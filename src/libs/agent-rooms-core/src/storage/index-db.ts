import Database from "better-sqlite3";
import { getIndexDbPath } from "./paths.js";

let db: Database.Database | null = null;
let dbPath: string | null = null;

export function openIndexDb(): Database.Database {
	const path = getIndexDbPath();
	if (db && dbPath === path) return db;
	if (db) {
		try { db.close(); } catch {}
	}
	db = new Database(path);
	dbPath = path;
	db.pragma("journal_mode = WAL");
	db.pragma("synchronous = NORMAL");
	db.pragma("busy_timeout = 5000");

	db.exec(`
		CREATE TABLE IF NOT EXISTS rooms (
			id TEXT PRIMARY KEY,
			status TEXT NOT NULL,
			tag TEXT,
			created_at INTEGER NOT NULL,
			updated_at INTEGER NOT NULL,
			last_activity_at INTEGER NOT NULL,
			protocol_body TEXT,
			facilitator TEXT,
			routing_strategy TEXT,
			failed_agent TEXT,
			failed_reason TEXT,
			callback_url TEXT,
			callback_secret TEXT,
			completed_at INTEGER
		);

		CREATE TABLE IF NOT EXISTS agents (
			room_id TEXT NOT NULL,
			name TEXT NOT NULL,
			role TEXT NOT NULL,
			execution_mode TEXT NOT NULL,
			status TEXT NOT NULL DEFAULT 'idle',
			ready INTEGER NOT NULL DEFAULT 0,
			task_completed INTEGER NOT NULL DEFAULT 0,
			has_participated INTEGER NOT NULL DEFAULT 0,
			PRIMARY KEY (room_id, name),
			FOREIGN KEY (room_id) REFERENCES rooms(id) ON DELETE CASCADE
		);

		CREATE INDEX IF NOT EXISTS idx_rooms_status_tag_created ON rooms(status, tag, created_at);
		CREATE INDEX IF NOT EXISTS idx_rooms_updated ON rooms(updated_at);
	`);

	return db;
}

export function closeIndexDb(): void {
	if (db) {
		try { db.close(); } catch {}
		db = null;
		dbPath = null;
	}
}

export function getIndexDb(): Database.Database {
	if (!db) throw new Error("IndexDb not initialized");
	return db;
}

export interface RoomIndexRow {
	id: string;
	status: string;
	tag: string | null;
	created_at: number;
	updated_at: number;
	last_activity_at: number;
	protocol_body: string | null;
	facilitator: string | null;
	routing_strategy: string | null;
	failed_agent: string | null;
	failed_reason: string | null;
	callback_url: string | null;
	callback_secret: string | null;
	completed_at: number | null;
}

export interface AgentIndexRow {
	room_id: string;
	name: string;
	role: string;
	execution_mode: string;
	status: string;
	ready: number;
	task_completed: number;
	has_participated: number;
}

export function upsertRoom(row: RoomIndexRow): void {
	const d = getIndexDb();
	const stmt = d.prepare(`
		INSERT INTO rooms (id, status, tag, created_at, updated_at, last_activity_at, protocol_body, facilitator, routing_strategy, failed_agent, failed_reason, callback_url, callback_secret, completed_at)
		VALUES (@id, @status, @tag, @created_at, @updated_at, @last_activity_at, @protocol_body, @facilitator, @routing_strategy, @failed_agent, @failed_reason, @callback_url, @callback_secret, @completed_at)
		ON CONFLICT(id) DO UPDATE SET
			status = excluded.status,
			tag = excluded.tag,
			updated_at = excluded.updated_at,
			last_activity_at = excluded.last_activity_at,
			protocol_body = excluded.protocol_body,
			facilitator = excluded.facilitator,
			routing_strategy = excluded.routing_strategy,
			failed_agent = excluded.failed_agent,
			failed_reason = excluded.failed_reason,
			callback_url = excluded.callback_url,
			callback_secret = excluded.callback_secret,
			completed_at = excluded.completed_at
	`);
	stmt.run(row);
}

