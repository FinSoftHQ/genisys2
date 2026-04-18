import type { FastifyInstance } from "fastify";
import { z } from "zod";
import {
  createSquadFromMarkdown,
  listSquads,
  getSquad,
  getSquadStatus,
  getSquadEvents,
  addSseClient,
  removeSseClient,
  resumeSquad,
  sendInstructions,
  completeSquad,
} from "./manager.js";

const ResumeBodySchema = z.object({
  action: z.literal("retry_error"),
});

const InstructionsBodySchema = z.object({
  targetAgents: z.array(z.string().min(1)).min(1),
  followUp: z.array(z.string().min(1)).min(1),
});

export async function squadRoutes(instance: FastifyInstance): Promise<void> {
  instance.addContentTypeParser(
    "text/markdown",
    { parseAs: "string" },
    (_request, body, done) => {
      done(null, body);
    },
  );

  instance.get("/", async (request, reply) => {
    const { status } = request.query as { status?: string };
    const { limit: limitRaw, offset: offsetRaw } = request.query as {
      limit?: string;
      offset?: string;
    };
    let limit = 50;
    let offset = 0;
    if (limitRaw !== undefined) {
      const parsed = parseInt(limitRaw, 10);
      if (!isNaN(parsed)) limit = parsed;
    }
    if (offsetRaw !== undefined) {
      const parsed = parseInt(offsetRaw, 10);
      if (!isNaN(parsed)) offset = parsed;
    }
    return reply.status(200).send(listSquads(status, limit, offset));
  });

  instance.post("/", async (request, reply) => {
    const contentType = request.headers["content-type"] ?? "";
    if (!contentType.includes("text/markdown")) {
      return reply.status(415).send({ error: "Expected text/markdown" });
    }

    const markdown = request.body as string;
    const result = createSquadFromMarkdown(markdown);
    return reply.status(201).send({ squadId: result.squadId, status: "initialized" });
  });

  instance.get("/:squadId/status", async (request, reply) => {
    const { squadId } = request.params as { squadId: string };
    const squad = getSquad(squadId);
    if (!squad) {
      return reply.status(404).send({ error: "Squad not found" });
    }
    return reply.status(200).send(getSquadStatus(squad));
  });

  instance.get("/:squadId/events", async (request, reply) => {
    const { squadId } = request.params as { squadId: string };
    const squad = getSquad(squadId);
    if (!squad) {
      return reply.status(404).send({ error: "Squad not found" });
    }

    const { since } = request.query as { since?: string };
    let sinceId: number | undefined;
    if (since !== undefined) {
      sinceId = parseInt(since, 10);
      if (isNaN(sinceId)) {
        return reply.status(400).send({ error: "Invalid 'since' parameter, must be an integer event id" });
      }
    }

    const events = getSquadEvents(squad, sinceId);
    return reply.status(200).send({ squadId, total: squad.events.length, events });
  });

  instance.get("/:squadId/stream", async (request, reply) => {
    const { squadId } = request.params as { squadId: string };
    const squad = getSquad(squadId);
    if (!squad) {
      return reply.status(404).send({ error: "Squad not found" });
    }

    reply.raw.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    });

    addSseClient(squad, reply);

    request.raw.on("close", () => {
      removeSseClient(squad, reply);
    });
  });

  instance.post("/:squadId/resume", async (request, reply) => {
    const { squadId } = request.params as { squadId: string };
    const squad = getSquad(squadId);
    if (!squad) {
      return reply.status(404).send({ error: "Squad not found" });
    }

    const body = ResumeBodySchema.safeParse(request.body);
    if (!body.success) {
      return reply.status(400).send({ error: "Invalid body", issues: body.error.issues });
    }

    resumeSquad(squad, body.data.action);
    return reply.status(202).send({ squadId, status: squad.status });
  });

  instance.post("/:squadId/instructions", async (request, reply) => {
    const { squadId } = request.params as { squadId: string };
    const squad = getSquad(squadId);
    if (!squad) {
      return reply.status(404).send({ error: "Squad not found" });
    }

    const body = InstructionsBodySchema.safeParse(request.body);
    if (!body.success) {
      return reply.status(400).send({ error: "Invalid body", issues: body.error.issues });
    }

    let totalQueued = 0;
    for (const agentName of body.data.targetAgents) {
      try {
        const result = sendInstructions(squad, agentName, body.data.followUp);
        totalQueued += result.queuedItems;
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        return reply.status(400).send({ error: message, agent: agentName });
      }
    }
    return reply.status(200).send({ squadId, queuedItems: totalQueued });
  });

  instance.delete("/:squadId", async (request, reply) => {
    const { squadId } = request.params as { squadId: string };
    const squad = getSquad(squadId);
    if (!squad) {
      return reply.status(404).send({ error: "Squad not found" });
    }
    completeSquad(squadId);
    return reply.status(200).send({ squadId, status: "completed" });
  });
}
