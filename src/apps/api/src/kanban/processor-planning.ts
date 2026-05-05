import type { FastifyInstance } from 'fastify';
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
  parseProtocolFromString,
} from '@repo/shared';
import { createAgentSession, SessionManager } from '@mariozechner/pi-coding-agent';
import { getModel } from '@mariozechner/pi-ai';
import type { AgentSessionEvent } from '@mariozechner/pi-coding-agent';
import { createCard, createCardRelationship, getBoardById, listBoards } from './repository.js';

const PLANNING_TIMEOUT_MS = 120_000;

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
  }).catch((err) => {
    console.error('[planning] Callback failed:', err instanceof Error ? err.message : String(err));
  });
}

/* ------------------------------------------------------------------ */
/*  Context extraction                                                 */
/* ------------------------------------------------------------------ */

function extractCardContext(card: {
  title: string;
  description: string | null;
  payload: Record<string, unknown>;
}): {
  title: string;
  body: string;
  instructions: Record<string, string>;
} {
  let body = '';
  let instructions: Record<string, string> = {};

  if (card.description && card.description.startsWith('---')) {
    try {
      const parsed = parseProtocolFromString(card.description, { requireTeam: false });
      body = parsed.body ?? '';
      instructions = parsed.instructions ?? {};
    } catch {
      body = card.description ?? '';
    }
  } else {
    body = card.description ?? '';
  }

  // Merge instructions already present in payload (e.g. set by prep processor)
  const payloadInstructions = card.payload.instructions;
  if (
    payloadInstructions &&
    typeof payloadInstructions === 'object' &&
    !Array.isArray(payloadInstructions)
  ) {
    instructions = { ...instructions, ...(payloadInstructions as Record<string, string>) };
  }

  return { title: card.title, body, instructions };
}

/* ------------------------------------------------------------------ */
/*  Prompt builder                                                     */
/* ------------------------------------------------------------------ */

function buildPlanningPrompt(context: {
  title: string;
  body: string;
  instructions: Record<string, string>;
}): string {
  const instructionsEntries = Object.entries(context.instructions);
  const instructionsBlock =
    instructionsEntries.length > 0
      ? 'Global Instructions:\n' +
        instructionsEntries.map(([name, value]) => `  ${name}: ${value}`).join('\n') +
        '\n\n'
      : '';

  return `You are a senior engineering project planner. Your job is to break a development task into small, manageable subtasks (2–5 tasks). Each subtask must be independently implementable and testable.

Task Title: ${context.title}

Task Body:
${context.body}

${instructionsBlock}Output ONLY subtasks using the following exact format. Do not add any preamble, explanation, or extra text.

<<<TASK>>>
<<<TITLE>>>
Subtask title
<<<BODY>>>
Subtask body — a detailed, self-contained description of what this subtask involves.
<<<INSTRUCTIONS>>>
agent_name: Specific instruction for this agent
another_agent: Another specific instruction
<<<END_TASK>>>
<<<TASK>>>
<<<TITLE>>>
Another subtask title
<<<BODY>>>
Another subtask body
<<<INSTRUCTIONS>>>
agent_name: Instruction
<<<END_TASK>>>
<<<END>>>`;
}

/* ------------------------------------------------------------------ */
/*  Delimiter parser                                                   */
/* ------------------------------------------------------------------ */

function extractMarker(text: string, marker: string, nextMarkers: string[]): string {
  const start = text.indexOf(marker);
  if (start === -1) return '';

  const contentStart = start + marker.length;
  let end = text.length;

  for (const next of nextMarkers) {
    const pos = text.indexOf(next, contentStart);
    if (pos !== -1 && pos < end) {
      end = pos;
    }
  }

  return text.slice(contentStart, end).trim();
}

function parsePlannedTasks(text: string): Array<{ title: string; body: string; instructions: Record<string, string> }> {
  const tasks: Array<{ title: string; body: string; instructions: Record<string, string> }> = [];
  const taskMarker = '<<<TASK>>>';
  const endMarker = '<<<END>>>';

  let searchStart = 0;
  while (true) {
    const taskStart = text.indexOf(taskMarker, searchStart);
    if (taskStart === -1) break;

    const blockStart = taskStart + taskMarker.length;
    let blockEnd = text.indexOf(taskMarker, blockStart);
    if (blockEnd === -1) {
      blockEnd = text.indexOf(endMarker, blockStart);
    }
    if (blockEnd === -1) {
      blockEnd = text.length;
    }

    const block = text.slice(blockStart, blockEnd);

    const title = extractMarker(block, '<<<TITLE>>>', ['<<<BODY>>>', '<<<INSTRUCTIONS>>>', '<<<END_TASK>>>']);
    const body = extractMarker(block, '<<<BODY>>>', ['<<<INSTRUCTIONS>>>', '<<<END_TASK>>>']);
    const instructionsText = extractMarker(block, '<<<INSTRUCTIONS>>>', ['<<<END_TASK>>>']);

    const instructions: Record<string, string> = {};
    if (instructionsText) {
      for (const line of instructionsText.split('\n')) {
        const trimmed = line.trim();
        const colonIdx = trimmed.indexOf(':');
        if (colonIdx !== -1) {
          const name = trimmed.slice(0, colonIdx).trim();
          const value = trimmed.slice(colonIdx + 1).trim();
          if (name && value) {
            instructions[name] = value;
          }
        }
      }
    }

    if (title && body) {
      tasks.push({ title: title.trim(), body: body.trim(), instructions });
    }

    searchStart = blockEnd;
  }

  if (tasks.length === 0) {
    throw new Error('No tasks found in LLM response');
  }

  return tasks;
}

