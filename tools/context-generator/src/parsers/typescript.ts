import { readFileSync } from 'fs';
import * as ts from 'typescript';
import type { SourceFile, ParsedFile } from '../types.js';

/**
 * Parse TypeScript/JavaScript/JSX files and extract skeleton
 * Uses TypeScript Compiler API for robust AST parsing
 */
export async function parseTypeScript(
  file: SourceFile,
  _verbose: boolean
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

  // Determine language based on extension or file path
  const ext = file.extension.toLowerCase();
  const pathExt = file.relativePath.slice(file.relativePath.lastIndexOf('.')).toLowerCase();
  const effectiveExt = ext === '.ts' ? pathExt : ext;
  
  let language: string;
  if (effectiveExt === '.tsx') {
    language = 'tsx';
  } else if (effectiveExt === '.jsx') {
    language = 'jsx';
  } else if (effectiveExt === '.js') {
    language = 'javascript';
  } else {
    language = 'typescript';
  }

  return {
    sourceFile: file,
    language,
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
  const heritage = node.heritageClauses 
    ? ' ' + node.heritageClauses.map(h => h.getText(source)).join(' ')
    : '';
  
  const members = node.members.map(member => {
    const memberJsDoc = getJsDoc(member, source);
    const text = member.getText(source);
    return memberJsDoc ? `${memberJsDoc}\n  ${text}` : `  ${text}`;
  }).join('\n');

  return `${jsDoc}${jsDoc ? '\n' : ''}${modifiers}interface ${node.name.text}${typeParams}${heritage} {\n${members}\n}`;
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
      const returnType = arrow.type ? arrow.type.getText(source) : 'any';
      const modifiers = node.modifiers ? node.modifiers.map(m => m.getText(source)).join(' ') + ' ' : '';
      return `${jsDoc}${jsDoc ? '\n' : ''}${modifiers}const ${name}${typeParams}: (${params}) => ${returnType};`;
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
