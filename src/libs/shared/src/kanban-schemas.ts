import { z } from 'zod';

const SqliteJournalModeSchema = z
  .string()
  .transform((value) => value.toUpperCase())
  .pipe(z.literal('WAL'));

const SqliteSynchronousSchema = z
  .string()
  .transform((value) => value.toUpperCase())
  .pipe(z.literal('NORMAL'));

export const SqlitePragmasSchema = z
  .object({
    journal_mode: SqliteJournalModeSchema,
    synchronous: SqliteSynchronousSchema,
    busy_timeout: z.coerce.number().int().pipe(z.literal(5000)),
  })
  .strict();

export type SqlitePragmas = z.infer<typeof SqlitePragmasSchema>;

export const BoardIdSchema = z.string().uuid({ message: 'boardId must be a valid UUID' }).brand('BoardId');
export type BoardId = z.infer<typeof BoardIdSchema>;

export const BoardSuiteIdSchema = z.string().uuid({ message: 'suiteId must be a valid UUID' }).brand('BoardSuiteId');
export type BoardSuiteId = z.infer<typeof BoardSuiteIdSchema>;

export const CardIdSchema = z.string().uuid({ message: 'cardId must be a valid UUID' }).brand('CardId');
export type CardId = z.infer<typeof CardIdSchema>;

export const CardVersionSchema = z.number().int().min(1, { message: 'version must be a positive integer' });

export const BoardPrefixSchema = z
  .string()
  .regex(/^[A-Z][A-Z0-9]{0,9}$/, {
    message: 'prefix must be 1-10 uppercase alphanumeric characters and start with a letter',
  });

export const DisplayIdSchema = z
  .string()
  .regex(/^[A-Z][A-Z0-9]{0,9}-[1-9]\d*$/, {
    message: 'displayId must match {PREFIX}-{number}, e.g. MKT-501',
  });

export const ColumnUidSchema = z
  .string()
  .min(1, { message: 'column uid is required' })
  .max(64, { message: 'column uid must be at most 64 characters' })
  .regex(/^[A-Za-z0-9:_-]+$/, {
    message: 'column uid may only contain letters, numbers, :, _, and -',
  });

export const ProcessorIdSchema = z
  .string()
  .min(1, { message: 'processor_id is required' })
  .max(120, { message: 'processor_id must be at most 120 characters' });

export const ProcessorHookSchema = z.enum(['on-enter', 'on-update', 'on-action', 'can-exit', 'on-exit']);

export const SyncHookSchema = z.enum(['on-update', 'can-exit']);

export const AsyncCallbackHookSchema = z.enum(['on-enter', 'on-action']);

export const IdempotencyKeySchema = z.string().uuid({ message: 'idempotency_key must be a valid UUID' });

export const CallbackTokenSchema = z
  .string()
  .uuid({ message: 'callback token must be a valid UUID' })
  .brand('CallbackToken');

export const SyncHookTimeoutMsSchema = z.literal(3000);

export const ProcessorRegistryStatusSchema = z.enum(['healthy', 'degraded', 'unhealthy', 'unknown']);

export const ProcessorRegistryAuthTypeSchema = z.enum(['bearer', 'oauth2', 'none']);

export const BoardColumnTypeSchema = z.enum(['Normal', 'Processing']);

export const BoardTemplateSchema = z.enum(['default', 'development', 'task']);
export const BoardSuiteTemplateSchema = z.enum(['default', 'development']);
export type BoardTemplate = z.infer<typeof BoardTemplateSchema>;

export const BoardColumnSchema = z
  .object({
    uid: ColumnUidSchema,
    title: z.string().min(1, { message: 'column title is required' }).max(120),
    type: BoardColumnTypeSchema,
    processor_id: ProcessorIdSchema,
    exit_logic: z.record(z.string().min(1), ColumnUidSchema),
    order: z.number().int().min(0),
  })
  .strict()
  .superRefine((column, ctx) => {
    if (column.type === 'Processing' && Object.keys(column.exit_logic).length === 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['exit_logic'],
        message: 'Processing columns must define at least one exit_logic route',
      });
    }
  });

export const ProcessingBoardColumnSchema = z
  .object({
    uid: ColumnUidSchema,
    title: z.string().min(1, { message: 'column title is required' }).max(120),
    type: z.literal('Processing'),
    processor_id: ProcessorIdSchema,
    exit_logic: z.record(z.string().min(1), ColumnUidSchema),
    order: z.number().int().min(0),
  })
  .strict()
  .refine((column) => Object.keys(column.exit_logic).length > 0, {
    path: ['exit_logic'],
    message: 'Processing columns must define at least one exit_logic route',
  });