/* ------------------------------------------------------------------ */
/*  LLM session                                                        */
/* ------------------------------------------------------------------ */

async function runPlanningSession(
  prompt: string,
  cwd?: string,
): Promise<Array<{ title: string; body: string; instructions: Record<string, string> }>> {
  const preferredModel = getModel('github-copilot', 'gpt-5-mini');

  console.log('[planning] Starting AI planning session');

  const { session } = await createAgentSession({
    cwd: cwd || process.cwd(),
    sessionManager: SessionManager.inMemory(cwd || process.cwd()),
    ...(preferredModel ? { model: preferredModel } : {}),
  });

  let agentError: Error | undefined;

  const unsubscribe = session.subscribe((event: AgentSessionEvent) => {
    if (event.type === 'auto_retry_end' && !event.success) {
      agentError = new Error(`Agent retry failed: ${event.finalError ?? 'unknown error'}`);
    }
  });

  try {
    await session.prompt(prompt);

    const start = Date.now();
    const maxWait = PLANNING_TIMEOUT_MS;

    while (session.isStreaming && !agentError) {
      if (Date.now() - start > maxWait) {
        await session.abort();
        throw new Error('LLM planning timed out');
      }
      await new Promise((r) => setTimeout(r, 200));
    }

    if (agentError) {
      throw agentError;
    }

    const lastText = session.getLastAssistantText();
    if (!lastText) {
      throw new Error('Agent produced no assistant text');
    }

    console.log('[planning] Raw LLM output:\n', lastText);

    return parsePlannedTasks(lastText);
  } finally {
    unsubscribe();
    session.dispose();
  }
}

/* ------------------------------------------------------------------ */
/*  Main planning handler                                              */
/* ------------------------------------------------------------------ */

async function delegatePlanning(
  card: {
    uid: string;
    board_uid: string;
    title: string;
    description: string | null;
    payload: Record<string, unknown>;
  },
  callbackUrl: string,
): Promise<void> {
  try {
    const sourceBoard = getBoardById({}, card.board_uid);
    if (!sourceBoard?.suite_uid) {
      fireAndForgetCallback(callbackUrl, {
        status: 'success',
        move_to_column: 'agentic-team',
      });
      return;
    }

    const taskBoard = listBoards({}).find((b) => b.suite_uid === sourceBoard.suite_uid && b.role === 'tasks');
    if (!taskBoard) {
      fireAndForgetCallback(callbackUrl, {
        status: 'success',
        move_to_column: 'agentic-team',
      });
      return;
    }

    // Attempt LLM-based subtask planning
    let tasks: Array<{ title: string; body: string; instructions: Record<string, string> }> = [];
    try {
      const context = extractCardContext(card);
      const workspacePath =
        typeof card.payload.workspace_path === 'string' ? card.payload.workspace_path : undefined;
      tasks = await runPlanningSession(buildPlanningPrompt(context), workspacePath);
      console.log(`[planning] LLM planned ${tasks.length} subtasks for card ${card.uid}`);
    } catch (llmErr) {
      const message = llmErr instanceof Error ? llmErr.message : String(llmErr);
      console.error(`[planning] LLM planning failed, continuing with clone: ${message}`);
    }

    // Create a single clone child card on the task board (1:1 with parent)
    const clonedPayload = {
      ...card.payload,
      parent_board_uid: card.board_uid,
      parent_card_uid: card.uid,
    };

    const taskCard = createCard(
      {},
      taskBoard.uid,
      {
        title: card.title,
        description: card.description,
        current_status: 'todo',
        payload: clonedPayload,
      },
      'system:planning',
    );

    createCardRelationship(
      {},
      card.board_uid,
      card.uid,
      taskCard.uid,
      'dependency',
      card.board_uid,
      taskBoard.uid,
    );

    console.log(`[planning] Created clone task card ${taskCard.display_id} / ${taskCard.title}`);

    fireAndForgetCallback(callbackUrl, {
      status: 'success',
      move_to_column: 'delegated',
      payload_updates: {
        payload: {
          ...card.payload,
          delegated: true,
          task_card_uid: taskCard.uid,
          task_board_uid: taskBoard.uid,
          planned_tasks: tasks,
        },
      },
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[planning] Planning failed: ${message}`);
    fireAndForgetCallback(callbackUrl, {
      status: 'error',
      error_message: `Planning failed: ${message}`.slice(0, 500),
    });
  }
}

export async function planningProcessorRoutes(instance: FastifyInstance): Promise<void> {
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
    delegatePlanning(body.data.card, body.data.callback_url).catch((err) => {
      console.error('[planning] Unhandled error in delegatePlanning:', err instanceof Error ? err.message : String(err));
    });
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
}
