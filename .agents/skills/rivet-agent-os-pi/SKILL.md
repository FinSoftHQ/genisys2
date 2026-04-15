---
name: rivet-agent-os-pi
description: >
  Guides building durable, multi-step coding agent workflows with Rivet agentOS and Pi.
  Use for Rivet agentOS + Pi, running Pi in Rivet VMs, agent workflows that survive
  crashes, Pi session orchestration with c.step(), agent chaining via filesystem,
  Pi extensions in ~/.pi/agent/extensions/, and agentic tools with @rivet-dev/agent-os-pi.
  Keywords: "agentOS Pi", "Rivet Pi workflow", "Pi in Rivet", "durable Pi agent",
  "agent-os-pi", "workflow pi rivet", "rivet pi c.step".
---

# Rivet agentOS + Pi Coding Agent

Build durable, multi-step coding agent workflows with Pi running inside Rivet's agentOS VMs. This skill covers both simple single-session usage and complex workflow orchestration that survives crashes and restarts.

## What This Covers

- **Single Pi sessions** in Rivet agentOS VMs
- **Durable workflows** with `workflow()` for multi-step Pi orchestration
- **Agent chaining** — output of one Pi session feeds into another
- **Pi extensions** in Rivet VMs (custom tools, system prompt modifications)
- **Data passing** between workflow steps via filesystem or return values

## Key Concepts

### Sessions are Ephemeral

Pi sessions **do not survive** workflow replays. Always create and close sessions within the same `c.step()`:

```typescript
// ✅ CORRECT: Session created and closed within one step
await c.step("do-work", async () => {
  const session = await agentHandle.createSession("pi", {
    env: { ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY! },
  });
  await agentHandle.sendPrompt(session.sessionId, "Write a function");
  await agentHandle.closeSession(session.sessionId);
});

// ❌ WRONG: Session spans multiple steps (won't exist after replay)
const session = await c.step("create", async () => {
  return await agentHandle.createSession("pi", { ... });
});
await c.step("prompt", async () => {
  await agentHandle.sendPrompt(session.sessionId, "..."); // Session gone!
});
```

### Separate Orchestrator from VM

Use separate actors: one for workflow logic, one for the Pi VM:

```typescript
const automator = actor({
  workflows: { task: workflow<{ input: string }>() },
  run: async (c) => { /* orchestration logic */ }
});

const vm = agentOs({
  options: { software: [common, pi] },
});

export const registry = setup({ use: { automator, vm } });
```

## Quick Start: Single Pi Session

The minimal setup to run Pi inside a Rivet VM:

**Server (`server.ts`):**
```typescript
import { agentOs } from "rivetkit/agent-os";
import { setup } from "rivetkit";
import common from "@rivet-dev/agent-os-common";
import pi from "@rivet-dev/agent-os-pi";

const vm = agentOs({
  options: { software: [common, pi] },
});

export const registry = setup({ use: { vm } });
registry.start();
```

**Client (`client.ts`):**
```typescript
import { createClient } from "rivetkit/client";
import type { registry } from "./server";

const client = createClient<typeof registry>("http://localhost:6420");
const agent = client.vm.getOrCreate(["my-agent"]);

const session = await agent.createSession("pi", {
  env: { ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY! },
});

const { text } = await agent.sendPrompt(
  session.sessionId,
  "What files are in the current directory?"
);
console.log(text);

await agent.closeSession(session.sessionId);
```

## Workflow Orchestration

### Basic Bug-Fix Workflow

Use `workflow()` for durable, multi-step orchestration:

