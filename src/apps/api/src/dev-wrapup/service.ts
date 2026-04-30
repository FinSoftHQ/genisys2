import { execSync } from "node:child_process";
import { statSync } from "node:fs";
import { z } from "zod";
import {
  createAgentSession,
  SessionManager,
} from "@mariozechner/pi-coding-agent";
import type { AgentSessionEvent } from "@mariozechner/pi-coding-agent";

const GENERATION_TIMEOUT_MS = 60_000;

const WrapupResponseSchema = z.object({
  commit_message: z
    .string()
    .regex(
      /^(feat|fix|chore|docs|refactor|test|build|ci|perf|style|revert)(\(.+\))?!?: .+$/,
      "commit_message must follow Conventional Commits format"
    ),
  pr_title: z.string().min(1).max(200),
  pr_body: z.string().min(1),
});

export class GitRepoError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GitRepoError";
  }
}

export class TimeoutError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TimeoutError";
  }
}

export class GenerationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GenerationError";
  }
}

function hasStagedChanges(workspacePath: string): boolean {
  try {
    const output = execSync("git diff --cached --name-only", {
      cwd: workspacePath,
      encoding: "utf-8",
      stdio: ["pipe", "pipe", "ignore"],
      timeout: 5_000,
    });
    return output.trim().length > 0;
  } catch {
    return false;
  }
}

function validateGitRepo(workspacePath: string): void {
  try {
    const stats = statSync(workspacePath);
    if (!stats.isDirectory()) {
      throw new GitRepoError(`workspace_path is not a directory: ${workspacePath}`);
    }
  } catch (err) {
    if (err instanceof GitRepoError) throw err;
    throw new GitRepoError(`workspace_path does not exist: ${workspacePath}`);
  }

  try {
    execSync("git rev-parse --git-dir", {
      cwd: workspacePath,
      encoding: "utf-8",
      stdio: ["pipe", "pipe", "ignore"],
      timeout: 5_000,
    });
  } catch {
    throw new GitRepoError(
      `workspace_path is not a git repository: ${workspacePath}`
    );
  }
}

const SYSTEM_PROMPT = `You are a senior engineer preparing a commit and PR for review.

Your task:
1. Inspect the git state of the current workspace by running:
   - git diff --staged
   - git log --oneline -5
2. Based on the staged changes, generate a development wrap-up.

Constraints:
- Output MUST be valid JSON only. No markdown code fences. No explanatory text before or after the JSON.
- commit_message must follow Conventional Commits format: type(scope)?: description
  Allowed types: feat, fix, chore, docs, refactor, test, build, ci, perf, style, revert
  Must be a single line, lowercase type, concise.
- pr_title should be a clear, descriptive title for the Pull Request.
- pr_body should be markdown-formatted with these sections: ## Summary, ## Changes, ## Risks

JSON schema:
{
  "commit_message": "string",
  "pr_title": "string",
  "pr_body": "string"
}`;

async function runPiSession(workspacePath: string): Promise<unknown> {
  const { session } = await createAgentSession({
    cwd: workspacePath,
    sessionManager: SessionManager.inMemory(workspacePath),
  });

  let agentError: Error | undefined;

  const unsubscribe = session.subscribe((event: AgentSessionEvent) => {
    if (event.type === "auto_retry_end" && !event.success) {
      agentError = new GenerationError(
        `Agent retry failed: ${event.finalError ?? "unknown error"}`
      );
    }
  });

  try {
    await session.prompt(SYSTEM_PROMPT);

    // Wait for agent_end with a polling loop (isStreaming becomes false)
    const start = Date.now();
    const maxWait = GENERATION_TIMEOUT_MS;

    while (session.isStreaming && !agentError) {
      if (Date.now() - start > maxWait) {
        await session.abort();
        throw new TimeoutError("LLM generation timed out");
      }
      await new Promise((r) => setTimeout(r, 200));
    }

    if (agentError) {
      throw agentError;
    }

    const lastText = session.getLastAssistantText();
    if (!lastText) {
      throw new GenerationError("Agent produced no assistant text");
    }

    // Try to extract JSON if the agent wrapped it in markdown fences despite instructions
    const jsonMatch = lastText.match(/```(?:json)?\s*([\s\S]*?)\s*```/);
    const rawJson = jsonMatch ? jsonMatch[1].trim() : lastText.trim();

    let parsed: unknown;
    try {
      parsed = JSON.parse(rawJson);
    } catch (parseErr) {
      throw new GenerationError(
        `Agent output is not valid JSON: ${parseErr instanceof Error ? parseErr.message : String(parseErr)}`
      );
    }

    return parsed;
  } finally {
    unsubscribe();
    session.dispose();
  }
}

export async function generateDevWrapup(
  workspacePath: string
): Promise<{ commit_message: string; pr_title: string; pr_body: string; has_staged_changes: boolean }> {
  validateGitRepo(workspacePath);

  const result = await Promise.race([
    runPiSession(workspacePath),
    new Promise<never>((_, reject) => {
      setTimeout(() => {
        reject(new TimeoutError("LLM generation timed out after 60s"));
      }, GENERATION_TIMEOUT_MS);
    }),
  ]);

  const parsed = WrapupResponseSchema.safeParse(result);
  if (!parsed.success) {
    throw new GenerationError(
      `LLM output validation failed: ${parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join(", ")}`
    );
  }

  return {
    ...parsed.data,
    has_staged_changes: hasStagedChanges(workspacePath),
  };
}
