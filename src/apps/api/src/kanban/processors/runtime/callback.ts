export function fireAndForgetCallback(
  url: string,
  payload: Record<string, unknown>,
  processorId?: string,
): void {
  fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer processor' },
    body: JSON.stringify(payload),
  }).catch((err) => {
    if (processorId) {
      console.error(
        `[${processorId}] Callback failed:`,
        err instanceof Error ? err.message : String(err),
      );
    }
    // Silently ignored when no processorId (matches generic context-routes behaviour).
  });
}
