import { Command } from 'commander';
import { dirname, join, resolve } from 'path';
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
      '-c, --context <path>',
      'Path to context markdown file (llm_context.md)'
    )
    .option(
      '--cwd <path>',
      'Working directory for resolving relative paths',
      process.cwd()
    )
    .parse();

  const options = program.opts<{ input: string; output: string; context?: string; cwd: string }>();

  const resolvedOutput = resolve(options.output);

  // Default context path is llm_context.md in the same directory as the output file
  const resolvedContext = options.context
    ? resolve(options.context)
    : join(dirname(resolvedOutput), 'llm_context.md');

  return {
    input: resolve(options.input),
    output: resolvedOutput,
    context: resolvedContext,
    cwd: resolve(options.cwd),
  };
}
