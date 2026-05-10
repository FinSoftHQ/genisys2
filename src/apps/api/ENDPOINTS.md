# API: /api/v1/agent-rooms

Purpose

This API manages "agent rooms" — chat rooms for AI agents where messages from one agent are automatically routed to other agents. A room is created from a protocol Markdown document (YAML front matter with a `team:` block plus a body). The server spawns one `pi` process per team member, passes the protocol body as `--append-system-prompt`, and optionally sends per-agent instructions via JSONL RPC.

The key behavioral difference from squads is **inter-agent message routing**: when an agent produces an assistant message, that message is forwarded to the other agents in the room so they can react and continue the conversation.

Notes
- The create endpoint requires `Content-Type: text/markdown` and a protocol with front matter containing a `team:` block.
- Rooms auto-expire after 2 hours of inactivity.
- The host must have the `pi` binary available (spawned as `pi --mode rpc --no-session`).
- **Routing behavior:**
  - If the front matter contains a `routes:` block, the room operates in **Explicit Mode** (zero-trust routing).
  - If the `routes:` block is omitted, the room operates in **Broadcast Mode** (default): every assistant message is forwarded to all other agents.
- In **Explicit Mode**, when an agent sends a message the system resolves recipients by:
  1. Scanning the message text for inline `@attn:<identifier>` tags (dynamic targeting). An identifier is resolved against **both agent names and roles** — if it matches a name, that agent is targeted; if it matches a role, all agents with that role are targeted.
  2. Looking up the sender's statically configured recipients in the `routes:` block.
  3. Merging both pools, deduplicating them, and excluding the sender.
  4. If no valid recipients remain, the message is forwarded to the designated `facilitator:` agent (if configured) with a `[SYSTEM_ROUTING_FAILURE]` wrapper. If no facilitator is configured, the message is dropped with a system warning. If the sender *is* the facilitator, the system grants **one retry**: the first consecutive orphan message is sent back to the facilitator wrapped in `[SYSTEM_ROUTING_FAILURE]` with a retry notice; a second consecutive orphan message is dropped with a critical error to prevent infinite loops. The retry counter resets to zero whenever the facilitator successfully routes a message to other agents.
- You can optionally declare a `facilitator:` key in the front matter to designate a fallback agent for orphaned messages in Explicit Mode.
- You can optionally declare a `routes:` block in the front matter to control which agents receive messages from which sender.
- You can optionally declare a `tailor_shop:` block in the front matter to point to a directory containing agent-specific prompt files (`agents/<agent_name>.md`, falling back to `agents/<role>.md`) and an optional shared protocol (`working_protocol.md`). These files are passed as `--append-system-prompt` to each `pi` process. Agent files may include an optional YAML front matter with `model:` to override the model for that agent.
- You can optionally declare a `working_dir:` block in the front matter to set the working directory for all spawned `pi` processes. Relative paths are resolved against the API server's CWD; absolute paths are used as-is. When omitted, `pi` inherits the API server's CWD.
- You can optionally declare an `instructions:` block in the front matter to send per-agent prompt messages immediately after the room is created. When omitted, no initial prompt is sent — callers must use `POST /api/v1/agent-rooms/:roomId/instructions` to trigger agents.

## Error responses

All error responses use a standardized shape:

```json
{
  "error": {
    "code": "ROOM_NOT_FOUND",
    "message": "Room not found",
    "details": {} // optional, structured extra context
  }
}
```

Common error codes:
- `INVALID_CONTENT_TYPE` — 415, request Content-Type is not supported
- `INVALID_HEADER` — 400, a required header is missing or malformed
- `INVALID_BODY` — 400, request body failed schema validation
- `INVALID_QUERY` — 400, query parameters failed schema validation
- `ROOM_NOT_FOUND` — 404, room does not exist
- `ROOM_COMPLETED` — 409, room is already completed
- `AGENT_NOT_FOUND` — 400, target agent does not exist in the room
- `SUPERVISOR_ERROR` — 502, the room supervisor process returned an error
- `SSE_SUBSCRIPTION_FAILED` — 502, could not establish SSE subscription

