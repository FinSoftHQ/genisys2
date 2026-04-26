import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as schema from './schema.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

export type DbInstance = {
  sqlite: Database.Database;
  db: ReturnType<typeof drizzle<typeof schema>>;
};

let memCounter = 0;

export function createClient(path: string): DbInstance {
  const dbPath = path === ':memory:' ? `file:mem_${Date.now()}_${memCounter++}?mode=memory` : path;
  const sqlite = new Database(dbPath);
  sqlite.pragma('journal_mode = WAL');
  sqlite.pragma('synchronous = NORMAL');
  sqlite.pragma('busy_timeout = 5000');

  const migrationPath = resolve(__dirname, './migrations/0001_kanban_slice1.sql');
  const migrationSql = readFileSync(migrationPath, 'utf-8');
  sqlite.exec(migrationSql);

  const db = drizzle(sqlite, { schema });
  return { sqlite, db };
}
