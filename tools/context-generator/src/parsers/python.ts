import { readFileSync } from 'fs';
import type { SourceFile, ParsedFile, FileContext, ImportInfo, FunctionInfo, ClassInfo } from '../types.js';

/**
 * Parse Python files using regex/heuristic extraction
 * Since there's no pure-JS Python AST parser without native bindings
 */
export async function parsePython(
  file: SourceFile,
  _verbose: boolean
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
      // Class variables with type annotations (for dataclasses, etc.)
      else if (trimmed.match(/^[a-zA-Z_][a-zA-Z0-9_]*\s*:/)) {
        // Match variable declarations like "name: str" or "debug: bool = False"
        const varMatch = trimmed.match(/^([a-zA-Z_][a-zA-Z0-9_]*\s*:\s*[^=#]+(?:\s*=\s*[^#]+)?)/);
        if (varMatch) {
          result.push('    ' + varMatch[1].trim());
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

/**
 * Parse Python file and return structured FileContext
 * This is used for testing purposes
 */
export function parsePythonToContext(content: string, filePath: string): FileContext {
  const imports: ImportInfo[] = [];
  const functions: FunctionInfo[] = [];
  const classes: ClassInfo[] = [];
  const docstrings: string[] = [];

  // Extract imports
  const importRegex = /^import\s+([\w.]+)(?:\s+as\s+(\w+))?/gm;
  const fromRegex = /^from\s+([\w.]+)\s+import\s+(.+)$/gm;

  let match;
  while ((match = importRegex.exec(content)) !== null) {
    imports.push({
      source: match[1],
      names: match[2] ? [match[2]] : [match[1]],
      isDefault: true,
    });
  }

  while ((match = fromRegex.exec(content)) !== null) {
    const names = match[2].split(',').map(n => n.trim().split(' as ')[0]);
    imports.push({
      source: match[1],
      names,
      isDefault: false,
    });
  }

  // Extract functions
  const funcRegex = /^(?:async\s+)?def\s+(\w+)\s*\(([^)]*)\)(?:\s*->\s*([^:]+))?:/gm;
  while ((match = funcRegex.exec(content)) !== null) {
    const isAsync = content.substring(match.index, match.index + 5) === 'async';
    functions.push({
      name: match[1],
      params: match[2].trim(),
      returnType: match[3]?.trim() || undefined,
      isAsync,
    });
  }

  // Extract classes
  const classRegex = /^class\s+(\w+)(?:\s*\(([^)]+)\))?:/gm;
  while ((match = classRegex.exec(content)) !== null) {
    const bases = match[2]?.split(',').map(b => b.trim()).filter(Boolean) || [];
    classes.push({
      name: match[1],
      extends: bases[0],
      implements: bases.slice(1),
    });
  }

  // Extract docstrings
  const docstringRegex = /^\s*(?:"""|''')([\s\S]*?)(?:"""|''')/gm;
  while ((match = docstringRegex.exec(content)) !== null) {
    docstrings.push(match[1].trim());
  }

  return {
    path: filePath,
    language: 'python',
    imports,
    functions,
    classes,
    types: [],
    exports: [],
    docstrings,
  };
}
