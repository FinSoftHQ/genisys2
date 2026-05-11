import type { Room, StoredEvent, StoredEventInput, ReturnedEvent } from "@repo/agent-rooms-core";
import { RoomLog, writeMessage, upsertRoom } from "@repo/agent-rooms-core";
import { Socket } from "net";

const DEFAULT_EVENT_LIMIT = 100;
const MAX_EVENT_FIELD_LENGTH = 4000;
const ROOM_LIVE_SYNC_DEBOUNCE_MS = 250;
const roomSyncTimers = new Map<string, ReturnType<typeof setTimeout>>();

function generateMsgId(): string {
	return `msg_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 5)}`;
}

interface IpcSubscriber {
	socket: Socket;
	channels: string[];
}

export function pushEvent(room: Room, event: StoredEventInput): StoredEvent {
	room.eventSeq += 1;
	const record = { id: room.eventSeq, ...event } as StoredEvent;
	room.events.push(record);
	room.roomLog.append(record);
	const now = Date.now();
	if (room.lastActivityAt < now) {
		room.lastActivityAt = now;
	}
	const prevTimer = roomSyncTimers.get(room.id);
	if (prevTimer) clearTimeout(prevTimer);
	roomSyncTimers.set(
		room.id,
		setTimeout(() => {
			roomSyncTimers.delete(room.id);
			try {
				upsertRoom({
					id: room.id,
					status: room.status,
					tag: room.tag ?? null,
					created_at: room.createdAt,
					updated_at: Date.now(),
					last_activity_at: room.lastActivityAt,
					protocol_body: room.protocolBody,
					facilitator: room.facilitator ?? null,
					routing_strategy: room.routingStrategy,
					failed_agent: room.failedAgent ?? null,
					failed_reason: room.failedReason ?? null,
					callback_url: room.callbackUrl ?? null,
					callback_secret: room.callbackSecret ?? null,
					completed_at: room.status === "completed" ? Date.now() : null,
				});
			} catch {
				// ignore transient db lifecycle races during shutdown/tests
			}
		}, ROOM_LIVE_SYNC_DEBOUNCE_MS),
	);
	return record;
}

export function broadcast(room: Room, channel: "raw" | "storedevent", payload: Record<string, unknown>): void {
	for (const client of room.sseClients) {
		const subscriber = client as IpcSubscriber;
		const socket = subscriber.socket;
		if (!subscriber.channels.includes(channel)) continue;
		try {
			writeMessage(socket, {
				id: generateMsgId(),
				type: "event",
				payload: { channel, event: payload },
			});
		} catch {
			try { socket.end(); } catch {}
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
