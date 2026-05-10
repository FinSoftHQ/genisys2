import fastify, { type FastifyInstance } from "fastify";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
	setupTestDataDir,
	teardownTestDataDir,
	clearIndexDb,
	upsertRoom,
	upsertAgent,
	RoomLog,
} from "@repo/agent-rooms-core";

const mocks = vi.hoisted(() => ({
	mockCreateRoom: vi.fn(),
	mockSendInstructions: vi.fn(),
	mockDestroyRoom: vi.fn(),
	mockSubscribeToRoom: vi.fn(),
}));

vi.mock("./client.js", () => ({
	createRoom: mocks.mockCreateRoom,
	sendInstructions: mocks.mockSendInstructions,
	destroyRoom: mocks.mockDestroyRoom,
	subscribeToRoom: mocks.mockSubscribeToRoom,
}));

import { agentRoomRoutes } from "./routes.js";

function seedRoom(roomId: string, createdAt: number): void {
	upsertRoom({
		id: roomId,
		status: "running",
		tag: "test-tag",
		created_at: createdAt,
		updated_at: createdAt,
		last_activity_at: createdAt,
		protocol_body: "# protocol",
		facilitator: null,
		routing_strategy: "broadcast",
		failed_agent: null,
		failed_reason: null,
		callback_url: null,
		callback_secret: null,
		completed_at: null,
	});
	upsertAgent({
		room_id: roomId,
		name: "agent-1",
		role: "dev",
		execution_mode: "session",
		status: "idle",
		ready: 1,
		task_completed: 0,
		has_participated: 1,
	});
}

async function buildApp(): Promise<FastifyInstance> {
	const app = fastify({ bodyLimit: 1024 * 1024 });
	app.addContentTypeParser("text/markdown", { parseAs: "string" }, (_request, body, done) => {
		done(null, body);
	});
	await app.register(agentRoomRoutes, { prefix: "/agent-rooms" });
	return app;
}

describe("agent-room routes", () => {
	let app: FastifyInstance;

	beforeEach(async () => {
		setupTestDataDir();
		clearIndexDb();
		mocks.mockCreateRoom.mockReset();
		mocks.mockSendInstructions.mockReset();
		mocks.mockDestroyRoom.mockReset();
		mocks.mockSubscribeToRoom.mockReset();
		mocks.mockSubscribeToRoom.mockRejectedValue(new Error("stop stream"));
		app = await buildApp();
	});

	afterEach(async () => {
		await app.close();
		teardownTestDataDir();
	});

	it("returns standardized error payload for unknown room", async () => {
		const response = await app.inject({
			method: "GET",
			url: "/agent-rooms/room-missing/status",
		});

		expect(response.statusCode).toBe(404);
		expect(response.json()).toEqual({
			error: {
				code: "ROOM_NOT_FOUND",
				message: "Room not found",
			},
		});
	});

	it("supports cursor pagination", async () => {
		const now = Date.now();
		seedRoom("room-1", now - 1000);
		seedRoom("room-2", now);

		const first = await app.inject({
			method: "GET",
			url: "/agent-rooms?limit=1",
		});
		expect(first.statusCode).toBe(200);
		const firstBody = first.json() as { rooms: Array<{ roomId: string }>; nextCursor: string | null };
		expect(firstBody.rooms).toHaveLength(1);
		expect(firstBody.nextCursor).toBeTruthy();

		const second = await app.inject({
			method: "GET",
			url: `/agent-rooms?limit=1&cursor=${firstBody.nextCursor ?? ""}`,
		});
		expect(second.statusCode).toBe(200);
		const secondBody = second.json() as { rooms: Array<{ roomId: string }> };
		expect(secondBody.rooms).toHaveLength(1);
		expect(secondBody.rooms[0].roomId).not.toBe(firstBody.rooms[0].roomId);
	});

	it("replays storedevent events with Last-Event-Id", async () => {
		seedRoom("room-stream", Date.now());
		const log = new RoomLog("room-stream");
		log.append({ id: 1, type: "message", from: "agent-1", at: new Date().toISOString(), text: "old" });
		log.append({ id: 2, type: "message", from: "agent-1", at: new Date().toISOString(), text: "new" });
		await log.close();

		const response = await app.inject({
			method: "GET",
			url: "/agent-rooms/room-stream/stream?channels=storedevent",
			headers: { "last-event-id": "1" },
		});

		expect(response.statusCode).toBe(200);
		expect(response.body).toContain("event: storedevent");
		expect(response.body).toContain("id: 2");
		expect(response.body).toContain('"text":"new"');
	});

	it("subscribes to both channels by default and supports channel filter", async () => {
		seedRoom("room-channels", Date.now());

		await app.inject({ method: "GET", url: "/agent-rooms/room-channels/stream" });
		expect(mocks.mockSubscribeToRoom).toHaveBeenCalled();
		expect(mocks.mockSubscribeToRoom.mock.calls[0][3]).toEqual(["raw", "storedevent"]);

		await app.inject({ method: "GET", url: "/agent-rooms/room-channels/stream?channels=raw" });
		expect(mocks.mockSubscribeToRoom.mock.calls[1][3]).toEqual(["raw"]);
	});

	it("enforces body limit on create endpoint", async () => {
		mocks.mockCreateRoom.mockResolvedValue({ roomId: "room-big", status: "initialized" });
		const oversized = "#".repeat(1024 * 1024 + 1);

		const response = await app.inject({
			method: "POST",
			url: "/agent-rooms",
			headers: { "content-type": "text/markdown" },
			payload: oversized,
		});

		expect(response.statusCode).toBe(413);
	});
});
