import { configDefaults, defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: ['src/apps/api/**/*.test.ts', 'src/apps/api/**/*.test.ts'],
    exclude: [...configDefaults.exclude, '**/.workspaces/**'],
    fileParallelism: false,
  },
});
