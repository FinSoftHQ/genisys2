export function errorResponse(
  code: string,
  message: string,
  details?: Record<string, unknown>,
): { error: { code: string; message: string; details?: Record<string, unknown> } } {
  return { error: { code, message, ...(details ? { details } : {}) } };
}
