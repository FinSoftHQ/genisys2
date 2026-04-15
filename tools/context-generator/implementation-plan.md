# context-generator CLI Implementation Plan

## Overview

Create a CLI tool called `context-generator` that generates a single markdown file named `llm_context.md` from a local project directory. The output is optimized for LLM context ingestion, containing a project tree and "skeleton" extracts of source files (imports, signatures, and docstrings only - no implementation details).

---

## Tech Stack (Research-Backed)

| Component | Version | Rationale |
|-----------|---------|-----------|
| **Node.js** | >=22.0.0 | Matches project requirements (engines in root package.json) |
| **TypeScript** | ^5.7.3 | Catalog version from pnpm-workspace.yaml |
| **Package Manager** | pnpm 10.6.0 | Matches workspace packageManager |
| **Build Tool** | tsup ^8.3.5 | Catalog version, used by other packages in monorepo |
| **CLI Parser** | commander ^12.x | Industry standard, already used in run-kimi |
| **Glob Matching** | fast-glob ^3.x | Fastest glob implementation, pure JavaScript [1] |
| **.gitignore Parsing** | ignore ^7.x | Used by ESLint, spec-compliant with gitignore 2.22.1 [2] |
| **Vue SFC Parsing** | @vue/compiler-sfc ^3.x | Official Vue 3 compiler, extracts script blocks [3] |
| **Testing** | vitest ^2.1.8 | Catalog version |

### Why These Choices?

1. **fast-glob**: Selected over globby for better performance and fewer dependencies (18 vs 24 packages). Fast-glob is the fastest glob implementation in JavaScript and is used by globby under the hood.

2. **ignore**: The standard for .gitignore parsing in JavaScript. Used by ESLint, fully tested with 500+ unit tests, follows gitignore spec 2.22.1 exactly.

3. **@vue/compiler-sfc**: Official Vue compiler for SFC (Single File Components). Pure JavaScript, no native bindings required. Can extract `<script>` and `<script setup>` blocks for further parsing.

4. **TypeScript Compiler API**: Used for TS/JS/JSX parsing since TypeScript is already a project dependency. No additional parser needed.

### Alternatives Considered

| Alternative | Why Not Chosen |
|-------------|----------------|
| globby | Larger dependency tree (24 packages vs 18), features not needed |
| @babel/parser | Would add extra dependency; TS compiler API already available |
| tree-sitter | Requires native C++ build steps, violates requirements |
| vue-template-compiler | Vue 2 only; @vue/compiler-sfc is Vue 3 standard |

---

## Project Structure

```
tools/context-generator/
├── package.json              # Package manifest with dependencies
├── tsconfig.json             # TypeScript configuration
├── justfile                  # Task definitions (dev, build, test)
├── README.md                 # Usage documentation
├── vitest.config.ts          # Vitest configuration
└── src/
    ├── index.ts              # CLI entry point
    ├── cli.ts                # Command-line argument parsing
    ├── types.ts              # TypeScript type definitions
    ├── file-discovery.ts     # File discovery with glob/gitignore
    ├── tree-generator.ts     # Project tree generation
    ├── output-writer.ts      # Markdown output generation
    └── parsers/
        ├── index.ts          # Parser registry and dispatcher
        ├── typescript.ts     # TS/JS/TSX/JSX parser (TS Compiler API)
        ├── vue.ts            # Vue SFC parser (@vue/compiler-sfc)
        ├── python.ts         # Python parser (regex/heuristic)
        └── kotlin.ts         # Kotlin parser (regex/heuristic)
```

---

## Package Configuration

### package.json

```json
{
  "name": "@repo/context-generator",
  "version": "0.0.1",
  "private": true,
  "type": "module",
  "bin": {
    "context-generator": "./dist/index.js"
  },
  "scripts": {
    "dev": "bun --hot src/index.ts",
    "build": "tsup src/index.ts --format esm --out-dir dist --target node22 --shebang",
    "start": "node dist/index.js",
    "test": "vitest run",
    "test:watch": "vitest",
    "typecheck": "tsc --noEmit"
  },
  "dependencies": {
    "commander": "^12.1.0",
    "fast-glob": "^3.3.2",
    "ignore": "^7.0.0",
    "@vue/compiler-sfc": "^3.5.0"
  },
  "devDependencies": {
    "@repo/typescript-config": "workspace:*",
    "@types/node": "catalog:",
    "tsup": "catalog:",
    "typescript": "catalog:",
    "vitest": "catalog:"
  }
}
```

### tsconfig.json

```json
{
  "extends": "@repo/typescript-config/node.json",
  "compilerOptions": {
    "outDir": "./dist",
    "rootDir": "./src"
  },
  "include": ["src/**/*"],
  "exclude": ["dist", "node_modules"]
}
```

### justfile

```justfile
set fallback := true

_default:
    just --list

dev:
    bun --hot src/index.ts

build:
    tsup src/index.ts --format esm --out-dir dist --target node22 --shebang

start:
    node dist/index.js

typecheck:
    tsc --noEmit

test:
    vitest run

test-watch:
    vitest
```

### vitest.config.ts

```typescript
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
  },
});
```

---

## Implementation Steps

### Step 1: Create Type Definitions (src/types.ts)

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

/**
 * Represents a discovered source file
 */
export interface SourceFile {
  /** Absolute path to the file */
  absolutePath: string;
  /** Path relative to root */
  relativePath: string;
  /** File extension */
  extension: string;
  /** File size in bytes */
  size: number;
}

/**
 * Result of parsing a source file
 */
export interface ParsedFile {
  /** Original source file info */
  sourceFile: SourceFile;
  /** Language for code block (ts, js, vue, py, kt) */
  language: string;
  /** Extracted skeleton content */
  skeleton: string;
  /** Error message if parsing failed */
  error?: string;
}

/**
 * Tree node for directory structure
 */
export interface TreeNode {
  /** Node name (file or directory name) */
  name: string;
  /** Full relative path */
  path: string;
  /** Whether this is a directory */
  isDirectory: boolean;
  /** Child nodes (if directory) */
  children?: TreeNode[];
}

/**
 * Processing statistics
 */
export interface ProcessingStats {
  /** Total files discovered */
  filesDiscovered: number;
  /** Files successfully parsed */
  filesParsed: number;
  /** Files skipped (binary, too large, error) */
  filesSkipped: number;
  /** List of skipped files with reasons */
  skippedFiles: Array<{ path: string; reason: string }>;
}

/**
 * Supported file extensions by language
 */
export const SUPPORTED_EXTENSIONS = {
  typescript: ['.ts', '.tsx'],
  javascript: ['.js', '.jsx'],
  vue: ['.vue'],
  python: ['.py'],
  kotlin: ['.kt', '.kts'],
} as const;

