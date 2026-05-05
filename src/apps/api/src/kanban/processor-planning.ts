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

  return `You are a senior engineering project planner. Your job is to break a parent development task into small, highly manageable subtasks.

**Core Principles for Sizing**
- **Scope:** Each subtask must represent roughly a half-day to a full day of work for a single developer (a single, easily reviewable Pull Request). If a subtask exceeds this, you must break it down further.
- **Independence:** Each subtask must be independently implementable and testable. Minimize blocking dependencies. If two subtasks absolutely must share a foundation (e.g., a shared contract or schema), the foundational piece must be its own subtask that appears first in the sequence.

---

**Step 1: Pre-Flight Analysis**
Before generating subtasks, output exactly ONE \`<<<PRE_FLIGHT>>>\` block. This is your designated workspace to reason out loud. Do not skip this step.

Inside \`<<<PRE_FLIGHT>>>\`:
1. **Complexity:** Classify as \`Trivial\` (1 subtask), \`Standard\` (2–5), \`Complex\` (5–10), or \`Epic\` (10+). Justify in one sentence.
2. **Primary Type:** Determine if the overall work is \`implementation\`, \`infrastructure/setup\`, \`research/spike\`, \`refactor\`, or \`bugfix\`.
3. **Ambiguity Check:** If the Task Body lacks sufficient detail to produce testable subtasks, list the missing information. If ambiguity is found, immediately after closing \`<<<PRE_FLIGHT>>>\`, output \`<<<CLARIFICATION_NEEDED>>>\` followed by your questions, then output \`<<<END>>>\` and stop. Do not invent assumptions.
4. **Draft Plan & Validation:** List tentative subtask titles and verify:
   - [ ] 100% coverage of the parent Task Body scope.
   - [ ] No subtask exceeds one day of work.
   - [ ] Every subtask is independently testable without waiting for another subtask to merge.
   - [ ] Dependencies flow forward only (no cycles); foundational subtasks appear first.
   If validation fails, revise the draft plan here before proceeding to Step 2.

---

**Step 2: Generate Subtasks**
If no clarification is needed, output the finalized subtasks. For each subtask, use the following **exact** format. Do not add markdown code fences, conversational filler, or extra text between blocks.

<<<TASK>>>
<<<TITLE>>>
Subtask title
<<<TYPE>>>
implementation | infrastructure | research | refactor | bugfix
<<<BODY>>>
A detailed, self-contained description of what this subtask involves. Include specific files, modules, or interfaces to be touched. State any assumptions explicitly.
<<<DEPENDS_ON>>>
none | [exact title of another subtask in this plan]
<<<ACCEPTANCE>>>
- A specific, demonstrable, pass/fail criterion (e.g., "Unit test X passes", "Endpoint Y returns 200 with schema Z").
- A second criterion that proves integration with the existing system.
<<<INSTRUCTIONS>>>
agent_name: Specific instruction for this agent. If no specific instructions are needed for any agent, write "none".
<<<RISK>>>
Any assumption, unknown, or external dependency that could cause this subtask to resize or block. If none, write "none".
<<<END_TASK>>>

Repeat the \`<<<TASK>>>\` block for every subtask.

---

**Input Data**

Task Title: ${context.title}

Task Body:
${context.body}

${instructionsBlock}---

**Final Output Rules**
- Output ONLY the requested tags (\`<<<PRE_FLIGHT>>>\`, \`<<<CLARIFICATION_NEEDED>>>\`, \`<<<TASK>>>\`, \`<<<END>>>\`). No markdown code fences around the entire output, no bullet summaries outside the tags.
- Ensure all \`<<<DEPENDS_ON>>>\` references map flawlessly to \`<<<TITLE>>>\` values that appear earlier in the output sequence.
- End the entire output with \`<<<END>>>\`.`;
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

type PlannedTask = {
  title: string;
  type: string;
  body: string;
  depends_on: string;
  acceptance: string;
  instructions: Record<string, string>;
  risk: string;
};

type PlanningResult = {
  tasks: PlannedTask[];
  pre_flight?: string;
  clarification_needed?: string;
};

