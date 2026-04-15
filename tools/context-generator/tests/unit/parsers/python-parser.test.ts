import { describe, it, expect, vi, beforeEach } from 'vitest';
import { readFileSync } from 'fs';
import type { SourceFile } from '../../../src/types.js';

// Mock fs
vi.mock('fs', () => ({
  readFileSync: vi.fn(),
}));

describe('Python Parser', () => {
  const mockFile = (content: string, path: string = 'test.py'): SourceFile => ({
    absolutePath: `/project/${path}`,
    relativePath: path,
    extension: '.py',
    size: content.length,
  });

  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('AC-7: Import/From Extraction', () => {
    it('should extract import statements', async () => {
      const content = `
import os
import sys
import json
`;
      (readFileSync as any).mockReturnValue(content);

      const { parsePython } = await import('../../../src/parsers/python.js');
      const result = await parsePython(mockFile(content), false);

      expect(result.skeleton).toContain('import os');
      expect(result.skeleton).toContain('import sys');
      expect(result.skeleton).toContain('import json');
    });

    it('should extract from-import statements', async () => {
      const content = `
from typing import List, Dict, Optional
from datetime import datetime
from dataclasses import dataclass, field
`;
      (readFileSync as any).mockReturnValue(content);

      const { parsePython } = await import('../../../src/parsers/python.js');
      const result = await parsePython(mockFile(content), false);

      expect(result.skeleton).toContain('from typing import');
      expect(result.skeleton).toContain('from datetime import datetime');
      expect(result.skeleton).toContain('from dataclasses import dataclass, field');
    });

    it('should extract relative imports', async () => {
      const content = `
from . import module
from ..utils import helper
from .models import User
`;
      (readFileSync as any).mockReturnValue(content);

      const { parsePython } = await import('../../../src/parsers/python.js');
      const result = await parsePython(mockFile(content), false);

      expect(result.skeleton).toContain('from . import module');
      expect(result.skeleton).toContain('from ..utils import helper');
      expect(result.skeleton).toContain('from .models import User');
    });

    it('should extract aliased imports', async () => {
      const content = `
import numpy as np
import pandas as pd
from typing import List as ListType
`;
      (readFileSync as any).mockReturnValue(content);

      const { parsePython } = await import('../../../src/parsers/python.js');
      const result = await parsePython(mockFile(content), false);

      expect(result.skeleton).toContain('import numpy as np');
      expect(result.skeleton).toContain('import pandas as pd');
    });

    it('should extract star imports', async () => {
      const content = `
from module import *
from .utils import *
`;
      (readFileSync as any).mockReturnValue(content);

      const { parsePython } = await import('../../../src/parsers/python.js');
      const result = await parsePython(mockFile(content), false);

      expect(result.skeleton).toContain('from module import *');
    });
  });

  describe('AC-7: Docstring Extraction', () => {
    it('should extract module-level docstrings', async () => {
      const content = `
"""
Main application module.

This module contains the core application logic and entry points.
"""

import os
`;
      (readFileSync as any).mockReturnValue(content);

      const { parsePython } = await import('../../../src/parsers/python.js');
      const result = await parsePython(mockFile(content), false);

      expect(result.skeleton).toContain('"""');
      expect(result.skeleton).toContain('Main application module');
      expect(result.skeleton).toContain('core application logic');
    });

    it('should extract single-quoted docstrings', async () => {
      const content = `
'''
Module documentation with single quotes.
'''

import sys
`;
      (readFileSync as any).mockReturnValue(content);

      const { parsePython } = await import('../../../src/parsers/python.js');
      const result = await parsePython(mockFile(content), false);

      expect(result.skeleton).toContain("'''");
      expect(result.skeleton).toContain('Module documentation');
    });

    it('should extract single-line docstrings', async () => {
      const content = `
"""Short module docstring."""

import os
`;
      (readFileSync as any).mockReturnValue(content);

      const { parsePython } = await import('../../../src/parsers/python.js');
      const result = await parsePython(mockFile(content), false);

      expect(result.skeleton).toContain('"""Short module docstring."""');
    });

    it('should handle docstrings with special characters', async () => {
      const content = `
"""
Docstring with "quotes" and 'apostrophes'.
Also contains: colons, dashes, and @mentions.
"""

import os
`;
      (readFileSync as any).mockReturnValue(content);

      const { parsePython } = await import('../../../src/parsers/python.js');
      const result = await parsePython(mockFile(content), false);

      expect(result.skeleton).toContain('Docstring with');
      expect(result.skeleton).toContain('quotes');
    });
  });

  describe('AC-7: Function Signature Extraction', () => {
    it('should extract simple function signatures', async () => {
      const content = `
def greet(name):
    """Greet a person."""
    return f"Hello, {name}!"
`;
      (readFileSync as any).mockReturnValue(content);

      const { parsePython } = await import('../../../src/parsers/python.js');
      const result = await parsePython(mockFile(content), false);

      expect(result.skeleton).toContain('def greet(name):');
      expect(result.skeleton).not.toContain('return f"Hello');
    });

    it('should extract typed function signatures', async () => {
      const content = `
def calculate(a: int, b: int) -> int:
    """Calculate sum."""
    return a + b
`;
      (readFileSync as any).mockReturnValue(content);

      const { parsePython } = await import('../../../src/parsers/python.js');
      const result = await parsePython(mockFile(content), false);

      expect(result.skeleton).toContain('def calculate(a: int, b: int) -> int:');
    });

    it('should extract async function signatures', async () => {
      const content = `
async def fetch_data(url: str) -> dict:
    """Fetch data from URL."""
    async with aiohttp.ClientSession() as session:
        pass
`;
      (readFileSync as any).mockReturnValue(content);

      const { parsePython } = await import('../../../src/parsers/python.js');
      const result = await parsePython(mockFile(content), false);

      expect(result.skeleton).toContain('async def fetch_data(url: str) -> dict:');
    });

    it('should extract functions with default parameters', async () => {
      const content = `
def greet(name: str, greeting: str = "Hello") -> str:
    return f"{greeting}, {name}!"
`;
      (readFileSync as any).mockReturnValue(content);

      const { parsePython } = await import('../../../src/parsers/python.js');
      const result = await parsePython(mockFile(content), false);

      expect(result.skeleton).toContain('def greet(name: str, greeting: str = "Hello") -> str:');
    });

    it('should extract functions with *args and **kwargs', async () => {
      const content = `
def flexible(*args, **kwargs):
    pass

def typed(args: tuple, kwargs: dict):
    pass
`;
      (readFileSync as any).mockReturnValue(content);

      const { parsePython } = await import('../../../src/parsers/python.js');
      const result = await parsePython(mockFile(content), false);

      expect(result.skeleton).toContain('def flexible(*args, **kwargs):');
    });
  });

  describe('AC-7: Class Extraction', () => {
    it('should extract class definitions', async () => {
      const content = `
class User:
    """Represents a user."""
    
    def __init__(self, name: str):
        self.name = name
    
    def get_name(self) -> str:
        return self.name
`;
      (readFileSync as any).mockReturnValue(content);

      const { parsePython } = await import('../../../src/parsers/python.js');
      const result = await parsePython(mockFile(content), false);

      expect(result.skeleton).toContain('class User:');
      expect(result.skeleton).toContain('def __init__(self, name: str):');
      expect(result.skeleton).toContain('def get_name(self) -> str:');
    });

    it('should extract classes with inheritance', async () => {
      const content = `
class Admin(User):
    """Admin user class."""
    
    def has_permission(self, permission: str) -> bool:
        return True
`;
      (readFileSync as any).mockReturnValue(content);

      const { parsePython } = await import('../../../src/parsers/python.js');
      const result = await parsePython(mockFile(content), false);

      expect(result.skeleton).toContain('class Admin(User):');
    });

    it('should extract dataclasses', async () => {
      const content = `
from dataclasses import dataclass

@dataclass
class Config:
    """Application configuration."""
    name: str
    debug: bool = False
`;
      (readFileSync as any).mockReturnValue(content);

      const { parsePython } = await import('../../../src/parsers/python.js');
      const result = await parsePython(mockFile(content), false);

      expect(result.skeleton).toContain('@dataclass');
      expect(result.skeleton).toContain('class Config:');
      expect(result.skeleton).toContain('name: str');
      expect(result.skeleton).toContain('debug: bool = False');
    });

    it('should preserve method docstrings', async () => {
      const content = `
class Service:
    def process(self, data: dict) -> dict:
        """Process input data.
        
        Args:
            data: Input dictionary
            
        Returns:
            Processed dictionary
        """
        return data
`;
      (readFileSync as any).mockReturnValue(content);

      const { parsePython } = await import('../../../src/parsers/python.js');
      const result = await parsePython(mockFile(content), false);

      expect(result.skeleton).toContain('def process(self, data: dict) -> dict:');
      expect(result.skeleton).toContain('Process input data');
      expect(result.skeleton).toContain('Args:');
    });
  });

  describe('AC-7: Decorators', () => {
    it('should preserve decorators on functions', async () => {
      const content = `
@staticmethod
def helper():
    pass

@classmethod
@deprecated
def old_method(cls):
    pass
`;
      (readFileSync as any).mockReturnValue(content);

      const { parsePython } = await import('../../../src/parsers/python.js');
      const result = await parsePython(mockFile(content), false);

      expect(result.skeleton).toContain('@staticmethod');
      expect(result.skeleton).toContain('@classmethod');
      expect(result.skeleton).toContain('@deprecated');
    });

    it('should preserve decorators with arguments', async () => {
      const content = `
@app.route('/users')
def get_users():
    pass

@cache(timeout=3600)
def expensive_operation():
    pass
`;
      (readFileSync as any).mockReturnValue(content);

      const { parsePython } = await import('../../../src/parsers/python.js');
      const result = await parsePython(mockFile(content), false);

      expect(result.skeleton).toContain("@app.route('/users')");
      expect(result.skeleton).toContain('@cache(timeout=3600)');
    });

    it('should handle multiple decorators', async () => {
      const content = `
@auth_required
@rate_limit(100)
@log_calls
def sensitive_operation():
    pass
`;
      (readFileSync as any).mockReturnValue(content);

      const { parsePython } = await import('../../../src/parsers/python.js');
      const result = await parsePython(mockFile(content), false);

      expect(result.skeleton).toContain('@auth_required');
      expect(result.skeleton).toContain('@rate_limit(100)');
      expect(result.skeleton).toContain('@log_calls');
    });
  });

  describe('AC-7: Type-Annotated Global Variables', () => {
    it('should extract type-annotated variables', async () => {
      const content = `
name: str = "default"
count: int = 0
enabled: bool = True
`;
      (readFileSync as any).mockReturnValue(content);

      const { parsePython } = await import('../../../src/parsers/python.js');
      const result = await parsePython(mockFile(content), false);

      expect(result.skeleton).toContain('name: str = ...');
      expect(result.skeleton).toContain('count: int = ...');
      expect(result.skeleton).toContain('enabled: bool = ...');
    });

    it('should extract constant variables (ALL_CAPS)', async () => {
      const content = `
MAX_RETRIES: int = 3
DEFAULT_TIMEOUT: float = 30.0
API_VERSION: str = "v1"
`;
      (readFileSync as any).mockReturnValue(content);

      const { parsePython } = await import('../../../src/parsers/python.js');
      const result = await parsePython(mockFile(content), false);

      expect(result.skeleton).toContain('MAX_RETRIES');
      expect(result.skeleton).toContain('DEFAULT_TIMEOUT');
      expect(result.skeleton).toContain('API_VERSION');
    });

    it('should extract complex type annotations', async () => {
      const content = `
from typing import List, Dict, Optional

users: List[User] = []
config: Dict[str, Any] = {}
maybe_value: Optional[int] = None
`;
      (readFileSync as any).mockReturnValue(content);

      const { parsePython } = await import('../../../src/parsers/python.js');
      const result = await parsePython(mockFile(content), false);

      expect(result.skeleton).toContain('users: List[User]');
      expect(result.skeleton).toContain('config: Dict[str, Any]');
      expect(result.skeleton).toContain('maybe_value: Optional[int]');
    });
  });

  describe('Edge Cases', () => {
    it('should handle empty files', async () => {
      const content = '';
      (readFileSync as any).mockReturnValue(content);

      const { parsePython } = await import('../../../src/parsers/python.js');
      const result = await parsePython(mockFile(content), false);

      expect(result.skeleton).toBeDefined();
      expect(result.language).toBe('python');
    });

    it('should handle files with only comments', async () => {
      const content = `
# This is a comment
# Another comment
`;
      (readFileSync as any).mockReturnValue(content);

      const { parsePython } = await import('../../../src/parsers/python.js');
      const result = await parsePython(mockFile(content), false);

      expect(result.skeleton).toBeDefined();
    });

    it('should handle multiline function definitions', async () => {
      const content = `
def complex_function(
    param1: str,
    param2: int,
    param3: Optional[dict] = None
) -> Result:
    pass
`;
      (readFileSync as any).mockReturnValue(content);

      const { parsePython } = await import('../../../src/parsers/python.js');
      const result = await parsePython(mockFile(content), false);

      expect(result.skeleton).toContain('def complex_function(');
    });

    it('should set correct language identifier', async () => {
      const content = 'pass';
      (readFileSync as any).mockReturnValue(content);

      const { parsePython } = await import('../../../src/parsers/python.js');
      const result = await parsePython(mockFile(content), false);

      expect(result.language).toBe('python');
    });

    it('should include source file info', async () => {
      const content = 'pass';
      (readFileSync as any).mockReturnValue(content);
      const file = mockFile(content, 'module.py');

      const { parsePython } = await import('../../../src/parsers/python.js');
      const result = await parsePython(file, false);

      expect(result.sourceFile).toEqual(file);
    });
  });
});
