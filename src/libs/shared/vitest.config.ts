import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: ['src/libs/shared/**/*.test.ts', 'src/libs/shared/**/*.spec.ts'],
  },
});
