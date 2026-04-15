# context-extractor Refactoring Plan

## Objective

Refactor the existing `tools/context-extractor` CLI tool to strictly match the `tool2_fix.md` specification. This is a **behavioral refactor** — the tech stack stays the same, but JSONL schema, CLI flags, extraction semantics, output format, and error messages must all be updated.

---

## Tech Stack Decision: KEEP EXISTING

| Component | Decision | Rationale |
|-----------|----------|-----------|
| **Node.js** | `>=22.0.0 <23.0.0` | Already aligned with workspace engines |
| **TypeScript** | Workspace catalog version | No change needed |
| **Package Manager** | pnpm (workspace) | No change needed |
| **Build Tool** | tsup | Already configured for ESM + shebang |
| **CLI Parser** | `commander ^14.0.3` | Minimal, industry-standard, already in use |
| **Testing** | `vitest` (workspace catalog) | Already configured |
| **Dependencies** | Keep minimal (only `commander`) | Spec explicitly requests Node.js built-ins for everything else |

**No new libraries are required.**

---

## Specification Changes Summary

| Area | Current Behavior | Required Behavior (per spec) |
|------|------------------|------------------------------|
| **CLI `--input`** | Optional, defaults to `targets.jsonl` | **Required**, no default |
| **CLI `--cwd`** | Does not exist; implicitly uses `dirname(input)` | New flag, defaults to `process.cwd()` |
| **JSONL key** | `filepath` | `file` |
| **`reasoning` key** | Ignored / stripped | Emit `<reasoning>[text]</reasoning>` inside `<file>` when present |
| **`start_line` only** | Treated as full-file extraction | Extract from `start_line` to EOF; XML tag has **only** `start_line` attribute |
| **Error: missing file** | `WARN: file not found: [filepath]` | `WARN: file not found: [file]` (uses `file` prop) |
| **Error: out-of-bounds** | `WARN: start_line [start] out of bounds for [filepath] ([total] lines)` | `WARN: start_line [start] out of bounds for [file] ([total] lines)` |
| **Error: malformed JSONL** | `WARN: invalid JSONL at line [n]: [raw line]` | Same (already correct) |
| **Summary** | `Done. [n] blocks written to [output]. [k] warnings.` | Same (already correct) |
| **Output indentation** | `<file>`, `</file>`, ` ``` ` are zero-indented | Must remain zero-indented; `<reasoning>` must also be zero-indented |
| **Blank lines between blocks** | Single blank line | Same (already correct) |
| **Trailing newline** | Ensure file ends with exactly one newline | Must be preserved |

---

## File-by-File Refactoring Guide

### 1. `src/types.ts`

**Changes:**
1. Rename `filepath` → `file` in `ExtractionTarget`.
2. Add optional `reasoning?: string` to `ExtractionTarget`.
3. `ExtractedBlock` should continue to carry the full `target` so `output-writer.ts` can access `reasoning`.
4. Add `reasoning?: string` to the type guard return type in `utils.ts` (or inline) — see `src/utils.ts` changes.

```typescript
export interface ExtractionTarget {
  file: string;
  start_line?: number;
  end_line?: number;
  reasoning?: string;
}
```

**Propagation requirement:** Any interface/type that references `filepath` (e.g., in tests, type guards) must be updated to `file`.

---

### 2. `src/cli.ts`

**Changes:**
1. Make `--input` **required with NO default value**.
   - Current: `.requiredOption('-i, --input <path>', '...', 'targets.jsonl')`
   - New: `.requiredOption('-i, --input <path>', 'Path to input JSONL file')` — omit the third argument.
2. Add `--cwd` option:
   - `.option('--cwd <path>', 'Base directory for resolving relative file paths', process.cwd())`
3. Resolve `cwd` via `resolve(options.cwd)`.
4. Update `CLIOptions` in `types.ts` to include `cwd: string`.

```typescript
export interface CLIOptions {
  input: string;
  output: string;
  cwd: string;
}
```

---

### 3. `src/index.ts`

**Changes:**
1. Remove `import { dirname } from 'path'` (no longer needed).
2. Use `options.cwd` instead of `dirname(options.input)`.
3. Pass `options.cwd` to `extractFromFile()`.

```typescript
const blocks: ExtractedBlock[] = [];
const cwd = options.cwd;
```

Everything else in the orchestration flow stays the same.

---

### 4. `src/utils.ts`

**Changes:**
1. Update `isValidExtractionTarget` to check `file` instead of `filepath`.
2. Allow `reasoning` to be present (it is ignored by validation, but must be a string if present).
3. The type-guard return type should reflect the new shape.

```typescript
export function isValidExtractionTarget(
  obj: unknown
): obj is { file: string; start_line?: number; end_line?: number; reasoning?: string } {
  if (typeof obj !== 'object' || obj === null) return false;
  const target = obj as Record<string, unknown>;

  if (typeof target.file !== 'string' || target.file.length === 0) return false;

  if (target.start_line !== undefined) {
    if (typeof target.start_line !== 'number' || !Number.isInteger(target.start_line) || target.start_line < 1) {
      return false;
    }
  }

  if (target.end_line !== undefined) {
    if (typeof target.end_line !== 'number' || !Number.isInteger(target.end_line) || target.end_line < 1) {
      return false;
    }
  }

  if (target.reasoning !== undefined && typeof target.reasoning !== 'string') {
    return false;
  }

  return true;
}
```

`getFileExtension` and `getLanguageForExtension` require **no changes**.

---

### 5. `src/jsonl-parser.ts`

**Changes:**
1. Rename `parsed.filepath` → `parsed.file` everywhere.
2. **Remove** the logic that clears partial ranges (the block that sets `startLine = undefined; endLine = undefined` when only one is present).
   - Per spec, `start_line` only is valid and means "extract to EOF".
3. Pass through `reasoning` if present.

```typescript
// AFTER parsing and validation:
targets.push({
  file: parsed.file,
  start_line: parsed.start_line,
  end_line: parsed.end_line,
  reasoning: parsed.reasoning,
});
```

**Note:** Do NOT validate that `end_line >= start_line`. The spec does not mention this as an error. The existing behavior of capping `end_line` silently and producing empty content if start > effective end is acceptable.

---

### 6. `src/file-extractor.ts`

**Changes:**
1. Rename all references to `target.filepath` → `target.file`.
2. **Handle `start_line` only extraction:**
   - Current logic: `if (target.start_line === undefined || target.end_line === undefined)` treats it as full-file.
   - New logic:
     - `if (target.start_line === undefined && target.end_line === undefined)` → full-file.
     - `else if (target.start_line !== undefined && target.end_line === undefined)` → extract from `start_line` to EOF. Set `effectiveStartLine = target.start_line`. Do NOT set `effectiveEndLine`.
     - `else` → both defined, existing range logic.
3. **Fix warning messages** to use `target.file` instead of `target.filepath`.
4. **Read file content robustly:** The current `readFileContent` function handles trailing newlines by calculating `totalLines` as `lines.length - 1` when content ends with `\n`. Keep this, but verify that `start_line`-only extraction works correctly with it.

**Important detail for start_line-only → EOF:**
- Use the existing `lines` array (split on `\n`).
- The total number of actual lines is the current `totalLines` calculation.
- Extract `lines.slice(start_line - 1)` and join with `\n`.
- Because `split('\n')` on a trailing-newline file creates an extra empty string at the end, joining `lines.slice(...)` will naturally produce the correct content (the extra empty element won't appear unless you slice to include it).

**Example:** File content `"a\nb\nc\n"` → `split('\n')` → `['a','b','c','']`. `totalLines = 3`. `start_line=2` → `slice(1)` → `['b','c','']`. Join → `"b\nc\n"`. This is correct: lines 2-3 with trailing newline preserved.

**Example:** File content `"a\nb\nc"` (no trailing newline) → `split('\n')` → `['a','b','c']`. `totalLines = 3`. `start_line=2` → `slice(1)` → `['b','c']`. Join → `"b\nc"`. Correct.

**Out-of-bounds check:** If `requestedStart > totalLines`, emit the warning and skip.

---

### 7. `src/output-writer.ts`

**Changes:**
1. Update `generateOpenTag` to:
   - Check `block.effectiveStartLine` and `block.effectiveEndLine`.
   - If **only** `effectiveStartLine` is set (and `effectiveEndLine` is undefined), output: `<file path="..." start_line="...">`
   - If both are set, output: `<file path="..." start_line="..." end_line="...">`
   - If neither, output: `<file path="...">`
2. Add `<reasoning>` tag generation **immediately after** the opening `<file>` tag when `block.target.reasoning` is present and non-empty.
   - `lines.push(`<reasoning>${escapeXml(block.target.reasoning)}</reasoning>`);`
3. Verify that **all** `<file>`, `</file>`, `<reasoning>`, and ` ``` ` lines have zero indentation.
4. **Content handling:** The current code strips a trailing empty string from `contentLines` if the content ends with a newline. This is **dangerous** because it can corrupt files where a blank line at the end is intentional.
   - **Fix:** Do NOT pop the trailing empty string. Instead, split the content by `\n` and push each element. Because the fence is ` ``` ` on its own line, the markdown will render correctly regardless.
   - Actually, let's think carefully. If `content = "a\nb\n"`, `split('\n')` → `["a", "b", ""]`. We want the output to be:
     ```
     ```ts
     a
     b
     
     ```
     ```
     Pushing the empty string gives us a blank line before the closing fence, which is correct because the original file had a trailing newline. So we should **not** pop the empty string.
   - If `content = "a\nb"`, `split('\n')` → `["a", "b"]`. Output has no blank line before fence. Correct.
   - **Action:** Remove the `contentLines.pop()` logic.

5. **Trailing newline of the overall output file:**
   - Current code does:
     ```ts
     if (lines.length > 0) lines.push('');
     writeFileSync(outputPath, lines.join('\n'), 'utf-8');
     ```
   - This ensures the file ends with `\n`. Keep this behavior.

```typescript
function generateBlockMarkdown(block: ExtractedBlock): string {
  const lines: string[] = [];

  lines.push(generateOpenTag(block));

  if (block.target.reasoning) {
    lines.push(`<reasoning>${escapeXml(block.target.reasoning)}</reasoning>`);
  }

  lines.push(`\`\`\`${block.extension}`);

  if (block.content.length > 0) {
    const contentLines = block.content.split('\n');
    for (const line of contentLines) {
      lines.push(line);
    }
  }

  lines.push('```');
  lines.push('</file>');

  return lines.join('\n');
}
```

---

## Test Updates Required

All tests must be updated to use `file` instead of `filepath` and to assert the new `start_line`-only and `reasoning` behaviors.

### `tests/unit/utils.test.ts`

- Update all `isValidExtractionTarget` calls: `filepath` → `file`.
- Add assertions for `reasoning` acceptance (string allowed, non-string rejected).

### `tests/unit/jsonl-parser.test.ts`

- Update all test data: `"filepath"` → `"file"`.
- **Remove** assertions that partial ranges (start_line only) get cleared to full-file.
- **Add** assertions that start_line-only targets are preserved with `start_line` set and `end_line` undefined.
- Add tests for parsing `reasoning` key (it should be preserved on the target object).

### `tests/unit/file-extractor.test.ts`

- Update all `ExtractionTarget` objects: `filepath` → `file`.
- **Add** `start_line`-only extraction tests:
  - Extracts from `start_line` to EOF.
  - `effectiveStartLine` is set; `effectiveEndLine` is **undefined**.
  - Out-of-bounds `start_line` on a `start_line`-only target produces the correct warning.
- Verify warnings use the `file` path (e.g., `file not found: test.ts`).
- Remove or update tests that expect `start_line`-only to be treated as full-file.

### `tests/unit/output-writer.test.ts`

- Update `createBlock` helper: `target: { file: 'test.ts' }`.
- **Add** tests for `<reasoning>` tag placement:
  - When `reasoning` is present, it appears immediately after `<file ...>` and before ` ``` `.
  - When absent, no `<reasoning>` tag appears.
