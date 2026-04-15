import { describe, it, expect } from 'vitest';
import { createLogger } from './index.js';

describe('logger', () => {
  it('creates a pino logger', () => {
    const logger = createLogger({ name: 'test' });
    expect(logger).toBeDefined();
  });
});
