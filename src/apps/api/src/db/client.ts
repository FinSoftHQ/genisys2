import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import * as schema from './schema.js';
import { bootstrapDefaultProcessor, bootstrapTodoProcessor, bootstrapDoneProcessor, bootstrapPlanningProcessor, bootstrapPrepProcessor, bootstrapWrapProcessor, bootstrapAgenticTeamProcessor, bootstrapDelegatedProcessor, bootstrapCommitProcessor, bootstrapExploreProcessor } from './seed.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

export type DbInstance = {
  sqlite: Database.Database;
  db: ReturnType<typeof drizzle<typeof schema>>;
};

let memCounter = 0;

export function createClient(path: string): DbInstance {
  const dbPath = path === ':memory:' ? `file:mem_${randomUUID().replace(/-/g, '')}_${memCounter++}?mode=memory` : path;
  const sqlite = new Database(dbPath);
  sqlite.pragma('journal_mode = WAL');
  sqlite.pragma('synchronous = NORMAL');
  sqlite.pragma('busy_timeout = 5000');

  sqlite.exec(`
    CREATE TABLE IF NOT EXISTS __migrations (
      filename TEXT PRIMARY KEY,
      applied_at TEXT NOT NULL
    )
  `);

  const migrationDir = resolve(__dirname, './migrations');
  const migrationFiles = readdirSync(migrationDir)
    .filter((f) => f.endsWith('.sql'))
    .sort();
  for (const file of migrationFiles) {
    const alreadyApplied = sqlite.prepare(`SELECT 1 FROM __migrations WHERE filename = ?`).get(file);
    if (alreadyApplied) continue;

    const migrationSql = readFileSync(resolve(migrationDir, file), 'utf-8');
    sqlite.exec(migrationSql);
    sqlite.prepare(`INSERT INTO __migrations (filename, applied_at) VALUES (?, ?)`).run(file, new Date().toISOString());
  }

  const db = drizzle(sqlite, { schema });
  bootstrapDefaultProcessor({ sqlite, db });
  bootstrapTodoProcessor({ sqlite, db });
  bootstrapDoneProcessor({ sqlite, db });
  bootstrapPlanningProcessor({ sqlite, db });
  bootstrapPrepProcessor({ sqlite, db });
  bootstrapWrapProcessor({ sqlite, db });
  bootstrapDelegatedProcessor({ sqlite, db });
  bootstrapAgenticTeamProcessor({ sqlite, db });
  bootstrapCommitProcessor({ sqlite, db });
  bootstrapExploreProcessor({ sqlite, db });
  return { sqlite, db };
}
