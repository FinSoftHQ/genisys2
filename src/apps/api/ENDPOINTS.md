# API: /api/v1/squads

Purpose

This API manages "squads" — short-lived groups of autonomous agents spawned from a protocol Markdown document. A squad is created from a protocol file (YAML front matter with a `team:` block plus a body). The server spawns one `pi` process per team member, injects the protocol body as the initial prompt, and exposes status, a server-sent events (SSE) stream of agent events, and control endpoints to resume, instruct, or complete the squad.

This behavior mirrors tools/piteam/ (both use parseProtocol and operate on the same protocol Markdown format).

Notes
- The create endpoint requires Content-Type: text/markdown and a protocol with front matter containing a `team:` block.
- Squads auto-expire after 2 hours of inactivity.
- The host must have the `pi` binary available (spawned as `pi --mode rpc --no-session`).

Endpoints (starter guide)

1) Create squad
- Purpose: Create a new squad from a protocol Markdown document and start agent processes.
- Request (HTTP):
  POST /api/v1/squads/
  Headers:
    Content-Type: text/markdown
  Body: (raw protocol Markdown, must include front matter with team)

- Success: 201 Created
  Body: { squadId: string, status: "initialized" }
- Common error: 415 if Content-Type does not include text/markdown

- The example raw protocol (Markdown + front matter) are as follows:

```md
---
team:
  smith: Tester
  john: Developer
---

# Working Protocol

When you're ready, please say something, so that we know you're ready!
```

2) Get squad status
- Purpose: Get a compact status snapshot for a squad and per-agent status, plus a pointer to the most recent stored event.
- Request (HTTP):
  GET /api/v1/squads/:squadId/status
  Headers: (none required)
  Body: none

- Success: 200 OK
  Body: {
    squadId: string,
    status: "initialized" | "running" | "suspended" | "error" | "completed",
    agents: { "<agentName>": { status: "idle" | "streaming" | "error" }, ... },
    // present once at least one event has been stored:
    lastEventId?: number,       // monotonic integer id, use as ?since= cursor
    lastEventAt?: string,       // ISO 8601 timestamp
    lastEventType?: string,     // e.g. "message", "tool_start", "agent_end"
    lastEventFrom?: string,     // agent name that emitted the event
    // optional if failure:
    failedAgent?: string,
    reason?: string
  }
- Common error: 404 if squad not found

3) Get stored events
- Purpose: Retrieve all coalesced events buffered for a squad (up to 2500 most recent). These are the same events shown in the server console — full assembled messages, tool calls, retries, and lifecycle events. Per-token streaming deltas are NOT included.
- Request (HTTP):
  GET /api/v1/squads/:squadId/events
  GET /api/v1/squads/:squadId/events?since=<eventId>
  Headers: (none required)
  Body: none

- Query params:
  since (optional): integer event id — return only events with id > since. Use lastEventId from /status as the cursor for efficient incremental polling.

- Success: 200 OK
  Body: {
    squadId: string,
    total: number,      // total events currently in buffer (before since filter)
    events: Array<{
      id: number,       // monotonic, 1-based per squad
      from: string,     // agent name
      at: string,       // ISO 8601 timestamp
      type: "thinking" | "message" | "tool_start" | "tool_end"
           | "retry_start" | "retry_end" | "agent_start" | "agent_end" | "squad_error",
      // type-specific fields:
      // thinking:    thinking: string
      // message:     text: string
      // tool_start:  toolName: string, args: unknown
      // tool_end:    toolName: string, result: string, isError: boolean
      // retry_start: attempt: number, maxAttempts: number, delayMs: number, errorMessage: string
      // retry_end:   success: boolean, attempt: number, finalError?: string
      // squad_error: reason: string
    }>
  }
- Common errors: 400 for invalid since, 404 if squad not found

- Notes:
  - Buffer cap is 2500 events. Oldest events are dropped once the cap is reached.
  - Poll pattern: call /status to get lastEventId, then call /events?since=<lastEventId> for incremental updates.

4) Subscribe to SSE stream
- Purpose: Receive real-time agent events and squad lifecycle events via Server-Sent Events.
- Request (HTTP):
  GET /api/v1/squads/:squadId/stream
  Headers: none (client should handle SSE)
  Body: none

- Success: 200 OK with headers:
    Content-Type: text/event-stream
    Cache-Control: no-cache
    Connection: keep-alive
  The server sends SSE events (event: message) where `data` is a JSON object containing agent events. Manager broadcasts include a `from` property.
- Common error: 404 if squad not found

5) Resume squad (after error)
- Purpose: Resume a squad that entered an error state (retry failed operations).
- Request (HTTP):
  POST /api/v1/squads/:squadId/resume
  Headers:
    Content-Type: application/json
  Body (JSON):
    { "action": "retry_error" }

- Success: 202 Accepted
  Body: { squadId: string, status: string }
- Common errors: 400 for invalid body, 404 if squad not found

