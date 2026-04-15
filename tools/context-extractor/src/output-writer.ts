import { writeFileSync, mkdirSync } from 'fs';
import { dirname } from 'path';
import type { ExtractedBlock, ProcessingStats } from './types.js';

/**
 * Escape special XML characters in attribute values
 */
function escapeXml(str: string): string {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

/**
 * Generate XML opening tag for a file block
 */
function generateOpenTag(block: ExtractedBlock): string {
  if (
    block.effectiveStartLine !== undefined &&
    block.effectiveEndLine !== undefined
  ) {
    return `<file path="${escapeXml(block.target.file)}" start_line="${String(block.effectiveStartLine)}" end_line="${String(block.effectiveEndLine)}">`;
  }

  if (block.effectiveStartLine !== undefined) {
    return `<file path="${escapeXml(block.target.file)}" start_line="${String(block.effectiveStartLine)}">`;
  }

  return `<file path="${escapeXml(block.target.file)}">`;
}

/**
 * Generate markdown output for a single extracted block
 */
function generateBlockMarkdown(block: ExtractedBlock): string {
  const lines: string[] = [];

  // Opening XML tag (zero indentation)
  lines.push(generateOpenTag(block));

  // Reasoning tag (zero indentation)
  if (block.target.reasoning) {
    lines.push(`<reasoning>${escapeXml(block.target.reasoning)}</reasoning>`);
  }

  // Fenced code block with language (zero indentation)
  lines.push(`\`\`\`${block.extension}`);

  // Content (preserving original whitespace)
  if (block.content.length > 0) {
    const contentLines = block.content.split('\n');
    for (const line of contentLines) {
      lines.push(line);
    }
  }

  // Close code fence (zero indentation)
  lines.push('```');

  // Closing XML tag (zero indentation)
  lines.push('</file>');

  return lines.join('\n');
}

/**
 * Write extracted blocks to markdown output file
 */
export function writeOutput(
  outputPath: string,
  blocks: ExtractedBlock[],
  _stats: ProcessingStats
): void {
  const lines: string[] = [];

  for (let i = 0; i < blocks.length; i++) {
    const block = blocks[i];
    lines.push(generateBlockMarkdown(block));

    // Single blank line between consecutive blocks
    if (i < blocks.length - 1) {
      lines.push('');
    }
  }

  // Ensure file ends with a newline
  if (lines.length > 0) {
    lines.push('');
  }

  // Create output directory if it doesn't exist
  const outputDir = dirname(outputPath);
  mkdirSync(outputDir, { recursive: true });

  writeFileSync(outputPath, lines.join('\n'), 'utf-8');
}
