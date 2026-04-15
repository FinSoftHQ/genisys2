import { describe, it, expect } from 'vitest';
import { generateTree, renderTree } from '../../src/tree-generator.js';
import type { SourceFile, TreeNode } from '../../src/types.js';

describe('Tree Generator', () => {
  describe('AC-4: Directory Traversal', () => {
    it('should generate tree from empty file list', () => {
      const files: SourceFile[] = [];
      const tree = generateTree(files);

      expect(tree).toEqual({
        name: '.',
        path: '.',
        isDirectory: true,
        children: [],
      });
    });

    it('should generate tree with single file', () => {
      const files: SourceFile[] = [
        {
          absolutePath: '/project/index.ts',
          relativePath: 'index.ts',
          extension: '.ts',
          size: 100,
        },
      ];

      const tree = generateTree(files);

      expect(tree.children).toHaveLength(1);
      expect(tree.children![0]).toMatchObject({
        name: 'index.ts',
        path: 'index.ts',
        isDirectory: false,
      });
    });

    it('should generate tree with nested directories', () => {
      const files: SourceFile[] = [
        {
          absolutePath: '/project/src/index.ts',
          relativePath: 'src/index.ts',
          extension: '.ts',
          size: 100,
        },
        {
          absolutePath: '/project/src/utils/helpers.ts',
          relativePath: 'src/utils/helpers.ts',
          extension: '.ts',
          size: 200,
        },
      ];

      const tree = generateTree(files);

      expect(tree.children).toHaveLength(1);
      expect(tree.children![0].name).toBe('src');
      expect(tree.children![0].isDirectory).toBe(true);
      expect(tree.children![0].children).toHaveLength(1);
      expect(tree.children![0].children![0].name).toBe('index.ts');
    });

    it('should handle deeply nested directory structures', () => {
      const files: SourceFile[] = [
        {
          absolutePath: '/project/a/b/c/d/file.ts',
          relativePath: 'a/b/c/d/file.ts',
          extension: '.ts',
          size: 100,
        },
      ];

      const tree = generateTree(files);

      let current = tree;
      const expectedNames = ['a', 'b', 'c', 'd'];
      for (const name of expectedNames) {
        expect(current.children).toHaveLength(1);
        expect(current.children![0].name).toBe(name);
        expect(current.children![0].isDirectory).toBe(true);
        current = current.children![0];
      }
      expect(current.children![0].name).toBe('file.ts');
    });

    it('should handle multiple files in same directory', () => {
      const files: SourceFile[] = [
        {
          absolutePath: '/project/src/a.ts',
          relativePath: 'src/a.ts',
          extension: '.ts',
          size: 100,
        },
        {
          absolutePath: '/project/src/b.ts',
          relativePath: 'src/b.ts',
          extension: '.ts',
          size: 100,
        },
        {
          absolutePath: '/project/src/c.ts',
          relativePath: 'src/c.ts',
          extension: '.ts',
          size: 100,
        },
      ];

      const tree = generateTree(files);

      expect(tree.children![0].children).toHaveLength(3);
    });

    it('should handle files at root level and in subdirectories', () => {
      const files: SourceFile[] = [
        {
          absolutePath: '/project/package.json',
          relativePath: 'package.json',
          extension: '.json',
          size: 100,
        },
        {
          absolutePath: '/project/src/index.ts',
          relativePath: 'src/index.ts',
          extension: '.ts',
          size: 100,
        },
        {
          absolutePath: '/project/README.md',
          relativePath: 'README.md',
          extension: '.md',
          size: 100,
        },
      ];

      const tree = generateTree(files);

      expect(tree.children).toHaveLength(2); // src, plus root files
      const srcDir = tree.children!.find(c => c.name === 'src');
      expect(srcDir).toBeDefined();
      expect(tree.children!.filter(c => !c.isDirectory)).toHaveLength(2); // package.json, README.md
    });

    it('should merge directories with same name at same level', () => {
      const files: SourceFile[] = [
        {
          absolutePath: '/project/src/a/file1.ts',
          relativePath: 'src/a/file1.ts',
          extension: '.ts',
          size: 100,
        },
        {
          absolutePath: '/project/src/b/file2.ts',
          relativePath: 'src/b/file2.ts',
          extension: '.ts',
          size: 100,
        },
        {
          absolutePath: '/project/src/a/file3.ts',
          relativePath: 'src/a/file3.ts',
          extension: '.ts',
          size: 100,
        },
      ];

      const tree = generateTree(files);

      expect(tree.children).toHaveLength(1); // src
      expect(tree.children![0].children).toHaveLength(2); // a, b
      const dirA = tree.children![0].children!.find(c => c.name === 'a');
      expect(dirA!.children).toHaveLength(2); // file1.ts, file3.ts
    });
  });

  describe('AC-4: Deterministic Alphabetical Ordering', () => {
    it('should sort directories before files at same level', () => {
      const files: SourceFile[] = [
        {
          absolutePath: '/project/zebra.ts',
          relativePath: 'zebra.ts',
          extension: '.ts',
          size: 100,
        },
        {
          absolutePath: '/project/alpha/file.ts',
          relativePath: 'alpha/file.ts',
          extension: '.ts',
          size: 100,
        },
      ];

      const tree = generateTree(files);

      expect(tree.children![0].isDirectory).toBe(true);
      expect(tree.children![1].isDirectory).toBe(false);
    });

    it('should sort directories alphabetically', () => {
      const files: SourceFile[] = [
        {
          absolutePath: '/project/z/file.ts',
          relativePath: 'z/file.ts',
          extension: '.ts',
          size: 100,
        },
        {
          absolutePath: '/project/a/file.ts',
          relativePath: 'a/file.ts',
          extension: '.ts',
          size: 100,
        },
        {
          absolutePath: '/project/m/file.ts',
          relativePath: 'm/file.ts',
          extension: '.ts',
          size: 100,
        },
      ];

      const tree = generateTree(files);

      const names = tree.children!.map(c => c.name);
      expect(names).toEqual(['a', 'm', 'z']);
    });

    it('should sort files alphabetically within same directory', () => {
      const files: SourceFile[] = [
        {
          absolutePath: '/project/z.ts',
          relativePath: 'z.ts',
          extension: '.ts',
          size: 100,
        },
        {
          absolutePath: '/project/a.ts',
          relativePath: 'a.ts',
          extension: '.ts',
          size: 100,
        },
        {
          absolutePath: '/project/m.ts',
          relativePath: 'm.ts',
          extension: '.ts',
          size: 100,
        },
      ];

      const tree = generateTree(files);

      const names = tree.children!.map(c => c.name);
      expect(names).toEqual(['a.ts', 'm.ts', 'z.ts']);
    });

    it('should sort recursively in nested directories', () => {
      const files: SourceFile[] = [
        {
          absolutePath: '/project/src/z/util.ts',
          relativePath: 'src/z/util.ts',
          extension: '.ts',
          size: 100,
        },
        {
          absolutePath: '/project/src/a/util.ts',
          relativePath: 'src/a/util.ts',
          extension: '.ts',
          size: 100,
        },
        {
          absolutePath: '/project/src/m/util.ts',
          relativePath: 'src/m/util.ts',
          extension: '.ts',
          size: 100,
        },
      ];

      const tree = generateTree(files);

      const srcChildren = tree.children![0].children!;
      const names = srcChildren.map(c => c.name);
      expect(names).toEqual(['a', 'm', 'z']);
    });

    it('should produce deterministic output for same input', () => {
      const files: SourceFile[] = [
        {
          absolutePath: '/project/b.ts',
          relativePath: 'b.ts',
          extension: '.ts',
          size: 100,
        },
        {
          absolutePath: '/project/a.ts',
          relativePath: 'a.ts',
          extension: '.ts',
          size: 100,
        },
      ];

      const tree1 = generateTree(files);
      const tree2 = generateTree(files);

      expect(tree1).toEqual(tree2);
    });
  });

  describe('AC-4: Filtering Logic', () => {
    it('should include only supported file types', () => {
      const files: SourceFile[] = [
        {
          absolutePath: '/project/valid.ts',
          relativePath: 'valid.ts',
          extension: '.ts',
          size: 100,
        },
      ];

      const tree = generateTree(files);

      expect(tree.children).toHaveLength(1);
      expect(tree.children![0].name).toBe('valid.ts');
    });

    it('should handle mixed file extensions', () => {
      const files: SourceFile[] = [
        { absolutePath: '/project/a.ts', relativePath: 'a.ts', extension: '.ts', size: 100 },
        { absolutePath: '/project/b.tsx', relativePath: 'b.tsx', extension: '.tsx', size: 100 },
        { absolutePath: '/project/c.js', relativePath: 'c.js', extension: '.js', size: 100 },
        { absolutePath: '/project/d.jsx', relativePath: 'd.jsx', extension: '.jsx', size: 100 },
        { absolutePath: '/project/e.vue', relativePath: 'e.vue', extension: '.vue', size: 100 },
        { absolutePath: '/project/f.py', relativePath: 'f.py', extension: '.py', size: 100 },
        { absolutePath: '/project/g.kt', relativePath: 'g.kt', extension: '.kt', size: 100 },
        { absolutePath: '/project/h.kts', relativePath: 'h.kts', extension: '.kts', size: 100 },
      ];

      const tree = generateTree(files);

      expect(tree.children).toHaveLength(8);
      const names = tree.children!.map(c => c.name);
      expect(names).toEqual(['a.ts', 'b.tsx', 'c.js', 'd.jsx', 'e.vue', 'f.py', 'g.kt', 'h.kts']);
    });
  });

  describe('Tree Rendering', () => {
    it('should render empty tree', () => {
      const tree: TreeNode = {
        name: '.',
        path: '.',
        isDirectory: true,
        children: [],
      };

      const output = renderTree(tree);

      expect(output.trim()).toBe('');
    });

    it('should render single file', () => {
      const tree: TreeNode = {
        name: '.',
        path: '.',
        isDirectory: true,
        children: [
          { name: 'index.ts', path: 'index.ts', isDirectory: false },
        ],
      };

      const output = renderTree(tree);

      expect(output).toContain('index.ts');
      expect(output).toContain('└──');
    });

    it('should render multiple files with proper connectors', () => {
      const tree: TreeNode = {
        name: '.',
        path: '.',
        isDirectory: true,
        children: [
          { name: 'a.ts', path: 'a.ts', isDirectory: false },
          { name: 'b.ts', path: 'b.ts', isDirectory: false },
        ],
      };

      const output = renderTree(tree);

      expect(output).toContain('├── a.ts');
      expect(output).toContain('└── b.ts');
    });

    it('should render nested directories with proper indentation', () => {
      const tree: TreeNode = {
        name: '.',
        path: '.',
        isDirectory: true,
        children: [
          {
            name: 'src',
            path: 'src',
            isDirectory: true,
            children: [
              { name: 'index.ts', path: 'src/index.ts', isDirectory: false },
            ],
          },
        ],
      };

      const output = renderTree(tree);

      expect(output).toContain('src');
      expect(output).toContain('index.ts');
    });

    it('should render complete tree structure', () => {
      const tree: TreeNode = {
        name: '.',
        path: '.',
        isDirectory: true,
        children: [
          {
            name: 'src',
            path: 'src',
            isDirectory: true,
            children: [
              { name: 'a.ts', path: 'src/a.ts', isDirectory: false },
              { name: 'b.ts', path: 'src/b.ts', isDirectory: false },
            ],
          },
          { name: 'package.json', path: 'package.json', isDirectory: false },
        ],
      };

      const output = renderTree(tree);

      expect(output).toContain('src');
      expect(output).toContain('a.ts');
      expect(output).toContain('b.ts');
      expect(output).toContain('package.json');
    });

    it('should use correct ASCII tree characters', () => {
      const tree: TreeNode = {
        name: '.',
        path: '.',
        isDirectory: true,
        children: [
          {
            name: 'src',
            path: 'src',
            isDirectory: true,
            children: [
              { name: 'a.ts', path: 'src/a.ts', isDirectory: false },
              { name: 'b.ts', path: 'src/b.ts', isDirectory: false },
            ],
          },
        ],
      };

      const output = renderTree(tree);

      expect(output).toContain('├──'); // connector for non-last items
      expect(output).toContain('└──'); // connector for last items
      expect(output).toContain('│');   // vertical line
    });
  });
});
