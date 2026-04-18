import { createStep } from '@mastra/core/workflows';
import { waitIdleOutputSchema, agentRoomsWorkflowOutputSchema } from './agent-rooms-workflow-schemas';

export const agentRoomReturnStep = createStep({
  id: 'agent-room-return-step',
  description: 'Returns the final result of the agent room workflow without destroying the room.',
  inputSchema: waitIdleOutputSchema,
  outputSchema: agentRoomsWorkflowOutputSchema,
  execute: async ({ inputData }) => {
    if (!inputData) {
      throw new Error('Input data is required for agent-room-return-step');
    }

    const { roomId, apiBaseUrl, agents } = inputData;

    // Fetch final status
    const statusRes = await fetch(`${apiBaseUrl}/${roomId}/status`);
    let status = 'unknown';
    if (statusRes.ok) {
      const data = (await statusRes.json()) as { status: string };
      status = data.status;
    }

    // Fetch all events for the summary
    const eventsRes = await fetch(`${apiBaseUrl}/${roomId}/events`);
    const events: unknown[] = [];
    if (eventsRes.ok) {
      const data = (await eventsRes.json()) as { events: unknown[] };
      events.push(...data.events);
    }

    return { roomId, status, agents, events };
  },
});
