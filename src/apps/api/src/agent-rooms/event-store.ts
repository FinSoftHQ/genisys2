import type { Room, StoredEvent, StoredEventInput, ReturnedEvent } from "./types.js";

const DEFAULT_EVENT_LIMIT = 100;
const MAX_EVENT_FIELD_LENGTH = 4000;
const SSE_HIGH_WATERMARK = Number(process.env.AGENT_ROOM_SSE_HIGH_WATERMARK ?? 1_048_576);

export function pushEvent(room: Room, event: StoredEventInput): void {
	room.eventSeq += 1;
	const record = { id: room.eventSeq, ...event } as StoredEvent;
	room.events.push(record);
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

export function getRoomEvents(
	room: Room,
	since?: number,
	limit?: number,
): { events: ReturnedEvent[]; hasMore: boolean } {
	let events = room.events.toArray();
	if (since !== undefined) {
		events = events.filter((e) => e.id > since);
	}
	const effectiveLimit = limit ?? DEFAULT_EVENT_LIMIT;
	const clampedLimit = Math.max(1, effectiveLimit);
	const hasMore = events.length > clampedLimit;
	const limitedEvents = events.slice(0, clampedLimit);
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
