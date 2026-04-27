import { test as base } from '@playwright/test';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DB_PATH = resolve(__dirname, './e2e-kanban.db');
const MIGRATION_PATH = resolve(__dirname, '../src/apps/api/src/db/migrations/0001_kanban_slice1.sql');

declare module 'node:sqlite' {
  export class DatabaseSync {
    constructor(path: string);
    exec(sql: string): void;
    prepare(sql: string): {
      run(...args: unknown[]): void;
      get(): Record<string, unknown> | undefined;
      all(): Array<Record<string, unknown>>;
    };
    close(): void;
  }
}

export const test = base.extend<{ boardId: string }>({
  boardId: async ({}, use) => {
    const { DatabaseSync } = await import('node:sqlite');
    const db = new DatabaseSync(DB_PATH);
    db.exec('PRAGMA journal_mode = WAL');
    db.exec('PRAGMA synchronous = NORMAL');
    db.exec('PRAGMA busy_timeout = 5000');

    const migration = readFileSync(MIGRATION_PATH, 'utf-8');
    db.exec(migration);

    const boardId = randomUUID();
    const now = new Date().toISOString();
    const prefix = 'E' + Math.floor(Math.random() * 1000);

    const schema = JSON.stringify({
      columns: [
        { uid: 'backlog', title: 'Backlog', type: 'Normal', processor_id: 'default-manual', exit_logic: { default: 'in-progress' }, order: 0 },
        { uid: 'in-progress', title: 'In Progress', type: 'Normal', processor_id: 'default-manual', exit_logic: { default: 'done' }, order: 1 },
        { uid: 'done', title: 'Done', type: 'Normal', processor_id: 'default-manual', exit_logic: {}, order: 2 },
      ],
    });

    db
      .prepare(
        `INSERT INTO boards (uid, title, prefix, schema, permissions, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(boardId, 'E2E Board', prefix, schema, JSON.stringify({ read: [], write: [] }), now, now);

    db.prepare(`INSERT INTO board_sequences (prefix, seq_value) VALUES (?, ?)`).run(prefix, 0);
    db.close();

    await use(boardId);
  },
});
