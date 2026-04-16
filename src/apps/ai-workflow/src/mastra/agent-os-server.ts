import { agentOs } from 'rivetkit/agent-os';
import { setup, actor } from 'rivetkit';
import common from '@rivet-dev/agent-os-common';
import pi from '@rivet-dev/agent-os-pi';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';

function findModuleAccessCwd(): string {
  let dir = process.cwd();
  while (true) {
    if (existsSync(join(dir, 'node_modules'))) {
      return dir;
    }
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return process.cwd();
}

const vmBase = agentOs({
  options: {
    software: [common, pi],
    moduleAccessCwd: findModuleAccessCwd(),
  },
});

// Wrap the agentOs actor with a shutdown action so callers can explicitly
// destroy the VM after a workflow run. agentOs itself does not expose custom
// actions, so we rebuild the ActorDefinition with the same config plus the
// extra action.
const vm = actor({
  ...(vmBase.config as any),
  options: {
    ...(vmBase.config as any).options,
    actionTimeout: 1_800_000, // 30 minutes
  },
  actions: {
    ...(vmBase.config as any).actions,
    shutdown: (c: any) => c.destroy(),
  },
} as any);

export const registry = setup({
  use: { vm },
  serveManager: true,
  managerPort: 6420,
});

export async function startAgentOsServer(): Promise<void> {
  await registry.start();
  console.log('[AgentOS] Registry HTTP server started on http://localhost:6420');
}
