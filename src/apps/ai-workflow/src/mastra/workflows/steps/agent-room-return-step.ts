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

    // Fetch all events with pagination (server defaults to 100 per page)
    const allEvents: unknown[] = [];
    let since = 0;
    let hasMore = true;
    const maxPages = 25; // safety cap at buffer size

    for (let page = 0; page < maxPages && hasMore; page++) {
      const eventsRes = await fetch(`${apiBaseUrl}/${roomId}/events?since=${since}`);
      if (!eventsRes.ok) break;

      const data = (await eventsRes.json()) as {
        events: Array<{ id: number }>;
        hasMore: boolean;
      };

      allEvents.push(...data.events);
      hasMore = data.hasMore;

      if (data.events.length === 0) break;
      since = data.events[data.events.length - 1].id;
    }

    return { roomId, status, agents, events: allEvents };
  },
});