6) Send instructions / follow-ups to agent(s)
- Purpose: Queue follow-up messages to one or more agents in a squad. Messages are sent as `prompt` (if agent idle) or `follow_up` (if streaming).
- Request (HTTP):
  POST /api/v1/squads/:squadId/instructions
  Headers:
    Content-Type: application/json
  Body (JSON):
    {
      "targetAgents": ["agentName1", "agentName2"],
      "followUp": ["Please try again.", "Add tests."]
    }

- Success: 200 OK
  Body: { squadId: string, queuedItems: number }
- Common errors: 400 for invalid body or unknown agent, 404 if squad not found

7) Complete (destroy) squad
- Purpose: Mark a squad completed and clean up processes and SSE clients.
- Request (HTTP):
  DELETE /api/v1/squads/:squadId
  Headers: none
  Body: none

- Success: 200 OK
  Body: { squadId: string, status: "completed" }
- Common error: 404 if squad not found

8) List squads
- Purpose: Retrieve a lightweight list of all active squad sessions with optional filtering and pagination.
- Request (HTTP):
  GET /api/v1/squads
  GET /api/v1/squads?status=<status>
  GET /api/v1/squads?limit=<number>&offset=<number>
  Headers: (none required)
  Body: none

- Query params:
  status (optional): filter by lifecycle state — one of `initialized`, `running`, `suspended`, `error`, `completed`.
  limit (optional): maximum number of squads to return. Default: `50`. Max: `200`.
  offset (optional): number of squads to skip. Default: `0`.

- Success: 200 OK
  Body: Array<{
    squadId: string,
    status: "initialized" | "running" | "suspended" | "error" | "completed",
    agents: { "<agentName>": { status: "idle" | "streaming" | "error" }, ... },
    // present once at least one event has been stored:
    lastEventId?: number,
    lastEventAt?: string,
    lastEventType?: string,
    lastEventFrom?: string,
    // optional if failure:
    failedAgent?: string,
    reason?: string
  }>

Event types (overview)
- Events are emitted by agent processes and forwarded through SSE. Typical `type` values include:
  - agent_start, agent_end
  - message_start, message_update, message_end
  - tool_execution_start, tool_execution_end
  - auto_retry_start, auto_retry_end
  - response
  - squad_error (from manager)
  - squad_closed (from manager when squad destroyed; reason: "expired"|"completed"|"manual")

Integration tips
- Use the SSE stream to build live UIs showing agent progress and tool executions.
- Use resume and instructions to recover from agent failures or to drive additional interactions.

---

# API: /api/v1/agent-rooms

Purpose

This API manages "agent rooms" — chat rooms for AI agents where messages from one agent are automatically routed to other agents. Like squads, a room is created from a protocol Markdown document (YAML front matter with a `team:` block plus a body). The server spawns one `pi` process per team member, passes the protocol body as `--append-system-prompt`, and optionally sends per-agent instructions via JSONL RPC.

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
  4. If no valid recipients remain, the message is forwarded to the designated `facilitator:` agent (if configured) with a `[SYSTEM_ROUTING_FAILURE]` wrapper. If no facilitator is configured, the message is dropped with a system warning. If the sender *is* the facilitator, the message is dropped with a critical error to prevent infinite loops.
- You can optionally declare a `facilitator:` key in the front matter to designate a fallback agent for orphaned messages in Explicit Mode.
- You can optionally declare a `routes:` block in the front matter to control which agents receive messages from which sender.
- You can optionally declare a `tailor_shop:` block in the front matter to point to a directory containing agent-specific prompt files (`agents/<agent_name>.md`, falling back to `agents/<role>.md`) and an optional shared protocol (`working_protocol.md`). These files are passed as `--append-system-prompt` to each `pi` process. Agent files may include an optional YAML front matter with `model:` to override the model for that agent.
- You can optionally declare an `instructions:` block in the front matter to send per-agent prompt messages immediately after the room is created. When omitted, no initial prompt is sent — callers must use `POST /api/v1/agent-rooms/:roomId/instructions` to trigger agents.

Endpoints (starter guide)

1) Create room
- Purpose: Create a new agent room from a protocol Markdown document and start agent processes.
- Request (HTTP):
  POST /api/v1/agent-rooms/
  Headers:
    Content-Type: text/markdown
  Body: (raw protocol Markdown, must include front matter with team)

- Success: 201 Created
  Body: { roomId: string, status: "initialized" }
- Common error: 415 if Content-Type does not include text/markdown

- Example raw protocol with routing rules, tailor_shop, instructions, and agent files with front matter:

