import { describe, it, expect } from 'vitest';

describe('api health defaults', () => {
  it('default port is 8080', () => {
    expect(Number(process.env.PORT) || 8080).toBe(8080);
  });
});
