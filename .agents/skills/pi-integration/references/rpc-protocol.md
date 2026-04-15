# Pi RPC Protocol Reference

Pi's RPC mode exposes a full bidirectional JSON-Lines (JSONL) protocol over `stdin`/`stdout`. This
document is the ground truth for building any language client against it.

## Table of contents

1. [Starting Pi in RPC mode](#starting-rpc-mode)
2. [Framing — the JSONL contract](#framing)
3. [Commands (stdin → Pi)](#commands)
4. [Responses](#responses)
5. [Events (Pi → stdout)](#events)
6. [Streaming and steering](#streaming-and-steering)
7. [Extension UI sub-protocol](#extension-ui-sub-protocol)
8. [Error handling](#error-handling)
9. [Message types reference](#message-types-reference)
10. [Complete Python example](#complete-python-example)

---

## Starting RPC mode

```bash
pi --mode rpc [options]
```

Common flags:

| Flag | Purpose |
|---|---|
| `--provider <name>` | LLM provider: `anthropic`, `openai`, `google`, etc. |
| `--model <pattern>` | Model ID or pattern, e.g. `anthropic/claude-sonnet-4-20250514` |
| `--no-session` | Disable session persistence (good for testing) |
| `--session-dir <path>` | Custom session storage directory |

Pi prints nothing to stdout until you send a command — it waits for input on stdin.

---

## Framing

RPC mode uses **strict JSONL**: every message (command or event) is one complete JSON object
followed by exactly one `\n` (LF) character.

Rules your parser must follow:

- **Split records on `\n` only.** Do not treat `\r\n`, `\r`, or any Unicode line separator
  (U+2028, U+2029) as a record boundary.
- **Strip a trailing `\r`** if present (to tolerate CRLF input from your side), but never treat
  `\r` alone as a separator.
- **Why this matters:** Node.js's built-in `readline` module splits on U+2028 and U+2029, which are
  perfectly valid inside JSON string values. If you use `readline`, it will silently corrupt any
  message that happens to contain those characters. Use a manual buffer-based reader instead (see
  the Node.js example in `typescript-sdk.md`).

---

## Commands

Commands are JSON objects written to Pi's **stdin**, one per line. Every command has a `type`
field. An optional `id` field lets you correlate a command to its response.

### Prompting commands

#### `prompt` — send a user message

```json
{"id": "req-1", "type": "prompt", "message": "Hello, world!"}
```

With images:

```json
{
  "type": "prompt",
  "message": "What's in this image?",
  "images": [{"type": "image", "data": "<base64>", "mimeType": "image/png"}]
}
```

**During streaming**, you must include `streamingBehavior`:

```json
{"type": "prompt", "message": "New instruction", "streamingBehavior": "steer"}
```

- `"steer"` — delivered after the current assistant turn finishes its tool calls, before the next
  LLM call.
- `"followUp"` — delivered only once the agent is completely idle.

Omitting `streamingBehavior` while streaming returns an error response.

#### `steer` — queue a steering message

Equivalent to `prompt` with `streamingBehavior: "steer"`. Use this when you know the agent is
running and you want to redirect it mid-flight.

```json
{"type": "steer", "message": "Stop and focus on error handling instead"}
```

#### `follow_up` — queue a follow-up message

Delivered after the agent finishes all tool calls and pending steers.

```json
{"type": "follow_up", "message": "After you're done, summarize what changed"}
```

#### `abort` — cancel current operation

```json
{"type": "abort"}
```

#### `new_session` — start a fresh conversation

```json
{"type": "new_session"}
```

With parent session tracking:

```json
{"type": "new_session", "parentSession": "/path/to/session.jsonl"}
```

### State commands

#### `get_state`

Returns current model, streaming status, session info, pending message counts.

```json
{"type": "get_state"}
```

Response `data` fields include: `model`, `thinkingLevel`, `isStreaming`, `isCompacting`,
`steeringMode`, `followUpMode`, `sessionFile`, `sessionId`, `sessionName`, `autoCompactionEnabled`,
`messageCount`, `pendingMessageCount`.

#### `get_messages`

Returns all `AgentMessage` objects in the conversation.

```json
{"type": "get_messages"}
```

### Model commands

| Command | Purpose |
|---|---|
| `set_model` | Switch provider+model: `{"type":"set_model","provider":"anthropic","modelId":"..."}` |
| `cycle_model` | Rotate to next configured model |
| `get_available_models` | List all configured models |

### Thinking level commands

| Command | Purpose |
|---|---|
| `set_thinking_level` | Set level: `"off"`, `"minimal"`, `"low"`, `"medium"`, `"high"`, `"xhigh"` |
| `cycle_thinking_level` | Rotate through levels |

### Queue mode commands

#### `set_steering_mode`

Controls how steer messages are delivered:
- `"all"` — deliver all pending steers after the current turn
- `"one-at-a-time"` — deliver one steer per completed turn (default)

```json
{"type": "set_steering_mode", "mode": "one-at-a-time"}
```

#### `set_follow_up_mode`

Same shape as `set_steering_mode` but for follow-up messages.

### Compaction commands

#### `compact`

Manually compress conversation context to reduce token usage.

```json
{"type": "compact", "customInstructions": "Keep focus on API changes"}
```

#### `set_auto_compaction`

```json
{"type": "set_auto_compaction", "enabled": true}
```

### Retry commands

| Command | Purpose |
|---|---|
| `set_auto_retry` | Enable/disable auto-retry on transient errors (overload, rate limit, 5xx) |
| `abort_retry` | Cancel a retry in progress |

### Bash command

Execute a shell command and add its output to the LLM's next context:

```json
{"type": "bash", "command": "git status"}
```

Important: bash output is **not** sent to the LLM immediately. It is stored internally and prepended
to the next `prompt` message. You can execute multiple bash commands before a prompt and all outputs
will be included.

#### `abort_bash`

```json
{"type": "abort_bash"}
```

### Session commands

| Command | Purpose |
|---|---|
| `get_session_stats` | Token usage, cost, context window percent |
| `export_html` | Export session to HTML file |
| `switch_session` | Load a different `.jsonl` session file |
| `fork` | Create a new session from a previous user message entry ID |
| `get_fork_messages` | List messages that can be forked from |
| `get_last_assistant_text` | Get the last assistant response as plain text |
| `set_session_name` | Set a display name for the session |

### Commands listing

#### `get_commands`

List available commands (extension commands, prompt templates, skills):

```json
{"type": "get_commands"}
```

Returns an array where each entry has `name`, `description`, `source` (`"extension"`, `"prompt"`,
or `"skill"`), optional `location`, and optional `path`.

---

## Responses

Every command produces exactly one response on stdout:

```json
{
  "type": "response",
  "command": "prompt",
  "id": "req-1",
  "success": true
}
```

On failure:

```json
{
  "type": "response",
  "command": "set_model",
  "success": false,
  "error": "Model not found: invalid/model"
}
```

The `id` field echoes the one you sent (if any). Successful commands may include a `data` field with
command-specific results.

---

## Events

Events stream from Pi's **stdout** asynchronously. They do NOT have an `id` field.

### Event catalog

| Event type | When it fires |
|---|---|
| `agent_start` | Agent begins processing a prompt |
| `agent_end` | Agent completes; `messages` field contains all generated messages |
| `turn_start` | New LLM turn begins |
| `turn_end` | Turn completes; includes assistant `message` and `toolResults` |
| `message_start` | A message (user/assistant/toolResult) begins |
| `message_update` | Streaming delta during assistant generation |
| `message_end` | A message completes |
| `tool_execution_start` | A tool call begins; `toolName`, `args` |
| `tool_execution_update` | Streaming partial result from a running tool |
| `tool_execution_end` | A tool call finishes; `result`, `isError` |
| `queue_update` | Steering or follow-up queue changed |
| `compaction_start` | Compaction begins (`reason`: `"manual"`, `"threshold"`, `"overflow"`) |
| `compaction_end` | Compaction completes or was aborted |
| `auto_retry_start` | Transient error triggered a retry |
| `auto_retry_end` | Retry succeeded or exhausted |
| `extension_error` | An extension threw an unhandled error |

### Reading streaming text

The most important event for rendering assistant output is `message_update`. Drill into
`assistantMessageEvent` to find the delta type:

```json
{
  "type": "message_update",
  "message": { "..." : "..." },
  "assistantMessageEvent": {
    "type": "text_delta",
    "contentIndex": 0,
    "delta": "Hello ",
    "partial": {}
  }
}
```

Delta types: `start`, `text_start`, `text_delta`, `text_end`, `thinking_start`, `thinking_delta`,
`thinking_end`, `toolcall_start`, `toolcall_delta`, `toolcall_end`, `done`, `error`.

For rendering live output, accumulate `text_delta` values. The `message` object in the event is a
snapshot of the partial message so far — you can use it directly to replace your display state.

### Tool execution events

Use `toolCallId` to correlate start/update/end events when Pi is running tools in parallel:

```json
{"type": "tool_execution_start", "toolCallId": "call_abc", "toolName": "bash", "args": {"command": "ls"}}
{"type": "tool_execution_update", "toolCallId": "call_abc", "toolName": "bash", "partialResult": {"content": [...]}}
{"type": "tool_execution_end",   "toolCallId": "call_abc", "toolName": "bash", "result": {"content": [...]}, "isError": false}
```

`partialResult` in `tool_execution_update` is the **accumulated** output so far, not a delta. To
display streaming bash output, simply replace your display with the latest `partialResult`.

---

## Streaming and steering

When the agent is actively processing (`isStreaming: true` in `get_state`), sending a plain `prompt`
without `streamingBehavior` will be rejected. You have two safe options:

1. **Steer** — intervene mid-flight, delivered between tool calls:
   ```json
   {"type": "steer", "message": "Actually, focus on the auth module only"}
   ```
2. **Follow-up** — queue something to happen after the agent finishes:
   ```json
   {"type": "follow_up", "message": "After that, run the tests"}
   ```

The `queue_update` event fires whenever the pending queue changes, giving you visibility into what
is queued:

```json
{"type": "queue_update", "steering": ["focus on auth"], "followUp": ["run tests"]}
```

---

## Extension UI sub-protocol

If Pi has extensions installed, those extensions may need to ask the user questions. This surfaces
through an extra request/response sub-protocol layered on top of the main event stream.

### Dialog requests (require a response)

Pi emits an `extension_ui_request` on stdout and **blocks** until you respond:

```json
{
  "type": "extension_ui_request",
  "id": "uuid-1",
  "method": "select",
  "title": "Allow dangerous command?",
  "options": ["Allow", "Block"],
  "timeout": 10000
}
```

Your app must write an `extension_ui_response` to stdin with the matching `id`:

```json
{"type": "extension_ui_response", "id": "uuid-1", "value": "Allow"}
```

To cancel a dialog: `{"type": "extension_ui_response", "id": "uuid-1", "cancelled": true}`

Dialog methods and their response shapes:

| Method | Response fields |
|---|---|
| `select` | `{"value": "<selected option string>"}` or `{"cancelled": true}` |
| `confirm` | `{"confirmed": true/false}` or `{"cancelled": true}` |
| `input` | `{"value": "<text>"}` or `{"cancelled": true}` |
| `editor` | `{"value": "<multiline text>"}` or `{"cancelled": true}` |

If a `timeout` field is present in the request, Pi will auto-resolve after that many milliseconds
— you do not need to track timeouts yourself.

### Fire-and-forget notifications (no response needed)

These arrive as `extension_ui_request` events but expect no response. Display them, log them, or
ignore them:

| Method | Purpose |
|---|---|
| `notify` | Show a notification; `notifyType`: `"info"`, `"warning"`, `"error"` |
| `setStatus` | Update a named footer/status entry; omit `statusText` to clear |
| `setWidget` | Show/clear a block of lines above/below the input area |
| `setTitle` | Set the window/tab title |
| `set_editor_text` | Prefill the input editor |

---

## Error handling

Parse errors return:

```json
{"type": "response", "command": "parse", "success": false, "error": "Unexpected token..."}
```

Failed commands return `success: false` with an `error` string. Never assume a command succeeded
without checking `success`.

Transient agent errors (overload, rate limit) trigger `auto_retry_start` / `auto_retry_end` events
if auto-retry is enabled.

---

## Message types reference

### Model object

```json
{
  "id": "claude-sonnet-4-20250514",
  "name": "Claude Sonnet 4",
  "api": "anthropic-messages",
  "provider": "anthropic",
  "reasoning": true,
  "contextWindow": 200000,
  "maxTokens": 16384,
  "cost": {"input": 3.0, "output": 15.0, "cacheRead": 0.3, "cacheWrite": 3.75}
}
```

### UserMessage

```json
{
  "role": "user",
  "content": "Hello!",
  "timestamp": 1733234567890,
  "attachments": []
}
```

`content` may be a string or an array of `TextContent` / `ImageContent` blocks.

### AssistantMessage

```json
{
  "role": "assistant",
  "content": [
    {"type": "text", "text": "Here is the result..."},
    {"type": "thinking", "thinking": "Let me reason through this..."},
    {"type": "toolCall", "id": "call_123", "name": "bash", "arguments": {"command": "ls"}}
  ],
  "provider": "anthropic",
  "model": "claude-sonnet-4-20250514",
  "usage": {"input": 100, "output": 50, "cacheRead": 0, "cacheWrite": 0, "cost": {...}},
  "stopReason": "toolUse",
  "timestamp": 1733234567890
}
```

Stop reasons: `"stop"`, `"length"`, `"toolUse"`, `"error"`, `"aborted"`.

### ToolResultMessage

```json
{
  "role": "toolResult",
  "toolCallId": "call_123",
  "toolName": "bash",
  "content": [{"type": "text", "text": "total 48\n..."}],
  "isError": false,
  "timestamp": 1733234567890
}
```

---

## Complete Python example

```python
import subprocess
import json

proc = subprocess.Popen(
    ["pi", "--mode", "rpc", "--no-session"],
    stdin=subprocess.PIPE,
    stdout=subprocess.PIPE,
    text=True,
)

def send(cmd: dict):
    proc.stdin.write(json.dumps(cmd) + "\n")
    proc.stdin.flush()

def read_events():
    for line in proc.stdout:
        line = line.rstrip("\r\n")
        if line:
            yield json.loads(line)

# Send a prompt
send({"id": "req-1", "type": "prompt", "message": "List files in the current directory."})

# Process events until agent_end
for event in read_events():
    t = event.get("type")

    if t == "message_update":
        delta = event.get("assistantMessageEvent", {})
        if delta.get("type") == "text_delta":
            print(delta["delta"], end="", flush=True)

    elif t == "tool_execution_start":
        print(f"\n[tool: {event['toolName']} → {event['args']}]")

    elif t == "agent_end":
        print("\n[done]")
        break

    elif t == "response" and not event.get("success"):
        print(f"\n[error] {event.get('error')}")
        break

proc.stdin.close()
proc.wait()
```
