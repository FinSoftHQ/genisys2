/**
 * CLI argument options
 */
export interface CLIOptions {
  /** Path to input JSONL file */
  input: string;
  /** Path to output markdown file */
  output: string;
  /** Path to context markdown file (llm_context.md) */
  context: string;
  /** Working directory for resolving relative paths */
  cwd: string;
}

/**
 * Represents a single extraction target from JSONL
 */
export interface ExtractionTarget {
  /** Absolute or relative path to the file */
  file: string;
  /** Start line (1-based, inclusive). Undefined for full-file extraction */
  start_line?: number;
  /** End line (1-based, inclusive). Undefined for full-file extraction */
  end_line?: number;
  /** Optional reasoning for the extraction */
  reasoning?: string;
}

/**
 * Result of extracting content from a file
 */
export interface ExtractedBlock {
  /** Original target specification */
  target: ExtractionTarget;
  /** Resolved absolute filepath */
  absolutePath: string;
  /** File extension without dot (e.g., 'ts', 'vue') */
  extension: string;
  /** Language for code block */
  language: string;
  /** Extracted content (preserving original whitespace) */
  content: string;
  /** Start line used for extraction (for range extractions) */
  effectiveStartLine?: number;
  /** End line used for extraction (for range extractions) */
  effectiveEndLine?: number;
  /** Error message if extraction failed */
  error?: string;
}

/**
 * Processing statistics
 */
export interface ProcessingStats {
  /** Total entries read from JSONL */
  totalEntries: number;
  /** Number of blocks successfully written */
  blocksWritten: number;
  /** Number of warnings encountered */
  warnings: number;
}

/**
 * Warning information for error reporting
 */
export interface Warning {
  /** Line number in JSONL file (if applicable) */
  lineNumber?: number;
  /** Raw line content (for JSON parse errors) */
  rawLine?: string;
  /** Warning message */
  message: string;
}