- **Add** tests for `start_line`-only XML tag:
  - `effectiveStartLine: 45`, `effectiveEndLine: undefined` → tag contains `start_line="45"` but **no** `end_line`.
- Update complete output format assertions to match the exact string, including any reasoning tags.
- Verify trailing newline handling is exact.

### `tests/integration/context-extractor.test.ts`

- Update **all** JSONL test data: `"filepath"` → `"file"`.
- Since `--input` is now required with no default, any integration test that previously ran the CLI with no arguments must now either:
  - Provide `--input targets.jsonl`, OR
  - Expect the CLI to exit non-zero due to missing required argument.
- **Update** the test `"processes valid JSONL with default output path"`: it currently calls `runCLI()` with no args. It must now call `runCLI('--input targets.jsonl')`.
- **Update** partial range tests: `start_line`-only should now produce a tag with `start_line` and extract to EOF, **not** full-file.
- **Add** integration tests for `--cwd`:
  - Create a JSONL in one directory, target files in another, use `--cwd` to resolve correctly.
- **Add** integration test for `reasoning` output:
  - JSONL contains `reasoning`, verify it appears in the markdown output.
- **Update** the missing input file test: without `--input`, commander should exit with an error code and a usage message. The existing test (`--input nonexistent.jsonl`) should still result in a fatal error because `parseJsonlFile` throws when the input file doesn't exist.

