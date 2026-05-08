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
import { getModel } from '@mariozechner/pi-ai';
import { getApiKey } from '../lib/ai-auth.js';
import { readFileTool, runLlmWithToolLoop, writeToFileTool } from '../lib/llm-tool-loop.js';
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
Return ONLY valid JSONL (JSON Lines). Wrap the JSONL in a \` \`\`\`jsonl \` markdown code block. Do not add conversational filler before or after the code block.

Each line must be a standalone, minified JSON object. Use exactly one line per object.

Example:

\`\`\`jsonl
{"version":"planning.v1","pre_flight":{"complexity_level":"trivial|standard|complex|epic","justification":"One-sentence rationale.","primary_type":"implementation|infrastructure|research|refactor|bugfix","ambiguity_status":"none|needs_clarification","missing_info":[],"validation":{"coverage_complete":true,"fits_one_day":true,"independently_testable":true,"forward_dependencies_only":true,"notes":[]}},"clarification_needed":{"required":false,"questions":[]}}
{"id":"T1","title":"Subtask title","type":"implementation|infrastructure|research|refactor|bugfix","body":["Paragraph chunk 1","Paragraph chunk 2"],"depends_on":[],"acceptance":["Pass/fail criterion 1","Pass/fail criterion 2"],"instructions":{"agent_name":"none","notes":[]},"risk":[]}
\`\`\`

**Line structure**
- **Line 1**: Header object containing \`version\`, \`pre_flight\`, and \`clarification_needed\`.
- **Lines 2–N**: One task object per line. Each task uses the same fields as shown above.
- If \`clarification_needed.required\` is \`true\`, output ONLY the header line (no task lines).

**Field guidance**
- \`body\`: Use paragraph chunks (not one array entry per physical line).
- \`acceptance\`: Each item must be pass/fail and testable.
- \`depends_on\`: Array of task IDs (e.g. \`["T1"]\`). Never depend on title text. Use \`[]\` for no dependencies.
- Output compact/minified JSON (no extra spaces or newlines inside a line).

---

**Input Data**

Task Title: ${context.title}

Task Body:
${context.body}

${instructionsBlock}---

**Final Output Rules**
- Output ONLY valid JSONL inside a \` \`\`\`jsonl \` code block. No prose before or after the block, no bullet summaries outside it.
- Ensure all \`depends_on\` references use task \`id\` values that appear earlier in the output.
- The first line must be the header object. Every subsequent line must be one task object.`;
}

/* ------------------------------------------------------------------ */
/*  JSON parser & validator                                            */
/* ------------------------------------------------------------------ */

type ParsePlanningResult =
  | { success: true; data: PlanningV1 }
  | { success: false; errors: string[]; raw: string };

function extractJsonlFromText(text: string): {
  header: unknown;
  tasks: unknown[];
  lineErrors: string[];
} {
  const allLines = text.split(/\r?\n/).map((line) => line.trim());

  // Detect markdown code fences and extract content between them
  let jsonlLines: string[] = [];
  const fenceOpenRegex = /^```(?:jsonl)?\s*$/;
  const fenceCloseRegex = /^```\s*$/;

  let insideFence = false;
  for (const line of allLines) {
    if (!insideFence && fenceOpenRegex.test(line)) {
      insideFence = true;
      continue;
    }
    if (insideFence && fenceCloseRegex.test(line)) {
      insideFence = false;
      continue;
    }
    if (insideFence) {
      jsonlLines.push(line);
    }
  }

  // If fences were found, use only fenced content; otherwise fall back to all non-empty lines
  const lines =
    jsonlLines.length > 0
      ? jsonlLines.filter((line) => line.length > 0)
      : allLines.filter((line) => line.length > 0 && !line.startsWith('```'));

  const parsedObjects: unknown[] = [];
  const lineErrors: string[] = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const isLastLine = i === lines.length - 1;

    if (!line.startsWith('{') || !line.endsWith('}')) {
      if (isLastLine) {
        lineErrors.push(`Line ${i + 1} appears truncated (incomplete JSON object)`);
        continue;
      }
      lineErrors.push(`Line ${i + 1} is not a valid JSON object`);
      continue;
    }

    try {
      parsedObjects.push(JSON.parse(line));
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (isLastLine) {
        lineErrors.push(`Line ${i + 1} JSON parse error (truncated?): ${message}`);
        continue;
      }
      lineErrors.push(`Line ${i + 1} JSON parse error: ${message}`);
    }
  }

  if (parsedObjects.length === 0) {
    return { header: null, tasks: [], lineErrors: [...lineErrors, 'No valid JSONL lines found'] };
  }

  const header = parsedObjects[0];
  const tasks = parsedObjects.slice(1);

  return { header, tasks, lineErrors };
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