export const BoardSchemaDocumentSchema = z
  .object({
    columns: z.array(BoardColumnSchema).min(1, { message: 'board schema must define at least one column' }),
  })
  .strict()
  .superRefine((value, ctx) => {
    const seenUids = new Set<string>();
    const seenOrders = new Set<number>();

    value.columns.forEach((column, index) => {
      if (seenUids.has(column.uid)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['columns', index, 'uid'],
          message: `duplicate column uid: ${column.uid}`,
        });
      }
      seenUids.add(column.uid);

      if (seenOrders.has(column.order)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['columns', index, 'order'],
          message: `duplicate column order: ${column.order}`,
        });
      }
      seenOrders.add(column.order);
    });
  });

const JsonValueSchema: z.ZodType<
  string | number | boolean | null | { [key: string]: unknown } | Array<unknown>
> = z.lazy(() =>
  z.union([
    z.string(),
    z.number(),
    z.boolean(),
    z.null(),
    z.array(JsonValueSchema),
    z.record(z.string(), JsonValueSchema),
  ]),
);

export const CardPayloadSchema = z.record(z.string(), JsonValueSchema);

export const BoardPermissionsSchema = z
  .object({
    read: z.array(z.string().min(1)).default([]),
    write: z.array(z.string().min(1)).default([]),
  })
  .strict();

export const IsoDateTimeSchema = z.string().datetime({ offset: true });

const ProcessorRegistryBaseSchema = z
  .object({
    processor_id: ProcessorIdSchema,
    name: z.string().min(1).max(200),
    base_url: z.string().url(),
    health_endpoint: z.string().min(1).max(200).default('/health'),
    hooks: z.array(ProcessorHookSchema).min(1),
    sla_seconds: z.number().int().min(1).max(86400),
    max_sla_seconds: z.number().int().min(1).max(86400),
    auth_type: ProcessorRegistryAuthTypeSchema,
    auth_config: z.record(z.string(), JsonValueSchema).nullable().optional(),
    hmac_secret: z.string().min(1, { message: 'hmac_secret cannot be empty (use placeholder in Slice 3 seed)' }),
    status: ProcessorRegistryStatusSchema,
    last_health_check: IsoDateTimeSchema.nullable().optional(),
    created_at: IsoDateTimeSchema,
    updated_at: IsoDateTimeSchema,
  })
  .strict();

export const ProcessorRegistryEntitySchema = ProcessorRegistryBaseSchema.refine(
  (value) => value.sla_seconds <= value.max_sla_seconds,
  {
    path: ['sla_seconds'],
    message: 'sla_seconds must be less than or equal to max_sla_seconds',
  },
);

export const UpsertProcessorRegistryRequestSchema = ProcessorRegistryBaseSchema.omit({
  status: true,
  last_health_check: true,
  created_at: true,
  updated_at: true,
}).refine((value) => value.sla_seconds <= value.max_sla_seconds, {
  path: ['sla_seconds'],
  message: 'sla_seconds must be less than or equal to max_sla_seconds',
});

export const ProcessorHealthPollConfigSchema = z
  .object({
    interval_seconds: z.literal(30),
    timeout_ms: z.number().int().min(250).max(10000).default(3000),
  })
  .strict();

export const ProcessorHealthCheckResultSchema = z
  .object({
    processor_id: ProcessorIdSchema,
    status: ProcessorRegistryStatusSchema,
    checked_at: IsoDateTimeSchema,
    http_status: z.number().int().min(100).max(599).nullable(),
    response_time_ms: z.number().int().min(0),
    error_message: z.string().min(1).max(500).nullable().optional(),
  })
  .strict();

export const DefaultAlwaysAllowProcessorSchema = ProcessorRegistryBaseSchema.extend({
  processor_id: z.literal('default-manual'),
  hooks: z.array(ProcessorHookSchema).default(['on-enter', 'on-update', 'on-action', 'can-exit', 'on-exit']),
}).strict();

export const BoardEntitySchema = z
  .object({
    uid: BoardIdSchema,
    title: z.string().min(1).max(200),
    prefix: BoardPrefixSchema,
    suite_uid: BoardSuiteIdSchema.nullable().optional(),
    role: z.string().min(1).max(50).nullable().optional(),
    schema: BoardSchemaDocumentSchema,
    permissions: BoardPermissionsSchema,
    created_at: IsoDateTimeSchema,
    updated_at: IsoDateTimeSchema,
  })
  .strict();

export const BoardSuiteEntitySchema = z
  .object({
    uid: BoardSuiteIdSchema,
    title: z.string().min(1).max(200),
    created_at: IsoDateTimeSchema,
    updated_at: IsoDateTimeSchema,
  })
  .strict();

export const BoardSequenceEntitySchema = z
  .object({
    prefix: BoardPrefixSchema,
    seq_value: z.number().int().min(0),
  })
  .strict();

export const CardProcessingStateSchema = z.enum(['IDLE', 'PROCESSING', 'ERROR']);