---

## Endpoints

### 1) Create room
- Purpose: Create a new agent room from a protocol Markdown document and start agent processes.
- Request (HTTP):
  ```
  POST /api/v1/agent-rooms/
  Headers:
    Content-Type: text/markdown
    x-room-callback-url: https://caller.example.com/hooks/agent-room (optional)
    x-room-callback-secret: your-shared-secret (optional, used to sign x-signature)
    x-room-tag: my-namespace (optional, scopes room to a tag for filtering)
  Body: (raw protocol Markdown. Front matter may omit `team:` if defaults are provided by `tailor_shop/working_protocol.md`.)
  ```

- Success: 201 Created
  ```json
  { "roomId": "string", "status": "initialized" }
  ```
- Common errors: 415 `INVALID_CONTENT_TYPE`; 400 `INVALID_HEADER` for invalid callback headers; 502 `SUPERVISOR_ERROR` if no team is found in either the protocol or `working_protocol.md` defaults.
- Callback behavior (optional): when `x-room-callback-url` is set, the API sends HTTP POST callbacks on room close (`completed`, `manual`, `expired`) with body:
  ```json
  { "type": "room_closed", "roomId": "...", "reason": "completed|manual|expired", "at": "<ISO timestamp>" }
  ```
  and `x-signature` header (HMAC-SHA256 hex of raw JSON body) when `x-room-callback-secret` is set.

- Callback verification sample (Node/Express):

```ts
import crypto from "crypto";
import express from "express";

const app = express();

// IMPORTANT: capture raw body for signature verification.
app.use(express.raw({ type: "application/json" }));

app.post("/hooks/agent-room", (req, res) => {
  const secret = process.env.AGENT_ROOM_CALLBACK_SECRET;
  const signature = req.header("x-signature") ?? "";
  const rawBody = Buffer.isBuffer(req.body) ? req.body : Buffer.from("");

  if (secret) {
    const expected = crypto
      .createHmac("sha256", secret)
      .update(rawBody)
      .digest("hex");

    const sigBuf = Buffer.from(signature);
    const expectedBuf = Buffer.from(expected);
    if (sigBuf.length !== expectedBuf.length || !crypto.timingSafeEqual(sigBuf, expectedBuf)) {
      return res.status(401).json({ error: "Invalid signature" });
    }
  }

  const event = JSON.parse(rawBody.toString("utf8"));
  // { type: "room_closed", roomId, reason, at }
  console.log("agent room callback", event);

  return res.status(204).end();
});
```

- Callback verification sample (Fastify):

```ts
import crypto from "crypto";
import Fastify from "fastify";

const app = Fastify();

app.addContentTypeParser("application/json", { parseAs: "buffer" }, (_req, body, done) => {
  done(null, body);
});

app.post("/hooks/agent-room", async (request, reply) => {
  const secret = process.env.AGENT_ROOM_CALLBACK_SECRET;
  const signature = String(request.headers["x-signature"] ?? "");
  const rawBody = Buffer.isBuffer(request.body) ? request.body : Buffer.from("");

  if (secret) {
    const expected = crypto
      .createHmac("sha256", secret)
      .update(rawBody)
      .digest("hex");

    const sigBuf = Buffer.from(signature);
    const expectedBuf = Buffer.from(expected);
    if (sigBuf.length !== expectedBuf.length || !crypto.timingSafeEqual(sigBuf, expectedBuf)) {
      return reply.status(401).send({ error: "Invalid signature" });
    }
  }

  const event = JSON.parse(rawBody.toString("utf8"));
  // { type: "room_closed", roomId, reason, at }
  request.log.info({ event }, "agent room callback");

  return reply.status(204).send();
});
```

- Troubleshooting callback signature mismatches:
  - Most mismatches happen when you verify against a parsed/re-stringified JSON object instead of the **raw request bytes**.
  - Always compute HMAC on the raw body exactly as received.
  - Ensure your callback secret exactly matches `x-room-callback-secret` (no extra spaces/newlines).

