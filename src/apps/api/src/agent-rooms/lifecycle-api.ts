import {
	getRoomIndex,
	getRoomAgentsIndex,
	listRoomsIndex,
	getRoomPromptsDir,
	RoomLog,
	RingBuffer,
	RoomLogger,
	type Room,
	type AgentState,
	type RoomIndexRow,
} from "@repo/agent-rooms-core";

export function listRooms(
	status?: string,
	limit = 50,
	offset = 0,
	tag?: string,
): object[] {
	const clampedLimit = Math.max(1, Math.min(200, limit));
	const clampedOffset = Math.max(0, offset);

	const rows = listRoomsIndex(status, tag, clampedLimit, clampedOffset);
	return rows.map((row) => getRoomStatusFromIndex(row));
}

function getRoomStatusFromIndex(row: RoomIndexRow): object {
	return {
		roomId: row.id,
		status: row.status,
		...(row.failed_agent ? { failedAgent: row.failed_agent, reason: row.failed_reason } : {}),
		agents: {}, // agents not loaded for cold rooms
		lastEventId: undefined,
		lastEventAt: undefined,
		lastEventType: undefined,
		lastEventFrom: undefined,
	};
}

export function getRoom(id: string): Room | undefined {
	// API only reads from index DB; live rooms are managed by supervisor
	const row = getRoomIndex(id);
	if (!row) return undefined;

	const agentRows = getRoomAgentsIndex(id);
	const agents = new Map<string, AgentState>();
	for (const ar of agentRows) {
		agents.set(ar.name, {
			proc: null,
			executionMode: ar.execution_mode as import("@repo/agent-rooms-core").ExecutionMode,
			piArgs: [],
			name: ar.name,
			role: ar.role,
			isStreaming: false,
			pendingUiRequest: false,
			status: ar.status as AgentState["status"],
			logger: new RoomLogger(ar.name),
			_textBuf: "",
			_thinkingBuf: "",
			_msgTs: 0,
			ready: Boolean(ar.ready),
			taskCompleted: Boolean(ar.task_completed),
			hasParticipated: Boolean(ar.has_participated),
		});
	}

	const room: Room = {
		id,
		status: row.status as import("@repo/agent-rooms-core").RoomStatus,
		agents,
		sseClients: new Set(),
		createdAt: row.created_at,
		lastActivityAt: row.last_activity_at,
		protocolBody: row.protocol_body ?? "",
		facilitator: row.facilitator ?? undefined,
		routingStrategy: (row.routing_strategy as import("@repo/agent-rooms-core").RoutingStrategy) ?? "broadcast",
		failedAgent: row.failed_agent ?? undefined,
		failedReason: row.failed_reason ?? undefined,
		events: new RingBuffer(200),
		eventSeq: 0,
		promptDir: getRoomPromptsDir(id),
		callbackUrl: row.callback_url ?? undefined,
		callbackSecret: row.callback_secret ?? undefined,
		tag: row.tag ?? undefined,
		roomLog: new RoomLog(id),
	};
	return room;
}

export function getRoomStatus(room: Room): object {
	const agentStatuses: Record<string, { status: string }> = {};
	for (const [name, agent] of room.agents) {
		agentStatuses[name] = { status: agent.status };
	}
	const lastEvent = room.events.newest;
	return {
		roomId: room.id,
		status: room.status,
		...(room.failedAgent
			? { failedAgent: room.failedAgent, reason: room.failedReason }
			: {}),
		agents: agentStatuses,
		...(lastEvent
			? {
					lastEventId: lastEvent.id,
					lastEventAt: lastEvent.at,
					lastEventType: lastEvent.type,
					lastEventFrom: lastEvent.from,
				}
			: {}),
	};
}

export async function getRoomEvents(
	room: Room,
	since?: number,
	limit?: number,
): Promise<{ events: import("@repo/agent-rooms-core").ReturnedEvent[]; hasMore: boolean }> {
	const DEFAULT_EVENT_LIMIT = 100;
	const MAX_EVENT_FIELD_LENGTH = 4000;

	const disk = await RoomLog.readEvents(room.id, since, limit ? limit + 1 : undefined);

	// Merge with any in-memory ring buffer events that may not be flushed yet
	const memoryEvents = room.events.toArray().filter((e) => {
		if (since !== undefined && e.id <= since) return false;
		return !disk.events.some((d) => d.id === e.id);
	});

	const merged = [...disk.events, ...memoryEvents];
	merged.sort((a, b) => a.id - b.id);

	const effectiveLimit = limit ?? DEFAULT_EVENT_LIMIT;
	const clampedLimit = Math.max(1, effectiveLimit);
	const hasMore = merged.length > clampedLimit;
	const limitedEvents = merged.slice(0, clampedLimit);
	return { events: truncateEvents(limitedEvents), hasMore };

	function truncateEvents(events: import("@repo/agent-rooms-core").StoredEvent[]): import("@repo/agent-rooms-core").ReturnedEvent[] {
		return events.map((event) => {
			let truncated = false;
			const copy = { ...event } as import("@repo/agent-rooms-core").ReturnedEvent;
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
}
