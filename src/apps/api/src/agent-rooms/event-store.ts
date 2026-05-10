import type { Room, StoredEvent, StoredEventInput, ReturnedEvent } from "./types.js";
import { RoomLog } from "./storage/room-log.js";

const DEFAULT_EVENT_LIMIT = 100;
const MAX_EVENT_FIELD_LENGTH = 4000;
const SSE_HIGH_WATERMARK = Number(process.env.AGENT_ROOM_SSE_HIGH_WATERMARK ?? 1_048_576);

export function pushEvent(room: Room, event: StoredEventInput): void {
	room.eventSeq += 1;
	const record = { id: room.eventSeq, ...event } as StoredEvent;
	room.events.push(record);
	room.roomLog.append(record);
}

export function broadcast(room: Room, payload: object): void {
	const data = `event: message\ndata: ${JSON.stringify(payload)}\n\n`;
	for (const client of room.sseClients) {
		try {
			if (client.raw.writableLength > SSE_HIGH_WATERMARK) {
				throw new Error("SSE backpressure");
			}
			client.raw.write(data);
		} catch {
			try { client.raw.end(); } catch {}
			room.sseClients.delete(client);
		}
	}
}

export async function getRoomEvents(
	room: Room,
	since?: number,
	limit?: number,
): Promise<{ events: ReturnedEvent[]; hasMore: boolean }> {
	// Read from persistent log first
	const disk = await RoomLog.readEvents(room.id, since, limit ? limit + 1 : undefined);

	// Merge with any in-memory ring buffer events that may not be flushed yet
	const memoryEvents = room.events.toArray().filter((e) => {
		if (since !== undefined && e.id <= since) return false;
		// avoid duplicates
		return !disk.events.some((d) => d.id === e.id);
	});

	const merged = [...disk.events, ...memoryEvents];
	merged.sort((a, b) => a.id - b.id);

	const effectiveLimit = limit ?? DEFAULT_EVENT_LIMIT;
	const clampedLimit = Math.max(1, effectiveLimit);
	const hasMore = merged.length > clampedLimit;
	const limitedEvents = merged.slice(0, clampedLimit);
	return { events: truncateEvents(limitedEvents), hasMore };
}

function truncateEvents(events: StoredEvent[]): ReturnedEvent[] {
	return events.map((event) => {
		let truncated = false;
		const copy = { ...event } as ReturnedEvent;
		switch (copy.type) {
			case "thinking":
				if (copy.thinking.length > MAX_EVENT_FIELD_LENGTH) {
					copy.thinking = copy.thinking.slice(0, MAX_EVENT_FIELD_LENGTH) + "... [truncated]";
					truncated = true;
				}
				break;
			case "message":
				if (copy.text.length > MAX_EVENT_FIELD_LENGTH) {
					copy.text = copy.text.slice(0, MAX_EVENT_FIELD_LENGTH) + "... [truncated]";
					truncated = true;
				}
				break;
			case "tool_end":
				if (copy.result.length > MAX_EVENT_FIELD_LENGTH) {
					copy.result = copy.result.slice(0, MAX_EVENT_FIELD_LENGTH) + "... [truncated]";
					truncated = true;
				}
				break;
		}
		if (truncated) {
			copy._fieldTruncated = true;
		}
		return copy;
	});
}
