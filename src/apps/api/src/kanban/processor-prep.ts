import type { FastifyInstance } from 'fastify';
import { access, constants, readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
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
import { parseProtocolFromString } from '@repo/shared';

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
    console.error('[prep] Callback failed:', err instanceof Error ? err.message : String(err));
  });
}

const GITHUB_URL_REGEX = /(?:https?:\/\/github\.com\/[^\/\s]+\/[^\/\s]+(?:\.git)?|git@github\.com[^:\s]*:[^\/\s]+\/[^\/\s]+(?:\.git)?)/i;

function parseCardDescription(description: string | null | undefined): {
  repo?: string;
  teamName?: string;
  tailorShop?: string;
  body?: string;
  team?: Record<string, string>;
  routes?: Record<string, string[]>;
  facilitator?: string;
  workingDir?: string;
  instructions?: Record<string, string>;
} {
  if (!description || !description.startsWith('---')) {
    return {};
  }
  try {
    const parsed = parseProtocolFromString(description, { requireTeam: false });
    const result: ReturnType<typeof parseCardDescription> = {
      ...(parsed.repo ? { repo: parsed.repo } : {}),
      ...(parsed.teamName ? { teamName: parsed.teamName } : {}),
      ...(parsed.body ? { body: parsed.body } : {}),
      ...(parsed.team && Object.keys(parsed.team).length > 0 ? { team: parsed.team } : {}),
      ...(parsed.routes && Object.keys(parsed.routes).length > 0 ? { routes: parsed.routes } : {}),
      ...(parsed.facilitator ? { facilitator: parsed.facilitator } : {}),
      ...(parsed.workingDir ? { workingDir: parsed.workingDir } : {}),
      ...(parsed.instructions && Object.keys(parsed.instructions).length > 0 ? { instructions: parsed.instructions } : {}),
    };
    if (parsed.teamName) {
      const tailorShopPath = resolve(process.cwd(), '../../..', 'teams', parsed.teamName);
      console.log('[prep] Resolving team_name:', parsed.teamName, 'cwd:', process.cwd(), 'resolved:', tailorShopPath);
      result.tailorShop = tailorShopPath;
    }
    return result;
  } catch (_err) {
    return {};
  }
}

function extractRepositoryUrl(card: { payload?: Record<string, unknown>; description?: string | null }): string | undefined {
  const fromPayload = card.payload?.repository_url;
  if (typeof fromPayload === 'string' && fromPayload.trim().length > 0) {
    return fromPayload.trim();
  }
  const parsed = parseCardDescription(card.description);
  if (parsed.repo) {
    return parsed.repo;
  }
  const fromDescription = card.description ?? '';
  const match = fromDescription.match(GITHUB_URL_REGEX);
  if (match) {
    return match[0];
  }
  return undefined;
}

function getWorkspacePath(displayId: string): string {
  const root = process.env.WORKSPACE_ROOT ?? './.workspaces';
  return resolve(root, displayId);
}

const JUSTFILE_CANDIDATES = ['justfile', 'Justfile', '.justfile', '.Justfile'];
const LLM_CONTEXT_PATH = 'llm_context.md';

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function justfileHasRecipe(contents: string, recipeName: string): boolean {
  const escaped = escapeRegExp(recipeName);
  const recipeDefinition = new RegExp(`^@?${escaped}(?=$|\\s|:)(?!\\s*:=).*:(?![=])`, 'm');
  return recipeDefinition.test(contents);
}

async function findJustfileWithRecipe(workspacePath: string, recipeName: string): Promise<string | undefined> {
  for (const candidate of JUSTFILE_CANDIDATES) {
    const candidatePath = join(workspacePath, candidate);
    try {
      await access(candidatePath);
      const contents = await readFile(candidatePath, 'utf8');
      if (justfileHasRecipe(contents, recipeName)) {
        return candidatePath;
      }
    } catch (err) {
      const code = typeof err === 'object' && err !== null && 'code' in err ? (err as { code?: string }).code : undefined;
      if (code !== 'ENOENT' && code !== 'ENOTDIR') {
        throw err;
      }
    }
  }
  return undefined;
}

