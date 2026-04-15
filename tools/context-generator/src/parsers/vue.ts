import { readFileSync } from 'fs';
import * as ts from 'typescript';
import type { SourceFile, ParsedFile } from '../types.js';

/**
 * Parse Vue Single File Components using regex extraction
 * Extracts script/setup blocks and parses with TypeScript
 */
export async function parseVue(
  file: SourceFile,
  _verbose: boolean
): Promise<ParsedFile> {
  const content = readFileSync(file.absolutePath, 'utf-8');
  
  // Extract script blocks using regex
  const { scriptContent, hasSetup, lang, hasTemplate, hasStyles } = extractScriptContent(content);
  
  if (!scriptContent) {
    return {
      sourceFile: file,
      language: 'vue',
      skeleton: '<!-- No script block found -->',
    };
  }

  // Parse script content with TypeScript
  const sourceFile = ts.createSourceFile(
    file.relativePath,
    scriptContent,
    ts.ScriptTarget.ESNext,
    true
  );

  const skeleton = extractVueScriptSkeleton(sourceFile, hasSetup, lang, hasTemplate, hasStyles);

  return {
    sourceFile: file,
    language: 'vue',
    skeleton,
  };
}

/**
 * Extract script content from Vue SFC using regex
 */
function extractScriptContent(content: string): { 
  scriptContent: string | null; 
  hasSetup: boolean; 
  lang: string;
  hasTemplate: boolean;
  hasStyles: boolean;
} {
  // Check for template
  const hasTemplate = /<template[\s>]/.test(content);
  
  // Check for styles
  const hasStyles = /<style[\s>]/.test(content);
  
  // Try to find <script setup> first
  const scriptSetupMatch = content.match(/<script\s+setup(?:\s+lang\s*=\s*["']([^"']*)["'])?[^>]*>([\s\S]*?)<\/script>/);
  if (scriptSetupMatch) {
    return {
      scriptContent: scriptSetupMatch[2].trim(),
      hasSetup: true,
      lang: scriptSetupMatch[1] || 'js',
      hasTemplate,
      hasStyles,
    };
  }
  
  // Try regular <script>
  const scriptMatch = content.match(/<script(?:\s+lang\s*=\s*["']([^"']*)["'])?[^>]*>([\s\S]*?)<\/script>/);
  if (scriptMatch) {
    return {
      scriptContent: scriptMatch[2].trim(),
      hasSetup: false,
      lang: scriptMatch[1] || 'js',
      hasTemplate,
      hasStyles,
    };
  }
  
  return {
    scriptContent: null,
    hasSetup: false,
    lang: 'js',
    hasTemplate,
    hasStyles,
  };
}

/**
 * Extract skeleton from Vue script content
 */
function extractVueScriptSkeleton(
  sourceFile: ts.SourceFile,
  hasSetup: boolean,
  lang: string,
  hasTemplate: boolean,
  hasStyles: boolean
): string {
  const lines: string[] = [];

  // Add template reference if exists
  if (hasTemplate) {
    lines.push('<!-- Template -->');
    lines.push('<template>...</template>');
    lines.push('');
  }

  // Add script block indicator
  const setup = hasSetup ? ' setup' : '';
  lines.push(`<script lang="${lang}"${setup}>`);

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
  if (hasStyles) {
    lines.push('');
    lines.push('<!-- Styles -->');
    lines.push('<style>...</style>');
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
