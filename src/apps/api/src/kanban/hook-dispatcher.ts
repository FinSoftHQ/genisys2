import {
  CanExitHookResponseSchema,
  SyncHookDispatchRequestSchema,
  OnEnterDispatchAcceptedResponseSchema,
  OnUpdateResponseSchema,
  type ProcessorRegistryEntity,
  type CanExitHookResponse,
  type OnUpdateResponse,
} from '@repo/shared';
import { getDefaultProcessor } from './config.js';

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
      processor = getDefaultProcessor(dispatchRequest.processor_id);
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

export async function dispatchOnUpdateHook(
  processor: ProcessorRegistryEntity,
  payload: Record<string, unknown>,
): Promise<OnUpdateResponse> {
  const controller = new AbortController();

  const timeoutPromise = new Promise<never>((_, reject) => {
    setTimeout(() => {
      controller.abort();
      reject(new Error('Hook dispatch timed out after 3000ms'));
    }, 3000);
  });

  try {
    const response = await Promise.race([
      fetch(`${processor.base_url}/on-update`, {
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
    return OnUpdateResponseSchema.parse(data);
  } catch (err) {
    throw err;
  }
}

export async function dispatchAsyncHook(
  processor: ProcessorRegistryEntity,
  hook: string,
  payload: Record<string, unknown>,
) {
  const response = await fetch(`${processor.base_url}/${hook}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });

  if (!response.ok) {
    throw new Error(`Async hook request failed with status ${response.status}`);
  }

  const data = await response.json();
  return OnEnterDispatchAcceptedResponseSchema.parse(data);
}

export function dispatchFireAndForgetHook(
  processor: ProcessorRegistryEntity,
  hook: string,
  payload: Record<string, unknown>,
): void {
  fetch(`${processor.base_url}/${hook}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  }).catch(() => {
    // Fire-and-forget: failures are silently ignored.
  });
}
