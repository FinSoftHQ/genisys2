import { randomUUID } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import type { BoardEntity, CardEntity, CardFamilyMetadata } from '@repo/shared';
import { BoardEntitySchema, BoardStreamSseEventSchema, CardEntitySchema, CardFamilyMetadataSchema } from '@repo/shared';
import { resolveDb } from './db-context.js';
import { appendEventLog } from './event-log.js';
import { broadcastEvent } from './board-stream.js';
import { boards, cards, cardRelationships } from '../db/schema.js';

const rollupTimers = new Map<string, ReturnType<typeof setTimeout>>();

type CardRef = { boardUid: string; cardUid: string };

function toFamilyMetadata(card: CardEntity): CardFamilyMetadata {
  return CardFamilyMetadataSchema.parse({
    uid: card.uid,
    board_uid: card.board_uid,
    display_id: card.display_id,
    status: card.current_status,
    title: card.title,
    processing_state: card.processing_state,
  });
}

function isCompletedColumn(board: BoardEntity, statusUid: string): boolean {
  const column = board.schema.columns.find((c) => c.uid === statusUid);
  if (!column) return false;
  return /done|archive/i.test(column.uid) || /done|archive/i.test(column.title);
}

function getCardByUid(instance: unknown, boardUid: string, cardUid: string): CardEntity | undefined {
  const { db } = resolveDb(instance);
  const row = db
    .select()
    .from(cards)
    .where(and(eq(cards.board_uid, boardUid), eq(cards.uid, cardUid)))
    .get();
  if (!row) return undefined;
  const parsed = CardEntitySchema.safeParse(row);
  return parsed.success ? parsed.data : undefined;
}

function getCardAcrossBoards(instance: unknown, boardUid: string, cardUid: string): CardEntity | undefined {
  const card = getCardByUid(instance, boardUid, cardUid);
  if (card) return card;

  const { db } = resolveDb(instance);
  const row = db.select().from(cards).where(eq(cards.uid, cardUid)).get();
  if (!row) return undefined;
  const parsed = CardEntitySchema.safeParse(row);
  return parsed.success ? parsed.data : undefined;
}

function getBoard(instance: unknown, boardUid: string): BoardEntity | undefined {
  const { db } = resolveDb(instance);
  const row = db.select().from(boards).where(eq(boards.uid, boardUid)).get();
  if (!row) return undefined;
  const parsed = BoardEntitySchema.safeParse(row);
  return parsed.success ? parsed.data : undefined;
}

function resolveRelatedBoardUid(
  relation: {
    parent_board_uid?: string | null;
    child_board_uid?: string | null;
  },
  direction: 'parents' | 'children',
  fallbackBoardUid: string,
): string {
  if (direction === 'parents') {
    return relation.parent_board_uid ?? fallbackBoardUid;
  }
  return relation.child_board_uid ?? fallbackBoardUid;
}

function collectRelatedRefs(
  instance: unknown,
  boardUid: string,
  cardUid: string,
  direction: 'parents' | 'children',
): CardRef[] {
  const { db } = resolveDb(instance);
  const relationRows = db
    .select()
    .from(cardRelationships)
    .where(direction === 'parents' ? eq(cardRelationships.child_card_uid, cardUid) : eq(cardRelationships.parent_card_uid, cardUid))
    .all();

  const refs: CardRef[] = [];
  for (const relation of relationRows) {
    const relatedCardUid = direction === 'parents' ? relation.parent_card_uid : relation.child_card_uid;
    const relatedBoardUid = resolveRelatedBoardUid(relation, direction, boardUid);
    const card = getCardByUid(instance, relatedBoardUid, relatedCardUid);
    if (card) {
      refs.push({ boardUid: relatedBoardUid, cardUid: relatedCardUid });
    }
  }
  return refs;
}

function collectReachableRefs(
  instance: unknown,
  rootBoardUid: string,
  rootCardUid: string,
  direction: 'parents' | 'children',
): CardRef[] {
  const visited = new Set<string>();
  const queue: CardRef[] = [{ boardUid: rootBoardUid, cardUid: rootCardUid }];
  const results: CardRef[] = [];

  while (queue.length > 0) {
    const current = queue.shift()!;
    const neighbors = collectRelatedRefs(instance, current.boardUid, current.cardUid, direction);
    for (const neighbor of neighbors) {
      const key = `${neighbor.boardUid}:${neighbor.cardUid}`;
      if (visited.has(key)) continue;
      visited.add(key);
      results.push(neighbor);
      queue.push(neighbor);
    }
  }

  return results;
}

export function getCardFamily(instance: unknown, boardUid: string, cardUid: string): {
  parents: CardFamilyMetadata[];
  children: CardFamilyMetadata[];
} {
  const parents = collectRelatedRefs(instance, boardUid, cardUid, 'parents')
    .map((ref) => getCardByUid(instance, ref.boardUid, ref.cardUid))
    .filter(Boolean)
    .map((card) => toFamilyMetadata(card as CardEntity));

  const children = collectRelatedRefs(instance, boardUid, cardUid, 'children')
    .map((ref) => getCardByUid(instance, ref.boardUid, ref.cardUid))
    .filter(Boolean)
    .map((card) => toFamilyMetadata(card as CardEntity));

  return { parents, children };
}

export function enrichCardFamily(instance: unknown, card: CardEntity): CardEntity {
  const family = getCardFamily(instance, card.board_uid, card.uid);
  return {
    ...card,
    parents: family.parents,
    children: family.children,
  };
}

