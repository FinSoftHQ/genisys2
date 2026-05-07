type ToastApi = {
  add: (input: unknown) => void;
};

export function useToast(): ToastApi {
  const fn = (globalThis as Record<string, unknown>).useToast;
  if (typeof fn === 'function') {
    return fn() as ToastApi;
  }
  return { add: () => {} };
}

export function definePageMeta(_meta: unknown): void {}
