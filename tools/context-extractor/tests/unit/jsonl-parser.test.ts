import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { parseJsonlFile } from '../../src/jsonl-parser.js';

describe('parseJsonlFile', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'jsonl-test-'));
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  describe('valid JSONL parsing', () => {
    it('parses full-file targets', async () => {
      const jsonlPath = join(tempDir, 'test.jsonl');
      writeFileSync(jsonlPath, '{"file": "src/App.vue"}\n{"file": "src/main.ts"}\n');

      const result = await parseJsonlFile(jsonlPath);

      expect(result.targets).toHaveLength(2);
      expect(result.targets[0]).toEqual({ file: 'src/App.vue', start_line: undefined, end_line: undefined });
      expect(result.targets[1]).toEqual({ file: 'src/main.ts', start_line: undefined, end_line: undefined });
      expect(result.warnings).toHaveLength(0);
    });

    it('parses range targets with start_line and end_line', async () => {
      const jsonlPath = join(tempDir, 'test.jsonl');
      writeFileSync(jsonlPath, '{"file": "src/App.vue", "start_line": 45, "end_line": 60}\n');

      const result = await parseJsonlFile(jsonlPath);

      expect(result.targets).toHaveLength(1);
      expect(result.targets[0]).toEqual({ file: 'src/App.vue', start_line: 45, end_line: 60 });
      expect(result.warnings).toHaveLength(0);
    });

    it('preserves reasoning key', async () => {
      const jsonlPath = join(tempDir, 'test.jsonl');
      writeFileSync(jsonlPath, '{"file": "src/App.vue", "start_line": 1, "end_line": 10, "reasoning": "Extract component header"}\n');

      const result = await parseJsonlFile(jsonlPath);

      expect(result.targets).toHaveLength(1);
      expect(result.targets[0]).toEqual({ file: 'src/App.vue', start_line: 1, end_line: 10, reasoning: 'Extract component header' });
      expect(result.warnings).toHaveLength(0);
    });

    it('ignores extra keys other than reasoning', async () => {
      const jsonlPath = join(tempDir, 'test.jsonl');
      writeFileSync(jsonlPath, '{"file": "src/App.vue", "start_line": 1, "end_line": 10, "reasoning": "Extract component header", "extra": "data"}\n');

      const result = await parseJsonlFile(jsonlPath);

      expect(result.targets).toHaveLength(1);
      expect(result.targets[0]).toEqual({ file: 'src/App.vue', start_line: 1, end_line: 10, reasoning: 'Extract component header' });
      expect(result.warnings).toHaveLength(0);
    });

    it('preserves targets in file order', async () => {
      const jsonlPath = join(tempDir, 'test.jsonl');
      writeFileSync(jsonlPath, 
        '{"file": "first.ts"}\n{"file": "second.ts"}\n{"file": "third.ts"}\n'
      );

      const result = await parseJsonlFile(jsonlPath);

      expect(result.targets.map(t => t.file)).toEqual(['first.ts', 'second.ts', 'third.ts']);
    });

    it('handles mixed full-file and range targets', async () => {
      const jsonlPath = join(tempDir, 'test.jsonl');
      writeFileSync(jsonlPath, 
        '{"file": "full.ts"}\n{"file": "range.ts", "start_line": 5, "end_line": 15}\n{"file": "another.ts"}\n'
      );

      const result = await parseJsonlFile(jsonlPath);

      expect(result.targets).toHaveLength(3);
      expect(result.targets[0].start_line).toBeUndefined();
      expect(result.targets[1].start_line).toBe(5);
      expect(result.targets[2].end_line).toBeUndefined();
    });
  });

  describe('empty lines handling', () => {
    it('skips empty lines', async () => {
      const jsonlPath = join(tempDir, 'test.jsonl');
      writeFileSync(jsonlPath, '\n{"file": "test.ts"}\n\n{"file": "test2.ts"}\n\n');

      const result = await parseJsonlFile(jsonlPath);

      expect(result.targets).toHaveLength(2);
      expect(result.warnings).toHaveLength(0);
    });

    it('skips lines with only whitespace', async () => {
      const jsonlPath = join(tempDir, 'test.jsonl');
      writeFileSync(jsonlPath, '   \n{"file": "test.ts"}\n\t\n{"file": "test2.ts"}\n   \n');

      const result = await parseJsonlFile(jsonlPath);

      expect(result.targets).toHaveLength(2);
      expect(result.warnings).toHaveLength(0);
    });

    it('handles completely empty file', async () => {
      const jsonlPath = join(tempDir, 'test.jsonl');
      writeFileSync(jsonlPath, '');

      const result = await parseJsonlFile(jsonlPath);

      expect(result.targets).toHaveLength(0);
      expect(result.warnings).toHaveLength(0);
    });

    it('handles file with only whitespace', async () => {
      const jsonlPath = join(tempDir, 'test.jsonl');
      writeFileSync(jsonlPath, '   \n\t\n   \n');

      const result = await parseJsonlFile(jsonlPath);

      expect(result.targets).toHaveLength(0);
      expect(result.warnings).toHaveLength(0);
    });
  });

  describe('invalid JSON handling', () => {
    it('reports invalid JSON lines with line numbers', async () => {
      const jsonlPath = join(tempDir, 'test.jsonl');
      writeFileSync(jsonlPath, '{"file": "valid.ts"}\nnot valid json\n{"file": "valid2.ts"}\n');

      const result = await parseJsonlFile(jsonlPath);

      expect(result.targets).toHaveLength(2);
      expect(result.warnings).toHaveLength(1);
      expect(result.warnings[0].lineNumber).toBe(2);
      expect(result.warnings[0].rawLine).toBe('not valid json');
      expect(result.warnings[0].message).toContain('invalid JSONL at line 2');
    });

    it('continues processing after invalid JSON', async () => {
      const jsonlPath = join(tempDir, 'test.jsonl');
      writeFileSync(jsonlPath, 
        '{"file": "first.ts"}\nbad json\n{"file": "second.ts"}\nmore bad json\n{"file": "third.ts"}\n'
      );

      const result = await parseJsonlFile(jsonlPath);

      expect(result.targets).toHaveLength(3);
      expect(result.targets.map(t => t.file)).toEqual(['first.ts', 'second.ts', 'third.ts']);
      expect(result.warnings).toHaveLength(2);
    });

    it('handles completely invalid JSONL file', async () => {
      const jsonlPath = join(tempDir, 'test.jsonl');
      writeFileSync(jsonlPath, 'not json\nanother bad line\n');

      const result = await parseJsonlFile(jsonlPath);

      expect(result.targets).toHaveLength(0);
      expect(result.warnings).toHaveLength(2);
    });

    it('handles JSON array instead of object', async () => {
      const jsonlPath = join(tempDir, 'test.jsonl');
      writeFileSync(jsonlPath, '["not", "valid"]\n{"file": "valid.ts"}\n');

      const result = await parseJsonlFile(jsonlPath);

      expect(result.targets).toHaveLength(1);
      expect(result.warnings).toHaveLength(1);
      expect(result.warnings[0].lineNumber).toBe(1);
    });

    it('handles JSON primitive instead of object', async () => {
      const jsonlPath = join(tempDir, 'test.jsonl');
      writeFileSync(jsonlPath, '"just a string"\n123\ntrue\nnull\n{"file": "valid.ts"}\n');

      const result = await parseJsonlFile(jsonlPath);

      expect(result.targets).toHaveLength(1);
      expect(result.warnings).toHaveLength(4);
    });
  });

  describe('invalid target structure handling', () => {
    it('reports missing file', async () => {
      const jsonlPath = join(tempDir, 'test.jsonl');
      writeFileSync(jsonlPath, '{"start_line": 1, "end_line": 10}\n{"file": "valid.ts"}\n');

      const result = await parseJsonlFile(jsonlPath);

      expect(result.targets).toHaveLength(1);
      expect(result.warnings).toHaveLength(1);
      expect(result.warnings[0].lineNumber).toBe(1);
      expect(result.warnings[0].message).toContain('invalid JSONL');
    });

    it('reports empty file', async () => {
      const jsonlPath = join(tempDir, 'test.jsonl');
      writeFileSync(jsonlPath, '{"file": ""}\n{"file": "valid.ts"}\n');

      const result = await parseJsonlFile(jsonlPath);

      expect(result.targets).toHaveLength(1);
      expect(result.warnings).toHaveLength(1);
    });

    it('reports non-string file', async () => {
      const jsonlPath = join(tempDir, 'test.jsonl');
      writeFileSync(jsonlPath, '{"file": 123}\n{"file": "valid.ts"}\n');

      const result = await parseJsonlFile(jsonlPath);

      expect(result.targets).toHaveLength(1);
      expect(result.warnings).toHaveLength(1);
    });

    it('reports invalid start_line values', async () => {
      const jsonlPath = join(tempDir, 'test.jsonl');
      writeFileSync(jsonlPath, 
        '{"file": "test.ts", "start_line": 0}\n' +
        '{"file": "test.ts", "start_line": -1}\n' +
        '{"file": "test.ts", "start_line": 1.5}\n' +
        '{"file": "valid.ts"}\n'
      );

      const result = await parseJsonlFile(jsonlPath);

      expect(result.targets).toHaveLength(1);
      expect(result.warnings).toHaveLength(3);
    });

    it('reports invalid end_line values', async () => {
      const jsonlPath = join(tempDir, 'test.jsonl');
      writeFileSync(jsonlPath, 
        '{"file": "test.ts", "end_line": 0}\n' +
        '{"file": "test.ts", "end_line": -10}\n' +
        '{"file": "test.ts", "end_line": "not a number"}\n' +
        '{"file": "valid.ts"}\n'
      );

      const result = await parseJsonlFile(jsonlPath);

      expect(result.targets).toHaveLength(1);
      expect(result.warnings).toHaveLength(3);
    });

    it('accepts valid start_line and end_line', async () => {
      const jsonlPath = join(tempDir, 'test.jsonl');
      writeFileSync(jsonlPath, 
        '{"file": "test.ts", "start_line": 1, "end_line": 10}\n' +
        '{"file": "test.ts", "start_line": 100, "end_line": 200}\n'
      );

      const result = await parseJsonlFile(jsonlPath);

      expect(result.targets).toHaveLength(2);
      expect(result.warnings).toHaveLength(0);
    });
  });

  describe('partial range specification handling', () => {
    it('preserves start_line-only target', async () => {
      const jsonlPath = join(tempDir, 'test.jsonl');
      writeFileSync(jsonlPath, '{"file": "test.ts", "start_line": 5}\n');

      const result = await parseJsonlFile(jsonlPath);

      expect(result.targets).toHaveLength(1);
      expect(result.targets[0].file).toBe('test.ts');
      expect(result.targets[0].start_line).toBe(5);
      expect(result.targets[0].end_line).toBeUndefined();
    });

    it('preserves end_line-only target', async () => {
      const jsonlPath = join(tempDir, 'test.jsonl');
      writeFileSync(jsonlPath, '{"file": "test.ts", "end_line": 20}\n');

      const result = await parseJsonlFile(jsonlPath);

      expect(result.targets).toHaveLength(1);
      expect(result.targets[0].file).toBe('test.ts');
      expect(result.targets[0].start_line).toBeUndefined();
      expect(result.targets[0].end_line).toBe(20);
    });

    it('preserves full range when both start_line and end_line provided', async () => {
      const jsonlPath = join(tempDir, 'test.jsonl');
      writeFileSync(jsonlPath, '{"file": "test.ts", "start_line": 5, "end_line": 20}\n');

      const result = await parseJsonlFile(jsonlPath);

      expect(result.targets).toHaveLength(1);
      expect(result.targets[0].start_line).toBe(5);
      expect(result.targets[0].end_line).toBe(20);
    });

    it('handles mixed partial and full specifications', async () => {
      const jsonlPath = join(tempDir, 'test.jsonl');
      writeFileSync(jsonlPath, 
        '{"file": "only-start.ts", "start_line": 5}\n' +
        '{"file": "only-end.ts", "end_line": 20}\n' +
        '{"file": "full-range.ts", "start_line": 5, "end_line": 20}\n' +
        '{"file": "full-file.ts"}\n'
      );

      const result = await parseJsonlFile(jsonlPath);

      expect(result.targets).toHaveLength(4);
      // start_line-only preserved
      expect(result.targets[0].start_line).toBe(5);
      expect(result.targets[0].end_line).toBeUndefined();
      // end_line-only preserved
      expect(result.targets[1].end_line).toBe(20);
      expect(result.targets[1].start_line).toBeUndefined();
      // Full range preserved
      expect(result.targets[2].start_line).toBe(5);
      expect(result.targets[2].end_line).toBe(20);
      // Full-file unchanged
      expect(result.targets[3].start_line).toBeUndefined();
    });
  });

  describe('complex scenarios', () => {
    it('handles file with comments in JSON (not valid JSONL)', async () => {
      const jsonlPath = join(tempDir, 'test.jsonl');
      writeFileSync(jsonlPath, 
        '// This is a comment\n' +
        '{"file": "valid.ts"}\n' +
        '# Another comment style\n' +
        '{"file": "valid2.ts"}\n'
      );

      const result = await parseJsonlFile(jsonlPath);

      // Comments are not valid JSON, so they should be warnings
      expect(result.targets).toHaveLength(2);
      expect(result.warnings).toHaveLength(2);
    });

    it('preserves whitespace in file path (valid but unusual)', async () => {
      const jsonlPath = join(tempDir, 'test.jsonl');
      writeFileSync(jsonlPath, '{"file": "path with spaces/file.ts"}\n');

      const result = await parseJsonlFile(jsonlPath);

      expect(result.targets).toHaveLength(1);
      expect(result.targets[0].file).toBe('path with spaces/file.ts');
    });

    it('handles large line numbers', async () => {
      const jsonlPath = join(tempDir, 'test.jsonl');
      writeFileSync(jsonlPath, '{"file": "test.ts", "start_line": 999999, "end_line": 1000000}\n');

      const result = await parseJsonlFile(jsonlPath);

      expect(result.targets).toHaveLength(1);
      expect(result.targets[0].start_line).toBe(999999);
      expect(result.targets[0].end_line).toBe(1000000);
    });
  });
});
