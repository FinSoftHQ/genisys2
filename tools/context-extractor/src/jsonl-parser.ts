import { createReadStream } from 'fs';
import { createInterface } from 'readline';
import type { ExtractionTarget, Warning } from './types.js';
import { isValidExtractionTarget } from './utils.js';

export interface ParseResult {
  targets: ExtractionTarget[];
  warnings: Warning[];
}

/**
 * Parse JSONL file into extraction targets
 * Returns targets in file order with any warnings
 */
export async function parseJsonlFile(inputPath: string): Promise<ParseResult> {
  const targets: ExtractionTarget[] = [];
  const warnings: Warning[] = [];

  const fileStream = createReadStream(inputPath, { encoding: 'utf-8' });
  const rl = createInterface({
    input: fileStream,
    crlfDelay: Infinity,
  });

  let lineNumber = 0;

  for await (const line of rl) {
    lineNumber++;

    const trimmedLine = line.trim();

    // Skip empty lines
    if (trimmedLine.length === 0) {
      continue;
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmedLine);
    } catch {
      warnings.push({
        lineNumber,
        rawLine: line,
        message: `invalid JSONL at line ${String(lineNumber)}: ${line}`,
      });
      continue;
    }

    if (!isValidExtractionTarget(parsed)) {
      warnings.push({
        lineNumber,
        rawLine: line,
        message: `invalid JSONL at line ${String(lineNumber)}: ${line}`,
      });
      continue;
    }

    const target: ExtractionTarget = {
      file: parsed.file,
      start_line: parsed.start_line,
      end_line: parsed.end_line,
    };

    if (parsed.reasoning !== undefined) {
      target.reasoning = parsed.reasoning;
    }

    targets.push(target);
  }

  return { targets, warnings };
}
