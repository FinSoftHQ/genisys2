import { z } from 'zod';
import {
  ApiErrorSchema,
  CardConflictResponseSchema,
  MoveCardBlockedResponseSchema,
} from '@repo/shared';
import type { ApiError, CardConflictResponse, MoveCardBlockedResponse } from '@repo/shared';

export function isFetchError(err: unknown): err is { data: unknown } {
  return typeof err === 'object' && err !== null && 'data' in err;
}

export function parseApiError(err: unknown): ApiError | null {
  if (!isFetchError(err)) return null;
  const parsed = ApiErrorSchema.safeParse(err.data);
  return parsed.success ? parsed.data : null;
}

export function parseConflictError(err: unknown): CardConflictResponse | null {
  if (!isFetchError(err)) return null;
  const parsed = CardConflictResponseSchema.safeParse(err.data);
  return parsed.success ? parsed.data : null;
}

export function parseMoveBlockedError(err: unknown): MoveCardBlockedResponse | null {
  if (!isFetchError(err)) return null;
  const parsed = MoveCardBlockedResponseSchema.safeParse(err.data);
  return parsed.success ? parsed.data : null;
}
