import { createTool } from '@mastra/core/tools';
import { z } from 'zod';
import { readFile, writeFile as fsWriteFile, appendFile, readdir, stat, mkdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';

export const readFileTool = createTool({
  id: 'read-file',
  description: 'Read the contents of a file at the given path.',
  inputSchema: z.object({
    path: z.string().describe('Relative or absolute file path'),
    encoding: z.enum(['utf8', 'base64']).optional().default('utf8').describe('File encoding'),
  }),
  outputSchema: z.object({
    content: z.string(),
    path: z.string(),
  }),
  execute: async ({ path, encoding }) => {
    const targetPath = resolve(path);
    const content = await readFile(targetPath, encoding as 'utf8' | 'base64');
    return { content: content.toString(), path: targetPath };
  },
});

export const writeFileTool = createTool({
  id: 'write-file',
  description: 'Write or append content to a file. Creates parent directories if needed.',
  inputSchema: z.object({
    path: z.string().describe('Relative or absolute file path'),
    content: z.string().describe('Content to write'),
    append: z.boolean().optional().default(false).describe('Append to existing file instead of overwriting'),
  }),
  outputSchema: z.object({
    path: z.string(),
    bytesWritten: z.number(),
  }),
  execute: async ({ path, content, append }) => {
    const targetPath = resolve(path);
    const parentDir = targetPath.split('/').slice(0, -1).join('/');
    if (parentDir) {
      await mkdir(parentDir, { recursive: true });
    }

    const bytes = Buffer.byteLength(content, 'utf8');
    if (append) {
      await appendFile(targetPath, content, 'utf8');
    } else {
      await fsWriteFile(targetPath, content, 'utf8');
    }
    return { path: targetPath, bytesWritten: bytes };
  },
});

export const listDirectoryTool = createTool({
  id: 'list-directory',
  description: 'List files and directories within the given path.',
  inputSchema: z.object({
    path: z.string().optional().default('.').describe('Directory path (defaults to current directory)'),
  }),
  outputSchema: z.object({
    entries: z.array(
      z.object({
        name: z.string(),
        type: z.enum(['file', 'directory']),
        size: z.number().optional(),
      })
    ),
  }),
  execute: async ({ path }) => {
    const targetPath = resolve(path ?? '.');
    const dirents = await readdir(targetPath, { withFileTypes: true });
    const entries = await Promise.all(
      dirents.map(async (dirent) => {
        const entryPath = join(targetPath, dirent.name);
        let size: number | undefined;
        if (dirent.isFile()) {
          try {
            const s = await stat(entryPath);
            size = s.size;
          } catch {
            // ignore
          }
        }
        return {
          name: dirent.name,
          type: (dirent.isDirectory() ? 'directory' : 'file') as 'file' | 'directory',
          size,
        };
      })
    );
    return { entries };
  },
});

const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', 'build', '.next', '.turbo', '.venv', 'venv', '__pycache__']);
const BINARY_EXTENSIONS = new Set([
  'png', 'jpg', 'jpeg', 'gif', 'bmp', 'ico', 'webp', 'svg',
  'mp3', 'mp4', 'wav', 'ogg', 'avi', 'mov', 'webm',
  'pdf', 'doc', 'docx', 'xls', 'xlsx', 'ppt', 'pptx',
  'zip', 'tar', 'gz', 'bz2', '7z', 'rar',
  'exe', 'dll', 'so', 'dylib', 'bin', 'dat',
  'ttf', 'otf', 'woff', 'woff2', 'eot',
]);

function isBinaryFile(filePath: string): boolean {
  const ext = filePath.split('.').pop()?.toLowerCase() ?? '';
  return BINARY_EXTENSIONS.has(ext);
}

export const searchFilesTool = createTool({
  id: 'search-files',
  description: 'Recursively search file contents for a query string. Skips binary files and common ignored directories.',
  inputSchema: z.object({
    query: z.string().describe('Text to search for'),
    path: z.string().optional().default('.').describe('Root directory to search from (defaults to current directory)'),
    glob: z.string().optional().describe('Optional glob pattern to filter files (e.g., "*.md", "*.ts")'),
  }),
  outputSchema: z.object({
    matches: z.array(
      z.object({
        file: z.string(),
        line: z.number(),
        text: z.string(),
      })
    ),
  }),
  execute: async ({ query, path, glob }) => {
    const rootPath = resolve(path ?? '.');
    const matches: Array<{ file: string; line: number; text: string }> = [];

    async function walk(dir: string) {
      const dirents = await readdir(dir, { withFileTypes: true });
      for (const dirent of dirents) {
        const fullPath = join(dir, dirent.name);
        if (dirent.isDirectory()) {
          if (!SKIP_DIRS.has(dirent.name)) {
            await walk(fullPath);
          }
        } else if (dirent.isFile()) {
          if (isBinaryFile(fullPath)) continue;
          if (glob && !matchGlob(dirent.name, glob)) continue;

          try {
            const content = await readFile(fullPath, 'utf8');
            const lines = content.split('\n');
            for (let i = 0; i < lines.length; i++) {
              if (lines[i].includes(query)) {
                matches.push({
                  file: fullPath,
                  line: i + 1,
                  text: lines[i].trim(),
                });
              }
            }
          } catch {
            // Skip files that can't be read as text
          }
        }
      }
    }

    await walk(rootPath);
    return { matches };
  },
});

function matchGlob(filename: string, pattern: string): boolean {
  // Very simple glob matching: only supports leading * (e.g., *.md)
  if (pattern.startsWith('*.')) {
    const ext = pattern.slice(1);
    return filename.endsWith(ext);
  }
  if (pattern.includes('*')) {
    const regex = new RegExp('^' + pattern.replace(/\./g, '\\.').replace(/\*/g, '.*') + '$');
    return regex.test(filename);
  }
  return filename === pattern;
}
