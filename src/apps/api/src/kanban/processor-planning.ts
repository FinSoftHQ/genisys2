import { resolve } from 'node:path';
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
  parseProtocol,
  PlanningV1Schema,
} from '@repo/shared';
import type { PlanningV1 } from '@repo/shared';
import { getModel } from '@mariozechner/pi-ai';
import { getApiKey } from '../lib/ai-auth.js';
import { readFileTool, runLlmWithToolLoop } from '../lib/llm-tool-loop.js';
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

function resolveWorkingDir(card: { payload: Record<string, unknown>; display_id?: string }): string | undefined {
  const fromPayload = typeof card.payload?.working_dir === 'string' ? card.payload.working_dir.trim() : undefined;
  if (fromPayload) {
    return resolve(fromPayload);
  }
  // Fallback: construct workspace path from display_id if available
  if (card.display_id) {
    const fallback = resolve(process.cwd(), '.workspaces', card.display_id);
    console.warn(`[planning] card.payload.working_dir missing — falling back to ${fallback}`);
    return fallback;
  }
  console.warn('[planning] card.payload.working_dir missing and no display_id — planning will have no file access');
  return undefined;
}

function resolveContactAgentName(card: { payload: Record<string, unknown> }): string | undefined {
  const tailorShop = typeof card.payload?.tailor_shop === 'string' ? card.payload.tailor_shop.trim() : undefined;
  if (!tailorShop) {
    return undefined;
  }
  const protocolPath = resolve(tailorShop, 'working_protocol.md');
  try {
    const protocol = parseProtocol(protocolPath, { requireTeam: true });
    const contact = protocol.facilitator ?? Object.keys(protocol.team)[0];
    if (contact) {
      console.log(`[planning] Resolved team contact from ${protocolPath}: ${contact}`);
      return contact;
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.warn(`[planning] Failed to parse team protocol at ${protocolPath}: ${message}`);
  }
  return undefined;
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
    "complexity_level": "trivial|standard|complex|epic",
    "justification": "string",
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
  "risk": ["string"]
}
\`\`\`

**Forbidden fields — NEVER use these**
Do NOT output fields like \`task_id\`, \`phase\`, \`description\`, \`status\`, \`recommended_file\`, \`recommended_test_file\`, \`dependencies\`, \`rule_ids\`, or \`estimated_effort\`. Use ONLY the fields shown in the schema above.

Example successful plan:

\`\`\`jsonl
{"version":"planning.v1","pre_flight":{"complexity_level":"standard","justification":"The task can be split into independently reviewable implementation steps.","primary_type":"implementation","ambiguity_status":"none","missing_info":[],"validation":{"coverage_complete":true,"fits_one_day":true,"independently_testable":true,"forward_dependencies_only":true,"notes":[]}},"clarification_needed":{"required":false,"questions":[]}}
{"id":"T1","title":"Define the shared API contract","type":"implementation","body":["Add or update the shared schema/types required by the feature so later implementation tasks can depend on a stable contract."],"depends_on":[],"acceptance":["The shared contract exists in the appropriate shared module.","The contract has validation or type coverage where applicable."],"risk":["The exact file location should be verified before editing."]}
{"id":"T2","title":"Implement the backend behavior","type":"implementation","body":["Implement the server-side behavior using the shared contract from T1."],"depends_on":["T1"],"acceptance":["The backend accepts valid requests that match the shared contract.","Relevant backend tests pass."],"risk":[]}
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
- The first line must be the header object. Every subsequent line must be one task object.`;
}

/* ------------------------------------------------------------------ */
/*  JSON parser & validator                                            */
/* ------------------------------------------------------------------ */

type ParsePlanningResult =
  | { success: true; data: PlanningV1 }
  | { success: false; errors: string[]; raw: string };

/**
 * Strip reasoning wrappers emitted by thinking/reasoning models before parsing.
 * Removes <think>...</think> blocks (DeepSeek, QwQ, o-series) so the remaining
 * text starts cleanly with the JSONL output.
 */
function stripReasoningPreamble(text: string): string {
  const stripped = text.replace(/<think>[\s\S]*?<\/think>/gi, '').trim();
  return stripped.length > 0 ? stripped : text;
}

