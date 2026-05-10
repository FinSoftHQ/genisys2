export type {
	RoomStatus,
	ExecutionMode,
	RoomCloseReason,
	RoutingStrategy,
	StoredEvent,
	StoredEventInput,
	RoomCreateOptions,
	AgentState,
	Room,
	ReturnedEvent,
} from "./types.js";

export {
	RoomStatusSchema,
	ExecutionModeSchema,
	RoomCloseReasonSchema,
	RoutingStrategySchema,
	StoredEventSchema,
	InstructionsBodySchema,
	ListRoomsQuerySchema,
	GetEventsQuerySchema,
	ApiErrorSchema,
	CreateRoomResponseSchema,
	ListRoomsResponseSchema,
	RoomStatusResponseSchema,
	EventsResponseSchema,
	InstructionsResponseSchema,
	DestroyRoomResponseSchema,
} from "./schemas.js";

export { RingBuffer } from "./ring-buffer.js";

export {
	ensureDataDir,
	getIndexDbPath,
	getRoomDir,
	getRoomEventsPath,
	getRoomProtocolPath,
	getRoomPromptsDir,
} from "./storage/paths.js";

export type { RoomIndexRow, AgentIndexRow, ListCursor } from "./storage/index-db.js";
export {
	openIndexDb,
	closeIndexDb,
	getIndexDb,
	upsertRoom,
	upsertAgent,
	listRoomsIndex,
	listRoomsIndexCursor,
	getRoomIndex,
	getRoomAgentsIndex,
	getTerminalRoomsOlderThan,
	deleteRoomIndex,
} from "./storage/index-db.js";

export { RoomLog } from "./storage/room-log.js";

export { startRetentionGc, stopRetentionGc, performGc } from "./storage/retention-gc.js";

export { RoomLogger, loggingEnabled } from "./internal/room-logger.js";

export {
	setupTestDataDir,
	teardownTestDataDir,
	clearIndexDb,
} from "./test-helpers.js";

export {
	SUPERVISOR_SOCKET_PATH,
	writeMessage,
	createMessageReader,
	type IpcRequest,
	type IpcResponse,
	type IpcRequestType,
} from "./ipc/protocol.js";
