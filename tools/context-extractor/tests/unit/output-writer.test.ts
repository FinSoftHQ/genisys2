import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, readFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { writeOutput } from '../../src/output-writer.js';
import type { ExtractedBlock, ProcessingStats } from '../../src/types.js';

describe('writeOutput', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'output-test-'));
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  function createBlock(overrides: Partial<ExtractedBlock> = {}): ExtractedBlock {
    return {
      target: { file: 'test.ts' },
      absolutePath: '/test.ts',
      extension: 'ts',
      language: 'typescript',
      content: 'const x = 1;',
      ...overrides,
    };
  }

  describe('XML tag generation for full-file extraction', () => {
    it('generates opening tag without line numbers for full-file', () => {
      const outputPath = join(tempDir, 'output.md');
      const block = createBlock({
        target: { file: 'src/App.vue' },
        extension: 'vue',
      });

      writeOutput(outputPath, [block], { totalEntries: 1, blocksWritten: 1, warnings: 0 });

      const content = readFileSync(outputPath, 'utf-8');
      expect(content).toContain('<file path="src/App.vue">');
      expect(content).toContain('</file>');
      expect(content).not.toContain('start_line');
      expect(content).not.toContain('end_line');
    });

    it('generates simple tag for root-level files', () => {
      const outputPath = join(tempDir, 'output.md');
      const block = createBlock({
        target: { file: 'README.md' },
        extension: 'md',
      });

      writeOutput(outputPath, [block], { totalEntries: 1, blocksWritten: 1, warnings: 0 });

      const content = readFileSync(outputPath, 'utf-8');
      expect(content).toContain('<file path="README.md">');
    });
  });

  describe('XML tag generation for range extraction', () => {
    it('generates opening tag with start_line and end_line attributes', () => {
      const outputPath = join(tempDir, 'output.md');
      const block = createBlock({
        target: { file: 'src/App.vue', start_line: 45, end_line: 60 },
        extension: 'vue',
        effectiveStartLine: 45,
        effectiveEndLine: 60,
      });

      writeOutput(outputPath, [block], { totalEntries: 1, blocksWritten: 1, warnings: 0 });

      const content = readFileSync(outputPath, 'utf-8');
      expect(content).toContain('<file path="src/App.vue" start_line="45" end_line="60">');
    });

    it('uses effective line numbers after capping', () => {
      const outputPath = join(tempDir, 'output.md');
      const block = createBlock({
        target: { file: 'test.ts', start_line: 1, end_line: 999 },
        extension: 'ts',
        effectiveStartLine: 1,
        effectiveEndLine: 25,  // Capped from 999
      });

      writeOutput(outputPath, [block], { totalEntries: 1, blocksWritten: 1, warnings: 0 });

      const content = readFileSync(outputPath, 'utf-8');
      expect(content).toContain('start_line="1"');
      expect(content).toContain('end_line="25"');
    });
  });

  describe('XML tag generation for start_line-only extraction', () => {
    it('generates opening tag with only start_line attribute', () => {
      const outputPath = join(tempDir, 'output.md');
      const block = createBlock({
        target: { file: 'src/utils/math.ts', start_line: 112 },
        extension: 'ts',
        effectiveStartLine: 112,
      });

      writeOutput(outputPath, [block], { totalEntries: 1, blocksWritten: 1, warnings: 0 });

      const content = readFileSync(outputPath, 'utf-8');
      expect(content).toContain('<file path="src/utils/math.ts" start_line="112">');
      expect(content).not.toContain('end_line');
    });
  });

  describe('code fence with correct language extension', () => {
    it('uses file extension for code fence', () => {
      const outputPath = join(tempDir, 'output.md');
      const block = createBlock({
        extension: 'ts',
        content: 'const x: number = 1;',
      });

      writeOutput(outputPath, [block], { totalEntries: 1, blocksWritten: 1, warnings: 0 });

      const content = readFileSync(outputPath, 'utf-8');
      expect(content).toContain('```ts');
    });

    it('uses vue extension for Vue files', () => {
      const outputPath = join(tempDir, 'output.md');
      const block = createBlock({
        target: { file: 'App.vue' },
        extension: 'vue',
        content: '<template></template>',
      });

      writeOutput(outputPath, [block], { totalEntries: 1, blocksWritten: 1, warnings: 0 });

      const content = readFileSync(outputPath, 'utf-8');
      expect(content).toContain('```vue');
    });

    it('uses text for files without extension', () => {
      const outputPath = join(tempDir, 'output.md');
      const block = createBlock({
        target: { file: 'Makefile' },
        extension: 'text',
        content: 'build: npm run build',
      });

      writeOutput(outputPath, [block], { totalEntries: 1, blocksWritten: 1, warnings: 0 });

      const content = readFileSync(outputPath, 'utf-8');
      expect(content).toContain('```text');
    });

    it('uses js extension for JavaScript files', () => {
      const outputPath = join(tempDir, 'output.md');
      const block = createBlock({
        target: { file: 'script.js' },
        extension: 'js',
        content: 'console.log("hello");',
      });

      writeOutput(outputPath, [block], { totalEntries: 1, blocksWritten: 1, warnings: 0 });

      const content = readFileSync(outputPath, 'utf-8');
      expect(content).toContain('```js');
    });
  });

  describe('zero indentation requirement', () => {
    it('has no indentation on opening XML tag', () => {
      const outputPath = join(tempDir, 'output.md');
      const block = createBlock();

      writeOutput(outputPath, [block], { totalEntries: 1, blocksWritten: 1, warnings: 0 });

      const content = readFileSync(outputPath, 'utf-8');
      const lines = content.split('\n');
      const openTagLine = lines.find(l => l.includes('<file'));
      expect(openTagLine).toBeDefined();
      expect(openTagLine).not.toMatch(/^\s/);  // Does not start with whitespace
    });

    it('has no indentation on closing XML tag', () => {
      const outputPath = join(tempDir, 'output.md');
      const block = createBlock();

      writeOutput(outputPath, [block], { totalEntries: 1, blocksWritten: 1, warnings: 0 });

      const content = readFileSync(outputPath, 'utf-8');
      const lines = content.split('\n');
      const closeTagLine = lines.find(l => l.includes('</file>'));
      expect(closeTagLine).toBeDefined();
      expect(closeTagLine).not.toMatch(/^\s/);  // Does not start with whitespace
    });

    it('has no indentation on reasoning tag', () => {
      const outputPath = join(tempDir, 'output.md');
      const block = createBlock({
        target: { file: 'test.ts', reasoning: 'some reason' },
      });

      writeOutput(outputPath, [block], { totalEntries: 1, blocksWritten: 1, warnings: 0 });

      const content = readFileSync(outputPath, 'utf-8');
      const lines = content.split('\n');
      const reasoningLine = lines.find(l => l.includes('<reasoning>'));
      expect(reasoningLine).toBeDefined();
      expect(reasoningLine).not.toMatch(/^\s/);
    });

    it('has no indentation on code fence opening', () => {
      const outputPath = join(tempDir, 'output.md');
      const block = createBlock();

      writeOutput(outputPath, [block], { totalEntries: 1, blocksWritten: 1, warnings: 0 });

      const content = readFileSync(outputPath, 'utf-8');
      const lines = content.split('\n');
      const codeFenceLine = lines.find(l => l.startsWith('```') && !l.startsWith('````'));
      expect(codeFenceLine).toBeDefined();
      expect(codeFenceLine).not.toMatch(/^\s/);  // Does not start with whitespace
    });

    it('has no indentation on code fence closing', () => {
      const outputPath = join(tempDir, 'output.md');
      const block = createBlock();

      writeOutput(outputPath, [block], { totalEntries: 1, blocksWritten: 1, warnings: 0 });

      const content = readFileSync(outputPath, 'utf-8');
      const lines = content.split('\n');
      const codeFenceLines = lines.filter(l => l === '```');
      expect(codeFenceLines.length).toBeGreaterThan(0);
      for (const line of codeFenceLines) {
        expect(line).not.toMatch(/^\s/);
      }
    });
  });

  describe('reasoning tag output', () => {
    it('includes reasoning tag when present', () => {
      const outputPath = join(tempDir, 'output.md');
      const block = createBlock({
        target: { file: 'test.ts', reasoning: 'Need to inspect this' },
      });

      writeOutput(outputPath, [block], { totalEntries: 1, blocksWritten: 1, warnings: 0 });

      const content = readFileSync(outputPath, 'utf-8');
      expect(content).toContain('<reasoning>Need to inspect this</reasoning>');
      const lines = content.split('\n');
      const fileLineIdx = lines.findIndex(l => l.startsWith('<file'));
      const reasoningLineIdx = lines.findIndex(l => l.startsWith('<reasoning>'));
      const fenceLineIdx = lines.findIndex(l => l.startsWith('```'));
      expect(reasoningLineIdx).toBeGreaterThan(fileLineIdx);
      expect(fenceLineIdx).toBeGreaterThan(reasoningLineIdx);
    });

    it('omits reasoning tag when absent', () => {
      const outputPath = join(tempDir, 'output.md');
      const block = createBlock();

      writeOutput(outputPath, [block], { totalEntries: 1, blocksWritten: 1, warnings: 0 });

      const content = readFileSync(outputPath, 'utf-8');
      expect(content).not.toContain('<reasoning>');
    });

    it('escapes XML special characters in reasoning', () => {
      const outputPath = join(tempDir, 'output.md');
      const block = createBlock({
        target: { file: 'test.ts', reasoning: 'A < B & C > D' },
      });

      writeOutput(outputPath, [block], { totalEntries: 1, blocksWritten: 1, warnings: 0 });

      const content = readFileSync(outputPath, 'utf-8');
      expect(content).toContain('<reasoning>A &lt; B &amp; C &gt; D</reasoning>');
    });
  });

  describe('content preservation', () => {
    it('preserves original whitespace in content', () => {
      const outputPath = join(tempDir, 'output.md');
      const block = createBlock({
        content: '  indented line\n    more indented\nno indent\n',
      });

      writeOutput(outputPath, [block], { totalEntries: 1, blocksWritten: 1, warnings: 0 });

      const content = readFileSync(outputPath, 'utf-8');
      expect(content).toContain('  indented line');
      expect(content).toContain('    more indented');
      expect(content).toContain('no indent');
    });

    it('handles content with trailing newline', () => {
      const outputPath = join(tempDir, 'output.md');
      const block = createBlock({
        content: 'line1\nline2\n',
      });

      writeOutput(outputPath, [block], { totalEntries: 1, blocksWritten: 1, warnings: 0 });

      const content = readFileSync(outputPath, 'utf-8');
      // Should preserve the trailing newline (blank line before closing fence)
      expect(content).toContain('```ts\nline1\nline2\n\n```');
    });

    it('handles content without trailing newline', () => {
      const outputPath = join(tempDir, 'output.md');
      const block = createBlock({
        content: 'line1\nline2',  // No trailing newline
      });

      writeOutput(outputPath, [block], { totalEntries: 1, blocksWritten: 1, warnings: 0 });

      const content = readFileSync(outputPath, 'utf-8');
      // Content should still be preserved correctly
      expect(content).toContain('line1\nline2\n```');
    });

    it('handles empty content', () => {
      const outputPath = join(tempDir, 'output.md');
      const block = createBlock({
        content: '',
      });

      writeOutput(outputPath, [block], { totalEntries: 1, blocksWritten: 1, warnings: 0 });

      const content = readFileSync(outputPath, 'utf-8');
      expect(content).toContain('<file');
      expect(content).toContain('```ts');
      expect(content).toContain('```\n</file>');
    });
  });

  describe('single blank line between blocks', () => {
    it('adds single blank line between consecutive blocks', () => {
      const outputPath = join(tempDir, 'output.md');
      const blocks = [
        createBlock({ target: { file: 'file1.ts' }, content: 'content1' }),
        createBlock({ target: { file: 'file2.ts' }, content: 'content2' }),
      ];

      writeOutput(outputPath, blocks, { totalEntries: 2, blocksWritten: 2, warnings: 0 });

      const content = readFileSync(outputPath, 'utf-8');
      // Check for exactly one blank line between blocks
      expect(content).toContain('</file>\n\n<file');
    });

    it('does not add extra blank lines at end', () => {
      const outputPath = join(tempDir, 'output.md');
      const block = createBlock();

      writeOutput(outputPath, [block], { totalEntries: 1, blocksWritten: 1, warnings: 0 });

      const content = readFileSync(outputPath, 'utf-8');
      // Should end with a single newline
      expect(content.endsWith('\n')).toBe(true);
      expect(content.endsWith('\n\n')).toBe(false);
    });

    it('handles multiple blocks with proper spacing', () => {
      const outputPath = join(tempDir, 'output.md');
      const blocks = [
        createBlock({ target: { file: 'a.ts' }, content: 'a' }),
        createBlock({ target: { file: 'b.ts' }, content: 'b' }),
        createBlock({ target: { file: 'c.ts' }, content: 'c' }),
      ];

      writeOutput(outputPath, blocks, { totalEntries: 3, blocksWritten: 3, warnings: 0 });

      const content = readFileSync(outputPath, 'utf-8');
      const lines = content.split('\n');
      
      // Find all </file> lines and count blank lines after them
      for (let i = 0; i < lines.length; i++) {
        if (lines[i] === '</file>' && i < lines.length - 2) {
          // Next line should be blank
          expect(lines[i + 1]).toBe('');
          // Line after that should be <file...> (not another blank line)
          expect(lines[i + 2]).toMatch(/^<file/);
        }
      }
    });
  });

  describe('XML escaping in file paths', () => {
    it('escapes ampersand in filepath', () => {
      const outputPath = join(tempDir, 'output.md');
      const block = createBlock({
        target: { file: 'src/foo & bar.ts' },
      });

      writeOutput(outputPath, [block], { totalEntries: 1, blocksWritten: 1, warnings: 0 });

      const content = readFileSync(outputPath, 'utf-8');
      expect(content).toContain('path="src/foo &amp; bar.ts"');
      expect(content).not.toContain('path="src/foo & bar.ts"');
    });

    it('escapes less than in filepath', () => {
      const outputPath = join(tempDir, 'output.md');
      const block = createBlock({
        target: { file: 'src/<special>.ts' },
      });

      writeOutput(outputPath, [block], { totalEntries: 1, blocksWritten: 1, warnings: 0 });

      const content = readFileSync(outputPath, 'utf-8');
      expect(content).toContain('path="src/&lt;special&gt;.ts"');
    });

    it('escapes greater than in filepath', () => {
      const outputPath = join(tempDir, 'output.md');
      const block = createBlock({
        target: { file: 'src/file>name.ts' },
      });

      writeOutput(outputPath, [block], { totalEntries: 1, blocksWritten: 1, warnings: 0 });

      const content = readFileSync(outputPath, 'utf-8');
      expect(content).toContain('path="src/file&gt;name.ts"');
    });

    it('escapes double quotes in filepath', () => {
      const outputPath = join(tempDir, 'output.md');
      const block = createBlock({
        target: { file: 'src/"quoted".ts' },
      });

      writeOutput(outputPath, [block], { totalEntries: 1, blocksWritten: 1, warnings: 0 });

      const content = readFileSync(outputPath, 'utf-8');
      expect(content).toContain('path="src/&quot;quoted&quot;.ts"');
    });

    it('escapes single quotes in filepath', () => {
      const outputPath = join(tempDir, 'output.md');
      const block = createBlock({
        target: { file: "src/'single'.ts" },
      });

      writeOutput(outputPath, [block], { totalEntries: 1, blocksWritten: 1, warnings: 0 });

      const content = readFileSync(outputPath, 'utf-8');
      expect(content).toContain("path=\"src/&apos;single&apos;.ts\"");
    });

    it('escapes multiple special characters', () => {
      const outputPath = join(tempDir, 'output.md');
      const block = createBlock({
        target: { file: 'src/<test & "value">.ts' },
      });

      writeOutput(outputPath, [block], { totalEntries: 1, blocksWritten: 1, warnings: 0 });

      const content = readFileSync(outputPath, 'utf-8');
      expect(content).toContain('path="src/&lt;test &amp; &quot;value&quot;&gt;.ts"');
    });
  });

  describe('complete output format', () => {
    it('generates correct format for full-file extraction', () => {
      const outputPath = join(tempDir, 'output.md');
      const block = createBlock({
        target: { file: 'src/App.vue' },
        extension: 'vue',
        content: '<template>\n  <div>Hello</div>\n</template>',
      });

      writeOutput(outputPath, [block], { totalEntries: 1, blocksWritten: 1, warnings: 0 });

      const content = readFileSync(outputPath, 'utf-8');
      const expected = `<file path="src/App.vue">
\`\`\`vue
<template>
  <div>Hello</div>
</template>
\`\`\`
</file>
`;
      expect(content).toBe(expected);
    });

    it('generates correct format for range extraction', () => {
      const outputPath = join(tempDir, 'output.md');
      const block = createBlock({
        target: { file: 'src/App.vue', start_line: 45, end_line: 60 },
        extension: 'vue',
        effectiveStartLine: 45,
        effectiveEndLine: 60,
        content: '<script setup>\nconst x = 1;\n</script>',
      });

      writeOutput(outputPath, [block], { totalEntries: 1, blocksWritten: 1, warnings: 0 });

      const content = readFileSync(outputPath, 'utf-8');
      const expected = `<file path="src/App.vue" start_line="45" end_line="60">
\`\`\`vue
<script setup>
const x = 1;
</script>
\`\`\`
</file>
`;
      expect(content).toBe(expected);
    });

    it('generates correct format for start_line-only extraction with reasoning', () => {
      const outputPath = join(tempDir, 'output.md');
      const block = createBlock({
        target: { file: 'src/utils/math.ts', start_line: 112, reasoning: 'Need to see the rest' },
        extension: 'ts',
        effectiveStartLine: 112,
        content: 'const x = 1;\n',
      });

      writeOutput(outputPath, [block], { totalEntries: 1, blocksWritten: 1, warnings: 0 });

      const content = readFileSync(outputPath, 'utf-8');
      const expected = `<file path="src/utils/math.ts" start_line="112">
<reasoning>Need to see the rest</reasoning>
\`\`\`ts
const x = 1;

\`\`\`
</file>
`;
      expect(content).toBe(expected);
    });
  });

  describe('empty blocks array', () => {
    it('handles empty blocks array', () => {
      const outputPath = join(tempDir, 'output.md');

      writeOutput(outputPath, [], { totalEntries: 0, blocksWritten: 0, warnings: 0 });

      const content = readFileSync(outputPath, 'utf-8');
      expect(content).toBe('');
    });
  });

  describe('stats parameter', () => {
    it('accepts stats but does not include them in output', () => {
      const outputPath = join(tempDir, 'output.md');
      const block = createBlock();
      const stats: ProcessingStats = { totalEntries: 5, blocksWritten: 3, warnings: 2 };

      writeOutput(outputPath, [block], stats);

      const content = readFileSync(outputPath, 'utf-8');
      // Stats should not appear in the markdown output
      expect(content).not.toContain('5');
      expect(content).not.toContain('3');
      expect(content).not.toContain('2');
      expect(content).not.toContain('totalEntries');
      expect(content).not.toContain('blocksWritten');
      expect(content).not.toContain('warnings');
      // But the file should still be written correctly
      expect(content).toContain('<file');
    });
  });
});
