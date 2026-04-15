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
 * File context for structured parsing output
 */
export interface FileContext {
  /** File path */
  path: string;
  /** Language identifier */
  language: string;
  /** Extracted imports */
  imports: ImportInfo[];
  /** Extracted functions */
  functions: FunctionInfo[];
  /** Extracted classes */
  classes: ClassInfo[];
  /** Extracted types */
  types: TypeInfo[];
  /** Extracted exports */
  exports: string[];
  /** Extracted docstrings */
  docstrings: string[];
}

/**
 * Import information
 */
export interface ImportInfo {
  /** Source module */
  source: string;
  /** Imported names */
  names: string[];
  /** Whether default import */
  isDefault: boolean;
}

/**
 * Function information
 */
export interface FunctionInfo {
  /** Function name */
  name: string;
  /** Parameters string */
  params: string;
  /** Return type */
  returnType?: string;
  /** Whether async */
  isAsync: boolean;
}

/**
 * Class information
 */
export interface ClassInfo {
  /** Class name */
  name: string;
  /** Base class/extends */
  extends?: string;
  /** Implemented interfaces */
  implements: string[];
}

/**
 * Type information
 */
export interface TypeInfo {
  /** Type name */
  name: string;
  /** Type definition */
  definition: string;
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