```md
---
team:
  smith: architect
  john: developer
tailor_shop: ./prompts
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

2) Get room status
- Purpose: Get a compact status snapshot for a room and per-agent status, plus a pointer to the most recent stored event.
- Request (HTTP):
  GET /api/v1/agent-rooms/:roomId/status
  Headers: (none required)
  Body: none

- Success: 200 OK
  Body: {
    roomId: string,
    status: "initialized" | "running" | "suspended" | "error" | "completed",
    agents: { "<agentName>": { status: "idle" | "streaming" | "error" }, ... },
    // present once at least one event has been stored:
    lastEventId?: number,
    lastEventAt?: string,
    lastEventType?: string,
    lastEventFrom?: string,
    // optional if failure:
    failedAgent?: string,
    reason?: string
  }
- Common error: 404 if room not found

3) Get stored events
- Purpose: Retrieve coalesced events buffered for a room. Events are paginated and large text fields are automatically truncated.
- Request (HTTP):
  GET /api/v1/agent-rooms/:roomId/events
  GET /api/v1/agent-rooms/:roomId/events?since=<eventId>
  GET /api/v1/agent-rooms/:roomId/events?since=<eventId>&limit=<number>
  Headers: (none required)
  Body: none

- Query params:
  since (optional): integer event id — return only events with id > since.
  limit (optional): maximum number of events to return. Default: 100. Must be a positive integer.

- Success: 200 OK
  Body: {
    roomId: string,
    total: number,        // total events currently in buffer (before since filter)
    returned: number,     // number of events in this response
    hasMore: boolean,     // true if more events are available beyond this page
    events: Array<{
      id: number,
      from: string,
      at: string,
      type: "thinking" | "message" | "tool_start" | "tool_end"
           | "retry_start" | "retry_end" | "agent_start" | "agent_end" | "room_error",
      // type-specific fields are identical to squads
      // present if any field in this event was truncated:
      _fieldTruncated?: boolean,
    }>
  }
- Common errors: 400 for invalid since or limit, 404 if room not found

- Notes:
  - If limit is omitted, the server defaults to 100 events.
  - Individual string fields (message text, thinking blocks, tool results) are truncated at 4000 characters. A _fieldTruncated flag is added to affected events.
  - Use hasMore + since cursors to paginate through large buffers.

4) Subscribe to SSE stream
- Purpose: Receive real-time agent events and room lifecycle events via Server-Sent Events.
- Request (HTTP):
  GET /api/v1/agent-rooms/:roomId/stream
  Headers: none (client should handle SSE)
  Body: none

- Success: 200 OK with headers:
    Content-Type: text/event-stream
    Cache-Control: no-cache
    Connection: keep-alive
- Common error: 404 if room not found

5) Send instructions / follow-ups to agent(s)
- Purpose: Queue follow-up messages to one or more agents in a room. Messages are sent as `prompt` (if agent idle) or `follow_up` (if streaming).
- Request (HTTP):
  POST /api/v1/agent-rooms/:roomId/instructions
  Headers:
    Content-Type: application/json
  Body (JSON):
    {
      "targetAgents": ["agentName1", "agentName2"],
      "followUp": ["Please focus on performance.", "Add error handling."]
    }

- Success: 200 OK
  Body: { roomId: string, queuedItems: number }
- Common errors: 400 for invalid body or unknown agent, 404 if room not found

6) Complete (destroy) room
- Purpose: Mark a room completed and clean up processes and SSE clients.
- Request (HTTP):
  DELETE /api/v1/agent-rooms/:roomId
  Headers: none
  Body: none

- Success: 200 OK
  Body: { roomId: string, status: "completed" }
- Common error: 404 if room not found

7) List agent rooms
- Purpose: Retrieve a lightweight list of all active agent room sessions with optional filtering and pagination.
- Request (HTTP):
  GET /api/v1/agent-rooms
  GET /api/v1/agent-rooms?status=<status>
  GET /api/v1/agent-rooms?limit=<number>&offset=<number>
  Headers: (none required)
  Body: none

- Query params:
  status (optional): filter by lifecycle state — one of `initialized`, `running`, `suspended`, `error`, `completed`.
  limit (optional): maximum number of rooms to return. Default: `50`. Max: `200`.
  offset (optional): number of rooms to skip. Default: `0`.

- Success: 200 OK
  Body: Array<{
    roomId: string,
    status: "initialized" | "running" | "suspended" | "error" | "completed",
    agents: { "<agentName>": { status: "idle" | "streaming" | "error" }, ... },
    // present once at least one event has been stored:
    lastEventId?: number,
    lastEventAt?: string,
    lastEventType?: string,
    lastEventFrom?: string,
    // optional if failure:
    failedAgent?: string,
    reason?: string
  }>

Event types (overview)
- Events are emitted by agent processes and forwarded through SSE. Typical `type` values include:
  - agent_start, agent_end
  - message_start, message_update, message_end
  - tool_execution_start, tool_execution_end
  - auto_retry_start, auto_retry_end
  - response
  - room_error (from manager)
  - room_closed (from manager when room destroyed; reason: "expired"|"completed"|"manual")

Key behavioral difference from squads
- When an agent emits an assistant `message`, the room manager automatically forwards that message to the other agents (formatted as `[<senderName>]: <text>`).
- **Broadcast Mode** (no `routes:` block): messages are broadcast to all other agents.
- **Explicit Mode** (`routes:` block present): messages are routed only to agents explicitly targeted via `@attn:<identifier>` inline mentions (resolved against names and roles) or the sender's static `routes:` entries. If no recipients are resolved, the message is forwarded to the configured `facilitator:` agent with a `[SYSTEM_ROUTING_FAILURE]` wrapper, or dropped if no facilitator exists.
