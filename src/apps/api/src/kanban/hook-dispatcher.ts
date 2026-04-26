import {
  CanExitHookResponseSchema,
  SyncHookDispatchRequestSchema,
  type ProcessorRegistryEntity,
  type CanExitHookResponse,
} from '@repo/shared';

export async function dispatchSyncHook(
  processorOrContext: ProcessorRegistryEntity | unknown,
  hookOrRequest: string | { hook: string; processor_id: string; timeout_ms?: number },
  payload: Record<string, unknown>,
): Promise<CanExitHookResponse> {
  let hookName: string;
  let processor: ProcessorRegistryEntity;

  if (typeof hookOrRequest === 'string') {
    hookName = hookOrRequest;
    processor = processorOrContext as ProcessorRegistryEntity;
  } else {
    const dispatchRequest = SyncHookDispatchRequestSchema.parse(hookOrRequest);
    hookName = dispatchRequest.hook;
    if (
      processorOrContext &&
      typeof processorOrContext === 'object' &&
      'base_url' in processorOrContext
    ) {
      processor = processorOrContext as ProcessorRegistryEntity;
    } else {
      processor = {
        processor_id: dispatchRequest.processor_id,
        name: 'Default Manual Processor',
        base_url: 'http://localhost:4001',
        health_endpoint: '/health',
        hooks: ['on-enter', 'on-update', 'on-action', 'can-exit', 'on-exit'],
        sla_seconds: 300,
        max_sla_seconds: 86400,
        auth_type: 'none',
        auth_config: null,
        hmac_secret: 'dev-secret',
        status: 'healthy',
        last_health_check: new Date().toISOString(),
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      } as ProcessorRegistryEntity;
    }
  }

  const controller = new AbortController();

  const timeoutPromise = new Promise<never>((_, reject) => {
    setTimeout(() => {
      controller.abort();
      reject(new Error('Hook dispatch timed out after 3000ms'));
    }, 3000);
  });

  try {
    const response = await Promise.race([
      fetch(`${processor.base_url}/${hookName}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
        signal: controller.signal,
      }),
      timeoutPromise,
    ]);

    if (!response.ok) {
      throw new Error(`Hook request failed with status ${response.status}`);
    }

    const data = await response.json();
    return CanExitHookResponseSchema.parse(data);
  } catch (err) {
    throw err;
  }
}
