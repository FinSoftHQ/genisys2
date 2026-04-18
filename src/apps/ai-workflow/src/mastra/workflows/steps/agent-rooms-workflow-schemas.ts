import { z } from 'zod';

export const agentRoomsWorkflowInputSchema = z.object({
  protocolFilePath: z.string().describe('Path to the protocol markdown file'),
  instructions: z.string().describe('Instructions to send to all room agents'),
  apiBaseUrl: z.string().optional().describe('Optional base URL for the agent rooms API. Defaults to http://localhost:8080/api/v1/agent-rooms'),
});

export const createRoomOutputSchema = z.object({
  roomId: z.string(),
  apiBaseUrl: z.string(),
  instructions: z.string(),
});

export const waitIdleOutputSchema = z.object({
  roomId: z.string(),
  apiBaseUrl: z.string(),
  instructions: z.string(),
  agents: z.record(z.string(), z.object({ status: z.string() })),
});

export const sendInstructionsOutputSchema = z.object({
  roomId: z.string(),
  apiBaseUrl: z.string(),
  instructions: z.string(),
  agents: z.record(z.string(), z.object({ status: z.string() })),
  events: z.array(z.unknown()),
});

export const agentRoomsWorkflowOutputSchema = z.object({
  roomId: z.string(),
  status: z.string(),
  agents: z.record(z.string(), z.object({ status: z.string() })),
  events: z.array(z.unknown()),
});
