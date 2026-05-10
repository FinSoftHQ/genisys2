import { z } from "zod";

export const RoomStatusSchema = z.enum([
	"initialized",
	"running",
	"suspended",
	"error",
	"completed",
]);

export const ExecutionModeSchema = z.enum(["session", "single-shot"]);
export const RoomCloseReasonSchema = z.enum(["completed", "manual", "expired"]);
export const RoutingStrategySchema = z.enum(["broadcast", "explicit"]);

export const StoredEventSchema = z.discriminatedUnion("type", [
	z.object({ id: z.number().int().nonnegative(), from: z.string(), at: z.string(), type: z.literal("thinking"), thinking: z.string() }),
	z.object({ id: z.number().int().nonnegative(), from: z.string(), at: z.string(), type: z.literal("message"), text: z.string() }),
	z.object({ id: z.number().int().nonnegative(), from: z.string(), at: z.string(), type: z.literal("tool_start"), toolName: z.string(), args: z.unknown() }),
	z.object({ id: z.number().int().nonnegative(), from: z.string(), at: z.string(), type: z.literal("tool_end"), toolName: z.string(), result: z.string(), isError: z.boolean() }),
	z.object({ id: z.number().int().nonnegative(), from: z.string(), at: z.string(), type: z.literal("retry_start"), attempt: z.number().int(), maxAttempts: z.number().int(), delayMs: z.number().int(), errorMessage: z.string() }),
	z.object({ id: z.number().int().nonnegative(), from: z.string(), at: z.string(), type: z.literal("retry_end"), success: z.boolean(), attempt: z.number().int(), finalError: z.string().optional() }),
	z.object({ id: z.number().int().nonnegative(), from: z.string(), at: z.string(), type: z.literal("agent_start") }),
	z.object({ id: z.number().int().nonnegative(), from: z.string(), at: z.string(), type: z.literal("agent_end") }),
	z.object({ id: z.number().int().nonnegative(), from: z.string(), at: z.string(), type: z.literal("room_error"), reason: z.string() }),
	z.object({ id: z.number().int().nonnegative(), from: z.string(), at: z.string(), type: z.literal("room_closed"), reason: z.literal("completed") }),
]);

export const InstructionsBodySchema = z.object({
	targetAgents: z.array(z.string().min(1)).min(1),
	followUp: z.array(z.string().min(1)).min(1),
});

export const ListRoomsQuerySchema = z.object({
	status: RoomStatusSchema.optional(),
	tag: z.string().optional(),
	limit: z.coerce.number().int().min(1).max(200).default(50),
	cursor: z.string().optional(),
});

export const GetEventsQuerySchema = z.object({
	since: z.coerce.number().int().nonnegative().optional(),
	limit: z.coerce.number().int().min(1).max(200).default(100),
});

export const ApiErrorSchema = z.object({
	error: z.object({
		code: z.string(),
		message: z.string(),
		details: z.unknown().optional(),
	}),
});

export const CreateRoomResponseSchema = z.object({
	roomId: z.string(),
	status: RoomStatusSchema,
});

export const ListRoomsResponseSchema = z.object({
	rooms: z.array(z.object({
		roomId: z.string(),
		status: RoomStatusSchema,
		failedAgent: z.string().optional(),
		reason: z.string().optional(),
		agents: z.record(z.string(), z.object({ status: z.string() })).optional(),
		lastEventId: z.number().optional(),
		lastEventAt: z.string().optional(),
		lastEventType: z.string().optional(),
		lastEventFrom: z.string().optional(),
	})),
	nextCursor: z.string().nullable(),
});

export const RoomStatusResponseSchema = z.object({
	roomId: z.string(),
	status: RoomStatusSchema,
	failedAgent: z.string().optional(),
	reason: z.string().optional(),
	agents: z.record(z.string(), z.object({ status: z.string() })),
	lastEventId: z.number().optional(),
	lastEventAt: z.string().optional(),
	lastEventType: z.string().optional(),
	lastEventFrom: z.string().optional(),
});

export const EventsResponseSchema = z.object({
	roomId: z.string(),
	total: z.number().int(),
	returned: z.number().int(),
	hasMore: z.boolean(),
	events: z.array(StoredEventSchema.and(z.object({ _fieldTruncated: z.boolean().optional() }))),
});

export const InstructionsResponseSchema = z.object({
	roomId: z.string(),
	queuedItems: z.number().int(),
});

export const DestroyRoomResponseSchema = z.object({
	roomId: z.string(),
	status: z.string(),
});
