import type { FastifyInstance } from 'fastify';
import { access, constants, mkdir, readFile, writeFile } from 'node:fs/promises';
import { join, resolve, sep } from 'node:path';
import { complete, getModel } from '@mariozechner/pi-ai';
import { getApiKey } from '../lib/ai-auth.js';
import { execFilePromise } from './exec-helpers.js';
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

type ExtractTarget = {
  file: string;
  start_line?: number;
  end_line?: number;
  reasoning?: string;
};

type ExploreCard = {
  display_id: string;
  title?: string;
  description?: string | null;
  payload?: Record<string, unknown>;
};

const DEFAULT_EXTRACT_REASONING = 'Mission-relevant context file.';
const SOW_PATH = '.dossier/sow.md';
const LLM_CONTEXT_PATH = 'llm_context.md';
const EXTRACT_TARGET_JSONL_PATH = '.dossier/llm_extract_target.jsonl';
const LLM_TARGET_MD_PATH = 'llm_target.md';
const EXTRACT_MODEL_PROVIDER = 'opencode-go';
const EXTRACT_MODEL_ID = 'deepseek-v4-flash';
const PROMPT_FILE_CHAR_LIMIT = Number(process.env.EXPLORE_PROMPT_FILE_CHAR_LIMIT ?? '120000');

const EXTRACT_TARGET_PROMPT = `You are a repository context curator. Your task is to generate a valid JSONL input file for \`.bin/context-extractor\`.

The generated JSONL will later be passed to:

\`\`\`bash
.bin/context-extractor --input <your-output>.jsonl --output llm_target.md
\`\`\`

The goal of llm_target.md is to help developers and AI LLMs quickly understand and work on this repository for the mission described in .dossier/sow.md.

## Required files to read first

Before generating the JSONL, read and use:

1. .dossier/sow.md
    - This is the mission / statement of work.
    - The generated context must be optimized for completing this mission.
2. llm_context.md
    - This is a repository-wide context file.
    - Use it as an index/map of the project structure and existing code.
    - Do not automatically include the entire llm_context.md in the JSONL unless it is small and directly useful.
    - Prefer selecting original source files, docs, configs, tests, and schemas referenced by llm_context.md.

You may inspect additional repository files as needed to verify paths, line numbers, and relevance.

## Output format

Output ONLY valid JSONL.

Do not output Markdown.
Do not wrap the output in code fences.
Do not add explanations before or after the JSONL.
Do not add comments.
Do not add trailing commas.

Each line must be a standalone JSON object matching this shape:

\`\`\`json
{"file":"relative/path/from/repo/root","start_line":1,"end_line":100,"reasoning":"Short reason this file or range is useful for the mission"}
\`\`\`

### Allowed fields:

- file: required string. Path to an existing file, preferably relative to the repository root.
- start_line: optional positive integer, 1-based inclusive.
- end_line: optional positive integer, 1-based inclusive.
- reasoning: optional string, but you should include it for every line.

If extracting a whole file, omit start_line and end_line:

\`\`\`json
{"file":"package.json","reasoning":"Root package metadata and scripts needed to understand how to work with the project."}
\`\`\`

If extracting a specific range, include both:

\`\`\`json
{"file":"src/example.ts","start_line":20,"end_line":80,"reasoning":"Core implementation related to the mission."}
\`\`\`

If extracting from a line to the end of a file, include only start_line:

\`\`\`json
{"file":"src/example.ts","start_line":120,"reasoning":"Remaining implementation after the main exported API."}
\`\`\`

## Selection goals

Select the smallest useful set of files and ranges that allows a developer or LLM to understand and complete the mission.

Always include:

1. .dossier/sow.md
    - Put this as the first JSONL line.

Usually include, if relevant and present:

2. Root project metadata:
    - README.md
    - package.json
    - workspace config files
    - build/test/lint config files
    - framework config files
3. Mission-relevant source files:
    - Main entry points
    - Core modules
    - Public APIs
    - Domain logic
    - Types/interfaces/schemas
    - Utilities directly involved in the mission
4. Mission-relevant tests:
    - Existing tests for affected behavior
    - Integration/e2e tests touching the mission area
    - Fixtures or mocks needed to understand tests
5. Documentation:
    - Architecture docs
    - API docs
    - Feature docs
    - Implementation plans
    - Any docs mentioned by .dossier/sow.md or llm_context.md
6. Generated or schema files only if they are required to understand contracts.

## What to avoid

Do not include:

- Large unrelated files.
- Lockfiles (e.g. pnpm-lock.yaml, package-lock.json, yarn.lock, bun.lockb, Cargo.lock, poetry.lock, Gemfile.lock). Exclude them unless the mission specifically requires analyzing dependency changes.
- node_modules, build output, and cache directories.
- Entire huge files when a focused range is enough.
- Binary files.
- Duplicate ranges unless there is a clear reason.
- Files that do not exist.
- Directories or glob patterns.
- Line numbers that are zero, negative, or obviously out of bounds.
- Ranges where end_line is less than start_line.

Do not include llm_context.md by default. Use it to decide what original files to include. Only include llm_context.md if it contains unique human-written
project guidance that is not available elsewhere, or if the mission specifically asks for it.

## Range-selection guidance

Use whole-file extraction for:

- Small files.
- Config files.
- Type/schema files that are easier to understand whole.
- Tests where the entire test file is relevant.
- Markdown docs that are directly relevant.

Use line ranges for:

- Large source files where only certain classes/functions/routes/components matter.
- Large docs where only certain sections matter.
- Files with multiple unrelated modules.

When using line ranges:

- Include enough surrounding context: imports, exported types, function/class definitions, nearby helpers, and relevant comments.
- Prefer one larger coherent range over many tiny disconnected ranges.
- If most of a file is relevant, include the whole file.

## Reasoning field requirements

Every JSONL line should include a concise reasoning value.

Good reasoning examples:

- "Mission statement; include first so downstream readers understand the requested work."
- "Root package scripts and dependencies needed to run and test the project."
- "Core implementation for the feature area described in the SOW."
- "Tests covering the behavior likely to be modified for this mission."
- "Shared schema used by the API and frontend for this workflow."

Keep reasoning short and specific.

## Validation checklist before final output

Before producing the final JSONL:

1. Confirm every file path exists.
2. Confirm all paths are relative to the repository root when possible.
3. Confirm each line is valid JSON.
4. Confirm there is exactly one JSON object per line.
5. Confirm no Markdown, prose, comments, or code fences are included.
6. Confirm all line numbers are positive integers.
7. Confirm each range is relevant to the mission.
8. Confirm the selected context is sufficient but not excessive.

## Final output

Produce only the JSONL content.
Optional first few lines your generated JSONL will often start with:

\`\`\`jsonl
{"file":".dossier/sow.md","reasoning":"Mission statement; include first so downstream readers understand the requested work."}
{"file":"README.md","reasoning":"High-level project overview and usage guidance."}
{"file":"package.json","reasoning":"Project scripts, dependencies, and workspace metadata needed to run and test changes."}
 \`\`\`

Write the JSONL content to file \`.dossier/llm_extract_target.jsonl\``;

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
    console.error('[explore] Callback failed:', err instanceof Error ? err.message : String(err));
  });
}

