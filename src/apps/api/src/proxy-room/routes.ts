import { createHmac } from "crypto";
import type { FastifyInstance } from "fastify";
import { z } from "zod";

type RoomCloseReason = "completed" | "manual" | "expired";
type ProxyRoomStatus = "initialized" | "running" | "suspended" | "error" | "completed";

type ProxyRoomRecord = {
	roomId: string;
	status: ProxyRoomStatus;
	clientCallbackUrl?: string;
	clientCallbackSecret?: string;
	closedAt?: string;
	closeReason?: RoomCloseReason;
};

const proxyRooms = new Map<string, ProxyRoomRecord>();

const InstructionsBodySchema = z.object({
	targetAgents: z.array(z.string().min(1)).min(1),
	followUp: z.array(z.string().min(1)).min(1),
});

const InternalRoomClosedSchema = z.object({
	type: z.literal("room_closed"),
	roomId: z.string().min(1),
	reason: z.enum(["completed", "manual", "expired"]),
	at: z.string().min(1),
});

function normalizeHeader(value: string | string[] | undefined): string | undefined {
	if (Array.isArray(value)) {
		return value[0]?.trim() || undefined;
	}
	return value?.trim() || undefined;
}

function getAgentRoomsBaseUrl(): string {
	const port = Number(process.env.PORT) || 8080;
	return `http://127.0.0.1:${String(port)}/api/v1/agent-rooms`;
}

function getInternalCallbackUrl(): string {
	const port = Number(process.env.PORT) || 8080;
	return `http://127.0.0.1:${String(port)}/api/v1/proxy-room/_internal/agent-room-closed`;
}

function computeSignature(payload: string, secret: string): string {
	return createHmac("sha256", secret).update(payload).digest("hex");
}

async function notifyClientCallback(record: ProxyRoomRecord): Promise<void> {
	if (!record.clientCallbackUrl || !record.closedAt || !record.closeReason) return;

	const payload = JSON.stringify({
		type: "room_closed",
		roomId: record.roomId,
		reason: record.closeReason,
		at: record.closedAt,
	});
	const headers: Record<string, string> = {
		"content-type": "application/json",
	};
	if (record.clientCallbackSecret) {
		headers["x-signature"] = computeSignature(payload, record.clientCallbackSecret);
	}

	try {
		const response = await fetch(record.clientCallbackUrl, {
			method: "POST",
			headers,
			body: payload,
			signal: AbortSignal.timeout(5000),
		});
		if (!response.ok) {
			console.warn(
				`[proxy-room] callback failed for room ${record.roomId}: ${response.status} ${response.statusText}`,
			);
			return;
		}
		console.info(`[proxy-room] callback delivered for room ${record.roomId} (${record.closeReason})`);
	} catch (err: unknown) {
		const message = err instanceof Error ? err.message : String(err);
		console.warn(`[proxy-room] callback failed for room ${record.roomId}: ${message}`);
	}
}

async function handleRoomClosed(
	roomId: string,
	reason: RoomCloseReason,
	at: string,
	source: "callback" | "status-reconcile" | "delete",
): Promise<void> {
	const record = proxyRooms.get(roomId);
	if (!record) return;
	if (record.closedAt) return;

	record.status = "completed";
	record.closedAt = at;
	record.closeReason = reason;

	console.info(`[proxy-room] room closed: ${roomId} (${reason}) via ${source}`);
	await notifyClientCallback(record);
}

async function fetchAgentRoomJson(
	path: string,
	init?: RequestInit,
): Promise<{ status: number; body: unknown }> {
	const response = await fetch(`${getAgentRoomsBaseUrl()}${path}`, init);
	let body: unknown = null;
	try {
		body = await response.json();
	} catch {
		body = null;
	}
	return { status: response.status, body };
}

async function listProxyRooms(status?: string, limit = 50, offset = 0): Promise<unknown[]> {
	const clampedLimit = Math.max(1, Math.min(200, limit));
	const clampedOffset = Math.max(0, offset);
	const targetCount = clampedOffset + clampedLimit;
	const filtered: unknown[] = [];

	let remoteOffset = 0;
	const remoteLimit = 200;

	while (filtered.length < targetCount) {
		const search = new URLSearchParams();
		if (status !== undefined) search.set("status", status);
		search.set("limit", String(remoteLimit));
		search.set("offset", String(remoteOffset));

		const response = await fetch(`${getAgentRoomsBaseUrl()}?${search.toString()}`);
		if (!response.ok) {
			break;
		}

		const page = (await response.json()) as Array<{ roomId?: string }>;
		if (page.length === 0) {
			break;
		}

		for (const item of page) {
			if (item.roomId && proxyRooms.has(item.roomId)) {
				filtered.push(item);
			}
		}

		remoteOffset += page.length;
		if (page.length < remoteLimit) {
			break;
		}
	}

	return filtered.slice(clampedOffset, clampedOffset + clampedLimit);
}