```typescript
import { agentOs } from "rivetkit/agent-os";
import common from "@rivet-dev/agent-os-common";
import pi from "@rivet-dev/agent-os-pi";
import { actor, setup, workflow } from "rivetkit";

const automator = actor({
  workflows: {
    fixBug: workflow<{ repo: string; issue: string }>(),
  },
  run: async (c) => {
    for await (const message of c.workflow.iter("fixBug")) {
      const { repo, issue } = message.body;
      const agentHandle = c.actors.vm.getOrCreate([`fix-${issue}`]);

      // Step 1: Clone the repo
      await c.step("clone-repo", async () => {
        return agentHandle.exec(`git clone ${repo} /home/user/repo`);
      });

      // Step 2: Pi fixes the bug (session lives within this step)
      await c.step("fix-bug", async () => {
        const session = await agentHandle.createSession("pi", {
          env: { ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY! },
        });
        await agentHandle.sendPrompt(
          session.sessionId,
          `Fix the bug described in issue: ${issue}`,
        );
        await agentHandle.closeSession(session.sessionId);
      });

      // Step 3: Run tests
      const tests = await c.step("run-tests", async () => {
        return agentHandle.exec("cd /home/user/repo && npm test");
      });
      console.log("Tests exit code:", tests.exitCode);
      
      // Store results in state if callers need them (message.complete() takes no arguments)
      c.state.lastResult = { passed: tests.exitCode === 0 };
      await message.complete();
    }
  },
});

const vm = agentOs({
  options: { software: [common, pi] },
});

export const registry = setup({ use: { automator, vm } });
registry.start();
```

**Trigger the workflow:**
```typescript
import { createClient } from "rivetkit/client";
import type { registry } from "./server";

const client = createClient<typeof registry>("http://localhost:6420");
const handle = client.automator.getOrCreate(["main"]);

await handle.send("fixBug", {
  repo: "https://github.com/example/repo.git",
  issue: "Fix the login redirect bug",
});
```

### Agent Chaining Pattern

Output of one Pi session feeds into the next. Each session is isolated in its own step:

```typescript
const pipeline = actor({
  workflows: {
    codeReview: workflow<{ filePath: string }>(),
  },
  run: async (c) => {
    for await (const message of c.workflow.iter("codeReview")) {
      const agentHandle = c.actors.vm.getOrCreate([`review-${Date.now()}`]);

      // Step 1: Agent reviews code and writes findings to a file
      await c.step("review", async () => {
        const session = await agentHandle.createSession("pi", {
          env: { ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY! },
        });
        await agentHandle.sendPrompt(
          session.sessionId,
          `Review the code at ${message.body.filePath} and write your findings to /home/user/review.md`,
        );
        await agentHandle.closeSession(session.sessionId);
      });

      // Step 2: Read the review from the filesystem
      const review = await c.step("read-review", async () => {
        const content = await agentHandle.readFile("/home/user/review.md");
        return new TextDecoder().decode(content);
      });

      // Step 3: Second session applies fixes based on the review
      await c.step("fix", async () => {
        const session = await agentHandle.createSession("pi", {
          env: { ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY! },
        });
        await agentHandle.sendPrompt(
          session.sessionId,
          `Apply the following review feedback:\n\n${review}`,
        );
        await agentHandle.closeSession(session.sessionId);
      });

      await message.complete();
    }
  },
});
```

## Pi Extensions in Rivet VMs

Pi extensions let you register custom tools and modify system prompts. Extensions are discovered automatically from `.js` files in:

- `~/.pi/agent/extensions/` — Global (applies to all sessions)
- `<cwd>/.pi/extensions/` — Project-local (applies only when cwd matches)

### Installing an Extension

Write the extension file before creating the session:

```typescript
const extensionCode = `
module.exports = function(pi) {
  // Modify the system prompt before each agent turn
  pi.on("before_agent_start", async (event) => {
    return {
      systemPrompt: event.systemPrompt +
        "\\n\\nAlways respond in formal English."
    };
  });
  
  // Register a custom tool
  pi.tools.register("getWeather", async (args) => {
    return { temperature: 72, condition: "sunny" };
  });
};
`;

// Write the extension before creating the session
await vm.mkdir("/home/user/.pi/agent/extensions", { recursive: true });
await vm.writeFile("/home/user/.pi/agent/extensions/formal.js", extensionCode);

// Pi discovers the extension automatically
const { sessionId } = await vm.createSession("pi", {
  env: { ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY },
});
```

## Data Passing Patterns

### Via Filesystem (Recommended for Large Data)

