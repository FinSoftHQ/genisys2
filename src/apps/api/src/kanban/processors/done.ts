import { definePiProcessor } from './runtime/define-processor.js';
import {
  getBoardById,
  getCardById,
  getCardFamily,
  listBoards,
  moveCard,
} from '../repository.js';
import { startProcessing } from '../processing-orchestrator.js';

function findCardByUidAcrossBoards(cardUid: string) {
  const allBoards = listBoards({});
  for (const board of allBoards) {
    const card = getCardById({}, board.uid, cardUid);
    if (card) {
      return card;
    }
  }
  return undefined;
}

async function wakeParentIfAllChildrenDone(card: {
  payload: Record<string, unknown>;
}): Promise<void> {
  const parentBoardUid =
    typeof card.payload.parent_board_uid === 'string'
      ? card.payload.parent_board_uid
      : undefined;
  const parentCardUid =
    typeof card.payload.parent_card_uid === 'string'
      ? card.payload.parent_card_uid
      : undefined;

  if (!parentBoardUid || !parentCardUid) {
    return;
  }

  const parent = getCardById({}, parentBoardUid, parentCardUid);
  if (!parent) {
    return;
  }

  const family = getCardFamily({}, parentBoardUid, parentCardUid);
  if (family.children.length === 0) {
    return;
  }

  const allDone = family.children.every((childMeta) => {
    const child = findCardByUidAcrossBoards(childMeta.uid);
    return Boolean(
      child &&
        child.current_status === 'done' &&
        child.processing_state !== 'ERROR',
    );
  });

  if (!allDone) {
    return;
  }

  const parentBoard = getBoardById({}, parentBoardUid);
  if (!parentBoard) {
    return;
  }

  const currentParent = getCardById({}, parentBoardUid, parentCardUid);
  if (!currentParent || currentParent.current_status !== 'delegated') {
    return;
  }

  const moved = moveCard(
    {},
    parentBoardUid,
    parentCardUid,
    'wrap',
    'system:task-complete',
  );
  const wrapColumn = parentBoard.schema.columns.find((c) => c.uid === 'wrap');
  if (wrapColumn?.type === 'Processing') {
    await startProcessing(
      {},
      parentBoard,
      moved,
      wrapColumn as {
        uid: string;
        title: string;
        type: 'Processing';
        processor_id: string;
        exit_logic: Record<string, string>;
        order: number;
      },
    );
  }
}

export const doneProcessorRoutes = definePiProcessor({
  id: 'done',
  onEnter: async (ctx, request) => {
    wakeParentIfAllChildrenDone(request.card).catch(() => {});
    ctx.fireAndForgetCallback(request.callback_url, { status: 'success' });
    return { status: 'accepted' };
  },
  onAction: async (ctx, request) => {
    ctx.fireAndForgetCallback(request.callback_url, { status: 'success' });
    return { status: 'accepted' };
  },
});
