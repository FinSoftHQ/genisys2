import { z } from 'zod';

export const agentRoomsWorkflowInputSchema = z.object({
  protocolFilePath: z.string().describe('Path to the protocol markdown file'),
  apiBaseUrl: z.string().optional().describe('Optional base URL for the agent rooms API. Defaults to http://localhost:8080/api/v1/agent-rooms'),
});

export const createRoomOutputSchema = z.object({
  roomId: z.string(),
  apiBaseUrl: z.string(),
});

export const waitIdleOutputSchema = z.object({
  roomId: z.string(),
  apiBaseUrl: z.string(),
  agents: z.record(z.string(), z.object({ status: z.string() })),
});

export const agentRoomsWorkflowOutputSchema = z.object({
  roomId: z.string(),
  status: z.string(),
  agents: z.record(z.string(), z.object({ status: z.string() })),
  events: z.array(z.unknown()),
});
