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
} from "./client.js";
import { listRooms, getRoom, getRoomStatus, getRoomEvents } from "./lifecycle-api.js";
import { sendError, ErrorCodes } from "./errors.js";

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
		const query = ListRoomsQuerySchema.safeParse(request.query);
		if (!query.success) {
			return sendError(reply, 400, {
				code: ErrorCodes.INVALID_QUERY,
				message: "Invalid query parameters",
				details: query.error.issues,
			});
		}
		const { status, tag, limit, cursor } = query.data;
		return reply.status(200).send(listRooms(status, limit, cursor, tag));
	});

	instance.post("/", async (request, reply) => {
		const contentType = request.headers["content-type"] ?? "";
		if (!contentType.includes("text/markdown")) {
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
			return sendError(reply, 400, {
				code: ErrorCodes.INVALID_HEADER,
				message: "x-room-callback-secret requires x-room-callback-url",
			});
		}
		if (callbackUrl) {
			try {
				const parsed = new URL(callbackUrl);
				if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
					return sendError(reply, 400, {
						code: ErrorCodes.INVALID_HEADER,
						message: "x-room-callback-url must be http or https",
					});
				}
			} catch {
				return sendError(reply, 400, {
					code: ErrorCodes.INVALID_HEADER,
					message: "Invalid x-room-callback-url",
				});
			}
		}

		try {
			const result = await createRoom(markdown, { callbackUrl, callbackSecret, tag });
			return reply.status(201).send({ roomId: result.roomId, status: result.status });
		} catch (err: unknown) {
			const message = err instanceof Error ? err.message : String(err);
			return sendError(reply, 502, {
				code: ErrorCodes.SUPERVISOR_ERROR,
				message,
			});
		}
	});

	instance.get("/:roomId/status", async (request, reply) => {
		const { roomId } = request.params as { roomId: string };
		const room = getRoom(roomId);
		if (!room) {
			return sendError(reply, 404, {
				code: ErrorCodes.ROOM_NOT_FOUND,
				message: "Room not found",
			});
		}
		return reply.status(200).send(getRoomStatus(room));
	});

	instance.get("/:roomId/events", async (request, reply) => {
		const { roomId } = request.params as { roomId: string };
		const room = getRoom(roomId);
		if (!room) {
			return sendError(reply, 404, {
				code: ErrorCodes.ROOM_NOT_FOUND,
				message: "Room not found",
			});
		}

		const query = GetEventsQuerySchema.safeParse(request.query);
		if (!query.success) {
			return sendError(reply, 400, {
				code: ErrorCodes.INVALID_QUERY,
				message: "Invalid query parameters",
				details: query.error.issues,
			});
		}
		const { since, limit } = query.data;

		const { events, hasMore } = await getRoomEvents(room, since, limit);
		const total = await RoomLog.countEvents(roomId);
		return reply.status(200).send({ roomId, total, returned: events.length, hasMore, events });
	});

	instance.get("/:roomId/stream", async (request, reply) => {
		const { roomId } = request.params as { roomId: string };
		const room = getRoom(roomId);
		if (!room) {
			return sendError(reply, 404, {
				code: ErrorCodes.ROOM_NOT_FOUND,
				message: "Room not found",
			});
		}

		const lastEventId = parseLastEventId(request.headers["last-event-id"]);

		reply.raw.writeHead(200, {
			"Content-Type": "text/event-stream",
			"Cache-Control": "no-cache",
			Connection: "keep-alive",
		});

		// Replay missed events if Last-Event-Id provided
		if (lastEventId !== undefined) {
			try {
				const { events } = await getRoomEvents(room, lastEventId, 1000);
				for (const event of events) {
					try {
						reply.raw.write(`id: ${event.id}\nevent: message\ndata: ${JSON.stringify(event)}\n\n`);
					} catch {
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
				(event) => {
					try {
						const id = typeof event.id === "number" ? event.id : "";
						reply.raw.write(`id: ${id}\nevent: message\ndata: ${JSON.stringify(event)}\n\n`);
					} catch {
						socket.end();
					}
				},
				(err) => {
					console.warn(`[agent-rooms] SSE subscription error for ${roomId}:`, err.message);
					try { reply.raw.end(); } catch {}
				},
			);

			reply.raw.on("close", () => {
				socket.end();
			});
			reply.raw.on("error", () => {
				socket.end();
			});
		} catch (err: unknown) {
			const message = err instanceof Error ? err.message : String(err);
			console.warn(`[agent-rooms] SSE subscription failed for ${roomId}:`, message);
			try { reply.raw.end(); } catch {}
		}
	});

	instance.post("/:roomId/instructions", async (request, reply) => {
		const { roomId } = request.params as { roomId: string };
		const room = getRoom(roomId);
		if (!room) {
			return sendError(reply, 404, {
				code: ErrorCodes.ROOM_NOT_FOUND,
				message: "Room not found",
			});
		}

		if (room.status === "completed") {
			return sendError(reply, 409, {
				code: ErrorCodes.ROOM_COMPLETED,
				message: "Room is completed",
			});
		}

		const body = InstructionsBodySchema.safeParse(request.body);
		if (!body.success) {
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
				return sendError(reply, 400, {
					code: ErrorCodes.AGENT_NOT_FOUND,
					message,
					details: { agent: agentName },
				});
			}
		}
		return reply.status(200).send({ roomId, queuedItems: totalQueued });
	});

	instance.delete("/:roomId", async (request, reply) => {
		const { roomId } = request.params as { roomId: string };
		const room = getRoom(roomId);
		if (!room) {
			return sendError(reply, 404, {
				code: ErrorCodes.ROOM_NOT_FOUND,
				message: "Room not found",
			});
		}
		try {
			await destroyRoomIpc(roomId);
			return reply.status(200).send({ roomId, status: "deleted" });
		} catch (err: unknown) {
			const message = err instanceof Error ? err.message : String(err);
			return sendError(reply, 502, {
				code: ErrorCodes.SUPERVISOR_ERROR,
				message,
			});
		}
	});
}
