import { createStep } from '@mastra/core/workflows';
import { readFileSync } from 'node:fs';
import { agentRoomsWorkflowInputSchema, createRoomOutputSchema } from './agent-rooms-workflow-schemas';

export const agentRoomCreateStep = createStep({
  id: 'agent-room-create-step',
  description: 'Reads the protocol markdown file and creates an agent room via the API.',
  inputSchema: agentRoomsWorkflowInputSchema,
  outputSchema: createRoomOutputSchema,
  execute: async ({ inputData }) => {
    if (!inputData) {
      throw new Error('Input data is required for agent-room-create-step');
    }

    const { protocolFilePath, instructions, apiBaseUrl } = inputData;
    const baseUrl = (apiBaseUrl ?? process.env.AGENT_ROOMS_API_URL ?? 'http://localhost:8080/api/v1/agent-rooms').replace(/\/+$/, '');
    const markdown = readFileSync(protocolFilePath, 'utf-8');

    const res = await fetch(`${baseUrl}/`, {
      method: 'POST',
      headers: { 'Content-Type': 'text/markdown' },
      body: markdown,
    });

    if (!res.ok) {
      const text = await res.text();
      throw new Error(`Failed to create agent room: ${res.status} ${text}`);
    }

    const data = (await res.json()) as { roomId: string; status: string };
    return { roomId: data.roomId, apiBaseUrl: baseUrl, instructions };
  },
});
