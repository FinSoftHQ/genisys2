import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import {
  OnEnterDispatchRequestSchema,
  OnUpdateRequestSchema,
  OnUpdateResponseSchema,
  OnActionRequestSchema,
  OnExitRequestSchema,
  CanExitHookRequestSchema,
  CanExitHookResponseSchema,
  OnEnterDispatchAcceptedResponseSchema,
  HealthCheckResponseSchema,
} from '@repo/shared';
import { getCardById, updateCard, moveCard, getBoardById, updateCardProcessingState } from './repository.js';
import { startProcessing } from './processing-orchestrator.js';

function errorResponse(code: string, message: string, details?: Record<string, unknown>) {
  return { error: { code, message, ...(details ? { details } : {}) } };
}

function fireAndForgetCallback(callbackUrl: string, payload: Record<string, unknown>) {
  fetch(callbackUrl, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: 'Bearer processor',
    },
    body: JSON.stringify(payload),
  }).catch(() => {
    // Fire-and-forget: failures are silently ignored.
  });
}

function getApiBaseUrl(): string {
  return (process.env.API_BASE_URL ?? `http://127.0.0.1:${String(process.env.PORT || 8080)}`).replace(/\/$/, '');
}

function getAgentRoomsUrl(): string {
  return `${getApiBaseUrl()}/api/v1/agent-rooms`;
}

function getRoomClosedCallbackUrl(): string {
  return `${getApiBaseUrl()}/api/kanban-processor/agentic-team/_internal/room-closed`;
}

// In-memory registry: roomId -> { cardUid, boardUid }
const agenticTeamRoomRegistry = new Map<string, { cardUid: string; boardUid: string }>();

function serializeYamlValue(value: unknown, indent = ''): string {
  if (value === null || value === undefined) {
    return '';
  }
  if (typeof value === 'string') {
    // Use quoted string if it contains special YAML characters
    if (value.includes('\n') || value.includes(':') || value.startsWith(' ') || value.startsWith('-') || value.startsWith('[') || value.startsWith('{') || value === '' || value === 'true' || value === 'false' || value === 'null' || /^\d+$/.test(value)) {
      const lines = value.split('\n');
      if (lines.length === 1) {
        return `"${value.replace(/"/g, '\\"')}"`;
      }
      return `|\n${lines.map((l) => `${indent}  ${l}`).join('\n')}`;
    }
    return value;
  }
  if (typeof value === 'number' || typeof value === 'boolean') {
    return String(value);
  }
  if (Array.isArray(value)) {
    if (value.length === 0) return '[]';
    return '\n' + value.map((v) => `${indent}  - ${serializeYamlValue(v, indent + '  ')}`).join('\n');
  }
  if (typeof value === 'object') {
    const entries = Object.entries(value);
    if (entries.length === 0) return '{}';
    return '\n' + entries.map(([k, v]) => {
      const serialized = serializeYamlValue(v, indent + '  ');
      if (serialized.startsWith('\n')) {
        return `${indent}  ${k}:${serialized}`;
      }
      return `${indent}  ${k}: ${serialized}`;
    }).join('\n');
  }
  return String(value);
}

function composeMarkdownFromPayload(card: {
  display_id: string;
  title: string;
  payload: Record<string, unknown>;
}): string {
  const p = card.payload;
  const frontMatterLines: string[] = [];

  const team = p.team;
  if (team && typeof team === 'object' && !Array.isArray(team) && Object.keys(team).length > 0) {
    frontMatterLines.push(`team:${serializeYamlValue(team)}`);
  }

  const routes = p.routes;
  if (routes && typeof routes === 'object' && !Array.isArray(routes) && Object.keys(routes).length > 0) {
    frontMatterLines.push(`routes:${serializeYamlValue(routes)}`);
  }

  if (typeof p.facilitator === 'string' && p.facilitator.trim()) {
    frontMatterLines.push(`facilitator: ${serializeYamlValue(p.facilitator.trim())}`);
  }

  if (typeof p.tailor_shop === 'string' && p.tailor_shop.trim()) {
    frontMatterLines.push(`tailor_shop: ${serializeYamlValue(p.tailor_shop.trim())}`);
  }

  // Explicit mapping: workspace_path -> working_dir
  const workingDir = typeof p.working_dir === 'string' && p.working_dir.trim()
    ? p.working_dir.trim()
    : typeof p.workspace_path === 'string' && p.workspace_path.trim()
      ? p.workspace_path.trim()
      : undefined;
  if (workingDir) {
    frontMatterLines.push(`working_dir: ${serializeYamlValue(workingDir)}`);
  }

  const instructions = p.instructions;
  if (instructions && typeof instructions === 'object' && !Array.isArray(instructions) && Object.keys(instructions).length > 0) {
    frontMatterLines.push(`instructions:${serializeYamlValue(instructions)}`);
  }

  const bodyText = typeof p.body === 'string' ? p.body : '';
  const metadataBlock = `Card: ${card.display_id} / ${card.title}`;

  return `---\n${frontMatterLines.join('\n')}\n---\n\n${metadataBlock}\n\n${bodyText}`;
}

