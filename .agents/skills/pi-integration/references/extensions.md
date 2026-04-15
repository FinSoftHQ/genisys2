# Pi Extensions Reference

Extensions are TypeScript modules that augment Pi's behavior — they can register new tools for the
LLM to call, intercept and block tool calls, inject context into conversations, add custom commands,
handle UI events, and more.

## Table of contents

1. [Placement and discovery](#placement-and-discovery)
2. [Available imports](#available-imports)
3. [Minimal extension skeleton](#minimal-extension-skeleton)
4. [Registering custom tools](#registering-custom-tools)
5. [Key lifecycle events](#key-lifecycle-events)
6. [Intercepting and blocking tool calls](#intercepting-and-blocking-tool-calls)
7. [Registering commands](#registering-commands)
8. [User interaction via `ctx.ui`](#user-interaction-via-ctxui)
9. [Behavior in RPC mode](#behavior-in-rpc-mode)
10. [Security note](#security-note)

---

## Placement and discovery

Pi auto-discovers extensions from two locations:

| Path | Scope |
|---|---|
| `~/.pi/agent/extensions/*.ts` | Global — all projects |
| `~/.pi/agent/extensions/*/index.ts` | Global — subdirectory style |
| `.pi/extensions/*.ts` | Project-local |
| `.pi/extensions/*/index.ts` | Project-local — subdirectory style |

For quick testing, pass `-e` on the command line:

```bash
pi -e ./my-extension.ts
```

Extensions discovered in the auto-discovery paths can be hot-reloaded with `/reload` inside Pi.

You can also register additional paths via `settings.json`:

```json
{
  "extensions": ["/absolute/path/to/extension.ts"]
}
```

Extensions are loaded via [jiti](https://github.com/unjs/jiti), so TypeScript works without a
compilation step.

---

## Available imports

```typescript
import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
// For schema definitions in custom tools:
import { Type } from "@sinclair/typebox";
// For Google-compatible string enums:
import { StringEnum } from "@mariozechner/pi-ai";
// For TUI rendering (advanced):
import { /* components */ } from "@mariozechner/pi-tui";
```

npm packages work too — put a `package.json` next to your extension, run `npm install`, and
imports from `node_modules/` resolve automatically. Node built-ins (`node:fs`, `node:path`, etc.)
are available directly.

---

## Minimal extension skeleton

```typescript
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";

export default function (pi: ExtensionAPI) {
  pi.on("session_start", async (_event, ctx) => {
    ctx.ui.notify("My extension loaded!", "info");
  });
}
```

The default export is a function that receives the `ExtensionAPI` object (`pi`). Everything
happens through that object.

---

## Registering custom tools

Custom tools are callable by the LLM exactly like Pi's built-in `bash`, `read`, `write`, and
`edit` tools. They show up in `get_commands` (as `source: "extension"`) and in `tool_execution_*`
events with whatever `name` you register.

```typescript
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";

export default function (pi: ExtensionAPI) {
  pi.registerTool({
    name: "fetch_url",              // Must be snake_case; this is what the LLM calls
    label: "Fetch URL",            // Human-readable label for display
    description: "Fetch the text content of a URL and return it as plain text",
    parameters: Type.Object({
      url: Type.String({ description: "The URL to fetch" }),
      timeout_ms: Type.Optional(Type.Number({ description: "Timeout in milliseconds" })),
    }),

    async execute(toolCallId, params, signal, onUpdate, ctx) {
      // onUpdate streams partial results to the UI (optional)
      onUpdate?.({
        content: [{ type: "text", text: `Fetching ${params.url}...` }],
      });

      const response = await fetch(params.url, { signal });
      const text = await response.text();

      return {
        content: [{ type: "text", text }],
        details: { statusCode: response.status },
      };
    },
  });
}
```

Key points:
- `parameters` uses TypeBox schemas (`Type.Object`, `Type.String`, `Type.Number`, etc.)
- `execute` receives `signal` — pass it to any `fetch()` or async operation so that abort works
- `onUpdate` is optional; call it to stream partial content during long-running operations
- Return `{ content: [...], details: {...} }` — `content` goes to the LLM, `details` is for the UI
- `pi.registerTool()` can be called after startup (inside event handlers or commands), and new
  tools are immediately active without a `/reload`

---

## Key lifecycle events

### `session_start`

Runs once on startup, and again after `/reload`, `/new`, `/resume`, or `/fork`.

```typescript
pi.on("session_start", async (event, ctx) => {
  // event.reason: "startup" | "reload" | "new" | "resume" | "fork"
  // event.previousSessionFile: present for "new", "resume", "fork"
});
```

Use this to initialize state and restore anything you persisted via `pi.appendEntry()`.

### `before_agent_start`

Fires after the user submits a prompt, before the agent loop begins. Good for injecting extra
context or modifying the system prompt for a single turn.

```typescript
pi.on("before_agent_start", async (event, ctx) => {
  // event.prompt - the user's raw prompt text
  // event.systemPrompt - current system prompt

  return {
    // Inject a message into the session (visible to LLM on this turn)
    message: {
      customType: "my-extension",
      content: "Today's date is " + new Date().toISOString(),
      display: true,
    },
    // Or modify the system prompt (chained across extensions)
    systemPrompt: event.systemPrompt + "\n\nAlways cite file paths.",
  };
});
```

### `agent_end`

Fires when the agent completes a full prompt. Useful for post-turn cleanup, analytics, or
triggering follow-up actions.

```typescript
pi.on("agent_end", async (event, ctx) => {
  // event.messages - all messages generated during this agent run
});
```

### `session_shutdown`

Fires on exit (Ctrl+C, Ctrl+D, SIGTERM). Clean up resources here.

```typescript
pi.on("session_shutdown", async (_event, ctx) => {
  // flush buffers, close connections, etc.
});
```

---

## Intercepting and blocking tool calls

The `tool_call` event fires after a tool call is scheduled but before it runs. Return
`{ block: true, reason: "..." }` to prevent execution.

```typescript
import { isToolCallEventType } from "@mariozechner/pi-coding-agent";

pi.on("tool_call", async (event, ctx) => {
  // Guard dangerous bash commands
  if (isToolCallEventType("bash", event)) {
    // event.input is typed as { command: string; timeout?: number }
    if (event.input.command.includes("rm -rf")) {
      const ok = await ctx.ui.confirm(
        "Dangerous command",
        `Allow: ${event.input.command}?`
      );
      if (!ok) return { block: true, reason: "Blocked by user" };
    }
  }

  // Mutate tool arguments in place before execution
  if (isToolCallEventType("bash", event)) {
    event.input.command = `source ~/.profile\n${event.input.command}`;
  }
});
```

Key points:
- `event.input` is **mutable** — change it in place to patch arguments before execution
- Mutations are visible to subsequent `tool_call` handlers and to the actual tool
- Only `{ block: true, reason?: string }` is a meaningful return value; anything else is ignored
- Use `isToolCallEventType("bash", event)` for type narrowing on built-in tools

### Modifying tool results

The `tool_result` event fires after execution, before results are sent to the LLM:

```typescript
pi.on("tool_result", async (event, ctx) => {
  // event.toolName, event.content, event.details, event.isError

  // Return a partial patch — omit any fields you don't want to change
  return {
    content: [{ type: "text", text: "[output truncated by extension]" }],
  };
});
```

---

## Registering commands

Commands are invokable by the user with `/commandname`. In RPC mode they can be sent via
`{"type": "prompt", "message": "/commandname arg1 arg2"}`.

```typescript
pi.registerCommand("summarize", {
  description: "Print session statistics to the status bar",
  handler: async (args, ctx) => {
    const entries = ctx.sessionManager.getEntries();
    ctx.ui.notify(`${entries.length} entries in session`, "info");
  },
});
```

Commands receive `ExtensionCommandContext` which extends `ExtensionContext` with session control
methods (`ctx.waitForIdle()`, `ctx.newSession()`, `ctx.fork()`, `ctx.switchSession()`). Do not
call those methods from event handlers — only from command handlers.

---

## User interaction via `ctx.ui`

All event handlers and tool `execute` functions receive `ctx` which includes `ctx.ui`:

| Method | Behavior |
|---|---|
| `ctx.ui.notify(message, type)` | Show a notification (`"info"`, `"warning"`, `"error"`) |
| `ctx.ui.confirm(title, message)` | Show a yes/no dialog; returns `boolean` |
| `ctx.ui.select(title, options)` | Show a picker; returns selected string or `undefined` |
| `ctx.ui.input(title, placeholder?)` | Show a text input; returns string or `undefined` |
| `ctx.ui.setStatus(key, text?)` | Update a named footer status entry; omit `text` to clear |
| `ctx.ui.setWidget(key, lines?)` | Show lines above the editor; omit `lines` to clear |

In **RPC mode**, dialog methods (`confirm`, `select`, `input`, `editor`) are translated into
`extension_ui_request` messages on stdout. Your RPC client must handle them and respond with
`extension_ui_response` (see `rpc-protocol.md`). If no response is sent within the `timeout` field,
Pi auto-resolves with a default value.

---

## Persisting state across sessions

Use `pi.appendEntry()` to persist arbitrary data to the session file:

```typescript
pi.appendEntry("my-state", { counter: 42 });
```

Then restore on `session_start` by scanning entries:

```typescript
pi.on("session_start", async (_event, ctx) => {
  for (const entry of ctx.sessionManager.getEntries()) {
    if (entry.type === "custom" && entry.customType === "my-state") {
      // restore from entry.data
    }
  }
});
```

This data is NOT sent to the LLM — it is only for extension bookkeeping.

---

## Behavior in RPC mode

Extensions work in RPC mode with a few differences:

- `ctx.hasUI` is `true` — dialog methods work via the sub-protocol.
- `ctx.ui.custom()` is unavailable (returns `undefined`).
- `ctx.ui.setWorkingMessage()`, `setFooter()`, `setHeader()`, `setEditorComponent()` are no-ops.
- `ctx.ui.getEditorText()` always returns `""`.
- `ctx.ui.getAllThemes()` returns `[]`; `getTheme()` returns `undefined`; `setTheme()` fails.

---

## Security note

Extensions run with the full system permissions of the user running Pi. Never install extensions
from sources you don't trust, and be careful when building extensions that execute external
commands or make network requests on behalf of the LLM.
