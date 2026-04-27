import { z } from 'zod';

const ActorSchema = z
  .string()
  .min(1)
  .max(200)
  .regex(/^[\x20-\x7E]+$/, { message: 'actor must be printable ASCII' })
  .transform((s: string) => s.trim())
  .pipe(z.string().min(1).max(200));

export function resolveActor(request: { headers: Record<string, string | string[] | undefined> }): string {
  const raw = request.headers['x-actor'];
  if (typeof raw !== 'string' || raw.trim().length === 0) {
    return 'user:anonymous';
  }
  const parsed = ActorSchema.safeParse(raw);
  return parsed.success ? parsed.data : 'user:anonymous';
}
