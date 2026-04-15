import type { TreeNode, SourceFile } from './types.js';

/**
 * Generate a tree structure from source files
 */
export function generateTree(files: SourceFile[]): TreeNode {
  const root: TreeNode = {
    name: '.',
    path: '.',
    isDirectory: true,
    children: [],
  };

  // First pass: collect which directories actually contain files
  const dirsWithFiles = new Set<string>();
  for (const file of files) {
    const parts = file.relativePath.split('/');
    let currentPath = '';
    for (let i = 0; i < parts.length - 1; i++) {
      currentPath = currentPath ? `${currentPath}/${parts[i]}` : parts[i];
      // Mark all parent directories
      dirsWithFiles.add(currentPath);
    }
  }

  for (const file of files) {
    const parts = file.relativePath.split('/');
    let current = root;
    let currentPath = '';

    for (let i = 0; i < parts.length; i++) {
      const part = parts[i];
      currentPath = currentPath ? `${currentPath}/${part}` : part;

      if (i === parts.length - 1) {
        // This is a file
        current.children!.push({
          name: part,
          path: file.relativePath,
          isDirectory: false,
        });
      } else {
        // This is a directory
        let child = current.children!.find(c => c.name === part && c.isDirectory);
        if (!child) {
          child = {
            name: part,
            path: currentPath,
            isDirectory: true,
            children: [],
          };
          current.children!.push(child);
        }
        current = child;
      }
    }
  }

  // Sort children: directories first, then files, both alphabetically
  sortTree(root);

  return root;
}

/**
 * Recursively sort tree nodes
 */
function sortTree(node: TreeNode): void {
  if (node.children) {
    node.children.sort((a, b) => {
      // Directories come before files
      if (a.isDirectory && !b.isDirectory) return -1;
      if (!a.isDirectory && b.isDirectory) return 1;
      // Alphabetical within same type
      return a.name.localeCompare(b.name);
    });

    for (const child of node.children) {
      sortTree(child);
    }
  }
}

/**
 * Render tree as ASCII string
 */
export function renderTree(node: TreeNode, prefix = '', isLast = true): string {
  let result = '';

  // Don't render root node itself, just its children
  if (node.name !== '.') {
    const connector = isLast ? '└── ' : '├── ';
    result += `${prefix}${connector}${node.name}\n`;
  }

  if (node.children && node.children.length > 0) {
    // Build the prefix for children
    let newPrefix: string;
    if (node.name === '.') {
      newPrefix = prefix;
    } else {
      // Use the box drawing character │ (U+2502) for vertical lines
      newPrefix = prefix + (isLast ? '    ' : '│   ');
    }

    for (let i = 0; i < node.children.length; i++) {
      const child = node.children[i];
      const childIsLast = i === node.children.length - 1;
      result += renderTree(child, newPrefix, childIsLast);
    }
  }

  return result;
}