/** All supported extensions as a flat array */
export const ALL_EXTENSIONS = Object.values(SUPPORTED_EXTENSIONS).flat();
```

### Step 2: Create CLI Parser (src/cli.ts)

```typescript
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

  return {
    root: resolve(options.root),
    output: resolve(options.output),
    exclude: options.exclude,
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
```

### Step 3: Create File Discovery Module (src/file-discovery.ts)

```typescript
import { readFileSync, statSync } from 'fs';
import { resolve, relative, join } from 'path';
import fastGlob from 'fast-glob';
import ignore from 'ignore';
import type { SourceFile, CLIOptions } from './types.js';
import { ALL_EXTENSIONS } from './types.js';

/**
 * Discover source files in the project directory
 */
export async function discoverFiles(
  options: CLIOptions
): Promise<SourceFile[]> {
  const { root, exclude, verbose } = options;

  if (verbose) {
    console.log(`🔍 Scanning directory: ${root}`);
  }

  // Load .gitignore patterns
  const gitignorePatterns = loadGitignore(root);
  
  if (verbose && gitignorePatterns.length > 0) {
    console.log(`📋 Loaded ${gitignorePatterns.length} patterns from .gitignore`);
  }

  // Build glob pattern for supported extensions
  const extensionsPattern = ALL_EXTENSIONS.map(ext => `**/*${ext}`);

  // Find all files matching the patterns
  const globResults = await fastGlob(extensionsPattern, {
    cwd: root,
    dot: true,
    ignore: [
      '**/node_modules/**',
      '**/.git/**',
      '**/dist/**',
      '**/build/**',
      '**/*.d.ts',
      ...exclude,
      ...gitignorePatterns,
    ],
    absolute: true,
    onlyFiles: true,
  });

  // Process discovered files
  const files: SourceFile[] = [];
  const ig = ignore().add(gitignorePatterns);

  for (const absolutePath of globResults) {
    const relPath = relative(root, absolutePath);
    
    // Double-check against gitignore patterns (fast-glob may not catch all)
    if (ig.ignores(relPath)) {
      continue;
    }

    try {
      const stats = statSync(absolutePath);
      const extension = absolutePath.slice(absolutePath.lastIndexOf('.'));

      files.push({
        absolutePath,
        relativePath: relPath,
        extension,
        size: stats.size,
      });
    } catch (error) {
      if (verbose) {
        console.warn(`⚠️  Could not stat file: ${relPath}`);
      }
    }
  }

  // Sort by relative path for deterministic output
  files.sort((a, b) => a.relativePath.localeCompare(b.relativePath));

  if (verbose) {
    console.log(`📁 Found ${files.length} source files`);
  }

  return files;
}

/**
 * Load .gitignore patterns from the root directory
 */
function loadGitignore(root: string): string[] {
  try {
    const gitignorePath = join(root, '.gitignore');
    const content = readFileSync(gitignorePath, 'utf-8');
    return content
      .split('\n')
      .map(line => line.trim())
      .filter(line => line && !line.startsWith('#'));
  } catch {
    return [];
  }
}

/**
 * Check if a file should be treated as binary (skip content extraction)
 */
export function isBinaryFile(file: SourceFile, verbose: boolean): boolean {
  // Check extension
  const binaryExtensions = [
    '.png', '.jpg', '.jpeg', '.gif', '.ico', '.svg',
    '.woff', '.woff2', '.ttf', '.eot', '.otf',
    '.pdf', '.zip', '.tar', '.gz', '.rar',
    '.exe', '.dll', '.so', '.dylib',
    '.mp3', '.mp4', '.avi', '.mov',
  ];
  
  if (binaryExtensions.some(ext => file.extension.toLowerCase() === ext)) {
    if (verbose) {
      console.log(`⏭️  Skipping binary file: ${file.relativePath}`);
    }
    return true;
  }

  // Check size (skip files larger than 1MB)
  const MAX_SIZE = 1024 * 1024;
  if (file.size > MAX_SIZE) {
    if (verbose) {
      console.log(`⏭️  Skipping oversized file: ${file.relativePath} (${file.size} bytes)`);
    }
    return true;
  }

  return false;
}
```

### Step 4: Create Tree Generator (src/tree-generator.ts)

```typescript
import type { TreeNode, SourceFile } from './types.js';

/**
 * Generate a tree structure from source files
 */
export function generateTree(files: SourceFile[]): TreeNode {
  const root: TreeNode = {
    name: '.',
    path: '.',
    isDirectory: true,
    children: [],
  };

  for (const file of files) {
    const parts = file.relativePath.split('/');
    let current = root;
    let currentPath = '';

    for (let i = 0; i < parts.length; i++) {
      const part = parts[i];
      currentPath = currentPath ? `${currentPath}/${part}` : part;

      if (i === parts.length - 1) {
        // This is a file
        current.children!.push({
          name: part,
          path: file.relativePath,
          isDirectory: false,
        });
      } else {
        // This is a directory
        let child = current.children!.find(c => c.name === part && c.isDirectory);
        if (!child) {
          child = {
            name: part,
            path: currentPath,
            isDirectory: true,
            children: [],
          };
          current.children!.push(child);
        }
        current = child;
      }
    }
  }

  // Sort children: directories first, then files, both alphabetically
  sortTree(root);

  return root;
}

/**
 * Recursively sort tree nodes
 */
function sortTree(node: TreeNode): void {
  if (node.children) {
    node.children.sort((a, b) => {
      // Directories come before files
      if (a.isDirectory && !b.isDirectory) return -1;
      if (!a.isDirectory && b.isDirectory) return 1;
      // Alphabetical within same type
      return a.name.localeCompare(b.name);
    });

    for (const child of node.children) {
      sortTree(child);
    }
  }
}

/**
 * Render tree as ASCII string
 */
export function renderTree(node: TreeNode, prefix = '', isLast = true): string {
  let result = '';

  // Don't render root node itself, just its children
  if (node.name !== '.') {
    const connector = isLast ? '└── ' : '├── ';
    result += `${prefix}${connector}${node.name}\n`;
  }

  if (node.children && node.children.length > 0) {
    const newPrefix = node.name === '.' 
      ? prefix 
      : prefix + (isLast ? '    ' : '│   ');

    for (let i = 0; i < node.children.length; i++) {
      const child = node.children[i];
      const childIsLast = i === node.children.length - 1;
      result += renderTree(child, newPrefix, childIsLast);
    }
  }

  return result;
}
```

### Step 5: Create Parser Registry (src/parsers/index.ts)

```typescript
import type { SourceFile, ParsedFile } from '../types.js';
import { parseTypeScript } from './typescript.js';
import { parseVue } from './vue.js';
import { parsePython } from './python.js';
import { parseKotlin } from './kotlin.js';

/**
 * Parser function type
 */
type Parser = (file: SourceFile, verbose: boolean) => Promise<ParsedFile>;

/**
 * Map of extensions to parser functions
 */
const parserRegistry: Map<string, Parser> = new Map([
  ['.ts', parseTypeScript],
  ['.tsx', parseTypeScript],
  ['.js', parseTypeScript],
  ['.jsx', parseTypeScript],
  ['.vue', parseVue],
  ['.py', parsePython],
  ['.kt', parseKotlin],
  ['.kts', parseKotlin],
]);

/**
 * Get the appropriate parser for a file
 */
export function getParser(extension: string): Parser | undefined {
  return parserRegistry.get(extension.toLowerCase());
}

/**
 * Check if a file extension is supported
 */
export function isSupportedExtension(extension: string): boolean {
  return parserRegistry.has(extension.toLowerCase());
}

/**
 * Parse a source file using the appropriate parser
 */
export async function parseFile(
  file: SourceFile,
  verbose: boolean
): Promise<ParsedFile> {
  const parser = getParser(file.extension);
  
  if (!parser) {
    return {
      sourceFile: file,
      language: 'text',
      skeleton: '',
      error: `Unsupported file extension: ${file.extension}`,
    };
  }

  try {
    return await parser(file, verbose);
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    if (verbose) {
      console.warn(`⚠️  Error parsing ${file.relativePath}: ${errorMessage}`);
    }
    return {
      sourceFile: file,
      language: getLanguageForExtension(file.extension),
      skeleton: '',
      error: errorMessage,
    };
  }
}

/**
 * Get language identifier for markdown code blocks
 */
function getLanguageForExtension(ext: string): string {
  const languageMap: Record<string, string> = {
    '.ts': 'typescript',
    '.tsx': 'tsx',
    '.js': 'javascript',
    '.jsx': 'jsx',
    '.vue': 'vue',
    '.py': 'python',
    '.kt': 'kotlin',
    '.kts': 'kotlin',
  };
  return languageMap[ext.toLowerCase()] || 'text';
}
```

### Step 6: Create TypeScript/JSX Parser (src/parsers/typescript.ts)

```typescript
import { readFileSync } from 'fs';
import * as ts from 'typescript';
import type { SourceFile, ParsedFile } from '../types.js';

/**
 * Parse TypeScript/JavaScript/JSX files and extract skeleton
 * Uses TypeScript Compiler API for robust AST parsing
 */
export async function parseTypeScript(
  file: SourceFile,
  verbose: boolean
): Promise<ParsedFile> {
  const content = readFileSync(file.absolutePath, 'utf-8');
  
  // Determine compiler options based on file extension
  const isTsx = file.extension === '.tsx' || file.extension === '.jsx';
  const compilerOptions: ts.CompilerOptions = {
    target: ts.ScriptTarget.ESNext,
    module: ts.ModuleKind.ESNext,
    jsx: isTsx ? ts.JsxEmit.React : ts.JsxEmit.None,
    allowJs: true,
    checkJs: false,
    noEmit: true,
  };

  // Parse the file
  const sourceFile = ts.createSourceFile(
    file.relativePath,
    content,
    compilerOptions.target!,
    true
  );

  const skeleton = extractTypeScriptSkeleton(sourceFile);

  return {
    sourceFile: file,
    language: isTsx ? 'tsx' : 'typescript',
    skeleton,
  };
}

/**
 * Extract skeleton from TypeScript AST
 * Includes: imports, exports, type signatures, function signatures, docstrings
 */
function extractTypeScriptSkeleton(sourceFile: ts.SourceFile): string {
  const lines: string[] = [];

  function visit(node: ts.Node) {
    // Import declarations
    if (ts.isImportDeclaration(node)) {
      lines.push(node.getText(sourceFile));
      return;
    }

    // Export declarations (re-exports)
    if (ts.isExportDeclaration(node)) {
      lines.push(node.getText(sourceFile));
      return;
    }

    // Interface declarations
    if (ts.isInterfaceDeclaration(node)) {
      lines.push(extractInterface(node, sourceFile));
      return;
    }

    // Type alias declarations
    if (ts.isTypeAliasDeclaration(node)) {
      lines.push(extractTypeAlias(node, sourceFile));
      return;
    }

    // Enum declarations
    if (ts.isEnumDeclaration(node)) {
      lines.push(extractEnum(node, sourceFile));
      return;
    }

    // Class declarations
    if (ts.isClassDeclaration(node)) {
      lines.push(extractClass(node, sourceFile));
      return;
    }

    // Function declarations
    if (ts.isFunctionDeclaration(node)) {
      lines.push(extractFunction(node, sourceFile));
      return;
    }

    // Variable declarations (const/let/var with potential arrow functions)
    if (ts.isVariableStatement(node)) {
      const extracted = extractVariableStatement(node, sourceFile);
      if (extracted) lines.push(extracted);
      return;
    }

    // Export assignment (export default / export =)
    if (ts.isExportAssignment(node)) {
      lines.push(extractExportAssignment(node, sourceFile));
      return;
    }

    // Continue visiting child nodes for top-level
    ts.forEachChild(node, visit);
  }

  ts.forEachChild(sourceFile, visit);

  return lines.join('\n\n');
}

function extractInterface(node: ts.InterfaceDeclaration, source: ts.SourceFile): string {
  const jsDoc = getJsDoc(node, source);
  const modifiers = node.modifiers ? node.modifiers.map(m => m.getText(source)).join(' ') + ' ' : '';
  const typeParams = node.typeParameters 
    ? `<${node.typeParameters.map(tp => tp.getText(source)).join(', ')}>` 
    : '';
  
  const members = node.members.map(member => {
    const memberJsDoc = getJsDoc(member, source);
    const text = member.getText(source);
    return memberJsDoc ? `${memberJsDoc}\n  ${text}` : `  ${text}`;
  }).join('\n');

  return `${jsDoc}${jsDoc ? '\n' : ''}${modifiers}interface ${node.name.text}${typeParams} {\n${members}\n}`;
}

function extractTypeAlias(node: ts.TypeAliasDeclaration, source: ts.SourceFile): string {
  const jsDoc = getJsDoc(node, source);
  const modifiers = node.modifiers ? node.modifiers.map(m => m.getText(source)).join(' ') + ' ' : '';
  const typeParams = node.typeParameters 
    ? `<${node.typeParameters.map(tp => tp.getText(source)).join(', ')}>` 
    : '';
  return `${jsDoc}${jsDoc ? '\n' : ''}${modifiers}type ${node.name.text}${typeParams} = ${node.type.getText(source)};`;
}

function extractEnum(node: ts.EnumDeclaration, source: ts.SourceFile): string {
  const jsDoc = getJsDoc(node, source);
  const modifiers = node.modifiers ? node.modifiers.map(m => m.getText(source)).join(' ') + ' ' : '';
  const members = node.members.map(m => `  ${m.getText(source)}`).join(',\n');
  return `${jsDoc}${jsDoc ? '\n' : ''}${modifiers}enum ${node.name.text} {\n${members}\n}`;
}

function extractClass(node: ts.ClassDeclaration, source: ts.SourceFile): string {
  const jsDoc = getJsDoc(node, source);
  const modifiers = node.modifiers ? node.modifiers.map(m => m.getText(source)).join(' ') + ' ' : '';
  const name = node.name ? node.name.text : '';
  const typeParams = node.typeParameters 
    ? `<${node.typeParameters.map(tp => tp.getText(source)).join(', ')}>` 
    : '';
  const heritage = node.heritageClauses 
    ? ' ' + node.heritageClauses.map(h => h.getText(source)).join(' ')
    : '';

  const members = node.members.map(member => {
    const memberJsDoc = getJsDoc(member, source);
    const text = member.getText(source);
    // Skip private members
    if (ts.isPropertyDeclaration(member) || ts.isMethodDeclaration(member)) {
      const isPrivate = member.modifiers?.some(m => m.kind === ts.SyntaxKind.PrivateKeyword);
      if (isPrivate) return null;
    }
    // For method bodies, only keep signature
    if (ts.isMethodDeclaration(member) && member.body) {
      const sig = extractMethodSignature(member, source);
      return memberJsDoc ? `${memberJsDoc}\n  ${sig}` : `  ${sig}`;
    }
    return memberJsDoc ? `${memberJsDoc}\n  ${text}` : `  ${text}`;
  }).filter(Boolean).join('\n\n');

  return `${jsDoc}${jsDoc ? '\n' : ''}${modifiers}class ${name}${typeParams}${heritage} {\n${members}\n}`;
}

function extractMethodSignature(node: ts.MethodDeclaration, source: ts.SourceFile): string {
  const modifiers = node.modifiers ? node.modifiers.map(m => m.getText(source)).join(' ') + ' ' : '';
  const name = node.name.getText(source);
  const typeParams = node.typeParameters 
    ? `<${node.typeParameters.map(tp => tp.getText(source)).join(', ')}>` 
    : '';
  const params = node.parameters.map(p => p.getText(source)).join(', ');
  const returnType = node.type ? `: ${node.type.getText(source)}` : '';
  return `${modifiers}${name}${typeParams}(${params})${returnType};`;
}

function extractFunction(node: ts.FunctionDeclaration, source: ts.SourceFile): string {
  const jsDoc = getJsDoc(node, source);
  const modifiers = node.modifiers ? node.modifiers.map(m => m.getText(source)).join(' ') + ' ' : '';
  const name = node.name ? node.name.text : 'anonymous';
  const typeParams = node.typeParameters 
    ? `<${node.typeParameters.map(tp => tp.getText(source)).join(', ')}>` 
    : '';
  const params = node.parameters.map(p => p.getText(source)).join(', ');
  const returnType = node.type ? `: ${node.type.getText(source)}` : '';
  return `${jsDoc}${jsDoc ? '\n' : ''}${modifiers}function ${name}${typeParams}(${params})${returnType};`;
}

function extractVariableStatement(node: ts.VariableStatement, source: ts.SourceFile): string | null {
  const jsDoc = getJsDoc(node, source);
  const declaration = node.declarationList.declarations[0];
  
  if (!declaration) return null;

  const name = declaration.name.getText(source);
  const type = declaration.type ? `: ${declaration.type.getText(source)}` : '';
  
  // Check if initializer is an arrow function or regular function
  if (declaration.initializer) {
    if (ts.isArrowFunction(declaration.initializer)) {
      const arrow = declaration.initializer;
      const typeParams = arrow.typeParameters 
        ? `<${arrow.typeParameters.map(tp => tp.getText(source)).join(', ')}>` 
        : '';
      const params = arrow.parameters.map(p => p.getText(source)).join(', ');
      const returnType = arrow.type ? `: ${arrow.type.getText(source)}` : '';
      const modifiers = node.modifiers ? node.modifiers.map(m => m.getText(source)).join(' ') + ' ' : '';
      return `${jsDoc}${jsDoc ? '\n' : ''}${modifiers}const ${name}${typeParams}: (${params}) => ${returnType || 'any'};`;
    }
  }

  // Regular variable - include if it has export
  const isExported = node.modifiers?.some(m => 
    m.kind === ts.SyntaxKind.ExportKeyword ||
    m.kind === ts.SyntaxKind.DeclareKeyword
  );
  
  if (isExported) {
    const modifiers = node.modifiers ? node.modifiers.map(m => m.getText(source)).join(' ') + ' ' : '';
    return `${jsDoc}${jsDoc ? '\n' : ''}${modifiers}const ${name}${type};`;
  }

  return null;
}

function extractExportAssignment(node: ts.ExportAssignment, source: ts.SourceFile): string {
  return node.getText(source);
}

function getJsDoc(node: ts.Node, source: ts.SourceFile): string {
  const jsDoc = ts.getJSDocCommentsAndTags(node);
  if (jsDoc && jsDoc.length > 0) {
    return jsDoc.map(doc => doc.getText(source)).join('\n');
  }
  return '';
}
```

### Step 7: Create Vue Parser (src/parsers/vue.ts)

```typescript
import { readFileSync } from 'fs';
import * as compiler from '@vue/compiler-sfc';
import * as ts from 'typescript';
import type { SourceFile, ParsedFile } from '../types.js';

/**
 * Parse Vue Single File Components
 * Extracts script/setup blocks and parses with TypeScript
 */
export async function parseVue(
  file: SourceFile,
  verbose: boolean
): Promise<ParsedFile> {
  const content = readFileSync(file.absolutePath, 'utf-8');
  
  const { descriptor, errors } = compiler.parse(content, {
    filename: file.relativePath,
  });

  if (errors.length > 0 && verbose) {
    console.warn(`⚠️  Vue parse warnings for ${file.relativePath}:`, errors);
  }

  // Extract script content (prefer <script setup>)
  const script = descriptor.scriptSetup || descriptor.script;
  
  if (!script) {
    return {
      sourceFile: file,
      language: 'vue',
      skeleton: '<!-- No script block found -->',
    };
  }

  const scriptContent = script.content;
  const isTypeScript = script.lang === 'ts';

  // Parse script content with TypeScript
  const sourceFile = ts.createSourceFile(
    file.relativePath,
    scriptContent,
    ts.ScriptTarget.ESNext,
    true
  );

  const skeleton = extractVueScriptSkeleton(sourceFile, descriptor);

  return {
    sourceFile: file,
    language: 'vue',
    skeleton,
  };
}

/**
 * Extract skeleton from Vue script content
 */
function extractVueScriptSkeleton(
  sourceFile: ts.SourceFile,
  descriptor: compiler.SFCDescriptor
): string {
  const lines: string[] = [];

  // Add template reference if exists
  if (descriptor.template) {
    lines.push('<!-- Template -->');
    lines.push('<template>...</template>');
    lines.push('');
  }

  // Add script block indicator
  const scriptBlock = descriptor.scriptSetup || descriptor.script;
  if (scriptBlock) {
    const lang = scriptBlock.lang || 'js';
    const setup = descriptor.scriptSetup ? ' setup' : '';
    lines.push(`<script lang="${lang}"${setup}>`);
  }

  // Extract imports and exports from script
  function visit(node: ts.Node) {
    // Import declarations
    if (ts.isImportDeclaration(node)) {
      lines.push(node.getText(sourceFile));
      return;
    }

    // Export declarations
    if (ts.isExportDeclaration(node)) {
      lines.push(node.getText(sourceFile));
      return;
    }

    // Interface and type declarations
    if (ts.isInterfaceDeclaration(node)) {
      lines.push(extractNodeSkeleton(node, sourceFile));
      return;
    }

    if (ts.isTypeAliasDeclaration(node)) {
      lines.push(extractNodeSkeleton(node, sourceFile));
      return;
    }

    // Props and emits definitions (defineProps, defineEmits)
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name)) {
      const name = node.name.text;
      if (name === 'props' || name === 'emit') {
        lines.push(`const ${name} = ${node.initializer?.getText(sourceFile) || '...'};`);
        return;
      }
    }

    // Function declarations
    if (ts.isFunctionDeclaration(node)) {
      lines.push(extractFunctionSignature(node, sourceFile));
      return;
    }

    // Variable statements (const/let/var with functions)
    if (ts.isVariableStatement(node)) {
      const extracted = extractVariableSkeleton(node, sourceFile);
      if (extracted) lines.push(extracted);
      return;
    }

    ts.forEachChild(node, visit);
  }

  ts.forEachChild(sourceFile, visit);

  lines.push('</script>');

  // Add style reference if exists
  if (descriptor.styles.length > 0) {
    lines.push('');
    lines.push('<!-- Styles -->');
    for (const style of descriptor.styles) {
      const scoped = style.scoped ? ' scoped' : '';
      const lang = style.lang ? ` lang="${style.lang}"` : '';
      lines.push(`<style${scoped}${lang}>...</style>`);
    }
  }

  return lines.join('\n');
}

