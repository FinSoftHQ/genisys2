import { createStep } from '@mastra/core/workflows';
import { createClient } from 'rivetkit/client';
import { piAgentOutputSchema } from './pi-agent-schemas';

/**
 * Mastra Workflow Step that destroys the Rivet Agent OS VM used by a Pi workflow run.
 *
 * This is intended as the final step of the piAgentWorkflow so the VM is cleaned up
 * after the run completes.
 */
export const piAgentDestroyStep = createStep({
  id: 'pi-agent-destroy-step',
  description:
    'Destroys the Rivet Agent OS VM associated with this workflow run to release resources.',
  inputSchema: piAgentOutputSchema,
  outputSchema: piAgentOutputSchema,
  execute: async ({ inputData, runId }) => {
    if (!inputData) {
      throw new Error('Input data is required for pi-agent-destroy-step');
    }

    const registryUrl = process.env.RIVET_AGENT_OS_URL ?? 'http://localhost:6420';
    const client = createClient(registryUrl);

    // Resolve the VM actor for this workflow run and ask it to shut down.
    const vm = client.vm.getOrCreate([runId]) as unknown as {
      shutdown(): Promise<void>;
    };

    try {
      await vm.shutdown();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      // Log but do not fail the workflow so the original Pi output is still returned.
      console.error(`Failed to destroy VM for run "${runId}": ${message}`);
    }

    return { piOutput: inputData.piOutput };
  },
});
