import { defineConfig } from 'vitest/config';
import { resolve } from 'node:path';
import vue from '@vitejs/plugin-vue';

export default defineConfig({
  plugins: [vue()],
  test: {
    globals: true,
    environment: 'happy-dom',
  },
  resolve: {
    alias: {
      '#imports': resolve(__dirname, './app/test/imports-shim.ts'),
      '~': resolve(__dirname, './app'),
      '~~': resolve(__dirname, '.'),
      '@': resolve(__dirname, './app'),
    },
  },
});