export async function proxyRoomRoutes(instance: FastifyInstance): Promise<void> {
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

		const rooms = await listProxyRooms(status, limit, offset);
		return reply.status(200).send(rooms);
	});

	instance.post("/", async (request, reply) => {
		const contentType = request.headers["content-type"] ?? "";
		if (!contentType.includes("text/markdown")) {
			return reply.status(415).send({ error: "Expected text/markdown" });
		}

		const markdown = request.body as string;
		const clientCallbackUrl = normalizeHeader(request.headers["x-room-callback-url"]);
		const clientCallbackSecret = normalizeHeader(request.headers["x-room-callback-secret"]);

		if (clientCallbackSecret && !clientCallbackUrl) {
			return reply.status(400).send({ error: "x-room-callback-secret requires x-room-callback-url" });
		}
		if (clientCallbackUrl) {
			try {
				const parsed = new URL(clientCallbackUrl);
				if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
					return reply.status(400).send({ error: "x-room-callback-url must be http or https" });
				}
			} catch {
				return reply.status(400).send({ error: "Invalid x-room-callback-url" });
			}
		}

		console.info("[proxy-room] creating room via agent-rooms");
		const upstream = await fetchAgentRoomJson("/", {
			method: "POST",
			headers: {
				"content-type": "text/markdown",
				"x-room-callback-url": getInternalCallbackUrl(),
			},
			body: markdown,
		});

		if (upstream.status < 200 || upstream.status >= 300) {
			return reply.status(upstream.status).send(upstream.body);
		}

		const body = upstream.body as { roomId: string; status: ProxyRoomStatus };
		proxyRooms.set(body.roomId, {
			roomId: body.roomId,
			status: body.status,
			clientCallbackUrl,
			clientCallbackSecret,
		});

		return reply.status(201).send(body);
	});

	// Internal endpoint used by agent-rooms callback; intentionally undocumented.
	instance.post("/_internal/agent-room-closed", async (request, reply) => {
		const body = InternalRoomClosedSchema.safeParse(request.body);
		if (!body.success) {
			return reply.status(400).send({ error: "Invalid body", issues: body.error.issues });
		}

		await handleRoomClosed(body.data.roomId, body.data.reason, body.data.at, "callback");
		return reply.status(204).send();
	});

	instance.get("/:roomId/status", async (request, reply) => {
		const { roomId } = request.params as { roomId: string };
		const record = proxyRooms.get(roomId);
		if (!record) {
			return reply.status(404).send({ error: "Room not found" });
		}

		if (record.closeReason === "manual" || record.closeReason === "expired") {
			return reply.status(404).send({ error: "Room not found" });
		}

		const upstream = await fetchAgentRoomJson(`/${encodeURIComponent(roomId)}/status`);
		if (upstream.status === 200) {
			const body = upstream.body as { status?: ProxyRoomStatus };
			if (body.status) {
				record.status = body.status;
			}
			if (body.status === "completed") {
				await handleRoomClosed(roomId, "completed", new Date().toISOString(), "status-reconcile");
			}
		}

		return reply.status(upstream.status).send(upstream.body);
	});

	instance.get("/:roomId/events", async (request, reply) => {
		const { roomId } = request.params as { roomId: string };
		if (!proxyRooms.has(roomId)) {
			return reply.status(404).send({ error: "Room not found" });
		}

		const query = new URLSearchParams();
		const { since, limit } = request.query as { since?: string; limit?: string };
		if (since !== undefined) query.set("since", since);
		if (limit !== undefined) query.set("limit", limit);
		const suffix = query.toString().length > 0 ? `?${query.toString()}` : "";

		const upstream = await fetchAgentRoomJson(`/${encodeURIComponent(roomId)}/events${suffix}`);
		return reply.status(upstream.status).send(upstream.body);
	});

	instance.get("/:roomId/stream", async (request, reply) => {
		const { roomId } = request.params as { roomId: string };
		if (!proxyRooms.has(roomId)) {
			return reply.status(404).send({ error: "Room not found" });
		}

		const controller = new AbortController();
		request.raw.on("close", () => {
			controller.abort();
		});

		const response = await fetch(`${getAgentRoomsBaseUrl()}/${encodeURIComponent(roomId)}/stream`, {
			signal: controller.signal,
		});
		if (!response.ok || !response.body) {
			const body = await response.text().catch(() => "");
			return reply.status(response.status).send(body ? { error: body } : { error: "Unable to connect stream" });
		}

		reply.raw.writeHead(200, {
			"Content-Type": "text/event-stream",
			"Cache-Control": "no-cache",
			Connection: "keep-alive",
		});

		const reader = response.body.getReader();
		while (true) {
			const { done, value } = await reader.read();
			if (done) break;
			reply.raw.write(Buffer.from(value));
		}
		reply.raw.end();
	});

	instance.post("/:roomId/instructions", async (request, reply) => {
		const { roomId } = request.params as { roomId: string };
		if (!proxyRooms.has(roomId)) {
			return reply.status(404).send({ error: "Room not found" });
		}

		const body = InstructionsBodySchema.safeParse(request.body);
		if (!body.success) {
			return reply.status(400).send({ error: "Invalid body", issues: body.error.issues });
		}

		const upstream = await fetchAgentRoomJson(`/${encodeURIComponent(roomId)}/instructions`, {
			method: "POST",
			headers: {
				"content-type": "application/json",
			},
			body: JSON.stringify(body.data),
		});
		return reply.status(upstream.status).send(upstream.body);
	});

	instance.delete("/:roomId", async (request, reply) => {
		const { roomId } = request.params as { roomId: string };
		if (!proxyRooms.has(roomId)) {
			return reply.status(404).send({ error: "Room not found" });
		}

		const upstream = await fetchAgentRoomJson(`/${encodeURIComponent(roomId)}`, {
			method: "DELETE",
		});
		if (upstream.status >= 200 && upstream.status < 300) {
			await handleRoomClosed(roomId, "manual", new Date().toISOString(), "delete");
		}
		return reply.status(upstream.status).send(upstream.body);
	});
}