```typescript
// Step 1: Write structured data
await c.step("generate-config", async () => {
  const session = await agentHandle.createSession("pi", { ... });
  await agentHandle.sendPrompt(
    session.sessionId,
    "Generate a JSON config for the API and save it to /home/user/config.json"
  );
  await agentHandle.closeSession(session.sessionId);
});

// Step 2: Read and use the data
const config = await c.step("load-config", async () => {
  const bytes = await agentHandle.readFile("/home/user/config.json");
  return JSON.parse(new TextDecoder().decode(bytes));
});

// Step 3: Use in next Pi session
await c.step("implement-api", async () => {
  const session = await agentHandle.createSession("pi", { ... });
  await agentHandle.sendPrompt(
    session.sessionId,
    `Implement the API using this config:\n${JSON.stringify(config, null, 2)}`
  );
  await agentHandle.closeSession(session.sessionId);
});
```

### Via Return Values (For Small Data)

```typescript
const summary = await c.step("summarize", async () => {
  const session = await agentHandle.createSession("pi", { ... });
  const result = await agentHandle.sendPrompt(
    session.sessionId,
    "Summarize this code in one sentence. Return only the summary."
  );
  await agentHandle.closeSession(session.sessionId);
  return result.text;
});

await c.step("document", async () => {
  const session = await agentHandle.createSession("pi", { ... });
  await agentHandle.sendPrompt(
    session.sessionId,
    `Write documentation based on this summary: ${summary}`
  );
  await agentHandle.closeSession(session.sessionId);
});
```

## Common Agentic Patterns

### Code Generator with Validation

```typescript
const generator = actor({
  workflows: {
    generateAndTest: workflow<{ spec: string; testCommand: string }>(),
  },
  run: async (c) => {
    for await (const message of c.workflow.iter("generateAndTest")) {
      const { spec, testCommand } = message.body;
      const vm = c.actors.vm.getOrCreate(["generator"]);

      // Generate code
      await c.step("generate", async () => {
        const session = await vm.createSession("pi", {
          env: { ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY! },
        });
        await vm.sendPrompt(
          session.sessionId,
          `Write a function that: ${spec}\n\nSave it to /home/user/src/impl.ts`
        );
        await vm.closeSession(session.sessionId);
      });

      // Run tests
      const testResult = await c.step("test", async () => {
        return vm.exec(testCommand);
      });

      // If tests fail, retry with feedback
      if (testResult.exitCode !== 0) {
        await c.step("fix", async () => {
          const session = await vm.createSession("pi", {
            env: { ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY! },
          });
          await vm.sendPrompt(
            session.sessionId,
            `Tests failed with:\n${testResult.stderr}\n\nFix the code in /home/user/src/impl.ts`
          );
          await vm.closeSession(session.sessionId);
        });
      }

      await message.complete();
    }
  },
});
```

### Multi-Agent Roundtable

```typescript
const roundtable = actor({
  workflows: {
    debate: workflow<{ topic: string; agentCount: number }>(),
  },
  run: async (c) => {
    for await (const message of c.workflow.iter("debate")) {
      const { topic, agentCount } = message.body;
      
      for (let round = 0; round < 3; round++) {
        await c.step(`round-${round}`, async () => {
          for (let i = 0; i < agentCount; i++) {
            const agentHandle = c.actors.vm.getOrCreate([`agent-${i}`]);
            
            // Read previous arguments
            let context = "";
            try {
              const prev = await agentHandle.readFile("/home/user/debate.log");
              context = new TextDecoder().decode(prev);
            } catch { /* first round */ }

            const session = await agentHandle.createSession("pi", {
              env: { ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY! },
            });
            
            await agentHandle.sendPrompt(
              session.sessionId,
              `Topic: ${topic}\n\nPrevious arguments:\n${context}\n\nProvide your argument.`
            );
            
            await agentHandle.closeSession(session.sessionId);
          }
        });
      }

      await message.complete();
    }
  },
});
```

## Streaming Long Pi Sessions in Workflows

Pi responses can be long-running. Since a `c.step()` re-executes entirely on replay, **never block waiting for a stream inside a step without persisting progress**. Two safe patterns:

### Pattern A: Stream within the step, persist to file

Have Pi write its output incrementally to a file inside the VM. Even if the step re-runs, Pi can resume from the file on retry.