export const CardFamilyMetadataSchema = z
  .object({
    uid: CardIdSchema,
    board_uid: BoardIdSchema,
    display_id: DisplayIdSchema,
    status: ColumnUidSchema,
    title: z.string().min(1).max(200),
    processing_state: CardProcessingStateSchema.optional(),
  })
  .strict();

export const CardEntitySchema = z
  .object({
    uid: CardIdSchema,
    board_uid: BoardIdSchema,
    display_id: DisplayIdSchema,
    title: z.string().min(1).max(200),
    description: z.string().max(5000).nullable(),
    version: CardVersionSchema,
    processing_state: CardProcessingStateSchema,
    is_editable: z.boolean(),
    payload: CardPayloadSchema,
    current_status: ColumnUidSchema,
    created_at: IsoDateTimeSchema,
    updated_at: IsoDateTimeSchema,
    parents: z.array(CardFamilyMetadataSchema).optional(),
    children: z.array(CardFamilyMetadataSchema).optional(),
  })
  .strict()
  .superRefine((card, ctx) => {
    if (card.processing_state === 'PROCESSING' && card.is_editable) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['is_editable'],
        message: 'cards in PROCESSING state must be non-editable',
      });
    }
    if (card.processing_state === 'ERROR' && card.is_editable) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['is_editable'],
        message: 'cards in ERROR state must be non-editable',
      });
    }
  });

export const ApiErrorSchema = z
  .object({
    error: z
      .object({
        code: z.string().min(1),
        message: z.string().min(1),
        details: z.record(z.string(), JsonValueSchema).optional(),
      })
      .strict(),
  })
  .strict();

export const BoardPathParamsSchema = z.object({ boardId: BoardIdSchema }).strict();

export const CardPathParamsSchema = z
  .object({
    boardId: BoardIdSchema,
    cardId: CardIdSchema,
  })
  .strict();

export const SnapshotDataSchema = z
  .object({
    board: BoardEntitySchema,
    cards: z.array(CardEntitySchema),
  })
  .strict();

export const SnapshotResponseSchema = z
  .object({
    data: SnapshotDataSchema,
  })
  .strict();

export const CardTitleSchema = z
  .string()
  .trim()
  .min(1, { message: 'title is required' })
  .max(200, { message: 'title must be at most 200 characters' });

export const CardDescriptionSchema = z
  .string()
  .max(5000, { message: 'description must be at most 5000 characters' })
  .nullable();

export const CardResponseDataSchema = z.object({ card: CardEntitySchema }).strict();

export const CreateCardRequestSchema = z
  .object({
    title: CardTitleSchema,
    description: CardDescriptionSchema.optional(),
    current_status: ColumnUidSchema,
    payload: CardPayloadSchema.optional(),
  })
  .strict();

export const CreateCardResponseSchema = z
  .object({
    data: CardResponseDataSchema,
  })
  .strict();

export const GetCardResponseSchema = z
  .object({
    data: CardResponseDataSchema,
  })
  .strict();

export const UpdateCardRequestSchema = z
  .object({
    version: CardVersionSchema,
    title: CardTitleSchema.optional(),
    description: CardDescriptionSchema.optional(),
    payload: CardPayloadSchema.optional(),
  })
  .strict()
  .refine((value) => value.title !== undefined || value.description !== undefined || value.payload !== undefined, {
    message: 'at least one of title, description, or payload must be provided',
    path: ['title'],
  });

export const UpdateCardResponseSchema = z
  .object({
    data: CardResponseDataSchema,
  })
  .strict();

export const CardConflictResponseSchema = z
  .object({
    error: z
      .object({
        code: z.literal('CONFLICT'),
        message: z.string().min(1),
        details: z
          .object({
            current_version: CardVersionSchema,
            card: CardEntitySchema,
          })
          .strict(),
      })
      .strict(),
  })
  .strict();

export const CanExitHookRequestSchema = z
  .object({
    card: CardEntitySchema,
    target_column: ColumnUidSchema,
    actor: z.string().min(1).max(200),
  })
  .strict();

export const CanExitHookResponseSchema = z
  .object({
    allowed: z.boolean(),
    message: z.string().min(1).nullable().optional(),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (!value.allowed && !value.message) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['message'],
        message: 'message is required when allowed is false',
      });
    }
  });

export const SyncHookDispatchRequestSchema = z
  .object({
    hook: SyncHookSchema,
    processor_id: ProcessorIdSchema,
    timeout_ms: SyncHookTimeoutMsSchema.default(3000),
  })
  .strict();

export const MoveCardBlockedResponseSchema = z
  .object({
    error: z
      .object({
        code: z.literal('MOVE_BLOCKED'),
        message: z.string().min(1),
        details: z
          .object({
            hook: z.literal('can-exit'),
          })
          .strict()
          .optional(),
      })
      .strict(),
  })
  .strict();

export const MoveCardRequestSchema = z
  .object({
    to_column_uid: ColumnUidSchema,
  })
  .strict();

