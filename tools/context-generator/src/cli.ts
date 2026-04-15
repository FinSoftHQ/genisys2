import { Command } from 'commander';
import { resolve } from 'path';
import type { CLIOptions } from './types.js';

export function parseArgs(): CLIOptions {
  const program = new Command();

  program
    .name('context-generator')
    .description('Generate LLM context from project source files')
    .version('0.0.1')
    .option(
      '-r, --root <path>',
      'Root directory to scan',
      process.cwd()
    )
    .option(
      '-o, --output <path>',
      'Output file path',
      'llm_context.md'
    )
    .option(
      '-e, --exclude <patterns>',
      'Exclude patterns (comma-separated or repeatable)',
      collectExclude,
      []
    )
    .option(
      '-v, --verbose',
      'Enable verbose diagnostics',
      false
    )
    .parse();

  const options = program.opts();

  // Filter out empty strings from exclude patterns
  const filteredExclude = options.exclude.filter((pattern: string) => pattern.trim() !== '');

  return {
    root: resolve(options.root),
    output: resolve(options.output),
    exclude: filteredExclude,
    verbose: options.verbose,
  };
}

/**
 * Collect exclude patterns from multiple --exclude flags or comma-separated values
 */
function collectExclude(value: string, previous: string[]): string[] {
  // Split by comma if the value contains commas, otherwise treat as single pattern
  const patterns = value.includes(',') 
    ? value.split(',').map(p => p.trim()).filter(Boolean)
    : [value];
  return previous.concat(patterns);
}
