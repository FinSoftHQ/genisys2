import { randomUUID } from 'node:crypto';
import { eq, and, gte, lte, inArray, asc, gt, or } from 'drizzle-orm';
import { EventLogRowSchema, type EventLogRow, type AuditLogQuery } from '@repo/shared';
import { resolveDb } from './db-context.js';
import { eventLog } from '../db/schema.js';

export function appendEventLog(
  instance: unknown,
  event: Omit<EventLogRow, 'event_id' | 'timestamp'> & Partial<Pick<EventLogRow, 'event_id' | 'timestamp'>>,
): EventLogRow {
  const { db } = resolveDb(instance);

  const row = {
    ...event,
    event_id: event.event_id ?? randomUUID(),
    timestamp: event.timestamp ?? new Date().toISOString(),
    lifecycle_event: event.lifecycle_event ?? null,
    from_column: event.from_column ?? null,
    to_column: event.to_column ?? null,
    idempotency_key: event.idempotency_key ?? null,
    payload_delta: event.payload_delta ?? null,
    metadata: event.metadata ?? null,
  };

  const parsed = EventLogRowSchema.safeParse(row);
  if (!parsed.success) {
    throw new Error('Invalid event log row: ' + JSON.stringify(parsed.error.issues));
  }

  db.insert(eventLog).values(parsed.data).run();
  return parsed.data;
}

export function queryAuditLog(
  instance: unknown,
  boardUid: string,
  query: AuditLogQuery,
): { events: EventLogRow[]; next_cursor: string | null } {
  const { db } = resolveDb(instance);
  const limit = query.limit ?? 50;

  const conditions = [eq(eventLog.board_uid, boardUid)];

  if (query.from) {
    conditions.push(gte(eventLog.timestamp, query.from));
  }
  if (query.to) {
    conditions.push(lte(eventLog.timestamp, query.to));
  }
  if (query.categories && query.categories.length > 0) {
    conditions.push(inArray(eventLog.category, query.categories));
  }
  if (query.actions && query.actions.length > 0) {
    conditions.push(inArray(eventLog.action, query.actions));
  }
  if (query.card_uid) {
    conditions.push(eq(eventLog.card_uid, query.card_uid));
  }
  if (query.cursor) {
    const parts = query.cursor.split('|');
    const cursorTs = parts[0]!;
    const cursorId = parts[1] ?? '';
    const cursorCondition = or(
      gt(eventLog.timestamp, cursorTs),
      and(eq(eventLog.timestamp, cursorTs), gt(eventLog.event_id, cursorId)),
    );
    if (cursorCondition) {
      conditions.push(cursorCondition);
    }
  }

  const rows = db
    .select()
    .from(eventLog)
    .where(and(...conditions))
    .orderBy(asc(eventLog.timestamp), asc(eventLog.event_id))
    .limit(limit + 1)
    .all();

  const hasMore = rows.length > limit;
  const events = (hasMore ? rows.slice(0, limit) : rows).map((r) => {
    const parsed = EventLogRowSchema.safeParse(r);
    if (!parsed.success) {
      throw new Error('Invalid event log row in DB: ' + JSON.stringify(parsed.error.issues));
    }
    return parsed.data;
  });

  const next_cursor = hasMore && events.length > 0
    ? `${events[events.length - 1].timestamp}|${events[events.length - 1].event_id}`
    : null;

  return { events, next_cursor };
}