export const MoveCardResponseSchema = z
  .object({
    data: CardResponseDataSchema,
  })
  .strict();

export const CardRelationshipEntitySchema = z
  .object({
    parent_card_uid: CardIdSchema,
    child_card_uid: CardIdSchema,
    parent_board_uid: BoardIdSchema.nullable().optional(),
    child_board_uid: BoardIdSchema.nullable().optional(),
    relationship_type: z.string().min(1).max(50),
    created_at: IsoDateTimeSchema,
  })
  .strict();

export const CreateCardRelationshipRequestSchema = z
  .object({
    child_card_uid: CardIdSchema,
    parent_board_uid: BoardIdSchema.optional(),
    child_board_uid: BoardIdSchema.optional(),
    relationship_type: z.string().min(1).max(50).optional(),
  })
  .strict();

export const CardFamilyResponseSchema = z
  .object({
    data: z
      .object({
        card: CardEntitySchema,
        parents: z.array(CardFamilyMetadataSchema),
        children: z.array(CardFamilyMetadataSchema),
      })
      .strict(),
  })
  .strict();

export const EventIdSchema = z.string().min(1, { message: 'event_id is required' }).brand('EventId');

export const EventLogCategorySchema = z.enum(['routing', 'lifecycle', 'user_action', 'system']);

export const EventLogActionSchema = z.enum([
  'CARD_CREATED',
  'CARD_UPDATED',
  'CARD_MOVED',
  'MOVED',
  'ACTION_TRIGGERED',
  'PROCESSING_STARTED',
  'PROCESSING_COMPLETED',
  'PROCESSING_ERROR',
  'ROLLUP_CHANGED',
  'ADMIN_OVERRIDE',
  'BOARD_RELOAD',
]);

export const EventLogLifecycleEventSchema = z.enum([
  'PROCESSING_STARTED',
  'PROCESSING_COMPLETED',
  'PROCESSING_ERROR',
]);

export const EventLogRowSchema = z
  .object({
    event_id: EventIdSchema,
    card_uid: CardIdSchema,
    board_uid: BoardIdSchema.nullable(),
    timestamp: IsoDateTimeSchema,
    actor: z.string().min(1).max(200),
    action: EventLogActionSchema,
    category: EventLogCategorySchema,
    lifecycle_event: EventLogLifecycleEventSchema.nullable(),
    from_column: ColumnUidSchema.nullable(),
    to_column: ColumnUidSchema.nullable(),
    idempotency_key: IdempotencyKeySchema.nullable().optional(),
    payload_delta: z.record(z.string().min(1), JsonValueSchema).nullable().optional(),
    metadata: z.record(z.string().min(1), JsonValueSchema).nullable().optional(),
  })
  .strict()
  .superRefine((value, ctx) => {
    if ((value.action === 'CARD_MOVED' || value.action === 'MOVED') && (!value.from_column || !value.to_column)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['from_column'],
        message: 'from_column and to_column are required for move events',
      });
    }

    if (value.category === 'lifecycle' && !value.lifecycle_event) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['lifecycle_event'],
        message: 'lifecycle_event is required when category is lifecycle',
      });
    }

    if (value.lifecycle_event && value.category !== 'lifecycle') {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['category'],
        message: 'category must be lifecycle when lifecycle_event is present',
      });
    }
  });

export const CardCreatedEventDataSchema = z
  .object({
    event_id: EventIdSchema,
    board_uid: BoardIdSchema,
    actor: z.string().min(1).max(200),
    timestamp: IsoDateTimeSchema,
    card: CardEntitySchema,
  })
  .strict()
  .refine((value) => value.card.board_uid === value.board_uid, {
    path: ['card', 'board_uid'],
    message: 'card.board_uid must match board_uid',
  });

export const CardUpdatedEventDataSchema = z
  .object({
    event_id: EventIdSchema,
    board_uid: BoardIdSchema,
    actor: z.string().min(1).max(200),
    timestamp: IsoDateTimeSchema,
    card: CardEntitySchema,
    changed_fields: z
      .array(
        z.enum([
          'title',
          'description',
          'payload',
          'processing_state',
          'is_editable',
          'current_status',
          'version',
          'updated_at',
        ]),
      )
      .min(1)
      .max(8),
  })
  .strict()
  .refine((value) => value.card.board_uid === value.board_uid, {
    path: ['card', 'board_uid'],
    message: 'card.board_uid must match board_uid',
  });

export const CardMovedEventDataSchema = z
  .object({
    event_id: EventIdSchema,
    board_uid: BoardIdSchema,
    actor: z.string().min(1).max(200),
    timestamp: IsoDateTimeSchema,
    card: CardEntitySchema,
    from_column: ColumnUidSchema,
    to_column: ColumnUidSchema,
  })
  .strict()
  .superRefine((value, ctx) => {
    if (value.card.board_uid !== value.board_uid) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['card', 'board_uid'],
        message: 'card.board_uid must match board_uid',
      });
    }

    if (value.card.current_status !== value.to_column) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['card', 'current_status'],
        message: 'card.current_status must match to_column',
      });
    }

    if (value.from_column === value.to_column) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['to_column'],
        message: 'to_column must differ from from_column',
      });
    }
  });

