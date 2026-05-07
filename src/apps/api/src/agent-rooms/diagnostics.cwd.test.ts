import { describe, it, expect } from 'vitest'
import fs from 'fs'
import path from 'path'

describe('Agent Working Directory Diagnostics', () => {
  it('should verify the current working directory and expected files', () => {
    console.log('[DIAGNOSTICS] CWD:', process.cwd())

    const cwdHasPackageJson = fs.existsSync(path.join(process.cwd(), 'package.json'))
    expect(cwdHasPackageJson).toBe(true)

    const apiPackageJsonPath = path.join(process.cwd(), 'src/apps/api/package.json')
    const apiPackageJsonExists = fs.existsSync(apiPackageJsonPath)
    expect(apiPackageJsonExists).toBe(true)
  })
})
