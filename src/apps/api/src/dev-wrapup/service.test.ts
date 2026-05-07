import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { execSync } from "node:child_process";
import {
  generateDevWrapup,
  GitRepoError,
  GenerationError,
} from "./service.js";

vi.mock("@mariozechner/pi-ai", () => ({
  complete: vi.fn(),
  getModel: vi.fn((_provider: string, modelId: string) => ({ provider: _provider, modelId })),
}));

vi.mock("node:child_process", () => ({
  execSync: vi.fn(),
}));

vi.mock("node:fs", () => ({
  statSync: vi.fn(),
}));

vi.mock("../lib/ai-auth.js", () => ({
  getApiKey: vi.fn().mockResolvedValue("fake-api-key"),
}));

import { complete } from "@mariozechner/pi-ai";
import { statSync } from "node:fs";

const mockedComplete = vi.mocked(complete);
const mockedExecSync = vi.mocked(execSync);
const mockedStatSync = vi.mocked(statSync);

describe("generateDevWrapup", () => {
  const workingDir = "/tmp/test-repo";

  beforeEach(() => {
    mockedComplete.mockReset();
    mockedExecSync.mockReset();
    mockedStatSync.mockReset();

    mockedStatSync.mockReturnValue({ isDirectory: () => true } as ReturnType<typeof statSync>);

    // Default git repo validation
    mockedExecSync.mockImplementation((cmd: string | Buffer | URL, _options?: unknown) => {
      if (typeof cmd === "string" && cmd.includes("git rev-parse --git-dir")) {
        return ".git";
      }
      if (typeof cmd === "string" && cmd.includes("git diff --cached --name-only")) {
        return "file1.ts\n";
      }
      if (typeof cmd === "string" && cmd.includes("git diff --staged")) {
        return "diff --git a/file1.ts b/file1.ts\n+console.log('hello');";
      }
      if (typeof cmd === "string" && cmd.includes("git log --oneline -5")) {
        return "abc1234 feat: initial commit";
      }
      return "";
    });
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it("returns parsed commit_message for include=commit", async () => {
    mockedComplete.mockResolvedValue({
      role: "assistant",
      content: [
        {
          type: "text",
          text: `<<<COMMIT_MESSAGE>>>
feat(file1): add hello log
<<<END>>>`
        },
      ],
    } as unknown as Awaited<ReturnType<typeof complete>>);

    const result = await generateDevWrapup(workingDir, "commit");

    expect(result).toEqual({
      commit_message: "feat(file1): add hello log",
      has_staged_changes: true,
    });

    expect(mockedComplete).toHaveBeenCalledTimes(1);
    const callArgs = mockedComplete.mock.calls[0];
    expect(callArgs[1]).toHaveProperty("systemPrompt");
    expect(callArgs[1]).toHaveProperty("messages");
    expect(callArgs[1].messages).toHaveLength(1);
    expect(callArgs[1].messages[0].role).toBe("user");
  });

  it("returns parsed pr_title and pr_body for include=pr", async () => {
    mockedComplete.mockResolvedValue({
      role: "assistant",
      content: [
        {
          type: "text",
          text: `<<<PR_TITLE>>>
Add hello log
<<<PR_BODY>>>
## Summary

Adds a hello log.

## Changes

- Added hello log

## Risks

Low
<<<END>>>`
        },
      ],
    } as unknown as Awaited<ReturnType<typeof complete>>);

    const result = await generateDevWrapup(workingDir, "pr");

    expect(result).toEqual({
      pr_title: "Add hello log",
      pr_body: "## Summary\n\nAdds a hello log.\n\n## Changes\n\n- Added hello log\n\n## Risks\n\nLow",
      has_staged_changes: true,
    });
  });

  it("returns all fields for include=all", async () => {
    mockedComplete.mockResolvedValue({
      role: "assistant",
      content: [
        {
          type: "text",
          text: `<<<COMMIT_MESSAGE>>>
feat(file1): add hello log
<<<PR_TITLE>>>
Add hello log
<<<PR_BODY>>>
## Summary

Adds a hello log.
<<<END>>>`
        },
      ],
    } as unknown as Awaited<ReturnType<typeof complete>>);

    const result = await generateDevWrapup(workingDir, "all");

    expect(result).toEqual({
      commit_message: "feat(file1): add hello log",
      pr_title: "Add hello log",
      pr_body: "## Summary\n\nAdds a hello log.",
      has_staged_changes: true,
    });
  });

  it("throws GitRepoError when working_dir is not a git repo", async () => {
    mockedExecSync.mockImplementation((cmd: string | Buffer | URL, _options?: unknown) => {
      if (typeof cmd === "string" && cmd.includes("git rev-parse --git-dir")) {
        throw new Error("not a git repo");
      }
      return "";
    });

    await expect(generateDevWrapup(workingDir, "commit")).rejects.toThrow(GitRepoError);
  });

  it("throws GenerationError when LLM returns empty text", async () => {
    mockedComplete.mockResolvedValue({
      role: "assistant",
      content: [],
    } as unknown as Awaited<ReturnType<typeof complete>>);

    await expect(generateDevWrapup(workingDir, "commit")).rejects.toThrow(GenerationError);
  });

  it("throws GenerationError with provider error message when stopReason is error", async () => {
    mockedComplete.mockResolvedValue({
      role: "assistant",
      content: [],
      stopReason: "error",
      errorMessage: "OpenAI API key is required",
    } as unknown as Awaited<ReturnType<typeof complete>>);

    await expect(generateDevWrapup(workingDir, "commit")).rejects.toThrow("OpenAI API key is required");
  });

  it("throws GenerationError when LLM output lacks expected delimiters", async () => {
    mockedComplete.mockResolvedValue({
      role: "assistant",
      content: [
        {
          type: "text",
          text: "Here is a commit message: feat: something",
        },
      ],
    } as unknown as Awaited<ReturnType<typeof complete>>);

    await expect(generateDevWrapup(workingDir, "commit")).rejects.toThrow(GenerationError);
  });

  it("throws GenerationError when LLM output fails Zod validation", async () => {
    mockedComplete.mockResolvedValue({
      role: "assistant",
      content: [
        {
          type: "text",
          text: `<<<COMMIT_MESSAGE>>>
invalid commit message without conventional format
<<<END>>>`
        },
      ],
    } as unknown as Awaited<ReturnType<typeof complete>>);

    await expect(generateDevWrapup(workingDir, "commit")).rejects.toThrow(GenerationError);
  });

  it("uses only the first non-empty line for commit_message", async () => {
    mockedComplete.mockResolvedValue({
      role: "assistant",
      content: [
        {
          type: "text",
          text: `<<<COMMIT_MESSAGE>>>
feat(file1): add hello log
some extra line that should be ignored
<<<END>>>`
        },
      ],
    } as unknown as Awaited<ReturnType<typeof complete>>);

    const result = await generateDevWrapup(workingDir, "commit");

    expect(result).toEqual({
      commit_message: "feat(file1): add hello log",
      has_staged_changes: true,
    });
  });

  it("includes git diff and log in the user message", async () => {
    mockedComplete.mockResolvedValue({
      role: "assistant",
      content: [
        {
          type: "text",
          text: `<<<COMMIT_MESSAGE>>>
feat: test
<<<END>>>`
        },
      ],
    } as unknown as Awaited<ReturnType<typeof complete>>);

    await generateDevWrapup(workingDir, "commit");

    const callArgs = mockedComplete.mock.calls[0];
    const userMessage = callArgs[1].messages[0].content as string;
    expect(userMessage).toContain("diff --git");
    expect(userMessage).toContain("abc1234");
    expect(userMessage).toContain("<<<GIT_DIFF>>>");
  });
});
