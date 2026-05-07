import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'

describe('Agent Working Directory Diagnostics', () => {
  it('should verify the current working directory contains expected files', () => {
    console.log('[DIAGNOSTICS] CWD:', process.cwd())

    const cwdHasPackageJson = fs.existsSync(path.join(process.cwd(), 'package.json'))
    expect(cwdHasPackageJson).toBe(true)

    const apiPackageJsonExists = fs.existsSync(
      path.join(process.cwd(), 'src/apps/api/package.json')
    )
    expect(apiPackageJsonExists).toBe(true)
  })
})
