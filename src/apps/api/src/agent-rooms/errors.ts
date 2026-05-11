import type { FastifyReply } from "fastify";

export interface ApiError {
	code: string;
	message: string;
	details?: unknown;
}

export function sendError(reply: FastifyReply, statusCode: number, error: ApiError): void {
	reply.status(statusCode).send({ error });
}

export const ErrorCodes = {
	INVALID_CONTENT_TYPE: "INVALID_CONTENT_TYPE",
	INVALID_HEADER: "INVALID_HEADER",
	INVALID_BODY: "INVALID_BODY",
	INVALID_QUERY: "INVALID_QUERY",
	ROOM_NOT_FOUND: "ROOM_NOT_FOUND",
	ROOM_COMPLETED: "ROOM_COMPLETED",
	AGENT_NOT_FOUND: "AGENT_NOT_FOUND",
	SUPERVISOR_ERROR: "SUPERVISOR_ERROR",
	SSE_SUBSCRIPTION_FAILED: "SSE_SUBSCRIPTION_FAILED",
} as const;
