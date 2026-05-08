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
  PlanningV1Schema,
} from '@repo/shared';
import type { PlanningV1 } from '@repo/shared';
import { complete } from '@mariozechner/pi-ai';
import { getModel } from '@mariozechner/pi-ai';
import { getApiKey } from '../lib/ai-auth.js';
import { createCard, createCardRelationship, getBoardById, listBoards } from './repository.js';

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

function formatInstructionsEntry(name: string, value: string): string {
  if (value.includes('\n')) {
    const lines = value.split('\n');
    return `  ${name}: |\n${lines.map((l) => `    ${l}`).join('\n')}`;
  }
  return `  ${name}: ${value}`;
}

function buildPlanningPrompt(context: {
  title: string;
  body: string;
  instructions: Record<string, string>;
}): string {
  const instructionsEntries = Object.entries(context.instructions);
  const instructionsBlock =
    instructionsEntries.length > 0
      ? 'Global Instructions:\n' +
        instructionsEntries.map(([name, value]) => formatInstructionsEntry(name, value)).join('\n') +
        '\n\n'
      : '';

  return `You are a senior engineering project planner. Your job is to break a parent development task into small, highly manageable subtasks.

**Core Principles for Sizing**
- **Scope:** Each subtask must represent roughly a half-day to a full day of work for a single developer (a single, easily reviewable Pull Request). If a subtask exceeds this, you must break it down further.
- **Independence:** Each subtask must be independently implementable and testable. Minimize blocking dependencies. If two subtasks absolutely must share a foundation (e.g., a shared contract or schema), the foundational piece must be its own subtask that appears first in the sequence.

---

**Output Format**
Return ONLY a single JSON object conforming to the \`planning.v1\` schema shown below. Do not wrap the JSON in markdown code fences, and do not add conversational filler before or after it.

\`\`\`json
{
  "version": "planning.v1",
  "pre_flight": {
    "complexity_level": "trivial|standard|complex|epic",
    "justification": "One-sentence rationale.",
    "primary_type": "implementation|infrastructure|research|refactor|bugfix",
    "ambiguity_status": "none|needs_clarification",
    "missing_info": ["string"],
    "validation": {
      "coverage_complete": true,
      "fits_one_day": true,
      "independently_testable": true,
      "forward_dependencies_only": true,
      "notes": ["string"]
    }
  },
  "clarification_needed": {
    "required": false,
    "questions": ["string"]
  },
  "tasks": [
    {
      "id": "T1",
      "title": "Subtask title",
      "type": "implementation|infrastructure|research|refactor|bugfix",
      "body": ["Paragraph chunk 1", "Paragraph chunk 2"],
      "depends_on": ["T0"],
      "acceptance": ["Pass/fail criterion 1", "Pass/fail criterion 2"],
      "instructions": {
        "agent_name": "none|string",
        "notes": ["string"]
      },
      "risk": ["string"]
    }
  ]
}
\`\`\`

**Field guidance**
- \`body\`: Use paragraph chunks (not one array entry per physical line).
- \`acceptance\`: Each item must be pass/fail and testable.
- \`depends_on\`: Array of task IDs (e.g. \`["T1"]\`). Never depend on title text. Use \`[]\` for no dependencies.
- If \`clarification_needed.required\` is \`true\`, \`tasks\` MUST be an empty array \`[]\`.

---

**Input Data**

Task Title: ${context.title}

Task Body:
${context.body}

${instructionsBlock}---

**Final Output Rules**
- Output ONLY valid JSON conforming to \`planning.v1\`. No markdown code fences around the entire output, no bullet summaries outside the JSON.
- Ensure all \`depends_on\` references use task \`id\` values that appear earlier in the \`tasks\` array.
- End the entire output with the closing brace of the JSON object.`;
}

/* ------------------------------------------------------------------ */
/*  JSON parser & validator                                            */
/* ------------------------------------------------------------------ */

type ParsePlanningResult =
  | { success: true; data: PlanningV1 }
  | { success: false; errors: string[]; raw: string };