async function createAgentRoom(
  markdown: string,
  callbackUrl: string,
): Promise<{ roomId: string } | { error: string }> {
  try {
    const response = await fetch(getAgentRoomsUrl(), {
      method: 'POST',
      headers: {
        'Content-Type': 'text/markdown',
        'x-room-callback-url': callbackUrl,
      },
      body: markdown,
    });

    if (!response.ok) {
      const bodyText = await response.text().catch(() => '');
      return { error: `Agent room creation failed: ${response.status} ${response.statusText}${bodyText ? ` - ${bodyText}` : ''}` };
    }

    const body = (await response.json()) as { roomId?: string };
    if (!body.roomId) {
      return { error: 'Agent room creation failed: missing roomId in response' };
    }

    return { roomId: body.roomId };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { error: `Agent room creation failed: ${message}` };
  }
}

async function runWipWorkflow(
  card: {
    uid: string;
    board_uid: string;
    display_id: string;
    title: string;
    payload: Record<string, unknown>;
  },
  callbackUrl: string,
) {
  const markdown = composeMarkdownFromPayload(card);
  console.log('[agentic-team] Composed markdown for card', card.display_id);
  console.log(markdown);

  const roomClosedCallbackUrl = getRoomClosedCallbackUrl();
  const result = await createAgentRoom(markdown, roomClosedCallbackUrl);

  if ('error' in result) {
    console.error('[agentic-team] Card', card.display_id, result.error);
    fireAndForgetCallback(callbackUrl, {
      status: 'error',
      error_message: result.error,
    });
    return;
  }

  const roomId = result.roomId;
  agenticTeamRoomRegistry.set(roomId, { cardUid: card.uid, boardUid: card.board_uid });
  console.log('[agentic-team] Card', card.display_id, 'created agent room:', roomId);

  // Update card payload with room_id directly, without transitioning state.
  // The card must stay in PROCESSING until the room actually closes.
  updateCard(
    {},
    card.board_uid,
    card.uid,
    { payload: { ...card.payload, room_id: roomId } },
    'system:agentic-team',
  );
}

const RoomClosedCallbackSchema = z.object({
  type: z.literal('room_closed'),
  roomId: z.string().min(1),
  reason: z.enum(['completed', 'manual', 'expired']),
  at: z.string().min(1),
});

