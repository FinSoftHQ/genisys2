import type { ProcessorRegistryEntity } from '@repo/shared';

export const API_BASE_URL = process.env.KANBAN_API_BASE_URL ?? 'http://localhost:8080';

export const DEFAULT_PROCESSOR_BASE_URL = `${API_BASE_URL}/api/kanban-processor/default`;

export function getDefaultProcessor(processorId: string): ProcessorRegistryEntity {
  const now = new Date().toISOString();
  return {
    processor_id: processorId,
    name: 'Default Manual Processor',
    base_url: `${API_BASE_URL}/api/kanban-processor/${processorId}`,
    health_endpoint: '/health',
    hooks: ['on-enter', 'on-update', 'on-action', 'can-exit', 'on-exit'],
    sla_seconds: 300,
    max_sla_seconds: 86400,
    auth_type: 'none',
    auth_config: null,
    hmac_secret: 'dev-secret',
    status: 'healthy',
    last_health_check: now,
    created_at: now,
    updated_at: now,
  } as ProcessorRegistryEntity;
}
