import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, readFileSync, rmSync, mkdirSync } from 'fs';
import { tmpdir } from 'os';
import { join, resolve } from 'path';
import { spawnSync } from 'child_process';

// Path to the CLI entry point (relative to this test file)
const CLI_PATH = resolve(__dirname, '../../dist/index.js');

describe('context-extractor CLI integration', () => {
  let tempDir: string;
  let originalCwd: string;

  beforeEach(() => {
    originalCwd = process.cwd();
    tempDir = mkdtempSync(join(tmpdir(), 'cli-test-'));
    process.chdir(tempDir);
  });

  afterEach(() => {
    process.chdir(originalCwd);
    rmSync(tempDir, { recursive: true, force: true });
  });

  function runCLI(args: string = ''): { stdout: string; stderr: string; exitCode: number } {
    const result = spawnSync('node', [CLI_PATH, ...args.split(' ').filter(Boolean)], {
      encoding: 'utf-8',
      cwd: tempDir,
    });
    return {
      stdout: result.stdout || '',
      stderr: result.stderr || '',
      exitCode: result.status ?? (result.error ? 1 : 0),
    };
  }

  describe('CLI execution with valid input', () => {
    it('processes valid JSONL with default output path', () => {
      // Create test files
      writeFileSync(join(tempDir, 'sample.ts'), 'const x = 1;\nconst y = 2;\n');
      writeFileSync(join(tempDir, 'targets.jsonl'), '{"file": "sample.ts"}\n');

      const result = runCLI('--input targets.jsonl');

      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain('Done');
      expect(result.stdout).toContain('1 blocks written');
      expect(result.stdout).toContain('llm_target.md');

      const outputContent = readFileSync(join(tempDir, 'llm_target.md'), 'utf-8');
      expect(outputContent).toContain('<file path="sample.ts">');
      expect(outputContent).toContain('```ts');
      expect(outputContent).toContain('const x = 1;');
    });

    it('processes multiple targets in order', () => {
      writeFileSync(join(tempDir, 'file1.ts'), 'export const a = 1;\n');
      writeFileSync(join(tempDir, 'file2.ts'), 'export const b = 2;\n');
      writeFileSync(join(tempDir, 'targets.jsonl'), 
        '{"file": "file1.ts"}\n{"file": "file2.ts"}\n'
      );

      const result = runCLI('--input targets.jsonl');

      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain('2 blocks written');

      const outputContent = readFileSync(join(tempDir, 'llm_target.md'), 'utf-8');
      const firstFileIndex = outputContent.indexOf('file1.ts');
      const secondFileIndex = outputContent.indexOf('file2.ts');
      expect(firstFileIndex).toBeLessThan(secondFileIndex);
    });

    it('processes range extraction targets', () => {
      writeFileSync(join(tempDir, 'sample.ts'), 
        'line 1\nline 2\nline 3\nline 4\nline 5\n'
      );
      writeFileSync(join(tempDir, 'targets.jsonl'), 
        '{"file": "sample.ts", "start_line": 2, "end_line": 4}\n'
      );

      const result = runCLI('--input targets.jsonl');

      expect(result.exitCode).toBe(0);

      const outputContent = readFileSync(join(tempDir, 'llm_target.md'), 'utf-8');
      expect(outputContent).toContain('start_line="2"');
      expect(outputContent).toContain('end_line="4"');
      expect(outputContent).toContain('line 2');
      expect(outputContent).toContain('line 3');
      expect(outputContent).toContain('line 4');
      expect(outputContent).not.toContain('line 1');
      expect(outputContent).not.toContain('line 5');
    });

    it('includes reasoning in output when present', () => {
      writeFileSync(join(tempDir, 'sample.ts'), 'const x = 1;\n');
      writeFileSync(join(tempDir, 'targets.jsonl'), 
        '{"file": "sample.ts", "reasoning": "This is a test file"}\n'
      );

      const result = runCLI('--input targets.jsonl');

      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain('1 blocks written');

      const outputContent = readFileSync(join(tempDir, 'llm_target.md'), 'utf-8');
      expect(outputContent).toContain('<reasoning>This is a test file</reasoning>');
    });
  });

  describe('CLI with custom output path', () => {
    it('writes to custom output path', () => {
      writeFileSync(join(tempDir, 'sample.ts'), 'const x = 1;\n');
      writeFileSync(join(tempDir, 'input.jsonl'), '{"file": "sample.ts"}\n');

      const result = runCLI('--input input.jsonl --output custom-output.md');

      expect(result.exitCode).toBe(0);

      const outputContent = readFileSync(join(tempDir, 'custom-output.md'), 'utf-8');
      expect(outputContent).toContain('<file path="sample.ts">');
    });

    it('writes to nested output path', () => {
      mkdirSync(join(tempDir, 'output'), { recursive: true });
      writeFileSync(join(tempDir, 'sample.ts'), 'const x = 1;\n');
      writeFileSync(join(tempDir, 'targets.jsonl'), '{"file": "sample.ts"}\n');

      const result = runCLI('--input targets.jsonl --output output/nested/result.md');

      expect(result.exitCode).toBe(0);

      const outputContent = readFileSync(join(tempDir, 'output/nested/result.md'), 'utf-8');
      expect(outputContent).toContain('<file');
    });

    it('accepts short flags', () => {
      writeFileSync(join(tempDir, 'sample.ts'), 'const x = 1;\n');
      writeFileSync(join(tempDir, 'my-input.jsonl'), '{"file": "sample.ts"}\n');

      const result = runCLI('-i my-input.jsonl -o my-output.md');

      expect(result.exitCode).toBe(0);

      const outputContent = readFileSync(join(tempDir, 'my-output.md'), 'utf-8');
      expect(outputContent).toContain('<file');
    });
  });

  describe('mixed valid/invalid JSONL handling', () => {
    it('continues processing after invalid JSON lines', () => {
      writeFileSync(join(tempDir, 'valid.ts'), 'const x = 1;\n');
      writeFileSync(join(tempDir, 'targets.jsonl'), 
        '{"file": "valid.ts"}\n' +
        'not valid json\n' +
        '{"file": "valid.ts"}\n'
      );

      const result = runCLI('--input targets.jsonl');

      expect(result.exitCode).toBe(0);
      expect(result.stderr).toContain('WARN: invalid JSONL at line 2: not valid json');
      expect(result.stdout).toContain('2 blocks written');
      expect(result.stdout).toContain('1 warnings');
    });

    it('continues after invalid target structure', () => {
      writeFileSync(join(tempDir, 'valid.ts'), 'const x = 1;\n');
      writeFileSync(join(tempDir, 'targets.jsonl'), 
        '{"file": "valid.ts"}\n' +
        '{"missing": "file"}\n' +
        '{"file": "valid.ts"}\n'
      );

      const result = runCLI('--input targets.jsonl');

      expect(result.exitCode).toBe(0);
      expect(result.stderr).toContain('WARN: invalid JSONL at line 2: {"missing": "file"}');
      expect(result.stdout).toContain('2 blocks written');
      expect(result.stdout).toContain('1 warnings');
    });

    it('skips empty lines', () => {
      writeFileSync(join(tempDir, 'sample.ts'), 'const x = 1;\n');
      writeFileSync(join(tempDir, 'targets.jsonl'), 
        '\n{"file": "sample.ts"}\n\n{"file": "sample.ts"}\n\n'
      );

      const result = runCLI('--input targets.jsonl');

      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain('2 blocks written');
      expect(result.stdout).toContain('0 warnings');
    });
  });

  describe('multiple file extractions', () => {
    it('extracts from multiple different files', () => {
      writeFileSync(join(tempDir, 'component.vue'), '<template>Hello</template>\n');
      writeFileSync(join(tempDir, 'utils.ts'), 'export function helper() {}\n');
      writeFileSync(join(tempDir, 'style.css'), '.class { color: red; }\n');
      writeFileSync(join(tempDir, 'targets.jsonl'), 
        '{"file": "component.vue"}\n' +
        '{"file": "utils.ts"}\n' +
        '{"file": "style.css"}\n'
      );

      const result = runCLI('--input targets.jsonl');

      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain('3 blocks written');

      const outputContent = readFileSync(join(tempDir, 'llm_target.md'), 'utf-8');
      expect(outputContent).toContain('```vue');
      expect(outputContent).toContain('```ts');
      expect(outputContent).toContain('```css');
    });

    it('extracts ranges from multiple files', () => {
      writeFileSync(join(tempDir, 'file1.ts'), 'line1\nline2\nline3\n');
      writeFileSync(join(tempDir, 'file2.ts'), 'lineA\nlineB\nlineC\n');
      writeFileSync(join(tempDir, 'targets.jsonl'), 
        '{"file": "file1.ts", "start_line": 1, "end_line": 2}\n' +
        '{"file": "file2.ts", "start_line": 2, "end_line": 3}\n'
      );

      const result = runCLI('--input targets.jsonl');

      expect(result.exitCode).toBe(0);

      const outputContent = readFileSync(join(tempDir, 'llm_target.md'), 'utf-8');
      expect(outputContent).toContain('line1');
      expect(outputContent).toContain('line2');
      expect(outputContent).toContain('lineB');
      expect(outputContent).toContain('lineC');
    });
  });

  describe('summary output verification', () => {
    it('prints correct summary for successful run', () => {
      writeFileSync(join(tempDir, 'sample.ts'), 'const x = 1;\n');
      writeFileSync(join(tempDir, 'targets.jsonl'), '{"file": "sample.ts"}\n');

      const result = runCLI('--input targets.jsonl');

      expect(result.exitCode).toBe(0);
      expect(result.stdout).toMatch(/Done\. \d+ blocks? written to .*\. \d+ warnings?\./);
    });

    it('prints correct summary with warnings', () => {
      writeFileSync(join(tempDir, 'sample.ts'), 'const x = 1;\n');
      writeFileSync(join(tempDir, 'targets.jsonl'), 
        '{"file": "sample.ts"}\n' +
        'invalid json\n'
      );

      const result = runCLI('--input targets.jsonl');

      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain('1 blocks written');
      expect(result.stdout).toContain('1 warnings');
    });

    it('prints correct summary with all warnings', () => {
      writeFileSync(join(tempDir, 'targets.jsonl'), 
        'invalid json\n' +
        '{"file": "missing.ts"}\n'
      );

      const result = runCLI('--input targets.jsonl');

      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain('0 blocks written');
      expect(result.stdout).toContain('2 warnings');
    });
  });

  describe('missing file warnings', () => {
    it('prints warning for missing file', () => {
      writeFileSync(join(tempDir, 'targets.jsonl'), '{"file": "does-not-exist.ts"}\n');

      const result = runCLI('--input targets.jsonl');

      expect(result.exitCode).toBe(0);
      expect(result.stderr).toBe('WARN: file not found: does-not-exist.ts\n');
      expect(result.stdout).toContain('0 blocks written');
      expect(result.stdout).toContain('1 warnings');
    });

    it('continues processing after missing file', () => {
      writeFileSync(join(tempDir, 'exists.ts'), 'const x = 1;\n');
      writeFileSync(join(tempDir, 'targets.jsonl'), 
        '{"file": "missing.ts"}\n' +
        '{"file": "exists.ts"}\n' +
        '{"file": "also-missing.ts"}\n'
      );

      const result = runCLI('--input targets.jsonl');

      expect(result.exitCode).toBe(0);
      expect(result.stderr).toContain('WARN: file not found: missing.ts');
      expect(result.stderr).toContain('WARN: file not found: also-missing.ts');
      expect(result.stdout).toContain('1 blocks written');
      expect(result.stdout).toContain('2 warnings');

      const outputContent = readFileSync(join(tempDir, 'llm_target.md'), 'utf-8');
      expect(outputContent).toContain('exists.ts');
      expect(outputContent).not.toContain('missing.ts');
    });
  });

  describe('out-of-bounds warnings', () => {
    it('prints warning for out-of-bounds start_line', () => {
      writeFileSync(join(tempDir, 'sample.ts'), 'line1\nline2\n');
      writeFileSync(join(tempDir, 'targets.jsonl'), 
        '{"file": "sample.ts", "start_line": 100, "end_line": 110}\n'
      );

      const result = runCLI('--input targets.jsonl');

      expect(result.exitCode).toBe(0);
      expect(result.stderr).toBe('WARN: start_line 100 out of bounds for sample.ts (2 lines)\n');
      expect(result.stdout).toContain('0 blocks written');
    });

    it('caps end_line silently and proceeds', () => {
      writeFileSync(join(tempDir, 'sample.ts'), 'line1\nline2\nline3\n');
      writeFileSync(join(tempDir, 'targets.jsonl'), 
        '{"file": "sample.ts", "start_line": 2, "end_line": 999}\n'
      );

      const result = runCLI('--input targets.jsonl');

      expect(result.exitCode).toBe(0);
      expect(result.stderr).not.toContain('out of bounds');
      expect(result.stdout).toContain('1 blocks written');

      const outputContent = readFileSync(join(tempDir, 'llm_target.md'), 'utf-8');
      expect(outputContent).toContain('end_line="3"');
    });
  });

  describe('help and version flags', () => {
    it('displays help with --help', () => {
      const result = runCLI('--help');

      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain('Usage:');
      expect(result.stdout).toContain('--input');
      expect(result.stdout).toContain('--output');
      expect(result.stdout).toContain('--version');
    });

    it('displays version with --version', () => {
      const result = runCLI('--version');

      expect(result.exitCode).toBe(0);
      expect(result.stdout).toMatch(/^\d+\.\d+\.\d+/);
    });

    it('displays help with -h', () => {
      const result = runCLI('-h');

      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain('Usage:');
    });

    it('displays version with -V', () => {
      const result = runCLI('-V');

      expect(result.exitCode).toBe(0);
      expect(result.stdout).toMatch(/^\d+/);
    });
  });

  describe('start_line-only extraction', () => {
    it('extracts from start_line to EOF', () => {
      writeFileSync(join(tempDir, 'sample.ts'), 'line1\nline2\nline3\n');
      writeFileSync(join(tempDir, 'targets.jsonl'), 
        '{"file": "sample.ts", "start_line": 2}\n'
      );

      const result = runCLI('--input targets.jsonl');

      expect(result.exitCode).toBe(0);

      const outputContent = readFileSync(join(tempDir, 'llm_target.md'), 'utf-8');
      expect(outputContent).toContain('start_line="2"');
      expect(outputContent).not.toContain('end_line');
      expect(outputContent).toContain('line2');
      expect(outputContent).toContain('line3');
      expect(outputContent).not.toContain('line1');
    });

    it('warns when start_line-only is out of bounds', () => {
      writeFileSync(join(tempDir, 'sample.ts'), 'line1\nline2\n');
      writeFileSync(join(tempDir, 'targets.jsonl'), 
        '{"file": "sample.ts", "start_line": 100}\n'
      );

      const result = runCLI('--input targets.jsonl');

      expect(result.exitCode).toBe(0);
      expect(result.stderr).toContain('WARN: start_line 100 out of bounds for sample.ts (2 lines)');
      expect(result.stdout).toContain('0 blocks written');
    });
  });

  describe('--cwd flag', () => {
    it('resolves relative file paths against custom cwd', () => {
      mkdirSync(join(tempDir, 'project'), { recursive: true });
      writeFileSync(join(tempDir, 'project', 'sample.ts'), 'const x = 1;\n');
      writeFileSync(join(tempDir, 'targets.jsonl'), '{"file": "sample.ts"}\n');

      const result = runCLI('--input targets.jsonl --cwd project');

      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain('1 blocks written');

      const outputContent = readFileSync(join(tempDir, 'llm_target.md'), 'utf-8');
      expect(outputContent).toContain('<file path="sample.ts">');
      expect(outputContent).toContain('```ts');
      expect(outputContent).toContain('const x = 1;');
    });

    it('works with cwd as absolute path', () => {
      const projectDir = join(tempDir, 'project');
      mkdirSync(projectDir, { recursive: true });
      writeFileSync(join(projectDir, 'sample.ts'), 'const x = 1;\n');
      writeFileSync(join(tempDir, 'targets.jsonl'), '{"file": "sample.ts"}\n');

      const result = runCLI(`--input targets.jsonl --cwd ${projectDir}`);

      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain('1 blocks written');

      const outputContent = readFileSync(join(tempDir, 'llm_target.md'), 'utf-8');
      expect(outputContent).toContain('<file path="sample.ts">');
    });
  });

  describe('files without extension', () => {
    it('handles files without extension', () => {
      writeFileSync(join(tempDir, 'Makefile'), 'build: npm run build\n');
      writeFileSync(join(tempDir, 'targets.jsonl'), '{"file": "Makefile"}\n');

      const result = runCLI('--input targets.jsonl');

      expect(result.exitCode).toBe(0);

      const outputContent = readFileSync(join(tempDir, 'llm_target.md'), 'utf-8');
      expect(outputContent).toContain('```text');
      expect(outputContent).toContain('Makefile');
    });
  });

  describe('edge cases', () => {
    it('handles empty JSONL file', () => {
      writeFileSync(join(tempDir, 'targets.jsonl'), '');

      const result = runCLI('--input targets.jsonl');

      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain('0 blocks written');
      expect(result.stdout).toContain('0 warnings');
    });

    it('handles empty file extraction', () => {
      writeFileSync(join(tempDir, 'empty.ts'), '');
      writeFileSync(join(tempDir, 'targets.jsonl'), '{"file": "empty.ts"}\n');

      const result = runCLI('--input targets.jsonl');

      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain('1 blocks written');

      const outputContent = readFileSync(join(tempDir, 'llm_target.md'), 'utf-8');
      expect(outputContent).toContain('<file path="empty.ts">');
      expect(outputContent).toContain('```ts');
    });

    it('handles nested directory structures', () => {
      mkdirSync(join(tempDir, 'src', 'components'), { recursive: true });
      writeFileSync(join(tempDir, 'src/components/Button.vue'), '<template>Button</template>\n');
      writeFileSync(join(tempDir, 'targets.jsonl'), '{"file": "src/components/Button.vue"}\n');

      const result = runCLI('--input targets.jsonl');

      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain('1 blocks written');

      const outputContent = readFileSync(join(tempDir, 'llm_target.md'), 'utf-8');
      expect(outputContent).toContain('src/components/Button.vue');
    });
  });

  describe('--context flag', () => {
    it('prepends context content up to ## File Contents heading', () => {
      writeFileSync(join(tempDir, 'sample.ts'), 'const x = 1;\n');
      writeFileSync(join(tempDir, 'targets.jsonl'), '{"file": "sample.ts"}\n');
      writeFileSync(
        join(tempDir, 'llm_context.md'),
        '# Project Context\n\n## Project Tree\n\n```\nsrc/\n```\n\n## File Contents\n\n<file path="old.ts">\n```ts\nold\n```\n</file>\n'
      );

      const result = runCLI('--input targets.jsonl');

      expect(result.exitCode).toBe(0);
      const outputContent = readFileSync(join(tempDir, 'llm_target.md'), 'utf-8');
      expect(outputContent).toContain('# Project Context');
      expect(outputContent).toContain('## Project Tree');
      expect(outputContent).toContain('## File Contents');
      expect(outputContent).not.toContain('old.ts');
      expect(outputContent).not.toContain('old');
      expect(outputContent).toContain('<file path="sample.ts">');
    });

    it('appends ## File Contents when heading is missing in context file', () => {
      writeFileSync(join(tempDir, 'sample.ts'), 'const x = 1;\n');
      writeFileSync(join(tempDir, 'targets.jsonl'), '{"file": "sample.ts"}\n');
      writeFileSync(
        join(tempDir, 'llm_context.md'),
        '# Project Context\n\n## Project Tree\n\n```\nsrc/\n```\n'
      );

      const result = runCLI('--input targets.jsonl');

      expect(result.exitCode).toBe(0);
      const outputContent = readFileSync(join(tempDir, 'llm_target.md'), 'utf-8');
      expect(outputContent).toContain('# Project Context');
      expect(outputContent).toContain('## Project Tree');
      expect(outputContent).toContain('## File Contents');
      expect(outputContent).toContain('<file path="sample.ts">');
      // Ensure heading appears exactly once in the prefix area
      const fileContentsMatches = outputContent.match(/## File Contents/g);
      expect(fileContentsMatches?.length).toBe(1);
    });

    it('uses custom context path with -c flag', () => {
      writeFileSync(join(tempDir, 'sample.ts'), 'const x = 1;\n');
      writeFileSync(join(tempDir, 'targets.jsonl'), '{"file": "sample.ts"}\n');
      writeFileSync(
        join(tempDir, 'custom-context.md'),
        '# Custom Context\n\n## File Contents\n'
      );

      const result = runCLI('--input targets.jsonl -c custom-context.md');

      expect(result.exitCode).toBe(0);
      const outputContent = readFileSync(join(tempDir, 'llm_target.md'), 'utf-8');
      expect(outputContent).toContain('# Custom Context');
      expect(outputContent).toContain('<file path="sample.ts">');
    });

    it('resolves default context relative to output directory', () => {
      mkdirSync(join(tempDir, 'output'), { recursive: true });
      writeFileSync(join(tempDir, 'sample.ts'), 'const x = 1;\n');
      writeFileSync(join(tempDir, 'targets.jsonl'), '{"file": "sample.ts"}\n');
      writeFileSync(
        join(tempDir, 'output', 'llm_context.md'),
        '# Output Context\n\n## File Contents\n'
      );

      const result = runCLI('--input targets.jsonl --output output/llm_target.md');

      expect(result.exitCode).toBe(0);
      const outputContent = readFileSync(join(tempDir, 'output', 'llm_target.md'), 'utf-8');
      expect(outputContent).toContain('# Output Context');
      expect(outputContent).toContain('<file path="sample.ts">');
    });

    it('skips context silently when file does not exist', () => {
      writeFileSync(join(tempDir, 'sample.ts'), 'const x = 1;\n');
      writeFileSync(join(tempDir, 'targets.jsonl'), '{"file": "sample.ts"}\n');
      // No llm_context.md created

      const result = runCLI('--input targets.jsonl');

      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain('1 blocks written');
      const outputContent = readFileSync(join(tempDir, 'llm_target.md'), 'utf-8');
      expect(outputContent).toContain('<file path="sample.ts">');
      expect(outputContent).toContain('```ts');
      expect(outputContent).toContain('const x = 1;');
      expect(outputContent).toContain('</file>');
      expect(outputContent).not.toContain('# Project Context');
    });
  });

  describe('CLI error handling', () => {
    it('exits non-zero when --input is missing', () => {
      const result = runCLI('');

      expect(result.exitCode).not.toBe(0);
      expect(result.stderr).toContain('error');
      expect(result.stderr).toContain('--input');
    });

    it('handles missing input file gracefully', () => {
      const result = runCLI('--input nonexistent.jsonl');

      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain('Fatal error');
    });
  });
});