export const BoardReloadEventDataSchema = z
  .object({
    event_id: EventIdSchema,
    board_uid: BoardIdSchema,
    reason: z.enum(['CURSOR_EXPIRED', 'BUFFER_MISS', 'SERVER_RESET']),
    timestamp: IsoDateTimeSchema,
  })
  .strict();

export const RollupChangedEventDataSchema = z
  .object({
    event_id: EventIdSchema,
    board_uid: BoardIdSchema,
    actor: z.string().min(1).max(200),
    timestamp: IsoDateTimeSchema,
    parent_card_uid: CardIdSchema,
    parent_card: CardFamilyMetadataSchema,
    completed_children: z.number().int().min(0),
    total_children: z.number().int().min(0),
    health_score: z.number().min(0).max(100),
  })
  .strict();

export const BoardStreamEventTypeSchema = z.enum(['CARD_CREATED', 'CARD_UPDATED', 'CARD_MOVED', 'ROLLUP_CHANGED', 'BOARD_RELOAD']);

export const RollupChangedSseEventSchema = z
  .object({
    id: EventIdSchema,
    event: z.literal('ROLLUP_CHANGED'),
    data: RollupChangedEventDataSchema,
  })
  .strict()
  .refine((value) => value.id === value.data.event_id, {
    path: ['data', 'event_id'],
    message: 'data.event_id must match id',
  });

export const CardCreatedSseEventSchema = z
  .object({
    id: EventIdSchema,
    event: z.literal('CARD_CREATED'),
    data: CardCreatedEventDataSchema,
  })
  .strict()
  .refine((value) => value.id === value.data.event_id, {
    path: ['data', 'event_id'],
    message: 'data.event_id must match id',
  });

export const CardUpdatedSseEventSchema = z
  .object({
    id: EventIdSchema,
    event: z.literal('CARD_UPDATED'),
    data: CardUpdatedEventDataSchema,
  })
  .strict()
  .refine((value) => value.id === value.data.event_id, {
    path: ['data', 'event_id'],
    message: 'data.event_id must match id',
  });

export const CardMovedSseEventSchema = z
  .object({
    id: EventIdSchema,
    event: z.literal('CARD_MOVED'),
    data: CardMovedEventDataSchema,
  })
  .strict()
  .refine((value) => value.id === value.data.event_id, {
    path: ['data', 'event_id'],
    message: 'data.event_id must match id',
  });

export const BoardReloadSseEventSchema = z
  .object({
    id: EventIdSchema,
    event: z.literal('BOARD_RELOAD'),
    data: BoardReloadEventDataSchema,
  })
  .strict()
  .refine((value) => value.id === value.data.event_id, {
    path: ['data', 'event_id'],
    message: 'data.event_id must match id',
  });

export const BoardStreamSseEventSchema = z.discriminatedUnion('event', [
  CardCreatedSseEventSchema,
  CardUpdatedSseEventSchema,
  CardMovedSseEventSchema,
  RollupChangedSseEventSchema,
  BoardReloadSseEventSchema,
]);

export const BoardStreamRequestHeadersSchema = z
  .object({
    'last-event-id': EventIdSchema.optional(),
  })
  .strict();

export const SseReplayBufferWindowMsSchema = z.literal(300000);

export const BoardStreamReplayCursorSchema = z
  .object({
    last_event_id: EventIdSchema.optional(),
  })
  .strict();

export const BoardStreamReplayDispositionSchema = z.enum(['LIVE', 'REPLAY', 'RESET_REQUIRED']);

export const AuditLogQuerySchema = z
  .object({
    limit: z.coerce.number().int().min(1).max(200).default(50),
    cursor: z.string().min(1).max(200).optional(),
    from: IsoDateTimeSchema.optional(),
    to: IsoDateTimeSchema.optional(),
    categories: z.array(EventLogCategorySchema).max(4).optional(),
    actions: z.array(EventLogActionSchema).max(20).optional(),
    card_uid: CardIdSchema.optional(),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (value.from && value.to && new Date(value.from).getTime() > new Date(value.to).getTime()) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['from'],
        message: 'from must be less than or equal to to',
      });
    }
  });

export const AuditLogResponseSchema = z
  .object({
    data: z
      .object({
        events: z.array(EventLogRowSchema),
        next_cursor: z.string().min(1).max(200).nullable(),
      })
      .strict(),
  })
  .strict();

