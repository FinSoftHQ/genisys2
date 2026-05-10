import { Socket } from "net";

export const SUPERVISOR_SOCKET_PATH = `${process.env.GENISYS_DATA_DIR ?? ".genisys-data"}/supervisor.sock`;

export type IpcRequestType =
	| "room.create"
	| "room.instruct"
	| "room.destroy"
	| "room.subscribe"
	| "supervisor.status"
	| "supervisor.shutdown";

export interface IpcRequest {
	id: string;
	type: IpcRequestType;
	payload: Record<string, unknown>;
}

export interface IpcResponse {
	id: string;
	type: "ok" | "error" | "event";
	payload?: Record<string, unknown>;
	error?: string;
}

export function writeMessage(socket: Socket, msg: IpcRequest | IpcResponse): void {
	socket.write(JSON.stringify(msg) + "\n");
}

export function createMessageReader(
	socket: Socket,
	onMessage: (msg: IpcRequest | IpcResponse) => void,
	onError?: (err: Error) => void,
): void {
	let buffer = "";
	socket.on("data", (chunk: Buffer) => {
		buffer += chunk.toString("utf8");
		let idx: number;
		while ((idx = buffer.indexOf("\n")) !== -1) {
			const line = buffer.slice(0, idx);
			buffer = buffer.slice(idx + 1);
			if (!line.trim()) continue;
			try {
				onMessage(JSON.parse(line) as IpcRequest | IpcResponse);
			} catch (err) {
				onError?.(err instanceof Error ? err : new Error(String(err)));
			}
		}
	});
}
