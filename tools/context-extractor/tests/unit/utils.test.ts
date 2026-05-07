import { describe, it, expect } from 'vitest';
import { getFileExtension, getLanguageForExtension, isValidExtractionTarget, buildContextPrefix } from '../../src/utils.js';

describe('getFileExtension', () => {
  it('extracts extension without dot for regular files', () => {
    expect(getFileExtension('src/App.vue')).toBe('vue');
    expect(getFileExtension('/path/to/file.ts')).toBe('ts');
    expect(getFileExtension('file.js')).toBe('js');
    expect(getFileExtension('deep/nested/path/file.tsx')).toBe('tsx');
  });

  it('handles uppercase extensions', () => {
    expect(getFileExtension('file.VUE')).toBe('vue');
    expect(getFileExtension('file.TS')).toBe('ts');
    expect(getFileExtension('file.JS')).toBe('js');
  });

  it('returns "text" for files without extension', () => {
    expect(getFileExtension('Makefile')).toBe('text');
    expect(getFileExtension('Dockerfile')).toBe('text');
    expect(getFileExtension('/path/to/no-extension')).toBe('text');
    expect(getFileExtension('.gitignore')).toBe('text');
  });

  it('handles files with dots in name but no extension', () => {
    expect(getFileExtension('some.file.with.dots')).toBe('dots');
    expect(getFileExtension('.eslintrc')).toBe('text');
  });

  it('handles edge cases', () => {
    expect(getFileExtension('')).toBe('text');
    expect(getFileExtension('.')).toBe('text');
    expect(getFileExtension('..')).toBe('text');
  });
});

describe('getLanguageForExtension', () => {
  it('maps common extensions correctly', () => {
    expect(getLanguageForExtension('js')).toBe('javascript');
    expect(getLanguageForExtension('ts')).toBe('typescript');
    expect(getLanguageForExtension('jsx')).toBe('jsx');
    expect(getLanguageForExtension('tsx')).toBe('tsx');
    expect(getLanguageForExtension('py')).toBe('python');
    expect(getLanguageForExtension('rb')).toBe('ruby');
    expect(getLanguageForExtension('go')).toBe('go');
    expect(getLanguageForExtension('rs')).toBe('rust');
    expect(getLanguageForExtension('java')).toBe('java');
  });

  it('maps web framework extensions correctly', () => {
    expect(getLanguageForExtension('vue')).toBe('vue');
    expect(getLanguageForExtension('svelte')).toBe('svelte');
    expect(getLanguageForExtension('astro')).toBe('astro');
  });

  it('maps style and markup extensions correctly', () => {
    expect(getLanguageForExtension('css')).toBe('css');
    expect(getLanguageForExtension('scss')).toBe('scss');
    expect(getLanguageForExtension('sass')).toBe('sass');
    expect(getLanguageForExtension('html')).toBe('html');
    expect(getLanguageForExtension('xml')).toBe('xml');
  });

  it('maps config/data format extensions correctly', () => {
    expect(getLanguageForExtension('json')).toBe('json');
    expect(getLanguageForExtension('yaml')).toBe('yaml');
    expect(getLanguageForExtension('yml')).toBe('yaml');
    expect(getLanguageForExtension('toml')).toBe('toml');
    expect(getLanguageForExtension('md')).toBe('markdown');
  });

  it('maps shell extensions correctly', () => {
    expect(getLanguageForExtension('sh')).toBe('bash');
    expect(getLanguageForExtension('bash')).toBe('bash');
    expect(getLanguageForExtension('zsh')).toBe('zsh');
    expect(getLanguageForExtension('ps1')).toBe('powershell');
  });

  it('handles kotlin variants', () => {
    expect(getLanguageForExtension('kt')).toBe('kotlin');
    expect(getLanguageForExtension('kts')).toBe('kotlin');
  });

  it('handles C/C++ variants', () => {
    expect(getLanguageForExtension('c')).toBe('c');
    expect(getLanguageForExtension('cpp')).toBe('cpp');
    expect(getLanguageForExtension('h')).toBe('c');
    expect(getLanguageForExtension('hpp')).toBe('cpp');
  });

  it('handles uppercase extensions', () => {
    expect(getLanguageForExtension('JS')).toBe('javascript');
    expect(getLanguageForExtension('TS')).toBe('typescript');
    expect(getLanguageForExtension('VUE')).toBe('vue');
  });

  it('returns the extension itself if not in mapping', () => {
    expect(getLanguageForExtension('unknown')).toBe('unknown');
    expect(getLanguageForExtension('xyz')).toBe('xyz');
  });

  it('returns "text" for empty extension', () => {
    expect(getLanguageForExtension('')).toBe('text');
  });
});

describe('buildContextPrefix', () => {
  it('returns content up to and including ## File Contents heading', () => {
    const content = '# Project Context\n\n## Project Tree\n\n```\nsrc/\n```\n\n## File Contents\n\n<file path="a.ts">\n```ts\nconst a = 1;\n```\n</file>';
    const result = buildContextPrefix(content);
    expect(result).toBe('# Project Context\n\n## Project Tree\n\n```\nsrc/\n```\n\n## File Contents');
  });

  it('appends ## File Contents when heading is missing', () => {
    const content = '# Project Context\n\n## Project Tree\n\n```\nsrc/\n```\n';
    const result = buildContextPrefix(content);
    expect(result).toBe('# Project Context\n\n## Project Tree\n\n```\nsrc/\n```\n\n## File Contents');
  });

  it('handles content with no trailing newline when heading is missing', () => {
    const content = '# Project Context';
    const result = buildContextPrefix(content);
    expect(result).toBe('# Project Context\n\n## File Contents');
  });

  it('handles heading at the very beginning', () => {
    const content = '## File Contents\n\n<file path="a.ts">';
    const result = buildContextPrefix(content);
    expect(result).toBe('## File Contents');
  });

  it('handles heading with surrounding whitespace', () => {
    const content = '# Context\n  ## File Contents  \n<file path="a.ts">';
    const result = buildContextPrefix(content);
    expect(result).toBe('# Context\n  ## File Contents  ');
  });
});

