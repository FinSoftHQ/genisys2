import { execFilePromise } from './exec-helpers.js';

export async function hasWorkingTreeChanges(workspacePath: string): Promise<boolean> {
  const { stdout } = await execFilePromise('git', ['status', '--porcelain'], { cwd: workspacePath, timeout: 10_000 });
  return stdout.trim().length > 0;
}

/**
 * Returns the number of commits on `branch` that have not yet been pushed to its
 * remote tracking branch.  Returns **-1** when the count cannot be determined
 * (e.g. the branch does not exist locally, `origin/HEAD` is unresolvable, or any
 * git command fails unexpectedly).
 *
 * Callers must treat -1 as truthy (`count !== 0`): "unknown" conservatively means
 * "there might be unpushed commits".
 */
export async function countUnpushedCommits(workspacePath: string, branch: string): Promise<number> {
  try {
    const { stdout } = await execFilePromise(
      'git', ['rev-list', '--count', `origin/${branch}..${branch}`],
      { cwd: workspacePath, timeout: 10_000 },
    );
    return parseInt(stdout.trim(), 10) || 0;
  } catch {
    try {
      const { stdout: baseBranch } = await execFilePromise(
        'git', ['rev-parse', '--abbrev-ref', 'origin/HEAD'],
        { cwd: workspacePath, timeout: 10_000 },
      );
      const base = baseBranch.trim().replace('origin/', '');
      const { stdout } = await execFilePromise(
        'git', ['rev-list', '--count', `${base}..${branch}`],
        { cwd: workspacePath, timeout: 10_000 },
      );
      return parseInt(stdout.trim(), 10) || 0;
    } catch {
      return -1; // unknown — treat as "might have commits"
    }
  }
}

export async function branchExists(workspacePath: string, branch: string): Promise<boolean> {
  try {
    await execFilePromise('git', ['show-ref', '--verify', '--quiet', `refs/heads/${branch}`], { cwd: workspacePath, timeout: 10_000 });
    return true;
  } catch {
    return false;
  }
}

export type PullRequestLookupResult =
  | { exists: true }
  | { exists: false; reason: string };

export async function lookupPullRequest(workspacePath: string, branch: string): Promise<PullRequestLookupResult> {
  try {
    await execFilePromise('gh', ['pr', 'view', branch], { cwd: workspacePath, timeout: 10_000 });
    return { exists: true };
  } catch (err) {
    return { exists: false, reason: err instanceof Error ? err.message : String(err) };
  }
}

export async function hasPullRequest(workspacePath: string, branch: string): Promise<boolean> {
  const result = await lookupPullRequest(workspacePath, branch);
  return result.exists;
}

export async function stageAll(workspacePath: string): Promise<void> {
  await execFilePromise('git', ['add', '.'], { cwd: workspacePath, timeout: 30_000 });
}

export async function getStagedFiles(workspacePath: string): Promise<string[]> {
  const { stdout } = await execFilePromise('git', ['diff', '--cached', '--name-only'], { cwd: workspacePath, timeout: 10_000 });
  return stdout.trim().split('\n').filter(Boolean);
}

export async function commit(workspacePath: string, message: string): Promise<void> {
  await execFilePromise('git', ['commit', '-m', message], { cwd: workspacePath, timeout: 30_000 });
}

export async function pushBranch(workspacePath: string, branch: string): Promise<void> {
  await execFilePromise('git', ['push', 'origin', branch], { cwd: workspacePath, timeout: 60_000 });
}

export async function verifyGhAuth(workspacePath: string): Promise<string> {
  const { stdout } = await execFilePromise('gh', ['auth', 'status'], { cwd: workspacePath, timeout: 10_000 });
  return stdout;
}

export async function createPullRequest(
  workspacePath: string,
  title: string,
  body: string,
): Promise<void> {
  await execFilePromise('gh', ['pr', 'create', '--title', title, '--body', body], { cwd: workspacePath, timeout: 30_000 });
}