async function runJustRecipeIfAvailable(workspacePath: string, recipeName: string): Promise<boolean> {
  const justfilePath = await findJustfileWithRecipe(workspacePath, recipeName);
  if (!justfilePath) {
    console.log(`[prep] No just ${recipeName} recipe found in ${workspacePath}; skipping`);
    return false;
  }

  console.log(`[prep] Running just ${recipeName} in ${workspacePath}`);
  await execFilePromise('just', ['--justfile', justfilePath, recipeName], { cwd: workspacePath, timeout: 600_000 });
  return true;
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

async function generateLlmContextForPrep(workspacePath: string, displayId: string): Promise<void> {
  const contextGeneratorPath = await resolveExecutablePath('context-generator');
  const outputPath = join(workspacePath, LLM_CONTEXT_PATH);

  console.log(`[prep] Card ${displayId}: running context-generator for ${LLM_CONTEXT_PATH}`);
  await execFilePromise(
    contextGeneratorPath,
    ['-e', '.agents', '-e', 'tools', '-r', workspacePath, '-o', outputPath],
    { cwd: workspacePath, timeout: 60_000 },
  );
  console.log(`[prep] Card ${displayId}: generated ${LLM_CONTEXT_PATH}`);
}

async function runPrepWorkflow(
  card: { display_id: string; payload?: Record<string, unknown>; description?: string | null },
  callbackUrl: string,
) {
  try {
    const parsed = parseCardDescription(card.description);
    const repositoryUrl = extractRepositoryUrl(card);
    if (!repositoryUrl) {
      fireAndForgetCallback(callbackUrl, {
        status: 'error',
        error_message: 'Prep failed: missing repository_url in payload or description',
      });
      return;
    }

    const workspacePath = getWorkspacePath(card.display_id);
    console.log(`[prep] Card ${card.display_id}: cloning ${repositoryUrl} into ${workspacePath}`);
    console.log('[prep] Parsed description for card', card.display_id, '→ repo:', repositoryUrl, 'tailor_shop:', parsed.tailorShop);

    // 1. Clone
    await execFilePromise('git', ['clone', repositoryUrl, workspacePath], { timeout: 120_000 });

    // 2. Configure git
    await execFilePromise('git', ['config', 'user.name', 'Teerachai Laothong'], { cwd: workspacePath });
    await execFilePromise('git', ['config', 'user.email', 'teerachai@finsoft2023.com'], { cwd: workspacePath });

    // 3. Create branch
    await execFilePromise('git', ['checkout', '-b', `surii/${card.display_id}`], { cwd: workspacePath });

    // 4. Run optional project preparation recipes from justfile, if present
    await runJustRecipeIfAvailable(workspacePath, 'bootup');
    await runJustRecipeIfAvailable(workspacePath, 'build-tools');

    // 5. Generate llm_context.md as the last prep step
    await generateLlmContextForPrep(workspacePath, card.display_id);

    // 6. Success callback
    console.log(`[prep] Card ${card.display_id}: success, moving to planning`);
    const updatedPayload: Record<string, unknown> = {
      ...card.payload,
      working_dir: parsed.workingDir ?? workspacePath,
      repository_url: repositoryUrl,
      llm_context_md: LLM_CONTEXT_PATH,
      ...(parsed.repo ? { repo: parsed.repo } : {}),
      ...(parsed.tailorShop ? { tailor_shop: parsed.tailorShop } : {}),
      ...(parsed.teamName ? { team_name: parsed.teamName } : {}),
      ...(parsed.team ? { team: parsed.team } : {}),
      ...(parsed.routes ? { routes: parsed.routes } : {}),
      ...(parsed.facilitator ? { facilitator: parsed.facilitator } : {}),

      ...(parsed.instructions ? { instructions: parsed.instructions } : {}),
      ...(parsed.body ? { body: parsed.body } : {}),
    };
    fireAndForgetCallback(callbackUrl, {
      status: 'success',
      payload_updates: {
        payload: updatedPayload,
      },
      move_to_column: 'planning',
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[prep] Card ${card.display_id}: ${message}`);
    fireAndForgetCallback(callbackUrl, {
      status: 'error',
      error_message: `Prep failed: ${message}`.slice(0, 500),
    });
  }
}

export async function prepProcessorRoutes(instance: FastifyInstance): Promise<void> {
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

    // Run prep workflow asynchronously and fire-and-forget the callback
    runPrepWorkflow(body.data.card, body.data.callback_url);

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
