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

function buildPlanningSystemPrompt(): string {
  return `CRITICAL OUTPUT CONSTRAINT — READ FIRST:
Your response must consist of raw JSONL and absolutely nothing else.
- The VERY FIRST CHARACTER you output must be \`{\`.
- Do NOT write any thinking, analysis, reasoning, preamble, or explanation before the JSONL.
- Do NOT wrap the output in markdown code fences (no \`\`\`jsonl or \`\`\` of any kind).
- Do NOT add prose, summaries, or blank lines between or after the JSONL lines.
- If you reason about the problem internally before answering, that reasoning must NOT appear in your response.

You are a senior engineering project planner. Your job is to break a parent development task into small, highly manageable subtasks.

**Core Principles for Sizing**
- **Scope:** Each subtask must represent roughly a half-day to a full day of work for a single developer (a single, easily reviewable Pull Request). If a subtask exceeds this, you must break it down further.
- **Independence:** Each subtask must be independently implementable and testable. Minimize blocking dependencies. If two subtasks absolutely must share a foundation (e.g., a shared contract or schema), the foundational piece must be its own subtask that appears first in the sequence.
- **Count:** Generate at most 38 tasks. If the natural breakdown exceeds 38, consolidate closely related items into one scoped task.

**Grounding Rules**
- Use only information present in the task title, task body, global instructions, or files you explicitly read with tools.
- Do not invent APIs, filenames, services, users, business rules, metrics, deadlines, or requirements.
- If essential information is missing and no useful task breakdown can be made, set \`clarification_needed.required\` to \`true\` and output only the header line.
- If the plan can proceed with reasonable assumptions, keep assumptions minimal and record uncertainty in \`pre_flight.validation.notes\` or task \`risk\`.
- Do not implement code. Do not create or modify project source files. Your final answer, or any file written for final output, must contain only the planning JSONL.`;
}

