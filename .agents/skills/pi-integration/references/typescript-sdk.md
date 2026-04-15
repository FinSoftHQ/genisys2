# Pi TypeScript / Node.js SDK Reference

When helping a user build a Node.js or TypeScript application that talks to Pi, read this file.
There are two ways to do it. Choose the right one before writing code.

## Table of contents

1. [Option A — Direct `AgentSession` (recommended for TypeScript)](#option-a--direct-agentsession)
2. [Option B — Subprocess RPC with typed client](#option-b--subprocess-rpc-with-typed-client)
3. [Safe JSONL reader for Node.js](#safe-jsonl-reader-for-nodejs)
4. [Minimal subprocess example](#minimal-subprocess-example)
5. [Key pitfall: never use `readline`](#key-pitfall-never-use-readline)

---

## Option A — Direct `AgentSession`

If the target app is TypeScript or Node.js, the cleanest integration is to import `AgentSession`
directly from the package rather than spawning a subprocess. This avoids the overhead of a child
process, the complexity of process lifecycle management, and the JSONL parsing layer entirely.

```bash
npm install @mariozechner/pi-coding-agent
```

Then import and instantiate:

```typescript
import { AgentSession } from "@mariozechner/pi-coding-agent";
```

The full `AgentSession` API lives in `src/core/agent-session.ts` inside the package. Examine
`node_modules/@mariozechner/pi-coding-agent/src/core/agent-session.ts` (or the compiled `.d.ts`
files in `dist/`) to see the exact constructor signature and methods before writing any code — do
not guess the API surface.

The high-level contract is:
- Construct an `AgentSession` with the model configuration you want.
- Call methods to send prompts, get state, manage the session lifecycle.
- Subscribe to events using the session's event emitter to receive streaming output.

Because `AgentSession` is the same object the CLI uses internally, it supports all the same
capabilities as the RPC protocol — steering, compaction, extension hooks, etc. — but as first-class
method calls rather than serialized JSON.

**When to prefer Option A:**
- Your app is already TypeScript.
- You want strong types without writing a JSON codec.
- You don't need to run Pi in a separate OS process (e.g., for isolation or cross-machine setups).

---

## Option B — Subprocess RPC with typed client

If you still want to spawn Pi as a child process (useful for isolation, cross-process sandboxing,
or when embedding Pi in an Electron renderer that talks to a Node.js main process), the package
ships a typed client:

```typescript
// Source reference (check the compiled dist/ for the importable path)
// packages/coding-agent/src/modes/rpc/rpc-client.ts
import { RpcClient } from "@mariozechner/pi-coding-agent/dist/modes/rpc/rpc-client.js";
```

Examine the actual `rpc-client.ts` source or its type declarations before using it, as the exact
export path may differ between versions.

For a complete interactive example, see the test file bundled with the package:
`packages/coding-agent/test/rpc-example.ts`.

---

## Safe JSONL reader for Node.js

This is the most critical piece of any Node.js subprocess client. **Do not use Node's `readline`
module** — it splits on Unicode line separators U+2028 and U+2029, which are legal inside JSON
string values. The protocol uses `\n` (LF) only.

Use a manual `StringDecoder`-based buffer reader instead:

```typescript
import { StringDecoder } from "string_decoder";

function attachJsonlReader(
  stream: NodeJS.ReadableStream,
  onLine: (line: string) => void
): void {
  const decoder = new StringDecoder("utf8");
  let buffer = "";

  stream.on("data", (chunk: Buffer | string) => {
    buffer += typeof chunk === "string" ? chunk : decoder.write(chunk);

    while (true) {
      const newlineIndex = buffer.indexOf("\n");
      if (newlineIndex === -1) break;

      let line = buffer.slice(0, newlineIndex);
      buffer = buffer.slice(newlineIndex + 1);

      // Tolerate CRLF input from the remote side
      if (line.endsWith("\r")) line = line.slice(0, -1);

      if (line.length > 0) onLine(line);
    }
  });

  stream.on("end", () => {
    buffer += decoder.end();
    if (buffer.length > 0) {
      const line = buffer.endsWith("\r") ? buffer.slice(0, -1) : buffer;
      if (line.length > 0) onLine(line);
    }
  });
}
```

---

## Minimal subprocess example

```typescript
import { spawn } from "child_process";
import { StringDecoder } from "string_decoder";

const agent = spawn("pi", ["--mode", "rpc", "--no-session"]);

// Paste the attachJsonlReader function from above here, or import it.

attachJsonlReader(agent.stdout, (line) => {
  const event = JSON.parse(line);

  switch (event.type) {
    case "message_update": {
      const { assistantMessageEvent } = event;
      if (assistantMessageEvent?.type === "text_delta") {
        process.stdout.write(assistantMessageEvent.delta);
      }
      break;
    }
    case "agent_end":
      process.stdout.write("\n");
      break;
    case "response":
      if (!event.success) {
        console.error("[error]", event.error);
      }
      break;
  }
});

agent.stderr.on("data", (d: Buffer) => process.stderr.write(d));

// Send a prompt
function send(cmd: object): void {
  agent.stdin.write(JSON.stringify(cmd) + "\n");
}

send({ type: "prompt", message: "List files in the current directory." });

// Handle Ctrl+C
process.on("SIGINT", () => {
  send({ type: "abort" });
  setTimeout(() => process.exit(0), 500);
});
```

---

## Key pitfall: never use `readline`

This deserves repeating. The following is **broken** for Pi RPC:

```typescript
// WRONG — readline splits on U+2028/U+2029 which corrupts JSON
import readline from "readline";
const rl = readline.createInterface({ input: agent.stdout });
rl.on("line", (line) => JSON.parse(line)); // ← will fail on messages containing those chars
```

The correct approach is the `StringDecoder` buffer loop shown above. It is 20 lines and is the only
safe way to read JSONL from Pi's stdout in Node.js.

---

## Extension UI sub-protocol in TypeScript

If Pi has extensions that call `ctx.ui.select()`, `ctx.ui.confirm()`, etc., you will receive
`extension_ui_request` events on stdout from Pi. Your client must respond on stdin.

```typescript
attachJsonlReader(agent.stdout, (line) => {
  const event = JSON.parse(line);

  if (event.type === "extension_ui_request") {
    if (event.method === "confirm") {
      // Present the dialog to the user, then respond:
      const userSaidYes = true; // replace with real UI
      send({
        type: "extension_ui_response",
        id: event.id,
        confirmed: userSaidYes,
      });
    } else if (event.method === "select") {
      send({
        type: "extension_ui_response",
        id: event.id,
        value: event.options[0], // or present a picker to the user
      });
    }
    // Fire-and-forget methods (notify, setStatus, setWidget, setTitle, set_editor_text)
    // need no response — just display or log them.
    return;
  }

  // ... handle other events
});
```

See `rpc-protocol.md` for the full list of dialog methods and their response shapes.