- Example raw protocol with routing rules, tailor_shop, instructions, and agent files with front matter:

```md
---
team:
  smith: architect
  john: developer
tailor_shop: ./prompts
working_dir: ./project
instructions:
  smith: Please start design using 'requirements.md'
  john: Please implement the auth module
routes:
  smith:
    - john
  john:
    - smith
facilitator: smith
---

Design and implement the v1 API.
```

With this protocol:
1. The body (`Design and implement the v1 API.`) is written to a temp file and passed as `--append-system-prompt` to both agents.
2. `instructions:` are sent as JSONL `prompt` messages to `smith` and `john` immediately after spawn. Agents without an instruction entry remain idle.
3. Because a `routes:` block is present, the room runs in **Explicit Mode**:
   - `smith`'s messages are delivered to `john` (and any `@attn:<agent>` tags used inline).
   - `john`'s messages are delivered to `smith`.
   - If either agent sends a message with no valid recipients, it is forwarded to the `facilitator` (`smith`) wrapped in a `[SYSTEM_ROUTING_FAILURE]` alert.
4. `tailor_shop` resolution:
   - The server looks for `./prompts/agents/smith.md` first; if missing, it falls back to `./prompts/agents/architect.md`.
   - For `john`, it looks for `./prompts/agents/john.md` first, then falls back to `./prompts/agents/developer.md`.
   - If an agent file contains YAML front matter with `model:`, that model is passed as `--model` to `pi` and only the body (after `---`) is appended as `--append-system-prompt`. If there is no front matter, the entire file is appended directly.
   - `./prompts/working_protocol.md` is appended silently if it exists.

#### Defaults from working_protocol.md
When the protocol front matter includes a `tailor_shop:` path, the server also reads `tailor_shop/working_protocol.md` and treats its front matter as **defaults** for any missing keys:

| Key | Merge behavior |
|-----|---------------|
| `team:` | Used only if the main protocol has no team. |
| `routes:` | Used only if the main protocol has no routes. |
| `facilitator:` | Used only if the main protocol has no facilitator. |
| `instructions:` | Merged agent-by-agent; the main protocol overrides individual agents. |
| `working_dir:` | Used only if the main protocol has no working_dir. |

This allows you to keep shared configuration (team roster, routing rules, etc.) in a central `working_protocol.md` and create lightweight per-task protocols that only specify `tailor_shop:` and task-specific overrides such as `instructions:`. The main protocol always takes precedence.

---

### 2) Get room status
- Purpose: Get a compact status snapshot for a room and per-agent status, plus a pointer to the most recent stored event.
- Request (HTTP):
  ```
  GET /api/v1/agent-rooms/:roomId/status
  Headers: (none required)
  Body: none
  ```

- Success: 200 OK
  ```json
  {
    "roomId": "string",
    "status": "initialized | running | suspended | error | completed",
    "agents": { "<agentName>": { "status": "idle | streaming | error" }, ... },
    "lastEventId?": 42,
    "lastEventAt?": "<ISO timestamp>",
    "lastEventType?": "message",
    "lastEventFrom?": "smith",
    "failedAgent?": "john",
    "reason?": "spawn_failure"
  }
  ```
- Common error: 404 `ROOM_NOT_FOUND`

---

### 3) Get stored events
- Purpose: Retrieve coalesced events buffered for a room. Events are paginated and large text fields are automatically truncated.
- Request (HTTP):
  ```
  GET /api/v1/agent-rooms/:roomId/events
  GET /api/v1/agent-rooms/:roomId/events?since=<eventId>
  GET /api/v1/agent-rooms/:roomId/events?since=<eventId>&limit=<number>
  ```

- Query params:
  - `since` (optional): integer event id — return only events with `id > since`.
  - `limit` (optional): maximum number of events to return. Default: `100`. Max: `200`. Must be a positive integer.

