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
