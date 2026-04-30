import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fastify, { type FastifyInstance } from "fastify";
import { devWrapupRoutes } from "./routes.js";
import {
  generateDevWrapup,
  GitRepoError,
  TimeoutError,
  GenerationError,
} from "./service.js";

vi.mock("./service.js", () => ({
  generateDevWrapup: vi.fn(),
  GitRepoError: class GitRepoError extends Error {},
  TimeoutError: class TimeoutError extends Error {},
  GenerationError: class GenerationError extends Error {},
}));

describe("dev-wrapup routes", () => {
  let app: FastifyInstance;

  beforeEach(async () => {
    app = fastify();
    await app.register(devWrapupRoutes, { prefix: "/api/v1/dev-wrapup" });
    vi.mocked(generateDevWrapup).mockReset();
  });

  afterEach(async () => {
    await app.close();
  });

  it("returns 200 with LLM-generated wrap-up for valid workspace_path", async () => {
    vi.mocked(generateDevWrapup).mockResolvedValue({
      commit_message: "feat: add user authentication",
      pr_title: "Add user authentication",
      pr_body: "## Summary\n\nAdds auth.\n\n## Changes\n\n- Login\n\n## Risks\n\nLow",
      has_staged_changes: true,
    });

    const response = await app.inject({
      method: "POST",
      url: "/api/v1/dev-wrapup",
      payload: { workspace_path: "/home/user/projects/my-app" },
    });

    expect(response.statusCode).toBe(200);
    const json = response.json();
    expect(json).toEqual({
      commit_message: "feat: add user authentication",
      pr_title: "Add user authentication",
      pr_body: "## Summary\n\nAdds auth.\n\n## Changes\n\n- Login\n\n## Risks\n\nLow",
      has_staged_changes: true,
    });
  });

  it("returns 400 when workspace_path is missing", async () => {
    const response = await app.inject({
      method: "POST",
      url: "/api/v1/dev-wrapup",
      payload: {},
    });

    expect(response.statusCode).toBe(400);
    const json = response.json();
    expect(json.error.code).toBe("INVALID_BODY");
  });

  it("returns 400 when workspace_path is empty string", async () => {
    const response = await app.inject({
      method: "POST",
      url: "/api/v1/dev-wrapup",
      payload: { workspace_path: "" },
    });

    expect(response.statusCode).toBe(400);
    const json = response.json();
    expect(json.error.code).toBe("INVALID_BODY");
  });

  it("returns 400 when workspace_path contains path traversal", async () => {
    const response = await app.inject({
      method: "POST",
      url: "/api/v1/dev-wrapup",
      payload: { workspace_path: "../../../etc/passwd" },
    });

    expect(response.statusCode).toBe(400);
    const json = response.json();
    expect(json.error.code).toBe("INVALID_PATH");
  });

  it("returns 422 when workspace_path is not a git repo", async () => {
    vi.mocked(generateDevWrapup).mockImplementation(() => {
      throw new GitRepoError("workspace_path is not a git repository: /tmp/foo");
    });

    const response = await app.inject({
      method: "POST",
      url: "/api/v1/dev-wrapup",
      payload: { workspace_path: "/tmp/foo" },
    });

    expect(response.statusCode).toBe(422);
    const json = response.json();
    expect(json.error.code).toBe("NOT_A_GIT_REPO");
  });

  it("returns 502 when LLM generation fails", async () => {
    vi.mocked(generateDevWrapup).mockImplementation(() => {
      throw new GenerationError("Agent output is not valid JSON");
    });

    const response = await app.inject({
      method: "POST",
      url: "/api/v1/dev-wrapup",
      payload: { workspace_path: "/home/user/projects/my-app" },
    });

    expect(response.statusCode).toBe(502);
    const json = response.json();
    expect(json.error.code).toBe("GENERATION_FAILED");
  });

  it("returns 504 when LLM generation times out", async () => {
    vi.mocked(generateDevWrapup).mockImplementation(() => {
      throw new TimeoutError("LLM generation timed out after 60s");
    });

    const response = await app.inject({
      method: "POST",
      url: "/api/v1/dev-wrapup",
      payload: { workspace_path: "/home/user/projects/my-app" },
    });

    expect(response.statusCode).toBe(504);
    const json = response.json();
    expect(json.error.code).toBe("GENERATION_TIMEOUT");
  });

  it("returns 500 for unexpected errors", async () => {
    vi.mocked(generateDevWrapup).mockImplementation(() => {
      throw new Error("Something went wrong");
    });

    const response = await app.inject({
      method: "POST",
      url: "/api/v1/dev-wrapup",
      payload: { workspace_path: "/home/user/projects/my-app" },
    });

    expect(response.statusCode).toBe(500);
    const json = response.json();
    expect(json.error.code).toBe("INTERNAL_ERROR");
  });

  it("returns 400 for non-JSON body", async () => {
    const response = await app.inject({
      method: "POST",
      url: "/api/v1/dev-wrapup",
      headers: { "content-type": "text/plain" },
      payload: "not json",
    });

    expect(response.statusCode).toBe(400);
  });
});