export function createCardRelationship(
  instance: unknown,
  boardUid: string,
  parentCardUid: string,
  childCardUid: string,
  relationshipType = 'dependency',
  parentBoardUid?: string | null,
  childBoardUid?: string | null,
): {
  parent_card_uid: string;
  child_card_uid: string;
  parent_board_uid: string | null;
  child_board_uid: string | null;
  relationship_type: string;
  created_at: string;
} {
  if (parentCardUid === childCardUid) {
    throw new Error('RELATIONSHIP_CYCLE');
  }

  const { db } = resolveDb(instance);
  const board = getBoard(instance, boardUid);
  if (!board) {
    throw new Error('BOARD_NOT_FOUND');
  }

  const resolvedParentBoardUid = parentBoardUid ?? boardUid;
  const resolvedChildBoardUid = childBoardUid ?? boardUid;

  const parent = getCardByUid(instance, resolvedParentBoardUid, parentCardUid);
  const child = getCardByUid(instance, resolvedChildBoardUid, childCardUid);
  if (!parent || !child) {
    throw new Error('CARD_NOT_FOUND');
  }

  const descendants = collectReachableRefs(instance, resolvedChildBoardUid, childCardUid, 'children');
  if (descendants.some((ref) => ref.boardUid === resolvedParentBoardUid && ref.cardUid === parentCardUid)) {
    throw new Error('RELATIONSHIP_CYCLE');
  }

  const existing = db
    .select()
    .from(cardRelationships)
    .where(and(eq(cardRelationships.parent_card_uid, parentCardUid), eq(cardRelationships.child_card_uid, childCardUid)))
    .get();
  if (existing) {
    return existing as {
      parent_card_uid: string;
      child_card_uid: string;
      parent_board_uid: string | null;
      child_board_uid: string | null;
      relationship_type: string;
      created_at: string;
    };
  }

  const now = new Date().toISOString();
  const relationship = {
    parent_card_uid: parentCardUid,
    child_card_uid: childCardUid,
    parent_board_uid: resolvedParentBoardUid,
    child_board_uid: resolvedChildBoardUid,
    relationship_type: relationshipType,
    created_at: now,
  };
  db.insert(cardRelationships).values(relationship).run();
  queueRollupForCard(instance, resolvedParentBoardUid, parentCardUid, 'system:relationship');
  return relationship;
}

export function deleteCardRelationship(
  instance: unknown,
  boardUid: string,
  parentCardUid: string,
  childCardUid: string,
): boolean {
  const { db } = resolveDb(instance);
  const result = db
    .delete(cardRelationships)
    .where(and(eq(cardRelationships.parent_card_uid, parentCardUid), eq(cardRelationships.child_card_uid, childCardUid)))
    .run();
  if ((result.changes ?? 0) > 0) {
    queueRollupForCard(instance, boardUid, parentCardUid, 'system:relationship');
    return true;
  }
  return false;
}

function isCompletedCard(board: BoardEntity, card: CardEntity): boolean {
  if (card.processing_state !== 'IDLE') {
    return false;
  }
  return isCompletedColumn(board, card.current_status);
}

function broadcastRollup(instance: unknown, boardUid: string, parentCardUid: string, actor: string): void {
  const board = getBoard(instance, boardUid);
  if (!board) return;

  const parentCard = getCardByUid(instance, boardUid, parentCardUid);
  if (!parentCard) return;

  const children = collectRelatedRefs(instance, boardUid, parentCardUid, 'children')
    .map((ref) => getCardByUid(instance, ref.boardUid, ref.cardUid))
    .filter(Boolean) as CardEntity[];

  const completedChildren = children.filter((card) => isCompletedCard(board, card)).length;
  const totalChildren = children.length;
  const healthScore = totalChildren === 0 ? 0 : Math.round((completedChildren / totalChildren) * 100);
  const eventId = randomUUID();
  const timestamp = new Date().toISOString();

  appendEventLog(instance, {
    event_id: eventId,
    timestamp,
    card_uid: parentCardUid,
    board_uid: boardUid,
    actor,
    action: 'ROLLUP_CHANGED',
    category: 'system',
    lifecycle_event: null,
    from_column: null,
    to_column: null,
    metadata: {
      parent_card_uid: parentCardUid,
      completed_children: completedChildren,
      total_children: totalChildren,
      health_score: healthScore,
    },
  });

  const event = BoardStreamSseEventSchema.parse({
    id: eventId,
    event: 'ROLLUP_CHANGED',
    data: {
      event_id: eventId,
      board_uid: boardUid,
      actor,
      timestamp,
      parent_card_uid: parentCardUid,
      parent_card: toFamilyMetadata(parentCard),
      completed_children: completedChildren,
      total_children: totalChildren,
      health_score: healthScore,
    },
  });
  broadcastEvent(boardUid, event);
}

function scheduleRollup(instance: unknown, boardUid: string, parentCardUid: string, actor: string): void {
  const key = `${boardUid}:${parentCardUid}`;
  const existing = rollupTimers.get(key);
  if (existing) {
    clearTimeout(existing);
  }
  const timer = setTimeout(() => {
    rollupTimers.delete(key);
    broadcastRollup(instance, boardUid, parentCardUid, actor);
  }, 500);
  rollupTimers.set(key, timer);
}

export function queueRollupForCard(instance: unknown, boardUid: string, cardUid: string, actor = 'system'): void {
  const ancestors = collectReachableRefs(instance, boardUid, cardUid, 'parents');
  for (const parentRef of ancestors) {
    scheduleRollup(instance, parentRef.boardUid, parentRef.cardUid, actor);
  }
}

export function clearRollupTimers(): void {
  for (const timer of rollupTimers.values()) {
    clearTimeout(timer);
  }
  rollupTimers.clear();
}
