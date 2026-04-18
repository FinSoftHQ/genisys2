import { createStep } from '@mastra/core/workflows';
import { waitIdleOutputSchema, sendInstructionsOutputSchema } from './agent-rooms-workflow-schemas';

function formatEventForWriter(event: Record<string, unknown>): string {
  const from = event.from ?? 'unknown';
  const type = event.type ?? 'unknown';
  const text =
    type === 'message'
      ? (event.text as string) ?? ''
      : type === 'thinking'
        ? (event.thinking as string) ?? ''
        : type === 'tool_start'
          ? `tool: ${event.toolName as string}`
          : type === 'tool_end'
            ? `tool done: ${event.toolName as string}`
            : JSON.stringify(event);
  return `[${String(from)}] ${String(type)}: ${text}`;
}

export const agentRoomInstructStreamStep = createStep({
  id: 'agent-room-instruct-stream-step',
  description:
    'Sends instructions to all agents in a room, collects the SSE stream until all agents are idle again.',
  inputSchema: waitIdleOutputSchema,
  outputSchema: sendInstructionsOutputSchema,
  execute: async ({ inputData, writer }) => {
    if (!inputData) {
      throw new Error('Input data is required for agent-room-instruct-stream-step');
    }

    const { roomId, apiBaseUrl, instructions, agents } = inputData;
    const agentNames = Object.keys(agents);

    // 1. Open SSE connection before sending instructions so we don't miss events.
    const streamUrl = `${apiBaseUrl}/${roomId}/stream`;
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
        const reader = sseRes.body!.getReader();
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
              if (writer) {
                await writer.write({ type: 'progress', text: formatEventForWriter(parsed) });
              }
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

    // 3. Send instructions to all agents.
    const instructRes = await fetch(`${apiBaseUrl}/${roomId}/instructions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ targetAgents: agentNames, followUp: [instructions] }),
    });

    if (!instructRes.ok) {
      abortController.abort();
      const text = await instructRes.text();
      throw new Error(`Failed to send instructions: ${instructRes.status} ${text}`);
    }

    // 4. Poll status until all agents are idle again (or timeout).
    const maxAttempts = 300; // up to 5 minutes
    const intervalMs = 1000;
    let finalAgents = agents;

    for (let i = 0; i < maxAttempts; i++) {
      await new Promise((r) => setTimeout(r, intervalMs));
      const res = await fetch(`${apiBaseUrl}/${roomId}/status`);
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
          `Room error during streaming: ${data.reason ?? 'unknown'} (agent: ${data.failedAgent ?? 'unknown'})`
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

    return { roomId, apiBaseUrl, instructions, agents: finalAgents, events };
  },
});
