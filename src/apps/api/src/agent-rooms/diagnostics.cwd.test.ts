import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

describe('Diagnostics — Agent Working Directory', () => {
  it('should verify process.cwd() contains a package.json and the API package exists', () => {
    console.log('[DIAGNOSTICS] CWD:', process.cwd());

    const cwd = process.cwd();
    const rootPackageJson = path.join(cwd, 'package.json');
    const apiPackageJson = path.join(cwd, 'src', 'apps', 'api', 'package.json');

    expect(fs.existsSync(rootPackageJson)).toBe(true);
    expect(fs.existsSync(apiPackageJson)).toBe(true);
  });
});