```typescript
await c.step("write-code", async () => {
  const session = await vm.createSession("pi", {
    env: { ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY! },
  });
  
  try {
    // Pi writes its own checkpoint file during reasoning
    await vm.sendPrompt(
      session.sessionId,
      `Implement the feature. Save progress to /home/user/progress.md ` +
      `and the final code to /home/user/workspace/feature.ts.`
    );
  } finally {
    await vm.closeSession(session.sessionId);
  }
});
```

### Pattern B: Use agentOS event streaming APIs

For real-time UI updates, stream events inside the step but checkpoint to `c.state` after receiving milestones:

```typescript
await c.step("stream-generation", async () => {
  const session = await vm.createSession("pi", {
    env: { ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY! },
  });
  
  try {
    // agentOS supports streaming events from the session
    const stream = await vm.sendPromptStream(session.sessionId, "...");
    
    for await (const event of stream) {
      if (event.type === "tool_execution_end" || event.type === "checkpoint") {
        // Write progress to VM filesystem as a durable side effect
        await vm.writeFile(
          "/home/user/workspace/status.json",
          JSON.stringify({ lastEvent: event.type, timestamp: Date.now() })
        );
      }
    }
  } finally {
    await vm.closeSession(session.sessionId);
  }
});
```

## Pi Extensions that Call Rivet Actors

A powerful pattern: Pi extensions can use `rivetkit/client` to call actions on other actors in the registry. This bridges Pi's reasoning with Rivet's durable state.

```typescript
const extensionCode = `
const { createClient } = require("rivetkit/client");

module.exports = function(pi) {
  pi.tools.register("updateTicket", async (args) => {
    const client = createClient("http://localhost:6420");
    const tracker = client.ticketTracker.getOrCreate(["main"]);
    await tracker.updateStatus(args.ticketId, args.status);
    return { ok: true };
  });
};
`;

await vm.mkdir("/home/user/.pi/agent/extensions", { recursive: true });
await vm.writeFile("/home/user/.pi/agent/extensions/ticket-tool.js", extensionCode);
```

> **Why this matters**: Pi decides *what* to do, then the tool call goes through Rivet's durable actor system to *do* it. This turns Pi into an intelligent orchestrator of your backend.

## Idempotency and Replay Costs

`c.step()` is durable and **re-executes from scratch** if a workflow crashes and replays. This has important implications for LLM sessions:

- **If a step crashes *after* `sendPrompt` completes**, the entire step re-runs on replay. The Pi session is recreated and the prompt is sent again — incurring repeat token costs.
- **To minimize replay costs**, break large tasks into smaller, checkpointed steps.
- **Make side effects idempotent** where possible. For example, instead of "create a new file", use "write this exact content to this path". On replay, the file is overwritten with the same content — harmless.

### Good: Idempotent file operations

```typescript
await c.step("generate-api", async () => {
  const session = await vm.createSession("pi", { ... });
  try {
    await vm.sendPrompt(
      session.sessionId,
      `Write the exact API code to /home/user/api.ts. If the file already exists, overwrite it.`
    );
  } finally {
    await vm.closeSession(session.sessionId);
  }
});
```

### Bad: Non-idempotent side effects

```typescript
await c.step("create-user", async () => {
  const session = await vm.createSession("pi", { ... });
  await vm.sendPrompt(session.sessionId, "Create a new user in the database");
  // Replay will create a duplicate user!
});
```

## Error Handling and Retry

When a Pi session fails (e.g., API error, rate limit), catch the error and decide whether to retry, escalate, or abort:

