import { createStep } from '@mastra/core/workflows';
import { createClient } from 'rivetkit/client';
import { piAgentInputSchema, piAgentOutputSchema } from './pi-agent-schemas';

/**
 * Payload shape for the Rivet agent-os `sessionEvent` broadcast.
 * The Pi ACP adapter translates Pi's `message_update` events into ACP
 * `sessionUpdate` notifications with `agent_message_chunk` or
 * `agent_thought_chunk` content.
 */
interface SessionEventPayload {
  sessionId: string;
  event: {
    method: string;
    params?: {
      update?: {
        sessionUpdate?: string;
        content?: {
          text?: string;
        };
      };
    };
  };
}

/**
 * Minimal local interface for the AgentOS connection methods we use.
 * We define this locally because rivetkit's ActorDefinition variance makes
 * createClient<typeof registry> unusable in strict TypeScript mode.
 */
interface AgentOsConn {
  createSession(agent: 'pi', opts?: { env?: Record<string, string>; cwd?: string }): Promise<{ sessionId: string }>;
  sendPrompt(sessionId: string, text: string): Promise<{ text: string }>;
  closeSession(sessionId: string): Promise<void>;
  on(event: 'sessionEvent', callback: (payload: SessionEventPayload) => void): () => void;
  dispose(): Promise<void>;
}

interface AgentOsHandle {
  connect(): AgentOsConn;
}

/**
 * Mastra Workflow Step that runs the Pi Coding Agent inside a remote Rivet Agent OS VM.
 *
 * Architecture:
 * - Connects to the Rivet actor registry via rivetkit/client.
 * - Retrieves (or creates) a stateful VM scoped to the Mastra workflow runId.
 * - Spawns a Pi session, sends the coding instruction, and streams the response
 *   by subscribing to the actor's `sessionEvent` broadcasts.
 * - Routes each text chunk to the Mastra `writer` so callers receive real-time progress.
 */
export const piAgentStep = createStep({
  id: 'pi-agent-step',
  description:
    'Executes a coding instruction inside a stateful Rivet Agent OS sandbox running Pi, streaming output back to the caller.',
  inputSchema: piAgentInputSchema,
  outputSchema: piAgentOutputSchema,
  execute: async ({ inputData, writer, runId }) => {
    if (!inputData) {
      throw new Error('Input data is required for pi-agent-step');
    }

    const { instruction, workingDirectory } = inputData;
    const cwd = workingDirectory ?? process.cwd();
    const apiKey = process.env.KIMI_API_KEY;
    if (!apiKey) {
      throw new Error('Missing KIMI_API_KEY environment variable');
    }

    const registryUrl = process.env.RIVET_AGENT_OS_URL ?? 'http://localhost:6420';

    // 1. Initialize the Rivetkit client that talks to the remote Agent OS registry.
    const client = createClient(registryUrl);

    // 2. Retrieve or create the stateful VM actor for this workflow run.
    //    Using runId as the key ensures every step in the same workflow run
    //    shares the same VM.
    const vm = client.vm.getOrCreate([runId]) as unknown as AgentOsHandle;
    const conn = vm.connect();

    // Buffer for text chunks that arrive via session events.
    const textChunks: string[] = [];
    let writingDone = false;

    // Background loop that drains the chunk buffer into Mastra's writer.
    // This runs in parallel with the prompt so we can await writer.write()
    // even though the event callback itself must be synchronous.
    const writerLoop = (async () => {
      while (!writingDone || textChunks.length > 0) {
        while (textChunks.length > 0) {
          const text = textChunks.shift()!;
          await writer?.write({ type: 'progress', text });
        }
        if (!writingDone) {
          await new Promise((resolve) => setTimeout(resolve, 50));
        }
      }
    })();

    // 3. Subscribe to session events before sending the prompt so we don't miss chunks.
    const unsubscribe = conn.on('sessionEvent', (payload) => {
      if (payload.sessionId !== undefined && payload.sessionId !== '') {
        // Events from this connection are already scoped to the actor handle,
        // but the payload also carries sessionId. We don't filter here because
        // the actor may only have one session at a time for our use-case.
      }

      const update = payload.event?.params?.update;
      if (!update) return;

      // The Pi ACP adapter emits these sessionUpdate types for streaming content.
      if (
        update.sessionUpdate === 'agent_message_chunk' ||
        update.sessionUpdate === 'agent_thought_chunk'
      ) {
        const text = update.content?.text ?? '';
        if (text) {
          textChunks.push(text);
        }
      }
    });

    let promptResult: { text: string } | null = null;

    try {
      // 4. Create a Pi session inside the VM, injecting the API key and cwd into its environment.
      const { sessionId } = await conn.createSession('pi', {
        env: { KIMI_API_KEY: apiKey },
        cwd,
      });

      // 5. Send the prompt. This blocks until the Pi agent loop finishes.
      //    Text deltas arrive via the sessionEvent listener in parallel.
      promptResult = await conn.sendPrompt(sessionId, instruction);

      // 6. Ensure the session is closed so the VM can reclaim resources.
      await conn.closeSession(sessionId);
    } catch (error) {
      // Surface a meaningful error if the VM/network/session fails.
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(`Pi agent execution failed for run "${runId}": ${message}`);
    } finally {
      // Stop accepting new chunks and unsubscribe from actor events.
      unsubscribe();
      writingDone = true;
      // Wait for the writer loop to flush any remaining chunks.
      await writerLoop.catch(() => {
        // Swallow writer errors to avoid masking the original failure.
      });
      // Clean up the persistent connection.
      try {
        await conn.dispose();
      } catch {
        // Swallow disposal errors.
      }
    }

    // 7. Return the authoritative full text from the prompt result.
    return { piOutput: promptResult?.text ?? '' };
  },
});
