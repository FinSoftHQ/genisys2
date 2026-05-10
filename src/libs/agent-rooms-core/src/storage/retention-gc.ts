import { rmSync } from "fs";
import { getTerminalRoomsOlderThan, deleteRoomIndex } from "./index-db.js";
import { getRoomDir } from "./paths.js";

const RETENTION_MS = Number(process.env.AGENT_ROOM_RETENTION_MS ?? 86_400_000); // 24h
const GC_INTERVAL_MS = 15 * 60 * 1000; // 15 min

let timer: ReturnType<typeof setInterval> | null = null;

export function startRetentionGc(): void {
	if (timer) return;
	timer = setInterval(() => {
		performGc();
	}, GC_INTERVAL_MS);
	// Run once shortly after startup
	setTimeout(performGc, 5000);
}

export function stopRetentionGc(): void {
	if (timer) {
		clearInterval(timer);
		timer = null;
	}
}

export function performGc(): void {
	const cutoff = Date.now() - RETENTION_MS;
	const oldRooms = getTerminalRoomsOlderThan(cutoff);
	for (const row of oldRooms) {
		try {
			rmSync(getRoomDir(row.id), { recursive: true, force: true });
			deleteRoomIndex(row.id);
			console.info(`[agent-rooms] GC deleted old room: ${row.id}`);
		} catch (err) {
			console.warn(`[agent-rooms] GC failed to delete room ${row.id}: ${String(err)}`);
		}
	}
}
