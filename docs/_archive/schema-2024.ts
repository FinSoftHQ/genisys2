// ============================================================================
// ARCHIVED / STALE — DO NOT USE AS SOURCE OF TRUTH
// ============================================================================
// This file was relocated from docs/schema-patched.ts during Phase 1.2 of the
// refactoring plan. It is out of sync with the canonical schema at
// src/apps/api/src/db/schema.ts and is preserved here only for historical
// reference.
// ============================================================================

import { sqliteTable, text, integer, index, primaryKey } from 'drizzle-orm/sqlite-core';
import { relations } from "drizzle-orm";

// --- Type Definitions for JSON Fields ---
export type BoardSchemaType = {
  columns: Array<{
    uid: string;
    title: string;
    type: 'Normal' | 'Processing';
    processor_id: string;
    exit_logic: Record<string, string>;
    order: number;
  }>;
};

// --- Core Domain ---
export const boards = sqliteTable('boards', {
  uid: text('uid').primaryKey().$defaultFn(() => crypto.randomUUID()),
  title: text('title').notNull(),
  prefix: text('prefix').notNull().unique(),
  schema: text('schema', { mode: 'json' }).$type<BoardSchemaType>().notNull(),
  permissions: text('permissions', { mode: 'json' }).notNull(),
  createdAt: integer('created_at', { mode: 'timestamp' }).notNull().$defaultFn(() => new Date()),
  updatedAt: integer('updated_at', { mode: 'timestamp' }).notNull().$defaultFn(() => new Date()),
});

export const boardSequences = sqliteTable('board_sequences', {
  prefix: text('prefix').primaryKey().references(() => boards.prefix),
  seqValue: integer('seq_value').notNull().default(0),
});

export const cards = sqliteTable('cards', {
  uid: text('uid').primaryKey().$defaultFn(() => crypto.randomUUID()),
  displayId: text('display_id').notNull().unique(),
  title: text('title').notNull(),
  version: integer('version').notNull().default(1),
  processingState: text('processing_state', { enum: ['IDLE', 'PROCESSING', 'ERROR'] }).notNull().default('IDLE'),
  isEditable: integer('is_editable', { mode: 'boolean' }).notNull().default(true),
  payload: text('payload', { mode: 'json' }).notNull(),
  currentStatus: text('current_status').notNull(),
  boardUid: text('board_uid').notNull().references(() => boards.uid, { onDelete: 'cascade' }),
  createdAt: integer('created_at', { mode: 'timestamp' }).notNull().$defaultFn(() => new Date()),
  updatedAt: integer('updated_at', { mode: 'timestamp' }).notNull().$defaultFn(() => new Date()),
}, (table) => ({
  boardIdx: index('idx_cards_board_uid').on(table.boardUid),
  statusIdx: index('idx_cards_current_status').on(table.currentStatus),
  stateIdx: index('idx_cards_processing_state').on(table.processingState),
}));

export const cardRelationships = sqliteTable('card_relationships', {
  parentCardUid: text('parent_card_uid').notNull().references(() => cards.uid, { onDelete: 'cascade' }),
  childCardUid: text('child_card_uid').notNull().references(() => cards.uid, { onDelete: 'cascade' }),
  relationshipType: text('relationship_type').notNull().default('dependency'),
}, (table) => ({
  pk: primaryKey({ columns: [table.parentCardUid, table.childCardUid] }),
  childIdx: index('idx_relationships_child').on(table.childCardUid),
}));

// --- Audit & Telemetry ---
export const eventLog = sqliteTable('event_log', {
  eventId: text('event_id').primaryKey().$defaultFn(() => crypto.randomUUID()),
  cardUid: text('card_uid').notNull().references(() => cards.uid),
  boardUid: text('board_uid').references(() => boards.uid),
  timestamp: integer('timestamp', { mode: 'timestamp' }).notNull().$defaultFn(() => new Date()),
  actor: text('actor').notNull(),
  action: text('action').notNull(),
  category: text('category', { enum: ['routing', 'lifecycle', 'user_action', 'system'] }).notNull(),
  lifecycleEvent: text('lifecycle_event'),
  fromColumn: text('from_column'),
  toColumn: text('to_column'),
  idempotencyKey: text('idempotency_key'),
  payloadDelta: text('payload_delta', { mode: 'json' }),
  metadata: text('metadata', { mode: 'json' }),
}, (table) => ({
  cardTimeIdx: index('idx_event_log_card_time').on(table.cardUid, table.timestamp),
  boardTimeIdx: index('idx_event_log_board_time').on(table.boardUid, table.timestamp),
  catTimeIdx: index('idx_event_log_cat_time').on(table.category, table.timestamp),
}));

