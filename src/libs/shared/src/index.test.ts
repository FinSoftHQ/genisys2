import { describe, it, expect } from 'vitest';
import { UserSchema } from './index.js';

describe('shared', () => {
  it('validates a user with strict schema', () => {
    const result = UserSchema.safeParse({
      id: '550e8400-e29b-41d4-a716-446655440000',
      name: 'Alice',
      email: 'alice@example.com',
    });
    expect(result.success).toBe(true);
  });

  it('rejects extra properties due to strict', () => {
    const result = UserSchema.safeParse({
      id: '550e8400-e29b-41d4-a716-446655440000',
      name: 'Alice',
      email: 'alice@example.com',
      extra: true,
    });
    expect(result.success).toBe(false);
  });
});
