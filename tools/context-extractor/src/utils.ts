import { extname } from 'path';

/**
 * Extract file extension without the dot
 * Returns 'text' if no extension exists
 */
export function getFileExtension(filepath: string): string {
  const ext = extname(filepath).toLowerCase();
  return ext ? ext.slice(1) : 'text';
}

/**
 * Map file extension to markdown code block language
 * Some extensions have special mappings (e.g., 'js' -> 'javascript')
 */
export function getLanguageForExtension(ext: string): string {
  const languageMap: Record<string, string> = {
    js: 'javascript',
    ts: 'typescript',
    jsx: 'jsx',
    tsx: 'tsx',
    py: 'python',
    rb: 'ruby',
    go: 'go',
    rs: 'rust',
    kt: 'kotlin',
    kts: 'kotlin',
    java: 'java',
    cs: 'csharp',
    cpp: 'cpp',
    c: 'c',
    h: 'c',
    hpp: 'cpp',
    vue: 'vue',
    svelte: 'svelte',
    astro: 'astro',
    css: 'css',
    scss: 'scss',
    sass: 'sass',
    less: 'less',
    html: 'html',
    xml: 'xml',
    json: 'json',
    yaml: 'yaml',
    yml: 'yaml',
    toml: 'toml',
    md: 'markdown',
    sh: 'bash',
    bash: 'bash',
    zsh: 'zsh',
    fish: 'fish',
    ps1: 'powershell',
    sql: 'sql',
    dockerfile: 'dockerfile',
    tf: 'hcl',
    hcl: 'hcl',
  };

  return languageMap[ext.toLowerCase()] || ext || 'text';
}

/**
 * Build a context prefix from llm_context.md content.
 * Returns everything up to and including the `## File Contents` heading.
 * If the heading is not found, returns the whole content with the heading appended.
 */
export function buildContextPrefix(contextContent: string): string {
  const lines = contextContent.split('\n');
  const headingIndex = lines.findIndex((line) => line.trim() === '## File Contents');

  if (headingIndex !== -1) {
    return lines.slice(0, headingIndex + 1).join('\n');
  }

  return contextContent.trimEnd() + '\n\n## File Contents';
}

/**
 * Validate if an object conforms to ExtractionTarget shape
 * Extra keys are allowed and ignored
 */
export function isValidExtractionTarget(
  obj: unknown
): obj is { file: string; start_line?: number; end_line?: number; reasoning?: string } {
  if (typeof obj !== 'object' || obj === null) {
    return false;
  }

  const target = obj as Record<string, unknown>;

  // file is required and must be a string
  if (typeof target.file !== 'string' || target.file.length === 0) {
    return false;
  }

  // start_line must be a positive integer if present
  if (target.start_line !== undefined) {
    if (typeof target.start_line !== 'number' || !Number.isInteger(target.start_line) || target.start_line < 1) {
      return false;
    }
  }

  // end_line must be a positive integer if present
  if (target.end_line !== undefined) {
    if (typeof target.end_line !== 'number' || !Number.isInteger(target.end_line) || target.end_line < 1) {
      return false;
    }
  }

  // reasoning must be a string if present
  if (target.reasoning !== undefined) {
    if (typeof target.reasoning !== 'string') {
      return false;
    }
  }

  return true;
}
