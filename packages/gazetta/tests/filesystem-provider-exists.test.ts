/**
 * filesystemStorage.exists() must distinguish "genuinely missing" from
 * "cannot tell": only ENOENT maps to false, any other failure (EACCES
 * from an unsearchable ancestor, IO errors) throws. Callers probing
 * absence - the history baseline scan, rm-ignore-missing - rely on
 * that to fail closed instead of losing real content (#1105 review).
 */
import { mkdtempSync, mkdirSync, writeFileSync, chmodSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { createFilesystemProvider } from '../src/providers/filesystem.js'

const base = mkdtempSync(join(tmpdir(), 'gaz-fs-exists-'))
mkdirSync(join(base, 'site/pages'), { recursive: true })
writeFileSync(join(base, 'site/pages/page.json'), 'home')
const canChmod = process.platform !== 'win32' && typeof process.getuid === 'function' && process.getuid() !== 0

describe('filesystemStorage.exists', () => {
  it('returns true for a present path and false for a genuinely missing one', async () => {
    const storage = createFilesystemProvider(base)
    expect(await storage.exists('site/pages')).toBe(true)
    expect(await storage.exists('site/pages/page.json')).toBe(true)
    expect(await storage.exists('site/nope')).toBe(false)
    expect(await storage.exists('missing/pages')).toBe(false)
  })

  it('returns false for paths that cannot exist (ENOTDIR, ENAMETOOLONG)', async () => {
    // Public-facing callers (asset serving) rely on these mapping to a
    // plain miss - a malformed URL path must not become a 500 (#1106).
    const storage = createFilesystemProvider(base)
    expect(await storage.exists('site/pages/page.json/child')).toBe(false)
    expect(await storage.exists(`site/${'x'.repeat(300)}`)).toBe(false)
  })

  it.skipIf(!canChmod)('throws - not false - when an ancestor is not searchable', async () => {
    chmodSync(join(base, 'site'), 0o000)
    try {
      const storage = createFilesystemProvider(base)
      await expect(storage.exists('site/pages')).rejects.toThrow(/EACCES/)
    } finally {
      chmodSync(join(base, 'site'), 0o755)
    }
  })
})
