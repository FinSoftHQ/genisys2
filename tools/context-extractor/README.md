# context-extractor

A CLI tool for extracting file contents based on JSONL specifications, generating LLM-friendly markdown output with XML metadata tags.

## Overview

`context-extractor` reads a JSONL (JSON Lines) file containing file extraction targets, extracts the specified content from each file, and outputs a markdown document with fenced code blocks wrapped in XML tags for metadata.

### Features

- **Full-file extraction** - Extract entire files
- **Line range extraction** - Extract specific line ranges from files
- **Start-line-only extraction** - Extract from a start line to end of file
- **Multiple file types** - Automatic extension detection for 30+ programming languages
- **Graceful error handling** - Continues processing after non-fatal errors
- **Preserves file order** - Maintains the order of targets from the JSONL input

## Installation

### Prerequisites

- Node.js >= 22.0.0 < 23.0.0

### Build from Source

```bash
# Install dependencies
pnpm install

# Build the project
pnpm build

# Or build a standalone binary
pnpm build:binary
```

### Local Development

```bash
# Run in development mode
pnpm dev

# Run tests
pnpm test

# Type check
pnpm typecheck
```

## Usage

### Basic Usage

```bash
# Specify input and output files
context-extractor --input targets.jsonl --output result.md

# Use short flags
context-extractor -i targets.jsonl -o result.md

# Use custom working directory for resolving relative paths
context-extractor --input targets.jsonl --cwd ./project
```

### CLI Options

| Option | Short | Description | Default |
|--------|-------|-------------|---------|
| `--input <path>` | `-i` | **Required.** Path to input JSONL file | — |
| `--output <path>` | `-o` | Path to output markdown file | `llm_target.md` |
| `--cwd <path>` | — | Working directory for resolving relative file paths | `process.cwd()` |
| `--help` | `-h` | Display help information | — |
| `--version` | `-V` | Display version number | — |

## Input Format

The input is a JSONL (JSON Lines) file where each line is a valid JSON object specifying a file to extract.

### JSONL Specification

Each line must be a JSON object with the following structure:

```json
{
  "file": "path/to/file.ts",
  "start_line": 10,
  "end_line": 25,
  "reasoning": "Why this extraction is needed"
}
```

### Fields

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `file` | string | Yes | Path to the file (relative to `--cwd` or absolute) |
| `start_line` | number | No | Start line (1-based, inclusive). Omit for full-file extraction. |
| `end_line` | number | No | End line (1-based, inclusive). Omit for start-line-only or full-file extraction. |
| `reasoning` | string | No | Optional reasoning text, emitted as a `<reasoning>` tag in the output. |

Extra keys in JSON objects are allowed and ignored.

### Full-File Extraction

To extract an entire file, omit both `start_line` and `end_line`:

```jsonl
{"file": "src/components/Button.vue"}
{"file": "src/utils/helpers.ts"}
{"file": "README.md"}
```

An `end_line`-only target (where `start_line` is omitted) is also treated as full-file extraction.

### Range Extraction

To extract specific line ranges, include both `start_line` and `end_line`:

```jsonl
{"file": "src/App.vue", "start_line": 45, "end_line": 60}
{"file": "src/main.ts", "start_line": 1, "end_line": 10}
```

### Start-Line-Only Extraction

To extract from a specific line to the end of the file, provide only `start_line`:

```jsonl
{"file": "src/utils/math.ts", "start_line": 112}
```

### Including Reasoning

If `reasoning` is provided, it is included in the output as a `<reasoning>` tag:

```jsonl
{"file": "src/App.vue", "start_line": 45, "end_line": 60, "reasoning": "Extract component template"}
```

### Complete Example

```jsonl
{"file": "src/components/Header.vue"}
{"file": "src/components/Header.vue", "start_line": 25, "end_line": 40}
{"file": "src/utils/api.ts", "reasoning": "Check API definitions"}
{"file": "tests/api.test.ts", "start_line": 1, "end_line": 50}
```

## Output Format

The output is a markdown file where each extracted file is wrapped in XML tags with a fenced code block. All XML tags and code fences are emitted with **zero indentation**.

### Full-File Output

```markdown
<file path="src/components/Button.vue">
```vue
<template>
  <button class="btn">Click me</button>
</template>

<script setup>
const props = defineProps(['label']);
</script>
```
</file>
```

### Range Extraction Output

```markdown
<file path="src/App.vue" start_line="45" end_line="60">
```vue
  <header>
    <nav>
      <router-link to="/">Home</router-link>
      <router-link to="/about">About</router-link>
    </nav>
  </header>
```
</file>
```

### Start-Line-Only Output

```markdown
<file path="src/utils/math.ts" start_line="112">
```ts
export function add(a: number, b: number): number {
  return a + b;
}
```
</file>
```

