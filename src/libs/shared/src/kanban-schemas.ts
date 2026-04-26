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

export const CardIdSchema = z.string().uuid({ message: 'cardId must be a valid UUID' }).brand('CardId');
export type CardId = z.infer<typeof CardIdSchema>;

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

export const BoardColumnTypeSchema = z.enum(['Normal', 'Processing']);

export const BoardColumnSchema = z
  .object({
    uid: ColumnUidSchema,
    title: z.string().min(1, { message: 'column title is required' }).max(120),
    type: BoardColumnTypeSchema,
    processor_id: ProcessorIdSchema,
    exit_logic: z.record(z.string().min(1), ColumnUidSchema),
    order: z.number().int().min(0),
  })
  .strict();

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

export const BoardEntitySchema = z
  .object({
    uid: BoardIdSchema,
    title: z.string().min(1).max(200),
    prefix: BoardPrefixSchema,
    schema: BoardSchemaDocumentSchema,
    permissions: BoardPermissionsSchema,
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

export const CardEntitySchema = z
  .object({
    uid: CardIdSchema,
    board_uid: BoardIdSchema,
    display_id: DisplayIdSchema,
    title: z.string().min(1).max(200),
    description: z.string().max(5000).nullable(),
    version: z.number().int().min(1),
    processing_state: CardProcessingStateSchema,
    is_editable: z.boolean(),
    payload: CardPayloadSchema,
    current_status: ColumnUidSchema,
    created_at: IsoDateTimeSchema,
    updated_at: IsoDateTimeSchema,
  })
  .strict();

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
    title: CardTitleSchema.optional(),
    description: CardDescriptionSchema.optional(),
  })
  .strict()
  .refine((value) => value.title !== undefined || value.description !== undefined, {
    message: 'at least one of title or description must be provided',
    path: ['title'],
  });

export const UpdateCardResponseSchema = z
  .object({
    data: CardResponseDataSchema,
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
export type SnapshotData = z.infer<typeof SnapshotDataSchema>;
export type SnapshotResponse = z.infer<typeof SnapshotResponseSchema>;
export type CardResponseData = z.infer<typeof CardResponseDataSchema>;
export type CreateCardRequest = z.infer<typeof CreateCardRequestSchema>;
export type CreateCardResponse = z.infer<typeof CreateCardResponseSchema>;
export type GetCardResponse = z.infer<typeof GetCardResponseSchema>;
export type UpdateCardRequest = z.infer<typeof UpdateCardRequestSchema>;
export type UpdateCardResponse = z.infer<typeof UpdateCardResponseSchema>;
export type MoveCardRequest = z.infer<typeof MoveCardRequestSchema>;
export type MoveCardResponse = z.infer<typeof MoveCardResponseSchema>;
export type CreateBoardResponse = z.infer<typeof CreateBoardResponseSchema>;
export type ApiError = z.infer<typeof ApiErrorSchema>;
