import { readFileSync, statSync } from 'fs';
import { relative, join } from 'path';
import fastGlob from 'fast-glob';
import ignore from 'ignore';
import type { SourceFile, CLIOptions } from './types.js';
import { ALL_EXTENSIONS } from './types.js';

/**
 * Discover source files in the project directory
 */
export async function discoverFiles(
  options: CLIOptions
): Promise<SourceFile[]> {
  const { root, exclude, verbose } = options;

  if (verbose) {
    console.log(`🔍 Scanning directory: ${root}`);
  }

  // Load .gitignore patterns
  const gitignorePatterns = loadGitignore(root);
  
  if (verbose && gitignorePatterns.length > 0) {
    console.log(`📋 Loaded ${gitignorePatterns.length} patterns from .gitignore`);
  }

  // Build glob pattern for supported extensions
  const extensionsPattern = ALL_EXTENSIONS.map(ext => `**/*${ext}`);

  // Find all files matching the patterns
  const globResults = await fastGlob(extensionsPattern, {
    cwd: root,
    dot: true,
    ignore: [
      '**/node_modules/**',
      '**/.git/**',
      '**/dist/**',
      '**/build/**',
      '**/*.d.ts',
      ...exclude,
      ...gitignorePatterns,
    ],
    absolute: true,
    onlyFiles: true,
  });

  // Process discovered files
  const files: SourceFile[] = [];
  const ig = ignore().add(gitignorePatterns);

  for (const absolutePath of globResults) {
    const relPath = relative(root, absolutePath);
    
    // Double-check against gitignore patterns (fast-glob may not catch all)
    if (ig.ignores(relPath)) {
      continue;
    }

    try {
      const stats = statSync(absolutePath);
      const extension = absolutePath.slice(absolutePath.lastIndexOf('.'));

      files.push({
        absolutePath,
        relativePath: relPath,
        extension,
        size: stats.size,
      });
    } catch (error) {
      if (verbose) {
        console.warn(`⚠️  Could not stat file: ${relPath}`);
      }
    }
  }

  // Sort by relative path for deterministic output
  files.sort((a, b) => a.relativePath.localeCompare(b.relativePath));

  if (verbose) {
    console.log(`📁 Found ${files.length} source files`);
  }

  return files;
}

/**
 * Load .gitignore patterns from the root directory
 */
export function loadGitignore(root: string): string[] {
  try {
    const gitignorePath = join(root, '.gitignore');
    const content = readFileSync(gitignorePath, 'utf-8');
    return content
      .split('\n')
      .map(line => line.trim())
      .filter(line => line && !line.startsWith('#'));
  } catch {
    return [];
  }
}

/**
 * Check if a file should be treated as binary (skip content extraction)
 */
export function isBinaryFile(file: SourceFile, verbose: boolean): boolean {
  // Check extension
  const binaryExtensions = [
    '.png', '.jpg', '.jpeg', '.gif', '.ico', '.svg',
    '.woff', '.woff2', '.ttf', '.eot', '.otf',
    '.pdf', '.zip', '.tar', '.gz', '.rar',
    '.exe', '.dll', '.so', '.dylib',
    '.mp3', '.mp4', '.avi', '.mov',
  ];
  
  if (binaryExtensions.some(ext => file.extension.toLowerCase() === ext)) {
    if (verbose) {
      console.log(`⏭️  Skipping binary file: ${file.relativePath}`);
    }
    return true;
  }

  // Check size (skip files larger than 1MB)
  const MAX_SIZE = 1024 * 1024;
  if (file.size > MAX_SIZE) {
    if (verbose) {
      console.log(`⏭️  Skipping oversized file: ${file.relativePath} (${file.size} bytes)`);
    }
    return true;
  }

  return false;
}