export const ClientCardStateUpdateSchema = z.discriminatedUnion('event', [
  z
    .object({
      event: z.literal('CARD_CREATED'),
      data: CardCreatedEventDataSchema,
    })
    .strict(),
  z
    .object({
      event: z.literal('CARD_UPDATED'),
      data: CardUpdatedEventDataSchema,
    })
    .strict(),
  z
    .object({
      event: z.literal('CARD_MOVED'),
      data: CardMovedEventDataSchema,
    })
    .strict(),
]);

export const CallbackTokenEntitySchema = z
  .object({
    token: CallbackTokenSchema,
    card_uid: CardIdSchema,
    processor_id: ProcessorIdSchema,
    hook: AsyncCallbackHookSchema,
    idempotency_key: IdempotencyKeySchema,
    context: z.record(z.string(), JsonValueSchema),
    expires_at: IsoDateTimeSchema,
    created_at: IsoDateTimeSchema,
  })
  .strict();

export const ProcessingStateTransitionSchema = z
  .object({
    from: CardProcessingStateSchema,
    to: CardProcessingStateSchema,
  })
  .strict()
  .refine(
    ({ from, to }) => {
      const validTransitions = new Set([
        'IDLE->PROCESSING',
        'PROCESSING->IDLE',
        'PROCESSING->ERROR',
        'ERROR->PROCESSING',
        'ERROR->IDLE',
      ]);
      return validTransitions.has(`${from}->${to}`);
    },
    {
      message: 'invalid processing state transition',
      path: ['to'],
    },
  );

export const OnEnterDispatchRequestSchema = z
  .object({
    card: CardEntitySchema,
    board: BoardEntitySchema,
    column: ProcessingBoardColumnSchema,
    callback_url: z.string().url(),
    idempotency_key: IdempotencyKeySchema,
  })
  .strict();

export const OnEnterDispatchAcceptedResponseSchema = z
  .object({
    status: z.literal('accepted'),
    estimated_duration: z.string().min(1).max(60).optional(),
  })
  .strict();

export const ProcessorContextSchema = z
  .object({
    card: CardEntitySchema,
    board: BoardEntitySchema,
    column: BoardColumnSchema,
    actor: z.string().min(1).max(200),
    callback_url: z.string().url(),
    idempotency_key: IdempotencyKeySchema,
  })
  .strict();

export const OnUpdateRequestSchema = z
  .object({
    card: CardEntitySchema,
    proposed_payload: CardPayloadSchema,
    actor: z.string().min(1).max(200),
  })
  .strict();

export const OnUpdateResponseSchema = z
  .object({
    allowed: z.boolean(),
    message: z.string().min(1).nullable().optional(),
    transformed_payload: CardPayloadSchema.nullable().optional(),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (!value.allowed && !value.message) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['message'],
        message: 'message is required when allowed is false',
      });
    }
  });

export const OnActionRequestSchema = ProcessorContextSchema.extend({
  action: z.string().min(1).max(200),
}).strict();

export const OnExitRequestSchema = z
  .object({
    card: CardEntitySchema,
    next_column: BoardColumnSchema,
    actor: z.string().min(1).max(200),
  })
  .strict();

export const HealthCheckResponseSchema = z
  .object({
    status: z.literal('healthy'),
  })
  .strict();

export const TriggerActionRequestSchema = z
  .object({
    action: z.string().min(1).max(200),
    version: CardVersionSchema,
  })
  .strict();

export const TriggerActionResponseSchema = z
  .object({
    data: z.object({
      card: CardEntitySchema,
      status: z.enum(['completed', 'accepted']),
    }).strict(),
  })
  .strict();

export const ListBoardsResponseSchema = z
  .object({
    data: z.object({
      boards: z.array(BoardEntitySchema),
    }).strict(),
  })
  .strict();

export const ProcessorCallbackPathParamsSchema = z
  .object({
    token: CallbackTokenSchema,
  })
  .strict();

export const ProcessorCallbackHeadersSchema = z
  .object({
    authorization: z
      .string()
      .regex(/^Bearer\s+.+$/, { message: 'authorization must be a Bearer token' }),
  })
  .strict();

export const ProcessorCallbackPayloadUpdatesSchema = z
  .object({
    title: CardTitleSchema.optional(),
    description: CardDescriptionSchema.optional(),
    payload: CardPayloadSchema.optional(),
    is_editable: z.boolean().optional(),
  })
  .strict();

export const ProcessorCallbackRequestSchema = z
  .object({
    status: z.enum(['success', 'error']).default('success'),
    payload_updates: ProcessorCallbackPayloadUpdatesSchema.optional(),
    move_to_column: ColumnUidSchema.nullable().optional(),
    error_message: z.string().min(1).max(500).optional(),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (value.status === 'error' && !value.error_message) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['error_message'],
        message: 'error_message is required when status is error',
      });
    }
  });

export const ProcessorCallbackResponseSchema = z
  .object({
    data: z.object({ card: CardEntitySchema }).strict(),
  })
  .strict();

