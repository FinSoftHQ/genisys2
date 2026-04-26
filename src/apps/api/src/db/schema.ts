import { sqliteTable, text, integer } from 'drizzle-orm/sqlite-core';

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
