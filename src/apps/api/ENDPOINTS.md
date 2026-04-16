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
- Purpose: Get a compact status snapshot for a squad and per-agent status.
- Request (HTTP):
  GET /api/v1/squads/:squadId/status
  Headers: (none required)
  Body: none

- Success: 200 OK
  Body: {
    squadId: string,
    status: "initialized" | "running" | "suspended" | "error" | "completed",
    agents: { "<agentName>": { status: "idle" | "streaming" | "error" }, ... },
    // optional if failure:
    failedAgent?: string,
    reason?: string
  }
- Common error: 404 if squad not found

3) Subscribe to SSE stream
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

4) Resume squad (after error)
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

5) Send instructions / follow-ups to agent(s)
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

6) Complete (destroy) squad
- Purpose: Mark a squad completed and clean up processes and SSE clients.
- Request (HTTP):
  DELETE /api/v1/squads/:squadId
  Headers: none
  Body: none

- Success: 200 OK
  Body: { squadId: string, status: "completed" }
- Common error: 404 if squad not found

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
