import { z } from 'zod';

export const squadWorkflowInputSchema = z.object({
  protocolFilePath: z.string().describe('Path to the protocol markdown file'),
  instructions: z.string().describe('Instructions to send to all squad agents'),
  apiBaseUrl: z.string().optional().describe('Optional base URL for the squad API. Defaults to http://localhost:8080/api/v1/squads'),
});

export const createSquadOutputSchema = z.object({
  squadId: z.string(),
  apiBaseUrl: z.string(),
  instructions: z.string(),
});

export const waitIdleOutputSchema = z.object({
  squadId: z.string(),
  apiBaseUrl: z.string(),
  instructions: z.string(),
  agents: z.record(z.string(), z.object({ status: z.string() })),
});

export const sendInstructionsOutputSchema = z.object({
  squadId: z.string(),
  apiBaseUrl: z.string(),
  instructions: z.string(),
  agents: z.record(z.string(), z.object({ status: z.string() })),
  events: z.array(z.unknown()),
});

export const squadWorkflowOutputSchema = z.object({
  squadId: z.string(),
  status: z.string(),
  events: z.array(z.unknown()),
});
