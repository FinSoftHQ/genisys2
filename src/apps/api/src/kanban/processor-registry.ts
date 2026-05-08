export { openDb, closeDb, upsertProcessorRegistry, getProcessorById, resolveDb } from './repository.js';
import {
  ProcessorHealthPollConfigSchema,
  ProcessorHealthCheckResultSchema,
  ProcessorRegistryEntitySchema,
} from '@repo/shared';
import type { ProcessorRegistryEntity } from '@repo/shared';
import { resolveDb } from './repository.js';
import { processorRegistry } from '../db/schema.js';
import { eq } from 'drizzle-orm';

export function getHealthPollConfig() {
  return ProcessorHealthPollConfigSchema.parse({
    interval_seconds: 30,
    timeout_ms: 3000,
  });
}

export async function runHealthCheck(processor: ProcessorRegistryEntity, dbInstance?: unknown) {
  const start = Date.now();
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 3000);

  try {
    const response = await fetch(`${processor.base_url}${processor.health_endpoint}`, {
      method: 'GET',
      signal: controller.signal,
    });
    clearTimeout(timeout);
    const responseTime = Date.now() - start;

    const status = response.ok ? 'healthy' : 'degraded';

    const result = {
      processor_id: processor.processor_id,
      status,
      checked_at: new Date().toISOString(),
      http_status: response.status,
      response_time_ms: responseTime,
    };

    const parsed = ProcessorHealthCheckResultSchema.parse(result);
    persistHealthResult(parsed, dbInstance);
    return parsed;
  } catch (err) {
    clearTimeout(timeout);
    const result = {
      processor_id: processor.processor_id,
      status: 'unhealthy' as const,
      checked_at: new Date().toISOString(),
      http_status: null,
      response_time_ms: Date.now() - start,
      error_message: err instanceof Error ? err.message : String(err),
    };
    const parsed = ProcessorHealthCheckResultSchema.parse(result);
    persistHealthResult(parsed, dbInstance);
    return parsed;
  }
}

function persistHealthResult(
  result: { processor_id: string; status: string; checked_at: string },
  dbInstance?: unknown,
) {
  try {
    const { db } = resolveDb(dbInstance);
    const existing = db
      .select()
      .from(processorRegistry)
      .where(eq(processorRegistry.processor_id, result.processor_id))
      .get();
    if (existing) {
      db.update(processorRegistry)
        .set({ status: result.status as 'healthy' | 'degraded' | 'unhealthy', last_health_check: result.checked_at })
        .where(eq(processorRegistry.processor_id, result.processor_id))
        .run();
    }
  } catch {
    // Silently skip persistence when no DB is available (e.g. unit tests with mock processors)
  }
}

export function startHealthPolling(dbInstance: unknown) {
  const config = getHealthPollConfig();

  const tick = async () => {
    try {
      const { db } = resolveDb(dbInstance);
      const rows = db.select().from(processorRegistry).all();
      for (const row of rows) {
        const parsed = ProcessorRegistryEntitySchema.safeParse(row);
        if (parsed.success) {
          await runHealthCheck(parsed.data, dbInstance);
        }
      }
    } catch {
      // Silently skip polling cycles when DB is unavailable
    }
  };

  // Run immediately, then on interval
  tick().catch(() => {});
  const interval = setInterval(() => {
    tick().catch(() => {});
  }, config.interval_seconds * 1000);

  return {
    stop: () => clearInterval(interval),
  };
}
