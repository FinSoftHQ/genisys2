import { createConnection, type Socket } from "net";
import {
	writeMessage,
	createMessageReader,
	type IpcRequest,
	type IpcResponse,
} from "@repo/agent-rooms-core";

const CONNECT_TIMEOUT_MS = 2000;
const RESPONSE_TIMEOUT_MS = 10000;

export type StreamChannel = "raw" | "storedevent";
export interface StreamEnvelope {
	channel: StreamChannel;
	event: Record<string, unknown>;
}

function getSupervisorSocketPath(): string {
	return `${process.env.GENISYS_DATA_DIR ?? ".genisys-data"}/supervisor.sock`;
}

function generateId(): string {
	return `req_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`;
}

function connect(timeoutMs = CONNECT_TIMEOUT_MS): Promise<Socket> {
	return new Promise((resolve, reject) => {
		const socket = createConnection(getSupervisorSocketPath());
		const timer = setTimeout(() => {
			socket.destroy(new Error(`IPC connect timeout after ${String(timeoutMs)}ms`));
		}, timeoutMs);
		socket.once("connect", () => {
			clearTimeout(timer);
			resolve(socket);
		});
		socket.once("error", (err) => {
			clearTimeout(timer);
			reject(err);
		});
	});
}

async function request<T = Record<string, unknown>>(
	req: Omit<IpcRequest, "id">,
): Promise<{ ok: true; payload: T } | { ok: false; error: string }> {
	const socket = await connect();
	try {
		const id = generateId();
		const response = await new Promise<IpcResponse>((resolve, reject) => {
			const timeout = setTimeout(() => {
				reject(new Error(`IPC response timeout after ${String(RESPONSE_TIMEOUT_MS)}ms`));
			}, RESPONSE_TIMEOUT_MS);
			createMessageReader(
				socket,
				(msg) => {
					if (msg.id === id) {
						clearTimeout(timeout);
						resolve(msg as IpcResponse);
					}
				},
				(err) => {
					clearTimeout(timeout);
					reject(err);
				},
			);
			writeMessage(socket, { ...req, id });
		});
		if (response.type === "error") {
			return { ok: false, error: response.error ?? "Unknown error" };
		}
		return { ok: true, payload: (response.payload ?? {}) as T };
	} finally {
		socket.end();
	}
}

export async function createRoom(
	markdown: string,
	options?: { callbackUrl?: string; callbackSecret?: string; tag?: string },
): Promise<{ roomId: string; status: string }> {
	const result = await request<{ roomId: string; status: string }>({
		type: "room.create",
		payload: {
			markdown,
			...(options?.callbackUrl ? { callbackUrl: options.callbackUrl } : {}),
			...(options?.callbackSecret ? { callbackSecret: options.callbackSecret } : {}),
			...(options?.tag ? { tag: options.tag } : {}),
		},
	});
	if (!result.ok) throw new Error(result.error);
	return result.payload;
}

export async function sendInstructions(
	roomId: string,
	targetAgent: string,
	followUp: string[],
): Promise<{ queuedItems: number }> {
	const result = await request<{ queuedItems: number }>({
		type: "room.instruct",
		payload: { roomId, targetAgent, followUp },
	});
	if (!result.ok) throw new Error(result.error);
	return result.payload;
}

export async function destroyRoom(roomId: string, reason = "manual"): Promise<void> {
	const result = await request({
		type: "room.destroy",
		payload: { roomId, reason },
	});
	if (!result.ok) throw new Error(result.error);
}

export function subscribeToRoom(
	roomId: string,
	onEvent: (event: StreamEnvelope) => void,
	onError?: (err: Error) => void,
	channels: StreamChannel[] = ["raw", "storedevent"],
): Promise<Socket> {
	return new Promise((resolve, reject) => {
		const socket = createConnection(getSupervisorSocketPath());
		const connectTimeout = setTimeout(() => {
			socket.destroy(new Error(`IPC connect timeout after ${String(CONNECT_TIMEOUT_MS)}ms`));
		}, CONNECT_TIMEOUT_MS);
		socket.once("connect", () => {
			clearTimeout(connectTimeout);
			const id = generateId();
			createMessageReader(
				socket,
				(msg) => {
					if (msg.id === id) {
						const response = msg as IpcResponse;
						if (response.type === "error") {
							socket.end();
							reject(new Error(response.error ?? "Subscription failed"));
							return;
						}
						// Subscription acknowledged; from now on receive events
						resolve(socket);
						return;
					}
					if (msg.type === "event") {
						const payload = (msg as IpcResponse).payload ?? {};
						const channel = payload.channel;
						const event = payload.event;
						if (
							(channel === "raw" || channel === "storedevent") &&
							event &&
							typeof event === "object"
						) {
							onEvent({ channel, event: event as Record<string, unknown> });
						}
					}
				},
				(err) => {
					onError?.(err);
					socket.end();
				},
			);
			writeMessage(socket, { type: "room.subscribe", payload: { roomId, channels }, id });
		});
		socket.once("error", (err) => {
			clearTimeout(connectTimeout);
			reject(err);
		});
	});
}
