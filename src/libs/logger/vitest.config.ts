import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: ['src/libs/logger/**/*.test.ts', 'src/libs/logger/**/*.spec.ts'],
  },
});
