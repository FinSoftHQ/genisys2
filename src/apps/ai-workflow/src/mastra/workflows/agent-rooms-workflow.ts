import { createWorkflow } from '@mastra/core/workflows';
import { agentRoomsWorkflowInputSchema, agentRoomsWorkflowOutputSchema } from './steps/agent-rooms-workflow-schemas';
import { agentRoomCreateStep } from './steps/agent-room-create-step';
import { agentRoomWaitIdleStep } from './steps/agent-room-wait-idle-step';
import { agentRoomReturnStep } from './steps/agent-room-return-step';

export const agentRoomsWorkflow = createWorkflow({
  id: 'agent-rooms-workflow',
  description:
    'Creates an agent room from a protocol markdown file (front matter may be relaxed if defaults are provided by tailor_shop/working_protocol.md), waits until all agents are idle, and returns the final status and events without destroying the room.',
  inputSchema: agentRoomsWorkflowInputSchema,
  outputSchema: agentRoomsWorkflowOutputSchema,
})
  .then(agentRoomCreateStep)
  .then(agentRoomWaitIdleStep)
  .then(agentRoomReturnStep)
  .commit();
