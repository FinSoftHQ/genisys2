import { createStep } from '@mastra/core/workflows';
import { createRoomOutputSchema, waitIdleOutputSchema } from './agent-rooms-workflow-schemas';

export const agentRoomWaitIdleStep = createStep({
  id: 'agent-room-wait-idle-step',
  description: 'Polls agent room status until all agents are idle.',
  inputSchema: createRoomOutputSchema,
  outputSchema: waitIdleOutputSchema,
  execute: async ({ inputData }) => {
    if (!inputData) {
      throw new Error('Input data is required for agent-room-wait-idle-step');
    }

    const { roomId, apiBaseUrl } = inputData;
    const maxAttempts = 120;
    const intervalMs = 1000;

    for (let i = 0; i < maxAttempts; i++) {
      const res = await fetch(`${apiBaseUrl}/${roomId}/status`);
      if (!res.ok) {
        const text = await res.text();
        throw new Error(`Status check failed: ${res.status} ${text}`);
      }

      const data = (await res.json()) as {
        roomId: string;
        status: string;
        agents: Record<string, { status: string }>;
        failedAgent?: string;
        reason?: string;
      };

      if (data.status === 'error') {
        throw new Error(
          `Room entered error state: ${data.reason ?? 'unknown'} (agent: ${data.failedAgent ?? 'unknown'})`
        );
      }

      const allIdle = Object.values(data.agents).every((a) => a.status === 'idle');
      if (allIdle) {
        return { roomId, apiBaseUrl, agents: data.agents };
      }

      await new Promise((r) => setTimeout(r, intervalMs));
    }

    throw new Error(`Timeout waiting for room ${roomId} to become idle`);
  },
});
