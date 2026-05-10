import { createServer, type Server, type Socket } from "net";
import { unlinkSync, existsSync } from "fs";
import {
	SUPERVISOR_SOCKET_PATH,
	writeMessage,
	createMessageReader,
	openIndexDb,
	closeIndexDb,
	startRetentionGc,
	stopRetentionGc,
	type IpcRequest,
	type IpcResponse,
} from "@repo/agent-rooms-core";
import {
	createRoomFromMarkdown,
} from "./manager.js";
import {
	sendInstructions,
	destroyRoom,
	rooms,
} from "./lifecycle.js";
import { performCrashRecovery } from "./crash-recovery.js";

let server: Server | undefined;
let shuttingDown = false;

async function handleRequest(req: IpcRequest, socket: Socket): Promise<IpcResponse> {
	switch (req.type) {
		case "room.create": {
			const markdown = String(req.payload.markdown ?? "");
			const callbackUrl = req.payload.callbackUrl ? String(req.payload.callbackUrl) : undefined;
			const callbackSecret = req.payload.callbackSecret ? String(req.payload.callbackSecret) : undefined;
			const tag = req.payload.tag ? String(req.payload.tag) : undefined;
			const result = await createRoomFromMarkdown(markdown, { callbackUrl, callbackSecret, tag });
			return { id: req.id, type: "ok", payload: { roomId: result.roomId, status: "initialized" } };
		}

		case "room.instruct": {
			const roomId = String(req.payload.roomId ?? "");
			const targetAgent = String(req.payload.targetAgent ?? "");
			const followUp = Array.isArray(req.payload.followUp)
				? req.payload.followUp.map(String)
				: [];
			const room = rooms.get(roomId);
			if (!room) {
				return { id: req.id, type: "error", error: "Room not found" };
			}
			if (room.status === "completed") {
				return { id: req.id, type: "error", error: "Room is completed" };
			}
			try {
				const result = await sendInstructions(room, targetAgent, followUp);
				return { id: req.id, type: "ok", payload: { queuedItems: result.queuedItems } };
			} catch (err: unknown) {
				const message = err instanceof Error ? err.message : String(err);
				return { id: req.id, type: "error", error: message };
			}
		}

		case "room.destroy": {
			const roomId = String(req.payload.roomId ?? "");
			const reason = String(req.payload.reason ?? "manual") as "manual" | "expired";
			destroyRoom(roomId, reason);
			return { id: req.id, type: "ok", payload: { roomId, status: "deleted" } };
		}

		case "room.subscribe": {
			const roomId = String(req.payload.roomId ?? "");
			const room = rooms.get(roomId);
			if (!room) {
				return { id: req.id, type: "error", error: "Room not found" };
			}
			room.sseClients.add(socket);
			socket.on("close", () => {
				room.sseClients.delete(socket);
			});
			socket.on("error", () => {
				room.sseClients.delete(socket);
			});
			// Acknowledge subscription so client knows it's active
			return { id: req.id, type: "ok", payload: { subscribed: true, roomId } };
		}

		case "supervisor.status": {
			const roomCount = rooms.size;
			const agentCount = Array.from(rooms.values()).reduce(
				(sum, r) => sum + r.agents.size,
				0,
			);
			return { id: req.id, type: "ok", payload: { rooms: roomCount, agents: agentCount } };
		}

		case "supervisor.shutdown": {
			void gracefulShutdown();
			return { id: req.id, type: "ok", payload: { shuttingDown: true } };
		}

		default:
			return { id: req.id, type: "error", error: `Unknown request type: ${String(req.type)}` };
	}
}

export async function startSupervisorServer(): Promise<Server> {
	// Remove stale socket file
	if (existsSync(SUPERVISOR_SOCKET_PATH)) {
		try { unlinkSync(SUPERVISOR_SOCKET_PATH); } catch {}
	}

	openIndexDb();
	await performCrashRecovery();
	startRetentionGc();

	const srv = createServer((socket) => {
		createMessageReader(
			socket,
			async (msg) => {
				const response = await handleRequest(msg as IpcRequest, socket);
				writeMessage(socket, response);
			},
			(err) => {
				console.error("[supervisor] IPC read error:", err.message);
			},
		);
	});

	srv.listen(SUPERVISOR_SOCKET_PATH, () => {
		console.info(`[supervisor] listening on ${SUPERVISOR_SOCKET_PATH}`);
	});

	server = srv;
	return srv;
}

export async function gracefulShutdown(): Promise<void> {
	if (shuttingDown) return;
	shuttingDown = true;
	console.info("[supervisor] shutting down...");

	if (server) {
		server.close();
	}

	// Close all rooms (kill agents, flush logs)
	const { shutdownAllRooms } = await import("./lifecycle.js");
	shutdownAllRooms();

	stopRetentionGc();
	closeIndexDb();

	// Give a brief window for cleanup
	await new Promise((resolve) => setTimeout(resolve, 500));
	process.exit(0);
}

// Signal handlers
process.on("SIGTERM", () => { void gracefulShutdown(); });
process.on("SIGINT", () => { void gracefulShutdown(); });
process.on("SIGHUP", () => { void gracefulShutdown(); });
process.on("uncaughtException", (err) => {
	console.error("[supervisor] uncaughtException:", err);
	void gracefulShutdown();
});
process.on("unhandledRejection", (reason) => {
	console.error("[supervisor] unhandledRejection:", reason);
	void gracefulShutdown();
});
