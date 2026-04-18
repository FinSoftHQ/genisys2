import { createStep } from '@mastra/core/workflows';
import { sendInstructionsOutputSchema, agentRoomsWorkflowOutputSchema } from './agent-rooms-workflow-schemas';

export const agentRoomReturnStep = createStep({
  id: 'agent-room-return-step',
  description: 'Returns the final result of the agent room workflow without destroying the room.',
  inputSchema: sendInstructionsOutputSchema,
  outputSchema: agentRoomsWorkflowOutputSchema,
  execute: async ({ inputData }) => {
    if (!inputData) {
      throw new Error('Input data is required for agent-room-return-step');
    }

    const { roomId, agents, events } = inputData;

    // Fetch final status to include in output
    const { apiBaseUrl } = inputData;
    const res = await fetch(`${apiBaseUrl}/${roomId}/status`);
    let status = 'unknown';
    if (res.ok) {
      const data = (await res.json()) as { status: string };
      status = data.status;
    }

    return { roomId, status, agents, events };
  },
});
