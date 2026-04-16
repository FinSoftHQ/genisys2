import { createStep } from '@mastra/core/workflows';
import { readFileSync } from 'node:fs';
import { squadWorkflowInputSchema, createSquadOutputSchema } from './squad-workflow-schemas';

export const squadCreateStep = createStep({
  id: 'squad-create-step',
  description: 'Reads the protocol markdown file and creates a squad via the API.',
  inputSchema: squadWorkflowInputSchema,
  outputSchema: createSquadOutputSchema,
  execute: async ({ inputData }) => {
    if (!inputData) {
      throw new Error('Input data is required for squad-create-step');
    }

    const { protocolFilePath, instructions, apiBaseUrl } = inputData;
    const baseUrl = (apiBaseUrl ?? process.env.SQUAD_API_URL ?? 'http://localhost:8080/api/v1/squads').replace(/\/+$/, '');
    const markdown = readFileSync(protocolFilePath, 'utf-8');

    const res = await fetch(`${baseUrl}/`, {
      method: 'POST',
      headers: { 'Content-Type': 'text/markdown' },
      body: markdown,
    });

    if (!res.ok) {
      const text = await res.text();
      throw new Error(`Failed to create squad: ${res.status} ${text}`);
    }

    const data = (await res.json()) as { squadId: string; status: string };
    return { squadId: data.squadId, apiBaseUrl: baseUrl, instructions };
  },
});