function extractNodeSkeleton(node: ts.Node, source: ts.SourceFile): string {
  return node.getText(source);
}

function extractFunctionSignature(node: ts.FunctionDeclaration, source: ts.SourceFile): string {
  const modifiers = node.modifiers ? node.modifiers.map(m => m.getText(source)).join(' ') + ' ' : '';
  const name = node.name ? node.name.text : 'anonymous';
  const typeParams = node.typeParameters 
    ? `<${node.typeParameters.map(tp => tp.getText(source)).join(', ')}>` 
    : '';
  const params = node.parameters.map(p => p.getText(source)).join(', ');
  const returnType = node.type ? `: ${node.type.getText(source)}` : '';
  return `${modifiers}function ${name}${typeParams}(${params})${returnType};`;
}

function extractVariableSkeleton(node: ts.VariableStatement, source: ts.SourceFile): string | null {
  const declaration = node.declarationList.declarations[0];
  if (!declaration) return null;

  const name = declaration.name.getText(source);
  const type = declaration.type ? `: ${declaration.type.getText(source)}` : '';

  // Check if it's a function-like variable
  if (declaration.initializer) {
    if (ts.isArrowFunction(declaration.initializer) || ts.isFunctionExpression(declaration.initializer)) {
      const func = declaration.initializer;
      const params = func.parameters.map(p => p.getText(source)).join(', ');
      const returnType = func.type ? `: ${func.type.getText(source)}` : '';
      return `const ${name}: (${params}) => ${returnType || 'any'};`;
    }
  }

  // Include if exported
  const isExported = node.modifiers?.some(m => m.kind === ts.SyntaxKind.ExportKeyword);
  if (isExported) {
    return `const ${name}${type};`;
  }

  return null;
}
```

### Step 8: Create Python Parser (src/parsers/python.ts)

```typescript
import { readFileSync } from 'fs';
import type { SourceFile, ParsedFile } from '../types.js';