export function upsertAgent(row: AgentIndexRow): void {
	const d = getIndexDb();
	const stmt = d.prepare(`
		INSERT INTO agents (room_id, name, role, execution_mode, status, ready, task_completed, has_participated)
		VALUES (@room_id, @name, @role, @execution_mode, @status, @ready, @task_completed, @has_participated)
		ON CONFLICT(room_id, name) DO UPDATE SET
			role = excluded.role,
			execution_mode = excluded.execution_mode,
			status = excluded.status,
			ready = excluded.ready,
			task_completed = excluded.task_completed,
			has_participated = excluded.has_participated
	`);
	stmt.run(row);
}

export function getRoomIndex(id: string): RoomIndexRow | undefined {
	const d = getIndexDb();
	return d.prepare("SELECT * FROM rooms WHERE id = ?").get(id) as RoomIndexRow | undefined;
}

export function getRoomAgentsIndex(roomId: string): AgentIndexRow[] {
	const d = getIndexDb();
	return d.prepare("SELECT * FROM agents WHERE room_id = ?").all(roomId) as AgentIndexRow[];
}

export function listRoomsIndex(
	status?: string,
	tag?: string,
	limit = 50,
	offset = 0,
): RoomIndexRow[] {
	const d = getIndexDb();
	let sql = "SELECT * FROM rooms WHERE 1=1";
	const params: (string | number)[] = [];
	if (status !== undefined) {
		sql += " AND status = ?";
		params.push(status);
	}
	if (tag !== undefined) {
		sql += " AND tag = ?";
		params.push(tag);
	}
	sql += " ORDER BY created_at DESC, id DESC LIMIT ? OFFSET ?";
	params.push(limit, offset);
	return d.prepare(sql).all(...params) as RoomIndexRow[];
}

export interface ListCursor {
	created_at: number;
	room_id: string;
}

function encodeCursor(cursor: ListCursor): string {
	return Buffer.from(`${cursor.created_at}:${cursor.room_id}`).toString("base64url");
}

function decodeCursor(cursor: string): ListCursor | undefined {
	try {
		const decoded = Buffer.from(cursor, "base64url").toString("utf8");
		const [created_at, room_id] = decoded.split(":");
		const ts = parseInt(created_at, 10);
		if (isNaN(ts) || !room_id) return undefined;
		return { created_at: ts, room_id };
	} catch {
		return undefined;
	}
}

export function listRoomsIndexCursor(
	status?: string,
	tag?: string,
	limit = 50,
	cursor?: string,
): { rows: RoomIndexRow[]; nextCursor: string | null } {
	const d = getIndexDb();
	const decoded = cursor ? decodeCursor(cursor) : undefined;

	let sql = "SELECT * FROM rooms WHERE 1=1";
	const params: (string | number)[] = [];
	if (status !== undefined) {
		sql += " AND status = ?";
		params.push(status);
	}
	if (tag !== undefined) {
		sql += " AND tag = ?";
		params.push(tag);
	}
	if (decoded) {
		sql += " AND (created_at < ? OR (created_at = ? AND id < ?))";
		params.push(decoded.created_at, decoded.created_at, decoded.room_id);
	}
	sql += " ORDER BY created_at DESC, id DESC LIMIT ?";
	params.push(limit + 1);

	const rows = d.prepare(sql).all(...params) as RoomIndexRow[];
	const hasMore = rows.length > limit;
	if (hasMore) {
		rows.pop();
	}
	const nextCursor = hasMore && rows.length > 0
		? encodeCursor({ created_at: rows[rows.length - 1].created_at, room_id: rows[rows.length - 1].id })
		: null;
	return { rows, nextCursor };
}

export function deleteRoomIndex(id: string): void {
	const d = getIndexDb();
	d.prepare("DELETE FROM rooms WHERE id = ?").run(id);
}

export function getTerminalRoomsOlderThan(timestamp: number): { id: string; completed_at: number | null }[] {
	const d = getIndexDb();
	return d
		.prepare("SELECT id, completed_at FROM rooms WHERE status IN ('completed','error') AND updated_at < ?")
		.all(timestamp) as { id: string; completed_at: number | null }[];
}
