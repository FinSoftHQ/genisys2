import type { FastifyInstance } from "fastify";
import { z } from "zod";
import {
  generateDevWrapup,
  GitRepoError,
  TimeoutError,
  GenerationError,
} from "./service.js";

const DevWrapupRequestSchema = z.object({
  workspace_path: z.string().min(1),
  include: z.enum(["all", "commit", "pr"]).default("all"),
});

export async function devWrapupRoutes(instance: FastifyInstance): Promise<void> {
  instance.post("/", async (request, reply) => {
    const body = DevWrapupRequestSchema.safeParse(request.body);
    if (!body.success) {
      return reply.status(400).send({
        error: {
          code: "INVALID_BODY",
          message: "Invalid request body",
          issues: body.error.issues,
        },
      });
    }

    if (body.data.workspace_path.includes("..")) {
      return reply.status(400).send({
        error: {
          code: "INVALID_PATH",
          message: "workspace_path contains invalid traversal characters",
        },
      });
    }

    try {
      const result = await generateDevWrapup(body.data.workspace_path, body.data.include);
      return reply.status(200).send(result);
    } catch (err) {
      if (err instanceof GitRepoError) {
        return reply.status(422).send({
          error: { code: "NOT_A_GIT_REPO", message: err.message },
        });
      }
      if (err instanceof TimeoutError) {
        return reply.status(504).send({
          error: {
            code: "GENERATION_TIMEOUT",
            message: "LLM generation timed out after 60s",
          },
        });
      }
      if (err instanceof GenerationError) {
        return reply.status(502).send({
          error: { code: "GENERATION_FAILED", message: err.message },
        });
      }
      request.log.error(err);
      return reply.status(500).send({
        error: { code: "INTERNAL_ERROR", message: "Unexpected error" },
      });
    }
  });
}
