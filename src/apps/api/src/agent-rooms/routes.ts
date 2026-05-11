import type { FastifyInstance } from "fastify";
import {
	InstructionsBodySchema,
	ListRoomsQuerySchema,
	GetEventsQuerySchema,
	RoomLog,
} from "@repo/agent-rooms-core";
import {
	createRoom,
	sendInstructions as sendInstructionsIpc,
	destroyRoom as destroyRoomIpc,
	subscribeToRoom,
	type StreamChannel,
} from "./client.js";
import { listRooms, getRoom, getRoomStatus, getRoomEvents } from "./lifecycle-api.js";
import { sendError, ErrorCodes } from "./errors.js";
import { agentRoomsIpcErrorsTotal, agentRoomsRequestsTotal, setAgentRoomsSseSubscribers } from "../metrics.js";

const SSE_HEARTBEAT_MS = 15000;
const SSE_HIGH_WATERMARK = Math.max(1024, Number(process.env.AGENT_ROOM_SSE_HIGH_WATERMARK ?? 1024 * 1024));
const ALLOWED_STREAM_CHANNELS = new Set<StreamChannel>(["raw", "storedevent"]);

function parseStreamChannels(value: unknown): StreamChannel[] {
	if (typeof value !== "string" || value.trim().length === 0) {
		return ["raw", "storedevent"];
	}
	const channels = value
		.split(",")
		.map((part) => part.trim())
		.filter((part): part is StreamChannel => ALLOWED_STREAM_CHANNELS.has(part as StreamChannel));
	return channels.length > 0 ? channels : ["raw", "storedevent"];
}

function writeSseEvent(reply: import("fastify").FastifyReply, eventName: string, data: unknown, id?: number): boolean {
	if (reply.raw.destroyed || reply.raw.writableEnded) return false;
	if (reply.raw.writableLength > SSE_HIGH_WATERMARK) return false;
	try {
		if (typeof id === "number") {
			reply.raw.write(`id: ${String(id)}\n`);
		}
		reply.raw.write(`event: ${eventName}\n`);
		reply.raw.write(`data: ${JSON.stringify(data)}\n\n`);
		return true;
	} catch {
		return false;
	}
}

function normalizeHeader(value: string | string[] | undefined): string | undefined {
	if (Array.isArray(value)) {
		return value[0]?.trim() || undefined;
	}
	return value?.trim() || undefined;
}

function parseLastEventId(value: string | string[] | undefined): number | undefined {
	if (value === undefined) return undefined;
	const raw = Array.isArray(value) ? value[0] : value;
	const parsed = parseInt(raw, 10);
	if (isNaN(parsed) || parsed < 0) return undefined;
	return parsed;
}

