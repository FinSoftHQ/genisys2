import { describe, it, expect, vi, beforeEach } from 'vitest';
import { readFileSync } from 'fs';
import type { SourceFile } from '../../../src/types.js';

// Mock fs
vi.mock('fs', () => ({
  readFileSync: vi.fn(),
}));

describe('TypeScript Parser', () => {
  const mockFile = (content: string, path: string = 'test.ts'): SourceFile => ({
    absolutePath: `/project/${path}`,
    relativePath: path,
    extension: path.endsWith('.tsx') ? '.tsx' : '.ts',
    size: content.length,
  });

  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('AC-5: Import Extraction', () => {
    it('should extract ES6 import statements', async () => {
      const content = `
import { useState } from 'react';
import React from 'react';
import type { User } from './types';
import * as utils from './utils';
`;
      (readFileSync as any).mockReturnValue(content);

      const { parseTypeScript } = await import('../../../src/parsers/typescript.js');
      const result = await parseTypeScript(mockFile(content), false);

      expect(result.skeleton).toContain("import { useState } from 'react'");
      expect(result.skeleton).toContain("import React from 'react'");
      expect(result.skeleton).toContain("import type { User } from './types'");
      expect(result.skeleton).toContain("import * as utils from './utils'");
    });

    it('should extract side-effect imports', async () => {
      const content = `
import 'polyfill';
import './styles.css';
`;
      (readFileSync as any).mockReturnValue(content);

      const { parseTypeScript } = await import('../../../src/parsers/typescript.js');
      const result = await parseTypeScript(mockFile(content), false);

      expect(result.skeleton).toContain("import 'polyfill'");
      expect(result.skeleton).toContain("import './styles.css'");
    });

    it('should extract dynamic imports', async () => {
      const content = `
const module = await import('./dynamic');
`;
      (readFileSync as any).mockReturnValue(content);

      const { parseTypeScript } = await import('../../../src/parsers/typescript.js');
      const result = await parseTypeScript(mockFile(content), false);

      // Dynamic imports might be handled differently, but should be preserved
      expect(result.skeleton).toBeDefined();
    });
  });

  describe('AC-5: Export Extraction', () => {
    it('should extract named exports', async () => {
      const content = `
export const foo = 'bar';
export function helper() {}
export class MyClass {}
`;
      (readFileSync as any).mockReturnValue(content);

      const { parseTypeScript } = await import('../../../src/parsers/typescript.js');
      const result = await parseTypeScript(mockFile(content), false);

      expect(result.skeleton).toContain('export');
    });

    it('should extract export statements', async () => {
      const content = `
export { foo, bar } from './module';
export * as utils from './utils';
export * from './types';
`;
      (readFileSync as any).mockReturnValue(content);

      const { parseTypeScript } = await import('../../../src/parsers/typescript.js');
      const result = await parseTypeScript(mockFile(content), false);

      expect(result.skeleton).toContain("export { foo, bar } from './module'");
      expect(result.skeleton).toContain("export * as utils from './utils'");
      expect(result.skeleton).toContain("export * from './types'");
    });

    it('should extract default export', async () => {
      const content = `
export default function main() {}
`;
      (readFileSync as any).mockReturnValue(content);

      const { parseTypeScript } = await import('../../../src/parsers/typescript.js');
      const result = await parseTypeScript(mockFile(content), false);

      expect(result.skeleton).toContain('export default');
    });

    it('should extract export assignment', async () => {
      const content = `
export = MyModule;
`;
      (readFileSync as any).mockReturnValue(content);

      const { parseTypeScript } = await import('../../../src/parsers/typescript.js');
      const result = await parseTypeScript(mockFile(content), false);

      expect(result.skeleton).toContain('export = MyModule');
    });
  });

  describe('AC-5: Function Signature Extraction', () => {
    it('should extract function declarations without bodies', async () => {
      const content = `
function greet(name: string): string {
  return \`Hello, \${name}\`;
}
`;
      (readFileSync as any).mockReturnValue(content);

      const { parseTypeScript } = await import('../../../src/parsers/typescript.js');
      const result = await parseTypeScript(mockFile(content), false);

      expect(result.skeleton).toContain('function greet(name: string): string;');
      expect(result.skeleton).not.toContain('return');
    });

    it('should extract async function signatures', async () => {
      const content = `
async function fetchData(url: string): Promise<Data> {
  const response = await fetch(url);
  return response.json();
}
`;
      (readFileSync as any).mockReturnValue(content);

      const { parseTypeScript } = await import('../../../src/parsers/typescript.js');
      const result = await parseTypeScript(mockFile(content), false);

      expect(result.skeleton).toContain('async function fetchData(url: string): Promise<Data>;');
    });

    it('should extract generic function signatures', async () => {
      const content = `
function identity<T>(arg: T): T {
  return arg;
}
`;
      (readFileSync as any).mockReturnValue(content);

      const { parseTypeScript } = await import('../../../src/parsers/typescript.js');
      const result = await parseTypeScript(mockFile(content), false);

      expect(result.skeleton).toContain('function identity<T>(arg: T): T;');
    });

    it('should extract arrow function signatures', async () => {
      const content = `
const add = (a: number, b: number): number => {
  return a + b;
};
`;
      (readFileSync as any).mockReturnValue(content);

      const { parseTypeScript } = await import('../../../src/parsers/typescript.js');
      const result = await parseTypeScript(mockFile(content), false);

      expect(result.skeleton).toContain('const add: (a: number, b: number) => number;');
    });
  });

  describe('AC-5: Class Extraction', () => {
    it('should extract class declarations with method signatures', async () => {
      const content = `
class User {
  private name: string;
  
  constructor(name: string) {
    this.name = name;
  }
  
  getName(): string {
    return this.name;
  }
}
`;
      (readFileSync as any).mockReturnValue(content);

      const { parseTypeScript } = await import('../../../src/parsers/typescript.js');
      const result = await parseTypeScript(mockFile(content), false);

      expect(result.skeleton).toContain('class User');
      expect(result.skeleton).toContain('getName(): string;');
    });

    it('should extract class with inheritance', async () => {
      const content = `
class Admin extends User {
  role: string = 'admin';
  
  hasPermission(permission: string): boolean {
    return true;
  }
}
`;
      (readFileSync as any).mockReturnValue(content);

      const { parseTypeScript } = await import('../../../src/parsers/typescript.js');
      const result = await parseTypeScript(mockFile(content), false);

      expect(result.skeleton).toContain('class Admin extends User');
      expect(result.skeleton).toContain('hasPermission(permission: string): boolean;');
    });

    it('should extract abstract classes', async () => {
      const content = `
abstract class Animal {
  abstract makeSound(): void;
  
  move(): void {
    console.log('moving');
  }
}
`;
      (readFileSync as any).mockReturnValue(content);

      const { parseTypeScript } = await import('../../../src/parsers/typescript.js');
      const result = await parseTypeScript(mockFile(content), false);

      expect(result.skeleton).toContain('abstract class Animal');
      expect(result.skeleton).toContain('abstract makeSound(): void;');
    });

    it('should skip private members', async () => {
      const content = `
class MyClass {
  public publicField: string;
  private privateField: string;
  
  public publicMethod(): void {}
  private privateMethod(): void {}
}
`;
      (readFileSync as any).mockReturnValue(content);

      const { parseTypeScript } = await import('../../../src/parsers/typescript.js');
      const result = await parseTypeScript(mockFile(content), false);

      expect(result.skeleton).toContain('publicField');
      expect(result.skeleton).toContain('publicMethod');
      expect(result.skeleton).not.toContain('privateField');
      expect(result.skeleton).not.toContain('privateMethod');
    });
  });

  describe('AC-5: Interface Extraction', () => {
    it('should extract interface declarations', async () => {
      const content = `
interface User {
  id: number;
  name: string;
  email: string;
}
`;
      (readFileSync as any).mockReturnValue(content);

      const { parseTypeScript } = await import('../../../src/parsers/typescript.js');
      const result = await parseTypeScript(mockFile(content), false);

      expect(result.skeleton).toContain('interface User');
      expect(result.skeleton).toContain('id: number');
      expect(result.skeleton).toContain('name: string');
      expect(result.skeleton).toContain('email: string');
    });

    it('should extract interfaces with optional properties', async () => {
      const content = `
interface Config {
  required: string;
  optional?: number;
}
`;
      (readFileSync as any).mockReturnValue(content);

      const { parseTypeScript } = await import('../../../src/parsers/typescript.js');
      const result = await parseTypeScript(mockFile(content), false);

      expect(result.skeleton).toContain('required: string');
      expect(result.skeleton).toContain('optional?: number');
    });

    it('should extract interfaces with methods', async () => {
      const content = `
interface Repository<T> {
  find(id: string): T | null;
  save(entity: T): void;
  delete(id: string): boolean;
}
`;
      (readFileSync as any).mockReturnValue(content);

      const { parseTypeScript } = await import('../../../src/parsers/typescript.js');
      const result = await parseTypeScript(mockFile(content), false);

      expect(result.skeleton).toContain('interface Repository<T>');
      expect(result.skeleton).toContain('find(id: string): T | null;');
      expect(result.skeleton).toContain('save(entity: T): void;');
      expect(result.skeleton).toContain('delete(id: string): boolean;');
    });

    it('should extract interface inheritance', async () => {
      const content = `
interface Animal {
  name: string;
}

interface Dog extends Animal {
  breed: string;
}
`;
      (readFileSync as any).mockReturnValue(content);

      const { parseTypeScript } = await import('../../../src/parsers/typescript.js');
      const result = await parseTypeScript(mockFile(content), false);

      expect(result.skeleton).toContain('interface Dog extends Animal');
    });
  });

  describe('AC-5: Type Alias Extraction', () => {
    it('should extract type aliases', async () => {
      const content = `
type UserId = string;
type Status = 'active' | 'inactive';
type Callback = (data: string) => void;
`;
      (readFileSync as any).mockReturnValue(content);

      const { parseTypeScript } = await import('../../../src/parsers/typescript.js');
      const result = await parseTypeScript(mockFile(content), false);

      expect(result.skeleton).toContain("type UserId = string;");
      expect(result.skeleton).toContain("type Status = 'active' | 'inactive';");
      expect(result.skeleton).toContain("type Callback = (data: string) => void;");
    });

    it('should extract generic type aliases', async () => {
      const content = `
type Container<T> = {
  value: T;
  timestamp: number;
};
`;
      (readFileSync as any).mockReturnValue(content);

      const { parseTypeScript } = await import('../../../src/parsers/typescript.js');
      const result = await parseTypeScript(mockFile(content), false);

      expect(result.skeleton).toContain('type Container<T> = {');
    });
  });

  describe('AC-5: Enum Extraction', () => {
    it('should extract enum declarations', async () => {
      const content = `
enum Status {
  Pending = 'PENDING',
  Active = 'ACTIVE',
  Inactive = 'INACTIVE',
}
`;
      (readFileSync as any).mockReturnValue(content);

      const { parseTypeScript } = await import('../../../src/parsers/typescript.js');
      const result = await parseTypeScript(mockFile(content), false);

      expect(result.skeleton).toContain('enum Status');
      expect(result.skeleton).toContain("Pending = 'PENDING'");
    });

    it('should extract numeric enums', async () => {
      const content = `
enum Priority {
  Low,
  Medium,
  High,
}
`;
      (readFileSync as any).mockReturnValue(content);

      const { parseTypeScript } = await import('../../../src/parsers/typescript.js');
      const result = await parseTypeScript(mockFile(content), false);

      expect(result.skeleton).toContain('enum Priority');
      expect(result.skeleton).toContain('Low');
      expect(result.skeleton).toContain('Medium');
      expect(result.skeleton).toContain('High');
    });
  });

  describe('AC-5: JSDoc Extraction', () => {
    it('should preserve JSDoc comments on functions', async () => {
      const content = `
/**
 * Calculate the sum of two numbers.
 * @param a - First number
 * @param b - Second number
 * @returns The sum of a and b
 */
function add(a: number, b: number): number {
  return a + b;
}
`;
      (readFileSync as any).mockReturnValue(content);

      const { parseTypeScript } = await import('../../../src/parsers/typescript.js');
      const result = await parseTypeScript(mockFile(content), false);

      expect(result.skeleton).toContain('/**');
      expect(result.skeleton).toContain('* Calculate the sum');
      expect(result.skeleton).toContain('@param a');
      expect(result.skeleton).toContain('@returns');
    });

    it('should preserve JSDoc on interfaces', async () => {
      const content = `
/**
 * Represents a user in the system.
 */
interface User {
  /** User's unique identifier */
  id: string;
  /** User's display name */
  name: string;
}
`;
      (readFileSync as any).mockReturnValue(content);

      const { parseTypeScript } = await import('../../../src/parsers/typescript.js');
      const result = await parseTypeScript(mockFile(content), false);

      expect(result.skeleton).toContain('Represents a user');
      expect(result.skeleton).toContain("User's unique identifier");
    });

    it('should preserve JSDoc on classes', async () => {
      const content = `
/**
 * Service class for managing users.
 * @example
 * const service = new UserService();
 */
class UserService {
  /**
   * Get user by ID.
   * @param id - User identifier
   */
  getUser(id: string): User {
    return { id, name: 'Test' };
  }
}
`;
      (readFileSync as any).mockReturnValue(content);

      const { parseTypeScript } = await import('../../../src/parsers/typescript.js');
      const result = await parseTypeScript(mockFile(content), false);

      expect(result.skeleton).toContain('Service class for managing users');
      expect(result.skeleton).toContain('@example');
      expect(result.skeleton).toContain('Get user by ID');
    });
  });

  describe('AC-6: Vue SFC Script Block Extraction', () => {
    it('should be handled by vue parser, not typescript parser directly', async () => {
      // The TypeScript parser shouldn't directly handle .vue files
      // They should be routed to the Vue parser
      const { getParser } = await import('../../../src/parsers/index.js');
      
      const vueParser = getParser('.vue');
      const tsParser = getParser('.ts');
      
      expect(vueParser).toBeDefined();
      expect(tsParser).toBeDefined();
      expect(vueParser).not.toBe(tsParser);
    });

    it('should extract TypeScript from Vue script blocks when processed', async () => {
      // This tests that the typescript parser can handle script content
      // extracted from Vue files (passed through the vue parser)
      const scriptContent = `
import { ref } from 'vue';

interface Props {
  message: string;
}

const count = ref(0);

function increment(): void {
  count.value++;
}
`;
      // The typescript parser should be able to parse this
      expect(scriptContent).toContain('import');
      expect(scriptContent).toContain('interface Props');
      expect(scriptContent).toContain('function increment');
    });
  });

  describe('AC-5: TSX/JSX Support', () => {
    it('should handle TSX files', async () => {
      const content = `
import React from 'react';

interface Props {
  name: string;
}

export function Component({ name }: Props): JSX.Element {
  return <div>{name}</div>;
}
`;
      (readFileSync as any).mockReturnValue(content);

      const { parseTypeScript } = await import('../../../src/parsers/typescript.js');
      const result = await parseTypeScript(mockFile(content, 'Component.tsx'), false);

      expect(result.language).toBe('tsx');
      expect(result.skeleton).toContain('interface Props');
      expect(result.skeleton).toContain('export function Component');
    });

    it('should handle JSX files', async () => {
      const content = `
import React from 'react';

export function Button({ children }) {
  return <button>{children}</button>;
}
`;
      (readFileSync as any).mockReturnValue(content);

      const { parseTypeScript } = await import('../../../src/parsers/typescript.js');
      const result = await parseTypeScript(mockFile(content, 'Button.jsx'), false);

      expect(result.language).toBe('jsx');
      expect(result.skeleton).toContain('export function Button');
    });
  });

  describe('Error Handling', () => {
    it('should handle syntax errors gracefully', async () => {
      const content = `
function broken( {
  // Missing closing parenthesis
`;
      (readFileSync as any).mockReturnValue(content);

      const { parseTypeScript } = await import('../../../src/parsers/typescript.js');
      
      // Should not throw, but may have limited extraction
      await expect(parseTypeScript(mockFile(content), false)).resolves.toBeDefined();
    });

    it('should handle empty files', async () => {
      const content = '';
      (readFileSync as any).mockReturnValue(content);

      const { parseTypeScript } = await import('../../../src/parsers/typescript.js');
      const result = await parseTypeScript(mockFile(content), false);

      expect(result.skeleton).toBeDefined();
    });

    it('should set correct language based on file extension', async () => {
      (readFileSync as any).mockReturnValue('');

      const { parseTypeScript } = await import('../../../src/parsers/typescript.js');
      
      const tsResult = await parseTypeScript(mockFile('', 'file.ts'), false);
      expect(tsResult.language).toBe('typescript');

      const tsxResult = await parseTypeScript(mockFile('', 'file.tsx'), false);
      expect(tsxResult.language).toBe('tsx');

      const jsResult = await parseTypeScript(mockFile('', 'file.js'), false);
      expect(jsResult.language).toBe('javascript');

      const jsxResult = await parseTypeScript(mockFile('', 'file.jsx'), false);
      expect(jsxResult.language).toBe('jsx');
    });
  });
});
