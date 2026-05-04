import type { FastifyInstance } from 'fastify';
import { rm } from 'node:fs/promises';
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
import * as git from './git-helpers.js';
import { execFilePromise } from './exec-helpers.js';

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
    console.error('[wrap] Callback failed:', err instanceof Error ? err.message : String(err));
  });
}

function getDevWrapupBaseUrl(): string {
  return (process.env.API_BASE_URL || `http://localhost:${process.env.PORT || 8080}`).replace(/\/$/, '');
}

function sendDone(callbackUrl: string, displayId: string): void {
  console.log(`[wrap] Card ${displayId}: success, moving to done`);
  fireAndForgetCallback(callbackUrl, { status: 'success', move_to_column: 'done' });
}

function sendError(callbackUrl: string, displayId: string, message: string): void {
  console.error(`[wrap] Card ${displayId}: ${message}`);
  fireAndForgetCallback(callbackUrl, { status: 'error', error_message: message.slice(0, 500) });
}

async function fetchDevWrapup(workspacePath: string) {
  const url = `${getDevWrapupBaseUrl()}/api/v1/dev-wrapup`;
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ workspace_path: workspacePath }),
  });
  if (!response.ok) {
    const bodyText = await response.text().catch(() => 'unknown');
    throw new Error(`dev-wrapup API returned ${response.status}: ${bodyText}`);
  }
  const data = await response.json() as {
    commit_message: string;
    pr_title: string;
    pr_body: string;
  };
  if (
    typeof data.commit_message !== 'string' ||
    typeof data.pr_title !== 'string' ||
    typeof data.pr_body !== 'string'
  ) {
    throw new Error('dev-wrapup API returned invalid response shape');
  }
  return {
    commitMessage: data.commit_message,
    prTitle: data.pr_title,
    prBody: data.pr_body,
  };
}

async function createPR(
  workspacePath: string,
  title: string,
  body: string,
  displayId: string,
) {
  console.log(
    `[wrap] Card ${displayId}: creating PR via gh CLI (title=${JSON.stringify(title)}, bodyLength=${body.length})`,
  );
  try {
    await git.createPullRequest(workspacePath, title, body);
    console.log(`[wrap] Card ${displayId}: PR created successfully`);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (/already exists|no commits between/i.test(message)) {
      console.log(`[wrap] Card ${displayId}: PR creation skipped — ${message}`);
    } else {
      console.error(`[wrap] Card ${displayId}: PR creation failed — ${message}`);
      throw err;
    }
  }
}

