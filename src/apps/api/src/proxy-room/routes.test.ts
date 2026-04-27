import fastify, { type FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { proxyRoomRoutes } from "./routes.js";

function jsonResponse(body: unknown, status = 200): Response {
	return new Response(JSON.stringify(body), {
		status,
		headers: {
			"content-type": "application/json",
		},
	});
}

describe("proxy-room routes", () => {
	let app: FastifyInstance;
	let fetchSpy: any;

	beforeEach(async () => {
		app = fastify();
		await app.register(proxyRoomRoutes, { prefix: "/api/v1/proxy-room" });
	});

	afterEach(async () => {
		if (fetchSpy) {
			fetchSpy.mockRestore();
		}
		await app.close();
	});

	it("creates proxy room and forwards create to agent-rooms with internal callback header", async () => {
		fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
			const url = String(input);
			if (url.endsWith("/api/v1/agent-rooms/")) {
				return jsonResponse({ roomId: "rm_proxy_1", status: "initialized" }, 201);
			}
			return jsonResponse({ error: "unexpected" }, 500);
		});

		const response = await app.inject({
			method: "POST",
			url: "/api/v1/proxy-room/",
			headers: {
				"content-type": "text/markdown",
			},
			payload: "---\nteam:\n  alpha: Lead\n---\n\nHello\n",
		});

		expect(response.statusCode).toBe(201);
		expect(response.json()).toEqual({ roomId: "rm_proxy_1", status: "initialized" });

		const upstreamCreate = fetchSpy.mock.calls.find((call: unknown[]) =>
			String(call[0]).endsWith("/api/v1/agent-rooms/"),
		);
		expect(upstreamCreate).toBeDefined();
		const init = upstreamCreate![1] as RequestInit;
		expect((init.headers as Record<string, string>)["x-room-callback-url"]).toContain(
			"/api/v1/proxy-room/_internal/agent-room-closed",
		);
	});

	it("invokes single close handler via internal callback and dispatches client callback", async () => {
		const clientCallbackCalls: Array<{ url: string; init: RequestInit | undefined }> = [];

		fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
			const url = String(input);
			if (url.endsWith("/api/v1/agent-rooms/")) {
				return jsonResponse({ roomId: "rm_proxy_2", status: "initialized" }, 201);
			}
			if (url === "https://client.example/hook") {
				clientCallbackCalls.push({ url, init });
				return new Response(null, { status: 204 });
			}
			return jsonResponse({ error: "unexpected" }, 500);
		});

		const created = await app.inject({
			method: "POST",
			url: "/api/v1/proxy-room/",
			headers: {
				"content-type": "text/markdown",
				"x-room-callback-url": "https://client.example/hook",
				"x-room-callback-secret": "top-secret",
			},
			payload: "---\nteam:\n  alpha: Lead\n---\n\nHello\n",
		});
		expect(created.statusCode).toBe(201);

		const callback = await app.inject({
			method: "POST",
			url: "/api/v1/proxy-room/_internal/agent-room-closed",
			headers: {
				"content-type": "application/json",
			},
			payload: {
				type: "room_closed",
				roomId: "rm_proxy_2",
				reason: "completed",
				at: new Date().toISOString(),
			},
		});
		expect(callback.statusCode).toBe(204);
		expect(clientCallbackCalls.length).toBe(1);

		const headers = clientCallbackCalls[0].init?.headers as Record<string, string>;
		expect(headers["x-signature"]).toBeTypeOf("string");
		expect(headers["x-signature"].length).toBeGreaterThan(0);
	});

	it("reconciles completion from status when callback is missed", async () => {
		let statusCalls = 0;
		const clientCallbackCalls: Array<{ url: string; init: RequestInit | undefined }> = [];

		fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
			const url = String(input);
			if (url.endsWith("/api/v1/agent-rooms/")) {
				return jsonResponse({ roomId: "rm_proxy_3", status: "initialized" }, 201);
			}
			if (url.endsWith("/api/v1/agent-rooms/rm_proxy_3/status")) {
				statusCalls += 1;
				return jsonResponse({ roomId: "rm_proxy_3", status: "completed", agents: {} }, 200);
			}
			if (url === "https://client.example/hook") {
				clientCallbackCalls.push({ url, init });
				return new Response(null, { status: 204 });
			}
			return jsonResponse({ error: "unexpected" }, 500);
		});

		const created = await app.inject({
			method: "POST",
			url: "/api/v1/proxy-room/",
			headers: {
				"content-type": "text/markdown",
				"x-room-callback-url": "https://client.example/hook",
			},
			payload: "---\nteam:\n  alpha: Lead\n---\n\nHello\n",
		});
		expect(created.statusCode).toBe(201);

		const s1 = await app.inject({ method: "GET", url: "/api/v1/proxy-room/rm_proxy_3/status" });
		expect(s1.statusCode).toBe(200);
		expect(s1.json().status).toBe("completed");

		const s2 = await app.inject({ method: "GET", url: "/api/v1/proxy-room/rm_proxy_3/status" });
		expect(s2.statusCode).toBe(200);

		expect(statusCalls).toBe(2);
		expect(clientCallbackCalls.length).toBe(1);
	});

	it("sends client callback on manual delete close path", async () => {
		const clientCallbackCalls: Array<{ url: string; init: RequestInit | undefined }> = [];

		fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
			const url = String(input);
			if (url.endsWith("/api/v1/agent-rooms/")) {
				return jsonResponse({ roomId: "rm_proxy_4", status: "initialized" }, 201);
			}
			if (url.endsWith("/api/v1/agent-rooms/rm_proxy_4")) {
				return jsonResponse({ roomId: "rm_proxy_4", status: "deleted" }, 200);
			}
			if (url === "https://client.example/hook") {
				clientCallbackCalls.push({ url, init });
				return new Response(null, { status: 204 });
			}
			return jsonResponse({ error: "unexpected" }, 500);
		});

		const created = await app.inject({
			method: "POST",
			url: "/api/v1/proxy-room/",
			headers: {
				"content-type": "text/markdown",
				"x-room-callback-url": "https://client.example/hook",
			},
			payload: "---\nteam:\n  alpha: Lead\n---\n\nHello\n",
		});
		expect(created.statusCode).toBe(201);

		const removed = await app.inject({
			method: "DELETE",
			url: "/api/v1/proxy-room/rm_proxy_4",
		});
		expect(removed.statusCode).toBe(200);
		expect(removed.json()).toEqual({ roomId: "rm_proxy_4", status: "deleted" });
		expect(clientCallbackCalls.length).toBe(1);
		const payload = JSON.parse(String(clientCallbackCalls[0].init?.body)) as Record<string, string>;
		expect(payload.reason).toBe("manual");
	});

	it("returns 404 for non-proxy room ids", async () => {
		fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(async () =>
			jsonResponse({ error: "unexpected" }, 500),
		);

		const response = await app.inject({ method: "GET", url: "/api/v1/proxy-room/rm_unknown/status" });
		expect(response.statusCode).toBe(404);
		expect(response.json()).toEqual({ error: "Room not found" });
	});
});
