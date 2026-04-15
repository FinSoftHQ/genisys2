import { readFileSync } from 'fs';
import type { SourceFile, ParsedFile } from '../types.js';

/**
 * Parse Kotlin files using regex/heuristic extraction
 * Extracts: imports, package declarations, class/interface/object signatures,
 * function signatures, property declarations with types, annotations, KDoc
 */
export async function parseKotlin(
  file: SourceFile,
  _verbose: boolean
): Promise<ParsedFile> {
  const content = readFileSync(file.absolutePath, 'utf-8');
  const lines = content.split('\n');
  
  const skeletonLines: string[] = [];
  let i = 0;
  let inMultilineComment = false;
  let pendingKDoc: string[] = [];
  let pendingAnnotations: string[] = [];

  while (i < lines.length) {
    const line = lines[i];
    const trimmed = line.trim();

    // Handle multi-line KDoc comments /** ... */
    if (trimmed.startsWith('/**') && !trimmed.endsWith('*/')) {
      pendingKDoc = [line];
      inMultilineComment = true;
      i++;
      continue;
    }
    if (inMultilineComment && trimmed.startsWith('*')) {
      pendingKDoc.push(line);
      if (trimmed.endsWith('*/')) {
        inMultilineComment = false;
      }
      i++;
      continue;
    }
    if (inMultilineComment && trimmed.endsWith('*/')) {
      pendingKDoc.push(line);
      inMultilineComment = false;
      i++;
      continue;
    }

    // Skip empty lines and single-line comments (but not KDoc)
    if (!trimmed || (trimmed.startsWith('//') && !trimmed.startsWith('/**'))) {
      i++;
      continue;
    }

    // Single-line KDoc /** ... */
    if (trimmed.startsWith('/**') && trimmed.endsWith('*/')) {
      pendingKDoc = [line];
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
    // Handle multi-line annotations like @ApiOperation(...)
    if (trimmed.startsWith('@')) {
      // Check if annotation continues on next lines (ends with opening paren but not closing)
      if (trimmed.includes('(') && !trimmed.includes(')')) {
        let annotationLines = [line];
        let j = i + 1;
        while (j < lines.length) {
          const nextLine = lines[j];
          annotationLines.push(nextLine);
          if (nextLine.includes(')')) {
            break;
          }
          j++;
        }
        pendingAnnotations.push(annotationLines.join('\n'));
        i = j + 1;
      } else {
        pendingAnnotations.push(line);
        i++;
      }
      continue;
    }

    // Class/Object/Interface/Enum declaration (including sealed, abstract, data)
    const classMatch = trimmed.match(/^(?:(?:public|private|protected|internal|abstract|open|sealed|data|enum)\s+)*(?:class|interface|object|enum\s+class)\s+/);
    if (classMatch) {
      // Add pending KDoc and annotations
      if (pendingKDoc.length > 0) {
        skeletonLines.push(...pendingKDoc);
        pendingKDoc = [];
      }
      if (pendingAnnotations.length > 0) {
        skeletonLines.push(...pendingAnnotations);
        pendingAnnotations = [];
      }
      
      const classBlock = extractKotlinClass(lines, i);
      skeletonLines.push(classBlock);
      i += countKotlinBlockLines(lines, i);
      continue;
    }

    // Function declaration (including suspend, abstract, inline, operator, generic)
    const funcMatch = trimmed.match(/^(?:(?:public|private|protected|internal|abstract|open|override|inline|operator|external)\s+)*(?:suspend\s+)?(?:fun\s+)(?:<[^>]+>\s+)?/);
    if (funcMatch || trimmed.match(/^fun\s+<\w+>/)) {
      // Add pending KDoc and annotations
      if (pendingKDoc.length > 0) {
        skeletonLines.push(...pendingKDoc);
        pendingKDoc = [];
      }
      if (pendingAnnotations.length > 0) {
        skeletonLines.push(...pendingAnnotations);
        pendingAnnotations = [];
      }
      
      const funcSig = extractKotlinFunction(lines, i);
      skeletonLines.push(funcSig);
      i += countKotlinBlockLines(lines, i);
      continue;
    }

    // Property/variable declaration (val/var including abstract, lateinit, const)
    if (trimmed.match(/^(?:(?:public|private|protected|internal|abstract|open|override)\s+)*(?:lateinit\s+)?(?:const\s+)?(?:val|var)\s+/)) {
      // Add pending KDoc and annotations
      if (pendingKDoc.length > 0) {
        skeletonLines.push(...pendingKDoc);
        pendingKDoc = [];
      }
      if (pendingAnnotations.length > 0) {
        skeletonLines.push(...pendingAnnotations);
        pendingAnnotations = [];
      }
      
      const prop = extractKotlinProperty(trimmed);
      if (prop) {
        skeletonLines.push(prop);
      }
      i++;
      continue;
    }

    // Type alias
    if (trimmed.startsWith('typealias ')) {
      if (pendingAnnotations.length > 0) {
        skeletonLines.push(...pendingAnnotations);
        pendingAnnotations = [];
      }
      skeletonLines.push(trimmed);
      i++;
      continue;
    }

    // Clear pending annotations and KDoc if we hit an unrelated line
    if (trimmed && !trimmed.startsWith('//')) {
      pendingKDoc = [];
      pendingAnnotations = [];
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
  
  // Extract class signature with modifiers, type parameters, and inheritance
  const sigMatch = classLine.match(/^((?:(?:public|private|protected|internal|abstract|open|sealed|data|enum)\s+)*)((?:class|interface|object|enum\s+class))\s+(\w+)(\s*<[^>]+>)?(\s*:[^{]*)?/);
  
  if (!sigMatch) {
    return classLine;
  }

  const modifiers = sigMatch[1]?.trim() || '';
  const type = sigMatch[2].trim();
  const name = sigMatch[3];
  const generics = sigMatch[4] || '';
  const inheritance = sigMatch[5] || '';
  
  // Ensure space before colon in inheritance
  const formattedInheritance = inheritance ? inheritance.replace(/^\s*:\s*/, ' : ') : '';
  
  const result: string[] = [
    `${modifiers ? modifiers + ' ' : ''}${type} ${name}${generics}${formattedInheritance} {`
  ];

  // Find class body
  let i = startIdx + 1;
  const classIndent = getIndent(lines[startIdx]);
  const bodyIndent = classIndent + 4;
  
  let pendingKDoc: string[] = [];
  let pendingAnnotations: string[] = [];

  while (i < lines.length) {
    const line = lines[i];
    const trimmed = line.trim();
    const indent = getIndent(line);

    // End of class
    if (trimmed === '}' && indent === classIndent) {
      break;
    }

    // Skip empty lines
    if (!trimmed) {
      i++;
      continue;
    }

    // KDoc
    if (trimmed.startsWith('/**')) {
      if (trimmed.endsWith('*/')) {
        pendingKDoc = [trimmed];
      } else {
        pendingKDoc = [trimmed];
        i++;
        while (i < lines.length) {
          const kdocLine = lines[i];
          pendingKDoc.push(kdocLine);
          if (kdocLine.trim().endsWith('*/')) break;
          i++;
        }
      }
      i++;
      continue;
    }

    // Annotations
    if (trimmed.startsWith('@')) {
      pendingAnnotations.push(trimmed);
      i++;
      continue;
    }

    if (indent >= bodyIndent) {
      // Constructor
      if (trimmed.match(/^(constructor|init)\s*[({]/)) {
        const constructorSig = trimmed.match(/^(constructor[^{]+)/)?.[1] || 'constructor(...)';
        if (pendingKDoc.length > 0) {
          result.push('    ' + pendingKDoc.join('\n    '));
          pendingKDoc = [];
        }
        if (pendingAnnotations.length > 0) {
          result.push('    ' + pendingAnnotations.join('\n    '));
          pendingAnnotations = [];
        }
        result.push('    ' + constructorSig);
      }
      // Property (including abstract)
      else if (trimmed.match(/^(?:(?:abstract)\s+)?(?:val|var|lateinit\s+var|const\s+val)\s+/)) {
        const prop = extractKotlinProperty(trimmed);
        if (prop) {
          if (pendingKDoc.length > 0) {
            result.push('    ' + pendingKDoc.join('\n    '));
            pendingKDoc = [];
          }
          if (pendingAnnotations.length > 0) {
            result.push('    ' + pendingAnnotations.join('\n    '));
            pendingAnnotations = [];
          }
          result.push('    ' + prop);
        }
      }
      // Function (including abstract, suspend, inline, operator, generic)
      else if (trimmed.match(/^(?:(?:abstract|override|open|internal|public|protected|private|inline|operator|external)\s+)*(?:suspend\s+)?fun\s+/)) {
        const func = extractKotlinFunctionSignature(trimmed);
        if (pendingKDoc.length > 0) {
          result.push('    ' + pendingKDoc.join('\n    '));
          pendingKDoc = [];
        }
        if (pendingAnnotations.length > 0) {
          result.push('    ' + pendingAnnotations.join('\n    '));
          pendingAnnotations = [];
        }
        result.push('    ' + func);
      }
      // Nested class/object/companion object
      else if (trimmed.match(/^(?:companion\s+)?(?:class|interface|object)/)) {
        if (trimmed.startsWith('companion object')) {
          const companionMatch = trimmed.match(/^(companion object)(?:\s*\{.*\})?/);
          if (companionMatch) {
            result.push('    ' + companionMatch[1] + ' { ... }');
          }
        } else {
          const nested = trimmed.match(/^(?:(?:data|abstract|sealed)\s+)?(?:class|interface|object)\s+\w+(?:\s*<[^>]+>)?(?:\s*:[^{]+)?/)?.[0];
          if (nested) {
            result.push('    ' + nested + ' { ... }');
          }
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
  // Match function signature with all modifiers and generic parameters
  // This handles: abstract suspend fun <T> name(params): ReturnType
  //              inline fun <T> name(params): ReturnType
  //              operator fun plus(params): ReturnType
  //              fun String.extension(params): ReturnType
  //              fun <T> List<T>.extension(params): ReturnType
  
  // First, let's extract the parts step by step
  // Match modifiers (including inline, operator, etc.)
  const modifierMatch = line.match(/^((?:(?:public|private|protected|internal|abstract|open|override|inline|operator|external|suspend)\s+)*)/);
  if (!modifierMatch) return line;
  
  const modifiers = modifierMatch[1].trim();
  let remaining = line.slice(modifierMatch[0].length).trim();
  
  // Must start with 'fun'
  if (!remaining.startsWith('fun ')) return line;
  remaining = remaining.slice(4).trim();
  
  // Match generic parameters if present <T> or <T, R>
  let genericParams = '';
  const genericMatch = remaining.match(/^<[^>]+>/);
  if (genericMatch) {
    genericParams = genericMatch[1] || genericMatch[0];
    remaining = remaining.slice(genericMatch[0].length).trim();
  }
  
  // Now match the function name (including extension functions like String.add or List<T>.secondOrNull)
  // The name can include type parameters like List<T> for extension functions
  const nameMatch = remaining.match(/^([\w<>.]+)/);
  if (!nameMatch) return line;
  const name = nameMatch[1];
  remaining = remaining.slice(nameMatch[0].length).trim();
  
  // Match parameters - find matching parentheses
  if (!remaining.startsWith('(')) return line;
  let parenCount = 0;
  let paramsEnd = 0;
  for (let i = 0; i < remaining.length; i++) {
    if (remaining[i] === '(') parenCount++;
    if (remaining[i] === ')') parenCount--;
    if (parenCount === 0) {
      paramsEnd = i;
      break;
    }
  }
  const params = remaining.slice(1, paramsEnd);
  remaining = remaining.slice(paramsEnd + 1).trim();
  
  // Match return type if present
  let returnType = '';
  if (remaining.startsWith(':')) {
    remaining = remaining.slice(1).trim();
    // Take everything until { or = or end
    const returnTypeMatch = remaining.match(/^([^{=]+)/);
    if (returnTypeMatch) {
      returnType = returnTypeMatch[1].trim();
    }
  }
  
  // Check if abstract
  const isAbstract = modifiers.includes('abstract');
  const suffix = isAbstract ? '' : ' { ... }';
  
  // Format: fun <T> name(params): ReturnType { ... }
  const genericPart = genericParams ? `${genericParams} ` : '';
  const returnPart = returnType ? `: ${returnType}` : '';
  const modifiersPart = modifiers ? `${modifiers} ` : '';
  
  return `${modifiersPart}fun ${genericPart}${name}(${params})${returnPart}${suffix}`;
}

/**
 * Extract Kotlin property declaration
 */
function extractKotlinProperty(trimmed: string): string | null {
  // Match val/var with modifiers and type annotation
  // Handles: val name: Type, var name: Type, abstract val name: Type, lateinit var name: Type, const val name: Type
  const match = trimmed.match(/^(?:(abstract|lateinit|const)\s+)?(val|var)\s+(\w+)(\s*:\s*[^=]+)?/);
  
  if (match) {
    const modifier = match[1] || '';
    const kind = match[2];
    const name = match[3];
    const type = match[4] || '';
    const modifierPart = modifier ? modifier + ' ' : '';
    return `${modifierPart}${kind} ${name}${type}`.trim();
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
  const firstLine = lines[startIdx];
  const trimmedFirst = firstLine.trim();
  
  // For expression-bodied functions (fun x() = ...), just return 1
  // These don't have braces and are single-line definitions
  if (trimmedFirst.includes('=') && !trimmedFirst.includes('{')) {
    return 1;
  }
  
  let count = 1;
  let i = startIdx + 1;
  let braceCount = 0;

  // Check if starts with brace on same line
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
