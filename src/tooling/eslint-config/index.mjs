import path from 'node:path';
import { fileURLToPath } from 'node:url';
import tseslint from 'typescript-eslint';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const monorepoRoot = path.resolve(__dirname, '../../..');

/** @type {import('eslint').Linter.Config[]} */
export default [
  { ignores: ['**/dist/**', '**/.output/**', '**/node_modules/**', '**/.nuxt/**', '**/.git/**'] },
  ...tseslint.configs.recommendedTypeChecked,
  ...tseslint.configs.strictTypeChecked,
  {
    languageOptions: {
      parserOptions: {
        project: path.join(monorepoRoot, 'tsconfig.eslint.json'),
        tsconfigRootDir: monorepoRoot,
      },
    },
    rules: {
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_' }],
    },
  },
];
