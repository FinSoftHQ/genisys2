import { createWorkflow } from '@mastra/core/workflows';
import { agentRoomsWorkflowInputSchema, agentRoomsWorkflowOutputSchema } from './steps/agent-rooms-workflow-schemas';
import { agentRoomCreateStep } from './steps/agent-room-create-step';
import { agentRoomWaitIdleStep } from './steps/agent-room-wait-idle-step';
import { agentRoomInstructStreamStep } from './steps/agent-room-instruct-stream-step';
import { agentRoomReturnStep } from './steps/agent-room-return-step';

export const agentRoomsWorkflow = createWorkflow({
  id: 'agent-rooms-workflow',
  description:
    'Creates an agent room from a protocol markdown file, waits until all agents are idle, sends instructions while collecting the SSE stream, waits until idle again, and returns the result without destroying the room.',
  inputSchema: agentRoomsWorkflowInputSchema,
  outputSchema: agentRoomsWorkflowOutputSchema,
})
  .then(agentRoomCreateStep)
  .then(agentRoomWaitIdleStep)
  .then(agentRoomInstructStreamStep)
  .then(agentRoomReturnStep)
  .commit();
