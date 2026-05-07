import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';

describe('Agent Working Directory Diagnostics', () => {
  it('should verify the current working directory contains expected paths', () => {
    console.log('[DIAGNOSTICS] CWD:', process.cwd());

    const cwd = process.cwd();

    expect(fs.existsSync(path.join(cwd, 'package.json'))).toBe(true);
    expect(fs.existsSync(path.join(cwd, 'src/apps/api/package.json'))).toBe(true);
  });
});
