import { defineWorkspace } from 'vitest/config';

export default defineWorkspace([
  'src/apps/*/vitest.config.ts',
  'src/libs/*/vitest.config.ts',
]);