export async function agenticTeamProcessorRoutes(instance: FastifyInstance): Promise<void> {
  instance.get('/health', async (_request, reply) => {
    const response = HealthCheckResponseSchema.parse({ status: 'healthy' });
    return reply.status(200).send(response);
  });

  instance.post('/can-exit', async (request, reply) => {
    const body = CanExitHookRequestSchema.safeParse(request.body);
    if (!body.success) {
      return reply.status(400).send(errorResponse('VALIDATION_ERROR', 'Invalid request body', { issues: body.error.issues }));
    }

    const response = CanExitHookResponseSchema.parse({ allowed: true });
    return reply.status(200).send(response);
  });

  instance.post('/on-update', async (request, reply) => {
    const body = OnUpdateRequestSchema.safeParse(request.body);
    if (!body.success) {
      return reply.status(400).send(errorResponse('VALIDATION_ERROR', 'Invalid request body', { issues: body.error.issues }));
    }

    const response = OnUpdateResponseSchema.parse({ allowed: true });
    return reply.status(200).send(response);
  });

  instance.post('/on-enter', async (request, reply) => {
    const body = OnEnterDispatchRequestSchema.safeParse(request.body);
    if (!body.success) {
      return reply.status(400).send(errorResponse('VALIDATION_ERROR', 'Invalid request body', { issues: body.error.issues }));
    }

    const response = OnEnterDispatchAcceptedResponseSchema.parse({ status: 'accepted' });

    const card = body.data.card;
    console.log('[agentic-team] Card', card.display_id, 'payload:', JSON.stringify(card.payload, null, 2));

    // Fire-and-forget: create agent room in background
    runWipWorkflow(card, body.data.callback_url);

    return reply.status(202).send(response);
  });

  instance.post('/on-action', async (request, reply) => {
    const body = OnActionRequestSchema.safeParse(request.body);
    if (!body.success) {
      return reply.status(400).send(errorResponse('VALIDATION_ERROR', 'Invalid request body', { issues: body.error.issues }));
    }

    const response = OnEnterDispatchAcceptedResponseSchema.parse({ status: 'accepted' });

    fireAndForgetCallback(body.data.callback_url, { status: 'success' });

    return reply.status(202).send(response);
  });

  instance.post('/on-exit', async (request, reply) => {
    const body = OnExitRequestSchema.safeParse(request.body);
    if (!body.success) {
      return reply.status(400).send(errorResponse('VALIDATION_ERROR', 'Invalid request body', { issues: body.error.issues }));
    }

    return reply.status(200).send({ status: 'acknowledged' });
  });

  instance.post('/_internal/room-closed', async (request, reply) => {
    const body = RoomClosedCallbackSchema.safeParse(request.body);
    if (!body.success) {
      return reply.status(400).send(errorResponse('VALIDATION_ERROR', 'Invalid request body', { issues: body.error.issues }));
    }

    const { roomId, reason, at } = body.data;
    const record = agenticTeamRoomRegistry.get(roomId);

    if (!record) {
      console.warn('[agentic-team] Room closed callback for unknown room:', roomId);
      return reply.status(200).send({ status: 'acknowledged' });
    }

    try {
      const currentCard = getCardById({}, record.boardUid, record.cardUid);
      if (!currentCard) {
        console.warn('[agentic-team] Card not found for room:', roomId, 'card:', record.cardUid);
        return reply.status(200).send({ status: 'acknowledged' });
      }

      const updatedPayload = {
        ...currentCard.payload,
        room_status: 'completed',
        room_closed_at: at,
        room_close_reason: reason,
      };

      const result = updateCard(
        {},
        record.boardUid,
        record.cardUid,
        { version: currentCard.version, payload: updatedPayload },
        'system:room-closed',
      );

      if (result) {
        console.log('[agentic-team] Room', roomId, 'closed (', reason, ') for card', record.cardUid);

        try {
          // 1. Transition from PROCESSING → IDLE to complete agentic-team work
          const idleCard = updateCardProcessingState(
            {},
            record.boardUid,
            record.cardUid,
            'PROCESSING',
            'IDLE',
            { is_editable: true },
          );
          if (!idleCard) {
            console.warn('[agentic-team] Failed to transition card to IDLE for room:', roomId);
            return reply.status(200).send({ status: 'acknowledged' });
          }

          const board = getBoardById({}, record.boardUid);
          if (board) {
            const currentColumn = board.schema.columns.find((c) => c.uid === idleCard.current_status);
            const nextColumnUid = currentColumn?.exit_logic?.default;
            if (nextColumnUid) {
              const movedCard = moveCard(
                {},
                record.boardUid,
                record.cardUid,
                nextColumnUid,
                'system:room-closed',
              );

              const nextColumn = board.schema.columns.find((c) => c.uid === nextColumnUid);
              if (nextColumn && nextColumn.type === 'Processing') {
                await startProcessing({}, board, movedCard, nextColumn as {
                  uid: string;
                  title: string;
                  type: 'Processing';
                  processor_id: string;
                  exit_logic: Record<string, string>;
                  order: number;
                });
              }
            }
          }
        } catch (moveErr) {
          const moveMessage = moveErr instanceof Error ? moveErr.message : String(moveErr);
          console.warn('[agentic-team] Failed to move card after room close:', moveMessage);
        }
      } else {
        console.warn('[agentic-team] Failed to update card for room:', roomId);
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.warn('[agentic-team] Error handling room closed callback:', message);
    }

    return reply.status(200).send({ status: 'acknowledged' });
  });
}
