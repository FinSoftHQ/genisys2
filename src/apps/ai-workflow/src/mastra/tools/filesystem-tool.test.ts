import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, writeFile as fsWriteFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  readFileTool,
  writeFileTool,
  listDirectoryTool,
  searchFilesTool,
} from './filesystem-tool.js';

describe('filesystem tools', () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'fs-tools-'));
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  describe('readFileTool', () => {
    it('should read a file as utf8', async () => {
      const filePath = join(tempDir, 'test.txt');
      await fsWriteFile(filePath, 'hello world', 'utf8');

      const result = (await readFileTool.execute!(
        { path: filePath },
        {} as any
      )) as { content: string; path: string };

      expect(result.content).toBe('hello world');
      expect(result.path).toBe(filePath);
    });

    it('should reject non-existent file', async () => {
      await expect(
        readFileTool.execute!({ path: join(tempDir, 'missing.txt') }, {} as any)
      ).rejects.toThrow();
    });
  });

  describe('writeFileTool', () => {
    it('should write a new file', async () => {
      const filePath = join(tempDir, 'new-file.txt');
      const result = (await writeFileTool.execute!(
        { path: filePath, content: 'new content' },
        {} as any
      )) as { path: string; bytesWritten: number };

      expect(result.path).toBe(filePath);
      expect(result.bytesWritten).toBe(Buffer.byteLength('new content', 'utf8'));

      const readBack = await readFileTool.execute!({ path: filePath }, {} as any);
      expect((readBack as { content: string }).content).toBe('new content');
    });

    it('should append to an existing file', async () => {
      const filePath = join(tempDir, 'append.txt');
      await writeFileTool.execute!(
        { path: filePath, content: 'first' },
        {} as any
      );
      await writeFileTool.execute!(
        { path: filePath, content: 'second', append: true },
        {} as any
      );

      const readBack = await readFileTool.execute!({ path: filePath }, {} as any);
      expect((readBack as { content: string }).content).toBe('firstsecond');
    });

    it('should create parent directories', async () => {
      const filePath = join(tempDir, 'nested', 'deep', 'file.txt');
      await writeFileTool.execute!(
        { path: filePath, content: 'deep content' },
        {} as any
      );

      const readBack = await readFileTool.execute!({ path: filePath }, {} as any);
      expect((readBack as { content: string }).content).toBe('deep content');
    });
  });

  describe('listDirectoryTool', () => {
    it('should list files and directories', async () => {
      await fsWriteFile(join(tempDir, 'file-a.txt'), 'a', 'utf8');
      await fsWriteFile(join(tempDir, 'file-b.txt'), 'b', 'utf8');

      const result = (await listDirectoryTool.execute!(
        { path: tempDir },
        {} as any
      )) as { entries: Array<{ name: string; type: string; size?: number }> };

      const names = result.entries.map((e) => e.name).sort();
      expect(names).toEqual(['file-a.txt', 'file-b.txt']);
      expect(result.entries.every((e) => e.type === 'file')).toBe(true);
      expect(result.entries[0].size).toBe(1);
    });
  });

  describe('searchFilesTool', () => {
    it('should find matches across files', async () => {
      await fsWriteFile(join(tempDir, 'a.md'), 'Hello world\nFoo bar', 'utf8');
      await fsWriteFile(join(tempDir, 'b.md'), 'Goodbye world\nBaz qux', 'utf8');

      const result = (await searchFilesTool.execute!(
        { query: 'world', path: tempDir },
        {} as any
      )) as { matches: Array<{ file: string; line: number; text: string }> };

      expect(result.matches).toHaveLength(2);
      expect(result.matches[0].text).toContain('world');
      expect(result.matches[1].text).toContain('world');
    });

    it('should respect glob pattern', async () => {
      await fsWriteFile(join(tempDir, 'a.md'), 'target text', 'utf8');
      await fsWriteFile(join(tempDir, 'b.txt'), 'target text', 'utf8');

      const result = (await searchFilesTool.execute!(
        { query: 'target', path: tempDir, glob: '*.md' },
        {} as any
      )) as { matches: Array<{ file: string; line: number; text: string }> };

      expect(result.matches).toHaveLength(1);
      expect(result.matches[0].file.endsWith('a.md')).toBe(true);
    });

    it('should skip node_modules', async () => {
      const nodeModules = join(tempDir, 'node_modules', 'pkg');
      await mkdir(nodeModules, { recursive: true });
      await fsWriteFile(join(nodeModules, 'index.js'), 'target', 'utf8');

      const result = (await searchFilesTool.execute!(
        { query: 'target', path: tempDir },
        {} as any
      )) as { matches: Array<{ file: string; line: number; text: string }> };

      expect(result.matches).toHaveLength(0);
    });
  });
});