function buildSowContentFromCard(card: ExploreCard): string {
  const missionBody = typeof card.payload?.body === 'string' && card.payload.body.trim().length > 0
    ? card.payload.body.trim()
    : typeof card.description === 'string' && card.description.trim().length > 0
      ? card.description.trim()
      : typeof card.title === 'string' && card.title.trim().length > 0
        ? card.title.trim()
        : 'No mission details were provided in the card body.';

  const title = typeof card.title === 'string' && card.title.trim().length > 0
    ? card.title.trim()
    : card.display_id;

  return `# Statement of Work\n\n## Card\n- Display ID: ${card.display_id}\n- Title: ${title}\n\n## Mission\n${missionBody}\n`;
}

async function writeCardContentToSow(workingDir: string, card: ExploreCard): Promise<void> {
  const dossierDir = join(workingDir, '.dossier');
  await mkdir(dossierDir, { recursive: true });
  const sowPath = join(workingDir, SOW_PATH);
  await writeFile(sowPath, buildSowContentFromCard(card), 'utf8');
  console.log(`[explore] Card ${card.display_id}: wrote ${SOW_PATH}`);
}

function trimForPrompt(name: string, content: string): string {
  if (content.length <= PROMPT_FILE_CHAR_LIMIT) {
    return content;
  }
  const omitted = content.length - PROMPT_FILE_CHAR_LIMIT;
  return `${content.slice(0, PROMPT_FILE_CHAR_LIMIT)}\n\n[TRUNCATED ${omitted} characters from ${name}]`;
}

