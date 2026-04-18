import type { FastifyInstance } from "fastify";
import { z } from "zod";
import {
	createRoomFromMarkdown,
	listRooms,
	getRoom,
	getRoomStatus,
	getRoomEvents,
	addSseClient,
	removeSseClient,
	sendInstructions,
	destroyRoom,
} from "./manager.js";

const InstructionsBodySchema = z.object({
	targetAgents: z.array(z.string().min(1)).min(1),
	followUp: z.array(z.string().min(1)).min(1),
});

export async function agentRoomRoutes(instance: FastifyInstance): Promise<void> {
	instance.addContentTypeParser(
		"text/markdown",
		{ parseAs: "string" },
		(_request, body, done) => {
			done(null, body);
		},
	);

	instance.get("/", async (request, reply) => {
		const { status } = request.query as { status?: string };
		const { limit: limitRaw, offset: offsetRaw } = request.query as {
			limit?: string;
			offset?: string;
		};
		let limit = 50;
		let offset = 0;
		if (limitRaw !== undefined) {
			const parsed = parseInt(limitRaw, 10);
			if (!isNaN(parsed)) limit = parsed;
		}
		if (offsetRaw !== undefined) {
			const parsed = parseInt(offsetRaw, 10);
			if (!isNaN(parsed)) offset = parsed;
		}
		return reply.status(200).send(listRooms(status, limit, offset));
	});

	instance.post("/", async (request, reply) => {
		const contentType = request.headers["content-type"] ?? "";
		if (!contentType.includes("text/markdown")) {
			return reply.status(415).send({ error: "Expected text/markdown" });
		}

		const markdown = request.body as string;
		const result = await createRoomFromMarkdown(markdown);
		return reply.status(201).send({ roomId: result.roomId, status: "initialized" });
	});

	instance.get("/:roomId/status", async (request, reply) => {
		const { roomId } = request.params as { roomId: string };
		const room = getRoom(roomId);
		if (!room) {
			return reply.status(404).send({ error: "Room not found" });
		}
		return reply.status(200).send(getRoomStatus(room));
	});

	instance.get("/:roomId/events", async (request, reply) => {
		const { roomId } = request.params as { roomId: string };
		const room = getRoom(roomId);
		if (!room) {
			return reply.status(404).send({ error: "Room not found" });
		}

		const { since } = request.query as { since?: string };
		let sinceId: number | undefined;
		if (since !== undefined) {
			sinceId = parseInt(since, 10);
			if (isNaN(sinceId)) {
				return reply.status(400).send({ error: "Invalid 'since' parameter, must be an integer event id" });
			}
		}

		const events = getRoomEvents(room, sinceId);
		return reply.status(200).send({ roomId, total: room.events.length, events });
	});

	instance.get("/:roomId/stream", async (request, reply) => {
		const { roomId } = request.params as { roomId: string };
		const room = getRoom(roomId);
		if (!room) {
			return reply.status(404).send({ error: "Room not found" });
		}

		reply.raw.writeHead(200, {
			"Content-Type": "text/event-stream",
			"Cache-Control": "no-cache",
			Connection: "keep-alive",
		});

		addSseClient(room, reply);

		request.raw.on("close", () => {
			removeSseClient(room, reply);
		});
	});

	instance.post("/:roomId/instructions", async (request, reply) => {
		const { roomId } = request.params as { roomId: string };
		const room = getRoom(roomId);
		if (!room) {
			return reply.status(404).send({ error: "Room not found" });
		}

		if (room.status === "completed") {
			return reply.status(409).send({ error: "Room is completed" });
		}

		const body = InstructionsBodySchema.safeParse(request.body);
		if (!body.success) {
			return reply.status(400).send({ error: "Invalid body", issues: body.error.issues });
		}

		let totalQueued = 0;
		for (const agentName of body.data.targetAgents) {
			try {
				const result = await sendInstructions(room, agentName, body.data.followUp);
				totalQueued += result.queuedItems;
			} catch (err: unknown) {
				const message = err instanceof Error ? err.message : String(err);
				return reply.status(400).send({ error: message, agent: agentName });
			}
		}
		return reply.status(200).send({ roomId, queuedItems: totalQueued });
	});

	instance.delete("/:roomId", async (request, reply) => {
		const { roomId } = request.params as { roomId: string };
		const room = getRoom(roomId);
		if (!room) {
			return reply.status(404).send({ error: "Room not found" });
		}
		destroyRoom(roomId);
		return reply.status(200).send({ roomId, status: "deleted" });
	});
}
