import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import {
  SqlitePragmasSchema,
  BoardEntitySchema,
  CardEntitySchema,
  CallbackTokenEntitySchema,
  ProcessorRegistryEntitySchema,
  EventLogRowSchema,
  type BoardEntity,
  type CardEntity,
  type EventLogRow,
  type AuditLogQuery,
} from '@repo/shared';
import {
  openDb,
  closeDb,
  getPragmas,
  seedBoard,
  getSnapshot,
  getCardById,
  getBoardById,
  createCard,
  updateCard,
  moveCard,
  createCallbackToken,
  getCallbackToken,
  deleteCallbackToken,
  updateCardProcessingState,
  upsertProcessorRegistry,
} from './repository.js';
import { appendEventLog, queryAuditLog } from './event-log.js';

const mockEventStore: EventLogRow[] = [];
let mockEventIdCounter = 0;
let mockTimestampCounter = 0;
const baseTimestamp = new Date('2026-04-27T00:00:00.000Z').getTime();

function resetMockState() {
  mockEventStore.length = 0;
  mockEventIdCounter = 0;
  mockTimestampCounter = 0;
}

function defaultAppendEventLog(_db: unknown, event: Record<string, unknown>): EventLogRow {
  const row = {
    ...event,
    event_id: event.event_id ?? `550e8400-e29b-41d4-a716-446655440${String(mockEventIdCounter++).padStart(3, '0')}`,
    timestamp: event.timestamp ?? new Date(baseTimestamp + mockTimestampCounter++ * 1000).toISOString(),
    lifecycle_event: event.lifecycle_event ?? null,
    from_column: event.from_column ?? null,
    to_column: event.to_column ?? null,
    idempotency_key: event.idempotency_key ?? null,
    payload_delta: event.payload_delta ?? null,
    metadata: event.metadata ?? null,
  } as EventLogRow;
  const parsed = EventLogRowSchema.safeParse(row);
  if (!parsed.success) {
    throw new Error('Invalid event log row: ' + JSON.stringify(parsed.error.issues));
  }
  mockEventStore.push(parsed.data);
  return parsed.data;
}

