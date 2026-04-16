import { createWorkflow } from '@mastra/core/workflows';
import { piAgentStep } from './steps/pi-agent-step';
import { piAgentDestroyStep } from './steps/pi-agent-destroy-step';
import { piAgentInputSchema, piAgentOutputSchema } from './steps/pi-agent-schemas';

export const piAgentWorkflow = createWorkflow({
  id: 'pi-agent-workflow',
  description:
    'Streams a coding instruction to Pi running inside a Rivet Agent OS sandbox and returns the accumulated output.',
  inputSchema: piAgentInputSchema,
  outputSchema: piAgentOutputSchema,
})
  .then(piAgentStep)
  .then(piAgentDestroyStep)
  .commit();