export async function agentRoomRoutes(instance: FastifyInstance): Promise<void> {
	instance.get("/", async (request, reply) => {
		agentRoomsRequestsTotal.inc({ method: "GET", route: "list", status: "started" });
		const query = ListRoomsQuerySchema.safeParse(request.query);
		if (!query.success) {
			agentRoomsRequestsTotal.inc({ method: "GET", route: "list", status: "error" });
			return sendError(reply, 400, {
				code: ErrorCodes.INVALID_QUERY,
				message: "Invalid query parameters",
				details: query.error.issues,
			});
		}
		const { status, tag, limit, cursor } = query.data;
		agentRoomsRequestsTotal.inc({ method: "GET", route: "list", status: "ok" });
		return reply.status(200).send(listRooms(status, limit, cursor, tag));
	});

	instance.post("/", async (request, reply) => {
		agentRoomsRequestsTotal.inc({ method: "POST", route: "create", status: "started" });
		const contentType = request.headers["content-type"] ?? "";
		if (!contentType.includes("text/markdown")) {
			agentRoomsRequestsTotal.inc({ method: "POST", route: "create", status: "error" });
			return sendError(reply, 415, {
				code: ErrorCodes.INVALID_CONTENT_TYPE,
				message: "Expected Content-Type: text/markdown",
			});
		}

		const markdown = request.body as string;
		const callbackUrl = normalizeHeader(request.headers["x-room-callback-url"]);
		const callbackSecret = normalizeHeader(request.headers["x-room-callback-secret"]);
		const tag = normalizeHeader(request.headers["x-room-tag"]);

		if (callbackSecret && !callbackUrl) {
			agentRoomsRequestsTotal.inc({ method: "POST", route: "create", status: "error" });
			return sendError(reply, 400, {
				code: ErrorCodes.INVALID_HEADER,
				message: "x-room-callback-secret requires x-room-callback-url",
			});
		}
		if (callbackUrl) {
			try {
				const parsed = new URL(callbackUrl);
				if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
					agentRoomsRequestsTotal.inc({ method: "POST", route: "create", status: "error" });
					return sendError(reply, 400, {
						code: ErrorCodes.INVALID_HEADER,
						message: "x-room-callback-url must be http or https",
					});
				}
			} catch {
				agentRoomsRequestsTotal.inc({ method: "POST", route: "create", status: "error" });
				return sendError(reply, 400, {
					code: ErrorCodes.INVALID_HEADER,
					message: "Invalid x-room-callback-url",
				});
			}
		}

		try {
			const result = await createRoom(markdown, { callbackUrl, callbackSecret, tag });
			agentRoomsRequestsTotal.inc({ method: "POST", route: "create", status: "ok" });
			return reply.status(201).send({ roomId: result.roomId, status: result.status });
		} catch (err: unknown) {
			const rawMessage = err instanceof Error ? err.message : String(err);
			agentRoomsRequestsTotal.inc({ method: "POST", route: "create", status: "error" });
			agentRoomsIpcErrorsTotal.inc({ operation: "room.create" });

			const isSocketMissing = rawMessage.includes("supervisor.sock") || rawMessage.includes("ENOENT");
			const message = isSocketMissing
				? `Supervisor is not running or socket is missing (${rawMessage}). Start the supervisor process (e.g., pnpm start:both) and ensure GENISYS_DATA_DIR is consistent between API and supervisor.`
				: rawMessage;

			return sendError(reply, 502, {
				code: ErrorCodes.SUPERVISOR_ERROR,
				message,
			});
		}
	});

	instance.get("/:roomId/status", async (request, reply) => {
		agentRoomsRequestsTotal.inc({ method: "GET", route: "status", status: "started" });
		const { roomId } = request.params as { roomId: string };
		const room = getRoom(roomId);
		if (!room) {
			agentRoomsRequestsTotal.inc({ method: "GET", route: "status", status: "error" });
			return sendError(reply, 404, {
				code: ErrorCodes.ROOM_NOT_FOUND,
				message: "Room not found",
			});
		}
		agentRoomsRequestsTotal.inc({ method: "GET", route: "status", status: "ok" });
		return reply.status(200).send(getRoomStatus(room));
	});

	instance.get("/:roomId/events", async (request, reply) => {
		agentRoomsRequestsTotal.inc({ method: "GET", route: "events", status: "started" });
		const { roomId } = request.params as { roomId: string };
		const room = getRoom(roomId);
		if (!room) {
			agentRoomsRequestsTotal.inc({ method: "GET", route: "events", status: "error" });
			return sendError(reply, 404, {
				code: ErrorCodes.ROOM_NOT_FOUND,
				message: "Room not found",
			});
		}

		const query = GetEventsQuerySchema.safeParse(request.query);
		if (!query.success) {
			agentRoomsRequestsTotal.inc({ method: "GET", route: "events", status: "error" });
			return sendError(reply, 400, {
				code: ErrorCodes.INVALID_QUERY,
				message: "Invalid query parameters",
				details: query.error.issues,
			});
		}
		const { since, limit } = query.data;

		const { events, hasMore } = await getRoomEvents(room, since, limit);
		const total = await RoomLog.countEvents(roomId);
		agentRoomsRequestsTotal.inc({ method: "GET", route: "events", status: "ok" });
		return reply.status(200).send({ roomId, total, returned: events.length, hasMore, events });
	});

	instance.get("/:roomId/stream", async (request, reply) => {
		agentRoomsRequestsTotal.inc({ method: "GET", route: "stream", status: "started" });
		const { roomId } = request.params as { roomId: string };
		const room = getRoom(roomId);
		if (!room) {
			agentRoomsRequestsTotal.inc({ method: "GET", route: "stream", status: "error" });
			return sendError(reply, 404, {
				code: ErrorCodes.ROOM_NOT_FOUND,
				message: "Room not found",
			});
		}

		const lastEventId = parseLastEventId(request.headers["last-event-id"]);
		const channels = parseStreamChannels((request.query as { channels?: string }).channels);

		reply.raw.writeHead(200, {
			"Content-Type": "text/event-stream",
			"Cache-Control": "no-cache",
			Connection: "keep-alive",
		});

		const heartbeat = setInterval(() => {
			if (reply.raw.destroyed || reply.raw.writableEnded) return;
			if (reply.raw.writableLength > SSE_HIGH_WATERMARK) {
				try { reply.raw.end(); } catch {}
				return;
			}
			try {
				reply.raw.write(`: heartbeat ${new Date().toISOString()}\n\n`);
			} catch {
				try { reply.raw.end(); } catch {}
			}
		}, SSE_HEARTBEAT_MS);

		setAgentRoomsSseSubscribers(1);

		let cleanedUp = false;
		const cleanup = () => {
			if (cleanedUp) return;
			cleanedUp = true;
			clearInterval(heartbeat);
			setAgentRoomsSseSubscribers(-1);
		};

		reply.raw.once("close", cleanup);
		reply.raw.once("error", cleanup);

		if (lastEventId !== undefined && channels.includes("storedevent")) {
			try {
				const { events } = await getRoomEvents(room, lastEventId, 1000);
				for (const event of events) {
					if (!writeSseEvent(reply, "storedevent", event, event.id)) {
						// Client disconnected during replay
						try { reply.raw.end(); } catch {}
						return;
					}
				}
			} catch (err: unknown) {
				console.warn(`[agent-rooms] SSE replay failed for ${roomId}:`, err);
			}
		}

		try {
			const socket = await subscribeToRoom(
				roomId,
				(envelope) => {
					if (envelope.channel === "raw") {
						if (!writeSseEvent(reply, "raw", envelope.event)) {
							socket.end();
						}
						return;
					}
					const id = typeof envelope.event.id === "number" ? envelope.event.id : undefined;
					if (!writeSseEvent(reply, "storedevent", envelope.event, id)) {
						socket.end();
					}
				},
				(err) => {
					agentRoomsIpcErrorsTotal.inc({ operation: "room.subscribe" });
					console.warn(`[agent-rooms] SSE subscription error for ${roomId}:`, err.message);
					try { reply.raw.end(); } catch {}
				},
				channels,
			);

			reply.raw.on("close", () => {
				socket.end();
			});
			reply.raw.on("error", () => {
				socket.end();
			});
			agentRoomsRequestsTotal.inc({ method: "GET", route: "stream", status: "ok" });
		} catch (err: unknown) {
			const message = err instanceof Error ? err.message : String(err);
			agentRoomsRequestsTotal.inc({ method: "GET", route: "stream", status: "error" });
			agentRoomsIpcErrorsTotal.inc({ operation: "room.subscribe" });
			console.warn(`[agent-rooms] SSE subscription failed for ${roomId}:`, message);
			try { reply.raw.end(); } catch {}
		}
	});

	instance.post("/:roomId/instructions", async (request, reply) => {
		agentRoomsRequestsTotal.inc({ method: "POST", route: "instructions", status: "started" });
		const { roomId } = request.params as { roomId: string };
		const room = getRoom(roomId);
		if (!room) {
			agentRoomsRequestsTotal.inc({ method: "POST", route: "instructions", status: "error" });
			return sendError(reply, 404, {
				code: ErrorCodes.ROOM_NOT_FOUND,
				message: "Room not found",
			});
		}

		if (room.status === "completed") {
			agentRoomsRequestsTotal.inc({ method: "POST", route: "instructions", status: "error" });
			return sendError(reply, 409, {
				code: ErrorCodes.ROOM_COMPLETED,
				message: "Room is completed",
			});
		}

		const body = InstructionsBodySchema.safeParse(request.body);
		if (!body.success) {
			agentRoomsRequestsTotal.inc({ method: "POST", route: "instructions", status: "error" });
			return sendError(reply, 400, {
				code: ErrorCodes.INVALID_BODY,
				message: "Invalid body",
				details: body.error.issues,
			});
		}

		let totalQueued = 0;
		for (const agentName of body.data.targetAgents) {
			try {
				const result = await sendInstructionsIpc(roomId, agentName, body.data.followUp);
				totalQueued += result.queuedItems;
			} catch (err: unknown) {
				const message = err instanceof Error ? err.message : String(err);
				agentRoomsRequestsTotal.inc({ method: "POST", route: "instructions", status: "error" });
				agentRoomsIpcErrorsTotal.inc({ operation: "room.instruct" });
				return sendError(reply, 400, {
					code: ErrorCodes.AGENT_NOT_FOUND,
					message,
					details: { agent: agentName },
				});
			}
		}
		agentRoomsRequestsTotal.inc({ method: "POST", route: "instructions", status: "ok" });
		return reply.status(200).send({ roomId, queuedItems: totalQueued });
	});

	instance.delete("/:roomId", async (request, reply) => {
		agentRoomsRequestsTotal.inc({ method: "DELETE", route: "destroy", status: "started" });
		const { roomId } = request.params as { roomId: string };
		const room = getRoom(roomId);
		if (!room) {
			agentRoomsRequestsTotal.inc({ method: "DELETE", route: "destroy", status: "error" });
			return sendError(reply, 404, {
				code: ErrorCodes.ROOM_NOT_FOUND,
				message: "Room not found",
			});
		}
		try {
			await destroyRoomIpc(roomId);
			agentRoomsRequestsTotal.inc({ method: "DELETE", route: "destroy", status: "ok" });
			return reply.status(200).send({ roomId, status: "deleted" });
		} catch (err: unknown) {
			const message = err instanceof Error ? err.message : String(err);
			agentRoomsRequestsTotal.inc({ method: "DELETE", route: "destroy", status: "error" });
			agentRoomsIpcErrorsTotal.inc({ operation: "room.destroy" });
			return sendError(reply, 502, {
				code: ErrorCodes.SUPERVISOR_ERROR,
				message,
			});
		}
	});
}
