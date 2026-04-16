import { createStep } from '@mastra/core/workflows';
import { createSquadOutputSchema, waitIdleOutputSchema } from './squad-workflow-schemas';

export const squadWaitIdleStep = createStep({
  id: 'squad-wait-idle-step',
  description: 'Polls squad status until all agents are idle.',
  inputSchema: createSquadOutputSchema,
  outputSchema: waitIdleOutputSchema,
  execute: async ({ inputData }) => {
    if (!inputData) {
      throw new Error('Input data is required for squad-wait-idle-step');
    }

    const { squadId, apiBaseUrl, instructions } = inputData;
    const maxAttempts = 120;
    const intervalMs = 1000;

    for (let i = 0; i < maxAttempts; i++) {
      const res = await fetch(`${apiBaseUrl}/${squadId}/status`);
      if (!res.ok) {
        const text = await res.text();
        throw new Error(`Status check failed: ${res.status} ${text}`);
      }

      const data = (await res.json()) as {
        squadId: string;
        status: string;
        agents: Record<string, { status: string }>;
        failedAgent?: string;
        reason?: string;
      };

      if (data.status === 'error') {
        throw new Error(
          `Squad entered error state: ${data.reason ?? 'unknown'} (agent: ${data.failedAgent ?? 'unknown'})`
        );
      }

      const allIdle = Object.values(data.agents).every((a) => a.status === 'idle');
      if (allIdle) {
        return { squadId, apiBaseUrl, instructions, agents: data.agents };
      }

      await new Promise((r) => setTimeout(r, intervalMs));
    }

    throw new Error(`Timeout waiting for squad ${squadId} to become idle`);
  },
});
