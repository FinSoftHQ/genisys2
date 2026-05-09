import type { FastifyReply } from "fastify";
import type { RoomLogger } from "./internal/room-logger.js";

export type RoomStatus =
	| "initialized"
	| "running"
	| "suspended"
	| "error"
	| "completed";

export type ExecutionMode = "session" | "single-shot";
export type RoomCloseReason = "completed" | "manual" | "expired";
export type RoutingStrategy = "broadcast" | "explicit";

type StoredEventBase = { id: number; from: string; at: string };

export type StoredEvent =
	| (StoredEventBase & { type: "thinking"; thinking: string })
	| (StoredEventBase & { type: "message"; text: string })
	| (StoredEventBase & { type: "tool_start"; toolName: string; args: unknown })
	| (StoredEventBase & { type: "tool_end"; toolName: string; result: string; isError: boolean })
	| (StoredEventBase & { type: "retry_start"; attempt: number; maxAttempts: number; delayMs: number; errorMessage: string })
	| (StoredEventBase & { type: "retry_end"; success: boolean; attempt: number; finalError?: string })
	| (StoredEventBase & { type: "agent_start" })
	| (StoredEventBase & { type: "agent_end" })
	| (StoredEventBase & { type: "room_error"; reason: string })
	| (StoredEventBase & { type: "room_closed"; reason: "completed" });

// Distributive Omit so pushEvent accepts each union member without the id field.
type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;
export type StoredEventInput = DistributiveOmit<StoredEvent, "id">;

export interface RoomCreateOptions {
	callbackUrl?: string;
	callbackSecret?: string;
}

export interface AgentState {
	proc: import("child_process").ChildProcess | null;
	executionMode: ExecutionMode;
	piArgs: string[];
	name: string;
	role: string;
	isStreaming: boolean;
	pendingUiRequest: boolean;
	status: "idle" | "streaming" | "error";
	logger: RoomLogger;
	// Event coalescing buffers (mirrors RoomLogger internals)
	_textBuf: string;
	_thinkingBuf: string;
	_msgTs: number;
	ready: boolean;
	taskCompleted: boolean;
	hasParticipated: boolean;
	_readyResolve?: () => void;
	_readyReject?: (err: Error) => void;
	_readyTimeout?: ReturnType<typeof setTimeout>;
}

export interface Room {
	id: string;
	status: RoomStatus;
	agents: Map<string, AgentState>;
	sseClients: Set<FastifyReply>;
	createdAt: number;
	lastActivityAt: number;
	protocolBody: string;
	routes?: Record<string, string[]>;
	facilitator?: string;
	routingStrategy: RoutingStrategy;
	failedAgent?: string;
	failedReason?: string;
	expireTimeout?: ReturnType<typeof setTimeout>;
	events: StoredEvent[];
	eventSeq: number;
	promptDir: string;
	workingDir?: string;
	idleCompletionTimeout?: ReturnType<typeof setTimeout>;
	callbackUrl?: string;
	callbackSecret?: string;
}

export type ReturnedEvent = StoredEvent & { _fieldTruncated?: boolean };
