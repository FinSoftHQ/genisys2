---
name: pi-integration
description: >
  Guides building applications, UIs, IDE plugins, Electron apps, VSCode extensions, CLI wrappers, and
  any other software that connects to or embeds the Pi Coding Agent
  (@mariozechner/pi-coding-agent). Pi is a minimalist AI coding assistant that deliberately restricts
  itself to only 4 tools: Read, Write, Edit, and Bash. Use this skill whenever the user mentions
  integrating with Pi, building a Pi client, using the Pi RPC protocol, spawning pi as a subprocess,
  embedding pi in another app, working with AgentSession, writing Pi extensions, registering custom
  Pi tools, or using keywords like "@pi-integration", "@pi-rpc", "pi coding agent", "pi agent
  session", or "pi extension". Even if the user just asks how to talk to Pi programmatically, trigger
  this skill.
---

# Pi Coding Agent — Integration Guide

## What is Pi?

Pi is a minimalist AI coding agent. Its defining design decision is intentional constraint: **it
uses exactly 4 tools and no others** — `read`, `write`, `edit`, and `bash`. This isn't a
limitation; it's the architecture. Every file operation, every inspection, every side-effect goes
through one of those four primitives. The result is a small, auditable, hackable agent that embeds
well.

The npm package is `@mariozechner/pi-coding-agent`.

---

## Two integration pathways

When helping the user write code that connects to Pi, choose the right pathway first:

| Scenario | Approach |
|---|---|
| Node.js / TypeScript app | Import `AgentSession` directly (no subprocess) |
| Any other language (Python, Go, Rust, etc.) | Spawn `pi --mode rpc` as a subprocess and speak the JSON-Lines protocol |
| IDE plugin / Electron / web backend | Either — `AgentSession` if TypeScript; subprocess otherwise |

Read **`references/typescript-sdk.md`** for the direct TypeScript path.  
Read **`references/rpc-protocol.md`** for the subprocess / JSON-Lines path (all languages).

---

## Integration checklist

When writing an app that connects to Pi, work through this list:

- [ ] **Choose pathway** — direct `AgentSession` (TypeScript) or subprocess RPC?
- [ ] **Start Pi correctly** — subprocess: `pi --mode rpc [--no-session] [--provider X] [--model Y]`
- [ ] **Wire stdin/stdout** — stdin receives commands, stdout emits events; both are newline-delimited JSON (JSONL)
- [ ] **Use a safe JSONL reader** — split on `\n` only; avoid Node's `readline` (it splits on U+2028/U+2029 which are valid inside JSON strings and will corrupt messages)
- [ ] **Handle the response/event distinction** — commands get a `type: "response"` reply; agent progress arrives as `type: "agent_start"`, `message_update"`, `agent_end"`, etc.
- [ ] **Never fire-and-forget a prompt during streaming** — if `isStreaming` is true, use `streamingBehavior: "steer"` or `"followUp"`, or wait for `agent_end`
- [ ] **Handle `extension_ui_request` messages** — if Pi has extensions installed, it may send dialog requests (select, confirm, input) that your app must respond to; fire-and-forget ones (notify, setStatus) can be displayed or ignored
- [ ] **Optionally register extensions** — pass `pi -e ./my-extension.ts` to inject custom tools the LLM can call
- [ ] **Shut down cleanly** — send `{"type": "abort"}` then close stdin, or SIGTERM the process

---

## Pi's 4-tool philosophy and what it means for integrators

Pi's tools map directly to filesystem primitives:

| Tool | What it does |
|---|---|
| `read` | Read a file (with optional offset + limit for ranged reads) |
| `write` | Write a file (creates or overwrites) |
| `edit` | Apply a targeted string replacement inside a file |
| `bash` | Execute a shell command and capture output |

Pi will never call a tool outside this set unless you explicitly register one via an extension. This
has a practical implication: **the agent is not fetching URLs, calling APIs, or doing anything
invisible.** If your UI wants to show what Pi did, it only needs to watch for `tool_execution_start`
/ `tool_execution_end` events on those four names.

Extensions can register additional tools (see `references/extensions.md`), and those will appear
in `tool_execution_*` events under their registered name.

---

## Reference files

| File | When to read it |
|---|---|
| `references/rpc-protocol.md` | Building any non-TypeScript client, or wanting the full command/event reference |
| `references/typescript-sdk.md` | Building a TypeScript/Node.js app; covers `AgentSession` and the typed subprocess client |
| `references/extensions.md` | Registering custom tools, intercepting events, adding commands to Pi |

---

## Quick "hello world" (subprocess, any language)

```bash
# Start Pi in RPC mode (no session persistence for testing)
pi --mode rpc --no-session
```

Then write to its stdin:

```json
{"type": "prompt", "message": "List files in the current directory"}
```

Read its stdout line by line. You'll see a stream of JSON events — `agent_start`, `message_update`
chunks with `text_delta`, `tool_execution_start` for the bash call, then `agent_end`.

For a complete working example in Python, see `references/rpc-protocol.md`.  
For TypeScript, see `references/typescript-sdk.md`.