describe('isValidExtractionTarget', () => {
  it('accepts valid full-file target', () => {
    expect(isValidExtractionTarget({ file: 'test.ts' })).toBe(true);
    expect(isValidExtractionTarget({ file: '/absolute/path.ts' })).toBe(true);
    expect(isValidExtractionTarget({ file: 'relative/path.vue' })).toBe(true);
  });

  it('accepts valid range target with both start_line and end_line', () => {
    expect(isValidExtractionTarget({ file: 'test.ts', start_line: 1, end_line: 10 })).toBe(true);
    expect(isValidExtractionTarget({ file: 'test.ts', start_line: 100, end_line: 200 })).toBe(true);
  });

  it('accepts valid target with reasoning', () => {
    expect(isValidExtractionTarget({ file: 'test.ts', reasoning: 'some reason' })).toBe(true);
    expect(isValidExtractionTarget({ file: 'test.ts', start_line: 1, end_line: 10, reasoning: 'some reason' })).toBe(true);
  });

  it('accepts valid target with extra keys', () => {
    expect(isValidExtractionTarget({ file: 'test.ts', extra: 'data' })).toBe(true);
    expect(isValidExtractionTarget({ file: 'test.ts', custom_field: 123, another: true })).toBe(true);
  });

  it('accepts target with only start_line', () => {
    expect(isValidExtractionTarget({ file: 'test.ts', start_line: 1 })).toBe(true);
  });

  it('accepts target with only end_line', () => {
    expect(isValidExtractionTarget({ file: 'test.ts', end_line: 10 })).toBe(true);
  });

  it('rejects non-object values', () => {
    expect(isValidExtractionTarget(null)).toBe(false);
    expect(isValidExtractionTarget(undefined)).toBe(false);
    expect(isValidExtractionTarget('string')).toBe(false);
    expect(isValidExtractionTarget(123)).toBe(false);
    expect(isValidExtractionTarget(true)).toBe(false);
    expect(isValidExtractionTarget([])).toBe(false);
  });

  it('rejects missing file', () => {
    expect(isValidExtractionTarget({})).toBe(false);
    expect(isValidExtractionTarget({ start_line: 1, end_line: 10 })).toBe(false);
  });

  it('rejects empty file', () => {
    expect(isValidExtractionTarget({ file: '' })).toBe(false);
  });

  it('rejects non-string file', () => {
    expect(isValidExtractionTarget({ file: 123 })).toBe(false);
    expect(isValidExtractionTarget({ file: null })).toBe(false);
    expect(isValidExtractionTarget({ file: undefined })).toBe(false);
    expect(isValidExtractionTarget({ file: [] })).toBe(false);
    expect(isValidExtractionTarget({ file: {} })).toBe(false);
  });

  it('rejects invalid start_line values', () => {
    expect(isValidExtractionTarget({ file: 'test.ts', start_line: 0 })).toBe(false);
    expect(isValidExtractionTarget({ file: 'test.ts', start_line: -1 })).toBe(false);
    expect(isValidExtractionTarget({ file: 'test.ts', start_line: -100 })).toBe(false);
    expect(isValidExtractionTarget({ file: 'test.ts', start_line: 1.5 })).toBe(false);
    expect(isValidExtractionTarget({ file: 'test.ts', start_line: '1' })).toBe(false);
    expect(isValidExtractionTarget({ file: 'test.ts', start_line: null })).toBe(false);
  });

  it('rejects invalid end_line values', () => {
    expect(isValidExtractionTarget({ file: 'test.ts', end_line: 0 })).toBe(false);
    expect(isValidExtractionTarget({ file: 'test.ts', end_line: -1 })).toBe(false);
    expect(isValidExtractionTarget({ file: 'test.ts', end_line: -100 })).toBe(false);
    expect(isValidExtractionTarget({ file: 'test.ts', end_line: 1.5 })).toBe(false);
    expect(isValidExtractionTarget({ file: 'test.ts', end_line: '10' })).toBe(false);
    expect(isValidExtractionTarget({ file: 'test.ts', end_line: null })).toBe(false);
  });

  it('rejects invalid reasoning values', () => {
    expect(isValidExtractionTarget({ file: 'test.ts', reasoning: 123 })).toBe(false);
    expect(isValidExtractionTarget({ file: 'test.ts', reasoning: null })).toBe(false);
    expect(isValidExtractionTarget({ file: 'test.ts', reasoning: {} })).toBe(false);
  });

  it('rejects targets with both invalid start_line and end_line', () => {
    expect(isValidExtractionTarget({ file: 'test.ts', start_line: 0, end_line: 0 })).toBe(false);
    expect(isValidExtractionTarget({ file: 'test.ts', start_line: -1, end_line: -10 })).toBe(false);
  });
});
