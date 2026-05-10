import { createConnection, type Socket } from "net";
import {
	SUPERVISOR_SOCKET_PATH,
	writeMessage,
	createMessageReader,
	type IpcRequest,
	type IpcResponse,
} from "@repo/agent-rooms-core";

function generateId(): string {
	return `req_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`;
}

function connect(): Promise<Socket> {
	return new Promise((resolve, reject) => {
		const socket = createConnection(SUPERVISOR_SOCKET_PATH);
		socket.once("connect", () => resolve(socket));
		socket.once("error", reject);
	});
}

async function request<T = Record<string, unknown>>(
	req: Omit<IpcRequest, "id">,
): Promise<{ ok: true; payload: T } | { ok: false; error: string }> {
	const socket = await connect();
	try {
		const id = generateId();
		const response = await new Promise<IpcResponse>((resolve, reject) => {
			createMessageReader(
				socket,
				(msg) => {
					if (msg.id === id) {
						resolve(msg as IpcResponse);
					}
				},
				(reject),
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
	onEvent: (event: Record<string, unknown>) => void,
	onError?: (err: Error) => void,
): Promise<Socket> {
	return new Promise((resolve, reject) => {
		const socket = createConnection(SUPERVISOR_SOCKET_PATH);
		socket.once("connect", () => {
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
						onEvent((msg as IpcResponse).payload ?? {});
					}
				},
				(err) => {
					onError?.(err);
					socket.end();
				},
			);
			writeMessage(socket, { type: "room.subscribe", payload: { roomId }, id });
		});
		socket.once("error", reject);
	});
}

export async function getSupervisorStatus(): Promise<{ rooms: number; agents: number }> {
	const result = await request<{ rooms: number; agents: number }>({
		type: "supervisor.status",
		payload: {},
	});
	if (!result.ok) throw new Error(result.error);
	return result.payload;
}