/**
 * Scan the raw text for a planning header object that may appear mid-line after
 * prose preamble (e.g. "Let me produce the JSONL.{\"version\":\"planning.v1\",...}").
 * Returns the parsed header object or null if not found.
 */
function tryFindHeaderObject(text: string): unknown | null {
  // Match the opening of a planning header anywhere in the text.
  const pattern = /\{\s*"version"\s*:\s*"planning\.v1"/;
  const match = pattern.exec(text);
  if (!match) return null;

  // Balance braces from the match position to extract the complete JSON object.
  const start = match.index;
  let depth = 0;
  for (let i = start; i < text.length; i++) {
    if (text[i] === '{') depth++;
    else if (text[i] === '}') {
      depth--;
      if (depth === 0) {
        try {
          return JSON.parse(text.slice(start, i + 1));
        } catch {
          return null;
        }
      }
    }
  }
  return null;
}

function extractJsonlFromText(text: string): {
  header: unknown;
  tasks: unknown[];
  lineErrors: string[];
  allObjects: unknown[];
} {
  // Strip reasoning preamble (<think> blocks, etc.) before any line analysis.
  const cleanText = stripReasoningPreamble(text);
  const allLines = cleanText.split(/\r?\n/).map((line) => line.trim());

  // Detect markdown code fences.
  // Enhanced: the opening fence may appear at the END of a prose line
  // (e.g. "...description.```jsonl") in addition to being on its own line.
  // We match any line that ENDS with the fence marker rather than requiring it
  // to occupy the entire line.
  const jsonlLines: string[] = [];
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

    // Rescue: if the first parsed object is not the planning header (e.g. the
    // LLM appended the header JSON to a prose sentence on the same line so it
    // didn't start with '{'), scan the full text for the header and prepend it.
    const firstObj = parsedObjects[0] as Record<string, unknown> | undefined;
    if (!firstObj || firstObj['version'] !== 'planning.v1') {
      const rescued = tryFindHeaderObject(cleanText);
      if (rescued) {
        console.warn('[planning] Header was embedded mid-line after prose — rescued via full-text scan');
        parsedObjects.unshift(rescued);
      }
    }
  }

  if (parsedObjects.length === 0) {
    return { header: null, tasks: [], lineErrors: [...lineErrors, 'No valid JSONL lines found'], allObjects: [] };
  }

  const header = parsedObjects[0];
  const tasks = parsedObjects.slice(1);

  return { header, tasks, lineErrors, allObjects: parsedObjects };
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
  const { header, tasks, lineErrors, allObjects } = extractJsonlFromText(rawText);

  if (header === null) {
    console.error(`[planning] JSONL parse failed: ${lineErrors.join('; ')}`);
    console.error(`[planning] Raw text (first 2000 chars):\n${rawText.slice(0, 2000)}`);
    return { success: false, errors: lineErrors, raw: rawText };
  }

  // Detect missing header: if the first object is not a valid planning header
  // but every object looks like a task, inject a default header so the plan
  // can still succeed.
  const firstObj = header as Record<string, unknown> | undefined;
  const isValidHeader = firstObj && firstObj['version'] === 'planning.v1';
  let effectiveHeader: unknown = header;
  let effectiveTasks: unknown[] = tasks;

  if (!isValidHeader && allObjects.length > 0) {
    const allLookLikeTasks = allObjects.every(
      (obj) =>
        obj &&
        typeof obj === 'object' &&
        typeof (obj as Record<string, unknown>)['id'] === 'string' &&
        typeof (obj as Record<string, unknown>)['title'] === 'string' &&
        typeof (obj as Record<string, unknown>)['type'] === 'string',
    );

    if (allLookLikeTasks) {
      console.warn('[planning] LLM omitted planning header — injecting default header and treating all objects as tasks');
      effectiveHeader = { version: 'planning.v1', clarification_needed: { required: false, questions: [] } };
      effectiveTasks = allObjects;
    }
  }

  // Warn about unrecognized task keys that were stripped by Zod.
  // Do this before safeParse so we report against the original raw objects.
  const allowedTaskKeys = new Set(['id', 'title', 'type', 'body', 'depends_on', 'acceptance', 'instructions', 'risk']);
  const strippedKeyWarnings: string[] = [];
  for (const [i, rawTask] of effectiveTasks.entries()) {
    if (rawTask && typeof rawTask === 'object') {
      const extraKeys = Object.keys(rawTask as object).filter((k) => !allowedTaskKeys.has(k));
      if (extraKeys.length > 0) {
        const taskId = (rawTask as Record<string, unknown>).id ?? `index ${i}`;
        strippedKeyWarnings.push(`Task ${String(taskId)}: stripped unknown keys [${extraKeys.join(', ')}]`);
      }
    }
  }
  if (strippedKeyWarnings.length > 0) {
    console.warn(`[planning] Stripped unrecognized keys from task objects (not a failure):`);
    for (const w of strippedKeyWarnings) {
      console.warn(`[planning]   - ${w}`);
    }
  }

  // Assemble into PlanningV1 shape
  const assembled = {
    ...(typeof effectiveHeader === 'object' && effectiveHeader !== null ? effectiveHeader : {}),
    tasks: effectiveTasks,
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

  if (!data.pre_flight) {
    console.warn('[planning] LLM omitted pre_flight from the header — plan will proceed but summary will be skipped');
  }
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
/*  LLM session runner                                                 */
/* ------------------------------------------------------------------ */

/**
 * Cap output tokens for planning sessions.
 * The model registry reports 384,000 as the model's maximum, but that is far
 * more than any planning output ever needs. A realistic cap keeps reasoning
 * phases short and avoids silently overflowing any lower provider-side limit.
 * Override with the PLANNING_MAX_OUTPUT_TOKENS env var if needed.
 */
const PLANNING_MAX_OUTPUT_TOKENS = Number(process.env.PLANNING_MAX_OUTPUT_TOKENS ?? '32768');

async function runPlanningSession(
  systemPrompt: string,
  userMessage: string,
  workingDir?: string,
  tierLabel = 'T?',
): Promise<ParsePlanningResult> {
  const preferredModel = getModel('opencode-go', 'deepseek-v4-flash');
  const planningMaxTokens = Math.min(preferredModel.maxTokens, PLANNING_MAX_OUTPUT_TOKENS);

  console.log(`[planning] [${tierLabel}] Starting LLM call (maxTokens=${planningMaxTokens})`);

  const apiKey = await getApiKey(preferredModel.provider);

  const result = await runLlmWithToolLoop({
    model: preferredModel,
    apiKey,
    systemPrompt,
    userMessage,
    workingDir,
    tools: [readFileTool],   // writeToFileTool removed: system prompt says don't create files
    maxRounds: 6,
    maxFilesPerRound: 3,
    maxTokens: planningMaxTokens,
  });

  if (result.stopReason === 'error' || result.stopReason === 'aborted') {
    throw new Error(`LLM provider error (stopReason=${result.stopReason})`);
  }

  const wasTruncatedByApi = result.stopReason === 'length';
  console.log(`[planning] [${tierLabel}] LLM completed: stopReason=${result.stopReason} rounds=${result.totalRounds}`);
  if (result.usage) {
    const u = result.usage;
    console.log(
      `[planning] [${tierLabel}] Token usage:` +
      ` input=${u.input} output=${u.output} cacheRead=${u.cacheRead}` +
      ` total=${u.totalTokens} cost=$${u.cost.total.toFixed(4)}`,
    );
  }
  if (wasTruncatedByApi) {
    console.warn(
      `[planning] [${tierLabel}] ⚠️ Output truncated by API (stopReason=length) — plan is likely incomplete`,
    );
  }

  const textContent = result.text;

  if (!textContent.trim()) {
    throw new Error('LLM returned empty text');
  }

  console.log(`[planning] [${tierLabel}] Raw LLM output (${textContent.length} chars):\n`, textContent);

  const parseResult = parsePlanningV1Jsonl(textContent);

  // If the API itself signalled truncation, inject a clear error so the retry
  // classifier reliably detects it even when the last JSON line happened to be
  // syntactically complete (edge case: last task was fully written but more
  // tasks were silently dropped by the token cap).
  if (parseResult.success && wasTruncatedByApi) {
    console.warn(
      `[planning] [${tierLabel}] ⚠️ Parsed successfully but API signaled truncation — plan may be incomplete (${parseResult.data.tasks.length} tasks)`,
    );
  }
  if (!parseResult.success && wasTruncatedByApi) {
    const truncationMsg = 'API stop reason: output was truncated (max tokens reached)';
    if (!parseResult.errors.some((e) => e.toLowerCase().includes('truncated'))) {
      return { success: false, errors: [...parseResult.errors, truncationMsg], raw: parseResult.raw };
    }
  }

  return parseResult;
}

/* ------------------------------------------------------------------ */
/*  Multi-tier retry helpers                                           */
/* ------------------------------------------------------------------ */

function classifyTier1Failure(errors: string[]): {
  wasTruncated: boolean;
  wasSchemaDrift: boolean;
  wasEmpty: boolean;
} {
  const joined = errors.join(' ').toLowerCase();
  return {
    wasTruncated: joined.includes('truncated'),
    wasSchemaDrift: joined.includes('unrecognized key') ||
      joined.includes('invalid input') ||
      joined.includes('invalid option') ||
      joined.includes('invalid enum value'),
    wasEmpty: joined.includes('empty text') || joined.includes('no lines'),
  };
}

function buildRepairPrompt(
  firstResult: { errors: string[]; raw: string },
  classification: { wasTruncated: boolean; wasSchemaDrift: boolean },
  taskLimit: number,
  taskContext: { title: string; body: string },
): string {
  const bodySnippet =
    taskContext.body.length > 800
      ? taskContext.body.slice(0, 800) + '\n[...body truncated — full body was in your original context...]'
      : taskContext.body;
  const taskSection =
    `TASK TO PLAN (same as original — scope has not changed):\n` +
    `Title: ${taskContext.title}\n` +
    `Body:\n${bodySnippet}\n`;

  // For schema drift, do NOT include raw output — it anchors the model to wrong schema.
  // For truncation, show a small snippet so the model can preserve the plan structure.
  let rawSection: string;
  if (classification.wasTruncated) {
    const snippet = firstResult.raw.slice(0, 3000);
    rawSection = `The previous output was truncated before it could finish. Here are the first 3000 characters for context (do NOT copy them — produce a fresh, complete, shorter plan):

---
${snippet}${firstResult.raw.length > 3000 ? `\n[… ${firstResult.raw.length - 3000} more characters truncated]` : ''}
---

To avoid truncation again, generate at most ${taskLimit} tasks total and keep each task body concise (1–2 sentences maximum).`;
  } else if (classification.wasSchemaDrift) {
    rawSection = `The previous output used wrong field names or a wrong format. Do NOT look at the previous output — it will mislead you. Start fresh with the correct schema below.`;
  } else {
    const snippet = firstResult.raw.slice(0, 2000);
    rawSection = `Here is the raw output that failed (use only for content ideas, NOT for format):
---
${snippet}${firstResult.raw.length > 2000 ? `\n[… ${firstResult.raw.length - 2000} more characters truncated]` : ''}
---`;
  }

  return `${taskSection}
The previous planning output was invalid. Return ONLY raw JSONL that fixes the errors below.

REQUIRED EXACT SCHEMA (deviate at all and it will fail again):

Line 1 — header object (only these fields, no wrapper):
${'```json'}
{"version":"planning.v1","pre_flight":{"complexity_level":"trivial|standard|complex|epic","justification":"string","primary_type":"implementation|infrastructure|research|refactor|bugfix","ambiguity_status":"none|needs_clarification","missing_info":["string"],"validation":{"coverage_complete":true,"fits_one_day":true,"independently_testable":true,"forward_dependencies_only":true,"notes":["string"]}},"clarification_needed":{"required":false,"questions":["string"]}}
${'```'}

Lines 2–N — task objects (only these fields, no others):
${'```json'}
{"id":"T1","title":"string","type":"implementation|infrastructure|research|refactor|bugfix","body":["string paragraph"],"depends_on":["T1"],"acceptance":["string"],"risk":["string"]}
${'```'}

CRITICAL:
- version MUST be "planning.v1" (not "1.0" or anything else).
- Do NOT wrap the header in a {"header":{...}} envelope — the header IS the object.
- Task fields are id, title, type, body, depends_on, acceptance, risk — NOT task_id, phase, description.
- Maximum ${taskLimit} total task lines. Each task body array item must be a short paragraph (1–2 sentences).
- If clarification_needed.required is true, output ONLY the header line (no tasks).

${rawSection}

Errors from the previous attempt:
${firstResult.errors.map((e) => `- ${e}`).join('\n')}

⚠️ YOUR RESPONSE MUST BEGIN WITH \`{\`. No prose, no fences, no blank lines. Output raw JSONL only.`;
}

function buildTier3UserMessage(
  originalUserMessage: string,
  errorsTier1: string[],
  errorsTier2: string[],
  taskLimit: number,
): string {
  const allErrors = [...new Set([...errorsTier1, ...errorsTier2])];
  const errorSummary = allErrors
    .slice(0, 10)
    .map((e) => `- ${e}`)
    .join('\n');

  // Re-use the original user message so the model has the full task description
  // and schema instructions, then append strict brevity constraints.
  return (
    originalUserMessage +
    `\n\n---\n\n` +
    `⚠️ RETRY NOTICE — two previous attempts both failed validation. ` +
    `Ignore any previous output. Start completely fresh.\n\n` +
    `STRICT LIMITS FOR THIS ATTEMPT:\n` +
    `- Maximum ${taskLimit} task lines total. Fewer is better than an incomplete or invalid plan.\n` +
    `- Each body[] item: 1 short sentence maximum.\n` +
    `- Each acceptance[] item: 1 short pass/fail criterion maximum.\n` +
    `- version MUST be "planning.v1" exactly.\n` +
    `- Task fields: id, title, type, body, depends_on, acceptance, risk — ONLY these.\n` +
    `- First character of your response MUST be {. No prose, no fences, no blank lines.\n\n` +
    `Previous errors to NOT repeat:\n${errorSummary}\n\n` +
    `Output valid JSONL now. First character must be {.`
  );
}

async function runPlanningSessionWithRetry(
  systemPrompt: string,
  userMessage: string,
  workingDir?: string,
  taskContext?: { title: string; body: string },
): Promise<ParsePlanningResult> {
  // ── Tier 1: Normal attempt ──────────────────────────────────────────
  console.log('[planning] ═══ Tier 1: Normal attempt ═══');
  const t1 = await runPlanningSession(systemPrompt, userMessage, workingDir, 'T1');
  if (t1.success) {
    console.log('[planning] ✅ Tier 1 succeeded');
    return t1;
  }

  const t1Class = classifyTier1Failure(t1.errors);
  console.log('[planning] ❌ Tier 1 failed');
  console.log(`[planning]    Classification → truncated=${t1Class.wasTruncated} schemaDrift=${t1Class.wasSchemaDrift} empty=${t1Class.wasEmpty}`);
  console.log(`[planning]    Errors (${t1.errors.length}):`);
  for (const e of t1.errors) console.log(`[planning]      • ${e}`);

  // ── Tier 2: Targeted repair ─────────────────────────────────────────
  const t2TaskLimit = t1Class.wasTruncated ? 16 : t1Class.wasSchemaDrift ? 24 : 32;
  console.log(`[planning] ═══ Tier 2: Repair pass (max ${t2TaskLimit} tasks) ═══`);

  // Always provide the original task context so the model knows what to plan
  // even when the raw previous output is withheld (schema-drift path).
  const ctx = taskContext ?? { title: '(task title unavailable — see system context)', body: '' };
  const repairPrompt = buildRepairPrompt({ errors: t1.errors, raw: t1.raw }, t1Class, t2TaskLimit, ctx);
  const t2 = await runPlanningSession(systemPrompt, repairPrompt, workingDir, 'T2');
  if (t2.success) {
    console.log('[planning] ✅ Tier 2 succeeded');
    return t2;
  }

  console.log('[planning] ❌ Tier 2 failed');
  console.log(`[planning]    Errors (${t2.errors.length}):`);
  for (const e of t2.errors) console.log(`[planning]      • ${e}`);

  // ── Tier 3: Full-context fresh retry ───────────────────────────────
  // Re-uses the original userMessage so the model keeps full task context and
  // schema instructions, then appends strict brevity constraints plus a compact
  // error summary so the model knows what mistakes to avoid.
  const t3TaskLimit = t1Class.wasTruncated ? 10 : t1Class.wasSchemaDrift ? 16 : 20;
  console.log(`[planning] ═══ Tier 3: Full-context fresh retry (max ${t3TaskLimit} tasks) ═══`);

  const t3UserMessage = buildTier3UserMessage(userMessage, t1.errors, t2.errors, t3TaskLimit);
  const t3 = await runPlanningSession(systemPrompt, t3UserMessage, workingDir, 'T3');
  if (t3.success) {
    console.log('[planning] ✅ Tier 3 succeeded');
    return t3;
  }

  console.log('[planning] ❌ All three tiers exhausted — planning failed');
  console.log(`[planning]    Tier 3 errors (${t3.errors.length}):`);
  for (const e of t3.errors) console.log(`[planning]      • ${e}`);

  return {
    success: false,
    errors: [
      `Tier 1: ${t1.errors.join('; ')}`,
      `Tier 2: ${t2.errors.join('; ')}`,
      `Tier 3: ${t3.errors.join('; ')}`,
    ],
    raw: t1.raw,
  };
}

/* ------------------------------------------------------------------ */
/*  Markdown summary generator                                         */
/* ------------------------------------------------------------------ */

function generatePlanningSummary(data: PlanningV1): string {
  const lines: string[] = [];
  lines.push('# Planning Summary');
  lines.push('');

  if (data.pre_flight) {
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
  }

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
      if (task.instructions && (task.instructions.agent_name || task.instructions.notes.length > 0)) {
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

function buildPlannedTaskCardDescription(task: PlanningV1['tasks'][number]): string {
  const scopeOfWork = `## Scope of Work\n\n${task.body.join('\n\n')}`;
  const extraParts: string[] = [];

  if (task.acceptance.length > 0) {
    extraParts.push(`**Acceptance:**\n${task.acceptance.map((a) => `- ${a}`).join('\n')}`);
  }
  if (task.risk.length > 0) {
    extraParts.push(`**Risk:**\n${task.risk.map((r) => `- ${r}`).join('\n')}`);
  }

  return extraParts.length > 0
    ? `${scopeOfWork}\n\n---\n\n${extraParts.join('\n\n')}`
    : scopeOfWork;
}

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
      const workingDir = resolveWorkingDir(card);
      const context = extractCardContext(card);
      result = await runPlanningSessionWithRetry(
        buildPlanningSystemPrompt(),
        buildPlanningUserPrompt(context),
        workingDir,
        { title: context.title, body: context.body },
      );

    } catch (llmErr) {
      const message = llmErr instanceof Error ? llmErr.message : String(llmErr);
      console.error(`[planning] LLM planning failed, continuing with clone: ${message}`);
      result = { success: false, errors: [`LLM error: ${message}`], raw: '' };
    }

    const contactAgentName = resolveContactAgentName(card);

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
              ...(contactAgentName ? { contact_agent_name: contactAgentName } : {}),
            },
          },
        });
        return;
      }

      // Normalize instructions and inject team contact where needed
      for (const task of data.tasks) {
        if (!task.instructions) {
          task.instructions = { agent_name: null, notes: [] };
        }
        if (contactAgentName && task.instructions.agent_name === null) {
          task.instructions.agent_name = contactAgentName;
          task.instructions.notes = [
            'Coordinate the team to implement the Scope of Work described in this card.',
            ...task.instructions.notes,
          ];
        }
      }

      if (data.tasks.length > 0) {
        // Multi-subtask path: create one card per planned task
        const createdTaskCards: { uid: string; id: string; title: string }[] = [];

        for (const task of data.tasks) {
          // Convert internal { agent_name, notes } to Record<string, string> for payload
          const instructionsPayload: Record<string, string> | undefined =
            task.instructions?.agent_name
              ? { [task.instructions.agent_name]: task.instructions.notes.join('\n\n') }
              : undefined;

          const taskPayload = {
            ...card.payload,
            parent_board_uid: card.board_uid,
            parent_card_uid: card.uid,
            task_type: task.type,
            ...(instructionsPayload ? { instructions: instructionsPayload } : {}),
            depends_on: task.depends_on,
            acceptance: task.acceptance,
            risk: task.risk,
          };

          const description = buildPlannedTaskCardDescription(task);

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
              ...(contactAgentName ? { contact_agent_name: contactAgentName } : {}),
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
      ...(contactAgentName ? { contact_agent_name: contactAgentName } : {}),
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