/**
 * Parse Python files using regex/heuristic extraction
 * Since there's no pure-JS Python AST parser without native bindings
 */
export async function parsePython(
  file: SourceFile,
  verbose: boolean
): Promise<ParsedFile> {
  const content = readFileSync(file.absolutePath, 'utf-8');
  const lines = content.split('\n');
  
  const skeletonLines: string[] = [];
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];
    const trimmed = line.trim();

    // Skip empty lines
    if (!trimmed) {
      i++;
      continue;
    }

    // Import statements
    if (trimmed.startsWith('import ') || trimmed.startsWith('from ')) {
      skeletonLines.push(line);
      i++;
      continue;
    }

    // Docstring at module level (triple quotes)
    if (trimmed.startsWith('"""') || trimmed.startsWith("'''")) {
      const docstring = extractDocstring(lines, i);
      skeletonLines.push(docstring);
      i += docstring.split('\n').length;
      continue;
    }

    // Class definition
    if (trimmed.startsWith('class ')) {
      const classBlock = extractClass(lines, i);
      skeletonLines.push(classBlock);
      i += countBlockLines(lines, i);
      continue;
    }

    // Function definition
    if (trimmed.startsWith('def ') || trimmed.startsWith('async def ')) {
      const funcSig = extractFunctionSignature(lines, i);
      skeletonLines.push(funcSig);
      i += countBlockLines(lines, i);
      continue;
    }

    // Global variable with type annotation (exported)
    if (trimmed.includes(':') && !trimmed.startsWith('#') && isGlobalVariable(line)) {
      const typeAnnotation = extractTypeAnnotation(trimmed);
      if (typeAnnotation) {
        skeletonLines.push(typeAnnotation);
      }
      i++;
      continue;
    }

    // Decorators (keep them with next function/class)
    if (trimmed.startsWith('@')) {
      skeletonLines.push(line);
      i++;
      continue;
    }

    // Constants (ALL_CAPS) at module level
    if (/^[A-Z][A-Z_0-9]*\s*=/.test(trimmed)) {
      skeletonLines.push(line.split('=')[0] + '= ...');
      i++;
      continue;
    }

    i++;
  }

  return {
    sourceFile: file,
    language: 'python',
    skeleton: skeletonLines.join('\n'),
  };
}

