import { configDefaults, defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: ['src/libs/agent-rooms-core/**/*.test.ts'],
    exclude: [...configDefaults.exclude, '**/.workspaces/**'],
    fileParallelism: false,
  },
});
