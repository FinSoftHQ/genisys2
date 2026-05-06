import { execSync } from "node:child_process";
import { statSync } from "node:fs";
import { z } from "zod";
import {
  createAgentSession,
  SessionManager,
} from "@mariozechner/pi-coding-agent";
import { getModel } from "@mariozechner/pi-ai";
import type { AgentSessionEvent } from "@mariozechner/pi-coding-agent";

const GENERATION_TIMEOUT_MS = 60_000;

const WrapupResponseAllSchema = z.object({
  commit_message: z
    .string()
    .regex(
      /^(feat|fix|chore|docs|refactor|test|build|ci|perf|style|revert)(\(.+\))?!?: .+$/,
      "commit_message must follow Conventional Commits format"
    ),
  pr_title: z.string().min(1).max(200),
  pr_body: z.string().min(1),
});

const WrapupResponseCommitSchema = z.object({
  commit_message: z
    .string()
    .regex(
      /^(feat|fix|chore|docs|refactor|test|build|ci|perf|style|revert)(\(.+\))?!?: .+$/,
      "commit_message must follow Conventional Commits format"
    ),
});

const WrapupResponsePrSchema = z.object({
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

function hasStagedChanges(workingDir: string): boolean {
  try {
    const output = execSync("git diff --cached --name-only", {
      cwd: workingDir,
      encoding: "utf-8",
      stdio: ["pipe", "pipe", "ignore"],
      timeout: 5_000,
    });
    return output.trim().length > 0;
  } catch {
    return false;
  }
}

function validateGitRepo(workingDir: string): void {
  try {
    const stats = statSync(workingDir);
    if (!stats.isDirectory()) {
      throw new GitRepoError(`working_dir is not a directory: ${workingDir}`);
    }
  } catch (err) {
    if (err instanceof GitRepoError) throw err;
    throw new GitRepoError(`working_dir does not exist: ${workingDir}`);
  }

  try {
    execSync("git rev-parse --git-dir", {
      cwd: workingDir,
      encoding: "utf-8",
      stdio: ["pipe", "pipe", "ignore"],
      timeout: 5_000,
    });
  } catch {
    throw new GitRepoError(
      `working_dir is not a git repository: ${workingDir}`
    );
  }
}

/**
 * Delimiter-based output avoids JSON escaping issues entirely.
 * Models frequently emit literal newlines inside JSON strings,
 * which breaks JSON.parse at the first unescaped '\n' character.
 * Plain section markers are trivial for models to follow and
 * trivial for us to parse.
 */
function buildSystemPrompt(include: "all" | "commit" | "pr"): string {
  const base = `You are a senior engineer preparing a commit and PR for review.

Your task:
1. Run: git diff --staged
2. Run: git log --oneline -5
3. Based on the staged changes, write the sections requested below.

Output ONLY the delimited sections. Do not add any preamble, explanation, or extra text.`;

  if (include === "commit") {
    return `${base}

<<<COMMIT_MESSAGE>>>
feat(scope): concise description of the change
<<<END>>>

Rules for commit_message:
- Conventional Commits format: type(scope)?: description
- Allowed types: feat, fix, chore, docs, refactor, test, build, ci, perf, style, revert
- Single line, lowercase type, no trailing period`;
  }

  if (include === "pr") {
    return `${base}

<<<PR_TITLE>>>
A clear, one-line title for the Pull Request
<<<PR_BODY>>>
## Summary

Brief description of what this PR does.

## Changes

- Key change one
- Key change two

## Risks

Risk assessment (e.g. Low — unit tests added).
<<<END>>>

Rules:
- pr_title: single line, clear and descriptive
- pr_body: well-structured markdown`;
  }

  return `${base}

<<<COMMIT_MESSAGE>>>
feat(scope): concise description of the change
<<<PR_TITLE>>>
A clear, one-line title for the Pull Request
<<<PR_BODY>>>
## Summary

Brief description of what this PR does.

## Changes

- Key change one
- Key change two

## Risks

Risk assessment (e.g. Low — unit tests added).
<<<END>>>

Rules:
- commit_message: Conventional Commits format, single line, lowercase type
- pr_title: single line, clear and descriptive
- pr_body: well-structured markdown`;
}

/**
 * Parses the delimiter-based output produced by the model.
 * Each field sits between its opening <<<FIELD>>> marker and
 * either the next marker or <<<END>>>.
 */
function parseDelimitedResponse(text: string): Record<string, string> {
  const result: Record<string, string> = {};
  const markers = [
    { marker: "<<<COMMIT_MESSAGE>>>", key: "commit_message" },
    { marker: "<<<PR_TITLE>>>", key: "pr_title" },
    { marker: "<<<PR_BODY>>>", key: "pr_body" },
  ];
  const terminator = "<<<END>>>";

  for (let i = 0; i < markers.length; i++) {
    const { marker, key } = markers[i];
    const start = text.indexOf(marker);
    if (start === -1) continue;

    const contentStart = start + marker.length;

    // End is the next known marker, <<<END>>>, or end of string — whichever comes first.
    let end = text.length;
    for (let j = i + 1; j < markers.length; j++) {
      const nextPos = text.indexOf(markers[j].marker);
      if (nextPos !== -1 && nextPos < end) end = nextPos;
    }
    const termPos = text.indexOf(terminator);
    if (termPos !== -1 && termPos < end) end = termPos;

    let value = text.slice(contentStart, end).trim();

    // Commit messages must be a single line; take only the first non-empty line.
    if (key === "commit_message") {
      value = value.split("\n").map((l) => l.trim()).filter(Boolean)[0] ?? value;
    }

    result[key] = value;
  }

  return result;
}

async function runPiSession(workingDir: string, prompt: string): Promise<unknown> {
  // Attempt to use the github-copilot/gpt-5-mini model if available in the registry.
  const preferredModel = getModel("github-copilot", "gpt-5-mini");

  console.log(`[dev-wrapup] Starting AI session in workspace: ${workingDir}`);

  const { session } = await createAgentSession({
    cwd: workingDir,
    sessionManager: SessionManager.inMemory(workingDir),
    ...(preferredModel ? { model: preferredModel } : {}),
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
    await session.prompt(prompt);

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

    // Parse the delimiter-based response (no JSON escaping hazards).
    const parsed = parseDelimitedResponse(lastText);
    if (Object.keys(parsed).length === 0) {
      throw new GenerationError(
        `Agent output did not contain expected delimiters (<<<COMMIT_MESSAGE>>>, <<<PR_TITLE>>>, or <<<PR_BODY>>>). Raw output: ${lastText.slice(0, 200)}`
      );
    }

    return parsed;
  } finally {
    unsubscribe();
    session.dispose();
  }
}

export type DevWrapupResult =
  | { commit_message: string; pr_title: string; pr_body: string; has_staged_changes: boolean }
  | { commit_message: string; has_staged_changes: boolean }
  | { pr_title: string; pr_body: string; has_staged_changes: boolean };

export async function generateDevWrapup(
  workingDir: string,
  include: "all" | "commit" | "pr" = "all"
): Promise<DevWrapupResult> {
  console.log(`[dev-wrapup] Generating wrapup for workspace: ${workingDir}, include: ${include}`);

  validateGitRepo(workingDir);

  const schema =
    include === "commit"
      ? WrapupResponseCommitSchema
      : include === "pr"
        ? WrapupResponsePrSchema
        : WrapupResponseAllSchema;

  const result = await Promise.race([
    runPiSession(workingDir, buildSystemPrompt(include)),
    new Promise<never>((_, reject) => {
      setTimeout(() => {
        reject(new TimeoutError("LLM generation timed out after 60s"));
      }, GENERATION_TIMEOUT_MS);
    }),
  ]);

  const parsed = schema.safeParse(result);
  if (!parsed.success) {
    throw new GenerationError(
      `LLM output validation failed: ${parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join(", ")}`
    );
  }

  return {
    ...parsed.data,
    has_staged_changes: hasStagedChanges(workingDir),
  } as DevWrapupResult;
}