---

## Acceptance Criteria

### AC-1: CLI Flags
- [ ] `--input` is required. Running without it causes commander to print an error and exit non-zero.
- [ ] `--input` accepts a path to a `.jsonl` file.
- [ ] `--output` defaults to `llm_target.md` when omitted.
- [ ] `--cwd` defaults to `process.cwd()` when omitted.
- [ ] `--cwd` is used as the base directory for resolving relative `file` paths from JSONL.

### AC-2: JSONL Parsing
- [ ] Each line is parsed as JSON.
- [ ] The `file` property is read (not `filepath`).
- [ ] `start_line` and `end_line` are optional positive integers.
- [ ] `start_line` without `end_line` is preserved as a valid target (extract to EOF).
- [ ] `reasoning` string is preserved on the target object when present.
- [ ] Extra keys are safely ignored.
- [ ] Empty/whitespace-only lines are skipped.
- [ ] Malformed JSON lines produce `WARN: invalid JSONL at line [n]: [raw line]` on stderr.

### AC-3: File Extraction
- [ ] Full-file extraction works when both `start_line` and `end_line` are absent.
- [ ] Range extraction works when both are present.
- [ ] `start_line`-only extracts from that line to EOF.
- [ ] Missing files produce `WARN: file not found: [file]` on stderr and are skipped.
- [ ] `start_line > total_lines` produces `WARN: start_line [start] out of bounds for [file] ([total] lines)` and is skipped.
- [ ] `end_line > total_lines` is silently capped to the last line.
- [ ] Processing continues after all warnings.

