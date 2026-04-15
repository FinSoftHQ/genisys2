#!/usr/bin/env node

import { parseArgs } from './cli.js';
import { discoverFiles, isBinaryFile } from './file-discovery.js';
import { generateTree } from './tree-generator.js';
import { parseFile } from './parsers/index.js';
import { writeOutput } from './output-writer.js';
import type { ParsedFile, ProcessingStats, CLIOptions } from './types.js';
import { mkdirSync } from 'fs';
import { dirname } from 'path';

/**
 * Main entry point for the context generator
 */
export async function main(): Promise<void> {
  const options = parseArgs();

  await generateContext(options);

  console.log(`\n✨ Done! Generated: ${options.output}`);
}

/**
 * Generate context from the given options
 */
export async function generateContext(options: CLIOptions): Promise<void> {
  if (options.verbose) {
    console.log('🚀 context-generator');
    console.log(`   Root: ${options.root}`);
    console.log(`   Output: ${options.output}`);
    if (options.exclude.length > 0) {
      console.log(`   Exclude: ${options.exclude.join(', ')}`);
    }
    console.log('');
  }

  // Ensure output directory exists
  const outputDir = dirname(options.output);
  try {
    mkdirSync(outputDir, { recursive: true });
  } catch {
    // Directory might already exist or root is current dir
  }

  // Step 1: Discover files
  const files = await discoverFiles(options);
  
  // Step 2: Generate tree structure
  const tree = generateTree(files);

  // Step 3: Parse files
  const parsedFiles: ParsedFile[] = [];
  const skippedFiles: Array<{ path: string; reason: string }> = [];
  let filesParsed = 0;

  for (const file of files) {
    // Check for binary/oversized files
    if (isBinaryFile(file, options.verbose)) {
      skippedFiles.push({
        path: file.relativePath,
        reason: 'Binary or oversized file',
      });
      continue;
    }

    try {
      const parsed = await parseFile(file, options.verbose);
      parsedFiles.push(parsed);
      
      if (parsed.error) {
        skippedFiles.push({
          path: file.relativePath,
          reason: `Parse error: ${parsed.error}`,
        });
      } else {
        filesParsed++;
        if (options.verbose) {
          console.log(`✅ Parsed: ${file.relativePath}`);
        }
      }
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      skippedFiles.push({
        path: file.relativePath,
        reason: `Error: ${reason}`,
      });
      if (options.verbose) {
        console.warn(`❌ Failed: ${file.relativePath} - ${reason}`);
      }
    }
  }

  // Step 4: Generate output
  const stats: ProcessingStats = {
    filesDiscovered: files.length,
    filesParsed,
    filesSkipped: skippedFiles.length,
    skippedFiles,
  };

  writeOutput(options.output, tree, parsedFiles, stats, options);

  console.log(`   Files: ${filesParsed} parsed, ${skippedFiles.length} skipped`);

  // Exit with error code if there were failures
  if (skippedFiles.length > 0 && filesParsed === 0) {
    console.error('\n⚠️  Warning: All files were skipped or failed to parse');
    process.exit(1);
  }
}

// Run main with error handling if this file is executed directly
if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error) => {
    console.error('💥 Unhandled error:', error);
    process.exit(1);
  });
}
