import { z } from 'zod';

export const piAgentInputSchema = z.object({
  instruction: z.string().describe('The coding instruction to send to Pi.'),
  workingDirectory: z.string().optional().describe('Working directory for Pi sessions inside the VM. Defaults to the Mastra process cwd.'),
});

export const piAgentOutputSchema = z.object({
  piOutput: z.string().describe('The full accumulated text output from Pi.'),
});

export type PiAgentInput = z.infer<typeof piAgentInputSchema>;
export type PiAgentOutput = z.infer<typeof piAgentOutputSchema>;