function buildPlanningUserPrompt(context: {
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

  return `⚠️ START YOUR RESPONSE IMMEDIATELY WITH \`{\` — NO TEXT BEFORE IT.
Do not write analysis, acknowledgements, code fences, or any prose. The first character of your response must be an opening brace.
After reading any files with tools, do NOT summarise what you found — output ONLY the JSONL plan.
Generate at most 38 tasks; consolidate related items if the natural count exceeds 38.

**Output Format**
Return valid JSONL (JSON Lines). Do not add conversational filler before or after the JSONL.

JSONL rules:
- Each physical line must be one complete, standalone, minified JSON object.
- Do not output a JSON array.
- Do not pretty-print JSON.
- Do not put commas between lines.
- Do not include comments or blank lines.

**JSON Schema (MUST follow exactly)**
\`\`\`json
{
  "version": "planning.v1",
  "pre_flight": {
    "complexity_level": "standard|complex|simple",
    "justification": "string",
    "primary_type": "implementation|infrastructure|research|refactor|bugfix",
    "ambiguity_status": "none|minor|needs_clarification",
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
  }
}
// Then one line per task:
{
  "id": "string (e.g. T1)",
  "title": "string",
  "type": "implementation|infrastructure|research|refactor|bugfix",
  "body": ["string paragraph"],
  "depends_on": ["T1"],
  "acceptance": ["string"],
  "instructions": {"agent_name": null, "notes": ["string"]},
  "risk": ["string"]
}
\`\`\`

**Forbidden fields — NEVER use these**
Do NOT output fields like \`task_id\`, \`phase\`, \`description\`, \`status\`, \`recommended_file\`, \`recommended_test_file\`, \`dependencies\`, \`rule_ids\`, or \`estimated_effort\`. Use ONLY the fields shown in the schema above.

Example successful plan:

\`\`\`jsonl
{"version":"planning.v1","pre_flight":{"complexity_level":"standard","justification":"The task can be split into independently reviewable implementation steps.","primary_type":"implementation","ambiguity_status":"none","missing_info":[],"validation":{"coverage_complete":true,"fits_one_day":true,"independently_testable":true,"forward_dependencies_only":true,"notes":[]}},"clarification_needed":{"required":false,"questions":[]}}
{"id":"T1","title":"Define the shared API contract","type":"implementation","body":["Add or update the shared schema/types required by the feature so later implementation tasks can depend on a stable contract."],"depends_on":[],"acceptance":["The shared contract exists in the appropriate shared module.","The contract has validation or type coverage where applicable."],"instructions":{"agent_name":null,"notes":[]},"risk":["The exact file location should be verified before editing."]}
{"id":"T2","title":"Implement the backend behavior","type":"implementation","body":["Implement the server-side behavior using the shared contract from T1."],"depends_on":["T1"],"acceptance":["The backend accepts valid requests that match the shared contract.","Relevant backend tests pass."],"instructions":{"agent_name":null,"notes":[]},"risk":[]}
\`\`\`

Example clarification-only output:

\`\`\`jsonl
{"version":"planning.v1","pre_flight":{"complexity_level":"standard","justification":"A useful implementation plan cannot be created until the missing decision is provided.","primary_type":"implementation","ambiguity_status":"needs_clarification","missing_info":["The required integration target is not specified."],"validation":{"coverage_complete":false,"fits_one_day":false,"independently_testable":false,"forward_dependencies_only":true,"notes":["Clarification is required before task breakdown."]}},"clarification_needed":{"required":true,"questions":["Which integration target should this task use?"]}}
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
- Output ONLY raw valid JSONL. No markdown code fences, no prose, no summaries, no comments, and no blank lines.
- The FIRST CHARACTER of your response must be \`{\`. Do not write anything before the opening brace.
- Ensure all \`depends_on\` references use task \`id\` values that appear earlier in the output.
- The first line must be the header object. Every subsequent line must be one task object.
- Maximum 38 task lines. Fewer is better if the breakdown is still complete.`;
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

  // Detect markdown code fences.
  // Enhanced: the opening fence may appear at the END of a prose line
  // (e.g. "...description.```jsonl") in addition to being on its own line.
  // We match any line that ENDS with the fence marker rather than requiring it
  // to occupy the entire line.
  let jsonlLines: string[] = [];
  let insideFence = false;
  let foundFence = false;
  const fenceOpenRegex = /```(?:jsonl)?\s*$/;  // fence at end of any line
  const fenceCloseRegex = /^```\s*$/;           // closing fence must be its own line

  for (const line of allLines) {
    if (!insideFence) {
      if (fenceOpenRegex.test(line)) {
        insideFence = true;
        foundFence = true;
        // If the fence marker was preceded by prose on the same line, discard the whole line.
        continue;
      }
    } else {
      if (fenceCloseRegex.test(line)) {
        insideFence = false;
        continue;
      }
      jsonlLines.push(line);
    }
  }

  // If an unclosed fence was found (e.g. output was truncated), jsonlLines still
  // contains everything captured so far — that is correct behaviour.

  const parsedObjects: unknown[] = [];
  const lineErrors: string[] = [];

  if (foundFence) {
    // Fenced mode: parse every non-empty line inside the fence.
    const lines = jsonlLines.filter((line) => line.length > 0);
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      const isLastLine = i === lines.length - 1;

      if (!line.startsWith('{') || !line.endsWith('}')) {
        if (isLastLine) {
          lineErrors.push('Last line appears truncated (incomplete JSON object)');
        } else {
          lineErrors.push(`Fenced line ${i + 1} is not a valid JSON object`);
        }
        continue;
      }

      try {
        parsedObjects.push(JSON.parse(line));
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        lineErrors.push(`Fenced line ${i + 1} JSON parse error${isLastLine ? ' (truncated?)' : ''}: ${message}`);
      }
    }
  } else {
    // Fallback mode: no fences found. Silently skip prose lines; only attempt to
    // parse lines that look like JSON objects (start with '{').
    const jsonLookingLines = allLines.filter((line) => line.startsWith('{'));
    for (let i = 0; i < jsonLookingLines.length; i++) {
      const line = jsonLookingLines[i];
      const isLastLine = i === jsonLookingLines.length - 1;

      if (!line.endsWith('}')) {
        // Starts with '{' but doesn't close — truncated.
        lineErrors.push('Last JSON line appears truncated (incomplete JSON object)');
        continue;
      }

      try {
        parsedObjects.push(JSON.parse(line));
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        lineErrors.push(`JSON parse error${isLastLine ? ' (truncated?)' : ''}: ${message}`);
      }
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

async function runPlanningSession(
  systemPrompt: string,
  userMessage: string,
  workingDir?: string,
): Promise<ParsePlanningResult> {
  const preferredModel = getModel('opencode-go', 'deepseek-v4-pro');

  console.log('[planning] Starting AI planning completion');

  const apiKey = await getApiKey(preferredModel.provider);

  const result = await runLlmWithToolLoop({
    model: preferredModel,
    apiKey,
    systemPrompt,
    userMessage,
    workingDir,
    tools: [readFileTool, writeToFileTool],
    maxRounds: 3,
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

async function runPlanningSessionWithRepair(
  systemPrompt: string,
  userMessage: string,
  workingDir?: string,
): Promise<ParsePlanningResult> {
  const firstResult = await runPlanningSession(systemPrompt, userMessage, workingDir);
  if (firstResult.success) {
    return firstResult;
  }

  console.log('[planning] First parse/validation failed, attempting repair pass');
  console.error(`[planning] First pass errors:\n${firstResult.errors.map((e) => `  - ${e}`).join('\n')}`);

  // Determine whether the failure was due to truncation so we can give a targeted hint.
  const wasTruncated = firstResult.errors.some((e) => e.toLowerCase().includes('truncated'));
  const rawSnippet = firstResult.raw.slice(0, 3000);
  const rawSection = wasTruncated
    ? `The previous output was truncated before it could finish. Here are the first 3000 characters for context (do NOT copy them — produce a fresh, complete, shorter plan):

---
${rawSnippet}${firstResult.raw.length > 3000 ? `\n[… ${firstResult.raw.length - 3000} more characters truncated]` : ''}
---

To avoid truncation again, generate at most 30 tasks total and keep each task body concise (2–3 sentences maximum).`
    : `Here is the raw output that failed:

---
${rawSnippet}${firstResult.raw.length > 3000 ? `\n[… ${firstResult.raw.length - 3000} more characters truncated]` : ''}
---`;

  const repairPrompt = `The previous planning output was invalid. The output must be raw JSONL: line 1 is a header with version, pre_flight, and clarification_needed; each subsequent line is one task object.

${rawSection}

Errors from the previous attempt:
${firstResult.errors.map((e) => `- ${e}`).join('\n')}

⚠️ YOUR RESPONSE MUST BEGIN WITH \`{\`. The first character must be an opening brace — no prose, no fences, no blank lines before it.
Please return ONLY valid JSONL that fixes these issues. Line 1 = header, lines 2+ = tasks. Do not include markdown code fences, prose, comments, blank lines, a surrounding JSON array, or commas between lines.`;

  const repairResult = await runPlanningSession(systemPrompt, repairPrompt, workingDir);
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
      result = await runPlanningSessionWithRepair(
        buildPlanningSystemPrompt(),
        buildPlanningUserPrompt(context),
        workingDir,
      );

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
