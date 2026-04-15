import { readFileSync, existsSync } from 'fs';
import { resolve, isAbsolute } from 'path';
import type { ExtractionTarget, ExtractedBlock, Warning } from './types.js';
import { getFileExtension, getLanguageForExtension } from './utils.js';

export interface ExtractionResult {
  block?: ExtractedBlock;
  warning?: Warning;
}

/**
 * Read file and return lines array and original content
 * Handles missing file by returning null
 */
function readFileContent(filepath: string): { lines: string[]; totalLines: number } | null {
  if (!existsSync(filepath)) {
    return null;
  }

  try {
    const content = readFileSync(filepath, 'utf-8');
    
    // Handle empty file
    if (content === '') {
      return { lines: [], totalLines: 0 };
    }
    
    // Split preserving line endings in content
    const lines = content.split('\n');
    
    // Calculate actual line count (accounting for trailing newline)
    // If content ends with newline, split creates an extra empty element
    const totalLines = content.endsWith('\n') ? lines.length - 1 : lines.length;
    
    return { lines, totalLines };
  } catch {
    return null;
  }
}

/**
 * Extract content from a file based on target specification
 */
export function extractFromFile(
  target: ExtractionTarget,
  cwd: string
): ExtractionResult {
  // Resolve file to absolute path
  const absolutePath = isAbsolute(target.file)
    ? target.file
    : resolve(cwd, target.file);

  const extension = getFileExtension(absolutePath);
  const language = getLanguageForExtension(extension);

  // Check if file exists
  const fileContent = readFileContent(absolutePath);
  if (fileContent === null) {
    return {
      warning: {
        message: `file not found: ${target.file}`,
      },
    };
  }

  const { lines, totalLines } = fileContent;

  // Helper to reconstruct content preserving trailing newline
  const hasTrailingNewline = lines.length > 0 && lines[lines.length - 1] === '';
  const reconstructContent = (extractedLines: string[]): string => {
    if (hasTrailingNewline) {
      return extractedLines.slice(0, -1).join('\n') + '\n';
    }
    return extractedLines.join('\n');
  };

  // Full-file extraction (also handles end_line-only targets)
  if (target.start_line === undefined) {
    const content = reconstructContent(lines);
    return {
      block: {
        target,
        absolutePath,
        extension,
        language,
        content,
      },
    };
  }

  // start_line-only extraction: from start_line to EOF
  if (target.end_line === undefined) {
    const requestedStart = target.start_line;

    if (requestedStart > totalLines) {
      return {
        warning: {
          message: `start_line ${String(requestedStart)} out of bounds for ${target.file} (${String(totalLines)} lines)`,
        },
      };
    }

    const effectiveStart = requestedStart;
    let content: string;
    if (effectiveStart === 1) {
      content = reconstructContent(lines);
    } else {
      content = lines.slice(effectiveStart - 1).join('\n');
    }

    return {
      block: {
        target,
        absolutePath,
        extension,
        language,
        content,
        effectiveStartLine: effectiveStart,
      },
    };
  }

  // Both start_line and end_line defined
  const requestedStart = target.start_line;
  const requestedEnd = target.end_line;

  // Check if start_line is out of bounds
  if (requestedStart > totalLines) {
    return {
      warning: {
        message: `start_line ${String(requestedStart)} out of bounds for ${target.file} (${String(totalLines)} lines)`,
      },
    };
  }

  // Cap end_line at file length silently
  const effectiveStart = requestedStart;
  const effectiveEnd = Math.min(requestedEnd, totalLines);

  // Handle edge case where start > end after capping
  if (effectiveStart > effectiveEnd) {
    return {
      block: {
        target,
        absolutePath,
        extension,
        language,
        content: '',
        effectiveStartLine: effectiveStart,
        effectiveEndLine: effectiveEnd,
      },
    };
  }

  // Extract lines (converting 1-based to 0-based indexing)
  // Note: slice end is exclusive, so we use effectiveEnd (not effectiveEnd + 1)
  const extractedLines = lines.slice(effectiveStart - 1, effectiveEnd);

  // Join extracted lines - never add trailing newline for range extractions
  const content = extractedLines.join('\n');

  return {
    block: {
      target,
      absolutePath,
      extension,
      language,
      content,
      effectiveStartLine: effectiveStart,
      effectiveEndLine: effectiveEnd,
    },
  };
}