function buildExtractTargetPrompt(workingDir: string, sowContent: string, llmContextContent: string): string {
  return `${EXTRACT_TARGET_PROMPT}

## Repository root path
${workingDir}

## File contents provided for required reads

### BEGIN ${SOW_PATH}
${trimForPrompt(SOW_PATH, sowContent)}
### END ${SOW_PATH}

### BEGIN ${LLM_CONTEXT_PATH}
${trimForPrompt(LLM_CONTEXT_PATH, llmContextContent)}
### END ${LLM_CONTEXT_PATH}

Follow all rules above strictly. Output only JSONL.`;
}

function normalizeFilePath(file: string): string {
  return file.replace(/\\/g, '/').replace(/^\.\//, '').trim();
}

function isWithinDirectory(rootDir: string, targetPath: string): boolean {
  const resolvedRoot = resolve(rootDir);
  const resolvedTarget = resolve(targetPath);
  if (resolvedTarget === resolvedRoot) return true;
  return resolvedTarget.startsWith(`${resolvedRoot}${sep}`);
}

function parseTargetLine(raw: Record<string, unknown>): ExtractTarget {
  const file = typeof raw.file === 'string' ? normalizeFilePath(raw.file) : '';
  if (!file) {
    throw new Error('Missing required file field in JSONL line');
  }

  const startLineRaw = raw.start_line;
  const endLineRaw = raw.end_line;

  const start_line = startLineRaw === undefined ? undefined : Number(startLineRaw);
  const end_line = endLineRaw === undefined ? undefined : Number(endLineRaw);

  if (start_line !== undefined && (!Number.isInteger(start_line) || start_line < 1)) {
    throw new Error(`Invalid start_line for ${file}`);
  }
  if (end_line !== undefined && (!Number.isInteger(end_line) || end_line < 1)) {
    throw new Error(`Invalid end_line for ${file}`);
  }
  if (start_line !== undefined && end_line !== undefined && end_line < start_line) {
    throw new Error(`Invalid range for ${file}: end_line < start_line`);
  }

  const reasoning = typeof raw.reasoning === 'string' && raw.reasoning.trim().length > 0
    ? raw.reasoning.trim()
    : DEFAULT_EXTRACT_REASONING;

  return {
    file,
    ...(start_line !== undefined ? { start_line } : {}),
    ...(end_line !== undefined ? { end_line } : {}),
    reasoning,
  };
}

function parseLlmJsonl(rawText: string): ExtractTarget[] {
  const lines = rawText
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith('```'));

  const targets: ExtractTarget[] = [];

  for (const line of lines) {
    if (!line.startsWith('{') || !line.endsWith('}')) {
      continue;
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      continue;
    }

    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      continue;
    }

    targets.push(parseTargetLine(parsed as Record<string, unknown>));
  }

  if (targets.length === 0) {
    throw new Error('LLM returned no valid JSONL target lines');
  }

  return targets;
}

function ensureSowFirst(targets: ExtractTarget[]): ExtractTarget[] {
  const sowIndex = targets.findIndex((target) => normalizeFilePath(target.file) === SOW_PATH);

  const sowTarget: ExtractTarget = sowIndex >= 0
    ? {
        ...targets[sowIndex],
        file: SOW_PATH,
        reasoning: targets[sowIndex].reasoning ?? 'Mission statement; include first so downstream readers understand the requested work.',
      }
    : {
        file: SOW_PATH,
        reasoning: 'Mission statement; include first so downstream readers understand the requested work.',
      };

  const withoutSow = targets.filter((_target, index) => index !== sowIndex);
  return [sowTarget, ...withoutSow];
}

function dedupeTargets(targets: ExtractTarget[]): ExtractTarget[] {
  const seen = new Set<string>();
  const deduped: ExtractTarget[] = [];

  for (const target of targets) {
    const key = `${normalizeFilePath(target.file)}::${target.start_line ?? ''}::${target.end_line ?? ''}`;
    if (seen.has(key)) continue;
    seen.add(key);
    deduped.push(target);
  }

  return deduped;
}

