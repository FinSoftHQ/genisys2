import { randomUUID } from 'node:crypto';
import { BoardEntitySchema } from '@repo/shared';
import { eq } from 'drizzle-orm';
import type { DbInstance } from './client.js';
import { boards, boardSequences, processorRegistry } from './schema.js';
import type { BoardEntity } from '@repo/shared';

let seedCounter = 0;

export function seedBoard(instance: DbInstance): BoardEntity {
  const { db } = instance;
  const uid = randomUUID();
  const now = new Date().toISOString();
  const prefix = `S${seedCounter++}`;

  const boardData = {
    uid,
    title: 'Demo Board',
    prefix,
    schema: {
      columns: [
        {
          uid: 'backlog',
          title: 'Backlog',
          type: 'Normal' as const,
          processor_id: 'default-manual',
          exit_logic: { default: 'in-progress' },
          order: 0,
        },
        {
          uid: 'in-progress',
          title: 'In Progress',
          type: 'Normal' as const,
          processor_id: 'default-manual',
          exit_logic: { default: 'done' },
          order: 1,
        },
        {
          uid: 'done',
          title: 'Done',
          type: 'Normal' as const,
          processor_id: 'default-manual',
          exit_logic: {},
          order: 2,
        },
      ],
    },
    permissions: { read: [] as string[], write: [] as string[] },
    created_at: now,
    updated_at: now,
  };

  const parsed = BoardEntitySchema.safeParse(boardData);
  if (!parsed.success) {
    throw new Error('Invalid board data: ' + JSON.stringify(parsed.error.issues));
  }

  db.insert(boards).values(boardData).run();
  db.insert(boardSequences).values({ prefix, seq_value: 0 }).run();

  return parsed.data;
}

export function bootstrapDefaultProcessor(instance: DbInstance): void {
  const { db } = instance;
  const existing = db.select().from(processorRegistry).where(eq(processorRegistry.processor_id, 'default-manual')).get();
  if (existing) return;

  const now = new Date().toISOString();
  db.insert(processorRegistry).values({
    processor_id: 'default-manual',
    name: 'Default Manual Processor',
    base_url: 'http://localhost:4001',
    health_endpoint: '/health',
    hooks: ['on-enter', 'on-update', 'on-action', 'can-exit', 'on-exit'],
    sla_seconds: 300,
    max_sla_seconds: 86400,
    auth_type: 'none',
    auth_config: null,
    hmac_secret: 'dev-secret',
    status: 'healthy',
    last_health_check: now,
    created_at: now,
    updated_at: now,
  }).run();
}
