import { mkdirSync } from "fs";
import { join } from "path";

const DATA_DIR = process.env.GENISYS_DATA_DIR ?? join(process.cwd(), ".genisys-data");

export function ensureDataDir(): string {
	mkdirSync(DATA_DIR, { recursive: true });
	return DATA_DIR;
}

export function getIndexDbPath(): string {
	return join(ensureDataDir(), "index.sqlite");
}

export function getRoomDir(roomId: string): string {
	return join(ensureDataDir(), "rooms", roomId);
}

export function getRoomEventsPath(roomId: string): string {
	return join(getRoomDir(roomId), "events.jsonl");
}

export function getRoomProtocolPath(roomId: string): string {
	return join(getRoomDir(roomId), "protocol.md");
}

export function getRoomPromptsDir(roomId: string): string {
	return join(getRoomDir(roomId), "prompts");
}
