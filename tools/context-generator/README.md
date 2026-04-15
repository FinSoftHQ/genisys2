# context-generator

A CLI tool that generates LLM context files from project source code. It creates a single markdown file (`llm_context.md`) containing a project tree and "skeleton" extracts of source files—imports, signatures, and docstrings—without implementation details.

## Installation

### From Monorepo

```bash
# Install dependencies from the monorepo root
pnpm install

# Build the package
pnpm --filter @repo/context-generator build
```

### Global Installation

After building, you can use the binary directly:

```bash
# Using pnpm
pnpm link --global ./tools/context-generator

# Or use the binary directly
./tools/context-generator/dist/index.js --help
```

## Usage

### Basic Usage

Scan the current directory and generate `llm_context.md`:

```bash
pnpm --filter @repo/context-generator start
```

### CLI Options

```
Usage: context-generator [options]

Generate LLM context from project source files

Options:
  -V, --version           Output the version number
  -r, --root <path>       Root directory to scan (default: current directory)
  -o, --output <path>     Output file path (default: "llm_context.md")
  -e, --exclude <patterns>  Exclude patterns (comma-separated or repeatable)
  -v, --verbose           Enable verbose diagnostics (default: false)
  -h, --help              Display help for command
```

### Example Commands

```bash
# Scan specific directory
pnpm --filter @repo/context-generator start -- --root ./my-project

# Custom output file
pnpm --filter @repo/context-generator start -- --output ./docs/context.md

# Exclude patterns (comma-separated)
pnpm --filter @repo/context-generator start -- --exclude "*.test.ts,*.spec.ts"

# Multiple exclude flags
pnpm --filter @repo/context-generator start -- --exclude "*.test.ts" --exclude "*.stories.tsx"

# Verbose mode (shows detailed progress)
pnpm --filter @repo/context-generator start -- --verbose

# Combined options
pnpm --filter @repo/context-generator start -- --root ./src --output ./context.md --exclude "*.test.ts" --verbose

# Using the binary directly
./tools/context-generator/dist/index.js --root ./src --verbose
```

## Supported Languages

| Language | Extensions | Parser Strategy |
|----------|------------|-----------------|
| **TypeScript** | `.ts`, `.tsx` | TypeScript Compiler API - Full AST parsing |
| **JavaScript** | `.js`, `.jsx` | TypeScript Compiler API - Full AST parsing |
| **Vue** | `.vue` | `@vue/compiler-sfc` - Extracts script blocks, parsed with TypeScript |
| **Python** | `.py` | Regex/heuristic-based extraction |
| **Kotlin** | `.kt`, `.kts` | Regex/heuristic-based extraction |

### Parser Details

- **TypeScript/JavaScript**: Uses the TypeScript Compiler API for robust AST parsing. Extracts imports, exports, interfaces, type aliases, enums, class signatures, function signatures, and JSDoc comments.

- **Vue SFC**: Uses the official Vue compiler to extract `<script>` and `<script setup>` blocks, then parses them with TypeScript. Includes template and style block indicators.

- **Python**: Uses regex and heuristics to extract imports, class definitions with method signatures, function signatures, type-annotated variables, and docstrings.

- **Kotlin**: Uses regex and heuristics to extract package declarations, imports, class/interface/object signatures, function signatures, and property declarations.

## Output Format

The generated `llm_context.md` file contains the following sections:

### 1. Summary

Statistics about the processing:

- Files Discovered
- Files Parsed
- Files Skipped

### 2. Project Tree

An ASCII tree representation of the project structure:

```
src/
├── cli.ts
├── file-discovery.ts
├── index.ts
├── output-writer.ts
├── parsers/
│   ├── index.ts
│   ├── kotlin.ts
│   ├── python.ts
│   ├── typescript.ts
│   └── vue.ts
├── tree-generator.ts
└── types.ts
```

### 3. File Contents

Each source file is included with its skeleton content in a code block:

```typescript
// File: src/types.ts

export interface CLIOptions {
  root: string;
  output: string;
  exclude: string[];
  verbose: boolean;
}

export interface SourceFile {
  absolutePath: string;
  relativePath: string;
  extension: string;
  size: number;
}
```

### 4. Skipped Files (if any)

A table listing files that were skipped with reasons:

