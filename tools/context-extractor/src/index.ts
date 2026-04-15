#!/usr/bin/env node

import { parseArgs } from './cli.js';
import { parseJsonlFile } from './jsonl-parser.js';
import { extractFromFile } from './file-extractor.js';
import { writeOutput } from './output-writer.js';
import type { ExtractedBlock, ProcessingStats, Warning } from './types.js';


async function main(): Promise<void> {
  const options = parseArgs();
  const warnings: Warning[] = [];

  try {
    // Step 1: Parse JSONL input file
    const { targets, warnings: parseWarnings } = await parseJsonlFile(
      options.input
    );
    warnings.push(...parseWarnings);

    // Print JSONL parsing warnings
    for (const warning of parseWarnings) {
      console.error(`WARN: ${warning.message}`);
    }

    // Step 2: Extract content from each target
    const blocks: ExtractedBlock[] = [];
    const cwd = options.cwd;

    for (const target of targets) {
      const result = extractFromFile(target, cwd);

      if (result.warning) {
        warnings.push(result.warning);
        // Print warning to stderr
        console.error(`WARN: ${result.warning.message}`);
      }

      if (result.block) {
        blocks.push(result.block);
      }
    }

    // Step 3: Write output
    const stats: ProcessingStats = {
      totalEntries: targets.length,
      blocksWritten: blocks.length,
      warnings: warnings.length,
    };

    writeOutput(options.output, blocks, stats);

    // Step 4: Print summary
    console.log(
      `Done. ${String(blocks.length)} blocks written to ${options.output}. ${String(warnings.length)} warnings.`
    );

    // Exit with error code if there were warnings (but not fatal)
    if (warnings.length > 0) {
      process.exitCode = 0; // Still success, just had warnings
    }
  } catch (error) {
    console.error('Fatal error:', error);
    process.exit(1);
  }
}

// Run main with error handling
main().catch((error: unknown) => {
  console.error('Unhandled error:', error);
  process.exit(1);
});