- Success: 200 OK
  ```json
  {
    "roomId": "string",
    "total": 150,
    "returned": 100,
    "hasMore": true,
    "events": [
      {
        "id": 1,
        "from": "smith",
        "at": "<ISO timestamp>",
        "type": "thinking | message | tool_start | tool_end | retry_start | retry_end | agent_start | agent_end | room_error | room_closed",
        "_fieldTruncated?": true
      }
    ]
  }
  ```
- Common errors: 400 `INVALID_QUERY` for invalid `since` or `limit`; 404 `ROOM_NOT_FOUND`

- Notes:
  - If `limit` is omitted, the server defaults to 100 events.
  - Individual string fields (message text, thinking blocks, tool results) are truncated at 4000 characters. A `_fieldTruncated` flag is added to affected events.
  - Use `hasMore` + `since` cursors to paginate through large buffers.

---

### 4) Subscribe to SSE stream
- Purpose: Receive real-time agent events and room lifecycle events via Server-Sent Events.
- Request (HTTP):
  ```
  GET /api/v1/agent-rooms/:roomId/stream
  Headers:
    Last-Event-Id: 42   (optional — replay events after this id on reconnect)
  Body: none
  ```

- Success: 200 OK with headers:
  ```
  Content-Type: text/event-stream
  Cache-Control: no-cache
  Connection: keep-alive
  ```
- Common error: 404 `ROOM_NOT_FOUND`

- Reconnect behavior:
  - Clients should set the `Last-Event-Id` header to the last `id:` field received before disconnect.
  - The server replays all events with `id > Last-Event-Id` before resuming the live stream.
  - Each SSE event includes an `id:` field derived from the event's numeric `id`:
    ```
    id: 42
    event: message
    data: {"id":42,"from":"smith","type":"message","text":"hello"}
    ```

---

### 5) Send instructions / follow-ups to agent(s)
- Purpose: Queue follow-up messages to one or more agents in a room. Messages are sent as `prompt` (if agent idle) or `follow_up` (if streaming).
- Request (HTTP):
  ```
  POST /api/v1/agent-rooms/:roomId/instructions
  Headers:
    Content-Type: application/json
  Body (JSON):
  {
    "targetAgents": ["agentName1", "agentName2"],
    "followUp": ["Please focus on performance.", "Add error handling."]
  }
  ```

- Success: 200 OK
  ```json
  { "roomId": "string", "queuedItems": 2 }
  ```
- Common errors: 400 `INVALID_BODY` or `AGENT_NOT_FOUND`; 404 `ROOM_NOT_FOUND`; 409 `ROOM_COMPLETED`

---

### 6) Complete (destroy) room
- Purpose: Mark a room completed and clean up processes and SSE clients.
- Request (HTTP):
  ```
  DELETE /api/v1/agent-rooms/:roomId
  Headers: none
  Body: none
  ```

- Success: 200 OK
  ```json
  { "roomId": "string", "status": "deleted" }
  ```
- Common error: 404 `ROOM_NOT_FOUND`

---

### 7) List agent rooms
- Purpose: Retrieve a lightweight list of agent room sessions with optional filtering and **cursor-based pagination**.
- Request (HTTP):
  ```
  GET /api/v1/agent-rooms
  GET /api/v1/agent-rooms?status=<status>
  GET /api/v1/agent-rooms?tag=<tag>
  GET /api/v1/agent-rooms?limit=<number>
  GET /api/v1/agent-rooms?cursor=<cursor>
  GET /api/v1/agent-rooms?status=<status>&tag=<tag>&limit=<number>&cursor=<cursor>
  ```

- Query params:
  - `status` (optional): filter by lifecycle state — one of `initialized`, `running`, `suspended`, `error`, `completed`.
  - `tag` (optional): filter to rooms created with the matching `x-room-tag` header.
  - `limit` (optional): maximum number of rooms to return. Default: `50`. Max: `200`.
  - `cursor` (optional): opaque cursor string from the previous page's `nextCursor`. Omit for the first page.

