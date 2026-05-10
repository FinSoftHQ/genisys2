# agent-rooms-redesign-plan.md

## Phase 0 — Hygiene (one-time)

- Delete leaked `file:mem_*` files in `src/apps/api/`
- Add `file:mem_*` to `.gitignore`
- Remove `Squads` section from `ENDPOINTS.md` (lines 1–199)
- Prune dead `squad` references across repo

## Phase A — Stabilize in place

### A1. Fix SQLite "in-memory" leak
- `db/client.ts`: pass `':memory:'` directly; drop URI rewriting
- Add `onClose` hook to close DB connection

### A2. Remove lazy DB auto-create
- `db-context.ts`: throw if DB not initialized
- `index.ts`: call `openDb()` explicitly before `app.listen()`

### A3. Complete shutdown handling
- Split `server.ts` into `buildServer()` + `index.ts`
- Register SIGTERM, SIGINT, SIGHUP, uncaughtException, unhandledRejection
- Shutdown sequence:
  1. Iterate `rooms`, call `destroyRoom(id, 'manual')` (5s budget)
  2. `await app.close()`
  3. `closeDb()`
  4. `process.exit(0)`
- Second signal within 2s escalates to SIGKILL of child pgids

### A4. Evict completed rooms from RAM
- `completeRoom`: set `status='completed'`, schedule TTL timer (default 5min, env `AGENT_ROOM_COMPLETED_TTL_MS`)
- TTL fires: `rooms.delete(id)`, `rmSync(promptDir)`
- Same for error status
- `destroyRoom` cancels TTL timer if present

### A5. Replace event ring with bounded buffer
- Introduce `RingBuffer<T>` (head/tail indices, fixed size 2500)
- Same `pushEvent` / `getRoomEvents` API

### A6. Process spawn correctness
- `stdio: ['pipe','pipe','pipe']` — pipe stderr to Pino logger
- Kill escalation: SIGTERM → wait 3s → SIGKILL pgid
- `sendToAgent` returns write boolean, warn on backpressure

### A7. SSE hardening
- Heartbeat every 15s per client
- Backpressure: disconnect if `writableLength > 1MB` (env `AGENT_ROOM_SSE_HIGH_WATERMARK`)
- De-dupe close handlers (register only in `addSseClient`)
- Add `'error'` listener on `client.raw`

### A8. Body limit
- Set Fastify `bodyLimit: 1MB` globally
- Verify `text/markdown` parser honors it; if not, use `parseAs: 'buffer'`

### A9. Rate limit
- Skip rate limiting for loopback IPs
- Bump default to 600 req/min

### A10. Query parsing fixes
- Clamp `limit` to [1, 200], reject negatives/non-finite
- Move `addContentTypeParser('text/markdown')` to top-level `buildServer`

## Phase B — Persistent, bounded EventStore

### B1. Storage layer (`agent-rooms/storage/`)
- `IndexDb`: `better-sqlite3` on `${GENISYS_DATA_DIR}/index.sqlite` (WAL mode)
  - `rooms` table: metadata, status, timestamps, callbacks
  - `agents` table: per-room agent state
  - Index: `(status, tag, created_at)`
- `RoomLog`: append-only `events.jsonl` per room
  - Buffered writer (4KB or 50ms flush)
  - `fsync` on close
  - Read: stream lines, filter by `since`, materialize events

### B2. Lifecycle integration
- Replace `room.events: StoredEvent[]` with hot tail `RingBuffer(200)` + `roomLog` writer
- `pushEvent`: write to ring + log + update index (debounced 250ms)
- `getRoomEvents`: read from log, ring as cache for hot tail
- `listRooms`: read from `IndexDb` only
- `getRoom`: check Map first, fall back to index + log for completed/error
- `destroyRoom` / `completeRoom`: flush + close writer, mark index, delete from Map
- `promptDir`: `${DATA_DIR}/rooms/<roomId>/prompts/`
- `protocolBody`: write to `${DATA_DIR}/rooms/<roomId>/protocol.md`

### B3. Retention GC
- Every 15 min: delete `rooms/<roomId>/` for terminal rooms older than `AGENT_ROOM_RETENTION_MS` (default 24h)
- Idle expiry (`AGENT_ROOM_IDLE_EXPIRY_MS`, default 2h) applies to running rooms only