function parsePlannedTasks(text: string): PlanningResult {
  let pre_flight: string | undefined;

  // Extract PRE_FLIGHT if present
  const preFlightStart = text.indexOf('<<<PRE_FLIGHT>>>');
  if (preFlightStart !== -1) {
    const contentStart = preFlightStart + '<<<PRE_FLIGHT>>>'.length;
    const nextMarkers = ['<<<CLARIFICATION_NEEDED>>>', '<<<TASK>>>', '<<<END>>>'];
    let end = text.length;
    for (const marker of nextMarkers) {
      const pos = text.indexOf(marker, contentStart);
      if (pos !== -1 && pos < end) end = pos;
    }
    pre_flight = text.slice(contentStart, end).trim();
  }

  // Check for CLARIFICATION_NEEDED
  const clarStart = text.indexOf('<<<CLARIFICATION_NEEDED>>>');
  if (clarStart !== -1) {
    const contentStart = clarStart + '<<<CLARIFICATION_NEEDED>>>'.length;
    const end = text.indexOf('<<<END>>>', contentStart);
    const clarification_needed = text.slice(contentStart, end !== -1 ? end : text.length).trim();
    return { tasks: [], pre_flight, clarification_needed };
  }

  const tasks: PlannedTask[] = [];
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

    const title = extractMarker(block, '<<<TITLE>>>', ['<<<TYPE>>>', '<<<BODY>>>', '<<<DEPENDS_ON>>>', '<<<ACCEPTANCE>>>', '<<<INSTRUCTIONS>>>', '<<<RISK>>>', '<<<END_TASK>>>']);
    const type = extractMarker(block, '<<<TYPE>>>', ['<<<BODY>>>', '<<<DEPENDS_ON>>>', '<<<ACCEPTANCE>>>', '<<<INSTRUCTIONS>>>', '<<<RISK>>>', '<<<END_TASK>>>']);
    const body = extractMarker(block, '<<<BODY>>>', ['<<<DEPENDS_ON>>>', '<<<ACCEPTANCE>>>', '<<<INSTRUCTIONS>>>', '<<<RISK>>>', '<<<END_TASK>>>']);
    const depends_on = extractMarker(block, '<<<DEPENDS_ON>>>', ['<<<ACCEPTANCE>>>', '<<<INSTRUCTIONS>>>', '<<<RISK>>>', '<<<END_TASK>>>']);
    const acceptance = extractMarker(block, '<<<ACCEPTANCE>>>', ['<<<INSTRUCTIONS>>>', '<<<RISK>>>', '<<<END_TASK>>>']);
    const instructionsText = extractMarker(block, '<<<INSTRUCTIONS>>>', ['<<<RISK>>>', '<<<END_TASK>>>']);
    const risk = extractMarker(block, '<<<RISK>>>', ['<<<END_TASK>>>']);

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
      tasks.push({
        title: title.trim(),
        type: type.trim() || 'implementation',
        body: body.trim(),
        depends_on: depends_on.trim() || 'none',
        acceptance: acceptance.trim() || '',
        instructions,
        risk: risk.trim() || 'none',
      });
    }

    searchStart = blockEnd;
  }

  if (tasks.length === 0) {
    throw new Error('No tasks found in LLM response');
  }

  return { tasks, pre_flight };
}

/* ------------------------------------------------------------------ */
/*  LLM session                                                        */
/* ------------------------------------------------------------------ */

async function runPlanningSession(
  prompt: string,
  cwd?: string,
): Promise<PlanningResult> {
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
    let result: PlanningResult = { tasks: [] };
    try {
      const context = extractCardContext(card);
      const workspacePath =
        typeof card.payload.workspace_path === 'string' ? card.payload.workspace_path : undefined;
      result = await runPlanningSession(buildPlanningPrompt(context), workspacePath);
      console.log(`[planning] LLM planned ${result.tasks.length} subtasks for card ${card.uid}`);
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
          planned_tasks: result.tasks,
          pre_flight: result.pre_flight,
          clarification_needed: result.clarification_needed,
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