async function runWrapWorkflow(
  card: { display_id: string; payload?: Record<string, unknown> },
  callbackUrl: string,
) {
  const workspacePath = card.payload?.workspace_path;
  if (!workspacePath || typeof workspacePath !== 'string') {
    return sendError(callbackUrl, card.display_id, 'Wrap failed: missing workspace_path in card payload');
  }

  const branch = `surii/${card.display_id}`;

  try {
    // Phase 1: Detect if there's anything to wrap
    const hasChanges = await git.hasWorkingTreeChanges(workspacePath);
    const branchExists = await git.branchExists(workspacePath, branch);
    console.log(
      `[wrap] Card ${card.display_id}: preflight state hasChanges=${hasChanges} branchExists=${branchExists} branch=${branch}`,
    );

    // Early exit: no local branch + no working-tree changes → nothing to commit,
    // push, or PR from this workspace. Skip PR lookup entirely to avoid turning
    // a no-op into a network/auth failure.
    if (!hasChanges && !branchExists) {
      console.log(`[wrap] Card ${card.display_id}: no branch and no changes, nothing to wrap`);
      return sendDone(callbackUrl, card.display_id);
    }

    // Always call countUnpushedCommits for remaining paths — it returns -1 when
    // the answer is unknown. -1 !== 0 is truthy, preserving "might have commits"
    // semantics without special-casing.
    const unpushedCount = await git.countUnpushedCommits(workspacePath, branch);
    const hasUnpushed = unpushedCount !== 0; // -1 means unknown → treat as truthy
    console.log(
      `[wrap] Card ${card.display_id}: commit state unpushedCount=${unpushedCount} hasUnpushed=${hasUnpushed}`,
    );

    // Nothing to stage, commit, or push — no point calling dev-wrapup (the AI
    // agent would have nothing to analyse and the call would fail). Skip straight
    // to Done.
    if (!hasChanges && !hasUnpushed) {
      console.log(`[wrap] Card ${card.display_id}: no changes and no unpushed commits, nothing to wrap`);
      return sendDone(callbackUrl, card.display_id);
    }

    console.log(
      `[wrap] Card ${card.display_id}: proceeding with wrap workflow (hasChanges=${hasChanges}, hasUnpushed=${hasUnpushed})`,
    );

    // Phase 2: Stage all changes so the AI sees them
    await git.stageAll(workspacePath);

    // Phase 3: Fetch wrapup metadata
    const currentBranch = await execFilePromise('git', ['rev-parse', '--abbrev-ref', 'HEAD'], {
      cwd: workspacePath,
      timeout: 10_000,
    }).then((r) => r.stdout.trim()).catch(() => 'unknown');
    console.log(
      `[wrap] Card ${card.display_id}: calling dev-wrapup for workspace=${workspacePath}, currentBranch=${currentBranch}`,
    );
    const wrapup = await fetchDevWrapup(workspacePath);

    // Phase 4: Commit changes
    const stagedFiles = await git.getStagedFiles(workspacePath);
    if (stagedFiles.length > 0) {
      await git.commit(workspacePath, wrapup.commitMessage);
    } else {
      console.log(`[wrap] Card ${card.display_id}: no staged changes, skipping commit`);
    }

    // Phase 4: Push and create PR
    console.log(`[wrap] Card ${card.display_id}: pushing branch ${branch}`);
    await git.pushBranch(workspacePath, branch);
    console.log(`[wrap] Card ${card.display_id}: push completed for ${branch}`);

    console.log(`[wrap] Card ${card.display_id}: checking gh auth status`);
    const authStatus = await git.verifyGhAuth(workspacePath);
    console.log(`[wrap] gh auth status:\n${authStatus}`);

    await createPR(workspacePath, wrapup.prTitle, wrapup.prBody, card.display_id);

    return sendDone(callbackUrl, card.display_id);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return sendError(callbackUrl, card.display_id, `Wrap failed: ${message}`);
  }
}

export async function wrapProcessorRoutes(instance: FastifyInstance): Promise<void> {
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

    runWrapWorkflow(body.data.card, body.data.callback_url);

    return reply.status(202).send(response);
  });

  instance.post('/on-action', async (request, reply) => {
    const body = OnActionRequestSchema.safeParse(request.body);
    if (!body.success) {
      return reply.status(400).send(errorResponse('VALIDATION_ERROR', 'Invalid request body', { issues: body.error.issues }));
    }

    const response = OnEnterDispatchAcceptedResponseSchema.parse({ status: 'accepted' });

    runWrapWorkflow(body.data.card, body.data.callback_url);

    return reply.status(202).send(response);
  });

  instance.post('/on-exit', async (request, reply) => {
    const body = OnExitRequestSchema.safeParse(request.body);
    if (!body.success) {
      return reply.status(400).send(errorResponse('VALIDATION_ERROR', 'Invalid request body', { issues: body.error.issues }));
    }

    const workspacePath = body.data.card.payload?.workspace_path;
    if (typeof workspacePath === 'string') {
      rm(workspacePath, { recursive: true, force: true }).then(() => {
        console.log(`[wrap] Cleaned up workspace ${workspacePath}`);
      }).catch((err) => {
        console.error(`[wrap] Failed to clean up workspace ${workspacePath}:`, err instanceof Error ? err.message : String(err));
      });
    }

    return reply.status(200).send({ status: 'acknowledged' });
  });
}