async function validateTargets(workingDir: string, targets: ExtractTarget[]): Promise<ExtractTarget[]> {
  const fileLineCountCache = new Map<string, number>();

  async function getLineCount(absolutePath: string): Promise<number> {
    const cached = fileLineCountCache.get(absolutePath);
    if (cached !== undefined) return cached;

    const content = await readFile(absolutePath, 'utf8');
    const lineCount = content.length === 0 ? 0 : content.split(/\r?\n/).length;
    fileLineCountCache.set(absolutePath, lineCount);
    return lineCount;
  }

  const validated: ExtractTarget[] = [];

  for (const target of targets) {
    const normalizedFile = normalizeFilePath(target.file);
    const absolutePath = resolve(workingDir, normalizedFile);

    if (!isWithinDirectory(workingDir, absolutePath)) {
      throw new Error(`Target file is outside repository root: ${normalizedFile}`);
    }

    await access(absolutePath, constants.F_OK);

    const normalizedTarget: ExtractTarget = {
      file: normalizedFile,
      ...(target.start_line !== undefined ? { start_line: target.start_line } : {}),
      ...(target.end_line !== undefined ? { end_line: target.end_line } : {}),
      reasoning: target.reasoning?.trim() || DEFAULT_EXTRACT_REASONING,
    };

    // end_line without start_line is treated as full-file extraction by context-extractor.
    // Drop end_line to keep JSONL canonical and always valid.
    if (normalizedTarget.start_line === undefined && normalizedTarget.end_line !== undefined) {
      delete normalizedTarget.end_line;
    }

    if (normalizedTarget.start_line !== undefined || normalizedTarget.end_line !== undefined) {
      const lineCount = await getLineCount(absolutePath);

      if (normalizedTarget.start_line !== undefined && normalizedTarget.start_line > lineCount) {
        throw new Error(`start_line ${normalizedTarget.start_line} out of bounds for ${normalizedFile} (${lineCount} lines)`);
      }

      if (normalizedTarget.end_line !== undefined && normalizedTarget.end_line > lineCount) {
        normalizedTarget.end_line = lineCount;
      }

      if (
        normalizedTarget.start_line !== undefined
        && normalizedTarget.end_line !== undefined
        && normalizedTarget.end_line < normalizedTarget.start_line
      ) {
        throw new Error(`Invalid range for ${normalizedFile}: end_line < start_line after normalization`);
      }
    }

    validated.push(normalizedTarget);
  }

  return validated;
}

function stringifyTargetsJsonl(targets: ExtractTarget[]): string {
  return `${targets.map((target) => JSON.stringify(target)).join('\n')}\n`;
}

async function resolveExecutablePath(binaryName: string): Promise<string> {
  const candidates = [
    resolve(process.cwd(), '.bin', binaryName),
    resolve(process.cwd(), '../../..', '.bin', binaryName),
  ];

  for (const candidate of candidates) {
    try {
      await access(candidate, constants.X_OK);
      return candidate;
    } catch {
      // Try next candidate.
    }
  }

  throw new Error(`Executable not found or not executable: ${binaryName}`);
}

async function generateExtractorTargets(workingDir: string): Promise<void> {
  const sowPath = join(workingDir, SOW_PATH);
  const llmContextPath = join(workingDir, LLM_CONTEXT_PATH);

  const [sowContent, llmContextContent] = await Promise.all([
    readFile(sowPath, 'utf8'),
    readFile(llmContextPath, 'utf8'),
  ]);

  const preferredModel = getModel(EXTRACT_MODEL_PROVIDER, EXTRACT_MODEL_ID);
  const apiKey = await getApiKey(preferredModel.provider);

  console.log('[explore] Generating context-extractor JSONL with LLM');

  const response = await complete(
    preferredModel,
    {
      messages: [
        {
          role: 'user',
          content: buildExtractTargetPrompt(workingDir, sowContent, llmContextContent),
          timestamp: Date.now(),
        },
      ],
    },
    { apiKey },
  );

  if (response.stopReason === 'error') {
    throw new Error(response.errorMessage || 'LLM provider error while generating extract targets');
  }

  const llmText = response.content
    .filter((part) => part.type === 'text')
    .map((part) => (part as { text: string }).text)
    .join('')
    .trim();

  if (!llmText) {
    throw new Error('LLM returned empty content for extract targets');
  }

  const parsedTargets = parseLlmJsonl(llmText);
  const targetsWithSowFirst = ensureSowFirst(parsedTargets);
  const dedupedTargets = dedupeTargets(targetsWithSowFirst);
  const validatedTargets = await validateTargets(workingDir, dedupedTargets);

  const dossierDir = join(workingDir, '.dossier');
  await mkdir(dossierDir, { recursive: true });

  const jsonlPath = join(workingDir, EXTRACT_TARGET_JSONL_PATH);
  await writeFile(jsonlPath, stringifyTargetsJsonl(validatedTargets), 'utf8');

  console.log(`[explore] Wrote ${validatedTargets.length} JSONL targets to ${jsonlPath}`);
}

async function runContextExtractor(workingDir: string): Promise<void> {
  const contextExtractorPath = await resolveExecutablePath('context-extractor');

  console.log('[explore] Running context-extractor');
  await execFilePromise(
    contextExtractorPath,
    ['-i', EXTRACT_TARGET_JSONL_PATH, '-o', LLM_TARGET_MD_PATH],
    { cwd: workingDir, timeout: 120_000 },
  );
  console.log('[explore] context-extractor completed');
}