```typescript
const resilientGenerator = actor({
  workflows: {
    generateWithRetry: workflow<{ spec: string }>(),
  },
  run: async (c) => {
    for await (const message of c.workflow.iter("generateWithRetry")) {
      const { spec } = message.body;
      const vm = c.actors.vm.getOrCreate(["resilient"]);
      
      let attempt = 0;
      const maxAttempts = 3;
      let success = false;
      let lastError = "";
      
      while (attempt < maxAttempts && !success) {
        try {
          await c.step(`generate-attempt-${attempt}`, async () => {
            const session = await vm.createSession("pi", {
              env: { ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY! },
            });
            
            try {
              const prompt = attempt === 0
                ? `Write code for: ${spec}`
                : `Previous attempt failed with: ${lastError}\n\nTry again. Write code for: ${spec}`;
              
              await vm.sendPrompt(session.sessionId, prompt);
              success = true;
            } finally {
              await vm.closeSession(session.sessionId);
            }
          });
        } catch (error) {
          lastError = String(error);
          attempt++;
          
          if (attempt >= maxAttempts) {
            console.error("All retry attempts exhausted:", lastError);
            // Persist failure info in state
            c.state.lastFailure = { spec, error: lastError, attempts: maxAttempts };
            throw new Error(`Failed after ${maxAttempts} attempts: ${lastError}`);
          }
          
          // Optional: wait before retry (use workflow timers for durable delays)
          await c.step(`wait-${attempt}`, async () => {
            await new Promise(resolve => setTimeout(resolve, 2000));
          });
        }
      }
      
      await message.complete();
    }
  },
});
```

For durable delays, use `ctx.step("wait", () => loopCtx.sleep(ms))` inside workflow loops instead of raw `setTimeout`.

## Best Practices

### Step Naming

Keep step names **stable** across code changes. Renaming a step breaks replay for in-progress workflows.

```typescript
// Good: Stable name
await c.step("clone-repo", async () => { ... });

// Bad: Dynamic name (breaks replay)
await c.step(`clone-${Date.now()}`, async () => { ... });
```

### Error Handling

Wrap Pi sessions in try/finally to ensure cleanup:

```typescript
await c.step("work", async () => {
  const session = await agentHandle.createSession("pi", { ... });
  try {
    await agentHandle.sendPrompt(session.sessionId, "...");
  } finally {
    await agentHandle.closeSession(session.sessionId);
  }
});
```

### Resource Cleanup

Actor handles returned by `c.actors.vm.getOrCreate()` are client-side references — they don't expose a `destroy()` method directly. To clean up VMs, either:

1. **Let them garbage-collect**: Idle VMs automatically sleep after inactivity (configurable)
2. **Add a shutdown action on the VM actor** and call it from the orchestrator:

```typescript
const vm = agentOs({
  options: { software: [common, pi] },
  actions: {
    shutdown: (c) => c.destroy(), // callable from orchestrator
  },
});

const automator = actor({
  workflows: { task: workflow() },
  run: async (c) => {
    for await (const message of c.workflow.iter("task")) {
      const agentHandle = c.actors.vm.getOrCreate([`task-${Date.now()}`]);
      
      // ... workflow steps ...
      
      // Gracefully ask the VM to destroy itself
      await c.step("cleanup", async () => {
        await agentHandle.shutdown();
      });
      
      await message.complete();
    }
  },
});
```

## Scripts

Use bundled scripts for common tasks:

| Script | Purpose |
|--------|---------|
| `scripts/scaffold-workflow.ts` | Scaffold a new agentOS + Pi workflow |
| `scripts/install-extension.ts` | Install a Pi extension in a Rivet VM |

Example:
```bash
npx tsx scripts/scaffold-workflow.ts --name my-agent --output ./my-agent
```

## Troubleshooting

### "Session not found" errors

This happens when you try to use a session across multiple steps. Sessions are ephemeral — always create and close within a single `c.step()`.

### Workflow replay issues

If a workflow restarts unexpectedly, ensure:
1. Step names are stable strings (not dynamic)
2. All side effects (file writes, API calls) happen inside `c.step()`
3. Sessions don't leak between steps

### Extension not loading

Verify the extension file was written before `createSession()` was called. Pi only scans for extensions at session startup.

## References

- [Rivet Workflows](https://rivet.dev/docs/agent-os/workflows/) — Workflow orchestration docs
- [Pi in agentOS](https://rivet.dev/docs/agent-os/agents/pi/) — Pi agent configuration
- [Sessions & Transcripts](https://rivet.dev/docs/agent-os/sessions/) — Session lifecycle
- [Tools](https://rivet.dev/docs/agent-os/tools/) — Custom tool registration
- [Extensions](https://rivet.dev/docs/agent-os/extensions/) — Full extension API
