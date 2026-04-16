import { createStep } from '@mastra/core/workflows';
import { waitIdleOutputSchema, sendInstructionsOutputSchema } from './squad-workflow-schemas';

export const squadInstructStreamStep = createStep({
  id: 'squad-instruct-stream-step',
  description:
    'Sends instructions to all agents, collects the SSE /stream until all agents are idle again.',
  inputSchema: waitIdleOutputSchema,
  outputSchema: sendInstructionsOutputSchema,
  execute: async ({ inputData }) => {
    if (!inputData) {
      throw new Error('Input data is required for squad-instruct-stream-step');
    }

    const { squadId, apiBaseUrl, instructions, agents } = inputData;
    const agentNames = Object.keys(agents);

    // 1. Open SSE connection before sending instructions so we don't miss events.
    const streamUrl = `${apiBaseUrl}/${squadId}/stream`;
    const abortController = new AbortController();
    let sseRes: Response;
    try {
      sseRes = await fetch(streamUrl, { signal: abortController.signal });
      if (!sseRes.ok || !sseRes.body) {
        throw new Error(`SSE stream returned ${sseRes.status}`);
      }
    } catch (err) {
      throw new Error(
        `Failed to open SSE stream: ${err instanceof Error ? err.message : String(err)}`
      );
    }

    // 2. Background task that drains the SSE response body.
    const events: unknown[] = [];
    const readerPromise = (async () => {
      try {
        const reader = sseRes.body.getReader();
        const decoder = new TextDecoder();
        let buffer = '';

        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          const parts = buffer.split('\n\n');
          buffer = parts.pop() ?? '';

          for (const part of parts) {
            const dataLine = part.split('\n').find((l) => l.startsWith('data: '));
            if (!dataLine) continue;
            const jsonStr = dataLine.slice(6);
            try {
              const parsed = JSON.parse(jsonStr) as Record<string, unknown>;
              events.push(parsed);
            } catch {
              events.push({ raw: jsonStr });
            }
          }
        }
      } catch (err) {
        if (err instanceof Error && err.name === 'AbortError') return;
        throw err;
      }
    })();

    // 4. Poll status until all agents are idle again (or timeout).
    const maxAttempts = 300; // up to 5 minutes
    const intervalMs = 1000;
    let finalAgents = agents;

    for (let i = 0; i < maxAttempts; i++) {
      await new Promise((r) => setTimeout(r, intervalMs));
      const res = await fetch(`${apiBaseUrl}/${squadId}/status`);
      if (!res.ok) continue;

      const data = (await res.json()) as {
        status: string;
        agents: Record<string, { status: string }>;
        failedAgent?: string;
        reason?: string;
      };

      if (data.status === 'error') {
        abortController.abort();
        throw new Error(
          `Squad error during streaming: ${data.reason ?? 'unknown'} (agent: ${data.failedAgent ?? 'unknown'})`
        );
      }

      const allIdle = Object.values(data.agents).every((a) => a.status === 'idle');
      if (allIdle) {
        finalAgents = data.agents;
        break;
      }
    }

    // Grace period for any trailing SSE events, then abort the stream.
    await new Promise((r) => setTimeout(r, 500));
    abortController.abort();
    await readerPromise.catch(() => {
      // Swallow abort errors.
    });

    return { squadId, apiBaseUrl, instructions, agents: finalAgents, events };
  },
});