export const CallbackTokenRejectedResponseSchema = z
  .object({
    error: z
      .object({
        code: z.enum(['CALLBACK_TOKEN_MISSING', 'CALLBACK_TOKEN_EXPIRED', 'CALLBACK_TOKEN_REPLAYED']),
        message: z.string().min(1),
      })
      .strict(),
  })
  .strict();

export const CreateBoardRequestSchema = z
  .object({
    template: BoardTemplateSchema.optional().default('default'),
    title: z.string().min(1).max(200).optional(),
    prefix: BoardPrefixSchema.optional(),
  })
  .strict();

export const CreateBoardSuiteRequestSchema = z
  .object({
    template: BoardSuiteTemplateSchema.optional().default('default'),
    title: z.string().min(1).max(200).optional(),
  })
  .strict();

export const BoardSuiteWithBoardsSchema = z
  .object({
    suite: BoardSuiteEntitySchema,
    boards: z.array(BoardEntitySchema),
  })
  .strict();

export const ListBoardSuitesResponseSchema = z
  .object({
    data: z.object({
      suites: z.array(BoardSuiteWithBoardsSchema),
    }).strict(),
  })
  .strict();

export const BoardSuiteResponseSchema = z
  .object({
    data: BoardSuiteWithBoardsSchema,
  })
  .strict();

export const BoardSuiteSnapshotResponseSchema = z
  .object({
    data: z.object({
      suite: BoardSuiteEntitySchema,
      boards: z.array(z.object({
        board: BoardEntitySchema,
        cards: z.array(CardEntitySchema),
      }).strict()),
    }).strict(),
  })
  .strict();

export const UpdateBoardRequestSchema = z
  .object({
    title: z.string().min(1).max(200).optional(),
  })
  .strict()
  .refine((value) => value.title !== undefined, {
    message: 'at least one field must be provided',
    path: ['title'],
  });

export const UpdateBoardResponseSchema = z
  .object({
    data: z.object({ board: BoardEntitySchema }).strict(),
  })
  .strict();

export const CreateBoardResponseSchema = z
  .object({
    data: z.object({ board: BoardEntitySchema }).strict(),
  })
  .strict();

