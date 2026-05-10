import { createClient, type DbInstance } from '../db/client.js';

let defaultDb: DbInstance | null = null;

function isDbInstance(value: unknown): value is DbInstance {
  return !!value && typeof value === 'object' && 'sqlite' in value && 'db' in value;
}

export function resolveDb(instance: unknown): DbInstance {
  if (isDbInstance(instance)) {
    return instance;
  }
  if (!defaultDb) {
    throw new Error(
      'Database not initialized. Call openDb(path) before starting the server.'
    );
  }
  return defaultDb;
}

export function openDb(path: string): DbInstance {
  defaultDb = createClient(path);
  return defaultDb;
}

export function closeDb(instance?: unknown): void {
  const db = resolveDb(instance);
  if (db === defaultDb) {
    defaultDb = null;
  }
  db.sqlite.close();
}