function parsePlanningV1Jsonl(rawText: string): ParsePlanningResult {
  const { header, tasks, lineErrors } = extractJsonlFromText(rawText);

  if (header === null) {
    console.error(`[planning] JSONL parse failed: ${lineErrors.join('; ')}`);
    console.error(`[planning] Raw text (first 2000 chars):\n${rawText.slice(0, 2000)}`);
    return { success: false, errors: lineErrors, raw: rawText };
  }

  // Assemble into PlanningV1 shape
  const assembled = {
    ...(typeof header === 'object' && header !== null ? header : {}),
    tasks,
  };

  const zodResult = PlanningV1Schema.safeParse(assembled);
  if (!zodResult.success) {
    const issues = zodResult.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`);
    console.error(`[planning] Schema validation failed with ${issues.length} issue(s):`);
    for (const issue of issues) {
      console.error(`[planning]   - ${issue}`);
    }
    return { success: false, errors: [...lineErrors, `Schema validation failed: ${issues.join('; ')}`], raw: rawText };
  }

  const data = zodResult.data;
  const semanticErrors: string[] = [...lineErrors];

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
    console.error(`[planning] Semantic validation failed with ${semanticErrors.length} error(s):`);
    for (const err of semanticErrors) {
      console.error(`[planning]   - ${err}`);
    }
    return { success: false, errors: semanticErrors, raw: rawText };
  }

  return { success: true, data };
}

/* ------------------------------------------------------------------ */
/*  LLM session with repair                                            */
/* ------------------------------------------------------------------ */

async function runPlanningSession(prompt: string, workingDir?: string): Promise<ParsePlanningResult> {
  const preferredModel = getModel('opencode-go', 'deepseek-v4-pro');

  console.log('[planning] Starting AI planning completion');

  const apiKey = await getApiKey(preferredModel.provider);

  const result = await runLlmWithToolLoop({
    model: preferredModel,
    apiKey,
    systemPrompt: prompt,
    userMessage: 'Please produce the task breakdown as valid JSON conforming to the planning.v1 schema above.',
    workingDir,
    tools: [readFileTool, writeToFileTool],
    maxRounds: 1,
    maxFilesPerRound: 3,
    maxTokens: preferredModel.maxTokens,
  });

  if (result.stopReason === 'error') {
    throw new Error('LLM provider error');
  }

  console.log(`[planning] LLM completed in ${result.totalRounds} round(s)`);

  // Prefer captured writes (e.g., from write_to_file tool calls) over raw text
  let textContent = result.text;
  const capturedWriteValues = Object.values(result.capturedWrites);
  if (capturedWriteValues.length > 0 && capturedWriteValues[0].trim()) {
    textContent = capturedWriteValues[0];
    console.log('[planning] Using captured write content as raw output');
  }

  if (!textContent.trim()) {
    throw new Error('LLM returned empty text');
  }

  console.log('[planning] Raw LLM output:\n', textContent);

  return parsePlanningV1Jsonl(textContent);
}

async function runPlanningSessionWithRepair(prompt: string, workingDir?: string): Promise<ParsePlanningResult> {
  const firstResult = await runPlanningSession(prompt, workingDir);
  if (firstResult.success) {
    return firstResult;
  }

  console.log('[planning] First parse/validation failed, attempting repair pass');
  console.error(`[planning] First pass errors:\n${firstResult.errors.map((e) => `  - ${e}`).join('\n')}`);

  const repairPrompt = `The previous planning output was invalid. The output should be JSONL: line 1 is a header with version, pre_flight, and clarification_needed; each subsequent line is one task object.

Here is the raw output:

---
${firstResult.raw}
---

Here are the errors:
${firstResult.errors.map((e) => `- ${e}`).join('\n')}

Please return ONLY valid JSONL that fixes these issues. Line 1 = header, lines 2+ = tasks. Do not include markdown code fences or any extra text.`;

  const repairResult = await runPlanningSession(repairPrompt, workingDir);
  if (repairResult.success) {
    console.log('[planning] Repair pass succeeded');
    return repairResult;
  }

  console.log('[planning] Repair pass also failed');
  console.error(`[planning] Repair pass errors:\n${repairResult.errors.map((e) => `  - ${e}`).join('\n')}`);
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
      const workingDir = typeof card.payload?.working_dir === 'string' ? card.payload.working_dir.trim() : undefined;
      const context = extractCardContext(card);
      result = await runPlanningSessionWithRepair(buildPlanningPrompt(context), workingDir);
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
