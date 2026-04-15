import { Command } from 'commander';
import { resolve } from 'path';
import type { CLIOptions } from './types.js';

export function parseArgs(): CLIOptions {
  const program = new Command();

  program
    .name('context-extractor')
    .description('Extract file contents from JSONL targets to markdown')
    .version('0.0.1')
    .requiredOption(
      '-i, --input <path>',
      'Path to input JSONL file'
    )
    .option(
      '-o, --output <path>',
      'Path to output markdown file',
      'llm_target.md'
    )
    .option(
      '--cwd <path>',
      'Working directory for resolving relative paths',
      process.cwd()
    )
    .parse();

  const options = program.opts<{ input: string; output: string; cwd: string }>();

  return {
    input: resolve(options.input),
    output: resolve(options.output),
    cwd: resolve(options.cwd),
  };
}