// --- Orchestrator State & Processors ---
export const processorRegistry = sqliteTable('processorRegistry', {
  processorId: text('processor_id').primaryKey(),
  name: text('name').notNull(),
  baseUrl: text('base_url').notNull(),
  healthEndpoint: text('health_endpoint').notNull().default('/health'),
  hooks: text('hooks', { mode: 'json' }).notNull(),
  slaSeconds: integer('sla_seconds').notNull().default(300),
  maxSlaSeconds: integer('max_sla_seconds').notNull().default(86400),
  authType: text('auth_type', { enum: ['bearer', 'oauth2', 'none'] }).notNull().default('bearer'),
  authConfig: text('auth_config', { mode: 'json' }),
  hmacSecret: text('hmac_secret').notNull(),
  status: text('status', { enum: ['healthy', 'degraded', 'unhealthy', 'unknown'] }).notNull().default('unknown'),
  lastHealthCheck: integer('last_health_check', { mode: 'timestamp' }),
  createdAt: integer('created_at', { mode: 'timestamp' }).notNull().$defaultFn(() => new Date()),
  updatedAt: integer('updated_at', { mode: 'timestamp' }).notNull().$defaultFn(() => new Date()),
});

export const callbackTokens = sqliteTable('callback_tokens', {
  token: text('token').primaryKey().$defaultFn(() => crypto.randomUUID()),
  cardUid: text('card_uid').notNull().references(() => cards.uid),
  processorId: text('processor_id').notNull(),
  hook: text('hook').notNull(),
  idempotencyKey: text('idempotency_key').notNull(),
  context: text('context', { mode: 'json' }).notNull(),
  expiresAt: integer('expires_at', { mode: 'timestamp' }).notNull(),
  createdAt: integer('created_at', { mode: 'timestamp' }).notNull().$defaultFn(() => new Date()),
}, (table) => ({
  expiresIdx: index('idx_callback_tokens_expires').on(table.expiresAt),
  cardIdx: index('idx_callback_tokens_card').on(table.cardUid),
}));

export const dlq = sqliteTable('dlq', {
  dlqId: text('dlq_id').primaryKey().$defaultFn(() => crypto.randomUUID()),
  cardUid: text('card_uid').notNull().references(() => cards.uid),
  processorId: text('processor_id').notNull(),
  hook: text('hook').notNull(),
  idempotencyKey: text('idempotency_key').notNull(),
  reason: text('reason').notNull(),
  status: text('status', { enum: ['pending_admin', 'retried', 'cancelled', 'forced'] }).notNull().default('pending_admin'),
  retryCount: integer('retry_count').notNull().default(0),
  context: text('context', { mode: 'json' }).notNull(),
  submittedAt: integer('submitted_at', { mode: 'timestamp' }).notNull(),
  deadlineAt: integer('deadline_at', { mode: 'timestamp' }).notNull(),
  resolvedAt: integer('resolved_at', { mode: 'timestamp' }),
  createdAt: integer('created_at', { mode: 'timestamp' }).notNull().$defaultFn(() => new Date()),
});

// --- Ephemeral State (Self-Contained SQLite) ---
export const idempotencyCache = sqliteTable('idempotency_cache', {
  key: text('key').primaryKey(),
  responseStatus: integer('response_status').notNull(),
  responseBody: text('response_body', { mode: 'json' }),
  createdAt: integer('created_at', { mode: 'timestamp' }).notNull().$defaultFn(() => new Date()),
  expiresAt: integer('expires_at', { mode: 'timestamp' }).notNull(),
}, (table) => ({
  expiresIdx: index('idx_idempotency_expires').on(table.expiresAt),
}));

export const rollupDebounceBuffer = sqliteTable('rollup_debounce_buffer', {
  parentCardUid: text('parent_card_uid').primaryKey().references(() => cards.uid),
  dirtySince: integer('dirty_since', { mode: 'timestamp' }).notNull().$defaultFn(() => new Date()),
  timerDeadline: integer('timer_deadline', { mode: 'timestamp' }).notNull(),
  pendingChildren: integer('pending_children').notNull().default(1),
  processedAt: integer('processed_at', { mode: 'timestamp' }),
}, (table) => ({
  deadlineIdx: index('idx_rollup_deadline').on(table.timerDeadline),
}));

// --- RELATIONS ---

export const boardRelations = relations(boards, ({ many }) => ({
  cards: many(cards),
}));

export const cardRelations = relations(cards, ({ one, many }) => ({
  board: one(boards, { 
    fields: [cards.boardUid], 
    references: [boards.uid] 
  }),
  events: many(eventLog),
  parentLinks: many(cardRelationships, { relationName: 'child_link' }),
  childLinks: many(cardRelationships, { relationName: 'parent_link' }),
}));

export const cardRelationshipsRelations = relations(cardRelationships, ({ one }) => ({
  parentCard: one(cards, {
    fields: [cardRelationships.parentCardUid],
    references: [cards.uid],
    relationName: 'parent_link'
  }),
  childCard: one(cards, {
    fields: [cardRelationships.childCardUid],
    references: [cards.uid],
    relationName: 'child_link'
  })
}));

export const eventLogRelations = relations(eventLog, ({ one }) => ({
  card: one(cards, {
    fields: [eventLog.cardUid],
    references: [cards.uid]
  })
}));
