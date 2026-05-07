import { writeFileSync } from 'fs';
import type { ParsedFile, TreeNode, ProcessingStats, CLIOptions } from './types.js';
import { renderTree } from './tree-generator.js';

/**
 * Generate and write the output markdown file
 */
export function writeOutput(
  outputPath: string,
  tree: TreeNode,
  parsedFiles: ParsedFile[],
  stats: ProcessingStats,
  options: CLIOptions
): void {
  const lines: string[] = [];

  // Header
  lines.push('# Project Context');
  lines.push('');
  lines.push(`Generated from: \`${options.root}\``);
  lines.push('');

  // Table of Contents
  lines.push('## Table of Contents');
  lines.push('');
  lines.push('1. [Project Tree](#project-tree)');
  lines.push('2. [File Contents](#file-contents)');
  if (stats.filesSkipped > 0) {
    lines.push('3. [Skipped Files](#skipped-files)');
  }
  lines.push('');

  // Statistics
  lines.push('## Summary');
  lines.push('');
  lines.push(`- **Files Discovered:** ${stats.filesDiscovered}`);
  lines.push(`- **Files Parsed:** ${stats.filesParsed}`);
  lines.push(`- **Files Skipped:** ${stats.filesSkipped}`);
  lines.push('');

  // Project Tree
  lines.push('## Project Tree');
  lines.push('');
  lines.push('```');
  lines.push(renderTree(tree).trim());
  lines.push('```');
  lines.push('');

  // File Contents
  lines.push('------');
  lines.push('');
  lines.push('## File Contents');
  lines.push('');
  lines.push('> **Note:** The files below are excerpted, not reproduced in full. For most modules, only exported symbols and type signatures are shown; function bodies, internal helpers, and detailed implementations are truncated. Do not infer implementation details, schema fields, or side effects from the signatures shown here—refer to the full files when reasoning about behavior.');
  lines.push('');

  for (const parsed of parsedFiles) {
    if (parsed.error) {
      continue; // Skip files with errors
    }

    lines.push(`### ${parsed.sourceFile.relativePath}`);
    lines.push('');

    if (parsed.skeleton.trim()) {
      lines.push(`\`\`\`${parsed.language}`);
      lines.push(parsed.skeleton);
      lines.push('```');
    } else {
      lines.push('*No extractable content*');
    }

    lines.push('');
  }

  // Skipped Files (if any)
  if (stats.filesSkipped > 0 && stats.skippedFiles.length > 0) {
    lines.push('## Skipped Files');
    lines.push('');
    lines.push('| File | Reason |');
    lines.push('|------|--------|');
    for (const skipped of stats.skippedFiles) {
      lines.push(`| ${skipped.path} | ${skipped.reason} |`);
    }
    lines.push('');
  }

  // Write to file
  writeFileSync(outputPath, lines.join('\n'), 'utf-8');
}
