import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { readFileSync } from 'fs';
import ignore from 'ignore';

// Mock fs
vi.mock('fs', () => ({
  readFileSync: vi.fn(),
  statSync: vi.fn(),
  existsSync: vi.fn(),
}));

// Mock ignore module - use actual implementation
vi.mock('ignore', async (importOriginal) => {
  const actual = await importOriginal<typeof import('ignore')>();
  return {
    default: actual.default,
  };
});

describe('Gitignore Resolver', () => {
  const mockRoot = '/project';

  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('AC-3: Pattern Matching', () => {
    it('should load and parse .gitignore file', async () => {
      const gitignoreContent = 'node_modules/\ndist/\n*.log\n';
      (readFileSync as any).mockReturnValue(gitignoreContent);

      const { loadGitignore } = await import('../../src/file-discovery.js');
      const patterns = loadGitignore(mockRoot);

      expect(patterns).toContain('node_modules/');
      expect(patterns).toContain('dist/');
      expect(patterns).toContain('*.log');
    });

    it('should handle wildcard patterns', async () => {
      const gitignoreContent = '*.log\n*.tmp\n*.cache\n';
      (readFileSync as any).mockReturnValue(gitignoreContent);

      const { loadGitignore } = await import('../../src/file-discovery.js');
      const patterns = loadGitignore(mockRoot);

      const ig = ignore().add(patterns);
      expect(ig.ignores('debug.log')).toBe(true);
      expect(ig.ignores('temp.tmp')).toBe(true);
      expect(ig.ignores('app.cache')).toBe(true);
      expect(ig.ignores('app.ts')).toBe(false);
    });

    it('should handle directory patterns', async () => {
      const gitignoreContent = 'node_modules/\ndist/\nbuild/\n';
      (readFileSync as any).mockReturnValue(gitignoreContent);

      const { loadGitignore } = await import('../../src/file-discovery.js');
      const patterns = loadGitignore(mockRoot);

      const ig = ignore().add(patterns);
      expect(ig.ignores('node_modules/package.json')).toBe(true);
      expect(ig.ignores('dist/bundle.js')).toBe(true);
      expect(ig.ignores('src/index.ts')).toBe(false);
    });

    it('should handle globstar patterns', async () => {
      const gitignoreContent = '**/*.log\n**/node_modules/\n';
      (readFileSync as any).mockReturnValue(gitignoreContent);

      const { loadGitignore } = await import('../../src/file-discovery.js');
      const patterns = loadGitignore(mockRoot);

      const ig = ignore().add(patterns);
      expect(ig.ignores('debug.log')).toBe(true);
      expect(ig.ignores('src/utils/debug.log')).toBe(true);
      expect(ig.ignores('node_modules/lodash/package.json')).toBe(true);
    });

    it('should handle specific file patterns', async () => {
      const gitignoreContent = '.env\n.env.local\npackage-lock.json\n';
      (readFileSync as any).mockReturnValue(gitignoreContent);

      const { loadGitignore } = await import('../../src/file-discovery.js');
      const patterns = loadGitignore(mockRoot);

      const ig = ignore().add(patterns);
      expect(ig.ignores('.env')).toBe(true);
      expect(ig.ignores('.env.local')).toBe(true);
      expect(ig.ignores('package-lock.json')).toBe(true);
      expect(ig.ignores('.env.example')).toBe(false);
    });

    it('should ignore comment lines', async () => {
      const gitignoreContent = `# Dependencies\nnode_modules/\n# Build output\ndist/\n`;
      (readFileSync as any).mockReturnValue(gitignoreContent);

      const { loadGitignore } = await import('../../src/file-discovery.js');
      const patterns = loadGitignore(mockRoot);

      expect(patterns).not.toContain('# Dependencies');
      expect(patterns).not.toContain('# Build output');
      expect(patterns).toContain('node_modules/');
      expect(patterns).toContain('dist/');
    });

    it('should ignore empty lines', async () => {
      const gitignoreContent = `node_modules/\n\ndist/\n\n*.log\n`;
      (readFileSync as any).mockReturnValue(gitignoreContent);

      const { loadGitignore } = await import('../../src/file-discovery.js');
      const patterns = loadGitignore(mockRoot);

      expect(patterns).not.toContain('');
      expect(patterns).toHaveLength(3);
    });
  });

  describe('AC-3: Negation Patterns', () => {
    it('should handle negation patterns', async () => {
      const gitignoreContent = '*.log\n!important.log\n';
      (readFileSync as any).mockReturnValue(gitignoreContent);

      const { loadGitignore } = await import('../../src/file-discovery.js');
      const patterns = loadGitignore(mockRoot);

      const ig = ignore().add(patterns);
      expect(ig.ignores('debug.log')).toBe(true);
      expect(ig.ignores('error.log')).toBe(true);
      expect(ig.ignores('important.log')).toBe(false);
    });

    it('should handle directory negation with wildcards', async () => {
      const gitignoreContent = 'build/\n!build/.gitkeep\n';
      (readFileSync as any).mockReturnValue(gitignoreContent);

      const { loadGitignore } = await import('../../src/file-discovery.js');
      const patterns = loadGitignore(mockRoot);

      const ig = ignore().add(patterns);
      expect(ig.ignores('build/output.js')).toBe(true);
      expect(ig.ignores('build/.gitkeep')).toBe(false);
    });

    it('should handle multiple negation patterns', async () => {
      const gitignoreContent = `
*.log
!important.log
!important-debug.log
temp/
!temp/keep/
`;
      (readFileSync as any).mockReturnValue(gitignoreContent);

      const { loadGitignore } = await import('../../src/file-discovery.js');
      const patterns = loadGitignore(mockRoot);

      const ig = ignore().add(patterns);
      expect(ig.ignores('debug.log')).toBe(true);
      expect(ig.ignores('important.log')).toBe(false);
      expect(ig.ignores('important-debug.log')).toBe(false);
    });
  });

  describe('AC-3: Nested Gitignores', () => {
    it('should handle patterns from nested directories', async () => {
      // This tests that patterns are applied correctly to nested paths
      const gitignoreContent = '*.pyc\n__pycache__/\n';
      (readFileSync as any).mockReturnValue(gitignoreContent);

      const { loadGitignore } = await import('../../src/file-discovery.js');
      const patterns = loadGitignore(mockRoot);

      const ig = ignore().add(patterns);
      expect(ig.ignores('src/__pycache__/module.cpython-39.pyc')).toBe(true);
      expect(ig.ignores('tests/__pycache__/test_module.cpython-39.pyc')).toBe(true);
    });

    it('should handle root-only patterns', async () => {
      const gitignoreContent = '/node_modules/\n/dist/\n';
      (readFileSync as any).mockReturnValue(gitignoreContent);

      const { loadGitignore } = await import('../../src/file-discovery.js');
      const patterns = loadGitignore(mockRoot);

      const ig = ignore().add(patterns);
      // Root-only patterns should only match at root
      expect(ig.ignores('node_modules/package.json')).toBe(true);
      expect(ig.ignores('src/node_modules/package.json')).toBe(false);
    });

    it('should handle patterns without trailing slash for directories', async () => {
      const gitignoreContent = 'node_modules\n';
      (readFileSync as any).mockReturnValue(gitignoreContent);

      const { loadGitignore } = await import('../../src/file-discovery.js');
      const patterns = loadGitignore(mockRoot);

      const ig = ignore().add(patterns);
      expect(ig.ignores('node_modules')).toBe(true);
      expect(ig.ignores('node_modules/lodash/package.json')).toBe(true);
    });
  });

  describe('AC-3: Missing Gitignore', () => {
    it('should return empty array when .gitignore does not exist', async () => {
      (readFileSync as any).mockImplementation(() => {
        throw new Error('ENOENT: no such file or directory');
      });

      const { loadGitignore } = await import('../../src/file-discovery.js');
      const patterns = loadGitignore(mockRoot);

      expect(patterns).toEqual([]);
    });

    it('should not throw error when .gitignore is missing', async () => {
      (readFileSync as any).mockImplementation(() => {
        throw new Error('ENOENT');
      });

      const { loadGitignore } = await import('../../src/file-discovery.js');

      expect(() => loadGitignore(mockRoot)).not.toThrow();
    });
  });

  describe('AC-3: Complex Gitignore Scenarios', () => {
    it('should handle real-world .gitignore patterns', async () => {
      const gitignoreContent = `
# Logs
logs
*.log
npm-debug.log*

# Dependencies
node_modules/

# Build
dist/
build/
*.tsbuildinfo

# Environment
.env
.env.local
.env.*.local

# IDE
.vscode/
.idea/
*.swp
*.swo

# OS
.DS_Store
Thumbs.db

# Testing
coverage/
.nyc_output/
`;
      (readFileSync as any).mockReturnValue(gitignoreContent);

      const { loadGitignore } = await import('../../src/file-discovery.js');
      const patterns = loadGitignore(mockRoot);

      const ig = ignore().add(patterns);
      expect(ig.ignores('node_modules/lodash/index.js')).toBe(true);
      expect(ig.ignores('dist/bundle.js')).toBe(true);
      expect(ig.ignores('.env')).toBe(true);
      expect(ig.ignores('.DS_Store')).toBe(true);
      expect(ig.ignores('src/index.ts')).toBe(false);
    });

    it('should handle patterns with spaces', async () => {
      const gitignoreContent = 'my file.txt\nfolder with spaces/\n';
      (readFileSync as any).mockReturnValue(gitignoreContent);

      const { loadGitignore } = await import('../../src/file-discovery.js');
      const patterns = loadGitignore(mockRoot);

      const ig = ignore().add(patterns);
      expect(ig.ignores('my file.txt')).toBe(true);
      expect(ig.ignores('folder with spaces/file.txt')).toBe(true);
    });

    it('should handle brace expansion patterns', async () => {
      const gitignoreContent = '*.{log,tmp,cache}\n';
      (readFileSync as any).mockReturnValue(gitignoreContent);

      const { loadGitignore } = await import('../../src/file-discovery.js');
      const patterns = loadGitignore(mockRoot);

      // Note: Standard gitignore doesn't support brace expansion
      // This tests that we handle the pattern gracefully
      const ig = ignore().add(patterns);
      expect(ig.ignores('file.log')).toBe(true);
    });

    it('should handle character class patterns', async () => {
      const gitignoreContent = '*.[oa]\n*~\n';
      (readFileSync as any).mockReturnValue(gitignoreContent);

      const { loadGitignore } = await import('../../src/file-discovery.js');
      const patterns = loadGitignore(mockRoot);

      const ig = ignore().add(patterns);
      expect(ig.ignores('file.o')).toBe(true);
      expect(ig.ignores('file.a')).toBe(true);
      expect(ig.ignores('backup~')).toBe(true);
      expect(ig.ignores('file.ts')).toBe(false);
    });
  });

  describe('Integration with File Discovery', () => {
    it('should correctly filter files using gitignore patterns', async () => {
      const gitignoreContent = 'node_modules/\ndist/\n*.log\n';
      (readFileSync as any).mockReturnValue(gitignoreContent);

      const { loadGitignore } = await import('../../src/file-discovery.js');
      const patterns = loadGitignore(mockRoot);

      const ig = ignore().add(patterns);
      
      // Should ignore
      expect(ig.ignores('node_modules/lodash/index.js')).toBe(true);
      expect(ig.ignores('dist/app.js')).toBe(true);
      expect(ig.ignores('error.log')).toBe(true);
      
      // Should not ignore
      expect(ig.ignores('src/index.ts')).toBe(false);
      expect(ig.ignores('package.json')).toBe(false);
      expect(ig.ignores('README.md')).toBe(false);
    });
  });
});
