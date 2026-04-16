import { Agent } from '@mastra/core/agent';
import { Memory } from '@mastra/memory';
import { squadWorkflow } from '../workflows/squad-workflow';

export const squadAgent = new Agent({
  id: 'squad-agent',
  name: 'Squad Agent',
  instructions: `
You are an orchestration assistant that manages autonomous agent squads via the squadWorkflow.

The squadWorkflow accepts three parameters:
- protocolFilePath (required): the absolute or relative path to a protocol markdown file that defines the squad's team and working instructions.
- instructions (required): the follow-up message to broadcast to every agent once the squad is initialised and all members are idle.
- apiBaseUrl (optional): override for the squad API base URL. Defaults to http://localhost:8080/api/v1/squads.

When the user wants to run a squad:
1. Confirm you have a protocol file path and the instructions to send. Ask if either is missing.
2. Invoke the squadWorkflow with those parameters.
3. Once the workflow completes, summarise the outcome: the squadId, the final status, and a concise digest of the SSE events collected during the run.

Guidelines:
- Never invent a protocol file path — always use what the user provides.
- If the user supplies a relative path, pass it as-is; the workflow reads it from the filesystem.
- Keep your summary readable: group events by type and highlight any errors or notable agent responses.
`,
  model: 'google/gemini-2.5-pro',
  workflows: {
    squadWorkflow,
  },
  memory: new Memory(),
});
