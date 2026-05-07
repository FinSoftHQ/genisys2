import { execSync } from "node:child_process";
import { statSync } from "node:fs";
import { z } from "zod";
import { complete } from "@mariozechner/pi-ai";
import { getModel } from "@mariozechner/pi-ai";
import { getApiKey } from "../lib/ai-auth.js";

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

function getGitDiffStaged(workingDir: string): string {
  try {
    return execSync("git diff --staged", {
      cwd: workingDir,
      encoding: "utf-8",
      stdio: ["pipe", "pipe", "ignore"],
      timeout: 10_000,
    });
  } catch {
    return "";
  }
}

function getGitLog(workingDir: string): string {
  try {
    return execSync("git log --oneline -5", {
      cwd: workingDir,
      encoding: "utf-8",
      stdio: ["pipe", "pipe", "ignore"],
      timeout: 10_000,
    });
  } catch {
    return "";
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

function buildUserMessage(
  workingDir: string,
  include: "all" | "commit" | "pr"
): string {
  const diff = getGitDiffStaged(workingDir);
  const log = getGitLog(workingDir);

  const sections: string[] = [];

  sections.push("Here are the staged changes:");
  sections.push("");
  sections.push("<<<GIT_DIFF>>>");
  sections.push(diff || "(no staged changes)");
  sections.push("<<<END>>>");
  sections.push("");
  sections.push("Recent commits:");
  sections.push(log || "(no commit history)");
  sections.push("");

  if (include === "commit") {
    sections.push("Write the following section:");
    sections.push("");
    sections.push("<<<COMMIT_MESSAGE>>>");
    sections.push("feat(scope): concise description of the change");
    sections.push("<<<END>>>");
    sections.push("");
    sections.push("Rules for commit_message:");
    sections.push("- Conventional Commits format: type(scope)?: description");
    sections.push("- Allowed types: feat, fix, chore, docs, refactor, test, build, ci, perf, style, revert");
    sections.push("- Single line, lowercase type, no trailing period");
  } else if (include === "pr") {
    sections.push("Write the following sections:");
    sections.push("");
    sections.push("<<<PR_TITLE>>>");
    sections.push("A clear, one-line title for the Pull Request");
    sections.push("<<<PR_BODY>>>");
    sections.push("## Summary");
    sections.push("");
    sections.push("Brief description of what this PR does.");
    sections.push("");
    sections.push("## Changes");
    sections.push("");
    sections.push("- Key change one");
    sections.push("- Key change two");
    sections.push("");
    sections.push("## Risks");
    sections.push("");
    sections.push("Risk assessment (e.g. Low — unit tests added).");
    sections.push("<<<END>>>");
    sections.push("");
    sections.push("Rules:");
    sections.push("- pr_title: single line, clear and descriptive");
    sections.push("- pr_body: well-structured markdown");
  } else {
    sections.push("Write the following sections:");
    sections.push("");
    sections.push("<<<COMMIT_MESSAGE>>>");
    sections.push("feat(scope): concise description of the change");
    sections.push("<<<PR_TITLE>>>");
    sections.push("A clear, one-line title for the Pull Request");
    sections.push("<<<PR_BODY>>>");
    sections.push("## Summary");
    sections.push("");
    sections.push("Brief description of what this PR does.");
    sections.push("");
    sections.push("## Changes");
    sections.push("");
    sections.push("- Key change one");
    sections.push("- Key change two");
    sections.push("");
    sections.push("## Risks");
    sections.push("");
    sections.push("Risk assessment (e.g. Low — unit tests added).");
    sections.push("<<<END>>>");
    sections.push("");
    sections.push("Rules:");
    sections.push("- commit_message: Conventional Commits format, single line, lowercase type");
    sections.push("- pr_title: single line, clear and descriptive");
    sections.push("- pr_body: well-structured markdown");
  }

  return sections.join("\n");
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

async function runCompletion(
  workingDir: string,
  include: "all" | "commit" | "pr"
): Promise<unknown> {
  const preferredModel = getModel("opencode-go", "deepseek-v4-flash");

  console.log(`[dev-wrapup] Starting AI completion in workspace: ${workingDir}`);

  const systemPrompt = buildSystemPrompt(include);
  const userMessage = buildUserMessage(workingDir, include);

  const apiKey = await getApiKey(preferredModel.provider);

  const response = await complete(
    preferredModel,
    {
      systemPrompt,
      messages: [
        {
          role: "user",
          content: userMessage,
          timestamp: Date.now(),
        },
      ],
    },
    { apiKey }
  );

  if (response.stopReason === "error") {
    throw new GenerationError(response.errorMessage || "LLM provider error");
  }

  const textContent = response.content
    .filter((c) => c.type === "text")
    .map((c) => (c as { text: string }).text)
    .join("");

  if (!textContent.trim()) {
    throw new GenerationError("LLM returned empty text");
  }

  const parsed = parseDelimitedResponse(textContent);
  if (Object.keys(parsed).length === 0) {
    throw new GenerationError(
      `LLM output did not contain expected delimiters (<<<COMMIT_MESSAGE>>>, <<<PR_TITLE>>>, or <<<PR_BODY>>>). Raw output: ${textContent.slice(0, 200)}`
    );
  }

  return parsed;
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
    runCompletion(workingDir, include),
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
  };
}