export type BoardPathParams = z.infer<typeof BoardPathParamsSchema>;
export type CardPathParams = z.infer<typeof CardPathParamsSchema>;
export type BoardEntity = z.infer<typeof BoardEntitySchema>;
export type BoardSequenceEntity = z.infer<typeof BoardSequenceEntitySchema>;
export type CardEntity = z.infer<typeof CardEntitySchema>;
export type ProcessorRegistryEntity = z.infer<typeof ProcessorRegistryEntitySchema>;
export type UpsertProcessorRegistryRequest = z.infer<typeof UpsertProcessorRegistryRequestSchema>;
export type ProcessorHealthPollConfig = z.infer<typeof ProcessorHealthPollConfigSchema>;
export type ProcessorHealthCheckResult = z.infer<typeof ProcessorHealthCheckResultSchema>;
export type DefaultAlwaysAllowProcessor = z.infer<typeof DefaultAlwaysAllowProcessorSchema>;
export type SnapshotData = z.infer<typeof SnapshotDataSchema>;
export type SnapshotResponse = z.infer<typeof SnapshotResponseSchema>;
export type CardResponseData = z.infer<typeof CardResponseDataSchema>;
export type CreateCardRequest = z.infer<typeof CreateCardRequestSchema>;
export type CreateCardResponse = z.infer<typeof CreateCardResponseSchema>;
export type GetCardResponse = z.infer<typeof GetCardResponseSchema>;
export type UpdateCardRequest = z.infer<typeof UpdateCardRequestSchema>;
export type UpdateCardResponse = z.infer<typeof UpdateCardResponseSchema>;
export type CardConflictResponse = z.infer<typeof CardConflictResponseSchema>;
export type CanExitHookRequest = z.infer<typeof CanExitHookRequestSchema>;
export type CanExitHookResponse = z.infer<typeof CanExitHookResponseSchema>;
export type SyncHookDispatchRequest = z.infer<typeof SyncHookDispatchRequestSchema>;
export type MoveCardBlockedResponse = z.infer<typeof MoveCardBlockedResponseSchema>;
export type MoveCardRequest = z.infer<typeof MoveCardRequestSchema>;
export type MoveCardResponse = z.infer<typeof MoveCardResponseSchema>;
export type BoardSuiteEntity = z.infer<typeof BoardSuiteEntitySchema>;
export type BoardSuiteWithBoards = z.infer<typeof BoardSuiteWithBoardsSchema>;
export type CardRelationshipEntity = z.infer<typeof CardRelationshipEntitySchema>;
export type CreateCardRelationshipRequest = z.infer<typeof CreateCardRelationshipRequestSchema>;
export type CreateBoardSuiteRequest = z.infer<typeof CreateBoardSuiteRequestSchema>;
export type CardFamilyResponse = z.infer<typeof CardFamilyResponseSchema>;
export type EventId = z.infer<typeof EventIdSchema>;
export type EventLogCategory = z.infer<typeof EventLogCategorySchema>;
export type EventLogAction = z.infer<typeof EventLogActionSchema>;
export type EventLogLifecycleEvent = z.infer<typeof EventLogLifecycleEventSchema>;
export type EventLogRow = z.infer<typeof EventLogRowSchema>;
export type CardFamilyMetadata = z.infer<typeof CardFamilyMetadataSchema>;
export type CardCreatedEventData = z.infer<typeof CardCreatedEventDataSchema>;
export type CardUpdatedEventData = z.infer<typeof CardUpdatedEventDataSchema>;
export type CardMovedEventData = z.infer<typeof CardMovedEventDataSchema>;
export type BoardReloadEventData = z.infer<typeof BoardReloadEventDataSchema>;
export type RollupChangedEventData = z.infer<typeof RollupChangedEventDataSchema>;
export type BoardStreamEventType = z.infer<typeof BoardStreamEventTypeSchema>;
export type CardCreatedSseEvent = z.infer<typeof CardCreatedSseEventSchema>;
export type CardUpdatedSseEvent = z.infer<typeof CardUpdatedSseEventSchema>;
export type CardMovedSseEvent = z.infer<typeof CardMovedSseEventSchema>;
export type RollupChangedSseEvent = z.infer<typeof RollupChangedSseEventSchema>;
export type BoardReloadSseEvent = z.infer<typeof BoardReloadSseEventSchema>;
export type BoardStreamSseEvent = z.infer<typeof BoardStreamSseEventSchema>;
export type BoardStreamRequestHeaders = z.infer<typeof BoardStreamRequestHeadersSchema>;
export type SseReplayBufferWindowMs = z.infer<typeof SseReplayBufferWindowMsSchema>;
export type BoardStreamReplayCursor = z.infer<typeof BoardStreamReplayCursorSchema>;
export type BoardStreamReplayDisposition = z.infer<typeof BoardStreamReplayDispositionSchema>;
export type AuditLogQuery = z.infer<typeof AuditLogQuerySchema>;
export type AuditLogResponse = z.infer<typeof AuditLogResponseSchema>;
export type ClientCardStateUpdate = z.infer<typeof ClientCardStateUpdateSchema>;
export type CallbackTokenEntity = z.infer<typeof CallbackTokenEntitySchema>;
export type ProcessingStateTransition = z.infer<typeof ProcessingStateTransitionSchema>;
export type OnEnterDispatchRequest = z.infer<typeof OnEnterDispatchRequestSchema>;
export type OnEnterDispatchAcceptedResponse = z.infer<typeof OnEnterDispatchAcceptedResponseSchema>;
export type ProcessorCallbackPathParams = z.infer<typeof ProcessorCallbackPathParamsSchema>;
export type ProcessorCallbackHeaders = z.infer<typeof ProcessorCallbackHeadersSchema>;
export type ProcessorCallbackPayloadUpdates = z.infer<typeof ProcessorCallbackPayloadUpdatesSchema>;
export type ProcessorCallbackRequest = z.infer<typeof ProcessorCallbackRequestSchema>;
export type ProcessorCallbackResponse = z.infer<typeof ProcessorCallbackResponseSchema>;
export type CallbackTokenRejectedResponse = z.infer<typeof CallbackTokenRejectedResponseSchema>;
export type CreateBoardRequest = z.infer<typeof CreateBoardRequestSchema>;
export type CreateBoardResponse = z.infer<typeof CreateBoardResponseSchema>;
export type ListBoardSuitesResponse = z.infer<typeof ListBoardSuitesResponseSchema>;
export type BoardSuiteResponse = z.infer<typeof BoardSuiteResponseSchema>;
export type BoardSuiteSnapshotResponse = z.infer<typeof BoardSuiteSnapshotResponseSchema>;
export type UpdateBoardRequest = z.infer<typeof UpdateBoardRequestSchema>;
export type UpdateBoardResponse = z.infer<typeof UpdateBoardResponseSchema>;
export type ApiError = z.infer<typeof ApiErrorSchema>;
export type ProcessorContext = z.infer<typeof ProcessorContextSchema>;
export type OnUpdateRequest = z.infer<typeof OnUpdateRequestSchema>;
export type OnUpdateResponse = z.infer<typeof OnUpdateResponseSchema>;
export type OnActionRequest = z.infer<typeof OnActionRequestSchema>;
export type OnExitRequest = z.infer<typeof OnExitRequestSchema>;
export type HealthCheckResponse = z.infer<typeof HealthCheckResponseSchema>;
export type TriggerActionRequest = z.infer<typeof TriggerActionRequestSchema>;
export type TriggerActionResponse = z.infer<typeof TriggerActionResponseSchema>;
export type ListBoardsResponse = z.infer<typeof ListBoardsResponseSchema>;