/**
 * Extract docstring (handles multi-line)
 */
function extractDocstring(lines: string[], startIdx: number): string {
  const firstLine = lines[startIdx].trim();
  const quote = firstLine.startsWith('"""') ? '"""' : "'''";
  
  // Single line docstring
  if (firstLine.endsWith(quote) && firstLine.length > 3) {
    return lines[startIdx];
  }

  // Multi-line docstring
  let result = [lines[startIdx]];
  let i = startIdx + 1;
  
  while (i < lines.length) {
    result.push(lines[i]);
    if (lines[i].trim().endsWith(quote)) {
      break;
    }
    i++;
  }
  
  return result.join('\n');
}

/**
 * Extract class definition with method signatures (no bodies)
 */
function extractClass(lines: string[], startIdx: number): string {
  const classLine = lines[startIdx].trim();
  const match = classLine.match(/^(class\s+\w+)(\([^)]*\))?:/);
  
  if (!match) return classLine;

  const className = match[1];
  const baseClass = match[2] || '';
  const result: string[] = [`${className}${baseClass}:`];

  // Find class body
  let i = startIdx + 1;
  const classIndent = getIndent(lines[startIdx]) + 4;

  while (i < lines.length) {
    const line = lines[i];
    const trimmed = line.trim();
    const indent = getIndent(line);

    // End of class
    if (trimmed && indent < classIndent) {
      break;
    }

    if (indent === classIndent) {
      // Method definition
      if (trimmed.startsWith('def ') || trimmed.startsWith('async def ')) {
        const docstringLines: string[] = [];
        const sig = extractPythonFunctionSignature(trimmed);
        result.push('    ' + sig);
        
        // Look for docstring
        let j = i + 1;
        while (j < lines.length && getIndent(lines[j]) > classIndent) {
          const innerTrimmed = lines[j].trim();
          if (innerTrimmed.startsWith('"""') || innerTrimmed.startsWith("'''")) {
            const docstring = extractDocstring(lines, j);
            docstringLines.push('    ' + docstring.split('\n').join('\n    '));
            break;
          }
          if (innerTrimmed && !innerTrimmed.startsWith('#')) {
            break;
          }
          j++;
        }
        
        if (docstringLines.length > 0) {
          result.push(...docstringLines);
        }
        result.push('        ...');
      }
      // Class variables with type annotations
      else if (trimmed.includes(':') && trimmed.includes('=')) {
        const varMatch = trimmed.match(/^([a-zA-Z_][a-zA-Z0-9_]*\s*:\s*[^=]+)/);
        if (varMatch) {
          result.push('    ' + varMatch[1] + ' = ...');
        }
      }
      // Pass/ellipsis for empty sections
      else if (trimmed === 'pass' || trimmed === '...') {
        result.push('    ...');
      }
    }

    i++;
  }

  return result.join('\n');
}

