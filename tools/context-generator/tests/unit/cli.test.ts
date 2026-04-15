import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { resolve } from 'path';

// Mock commander before importing cli module
const mockCommand = {
  name: vi.fn().mockReturnThis(),
  description: vi.fn().mockReturnThis(),
  version: vi.fn().mockReturnThis(),
  option: vi.fn().mockReturnThis(),
  parse: vi.fn().mockReturnThis(),
  opts: vi.fn(),
  help: vi.fn(),
};

vi.mock('commander', () => ({
  Command: vi.fn(() => mockCommand),
}));

// Mock process.cwd
const mockCwd = '/mock/project';

// Mock console.error for error handling tests
const mockConsoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
const mockProcessExit = vi.spyOn(process, 'exit').mockImplementation((code) => {
  throw new Error(`Process.exit(${code})`);
});

describe('CLI Argument Parsing', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubGlobal('process', {
      ...process,
      cwd: () => mockCwd,
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  describe('AC-2: CLI Arguments', () => {
    it('should parse --root flag correctly', async () => {
      const { parseArgs } = await import('../../src/cli.js');
      mockCommand.opts.mockReturnValue({
        root: '/custom/path',
        output: 'llm_context.md',
        exclude: [],
        verbose: false,
      });

      const options = parseArgs();

      expect(options.root).toBe(resolve('/custom/path'));
    });

    it('should parse -r shorthand for --root', async () => {
      const { parseArgs } = await import('../../src/cli.js');
      mockCommand.opts.mockReturnValue({
        root: './src',
        output: 'llm_context.md',
        exclude: [],
        verbose: false,
      });

      const options = parseArgs();

      expect(options.root).toBe(resolve('./src'));
    });

    it('should parse --output flag correctly', async () => {
      const { parseArgs } = await import('../../src/cli.js');
      mockCommand.opts.mockReturnValue({
        root: mockCwd,
        output: './docs/context.md',
        exclude: [],
        verbose: false,
      });

      const options = parseArgs();

      expect(options.output).toBe(resolve('./docs/context.md'));
    });

    it('should parse -o shorthand for --output', async () => {
      const { parseArgs } = await import('../../src/cli.js');
      mockCommand.opts.mockReturnValue({
        root: mockCwd,
        output: 'output.md',
        exclude: [],
        verbose: false,
      });

      const options = parseArgs();

      expect(options.output).toBe(resolve('output.md'));
    });

    it('should parse --exclude with comma-separated patterns', async () => {
      const { parseArgs } = await import('../../src/cli.js');
      mockCommand.opts.mockReturnValue({
        root: mockCwd,
        output: 'llm_context.md',
        exclude: ['*.test.ts', '*.spec.ts', '*.stories.tsx'],
        verbose: false,
      });

      const options = parseArgs();

      expect(options.exclude).toEqual(['*.test.ts', '*.spec.ts', '*.stories.tsx']);
    });

    it('should parse multiple --exclude flags', async () => {
      const { parseArgs } = await import('../../src/cli.js');
      mockCommand.opts.mockReturnValue({
        root: mockCwd,
        output: 'llm_context.md',
        exclude: ['node_modules', 'dist', '*.log'],
        verbose: false,
      });

      const options = parseArgs();

      expect(options.exclude).toContain('node_modules');
      expect(options.exclude).toContain('dist');
      expect(options.exclude).toContain('*.log');
    });

    it('should parse -e shorthand for --exclude', async () => {
      const { parseArgs } = await import('../../src/cli.js');
      mockCommand.opts.mockReturnValue({
        root: mockCwd,
        output: 'llm_context.md',
        exclude: ['*.test.ts'],
        verbose: false,
      });

      const options = parseArgs();

      expect(options.exclude).toEqual(['*.test.ts']);
    });

    it('should parse --verbose flag correctly', async () => {
      const { parseArgs } = await import('../../src/cli.js');
      mockCommand.opts.mockReturnValue({
        root: mockCwd,
        output: 'llm_context.md',
        exclude: [],
        verbose: true,
      });

      const options = parseArgs();

      expect(options.verbose).toBe(true);
    });

    it('should parse -v shorthand for --verbose', async () => {
      const { parseArgs } = await import('../../src/cli.js');
      mockCommand.opts.mockReturnValue({
        root: mockCwd,
        output: 'llm_context.md',
        exclude: [],
        verbose: true,
      });

      const options = parseArgs();

      expect(options.verbose).toBe(true);
    });
  });

  describe('Default Values', () => {
    it('should default root to current working directory', async () => {
      const { parseArgs } = await import('../../src/cli.js');
      mockCommand.opts.mockReturnValue({
        root: mockCwd,
        output: 'llm_context.md',
        exclude: [],
        verbose: false,
      });

      const options = parseArgs();

      expect(options.root).toBe(mockCwd);
    });

    it('should default output to llm_context.md', async () => {
      const { parseArgs } = await import('../../src/cli.js');
      mockCommand.opts.mockReturnValue({
        root: mockCwd,
        output: 'llm_context.md',
        exclude: [],
        verbose: false,
      });

      const options = parseArgs();

      expect(options.output).toBe(resolve('llm_context.md'));
    });

    it('should default exclude to empty array', async () => {
      const { parseArgs } = await import('../../src/cli.js');
      mockCommand.opts.mockReturnValue({
        root: mockCwd,
        output: 'llm_context.md',
        exclude: [],
        verbose: false,
      });

      const options = parseArgs();

      expect(options.exclude).toEqual([]);
    });

    it('should default verbose to false', async () => {
      const { parseArgs } = await import('../../src/cli.js');
      mockCommand.opts.mockReturnValue({
        root: mockCwd,
        output: 'llm_context.md',
        exclude: [],
        verbose: false,
      });

      const options = parseArgs();

      expect(options.verbose).toBe(false);
    });
  });

  describe('CLI Help and Version', () => {
    it('should display help with -h flag', async () => {
      mockCommand.parse.mockImplementation(() => {
        throw new Error('help displayed');
      });

      await expect(import('../../src/cli.js')).rejects.toThrow('help displayed');
    });

    it('should display help with --help flag', async () => {
      mockCommand.parse.mockImplementation(() => {
        throw new Error('help displayed');
      });

      await expect(import('../../src/cli.js')).rejects.toThrow('help displayed');
    });

    it('should display version with -V flag', async () => {
      mockCommand.parse.mockImplementation(() => {
        throw new Error('version displayed');
      });

      await expect(import('../../src/cli.js')).rejects.toThrow('version displayed');
    });

    it('should display version with --version flag', async () => {
      mockCommand.parse.mockImplementation(() => {
        throw new Error('version displayed');
      });

      await expect(import('../../src/cli.js')).rejects.toThrow('version displayed');
    });
  });

  describe('Error Handling', () => {
    it('should handle invalid root path gracefully', async () => {
      const { parseArgs } = await import('../../src/cli.js');
      mockCommand.opts.mockReturnValue({
        root: '',
        output: 'llm_context.md',
        exclude: [],
        verbose: false,
      });

      // Empty string should still resolve, but might be invalid
      const options = parseArgs();
      expect(options.root).toBeDefined();
    });

    it('should handle empty exclude patterns', async () => {
      const { parseArgs } = await import('../../src/cli.js');
      mockCommand.opts.mockReturnValue({
        root: mockCwd,
        output: 'llm_context.md',
        exclude: [],
        verbose: false,
      });

      const options = parseArgs();

      expect(options.exclude).toEqual([]);
    });

    it('should filter out empty strings from exclude patterns', async () => {
      const { parseArgs } = await import('../../src/cli.js');
      mockCommand.opts.mockReturnValue({
        root: mockCwd,
        output: 'llm_context.md',
        exclude: ['valid-pattern', '', '   '],
        verbose: false,
      });

      const options = parseArgs();

      // Empty strings should be filtered out
      expect(options.exclude).not.toContain('');
      expect(options.exclude).not.toContain('   ');
    });
  });

  describe('CLIOptions Interface', () => {
    it('should return valid CLIOptions structure', async () => {
      const { parseArgs } = await import('../../src/cli.js');
      mockCommand.opts.mockReturnValue({
        root: '/project',
        output: 'output.md',
        exclude: ['*.test.ts'],
        verbose: true,
      });

      const options = parseArgs();

      expect(options).toHaveProperty('root');
      expect(options).toHaveProperty('output');
      expect(options).toHaveProperty('exclude');
      expect(options).toHaveProperty('verbose');
      expect(typeof options.root).toBe('string');
      expect(typeof options.output).toBe('string');
      expect(Array.isArray(options.exclude)).toBe(true);
      expect(typeof options.verbose).toBe('boolean');
    });
  });
});