| File | Reason |
|------|--------|
| large-file.ts | Binary or oversized file |
| broken.ts | Parse error: Unexpected token |

## Examples

### Example Command

```bash
$ pnpm --filter @repo/context-generator start -- --root ./src --verbose

🚀 context-generator
   Root: /home/user/project/src
   Output: /home/user/project/llm_context.md

🔍 Scanning directory: /home/user/project/src
📋 Loaded 12 patterns from .gitignore
📁 Found 42 source files
✅ Parsed: cli.ts
✅ Parsed: file-discovery.ts
✅ Parsed: index.ts
✅ Parsed: output-writer.ts
✅ Parsed: parsers/index.ts
...

✨ Done! Generated: /home/user/project/llm_context.md
   Files: 42 parsed, 0 skipped
```

### Example Output Snippet

```markdown
# Project Context

Generated from: `/home/user/project`

## Table of Contents

1. [Project Tree](#project-tree)
2. [File Contents](#file-contents)

## Summary

- **Files Discovered:** 42
- **Files Parsed:** 42
- **Files Skipped:** 0

## Project Tree

```
src/
├── cli.ts
├── file-discovery.ts
├── index.ts
├── output-writer.ts
├── parsers/
│   ├── index.ts
│   ├── kotlin.ts
│   ├── python.ts
│   ├── typescript.ts
│   └── vue.ts
├── tree-generator.ts
└── types.ts
```

## File Contents

### src/types.ts

```typescript
/**
 * CLI argument options
 */
export interface CLIOptions {
  /** Root directory to scan (default: current directory) */
  root: string;
  /** Output file path (default: llm_context.md) */
  output: string;
  /** Exclude patterns (glob) */
  exclude: string[];
  /** Enable verbose diagnostics */
  verbose: boolean;
}
```

### src/cli.ts

```typescript
import { Command } from 'commander';
import { resolve } from 'path';
import type { CLIOptions } from './types.js';

export function parseArgs(): CLIOptions;
```
```

## Development

### Project Structure

```
tools/context-generator/
├── package.json              # Package manifest
├── tsconfig.json             # TypeScript configuration
├── vitest.config.ts          # Vitest configuration
├── README.md                 # This file
└── src/
    ├── index.ts              # CLI entry point
    ├── cli.ts                # Command-line argument parsing
    ├── types.ts              # TypeScript type definitions
    ├── file-discovery.ts     # File discovery with glob/gitignore
    ├── tree-generator.ts     # Project tree generation
    ├── output-writer.ts      # Markdown output generation
    └── parsers/
        ├── index.ts          # Parser registry and dispatcher
        ├── typescript.ts     # TS/JS/TSX/JSX parser
        ├── vue.ts            # Vue SFC parser
        ├── python.ts         # Python parser
        └── kotlin.ts         # Kotlin parser
```

### Running Tests

```bash
# Run tests once
pnpm --filter @repo/context-generator test

# Run tests in watch mode
pnpm --filter @repo/context-generator test:watch
```

### Building

```bash
# Build the package
pnpm --filter @repo/context-generator build

# Type check without emitting
pnpm --filter @repo/context-generator typecheck

# Development mode with hot reload
pnpm --filter @repo/context-generator dev
```

### Development Scripts

| Script | Description |
|--------|-------------|
| `dev` | Run with hot reload using bun |
| `build` | Compile TypeScript to `dist/` and make executable |
| `start` | Run the compiled binary |
| `test` | Run Vitest tests |
| `test:watch` | Run Vitest in watch mode |
| `typecheck` | Type check without emitting |

## Features

- **Automatic .gitignore Integration**: Respects your `.gitignore` patterns automatically
- **Binary File Detection**: Skips binary files and files over 1MB
- **Deterministic Output**: Files are sorted for consistent output
- **Verbose Diagnostics**: Optional verbose mode for debugging
- **Error Resilience**: Continues processing when individual files fail
- **Clean Skeleton Output**: Extracts only signatures, imports, and docstrings—no implementation details

## Dependencies

| Package | Purpose |
|---------|---------|
| `commander` | CLI argument parsing |
| `fast-glob` | Fast glob matching for file discovery |
| `ignore` | .gitignore pattern parsing |
| `@vue/compiler-sfc` | Vue Single File Component parsing |
| `typescript` | TypeScript Compiler API for TS/JS parsing |
