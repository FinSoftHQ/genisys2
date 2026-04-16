import { createWorkflow } from '@mastra/core/workflows';
import { squadWorkflowInputSchema, squadWorkflowOutputSchema } from './steps/squad-workflow-schemas';
import { squadCreateStep } from './steps/squad-create-step';
import { squadWaitIdleStep } from './steps/squad-wait-idle-step';
import { squadInstructStreamStep } from './steps/squad-instruct-stream-step';
import { squadDeleteStep } from './steps/squad-delete-step';

export const squadWorkflow = createWorkflow({
  id: 'squad-workflow',
  description:
    'Creates a squad from a protocol markdown file, waits until all agents are idle, sends instructions while collecting the SSE /stream, waits until idle again, and finally deletes the squad.',
  inputSchema: squadWorkflowInputSchema,
  outputSchema: squadWorkflowOutputSchema,
})
  .then(squadCreateStep)
  .then(squadWaitIdleStep)
  .then(squadInstructStreamStep)
  .then(squadDeleteStep)
  .commit();