### AC-4: Output Format
- [ ] Each block is wrapped in `<file path="...">...</file>`.
- [ ] Range extractions include `start_line="..." end_line="..."` attributes.
- [ ] `start_line`-only extractions include **only** `start_line="..."` attribute.
- [ ] If `reasoning` is present, `<reasoning>[text]</reasoning>` appears immediately inside `<file>`, before the code fence.
- [ ] `<file>`, `</file>`, `<reasoning>`, and fenced code block backticks have **zero indentation**.
- [ ] Code fence language is the file extension without dot, or `text` if none.
- [ ] Original whitespace of extracted source code is preserved exactly.
- [ ] Consecutive blocks are separated by exactly one blank line.
- [ ] The output file ends with exactly one trailing newline.

### AC-5: Summary & Exit Behavior
- [ ] stdout prints `Done. [n] blocks written to [output]. [k] warnings.`
- [ ] Exit code is `0` on success (even with warnings).
- [ ] Exit code is non-zero on fatal errors (e.g., missing `--input` or unreadable input file).

### AC-6: Tests Pass
- [ ] All unit tests pass (`vitest run tests/unit`).
- [ ] All integration tests pass (`vitest run tests/integration`).
- [ ] `pnpm typecheck` passes with zero errors.

---

## Implementation Order (Recommended)

1. **Update types** (`src/types.ts`)
2. **Update CLI parser** (`src/cli.ts`)
3. **Update main entry point** (`src/index.ts`)
4. **Update utilities** (`src/utils.ts`)
5. **Update JSONL parser** (`src/jsonl-parser.ts`)
6. **Update file extractor** (`src/file-extractor.ts`)
7. **Update output writer** (`src/output-writer.ts`)
8. **Run typecheck** and fix any TypeScript errors
9. **Update unit tests** one by one, running them as you go
10. **Update integration tests**
11. **Full test suite run**

---

## Notes for Test Engineer

- The most error-prone areas are:
  1. **Trailing newline handling** in `output-writer.ts` and `file-extractor.ts`. Ensure `split('\n')` + `join('\n')` round-trips correctly for files with and without trailing newlines.
  2. **`start_line`-only extraction**. Make sure the XML tag has **only** `start_line`, not `end_line`, and that the content goes to EOF.
  3. **Commander required option behavior**. Without `--input`, the CLI should now exit with a usage error from commander itself.
  4. **All tests use old `filepath` key**. Every test fixture and assertion must be globally updated to `file`.
- No new dependencies need to be installed.
