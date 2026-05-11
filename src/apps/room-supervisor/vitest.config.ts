import { configDefaults, defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: ['src/apps/room-supervisor/**/*.test.ts'],
    exclude: [...configDefaults.exclude, '**/.workspaces/**'],
    fileParallelism: false,
  },
});
