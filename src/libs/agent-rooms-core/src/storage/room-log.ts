import { createWriteStream, existsSync, mkdirSync, type WriteStream } from "fs";
import { createInterface } from "readline";
import { createReadStream } from "fs";
import { getRoomEventsPath, getRoomDir } from "./paths.js";
import type { StoredEvent } from "../types.js";

const FLUSH_SIZE = 4096;
const FLUSH_INTERVAL_MS = 50;

export class RoomLog {
	private stream: WriteStream;
	private buffer = "";
	private flushTimer: ReturnType<typeof setTimeout> | null = null;
	private flushed = 0;
	private closed = false;

	constructor(roomId: string) {
		const dir = getRoomDir(roomId);
		mkdirSync(dir, { recursive: true });
		const path = getRoomEventsPath(roomId);
		this.stream = createWriteStream(path, { flags: "a" });
	}

	append(event: StoredEvent): void {
		if (this.closed) return;
		const line = JSON.stringify(event) + "\n";
		this.buffer += line;
		if (this.buffer.length >= FLUSH_SIZE) {
			this.flush();
		} else if (!this.flushTimer) {
			this.flushTimer = setTimeout(() => this.flush(), FLUSH_INTERVAL_MS);
		}
	}

	flush(): void {
		if (this.closed || this.buffer.length === 0) return;
		this.stream.write(this.buffer, (err) => {
			if (err) {
				console.error(`[agent-rooms] RoomLog flush error: ${String(err)}`);
			}
		});
		this.flushed += this.buffer.length;
		this.buffer = "";
		if (this.flushTimer) {
			clearTimeout(this.flushTimer);
			this.flushTimer = null;
		}
	}

	close(): Promise<void> {
		return new Promise((resolve) => {
			if (this.closed) {
				resolve();
				return;
			}
			this.closed = true;
			if (this.flushTimer) {
				clearTimeout(this.flushTimer);
				this.flushTimer = null;
			}
			if (this.buffer.length === 0) {
				this.stream.end(resolve);
				return;
			}
			this.stream.write(this.buffer, (err) => {
				if (err) {
					console.error(`[agent-rooms] RoomLog flush error: ${String(err)}`);
				}
				this.buffer = "";
				this.stream.end(resolve);
			});
		});
	}

	static async readEvents(roomId: string, since?: number, limit?: number): Promise<{ events: StoredEvent[]; hasMore: boolean }> {
		const path = getRoomEventsPath(roomId);
		if (!existsSync(path)) {
			return { events: [], hasMore: false };
		}

		const events: StoredEvent[] = [];
		const effectiveLimit = limit ?? Number.MAX_SAFE_INTEGER;
		const rl = createInterface({ input: createReadStream(path), crlfDelay: Infinity });

		for await (const line of rl) {
			if (!line.trim()) continue;
			try {
				const event = JSON.parse(line) as StoredEvent;
				if (since !== undefined && event.id <= since) continue;
				events.push(event);
				if (events.length >= effectiveLimit + 1) break;
			} catch {
				// skip malformed lines
			}
		}

		const hasMore = events.length > effectiveLimit;
		if (hasMore) {
			events.pop();
		}
		return { events, hasMore };
	}

	static async countEvents(roomId: string): Promise<number> {
		const path = getRoomEventsPath(roomId);
		if (!existsSync(path)) return 0;
		let count = 0;
		const rl = createInterface({ input: createReadStream(path), crlfDelay: Infinity });
		for await (const line of rl) {
			if (line.trim()) count++;
		}
		return count;
	}
}