async function runExploreWorkflow(card: ExploreCard, callbackUrl: string) {
  const workingDir = typeof card.payload?.working_dir === 'string' ? card.payload.working_dir.trim() : process.cwd();
  const warnings: string[] = [];
  const generatedFiles: string[] = [];
  let targetGenerated = false;

  const recordGeneratedFile = (relativePath: string) => {
    if (!generatedFiles.includes(relativePath)) {
      generatedFiles.push(relativePath);
    }
  };

  const addWarning = (message: string, err?: unknown) => {
    const details = err instanceof Error ? err.message : err ? String(err) : '';
    const fullMessage = details ? `${message}: ${details}` : message;
    warnings.push(fullMessage);
    console.warn(`[explore] Card ${card.display_id}: ${fullMessage}`);
  };

  try {
    console.log(`[explore] Card ${card.display_id}: starting workflow in ${workingDir}`);

    // Step 1: write card mission content to .dossier/sow.md
    try {
      await writeCardContentToSow(workingDir, card);
      recordGeneratedFile(SOW_PATH);
    } catch (err) {
      addWarning('Failed to write .dossier/sow.md from card content', err);
    }

    // Step 2: build repository map (best effort)
    try {
      const contextGeneratorPath = await resolveExecutablePath('context-generator');
      console.log(`[explore] Card ${card.display_id}: running context-generator`);
      await execFilePromise(
        contextGeneratorPath,
        ['-e', '.agents', '-e', 'tools', '-r', workingDir, '-o', join(workingDir, LLM_CONTEXT_PATH)],
        { cwd: workingDir, timeout: 60_000 },
      );
      console.log(`[explore] Card ${card.display_id}: context-generator completed`);
      recordGeneratedFile(LLM_CONTEXT_PATH);
    } catch (err) {
      const code = typeof err === 'object' && err !== null && 'code' in err ? (err as { code?: string }).code : undefined;
      if (code === 'ENOENT') {
        addWarning('context-generator not found, skipping llm_context.md refresh');
      } else {
        addWarning('context-generator failed', err);
      }
    }

    // Step 3: generate JSONL targets + run context-extractor (best effort)
    try {
      await generateExtractorTargets(workingDir);
      recordGeneratedFile(EXTRACT_TARGET_JSONL_PATH);
      await runContextExtractor(workingDir);
      recordGeneratedFile(LLM_TARGET_MD_PATH);
      targetGenerated = true;
    } catch (err) {
      addWarning('Failed to generate llm_target.md', err);
    }
  } catch (err) {
    addWarning('Unexpected explore workflow failure', err);
  }

  if (generatedFiles.length > 0) {
    console.log(`[explore] Card ${card.display_id}: generated files -> ${generatedFiles.join(', ')}`);
  } else {
    console.warn(`[explore] Card ${card.display_id}: generated files -> none`);
  }

  const existingBody = typeof card.payload?.body === 'string' ? card.payload.body : '';
  const targetNote = targetGenerated
    ? '\n\n## Mission Context Extract\n\nMission-focused extracted context is available in \'llm_target.md\' (generated from \'.dossier/llm_extract_target.jsonl\'). Use \'llm_target.md\' as your primary context for implementation.'
    : '\n\n## Mission Context Extract\n\nUse \'llm_target.md\' (generated from \'.dossier/llm_extract_target.jsonl\') when available. If it is missing, continue with source files directly.';

  const warningNote = warnings.length > 0
    ? `\n\n## Explore Warnings\n${warnings.map((w) => `- ${w}`).join('\n')}`
    : '';

  const updatedBody = existingBody + targetNote + warningNote;

  const updatedPayload: Record<string, unknown> = {
    ...card.payload,
    body: updatedBody,
    llm_extract_target_jsonl: EXTRACT_TARGET_JSONL_PATH,
    llm_target_md: LLM_TARGET_MD_PATH,
    generated_files: generatedFiles,
    ...(warnings.length > 0 ? { explore_warnings: warnings } : {}),
  };

  console.log(`[explore] Card ${card.display_id}: moving to agentic-team`);
  fireAndForgetCallback(callbackUrl, {
    status: 'success',
    move_to_column: 'agentic-team',
    payload_updates: {
      payload: updatedPayload,
    },
  });
}

export async function exploreProcessorRoutes(instance: FastifyInstance): Promise<void> {
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

    runExploreWorkflow(body.data.card, body.data.callback_url);

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