function extractJsonFromText(text: string): string {
  // Tolerate markdown fences: find first '{' and last '}'
  const firstBrace = text.indexOf('{');
  const lastBrace = text.lastIndexOf('}');
  if (firstBrace === -1 || lastBrace === -1 || lastBrace < firstBrace) {
    return text.trim();
  }
  return text.slice(firstBrace, lastBrace + 1);
}

function hasDependencyCycle(tasks: PlanningV1['tasks']): boolean {
  const idSet = new Set(tasks.map((t) => t.id));
  const visited = new Set<string>();
  const recStack = new Set<string>();

  function dfs(id: string): boolean {
    visited.add(id);
    recStack.add(id);
    const task = tasks.find((t) => t.id === id);
    if (task) {
      for (const dep of task.depends_on) {
        if (!idSet.has(dep)) continue;
        if (!visited.has(dep)) {
          if (dfs(dep)) return true;
        } else if (recStack.has(dep)) {
          return true;
        }
      }
    }
    recStack.delete(id);
    return false;
  }

  for (const task of tasks) {
    if (!visited.has(task.id)) {
      if (dfs(task.id)) return true;
    }
  }
  return false;
}

function parsePlanningV1(rawText: string): ParsePlanningResult {
  const jsonText = extractJsonFromText(rawText);
  let parsed: unknown;
  try {
    parsed = JSON.parse(jsonText);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { success: false, errors: [`JSON parse error: ${message}`], raw: rawText };
  }

  const zodResult = PlanningV1Schema.safeParse(parsed);
  if (!zodResult.success) {
    const issues = zodResult.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`);
    return { success: false, errors: [`Schema validation failed: ${issues.join('; ')}`], raw: rawText };
  }

  const data = zodResult.data;
  const semanticErrors: string[] = [];

  // Semantic checks
  if (!data.clarification_needed.required && data.tasks.length === 0) {
    semanticErrors.push('tasks must be non-empty when clarification_needed.required is false');
  }

  const idSet = new Set(data.tasks.map((t) => t.id));

  for (const task of data.tasks) {
    for (const dep of task.depends_on) {
      if (!idSet.has(dep)) {
        semanticErrors.push(`Task ${task.id} depends_on unknown task id: ${dep}`);
      }
    }
    if (task.depends_on.includes(task.id)) {
      semanticErrors.push(`Task ${task.id} has self-dependency`);
    }
  }

  if (hasDependencyCycle(data.tasks)) {
    semanticErrors.push('Dependency cycle detected among tasks');
  }

  if (semanticErrors.length > 0) {
    return { success: false, errors: semanticErrors, raw: rawText };
  }

  return { success: true, data };
}

/* ------------------------------------------------------------------ */
/*  LLM session with repair                                            */
/* ------------------------------------------------------------------ */

async function runPlanningSession(prompt: string): Promise<ParsePlanningResult> {
  const preferredModel = getModel('opencode-go', 'deepseek-v4-pro');

  console.log('[planning] Starting AI planning completion');

  const apiKey = await getApiKey(preferredModel.provider);

  const response = await complete(
    preferredModel,
    {
      messages: [
        {
          role: 'user',
          content: prompt,
          timestamp: Date.now(),
        },
      ],
    },
    { apiKey }
  );

  if (response.stopReason === 'error') {
    throw new Error(response.errorMessage || 'LLM provider error');
  }

  const textContent = response.content
    .filter((c) => c.type === 'text')
    .map((c) => (c as { text: string }).text)
    .join('');

  if (!textContent.trim()) {
    throw new Error('LLM returned empty text');
  }

  console.log('[planning] Raw LLM output:\n', textContent);

  return parsePlanningV1(textContent);
}

async function runPlanningSessionWithRepair(prompt: string): Promise<ParsePlanningResult> {
  const firstResult = await runPlanningSession(prompt);
  if (firstResult.success) {
    return firstResult;
  }

  console.log('[planning] First parse/validation failed, attempting repair pass');

  const repairPrompt = `The previous planning output was invalid. Here is the raw output:

---
${firstResult.raw}
---

Here are the errors:
${firstResult.errors.map((e) => `- ${e}`).join('\n')}

Please return ONLY a valid \`planning.v1\` JSON object that fixes these issues. Do not include markdown code fences or any extra text.`;

  const repairResult = await runPlanningSession(repairPrompt);
  if (repairResult.success) {
    console.log('[planning] Repair pass succeeded');
    return repairResult;
  }

  console.log('[planning] Repair pass also failed');
  return {
    success: false,
    errors: [...firstResult.errors, `Repair pass failed: ${repairResult.errors.join('; ')}`],
    raw: firstResult.raw,
  };
}

/* ------------------------------------------------------------------ */
/*  Markdown summary generator                                         */
/* ------------------------------------------------------------------ */

function generatePlanningSummary(data: PlanningV1): string {
  const lines: string[] = [];
  lines.push('# Planning Summary');
  lines.push('');

  const pf = data.pre_flight;
  lines.push(`**Complexity:** ${pf.complexity_level}`);
  lines.push(`**Justification:** ${pf.justification}`);
  lines.push(`**Primary Type:** ${pf.primary_type}`);
  lines.push(`**Ambiguity:** ${pf.ambiguity_status}`);
  if (pf.missing_info.length > 0) {
    lines.push(`**Missing Info:** ${pf.missing_info.join(', ')}`);
  }
  lines.push('');
  lines.push('**Validation:**');
  lines.push(`- Coverage complete: ${pf.validation.coverage_complete ? 'Yes' : 'No'}`);
  lines.push(`- Fits one day: ${pf.validation.fits_one_day ? 'Yes' : 'No'}`);
  lines.push(`- Independently testable: ${pf.validation.independently_testable ? 'Yes' : 'No'}`);
  lines.push(`- Forward dependencies only: ${pf.validation.forward_dependencies_only ? 'Yes' : 'No'}`);
  if (pf.validation.notes.length > 0) {
    lines.push(`- Notes: ${pf.validation.notes.join('; ')}`);
  }
  lines.push('');

  if (data.clarification_needed.required) {
    lines.push('**Clarification Needed:**');
    for (const q of data.clarification_needed.questions) {
      lines.push(`- ${q}`);
    }
    lines.push('');
  }

  if (data.tasks.length > 0) {
    lines.push('**Tasks:**');
    for (const task of data.tasks) {
      lines.push('');
      lines.push(`### ${task.id}: ${task.title}`);
      lines.push(`**Type:** ${task.type}`);
      if (task.depends_on.length > 0) {
        lines.push(`**Depends on:** ${task.depends_on.join(', ')}`);
      }
      lines.push('');
      lines.push('**Body:**');
      for (const paragraph of task.body) {
        lines.push(paragraph);
        lines.push('');
      }
      lines.push('**Acceptance:**');
      for (const acc of task.acceptance) {
        lines.push(`- ${acc}`);
      }
      if (task.instructions.agent_name || task.instructions.notes.length > 0) {
        lines.push('');
        lines.push('**Instructions:**');
        if (task.instructions.agent_name) {
          lines.push(`- Agent: ${task.instructions.agent_name}`);
        }
        for (const note of task.instructions.notes) {
          lines.push(`- ${note}`);
        }
      }
      if (task.risk.length > 0) {
        lines.push('');
        lines.push('**Risk:**');
        for (const r of task.risk) {
          lines.push(`- ${r}`);
        }
      }
    }
  }

  return lines.join('\n');
}

/* ------------------------------------------------------------------ */
/*  Description append helper                                          */
/* ------------------------------------------------------------------ */

function appendSummaryToDescription(original: string | null, summary: string): string {
  const base = original ?? '';
  // If there's a protocol front-matter block, append after it
  if (base.startsWith('---')) {
    const endIdx = base.indexOf('\n---', 3);
    if (endIdx !== -1) {
      const frontMatterEnd = endIdx + 4; // include the '\n---'
      return base.slice(0, frontMatterEnd) + '\n\n---\n\n' + summary + base.slice(frontMatterEnd);
    }
  }
  if (base.trim().length === 0) {
    return summary;
  }
  return base + '\n\n---\n\n' + summary;
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

    // Attempt LLM-based subtask planning with repair
    let result: ParsePlanningResult = { success: false, errors: ['Not attempted'], raw: '' };
    try {
      const context = extractCardContext(card);
      result = await runPlanningSessionWithRepair(buildPlanningPrompt(context));
    } catch (llmErr) {
      const message = llmErr instanceof Error ? llmErr.message : String(llmErr);
      console.error(`[planning] LLM planning failed, continuing with clone: ${message}`);
      result = { success: false, errors: [`LLM error: ${message}`], raw: '' };
    }

    if (result.success) {
      const data = result.data;

      if (data.clarification_needed.required) {
        // Clarification needed: do not create child cards
        fireAndForgetCallback(callbackUrl, {
          status: 'success',
          move_to_column: 'delegated',
          payload_updates: {
            payload: {
              ...card.payload,
              delegated: true,
              task_card_uids: [],
              task_board_uid: taskBoard.uid,
              planned_tasks: [],
              pre_flight: data.pre_flight,
              clarification_needed: data.clarification_needed,
            },
          },
        });
        return;
      }

      if (data.tasks.length > 0) {
        // Multi-subtask path: create one card per planned task
        const createdTaskCards: { uid: string; id: string; title: string }[] = [];

        for (const task of data.tasks) {
          const taskPayload = {
            ...card.payload,
            parent_board_uid: card.board_uid,
            parent_card_uid: card.uid,
            task_type: task.type,
            instructions: task.instructions,
            depends_on: task.depends_on,
            acceptance: task.acceptance,
            risk: task.risk,
          };

          const descriptionParts = task.body.join('\n\n');
          const extraParts: string[] = [];
          if (task.acceptance.length > 0) {
            extraParts.push(`**Acceptance:**\n${task.acceptance.map((a) => `- ${a}`).join('\n')}`);
          }
          if (task.risk.length > 0) {
            extraParts.push(`**Risk:**\n${task.risk.map((r) => `- ${r}`).join('\n')}`);
          }
          const description = extraParts.length > 0 ? `${descriptionParts}\n\n---\n\n${extraParts.join('\n\n')}` : descriptionParts;

          const taskCard = createCard(
            {},
            taskBoard.uid,
            {
              title: task.title,
              description,
              current_status: 'todo',
              payload: taskPayload,
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

          createdTaskCards.push({ uid: taskCard.uid, id: task.id, title: task.title });
          console.log(`[planning] Created task card ${taskCard.display_id} / ${taskCard.title}`);
        }

        // Create inter-task dependency relationships
        const idToUid = new Map(createdTaskCards.map((c) => [c.id, c.uid]));
        for (const [index, task] of data.tasks.entries()) {
          for (const depId of task.depends_on) {
            const parentTaskUid = idToUid.get(depId);
            if (parentTaskUid) {
              const childUid = createdTaskCards[index].uid;
              createCardRelationship(
                {},
                taskBoard.uid,
                parentTaskUid,
                childUid,
                'dependency',
                taskBoard.uid,
                taskBoard.uid,
              );
            }
          }
        }

        // Generate and append markdown summary
        const summary = generatePlanningSummary(data);
        const updatedDescription = appendSummaryToDescription(card.description, summary);

        fireAndForgetCallback(callbackUrl, {
          status: 'success',
          move_to_column: 'delegated',
          payload_updates: {
            description: updatedDescription,
            payload: {
              ...card.payload,
              delegated: true,
              task_card_uids: createdTaskCards.map((c) => c.uid),
              task_board_uid: taskBoard.uid,
              planned_tasks: data.tasks,
              pre_flight: data.pre_flight,
              clarification_needed: data.clarification_needed,
            },
          },
        });
        return;
      }
    }

    // Fallback: create a single clone child card on the task board (1:1 with parent)
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

    const fallbackPayload: Record<string, unknown> = {
      ...card.payload,
      delegated: true,
      task_card_uid: taskCard.uid,
      task_board_uid: taskBoard.uid,
      planned_tasks: [],
    };

    if (!result.success) {
      fallbackPayload.planning_raw_output = result.raw;
      fallbackPayload.planning_parse_errors = result.errors.filter((e) => e.toLowerCase().includes('json parse'));
      fallbackPayload.planning_validation_errors = result.errors.filter((e) => !e.toLowerCase().includes('json parse'));
    }

    fireAndForgetCallback(callbackUrl, {
      status: 'success',
      move_to_column: 'delegated',
      payload_updates: {
        payload: fallbackPayload,
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
