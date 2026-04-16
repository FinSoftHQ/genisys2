import { createStep } from '@mastra/core/workflows';
import { sendInstructionsOutputSchema, squadWorkflowOutputSchema } from './squad-workflow-schemas';

export const squadDeleteStep = createStep({
  id: 'squad-delete-step',
  description: 'Deletes the squad once all agents are idle again.',
  inputSchema: sendInstructionsOutputSchema,
  outputSchema: squadWorkflowOutputSchema,
  execute: async ({ inputData }) => {
    if (!inputData) {
      throw new Error('Input data is required for squad-delete-step');
    }

    const { squadId, apiBaseUrl, events } = inputData;
    const res = await fetch(`${apiBaseUrl}/${squadId}`, { method: 'DELETE' });

    if (!res.ok) {
      const text = await res.text();
      throw new Error(`Failed to delete squad: ${res.status} ${text}`);
    }

    const data = (await res.json()) as { squadId: string; status: string };
    return { squadId, status: data.status, events };
  },
});
