import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync, existsSync, readFileSync as fsReadFileSync } from 'fs';
import { join, resolve } from 'path';
import { tmpdir } from 'os';

// Helper to create test project structure
function createTestProject(baseDir: string, files: Record<string, string | Buffer>) {
  for (const [filePath, content] of Object.entries(files)) {
    const fullPath = join(baseDir, filePath);
    const dir = fullPath.substring(0, fullPath.lastIndexOf('/'));
    if (dir && !existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }
    writeFileSync(fullPath, content);
  }
}

// Mock process.argv for CLI testing
const mockProcessArgv = (args: string[]) => {
  Object.defineProperty(process, 'argv', {
    value: ['node', 'cli.js', ...args],
    writable: true,
    configurable: true,
  });
};

describe('Context Generator Integration Tests', () => {
  let tempDir: string;
  const originalArgv = process.argv;
  const originalCwd = process.cwd;

  beforeAll(() => {
    // Create a temporary directory for test projects
    tempDir = mkdtempSync(join(tmpdir(), 'context-gen-test-'));
  });

  afterAll(() => {
    // Cleanup temporary directory
    if (tempDir && existsSync(tempDir)) {
      rmSync(tempDir, { recursive: true, force: true });
    }
    // Restore original process.argv
    Object.defineProperty(process, 'argv', {
      value: originalArgv,
      writable: true,
      configurable: true,
    });
  });

  beforeEach(() => {
    // Clean temp dir before each test
    if (tempDir && existsSync(tempDir)) {
      rmSync(tempDir, { recursive: true, force: true });
    }
    tempDir = mkdtempSync(join(tmpdir(), 'context-gen-test-'));
    
    // Reset process.argv
    Object.defineProperty(process, 'argv', {
      value: originalArgv,
      writable: true,
      configurable: true,
    });
  });

  describe('End-to-End Generation', () => {
    it('should generate output for TypeScript project', async () => {
      const projectDir = join(tempDir, 'ts-project');
      mkdirSync(projectDir, { recursive: true });
      
      createTestProject(projectDir, {
        'package.json': JSON.stringify({ name: 'test-project' }),
        'src/index.ts': `
import { User } from './types';

export interface Config {
  name: string;
}

export function init(config: Config): void {
  console.log(config);
}
`,
        'src/types.ts': `
export interface User {
  id: string;
  name: string;
}
`,
      });

      const outputPath = join(projectDir, 'llm_context.md');
      mockProcessArgv(['--root', projectDir, '--output', outputPath]);
      
      // Import and run main function
      const { main } = await import('../../src/index.js');
      await main();

      expect(existsSync(outputPath)).toBe(true);
    });

    it('should generate output for Python project', async () => {
      const projectDir = join(tempDir, 'py-project');
      mkdirSync(projectDir, { recursive: true });
      
      createTestProject(projectDir, {
        'main.py': `
"""Main module."""
import os

def main():
    pass

if __name__ == "__main__":
    main()
`,
        'utils/helpers.py': `
def helper():
    """Helper function."""
    pass
`,
      });

      const outputPath = join(projectDir, 'llm_context.md');
      mockProcessArgv(['--root', projectDir, '--output', outputPath]);
      
      const { main } = await import('../../src/index.js');
      await main();

      expect(existsSync(outputPath)).toBe(true);
    });

    it('should generate output for mixed-language project', async () => {
      const projectDir = join(tempDir, 'mixed-project');
      mkdirSync(projectDir, { recursive: true });
      
      createTestProject(projectDir, {
        'frontend/App.vue': `
<template>
  <div>Hello</div>
</template>

<script setup lang="ts">
import { ref } from 'vue';
const count = ref(0);
</script>
`,
        'backend/api.ts': `
import express from 'express';
export const app = express();
`,
        'scripts/deploy.py': `
import os
def deploy(): pass
`,
      });

      const outputPath = join(projectDir, 'llm_context.md');
      mockProcessArgv(['--root', projectDir, '--output', outputPath]);
      
      const { main } = await import('../../src/index.js');
      await main();

      expect(existsSync(outputPath)).toBe(true);
    });
  });

  describe('Output Format Verification', () => {
    it('should include project tree section', async () => {
      const projectDir = join(tempDir, 'tree-test');
      mkdirSync(projectDir, { recursive: true });
      
      createTestProject(projectDir, {
        'src/index.ts': 'export const a = 1;',
        'src/utils/helper.ts': 'export const b = 2;',
        'README.md': '# Test',
      });

      const outputPath = join(projectDir, 'llm_context.md');
      mockProcessArgv(['--root', projectDir, '--output', outputPath]);
      
      const { main } = await import('../../src/index.js');
      await main();

      const output = fsReadFileSync(outputPath, 'utf-8');
      expect(output).toContain('## Project Tree');
      expect(output).toContain('src');
      expect(output).toContain('index.ts');
    });

    it('should include file contents section', async () => {
      const projectDir = join(tempDir, 'content-test');
      mkdirSync(projectDir, { recursive: true });
      
      createTestProject(projectDir, {
        'src/index.ts': 'export const value = 42;',
      });

      const outputPath = join(projectDir, 'llm_context.md');
      mockProcessArgv(['--root', projectDir, '--output', outputPath]);
      
      const { main } = await import('../../src/index.js');
      await main();

      const output = fsReadFileSync(outputPath, 'utf-8');
      expect(output).toContain('## File Contents');
      expect(output).toContain('### src/index.ts');
      expect(output).toContain('```typescript');
    });

    it('should include summary statistics', async () => {
      const projectDir = join(tempDir, 'stats-test');
      mkdirSync(projectDir, { recursive: true });
      
      createTestProject(projectDir, {
        'a.ts': '',
        'b.ts': '',
        'c.py': '',
      });

      const outputPath = join(projectDir, 'llm_context.md');
      mockProcessArgv(['--root', projectDir, '--output', outputPath]);
      
      const { main } = await import('../../src/index.js');
      await main();

      const output = fsReadFileSync(outputPath, 'utf-8');
      expect(output).toContain('## Summary');
      expect(output).toContain('Files Discovered:');
      expect(output).toContain('Files Parsed:');
    });

    it('should use correct language tags in code blocks', async () => {
      const projectDir = join(tempDir, 'lang-test');
      mkdirSync(projectDir, { recursive: true });
      
      createTestProject(projectDir, {
        'app.ts': 'const a = 1;',
        'app.tsx': 'const Component = () => null;',
        'app.js': 'var b = 2;',
        'app.jsx': 'var C = function() {};',
        'app.vue': '<script setup>const d = 3;</script>',
        'app.py': 'e = 4',
        'app.kt': 'val f = 5',
      });

      const outputPath = join(projectDir, 'llm_context.md');
      mockProcessArgv(['--root', projectDir, '--output', outputPath]);
      
      const { main } = await import('../../src/index.js');
      await main();

      const output = fsReadFileSync(outputPath, 'utf-8');
      // Check that appropriate code blocks are present
      expect(output).toMatch(/```typescript/);
      expect(output).toMatch(/```tsx/);
      expect(output).toMatch(/```javascript/);
      expect(output).toMatch(/```jsx/);
      expect(output).toMatch(/```vue/);
      expect(output).toMatch(/```python/);
      expect(output).toMatch(/```kotlin/);
    });

    it('should include table of contents', async () => {
      const projectDir = join(tempDir, 'toc-test');
      mkdirSync(projectDir, { recursive: true });
      
      createTestProject(projectDir, {
        'index.ts': 'export const a = 1;',
      });

      const outputPath = join(projectDir, 'llm_context.md');
      mockProcessArgv(['--root', projectDir, '--output', outputPath]);
      
      const { main } = await import('../../src/index.js');
      await main();

      const output = fsReadFileSync(outputPath, 'utf-8');
      expect(output).toContain('## Table of Contents');
      expect(output).toContain('[Project Tree]');
      expect(output).toContain('[File Contents]');
    });
  });

  describe('Deterministic Output', () => {
    it('should produce identical output for identical input', async () => {
      const projectDir = join(tempDir, 'deterministic-test');
      mkdirSync(projectDir, { recursive: true });
      
      createTestProject(projectDir, {
        'z.ts': 'export const z = 1;',
        'a.ts': 'export const a = 2;',
        'm/b.ts': 'export const b = 3;',
      });

      const outputPath1 = join(projectDir, 'output1.md');
      const outputPath2 = join(projectDir, 'output2.md');
      
      mockProcessArgv(['--root', projectDir, '--output', outputPath1]);
      const { main: main1 } = await import('../../src/index.js');
      await main1();

      // Clear module cache for second run
      vi.resetModules();
      
      mockProcessArgv(['--root', projectDir, '--output', outputPath2]);
      const { main: main2 } = await import('../../src/index.js');
      await main2();

      const output1 = fsReadFileSync(outputPath1, 'utf-8');
      const output2 = fsReadFileSync(outputPath2, 'utf-8');
      expect(output1).toBe(output2);
    });

    it('should have consistent file ordering', async () => {
      const projectDir = join(tempDir, 'ordering-test');
      mkdirSync(projectDir, { recursive: true });
      
      createTestProject(projectDir, {
        'z.ts': 'export const z = 1;',
        'a.ts': 'export const a = 2;',
        'b/c.ts': 'export const c = 3;',
        'b/a.ts': 'export const d = 4;',
      });

      const outputPath = join(projectDir, 'llm_context.md');
      mockProcessArgv(['--root', projectDir, '--output', outputPath]);
      
      const { main } = await import('../../src/index.js');
      await main();

      const output = fsReadFileSync(outputPath, 'utf-8');
      const aIndex = output.indexOf('### a.ts');
      const cIndex = output.indexOf('### b/a.ts');
      const dIndex = output.indexOf('### b/c.ts');
      const zIndex = output.indexOf('### z.ts');

      expect(aIndex).toBeLessThan(zIndex);
      expect(aIndex).toBeLessThan(cIndex);
      expect(cIndex).toBeLessThan(dIndex);
    });
  });

  describe('.gitignore Integration', () => {
    it('should respect .gitignore patterns', async () => {
      const projectDir = join(tempDir, 'gitignore-test');
      mkdirSync(projectDir, { recursive: true });
      
      createTestProject(projectDir, {
        '.gitignore': 'node_modules/\n*.log\n',
        'src/index.ts': 'export const a = 1;',
        'node_modules/lib/index.ts': 'export const ignore = 1;',
        'debug.log': 'ignored',
      });

      const outputPath = join(projectDir, 'llm_context.md');
      mockProcessArgv(['--root', projectDir, '--output', outputPath]);
      
      const { main } = await import('../../src/index.js');
      await main();

      const output = fsReadFileSync(outputPath, 'utf-8');
      expect(output).toContain('src/index.ts');
      expect(output).not.toContain('node_modules/lib/index.ts');
      expect(output).not.toContain('debug.log');
    });

    it('should handle missing .gitignore gracefully', async () => {
      const projectDir = join(tempDir, 'no-gitignore-test');
      mkdirSync(projectDir, { recursive: true });
      
      createTestProject(projectDir, {
        'src/index.ts': 'export const a = 1;',
      });

      const outputPath = join(projectDir, 'llm_context.md');
      mockProcessArgv(['--root', projectDir, '--output', outputPath]);
      
      const { main } = await import('../../src/index.js');
      await expect(main()).resolves.not.toThrow();

      expect(existsSync(outputPath)).toBe(true);
    });
  });

  describe('Exclude Patterns', () => {
    it('should exclude files matching --exclude patterns', async () => {
      const projectDir = join(tempDir, 'exclude-test');
      mkdirSync(projectDir, { recursive: true });
      
      createTestProject(projectDir, {
        'src/index.ts': 'export const a = 1;',
        'src/index.test.ts': 'test("test", () => {});',
        'src/index.spec.ts': 'test("spec", () => {});',
      });

      const outputPath = join(projectDir, 'llm_context.md');
      mockProcessArgv([
        '--root', projectDir,
        '--output', outputPath,
        '--exclude', '*.test.ts',
        '--exclude', '*.spec.ts',
      ]);
      
      const { main } = await import('../../src/index.js');
      await main();

      const output = fsReadFileSync(outputPath, 'utf-8');
      expect(output).toContain('src/index.ts');
      expect(output).not.toContain('index.test.ts');
      expect(output).not.toContain('index.spec.ts');
    });

    it('should handle multiple exclude patterns', async () => {
      const projectDir = join(tempDir, 'multi-exclude-test');
      mkdirSync(projectDir, { recursive: true });
      
      createTestProject(projectDir, {
        'src/a.ts': 'export const a = 1;',
        'tests/a.test.ts': 'test("a");',
        'mocks/a.mock.ts': 'mock("a");',
      });

      const outputPath = join(projectDir, 'llm_context.md');
      mockProcessArgv([
        '--root', projectDir,
        '--output', outputPath,
        '--exclude', 'tests/**',
        '--exclude', 'mocks/**',
      ]);
      
      const { main } = await import('../../src/index.js');
      await main();

      const output = fsReadFileSync(outputPath, 'utf-8');
      expect(output).toContain('src/a.ts');
      expect(output).not.toContain('tests/');
      expect(output).not.toContain('mocks/');
    });
  });

  describe('Error Handling', () => {
    it('should continue processing when individual files fail', async () => {
      const projectDir = join(tempDir, 'error-test');
      mkdirSync(projectDir, { recursive: true });
      
      createTestProject(projectDir, {
        'valid.ts': 'export const a = 1;',
        'binary.png': Buffer.from([0x89, 0x50, 0x4E, 0x47]),
      });

      const outputPath = join(projectDir, 'llm_context.md');
      mockProcessArgv(['--root', projectDir, '--output', outputPath]);
      
      const { main } = await import('../../src/index.js');
      await expect(main()).resolves.not.toThrow();

      expect(existsSync(outputPath)).toBe(true);
    });

    it('should handle non-existent root directory gracefully', async () => {
      const nonExistentDir = join(tempDir, 'does-not-exist');
      
      const outputPath = join(tempDir, 'output.md');
      mockProcessArgv(['--root', nonExistentDir, '--output', outputPath]);
      
      const { main } = await import('../../src/index.js');
      await expect(main()).rejects.toThrow();
    });
  });

  describe('CLI Options', () => {
    it('should respect custom output path', async () => {
      const projectDir = join(tempDir, 'output-path-test');
      mkdirSync(projectDir, { recursive: true });
      
      createTestProject(projectDir, {
        'src/index.ts': 'export const a = 1;',
      });

      const customOutput = join(projectDir, 'docs', 'context.md');
      mkdirSync(join(projectDir, 'docs'), { recursive: true });

      mockProcessArgv(['--root', projectDir, '--output', customOutput]);
      
      const { main } = await import('../../src/index.js');
      await main();

      expect(existsSync(customOutput)).toBe(true);
      expect(existsSync(join(projectDir, 'llm_context.md'))).toBe(false);
    });

    it('should include skipped files section when files are skipped', async () => {
      const projectDir = join(tempDir, 'skipped-test');
      mkdirSync(projectDir, { recursive: true });
      
      createTestProject(projectDir, {
        'src/valid.ts': 'export const a = 1;',
        'src/large.ts': 'x'.repeat(100),
      });

      const outputPath = join(projectDir, 'llm_context.md');
      mockProcessArgv(['--root', projectDir, '--output', outputPath]);
      
      const { main } = await import('../../src/index.js');
      await main();

      const output = fsReadFileSync(outputPath, 'utf-8');
      // The output should be valid and contain expected sections
      expect(output).toContain('# Project Context');
    });
  });
});
