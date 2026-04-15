import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync, mkdirSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { extractFromFile } from '../../src/file-extractor.js';
import type { ExtractionTarget } from '../../src/types.js';

describe('extractFromFile', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'extract-test-'));
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  describe('full-file extraction', () => {
    it('extracts entire file content', () => {
      const content = 'line 1\nline 2\nline 3\n';
      writeFileSync(join(tempDir, 'test.ts'), content);

      const target: ExtractionTarget = { file: 'test.ts' };
      const result = extractFromFile(target, tempDir);

      expect(result.warning).toBeUndefined();
      expect(result.block).toBeDefined();
      expect(result.block!.content).toBe(content);
      expect(result.block!.extension).toBe('ts');
      expect(result.block!.language).toBe('typescript');
      expect(result.block!.absolutePath).toBe(join(tempDir, 'test.ts'));
    });

    it('resolves relative paths from cwd', () => {
      const content = 'test content';
      writeFileSync(join(tempDir, 'relative.ts'), content);

      const target: ExtractionTarget = { file: './relative.ts' };
      const result = extractFromFile(target, tempDir);

      expect(result.block!.content).toBe(content);
    });

    it('resolves nested relative paths', () => {
      const nestedDir = join(tempDir, 'src', 'components');
      mkdirSync(nestedDir, { recursive: true });
      writeFileSync(join(nestedDir, 'Button.vue'), '<template></template>');

      const target: ExtractionTarget = { file: 'src/components/Button.vue' };
      const result = extractFromFile(target, tempDir);

      expect(result.block).toBeDefined();
      expect(result.block!.extension).toBe('vue');
    });

    it('handles files without extension', () => {
      const content = 'no extension here';
      writeFileSync(join(tempDir, 'Makefile'), content);

      const target: ExtractionTarget = { file: 'Makefile' };
      const result = extractFromFile(target, tempDir);

      expect(result.block!.extension).toBe('text');
      expect(result.block!.language).toBe('text');
      expect(result.block!.content).toBe(content);
    });

    it('handles empty file', () => {
      writeFileSync(join(tempDir, 'empty.txt'), '');

      const target: ExtractionTarget = { file: 'empty.txt' };
      const result = extractFromFile(target, tempDir);

      expect(result.block!.content).toBe('');
    });

    it('preserves original line endings', () => {
      const content = 'line1\nline2\nline3';  // No trailing newline
      writeFileSync(join(tempDir, 'test.txt'), content);

      const target: ExtractionTarget = { file: 'test.txt' };
      const result = extractFromFile(target, tempDir);

      expect(result.block!.content).toBe(content);
    });

    it('preserves trailing newline', () => {
      const content = 'line1\nline2\nline3\n';  // With trailing newline
      writeFileSync(join(tempDir, 'test.txt'), content);

      const target: ExtractionTarget = { file: 'test.txt' };
      const result = extractFromFile(target, tempDir);

      expect(result.block!.content).toBe(content);
    });
  });

  describe('range extraction (1-based inclusive)', () => {
    it('extracts single line', () => {
      writeFileSync(join(tempDir, 'test.ts'), 'line1\nline2\nline3\n');

      const target: ExtractionTarget = { file: 'test.ts', start_line: 2, end_line: 2 };
      const result = extractFromFile(target, tempDir);

      expect(result.block!.content).toBe('line2');
      expect(result.block!.effectiveStartLine).toBe(2);
      expect(result.block!.effectiveEndLine).toBe(2);
    });

    it('extracts range of lines', () => {
      writeFileSync(join(tempDir, 'test.ts'), 'line1\nline2\nline3\nline4\nline5\n');

      const target: ExtractionTarget = { file: 'test.ts', start_line: 2, end_line: 4 };
      const result = extractFromFile(target, tempDir);

      expect(result.block!.content).toBe('line2\nline3\nline4');
      expect(result.block!.effectiveStartLine).toBe(2);
      expect(result.block!.effectiveEndLine).toBe(4);
    });

    it('extracts from start of file', () => {
      writeFileSync(join(tempDir, 'test.ts'), 'first\nsecond\nthird\n');

      const target: ExtractionTarget = { file: 'test.ts', start_line: 1, end_line: 2 };
      const result = extractFromFile(target, tempDir);

      expect(result.block!.content).toBe('first\nsecond');
    });

    it('extracts to end of file with exact end_line', () => {
      writeFileSync(join(tempDir, 'test.ts'), 'a\nb\nc\n');

      const target: ExtractionTarget = { file: 'test.ts', start_line: 2, end_line: 3 };
      const result = extractFromFile(target, tempDir);

      expect(result.block!.content).toBe('b\nc');
    });

    it('handles large file correctly', () => {
      const lines: string[] = [];
      for (let i = 1; i <= 100; i++) {
        lines.push(`line ${i}`);
      }
      writeFileSync(join(tempDir, 'large.txt'), lines.join('\n'));

      const target: ExtractionTarget = { file: 'large.txt', start_line: 50, end_line: 60 };
      const result = extractFromFile(target, tempDir);

      expect(result.block!.content).toBe(lines.slice(49, 60).join('\n'));
    });
  });

  describe('start_line-only extraction', () => {
    it('extracts from start_line to EOF', () => {
      writeFileSync(join(tempDir, 'test.ts'), 'line1\nline2\nline3\n');

      const target: ExtractionTarget = { file: 'test.ts', start_line: 2 };
      const result = extractFromFile(target, tempDir);

      expect(result.block!.content).toBe('line2\nline3\n');
      expect(result.block!.effectiveStartLine).toBe(2);
      expect(result.block!.effectiveEndLine).toBeUndefined();
    });

    it('extracts from start_line to EOF preserving trailing newline', () => {
      writeFileSync(join(tempDir, 'test.ts'), 'line1\nline2\nline3\n');

      const target: ExtractionTarget = { file: 'test.ts', start_line: 1 };
      const result = extractFromFile(target, tempDir);

      expect(result.block!.content).toBe('line1\nline2\nline3\n');
      expect(result.block!.effectiveStartLine).toBe(1);
      expect(result.block!.effectiveEndLine).toBeUndefined();
    });

    it('returns warning when start_line is out of bounds', () => {
      writeFileSync(join(tempDir, 'test.ts'), 'line1\nline2\n');

      const target: ExtractionTarget = { file: 'test.ts', start_line: 10 };
      const result = extractFromFile(target, tempDir);

      expect(result.block).toBeUndefined();
      expect(result.warning).toBeDefined();
      expect(result.warning!.message).toBe('start_line 10 out of bounds for test.ts (2 lines)');
    });
  });

  describe('missing file handling', () => {
    it('returns warning for non-existent file', () => {
      const target: ExtractionTarget = { file: 'does-not-exist.ts' };
      const result = extractFromFile(target, tempDir);

      expect(result.block).toBeUndefined();
      expect(result.warning).toBeDefined();
      expect(result.warning!.message).toBe('file not found: does-not-exist.ts');
    });

    it('returns warning for non-existent relative path', () => {
      const target: ExtractionTarget = { file: 'src/components/Missing.vue' };
      const result = extractFromFile(target, tempDir);

      expect(result.block).toBeUndefined();
      expect(result.warning).toBeDefined();
    });

    it('returns warning for non-existent range extraction', () => {
      const target: ExtractionTarget = { file: 'missing.ts', start_line: 1, end_line: 10 };
      const result = extractFromFile(target, tempDir);

      expect(result.block).toBeUndefined();
      expect(result.warning).toBeDefined();
    });

    it('returns warning for non-existent start_line-only extraction', () => {
      const target: ExtractionTarget = { file: 'missing.ts', start_line: 1 };
      const result = extractFromFile(target, tempDir);

      expect(result.block).toBeUndefined();
      expect(result.warning).toBeDefined();
      expect(result.warning!.message).toBe('file not found: missing.ts');
    });
  });

  describe('out-of-bounds start_line handling', () => {
    it('returns warning when start_line exceeds file length', () => {
      writeFileSync(join(tempDir, 'test.ts'), 'line1\nline2\n');

      const target: ExtractionTarget = { file: 'test.ts', start_line: 10, end_line: 15 };
      const result = extractFromFile(target, tempDir);

      expect(result.block).toBeUndefined();
      expect(result.warning).toBeDefined();
      expect(result.warning!.message).toBe('start_line 10 out of bounds for test.ts (2 lines)');
    });

    it('returns warning when start_line equals file length + 1', () => {
      writeFileSync(join(tempDir, 'test.ts'), 'line1\nline2\n');

      const target: ExtractionTarget = { file: 'test.ts', start_line: 3, end_line: 5 };
      const result = extractFromFile(target, tempDir);

      expect(result.warning).toBeDefined();
      expect(result.warning!.message).toBe('start_line 3 out of bounds for test.ts (2 lines)');
    });

    it('succeeds when start_line equals file length (last line)', () => {
      writeFileSync(join(tempDir, 'test.ts'), 'line1\nline2\n');

      const target: ExtractionTarget = { file: 'test.ts', start_line: 2, end_line: 2 };
      const result = extractFromFile(target, tempDir);

      expect(result.block).toBeDefined();
      expect(result.warning).toBeUndefined();
      expect(result.block!.content).toBe('line2');
    });
  });

  describe('out-of-bounds end_line handling (capping)', () => {
    it('caps end_line at file length silently', () => {
      writeFileSync(join(tempDir, 'test.ts'), 'line1\nline2\nline3\n');

      const target: ExtractionTarget = { file: 'test.ts', start_line: 2, end_line: 100 };
      const result = extractFromFile(target, tempDir);

      expect(result.block).toBeDefined();
      expect(result.warning).toBeUndefined();
      expect(result.block!.content).toBe('line2\nline3');
      expect(result.block!.effectiveEndLine).toBe(3);  // Capped to actual line count
    });

    it('caps end_line when it exceeds by small amount', () => {
      writeFileSync(join(tempDir, 'test.ts'), 'a\nb\nc\n');

      const target: ExtractionTarget = { file: 'test.ts', start_line: 1, end_line: 5 };
      const result = extractFromFile(target, tempDir);

      expect(result.block!.content).toBe('a\nb\nc');
      expect(result.block!.effectiveEndLine).toBe(3);
    });

    it('extracts entire file when start_line=1 and end_line exceeds length', () => {
      writeFileSync(join(tempDir, 'test.ts'), 'a\nb\nc\n');

      const target: ExtractionTarget = { file: 'test.ts', start_line: 1, end_line: 999 };
      const result = extractFromFile(target, tempDir);

      expect(result.block!.content).toBe('a\nb\nc');
      expect(result.block!.effectiveStartLine).toBe(1);
      expect(result.block!.effectiveEndLine).toBe(3);
    });
  });

  describe('edge case: start > end after capping', () => {
    it('outputs empty content when start > end after capping', () => {
      writeFileSync(join(tempDir, 'test.ts'), 'line1\n');  // Only 1 line

      const target: ExtractionTarget = { file: 'test.ts', start_line: 2, end_line: 2 };
      const result = extractFromFile(target, tempDir);

      // This should produce a warning, not empty content, since start_line=2 > total_lines=1
      // The implementation checks start_line > total_lines first
      expect(result.warning).toBeDefined();
    });

    it('handles scenario where end_line caps to below start_line', () => {
      // File has 3 lines, asking for lines 2-5, but 5 caps to 3
      // So we get lines 2-3, which is valid
      writeFileSync(join(tempDir, 'test.ts'), 'line1\nline2\nline3\n');

      const target: ExtractionTarget = { file: 'test.ts', start_line: 2, end_line: 100 };
      const result = extractFromFile(target, tempDir);

      expect(result.block).toBeDefined();
      expect(result.block!.content).toBe('line2\nline3');
    });

    it('outputs empty block when effective start > effective end', () => {
      // This edge case would require: start_line <= total_lines but end_line caps to < start_line
      // With the current implementation, this shouldn't happen because:
      // - If start_line > total_lines: warning
      // - If start_line <= total_lines and end_line < start_line: content is empty
      // But wait, end_line is capped at total_lines, so if start_line <= total_lines, 
      // then effectiveEndLine = min(end_line, total_lines) >= start_line (assuming end_line >= start_line)
      
      // Let's create a scenario: file has 5 lines, target is start_line=5, end_line=3
      // But this would be caught by validation (end_line < start_line is still valid structurally)
      writeFileSync(join(tempDir, 'test.ts'), '1\n2\n3\n4\n5\n');

      const target: ExtractionTarget = { file: 'test.ts', start_line: 5, end_line: 3 };
      const result = extractFromFile(target, tempDir);

      // start_line=5, end_line=3, effectiveEndLine = min(3, 5) = 3
      // effectiveStartLine = 5, effectiveEndLine = 3
      // Since 5 > 3, we get empty content
      expect(result.block).toBeDefined();
      expect(result.block!.content).toBe('');
      expect(result.block!.effectiveStartLine).toBe(5);
      expect(result.block!.effectiveEndLine).toBe(3);
    });
  });

  describe('absolute path handling', () => {
    it('resolves absolute paths correctly', () => {
      const content = 'absolute path content';
      const absolutePath = join(tempDir, 'absolute.ts');
      writeFileSync(absolutePath, content);

      const target: ExtractionTarget = { file: absolutePath };
      const result = extractFromFile(target, tempDir);

      expect(result.block).toBeDefined();
      expect(result.block!.content).toBe(content);
      expect(result.block!.absolutePath).toBe(absolutePath);
    });

    it('handles absolute path for range extraction', () => {
      const absolutePath = join(tempDir, 'absolute.ts');
      writeFileSync(absolutePath, 'line1\nline2\nline3\n');

      const target: ExtractionTarget = { file: absolutePath, start_line: 2, end_line: 3 };
      const result = extractFromFile(target, '/some/other/cwd');

      expect(result.block).toBeDefined();
      expect(result.block!.content).toBe('line2\nline3');
    });
  });

  describe('language detection', () => {
    it('detects TypeScript correctly', () => {
      writeFileSync(join(tempDir, 'test.ts'), 'const x = 1;');

      const target: ExtractionTarget = { file: 'test.ts' };
      const result = extractFromFile(target, tempDir);

      expect(result.block!.extension).toBe('ts');
      expect(result.block!.language).toBe('typescript');
    });

    it('detects Vue files correctly', () => {
      writeFileSync(join(tempDir, 'test.vue'), '<template></template>');

      const target: ExtractionTarget = { file: 'test.vue' };
      const result = extractFromFile(target, tempDir);

      expect(result.block!.extension).toBe('vue');
      expect(result.block!.language).toBe('vue');
    });

    it('detects JavaScript correctly', () => {
      writeFileSync(join(tempDir, 'test.js'), 'console.log("hello");');

      const target: ExtractionTarget = { file: 'test.js' };
      const result = extractFromFile(target, tempDir);

      expect(result.block!.extension).toBe('js');
      expect(result.block!.language).toBe('javascript');
    });
  });

  describe('target preservation in block', () => {
    it('preserves original target in extracted block', () => {
      writeFileSync(join(tempDir, 'test.ts'), 'content');

      const target: ExtractionTarget = { file: 'test.ts', start_line: 1, end_line: 1 };
      const result = extractFromFile(target, tempDir);

      expect(result.block!.target).toBe(target);
      expect(result.block!.target.file).toBe('test.ts');
      expect(result.block!.target.start_line).toBe(1);
      expect(result.block!.target.end_line).toBe(1);
    });
  });
});
