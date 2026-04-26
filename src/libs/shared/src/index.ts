import { z } from 'zod';

export type UserId = z.infer<typeof UserId>;
export const UserId = z.string().uuid().brand('UserId');

export const UserSchema = z
  .object({
    id: UserId,
    name: z.string().min(1),
    email: z.string().email(),
  })
  .strict();

export type User = z.infer<typeof UserSchema>;

export * from './kanban-schemas.js';
export { parseProtocol, parseAgentPromptFile, type Protocol } from './protocol-parser.js';
