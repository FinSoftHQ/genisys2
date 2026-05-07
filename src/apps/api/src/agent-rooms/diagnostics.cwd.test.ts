import { describe, it, expect } from 'vitest'
import fs from 'fs'
import path from 'path'

describe('Agent Working Directory Diagnostics', () => {
  it('should verify process.cwd() contains package.json and src/apps/api/package.json exists', () => {
    console.log('[DIAGNOSTICS] CWD:', process.cwd())

    const cwdPackageJson = path.join(process.cwd(), 'package.json')
    expect(fs.existsSync(cwdPackageJson)).toBe(true)

    const apiPackageJson = path.join(process.cwd(), 'src/apps/api/package.json')
    expect(fs.existsSync(apiPackageJson)).toBe(true)
  })
})
