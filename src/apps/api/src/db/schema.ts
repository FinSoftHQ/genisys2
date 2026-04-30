import { sqliteTable, text, integer, index } from 'drizzle-orm/sqlite-core';

export const boards = sqliteTable('boards', {
  uid: text('uid').primaryKey(),
  title: text('title').notNull(),
  prefix: text('prefix').notNull().unique(),
  schema: text('schema', { mode: 'json' }).notNull(),
  permissions: text('permissions', { mode: 'json' }).notNull(),
  created_at: text('created_at').notNull(),
  updated_at: text('updated_at').notNull(),
});

export const boardSequences = sqliteTable('board_sequences', {
  prefix: text('prefix').primaryKey(),
  seq_value: integer('seq_value').notNull().default(0),
});

export const cards = sqliteTable('cards', {
  uid: text('uid').primaryKey(),
  board_uid: text('board_uid').notNull(),
  display_id: text('display_id').notNull().unique(),
  title: text('title').notNull(),
  description: text('description'),
  version: integer('version').notNull().default(1),
  processing_state: text('processing_state', { enum: ['IDLE', 'PROCESSING', 'ERROR'] }).notNull().default('IDLE'),
  is_editable: integer('is_editable', { mode: 'boolean' }).notNull().default(true),
  payload: text('payload', { mode: 'json' }).notNull(),
  current_status: text('current_status').notNull(),
  created_at: text('created_at').notNull(),
  updated_at: text('updated_at').notNull(),
});

export const processorRegistry = sqliteTable('processor_registry', {
  processor_id: text('processor_id').primaryKey(),
  name: text('name').notNull(),
  base_url: text('base_url').notNull(),
  health_endpoint: text('health_endpoint').notNull(),
  hooks: text('hooks', { mode: 'json' }).notNull(),
  sla_seconds: integer('sla_seconds').notNull(),
  max_sla_seconds: integer('max_sla_seconds').notNull(),
  auth_type: text('auth_type', { enum: ['bearer', 'oauth2', 'none'] }).notNull(),
  auth_config: text('auth_config', { mode: 'json' }),
  hmac_secret: text('hmac_secret').notNull(),
  status: text('status', { enum: ['healthy', 'degraded', 'unhealthy', 'unknown'] }).notNull(),
  last_health_check: text('last_health_check'),
  created_at: text('created_at').notNull(),
  updated_at: text('updated_at').notNull(),
});

export const callbackTokens = sqliteTable('callback_tokens', {
  token: text('token').primaryKey(),
  card_uid: text('card_uid').notNull(),
  processor_id: text('processor_id').notNull(),
  hook: text('hook', { enum: ['on-enter', 'on-action'] }).notNull(),
  idempotency_key: text('idempotency_key').notNull(),
  context: text('context', { mode: 'json' }).notNull(),
  expires_at: text('expires_at').notNull(),
  created_at: text('created_at').notNull(),
});

export const cardRelationships = sqliteTable('card_relationships', {
  parent_card_uid: text('parent_card_uid').notNull(),
  child_card_uid: text('child_card_uid').notNull(),
  relationship_type: text('relationship_type').notNull().default('dependency'),
  created_at: text('created_at').notNull(),
}, (table) => ({
  parentIdx: index('card_relationships_parent_idx').on(table.parent_card_uid),
  childIdx: index('card_relationships_child_idx').on(table.child_card_uid),
}));

export const consumedCallbackTokens = sqliteTable('consumed_callback_tokens', {
  token: text('token').primaryKey(),
  consumed_at: text('consumed_at').notNull(),
});

export const eventLog = sqliteTable('event_log', {
  event_id: text('event_id').primaryKey(),
  card_uid: text('card_uid').notNull(),
  board_uid: text('board_uid'),
  timestamp: text('timestamp').notNull(),
  actor: text('actor').notNull(),
  action: text('action', { enum: ['CARD_CREATED', 'CARD_UPDATED', 'CARD_MOVED', 'MOVED', 'ACTION_TRIGGERED', 'PROCESSING_STARTED', 'PROCESSING_COMPLETED', 'PROCESSING_ERROR', 'ROLLUP_CHANGED', 'ADMIN_OVERRIDE', 'BOARD_RELOAD'] }).notNull(),
  category: text('category', { enum: ['routing', 'lifecycle', 'user_action', 'system'] }).notNull(),
  lifecycle_event: text('lifecycle_event', { enum: ['PROCESSING_STARTED', 'PROCESSING_COMPLETED', 'PROCESSING_ERROR'] }),
  from_column: text('from_column'),
  to_column: text('to_column'),
  idempotency_key: text('idempotency_key'),
  payload_delta: text('payload_delta', { mode: 'json' }),
  metadata: text('metadata', { mode: 'json' }),
}, (table) => ({
  cardTimestampIdx: index('event_log_card_timestamp_idx').on(table.card_uid, table.timestamp),
  boardTimestampIdx: index('event_log_board_timestamp_idx').on(table.board_uid, table.timestamp),
  categoryTimestampIdx: index('event_log_category_timestamp_idx').on(table.category, table.timestamp),
}));