- Success: 200 OK
  ```json
  {
    "rooms": [
      {
        "roomId": "string",
        "status": "initialized | running | suspended | error | completed",
        "agents": { "<agentName>": { "status": "idle | streaming | error" }, ... },
        "lastEventId?": 42,
        "lastEventAt?": "<ISO timestamp>",
        "lastEventType?": "message",
        "lastEventFrom?": "smith",
        "failedAgent?": "john",
        "reason?": "spawn_failure"
      }
    ],
    "nextCursor": "eyJjcmVhdGVkX2F0IjoxNzE1NDMyMTAwMDAwLCJyb29tX2lkIjoicm0teHl6In0" // null when no more pages
  }
  ```

- Pagination notes:
  - Results are ordered by `created_at DESC, roomId DESC`.
  - Pass `nextCursor` from the response into the next request's `cursor` query param.
  - When `nextCursor` is `null`, there are no more pages.

---

## Event types (overview)
- Events are emitted by agent processes and forwarded through SSE. Typical `type` values include:
  - `agent_start`, `agent_end`
  - `message_start`, `message_update`, `message_end`
  - `tool_execution_start`, `tool_execution_end`
  - `auto_retry_start`, `auto_retry_end`
  - `response`
  - `room_error` (from manager)
  - `room_closed` (from manager when room destroyed; reason: `expired|completed|manual`)

## Key behavioral difference from squads
- When an agent emits an assistant `message`, the room manager automatically forwards that message to the other agents (formatted as `[<senderName>]: <text>`).
- **Broadcast Mode** (no `routes:` block): messages are broadcast to all other agents.
- **Explicit Mode** (`routes:` block present): messages are routed only to agents explicitly targeted via `@attn:<identifier>` inline mentions (resolved against names and roles) or the sender's static `routes:` entries. If no recipients are resolved, the message is forwarded to the configured `facilitator:` agent with a `[SYSTEM_ROUTING_FAILURE]` wrapper, or dropped if no facilitator exists. If the sender *is* the facilitator, one self-retry is allowed before the message is dropped with a critical error; the retry counter resets when the facilitator successfully routes a message.

---

# API: /api/v1/dev-wrapup

Purpose

Generate development wrap-up metadata — commit message, PR title, and PR body — for a given workspace directory. The endpoint uses a Pi/LLM session to inspect the git state (`git diff --staged`, `git log`) and generate the metadata. No fallback payload is returned on failure.

Endpoints

1) Generate wrap-up
- Purpose: Use an LLM to analyze staged changes and return commit message, PR title, and PR body.
- Request (HTTP):
  POST /api/v1/dev-wrapup
  Headers:
    Content-Type: application/json
  Body (JSON):
  {
    "workspace_path": "/path/to/project",
    "include": "all"          // Optional. Default: "all". Allowed: "all", "commit", "pr"
  }

- Success: 200 OK
  Response shape depends on the `include` parameter:

  `include: "all"` (default):
  {
    "commit_message": "feat: add user authentication",
    "pr_title": "Add user authentication",
    "pr_body": "## Summary\n\nAdds auth.\n\n## Changes\n\n- Login\n\n## Risks\n\nLow",
    "has_staged_changes": true
  }

  `include: "commit"`:
  {
    "commit_message": "feat: add user authentication",
    "has_staged_changes": true
  }

  `include: "pr"`:
  {
    "pr_title": "Add user authentication",
    "pr_body": "## Summary\n\nAdds auth.\n\n## Changes\n\n- Login\n\n## Risks\n\nLow",
    "has_staged_changes": true
  }

- Error responses:
  - 400 `INVALID_BODY` — missing or invalid `workspace_path`, or invalid `include` value
  - 400 `INVALID_PATH` — `workspace_path` contains `..` path-traversal characters
  - 422 `NOT_A_GIT_REPO` — `workspace_path` is not a git repository
  - 502 `GENERATION_FAILED` — LLM generation failed or produced invalid/unsatisfiable output
  - 504 `GENERATION_TIMEOUT` — LLM generation timed out after 60 seconds