### B4. Tests
- Restart simulation: create room, push events, reconstruct API, assert data survives
- Retention test with mocked clock
- Index/disk drift test

## Phase C — Split out `room-supervisor`

### C1. New workspace: `src/apps/room-supervisor/`
- Owns: `spawn.ts`, `manager.ts`, runtime `lifecycle.ts`, `router.ts`, `internal/*`
- Owns EventStore writer (RoomLog + IndexDb writes)
- IPC server on Unix domain socket `${DATA_DIR}/supervisor.sock`
- Length-prefixed JSONL frames

### C2. IPC contract (`@repo/shared/supervisor-protocol.ts`)
- Requests: `room.create`, `room.instruct`, `room.destroy`, `room.subscribe`, `supervisor.status`, `supervisor.shutdown`
- Responses: JSONL events stream
- `protocolVersion: 1`

### C3. API side (`apps/api/src/agent-rooms/`)
- `routes.ts`: thin HTTP→IPC translator
- Reads (`/status`, `/events`, list): from `IndexDb` + `RoomLog` directly
- `/stream`: IPC `room.subscribe` → SSE pipe
- Mutations: send IPC requests

### C4. Bootstrap
- `bin/start.ts`: spawn supervisor → wait for `READY` → spawn API
- Forward SIGTERM/SIGINT to API first, then supervisor
- `pnpm dev`: `concurrently` with colored prefixes
- Production: systemd unit templates or PM2

### C5. Crash recovery
- Supervisor startup: scan `IndexDb` for `status IN ('running','initialized')`
- Transition to `status='error'`, `failed_reason='supervisor_restart'`
- Fire close callback

### C6. Callbacks
- Supervisor owns `notifyRoomClosedCallback`
- Retry: 3 attempts, exponential backoff (1s / 4s / 16s)
- Final failure logged to event log as `room_callback_failed`

### C7. Tests
- Supervisor unit tests with mocked `spawn`
- API tests: `FakeSupervisor` over stub Unix socket
- Integration: real supervisor + fake-pi script, full round trip

## Phase D — API surface cleanup

- Standardize errors: `{ error: { code, message, details? } }`
- Pagination: cursor-based on `(created_at, roomId)` for list
- `Last-Event-Id` on `/stream` for SSE reconnect replay
- Move agent-rooms types to `@repo/shared` (Zod-validated)
- Update `ENDPOINTS.md`

## Phase E — Ops polish

- `/metrics` endpoint (Prometheus text format)
- Drop `node_modules/.bin` PATH hack (with deprecation log)
- `pnpm clean` task
- README ops section

## File changes summary

Modifications:
- `src/apps/api/src/server.ts` → `buildServer.ts` + thin `index.ts`
- `src/apps/api/src/db/client.ts` — drop URI hack, add close hook
- `src/apps/api/src/kanban/db-context.ts` — remove lazy auto-create
- `src/apps/api/src/agent-rooms/event-store.ts` — RingBuffer + RoomLog
- `src/apps/api/src/agent-rooms/lifecycle.ts` — TTL, durable storage, IPC client
- `src/apps/api/src/agent-rooms/spawn.ts` — stderr, kill escalation
- `src/apps/api/src/agent-rooms/routes.ts` — body limit, errors, cursor pagination
- `src/apps/api/ENDPOINTS.md` — drop squads, update

New:
- `src/apps/api/src/agent-rooms/storage/{index-db.ts,room-log.ts,paths.ts}`
- `src/apps/room-supervisor/` workspace
- `src/packages/shared/src/supervisor-protocol.ts`
- `bin/start.ts`

Deletions:
- Dead `squad` code/tests/docs
- Runtime sections moved to supervisor

## Environment variables

- `GENISYS_DATA_DIR` — runtime state directory (default `./.genisys-data/`)
- `KANBAN_DB_PATH` — kanban DB path (default `${GENISYS_DATA_DIR}/kanban.sqlite`)
- `AGENT_ROOM_COMPLETED_TTL_MS` — RAM retention for completed rooms (default 300000)
- `AGENT_ROOM_RETENTION_MS` — disk retention for terminal rooms (default 86400000)
- `AGENT_ROOM_IDLE_EXPIRY_MS` — running room idle timeout (default 7200000)
- `AGENT_ROOM_SSE_HIGH_WATERMARK` — SSE backpressure limit (default 1048576)
