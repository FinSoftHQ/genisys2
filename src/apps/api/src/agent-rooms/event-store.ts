import type { Room, StoredEvent, StoredEventInput, ReturnedEvent } from "./types.js";

const EVENT_BUFFER_CAP = 2500;
const DEFAULT_EVENT_LIMIT = 100;
const MAX_EVENT_FIELD_LENGTH = 4000;

export function pushEvent(room: Room, event: StoredEventInput): void {
	room.eventSeq += 1;
	const record = { id: room.eventSeq, ...event } as StoredEvent;
	room.events.push(record);
	if (room.events.length > EVENT_BUFFER_CAP) {
		room.events.shift();
	}
}

export function broadcast(room: Room, payload: object): void {
	const data = `event: message\ndata: ${JSON.stringify(payload)}\n\n`;
	for (const client of room.sseClients) {
		try {
			client.raw.write(data);
		} catch {
			// ignore
		}
	}
}

export function getRoomEvents(
	room: Room,
	since?: number,
	limit?: number,
): { events: ReturnedEvent[]; hasMore: boolean } {
	let events = room.events;
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