### Reasoning Tag Output

When `reasoning` is present, a `<reasoning>` tag appears immediately after the opening `<file>` tag:

```markdown
<file path="src/utils/api.ts">
<reasoning>Check API definitions</reasoning>
```ts
export const API_BASE = '/api/v1';
```
</file>
```

### Multiple Files

Files are separated by a single blank line:

```markdown
<file path="file1.ts">
```ts
export const a = 1;
```
</file>

<file path="file2.ts">
```ts
export const b = 2;
```
</file>
```

### Code Fence Languages

The tool uses the file extension (without the dot) as the language identifier on the code fence. For example:

| Extension | Fence | Extension | Fence |
|-----------|-------|-----------|-------|
| `.ts` | ` ```ts ` | `.vue` | ` ```vue ` |
| `.js` | ` ```js ` | `.py` | ` ```py ` |
| `.css` | ` ```css ` | `.md` | ` ```md ` |
| (no ext) | ` ```text ` | | |

## Error Handling

### Warning Messages

Warnings are printed to `stderr` in the format:

```
WARN: <message>
```

### Types of Warnings

#### Invalid JSONL

When a line cannot be parsed as valid JSON, or the JSON object fails validation:

```
WARN: invalid JSONL at line 3: {invalid json here}
```

A target fails validation when it is missing `file`, has an empty/non-string `file`, or has invalid `start_line`/`end_line`/`reasoning` values.

#### File Not Found

When a specified file does not exist:

```
WARN: file not found: src/missing.ts
```

#### Out of Bounds

When `start_line` exceeds the file's line count:

```
WARN: start_line 100 out of bounds for src/small.ts (5 lines)
```

Note: `end_line` is silently capped at the file length rather than producing a warning.

### Exit Codes

| Exit Code | Meaning |
|-----------|---------|
| `0` | Success (may include warnings) |
| `1` | Fatal error (e.g., missing `--input`, missing input file, unhandled exception) |

### Summary Output

After processing, a summary is printed to `stdout`:

```
Done. 3 blocks written to llm_target.md. 1 warnings.
```

## Examples

### Example 1: Extract Component and Utils

**Input (`targets.jsonl`):**
```jsonl
{"file": "src/components/UserProfile.vue"}
{"file": "src/utils/user.ts", "start_line": 1, "end_line": 25}
```

**Command:**
```bash
context-extractor -i targets.jsonl -o output.md
```

**Output (`output.md`):**
```markdown
<file path="src/components/UserProfile.vue">
```vue
<template>
  <div class="user-profile">
    <h1>{{ user.name }}</h1>
  </div>
</template>
```
</file>

<file path="src/utils/user.ts" start_line="1" end_line="25">
```ts
export interface User {
  id: string;
  name: string;
  email: string;
}

export function getUser(id: string): Promise<User> {
  return fetch(`/api/users/${id}`).then(r => r.json());
}
```
</file>
```

### Example 2: Handle Missing Files Gracefully

**Input (`targets.jsonl`):**
```jsonl
{"file": "src/exists.ts"}
{"file": "src/missing.ts"}
```

**Command:**
```bash
context-extractor --input targets.jsonl
```

**Output:**
```
WARN: file not found: src/missing.ts
Done. 1 blocks written to llm_target.md. 1 warnings.
```

### Example 3: Range Extraction with Capped End

**Input (`targets.jsonl`):**
```jsonl
{"file": "src/file.ts", "start_line": 10, "end_line": 999}
```

**Behavior:**
- If `src/file.ts` has 50 lines, extracts lines 10-50 (capped silently)
- No warning is produced

### Example 4: Mixed Valid and Invalid JSONL

**Input (`targets.jsonl`):**
```jsonl
{"file": "src/valid.ts"}
not valid json
{"file": "src/another.ts"}
{"missing": "file"}
```

**Output:**
```
WARN: invalid JSONL at line 2: not valid json
WARN: invalid JSONL at line 4: {"missing": "file"}
Done. 2 blocks written to llm_target.md. 2 warnings.
```

## File Structure

```
tools/context-extractor/
├── src/
│   ├── index.ts          # Main entry point
│   ├── cli.ts            # CLI argument parsing
│   ├── types.ts          # TypeScript type definitions
│   ├── utils.ts          # Utility functions (extension mapping, validation)
│   ├── jsonl-parser.ts   # JSONL file parsing
│   ├── file-extractor.ts # File content extraction
│   └── output-writer.ts  # Markdown output generation
├── tests/
│   ├── integration/      # Integration tests
│   └── unit/             # Unit tests
├── package.json
└── README.md
```

## Known Limitations

None.

## License

Private - Part of the @repo workspace.