function defaultQueryAuditLog(_db: unknown, boardUid: string, query: AuditLogQuery) {
  let filtered = mockEventStore.filter((e) => e.board_uid === boardUid);
  if (query.from) {
    filtered = filtered.filter((e) => new Date(e.timestamp) >= new Date(query.from));
  }
  if (query.to) {
    filtered = filtered.filter((e) => new Date(e.timestamp) <= new Date(query.to));
  }
  if (query.categories?.length) {
    filtered = filtered.filter((e) => query.categories!.includes(e.category));
  }
  if (query.actions?.length) {
    filtered = filtered.filter((e) => query.actions!.includes(e.action));
  }
  if (query.card_uid) {
    filtered = filtered.filter((e) => e.card_uid === query.card_uid);
  }
  if (query.cursor) {
    filtered = filtered.filter((e) => new Date(e.timestamp) < new Date(query.cursor));
  }
  filtered.sort((a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime());
  const limit = query.limit ?? 50;
  const hasMore = filtered.length > limit;
  const events = hasMore ? filtered.slice(0, limit) : filtered;
  const next_cursor = hasMore && events.length > 0 ? events[events.length - 1].timestamp : null;
  return { events, next_cursor };
}

vi.mock('./event-log.js', () => ({
  appendEventLog: vi.fn(defaultAppendEventLog),
  queryAuditLog: vi.fn(defaultQueryAuditLog),
}));

describe('kanban repository', () => {
  let db: unknown;

  beforeAll(() => {
    db = openDb(':memory:');
  });

  afterAll(() => {
    closeDb(db);
  });

  beforeEach(() => {
    resetMockState();
    vi.mocked(appendEventLog).mockImplementation(defaultAppendEventLog);
    vi.mocked(queryAuditLog).mockImplementation(defaultQueryAuditLog);
  });

  describe('sqlite pragmas', () => {
    it('enables WAL mode with NORMAL synchronous and 5000ms busy timeout', () => {
      const pragmas = getPragmas(db);
      expect(SqlitePragmasSchema.safeParse(pragmas).success).toBe(true);
      expect(pragmas.journal_mode).toBe('wal');
      expect(pragmas.synchronous).toBe('normal');
      expect(pragmas.busy_timeout).toBe(5000);
    });
  });

  describe('seeded board', () => {
    let board: BoardEntity;

    beforeAll(() => {
      board = seedBoard(db);
    });

    it('returns a valid board entity', () => {
      expect(BoardEntitySchema.safeParse(board).success).toBe(true);
    });

    it('creates a board with at least one column', () => {
      expect(board.schema.columns.length).toBeGreaterThanOrEqual(1);
    });

    it('has a valid prefix matching board_sequences', () => {
      expect(board.prefix).toMatch(/^[A-Z][A-Z0-9]{0,9}$/);
    });
  });

  describe('card lifecycle', () => {
    let board: BoardEntity;

    beforeAll(() => {
      board = seedBoard(db);
    });

    it('creates a card with monotonic display ids via board_sequences', () => {
      const firstColumn = board.schema.columns[0].uid;

      const card1 = createCard(db, board.uid, {
        title: 'Card One',
        current_status: firstColumn,
      });

      const card2 = createCard(db, board.uid, {
        title: 'Card Two',
        current_status: firstColumn,
      });

      expect(CardEntitySchema.safeParse(card1).success).toBe(true);
      expect(CardEntitySchema.safeParse(card2).success).toBe(true);

      expect(card1.display_id).toBe(`${board.prefix}-1`);
      expect(card2.display_id).toBe(`${board.prefix}-2`);

      const id1 = parseInt(card1.display_id.split('-')[1], 10);
      const id2 = parseInt(card2.display_id.split('-')[1], 10);
      expect(id2).toBe(id1 + 1);
    });

    it('retrieves a card by id', () => {
      const firstColumn = board.schema.columns[0].uid;
      const created = createCard(db, board.uid, {
        title: 'Retrievable Card',
        current_status: firstColumn,
      });

      const found = getCardById(db, board.uid, created.uid);
      expect(found).toBeDefined();
      expect(found!.uid).toBe(created.uid);
    });

    it('returns undefined for unknown card id', () => {
      const found = getCardById(
        db,
        board.uid,
        '00000000-0000-0000-0000-000000000000',
      );
      expect(found).toBeUndefined();
    });

    it('updates card title and increments version', () => {
      const firstColumn = board.schema.columns[0].uid;
      const created = createCard(db, board.uid, {
        title: 'Original Title',
        current_status: firstColumn,
      });

      const updated = updateCard(db, board.uid, created.uid, {
        title: 'Updated Title',
      });

      expect(updated.title).toBe('Updated Title');
      expect(updated.version).toBe(created.version + 1);
    });

    it('updates card description', () => {
      const firstColumn = board.schema.columns[0].uid;
      const created = createCard(db, board.uid, {
        title: 'Desc Card',
        current_status: firstColumn,
      });

      const updated = updateCard(db, board.uid, created.uid, {
        description: 'New description',
      });

      expect(updated.description).toBe('New description');
    });

    it('moves card to a different column', () => {
      const fromColumn = board.schema.columns[0].uid;
      const toColumn =
        board.schema.columns[1]?.uid ?? board.schema.columns[0].uid;
      const created = createCard(db, board.uid, {
        title: 'Movable Card',
        current_status: fromColumn,
      });

      const moved = moveCard(db, board.uid, created.uid, toColumn);
      expect(moved.current_status).toBe(toColumn);
    });

    it('returns snapshot with board and all cards', () => {
      const firstColumn = board.schema.columns[0].uid;
      createCard(db, board.uid, {
        title: 'Snapshot Card 1',
        current_status: firstColumn,
      });
      createCard(db, board.uid, {
        title: 'Snapshot Card 2',
        current_status: firstColumn,
      });

      const snapshot = getSnapshot(db, board.uid);
      expect(snapshot).toBeDefined();
      expect(snapshot.board.uid).toBe(board.uid);
      expect(snapshot.cards.length).toBeGreaterThanOrEqual(2);
    });

    it('returns undefined snapshot for unknown board', () => {
      const snapshot = getSnapshot(
        db,
        '00000000-0000-0000-0000-000000000000',
      );
      expect(snapshot).toBeUndefined();
    });

    it('rejects creating a card with invalid current_status', () => {
      expect(() =>
        createCard(db, board.uid, {
          title: 'Invalid Status Card',
          current_status: 'nonexistent-column',
        }),
      ).toThrow();
    });

    it('updates both title and description together', () => {
      const firstColumn = board.schema.columns[0].uid;
      const created = createCard(db, board.uid, {
        title: 'Original Title',
        current_status: firstColumn,
      });

      const updated = updateCard(db, board.uid, created.uid, {
        title: 'Updated Title',
        description: 'Updated description',
      });

      expect(updated.title).toBe('Updated Title');
      expect(updated.description).toBe('Updated description');
      expect(updated.version).toBe(created.version + 1);
    });

    it('increments version on move', () => {
      const fromColumn = board.schema.columns[0].uid;
      const toColumn =
        board.schema.columns[1]?.uid ?? board.schema.columns[0].uid;
      const created = createCard(db, board.uid, {
        title: 'Movable Card',
        current_status: fromColumn,
      });

      const moved = moveCard(db, board.uid, created.uid, toColumn);
      expect(moved.current_status).toBe(toColumn);
      expect(moved.version).toBe(created.version + 1);
    });

    it('rejects moving card to invalid destination column', () => {
      const fromColumn = board.schema.columns[0].uid;
      const created = createCard(db, board.uid, {
        title: 'Stuck Card',
        current_status: fromColumn,
      });

      expect(() =>
        moveCard(db, board.uid, created.uid, 'nonexistent-column'),
      ).toThrow();
    });

    it('only returns card for matching board/card pair', () => {
      const otherBoard = seedBoard(db);
      const firstColumn = board.schema.columns[0].uid;
      const otherColumn = otherBoard.schema.columns[0].uid;

      const cardOnBoard = createCard(db, board.uid, {
        title: 'Board A Card',
        current_status: firstColumn,
      });

      const cardOnOther = createCard(db, otherBoard.uid, {
        title: 'Board B Card',
        current_status: otherColumn,
      });

      const foundCorrect = getCardById(db, board.uid, cardOnBoard.uid);
      expect(foundCorrect).toBeDefined();
      expect(foundCorrect!.uid).toBe(cardOnBoard.uid);

      const foundWrongBoard = getCardById(db, board.uid, cardOnOther.uid);
      expect(foundWrongBoard).toBeUndefined();

      const foundOther = getCardById(db, otherBoard.uid, cardOnOther.uid);
      expect(foundOther).toBeDefined();
      expect(foundOther!.uid).toBe(cardOnOther.uid);
    });
  });

  describe('getBoardById', () => {
    it('returns null for an unknown board id', () => {
      const result = getBoardById(db, '00000000-0000-0000-0000-000000000000');
      expect(result).toBeNull();
    });
  });

  describe('createCard edge cases', () => {
    let board: BoardEntity;

    beforeAll(() => {
      board = seedBoard(db);
    });

    it('throws BOARD_NOT_FOUND when board does not exist', () => {
      expect(() =>
        createCard(db, '00000000-0000-0000-0000-000000000000', {
          title: 'Orphan Card',
          current_status: 'backlog',
        }),
      ).toThrow('BOARD_NOT_FOUND');
    });
  });

  describe('updateCard edge cases', () => {
    let board: BoardEntity;

    beforeAll(() => {
      board = seedBoard(db);
    });

    it('returns null when card does not exist', () => {
      const result = updateCard(db, board.uid, '00000000-0000-0000-0000-000000000000', {
        title: 'Ghost',
      });
      expect(result).toBeNull();
    });

    it('does not update a card belonging to a different board', () => {
      const otherBoard = seedBoard(db);
      const column = board.schema.columns[0].uid;

      const card = createCard(db, board.uid, {
        title: 'Board A Card',
        current_status: column,
      });

      const result = updateCard(db, otherBoard.uid, card.uid, {
        title: 'Hacked Title',
      });

      expect(result).toBeNull();

      const untouched = getCardById(db, board.uid, card.uid);
      expect(untouched).toBeDefined();
      expect(untouched!.title).toBe('Board A Card');
    });
  });

  describe('moveCard edge cases', () => {
    let board: BoardEntity;

    beforeAll(() => {
      board = seedBoard(db);
    });

    it('throws BOARD_NOT_FOUND when board does not exist', () => {
      expect(() =>
        moveCard(db, '00000000-0000-0000-0000-000000000000', '00000000-0000-0000-0000-000000000000', 'backlog'),
      ).toThrow('BOARD_NOT_FOUND');
    });

    it('throws CARD_NOT_FOUND when card does not exist on valid board', () => {
      const column = board.schema.columns[0].uid;
      expect(() =>
        moveCard(db, board.uid, '00000000-0000-0000-0000-000000000000', column),
      ).toThrow('CARD_NOT_FOUND');
    });

    it('does not move a card belonging to a different board', () => {
      const otherBoard = seedBoard(db);
      const column = board.schema.columns[0].uid;
      const otherColumn = otherBoard.schema.columns[0].uid;

      const card = createCard(db, board.uid, {
        title: 'Board A Card',
        current_status: column,
      });

      expect(() => moveCard(db, otherBoard.uid, card.uid, otherColumn)).toThrow('CARD_NOT_FOUND');

      const untouched = getCardById(db, board.uid, card.uid);
      expect(untouched).toBeDefined();
      expect(untouched!.current_status).toBe(column);
    });
  });

  describe('getSnapshot edge cases', () => {
    it('returns empty cards array for a board with no cards', () => {
      const board = seedBoard(db);
      const snapshot = getSnapshot(db, board.uid);
      expect(snapshot).toBeDefined();
      expect(snapshot!.board.uid).toBe(board.uid);
      expect(snapshot!.cards).toEqual([]);
    });
  });

  describe('updateCard — Slice 2 optimistic locking', () => {
    let board: BoardEntity;

    beforeAll(() => {
      board = seedBoard(db);
    });

    it('rejects update when version does not match and leaves card unchanged', () => {
      const firstColumn = board.schema.columns[0].uid;
      const created = createCard(db, board.uid, {
        title: 'Original Title',
        current_status: firstColumn,
      });

      const result = updateCard(db, board.uid, created.uid, {
        version: 999,
        title: 'Hacked Title',
      });

      expect(result).toBeNull();

      const untouched = getCardById(db, board.uid, created.uid);
      expect(untouched).toBeDefined();
      expect(untouched!.title).toBe('Original Title');
      expect(untouched!.version).toBe(created.version);
    });

    it('accepts update when version matches and increments version', () => {
      const firstColumn = board.schema.columns[0].uid;
      const created = createCard(db, board.uid, {
        title: 'Original Title',
        current_status: firstColumn,
      });

      const result = updateCard(db, board.uid, created.uid, {
        version: created.version,
        title: 'Updated Title',
      });

      expect(result).not.toBeNull();
      expect(result!.title).toBe('Updated Title');
      expect(result!.version).toBe(created.version + 1);
    });

    it('accepts update with version and description only', () => {
      const firstColumn = board.schema.columns[0].uid;
      const created = createCard(db, board.uid, {
        title: 'Original Title',
        current_status: firstColumn,
      });

      const result = updateCard(db, board.uid, created.uid, {
        version: created.version,
        description: 'New description',
      });

      expect(result).not.toBeNull();
      expect(result!.description).toBe('New description');
      expect(result!.version).toBe(created.version + 1);
    });

    it('returns null when card does not exist with version provided', () => {
      const result = updateCard(db, board.uid, '00000000-0000-0000-0000-000000000000', {
        version: 1,
        title: 'Ghost',
      });
      expect(result).toBeNull();
    });
  });

  describe('moveCard — Slice 2 version increment', () => {
    let board: BoardEntity;

    beforeAll(() => {
      board = seedBoard(db);
    });

    it('increments version on successful move', () => {
      const fromColumn = board.schema.columns[0].uid;
      const toColumn = board.schema.columns[1].uid;
      const created = createCard(db, board.uid, {
        title: 'Movable Card',
        current_status: fromColumn,
      });

      const moved = moveCard(db, board.uid, created.uid, toColumn);
      expect(moved.current_status).toBe(toColumn);
      expect(moved.version).toBe(created.version + 1);
    });
  });

  describe('callback token lifecycle', () => {
    let board: BoardEntity;

    beforeAll(() => {
      board = seedBoard(db);
    });

    it('creates a callback token that validates against CallbackTokenEntitySchema', () => {
      const card = createCard(db, board.uid, {
        title: 'Token Card',
        current_status: board.schema.columns[0].uid,
      });
      const token = createCallbackToken(db, {
        token: '550e8400-e29b-41d4-a716-446655440001',
        card_uid: card.uid,
        processor_id: 'manager-approval',
        hook: 'on-enter',
        idempotency_key: '550e8400-e29b-41d4-a716-446655440002',
        context: { previous_status: 'backlog' },
        expires_at: '2026-04-26T08:35:00.000Z',
      });

      expect(CallbackTokenEntitySchema.safeParse(token).success).toBe(true);
      expect(token.token).toBe('550e8400-e29b-41d4-a716-446655440001');
    });

    it('retrieves a callback token by its UUID', () => {
      const card = createCard(db, board.uid, {
        title: 'Token Card',
        current_status: board.schema.columns[0].uid,
      });
      createCallbackToken(db, {
        token: '550e8400-e29b-41d4-a716-446655440003',
        card_uid: card.uid,
        processor_id: 'manager-approval',
        hook: 'on-enter',
        idempotency_key: '550e8400-e29b-41d4-a716-446655440004',
        context: {},
        expires_at: '2026-04-26T08:35:00.000Z',
      });

      const found = getCallbackToken(db, '550e8400-e29b-41d4-a716-446655440003');
      expect(found).toBeDefined();
      expect(found!.processor_id).toBe('manager-approval');
    });

    it('returns undefined for unknown callback token', () => {
      const found = getCallbackToken(db, '00000000-0000-0000-0000-000000000000');
      expect(found).toBeUndefined();
    });

    it('deletes a callback token', () => {
      const card = createCard(db, board.uid, {
        title: 'Token Card',
        current_status: board.schema.columns[0].uid,
      });
      createCallbackToken(db, {
        token: '550e8400-e29b-41d4-a716-446655440005',
        card_uid: card.uid,
        processor_id: 'manager-approval',
        hook: 'on-enter',
        idempotency_key: '550e8400-e29b-41d4-a716-446655440006',
        context: {},
        expires_at: '2026-04-26T08:35:00.000Z',
      });

      deleteCallbackToken(db, '550e8400-e29b-41d4-a716-446655440005');
      const found = getCallbackToken(db, '550e8400-e29b-41d4-a716-446655440005');
      expect(found).toBeUndefined();
    });
  });

  describe('updateCardProcessingState', () => {
    let board: BoardEntity;

    beforeAll(() => {
      board = seedBoard(db);
    });

    it('transitions card state and updates is_editable', () => {
      const firstColumn = board.schema.columns[0].uid;
      const card = createCard(db, board.uid, {
        title: 'State Card',
        current_status: firstColumn,
      });

      const updated = updateCardProcessingState(db, board.uid, card.uid, 'IDLE', 'PROCESSING', {
        is_editable: false,
      });

      expect(updated).not.toBeNull();
      expect(updated!.processing_state).toBe('PROCESSING');
      expect(updated!.is_editable).toBe(false);
      expect(updated!.version).toBe(card.version + 1);
    });

    it('returns null when from state does not match', () => {
      const firstColumn = board.schema.columns[0].uid;
      const card = createCard(db, board.uid, {
        title: 'State Card',
        current_status: firstColumn,
      });

      const updated = updateCardProcessingState(db, board.uid, card.uid, 'PROCESSING', 'IDLE', {
        is_editable: true,
      });

      expect(updated).toBeNull();

      const untouched = getCardById(db, board.uid, card.uid);
      expect(untouched!.processing_state).toBe('IDLE');
    });

    it('rejects invalid transitions by throwing', () => {
      const firstColumn = board.schema.columns[0].uid;
      const card = createCard(db, board.uid, {
        title: 'State Card',
        current_status: firstColumn,
      });

      expect(() =>
        updateCardProcessingState(db, board.uid, card.uid, 'IDLE', 'ERROR', { is_editable: false }),
      ).toThrow();
    });

    it('applies optional payload updates alongside state change', () => {
      const firstColumn = board.schema.columns[0].uid;
      const card = createCard(db, board.uid, {
        title: 'State Card',
        current_status: firstColumn,
      });

      const updated = updateCardProcessingState(db, board.uid, card.uid, 'IDLE', 'PROCESSING', {
        is_editable: false,
        payload: { processing: true },
      });

      expect(updated!.payload).toEqual({ processing: true });
    });
  });

  describe('upsertProcessorRegistry', () => {
    it('creates a processor registry entry', () => {
      const processor = upsertProcessorRegistry(db, {
        processor_id: 'repo-test',
        name: 'Repo Test Processor',
        base_url: 'http://localhost:4001',
        health_endpoint: '/health',
        hooks: ['on-enter'],
        sla_seconds: 300,
        max_sla_seconds: 600,
        auth_type: 'none',
        hmac_secret: 'temp-secret-ignore',
      });

      expect(ProcessorRegistryEntitySchema.safeParse(processor).success).toBe(true);
      expect(processor.status).toBe('unknown');
    });
  });

  describe('appendEventLog', () => {
    it('persists a CARD_CREATED event that validates against EventLogRowSchema', () => {
      const board = seedBoard(db);
      const card = createCard(db, board.uid, {
        title: 'Audit Card',
        current_status: board.schema.columns[0].uid,
      });

      const event = appendEventLog(db, {
        card_uid: card.uid,
        board_uid: board.uid,
        actor: 'alice',
        action: 'CARD_CREATED',
        category: 'user_action',
      });

      expect(EventLogRowSchema.safeParse(event).success).toBe(true);
      expect(event.action).toBe('CARD_CREATED');
      expect(event.category).toBe('user_action');
      expect(event.actor).toBe('alice');
    });

    it('persists a CARD_MOVED event with from_column and to_column', () => {
      const board = seedBoard(db);
      const card = createCard(db, board.uid, {
        title: 'Audit Card',
        current_status: board.schema.columns[0].uid,
      });

      const event = appendEventLog(db, {
        card_uid: card.uid,
        board_uid: board.uid,
        actor: 'alice',
        action: 'CARD_MOVED',
        category: 'user_action',
        from_column: board.schema.columns[0].uid,
        to_column: board.schema.columns[1].uid,
      });

      expect(EventLogRowSchema.safeParse(event).success).toBe(true);
      expect(event.from_column).toBe(board.schema.columns[0].uid);
      expect(event.to_column).toBe(board.schema.columns[1].uid);
    });

    it('persists a lifecycle event with category lifecycle and lifecycle_event set', () => {
      const board = seedBoard(db);
      const card = createCard(db, board.uid, {
        title: 'Audit Card',
        current_status: board.schema.columns[0].uid,
      });

      const event = appendEventLog(db, {
        card_uid: card.uid,
        board_uid: board.uid,
        actor: 'system',
        action: 'PROCESSING_STARTED',
        category: 'lifecycle',
        lifecycle_event: 'PROCESSING_STARTED',
      });

      expect(EventLogRowSchema.safeParse(event).success).toBe(true);
      expect(event.category).toBe('lifecycle');
      expect(event.lifecycle_event).toBe('PROCESSING_STARTED');
    });

    it('rejects invalid events missing required action', () => {
      expect(() =>
        appendEventLog(db, {
          card_uid: 'a601f5b3-f91b-4ce0-b562-f4a11fcb45f9',
          board_uid: '550e8400-e29b-41d4-a716-446655440000',
          actor: 'alice',
          action: 'INVALID_ACTION' as any,
          category: 'user_action',
        }),
      ).toThrow();
    });
  });

  describe('queryAuditLog', () => {
    let board: BoardEntity;

    beforeAll(() => {
      board = seedBoard(db);
    });

    it('filters events by board_uid', () => {
      const otherBoard = seedBoard(db);
      const cardA = 'a601f5b3-f91b-4ce0-b562-f4a11fcb45f9';
      const cardB = 'b702f5b3-f91b-4ce0-b562-f4a11fcb45f0';

      appendEventLog(db, {
        card_uid: cardA,
        board_uid: board.uid,
        actor: 'alice',
        action: 'CARD_CREATED',
        category: 'user_action',
      });

      appendEventLog(db, {
        card_uid: cardB,
        board_uid: otherBoard.uid,
        actor: 'bob',
        action: 'CARD_CREATED',
        category: 'user_action',
      });

      const result = queryAuditLog(db, board.uid, { limit: 50 });
      expect(result.events).toHaveLength(1);
      expect(result.events[0].board_uid).toBe(board.uid);
    });

    it('supports cursor pagination', () => {
      const card = 'a601f5b3-f91b-4ce0-b562-f4a11fcb45f9';

      for (let i = 0; i < 3; i++) {
        appendEventLog(db, {
          card_uid: card,
          board_uid: board.uid,
          actor: 'alice',
          action: 'CARD_UPDATED',
          category: 'user_action',
        });
      }

      const page1 = queryAuditLog(db, board.uid, { limit: 2 });
      expect(page1.events).toHaveLength(2);
      expect(page1.next_cursor).toBeTruthy();

      const page2 = queryAuditLog(db, board.uid, { limit: 2, cursor: page1.next_cursor! });
      expect(page2.events).toHaveLength(1);
    });

    it('filters by categories', () => {
      const card = 'a601f5b3-f91b-4ce0-b562-f4a11fcb45f9';

      appendEventLog(db, {
        card_uid: card,
        board_uid: board.uid,
        actor: 'alice',
        action: 'CARD_CREATED',
        category: 'user_action',
      });

      appendEventLog(db, {
        card_uid: card,
        board_uid: board.uid,
        actor: 'system',
        action: 'PROCESSING_STARTED',
        category: 'lifecycle',
        lifecycle_event: 'PROCESSING_STARTED',
      });

      const result = queryAuditLog(db, board.uid, { limit: 50, categories: ['lifecycle'] });
      expect(result.events).toHaveLength(1);
      expect(result.events[0].category).toBe('lifecycle');
    });

    it('filters by actions', () => {
      const card = 'a601f5b3-f91b-4ce0-b562-f4a11fcb45f9';

      appendEventLog(db, {
        card_uid: card,
        board_uid: board.uid,
        actor: 'alice',
        action: 'CARD_CREATED',
        category: 'user_action',
      });

      appendEventLog(db, {
        card_uid: card,
        board_uid: board.uid,
        actor: 'alice',
        action: 'CARD_UPDATED',
        category: 'user_action',
      });

      const result = queryAuditLog(db, board.uid, { limit: 50, actions: ['CARD_CREATED'] });
      expect(result.events).toHaveLength(1);
      expect(result.events[0].action).toBe('CARD_CREATED');
    });

    it('filters by card_uid', () => {
      const cardA = 'a601f5b3-f91b-4ce0-b562-f4a11fcb45f9';
      const cardB = 'b702f5b3-f91b-4ce0-b562-f4a11fcb45f0';

      appendEventLog(db, {
        card_uid: cardA,
        board_uid: board.uid,
        actor: 'alice',
        action: 'CARD_CREATED',
        category: 'user_action',
      });

      appendEventLog(db, {
        card_uid: cardB,
        board_uid: board.uid,
        actor: 'alice',
        action: 'CARD_CREATED',
        category: 'user_action',
      });

      const result = queryAuditLog(db, board.uid, { limit: 50, card_uid: cardA });
      expect(result.events).toHaveLength(1);
      expect(result.events[0].card_uid).toBe(cardA);
    });

    it('filters by from/to timestamp range', () => {
      const card = 'a601f5b3-f91b-4ce0-b562-f4a11fcb45f9';

      appendEventLog(db, {
        card_uid: card,
        board_uid: board.uid,
        actor: 'alice',
        action: 'CARD_CREATED',
        category: 'user_action',
      });

      const result = queryAuditLog(db, board.uid, {
        limit: 50,
        from: '2025-01-01T00:00:00.000Z',
        to: '2027-01-01T00:00:00.000Z',
      });

      expect(result.events.length).toBeGreaterThanOrEqual(1);
    });

    it('returns events ordered chronologically', () => {
      const card = 'a601f5b3-f91b-4ce0-b562-f4a11fcb45f9';

      appendEventLog(db, {
        card_uid: card,
        board_uid: board.uid,
        actor: 'alice',
        action: 'CARD_CREATED',
        category: 'user_action',
      });

      appendEventLog(db, {
        card_uid: card,
        board_uid: board.uid,
        actor: 'alice',
        action: 'CARD_UPDATED',
        category: 'user_action',
      });

      const result = queryAuditLog(db, board.uid, { limit: 50 });
      expect(result.events).toHaveLength(2);
      const timestamps = result.events.map((e: EventLogRow) => new Date(e.timestamp).getTime());
      expect(timestamps[0]).toBeLessThanOrEqual(timestamps[1]);
    });
  });

  describe('atomic transaction — card mutation and audit append', () => {
    let board: BoardEntity;

    beforeAll(() => {
      board = seedBoard(db);
    });

    it('rolls back card creation when appendEventLog throws', () => {
      const firstColumn = board.schema.columns[0].uid;
      vi.mocked(appendEventLog).mockImplementation(() => {
        throw new Error('AUDIT_FAIL');
      });

      expect(() =>
        createCard(db, board.uid, {
          title: 'Rollback Card',
          current_status: firstColumn,
        }),
      ).toThrow('AUDIT_FAIL');

      const snapshot = getSnapshot(db, board.uid);
      const cardCount = snapshot?.cards.filter((c) => c.title === 'Rollback Card').length ?? 0;
      expect(cardCount).toBe(0);
    });

    it('rolls back card update when appendEventLog throws', () => {
      const firstColumn = board.schema.columns[0].uid;
      const card = createCard(db, board.uid, {
        title: 'Original Title',
        current_status: firstColumn,
      });

      vi.mocked(appendEventLog).mockImplementation(() => {
        throw new Error('AUDIT_FAIL');
      });

      expect(() =>
        updateCard(db, board.uid, card.uid, {
          version: card.version,
          title: 'Hacked Title',
        }),
      ).toThrow('AUDIT_FAIL');

      const untouched = getCardById(db, board.uid, card.uid);
      expect(untouched!.title).toBe('Original Title');
    });

    it('rolls back card move when appendEventLog throws', () => {
      const fromColumn = board.schema.columns[0].uid;
      const toColumn = board.schema.columns[1].uid;
      const card = createCard(db, board.uid, {
        title: 'Immovable Card',
        current_status: fromColumn,
      });

      vi.mocked(appendEventLog).mockImplementation(() => {
        throw new Error('AUDIT_FAIL');
      });

      expect(() => moveCard(db, board.uid, card.uid, toColumn)).toThrow('AUDIT_FAIL');

      const untouched = getCardById(db, board.uid, card.uid);
      expect(untouched!.current_status).toBe(fromColumn);
    });

    it('appends CARD_CREATED event atomically with card creation', () => {
      vi.mocked(appendEventLog).mockClear();
      const firstColumn = board.schema.columns[0].uid;
      const card = createCard(db, board.uid, {
        title: 'Atomic Card',
        current_status: firstColumn,
      });

      expect(appendEventLog).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({
          card_uid: card.uid,
          board_uid: board.uid,
          action: 'CARD_CREATED',
          category: 'user_action',
        }),
      );
    });

    it('appends CARD_UPDATED event with payload_delta on update', () => {
      vi.mocked(appendEventLog).mockClear();
      const firstColumn = board.schema.columns[0].uid;
      const card = createCard(db, board.uid, {
        title: 'Original',
        current_status: firstColumn,
      });

      updateCard(db, board.uid, card.uid, {
        version: card.version,
        title: 'Updated',
      });

      expect(appendEventLog).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({
          card_uid: card.uid,
          board_uid: board.uid,
          action: 'CARD_UPDATED',
          category: 'user_action',
          payload_delta: expect.objectContaining({ title: 'Updated' }),
        }),
      );
    });

    it('appends CARD_MOVED event with from_column and to_column on move', () => {
      vi.mocked(appendEventLog).mockClear();
      const fromColumn = board.schema.columns[0].uid;
      const toColumn = board.schema.columns[1].uid;
      const card = createCard(db, board.uid, {
        title: 'Movable',
        current_status: fromColumn,
      });

      moveCard(db, board.uid, card.uid, toColumn);

      expect(appendEventLog).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({
          card_uid: card.uid,
          board_uid: board.uid,
          action: 'CARD_MOVED',
          category: 'user_action',
          from_column: fromColumn,
          to_column: toColumn,
        }),
      );
    });
  });
});