/**
 * Extract function signature line
 */
function extractFunctionSignature(lines: string[], startIdx: number): string {
  const line = lines[startIdx].trim();
  return extractPythonFunctionSignature(line);
}

/**
 * Extract Python function signature from a line
 */
function extractPythonFunctionSignature(line: string): string {
  // Match def or async def
  const match = line.match(/^(async\s+)?def\s+(\w+\([^)]*\))(\s*->\s*[^:]+)?:/);
  if (match) {
    const async = match[1] || '';
    const sig = match[2];
    const returnType = match[3] || '';
    return `${async}def ${sig}${returnType}:`;
  }
  return line;
}

/**
 * Check if line represents a global variable
 */
function isGlobalVariable(line: string): boolean {
  // Simple heuristic: starts with identifier at column 0
  return /^[a-zA-Z_][a-zA-Z0-9_]*\s*:/.test(line.trim());
}

/**
 * Extract type annotation from variable
 */
function extractTypeAnnotation(trimmed: string): string | null {
  const match = trimmed.match(/^([a-zA-Z_][a-zA-Z0-9_]*\s*:\s*[^=#]+)/);
  if (match) {
    return match[1].trim() + ' = ...';
  }
  return null;
}

/**
 * Get indentation level of a line
 */
function getIndent(line: string): number {
  const match = line.match(/^(\s*)/);
  return match ? match[1].length : 0;
}

/**
 * Count lines until block ends (simple indentation-based)
 */
function countBlockLines(lines: string[], startIdx: number): number {
  const baseIndent = getIndent(lines[startIdx]);
  let count = 1;
  let i = startIdx + 1;

  while (i < lines.length) {
    const line = lines[i];
    const trimmed = line.trim();
    const indent = getIndent(line);

    if (trimmed && indent <= baseIndent) {
      break;
    }
    count++;
    i++;
  }

  return count;
}
```

### Step 9: Create Kotlin Parser (src/parsers/kotlin.ts)

```typescript
import { readFileSync } from 'fs';
import type { SourceFile, ParsedFile } from '../types.js';

/**
 * Parse Kotlin files using regex/heuristic extraction
 * Extracts: imports, package declarations, class/interface/object signatures,
 * function signatures, property declarations with types
 */
export async function parseKotlin(
  file: SourceFile,
  verbose: boolean
): Promise<ParsedFile> {
  const content = readFileSync(file.absolutePath, 'utf-8');
  const lines = content.split('\n');
  
  const skeletonLines: string[] = [];
  let i = 0;
  let inMultilineComment = false;

  while (i < lines.length) {
    const line = lines[i];
    const trimmed = line.trim();

    // Handle multi-line comments
    if (trimmed.startsWith('/*')) {
      inMultilineComment = true;
    }
    if (inMultilineComment) {
      if (trimmed.includes('*/')) {
        inMultilineComment = false;
      }
      i++;
      continue;
    }

    // Skip empty lines and single-line comments
    if (!trimmed || trimmed.startsWith('//')) {
      i++;
      continue;
    }

    // Package declaration
    if (trimmed.startsWith('package ')) {
      skeletonLines.push(line);
      i++;
      continue;
    }

    // Import statements
    if (trimmed.startsWith('import ')) {
      skeletonLines.push(line);
      i++;
      continue;
    }

    // Annotations (keep them with next declaration)
    if (trimmed.startsWith('@')) {
      skeletonLines.push(line);
      i++;
      continue;
    }

    // Class declaration
    const classMatch = trimmed.match(/^(abstract\s+)?(data\s+)?(class|interface|object|enum\s+class)\s+(\w+)/);
    if (classMatch) {
      const classBlock = extractKotlinClass(lines, i);
      skeletonLines.push(classBlock);
      i += countKotlinBlockLines(lines, i);
      continue;
    }

    // Function declaration
    const funcMatch = trimmed.match(/^(abstract\s+)?(suspend\s+)?(fun\s+)/);
    if (funcMatch) {
      const funcSig = extractKotlinFunction(lines, i);
      skeletonLines.push(funcSig);
      i += countKotlinBlockLines(lines, i);
      continue;
    }

    // Property/variable declaration (val/var)
    if (trimmed.match(/^(val|var|const\s+val|lateinit\s+var)\s+/)) {
      const prop = extractKotlinProperty(trimmed);
      if (prop) {
        skeletonLines.push(prop);
      }
      i++;
      continue;
    }

    // Type alias
    if (trimmed.startsWith('typealias ')) {
      skeletonLines.push(trimmed);
      i++;
      continue;
    }

    i++;
  }

  return {
    sourceFile: file,
    language: 'kotlin',
    skeleton: skeletonLines.join('\n'),
  };
}

/**
 * Extract Kotlin class/object/interface with signatures
 */
function extractKotlinClass(lines: string[], startIdx: number): string {
  const classLine = lines[startIdx].trim();
  
  // Extract class signature
  const sigMatch = classLine.match(/^((?:abstract\s+)?(?:data\s+)?(?:enum\s+)?(?:sealed\s+)?(?:open\s+)?(?:internal\s+)?(?:public\s+)?(?:protected\s+)?(?:private\s+)*)((?:class|interface|object|enum\s+class))\s+(\w+)([^{]*)/);
  
  if (!sigMatch) {
    return classLine;
  }

  const modifiers = sigMatch[1]?.trim() || '';
  const type = sigMatch[2].trim();
  const name = sigMatch[3];
  const genericsAndInheritance = sigMatch[4]?.trim() || '';
  
  const result: string[] = [
    `${modifiers ? modifiers + ' ' : ''}${type} ${name}${genericsAndInheritance} {`
  ];

  // Find class body
  let i = startIdx + 1;
  const classIndent = getIndent(lines[startIdx]);
  const bodyIndent = classIndent + 4;

  while (i < lines.length) {
    const line = lines[i];
    const trimmed = line.trim();
    const indent = getIndent(line);

    // End of class
    if (trimmed === '}' && indent === classIndent) {
      break;
    }

    if (indent >= bodyIndent || (trimmed && indent === bodyIndent)) {
      // Constructor
      if (trimmed.match(/^(constructor|init)\s*[({]/)) {
        const constructorSig = trimmed.match(/^(constructor[^{]+)/)?.[1] || 'constructor(...)';
        result.push('    ' + constructorSig);
        
        // Look for KDoc/docstring
        const kdoc = findPreviousKDoc(lines, startIdx, i);
        if (kdoc) {
          result.splice(result.length - 1, 0, '    ' + kdoc);
        }
      }
      // Property
      else if (trimmed.match(/^(val|var|abstract\s+val|abstract\s+var|lateinit\s+var|const\s+val)\s+/)) {
        const prop = extractKotlinProperty(trimmed);
        if (prop) {
          result.push('    ' + prop);
        }
      }
      // Function
      else if (trimmed.match(/^(abstract\s+)?(suspend\s+)?fun\s+/)) {
        const func = extractKotlinFunctionSignature(trimmed);
        result.push('    ' + func);
      }
      // Nested class/object
      else if (trimmed.match(/^(class|interface|object)\s+/)) {
        const nested = trimmed.match(/^((?:class|interface|object)\s+\w+[^{]*)/)?.[1];
        if (nested) {
          result.push('    ' + nested + ' { ... }');
        }
      }
    }

    i++;
  }

  result.push('}');
  return result.join('\n');
}

/**
 * Extract Kotlin function signature
 */
function extractKotlinFunction(lines: string[], startIdx: number): string {
  const line = lines[startIdx].trim();
  return extractKotlinFunctionSignature(line);
}

/**
 * Extract function signature from a line
 */
function extractKotlinFunctionSignature(line: string): string {
  // Match function signature up to opening brace or equals
  const match = line.match(/^((?:abstract\s+)?(?:suspend\s+)?(?:external\s+)?(?:override\s+)?(?:open\s+)?(?:internal\s+)?(?:public\s+)?(?:protected\s+)?(?:private\s+)*)fun\s+(?:<[^>]+>\s+)?(\w+)\s*\([^)]*\)(\s*:\s*[^={]+)?/);
  
  if (match) {
    const modifiers = match[1]?.trim() || '';
    const name = match[2];
    const returnType = match[3]?.trim() || '';
    
    // Extract parameters (simplified)
    const paramsMatch = line.match(/\(([^)]*)\)/);
    const params = paramsMatch ? paramsMatch[1] : '';
    
    // Check if abstract
    const isAbstract = modifiers.includes('abstract');
    const suffix = isAbstract ? '' : ' { ... }';
    
    return `${modifiers ? modifiers + ' ' : ''}fun ${name}(${params})${returnType}${suffix}`;
  }
  
  return line;
}

/**
 * Extract Kotlin property declaration
 */
function extractKotlinProperty(trimmed: string): string | null {
  // Match val/var with type annotation
  const match = trimmed.match(/^(val|var|const\s+val|lateinit\s+var)\s+(\w+)(\s*:\s*[^=]+)?/);
  
  if (match) {
    const kind = match[1];
    const name = match[2];
    const type = match[3] || '';
    return `${kind} ${name}${type}`;
  }
  
  return null;
}

/**
 * Find KDoc comment before a declaration
 */
function findPreviousKDoc(lines: string[], startIdx: number, targetIdx: number): string | null {
  for (let i = targetIdx - 1; i > startIdx; i--) {
    const trimmed = lines[i].trim();
    if (trimmed.startsWith('/**')) {
      // Extract KDoc (simplified - just returns indicator)
      return '/** ... */';
    }
    if (trimmed && !trimmed.startsWith('//') && !trimmed.startsWith('@')) {
      break;
    }
  }
  return null;
}

/**
 * Get indentation level
 */
function getIndent(line: string): number {
  const match = line.match(/^(\s*)/);
  return match ? match[1].length : 0;
}

/**
 * Count lines in a Kotlin block
 */
function countKotlinBlockLines(lines: string[], startIdx: number): number {
  const baseIndent = getIndent(lines[startIdx]);
  let count = 1;
  let i = startIdx + 1;
  let braceCount = 0;

  // Check if starts with brace on same line
  const firstLine = lines[startIdx];
  if (firstLine.includes('{')) {
    braceCount++;
  }

  while (i < lines.length) {
    const line = lines[i];
    const trimmed = line.trim();

    // Count braces
    for (const char of line) {
      if (char === '{') braceCount++;
      if (char === '}') braceCount--;
    }

    count++;

    // End of block
    if (braceCount === 0 && trimmed === '}') {
      break;
    }

    i++;
  }

  return count;
}
```

### Step 10: Create Output Writer (src/output-writer.ts)

```typescript
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
  lines.push('## File Contents');
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
```

### Step 11: Create Main Entry Point (src/index.ts)

```typescript
#!/usr/bin/env node

import { parseArgs } from './cli.js';
import { discoverFiles, isBinaryFile } from './file-discovery.js';
import { generateTree } from './tree-generator.js';
import { parseFile } from './parsers/index.js';
import { writeOutput } from './output-writer.js';
import type { ParsedFile, ProcessingStats, SourceFile } from './types.js';

async function main(): Promise<void> {
  const startTime = Date.now();
  const options = parseArgs();

  if (options.verbose) {
    console.log('🚀 context-generator');
    console.log(`   Root: ${options.root}`);
    console.log(`   Output: ${options.output}`);
    if (options.exclude.length > 0) {
      console.log(`   Exclude: ${options.exclude.join(', ')}`);
    }
    console.log('');
  }

  try {
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

    const duration = Date.now() - startTime;
    
    console.log(`\n✨ Done! Generated: ${options.output}`);
    console.log(`   Files: ${filesParsed} parsed, ${skippedFiles.length} skipped`);
    console.log(`   Time: ${duration}ms`);

    // Exit with error code if there were failures
    if (skippedFiles.length > 0 && filesParsed === 0) {
      console.error('\n⚠️  Warning: All files were skipped or failed to parse');
      process.exit(1);
    }

  } catch (error) {
    console.error('\n💥 Fatal error:', error);
    process.exit(1);
  }
}

// Run main with error handling
main().catch((error) => {
  console.error('💥 Unhandled error:', error);
  process.exit(1);
});
```

---

## Installation & Usage Instructions

### Installation

```bash
# From monorepo root
pnpm install

# Build the package
pnpm --filter @repo/context-generator build
```

### Usage

```bash
# Basic usage - scan current directory
pnpm --filter @repo/context-generator start

# Scan specific directory
pnpm --filter @repo/context-generator start -- --root ./my-project

# Custom output file
pnpm --filter @repo/context-generator start -- --output ./docs/context.md

# Exclude patterns
pnpm --filter @repo/context-generator start -- --exclude "*.test.ts,*.spec.ts"

# Multiple exclude flags
pnpm --filter @repo/context-generator start -- --exclude "*.test.ts" --exclude "node_modules"

# Verbose mode
pnpm --filter @repo/context-generator start -- --verbose

# Combined options
pnpm --filter @repo/context-generator start -- --root ./src --output ./context.md --exclude "*.test.ts" --verbose

# Using the binary directly
./tools/context-generator/dist/index.js --root ./src --verbose
```

### Command-Line Options

```
Usage: context-generator [options]

Generate LLM context from project source files

Options:
  -V, --version          output the version number
  -r, --root <path>      Root directory to scan (default: current directory)
  -o, --output <path>    Output file path (default: "llm_context.md")
  -e, --exclude <patterns>  Exclude patterns (comma-separated or repeatable)
  -v, --verbose          Enable verbose diagnostics (default: false)
  -h, --help             display help for command
```

---

## Acceptance Criteria

### AC-1: Package Structure
- [ ] Package exists at `tools/context-generator/`
- [ ] `package.json` includes all required dependencies
- [ ] `tsconfig.json` extends `@repo/typescript-config/node.json`
- [ ] `justfile` defines `dev`, `build`, `test`, and `start` tasks
- [ ] `vitest.config.ts` configured for unit testing
- [ ] Package builds successfully with `pnpm build`

### AC-2: CLI Arguments
- [ ] `--root` (optional) accepts path to scan (defaults to cwd)
- [ ] `--output` (optional) accepts output file path (defaults to `llm_context.md`)
- [ ] `--exclude` (optional, repeatable) accepts glob patterns to exclude
- [ ] `--verbose` (optional) enables diagnostic output
- [ ] CLI displays help with `-h` or `--help`
- [ ] CLI displays version with `-V` or `--version`
- [ ] Combined short options work correctly

### AC-3: .gitignore Integration
- [ ] Automatically finds and parses `.gitignore` in root directory
- [ ] Files matching .gitignore patterns are excluded from discovery
- [ ] Works with nested .gitignore files (via glob pattern matching)
- [ ] Handles missing .gitignore gracefully

### AC-4: File Discovery
- [ ] Discovers all supported file types: `.ts`, `.tsx`, `.js`, `.jsx`, `.vue`, `.py`, `.kt`, `.kts`
- [ ] Excludes `node_modules`, `.git`, `dist`, `build` directories
- [ ] Excludes `.d.ts` declaration files
- [ ] Applies custom `--exclude` patterns correctly
- [ ] Skips binary files with warning in verbose mode
- [ ] Skips oversized files (>1MB) with warning in verbose mode
- [ ] Results are deterministically sorted by relative path

### AC-5: TypeScript/JavaScript Parsing
- [ ] Extracts import statements
- [ ] Extracts export statements
- [ ] Extracts interface declarations with docstrings
- [ ] Extracts type alias declarations
- [ ] Extracts enum declarations
- [ ] Extracts class declarations with public method signatures (no bodies)
- [ ] Extracts function declarations with signatures
- [ ] Extracts exported const declarations with type annotations
- [ ] Preserves JSDoc comments

### AC-6: Vue SFC Parsing
- [ ] Extracts `<script>` and `<script setup>` blocks
- [ ] Parses script content with TypeScript parser
- [ ] Handles both JS and TS scripts (lang="ts")
- [ ] Includes template and style block indicators in output
- [ ] Preserves imports and exports from script

### AC-7: Python Parsing
- [ ] Extracts import and from-import statements
- [ ] Extracts module-level docstrings
- [ ] Extracts class definitions with method signatures
- [ ] Extracts function signatures (def and async def)
- [ ] Extracts type-annotated global variables
- [ ] Preserves decorators

### AC-8: Kotlin Parsing
- [ ] Extracts package declarations
- [ ] Extracts import statements
- [ ] Extracts class/interface/object/enum declarations
- [ ] Extracts function signatures with type annotations
- [ ] Extracts property declarations (val/var)
- [ ] Preserves annotations

### AC-9: Output Format
- [ ] Generates valid Markdown output
- [ ] Includes "Project Tree" section with ASCII tree
- [ ] Includes "File Contents" section with code blocks
- [ ] Each file has `### <relative/path>` heading
- [ ] Code blocks use correct language tags
- [ ] Includes processing statistics in summary
- [ ] Skipped files section included only when files were skipped

### AC-10: Error Handling
- [ ] Continues processing when individual files fail
- [ ] Reports skipped files with reasons in verbose mode
- [ ] Handles permission errors gracefully
- [ ] Handles unreadable files gracefully
- [ ] Handles symlink loops safely
- [ ] Exits with non-zero code on complete failure
- [ ] Exits with success code on partial success

### AC-11: Cross-Platform Compatibility
- [ ] Works on macOS
- [ ] Works on Linux
- [ ] Works on Windows (path handling)

---

## Testing Strategy

### Unit Tests

Create `src/*.test.ts` files alongside each module:

1. **cli.test.ts**: Test argument parsing
   - Default values
   - Custom values
   - Multiple exclude patterns
   - Help/version display

2. **file-discovery.test.ts**: Test file discovery
   - Mock filesystem with test files
   - Verify glob patterns work
   - Verify .gitignore filtering
   - Verify binary file detection

3. **tree-generator.test.ts**: Test tree generation
   - Test tree structure building
   - Test ASCII rendering
   - Test sorting

4. **parsers/*.test.ts**: Test each parser
   - Test with sample files for each language
   - Verify correct extraction of signatures
   - Verify error handling

### Integration Tests

Create `src/__tests__/integration.test.ts`:

1. **End-to-end test**: Full CLI invocation on test fixtures
2. **Cross-platform test**: Verify path handling
3. **Performance test**: Verify reasonable performance on 100+ files

### Test Fixtures

Create `src/__fixtures__/` with sample files:

```
__fixtures__/
├── typescript/
│   ├── sample.ts
│   ├── with-jsdoc.ts
│   └── react.tsx
├── javascript/
│   └── sample.js
├── vue/
│   ├── Simple.vue
│   └── WithScriptSetup.vue
├── python/
│   └── sample.py
├── kotlin/
│   └── Sample.kt
└── mixed-project/
    ├── src/
    ├── package.json
    └── .gitignore
```

### Edge Cases to Test

1. Empty project directory
2. Project with only unsupported files
3. Circular symlinks
4. Files with unicode names
5. Files with very long paths
6. Read-only output directory
7. Binary files disguised as text
8. Malformed source files (syntax errors)
9. Files with mixed line endings
10. Large files (near 1MB limit)

---

## Research Sources

[1] fast-glob npm package documentation
    https://www.npmjs.com/package/fast-glob
    - Fastest glob implementation in JavaScript
    - 18 dependencies, 503KB install size

[2] ignore npm package documentation
    https://www.npmjs.com/package/ignore
    - Used by ESLint, gitbook
    - Implements gitignore spec 2.22.1 exactly
    - 500+ unit tests

[3] @vue/compiler-sfc npm package documentation
    https://www.npmjs.com/package/@vue/compiler-sfc
    - Official Vue 3 SFC compiler
    - Extracts script blocks for parsing

[4] glob vs fast-glob vs globby comparison
    https://www.npmjs.com/package/glob
    - globby wraps fast-glob with extra features
    - fast-glob is fastest for simple use cases

---

## Notes for Developer

1. **TypeScript Compiler API**: We're using the built-in TypeScript compiler API which is already available as a dependency. This avoids adding @babel/parser.

2. **Vue Parsing**: @vue/compiler-sfc extracts script blocks, then we use the TypeScript parser on the script content. This handles both `<script>` and `<script setup>`.

3. **Python/Kotlin Parsing**: These use regex/heuristic approaches since there's no pure-JavaScript AST parser for these languages without native bindings. The focus is on extracting signatures and structure, not perfect parsing.

4. **Deterministic Output**: Files are sorted by relative path using `localeCompare` before processing and output generation.

5. **Error Resilience**: Each file is processed independently. Failures are logged in verbose mode but don't stop processing.

6. **Performance Considerations**:
   - Fast-glob is used for efficient file discovery
   - Files are processed sequentially (not in parallel) to avoid memory issues
   - Binary check happens before reading file contents
   - Files >1MB are skipped automatically

7. **Cross-Platform Paths**: Uses Node.js `path` module consistently. Fast-glob handles forward-slash normalization.
