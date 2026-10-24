/**
 * buildSourceContext's config errors. Targets default to public storage, and a
 * public target isn't editable (design-public-storage.md Q6), so a config
 * written before Q6, `local: { storage: filesystemStorage() }`, has no editable
 * target: the error names the cause and the fix, and the fix works.
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { buildSourceContext } from '../src/cli/bootstrap.js'
import { filesystemStorage } from '../src/providers/factories.js'
import { isPublicStorage, type SiteManifest, type TargetConfig } from '../src/types.js'

let dir: string
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'gazetta-bootstrap-'))
})
afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

const build = (targets: Record<string, TargetConfig>) =>
  buildSourceContext({ projectSiteDir: dir, manifest: { name: 'site', targets } as SiteManifest })
const localStorage = () => filesystemStorage({ path: join(dir, 'local') })
const fix = /local: \{ storage: filesystemStorage\(\), editable: true \}/

describe('buildSourceContext config errors', () => {
  it('names public storage as the cause and editable: true as the fix when no target is editable', async () => {
    await expect(build({ local: { storage: localStorage() } })).rejects.toThrow(/public storage, which isn't editable/)
    await expect(build({ local: { storage: localStorage() } })).rejects.toThrow(fix)
  })

  it('suggests the same editing target when no target is declared', async () => {
    await expect(build({})).rejects.toThrow(fix)
  })

  it('the suggested target is private and becomes the source', async () => {
    const local: TargetConfig = { storage: localStorage(), editable: true }
    expect(isPublicStorage(local)).toBe(false)
    const { source } = await build({ local })
    expect(source.targetName).toBe('local')
  })

  it('names a target without storage instead of failing with a TypeError', async () => {
    await expect(
      build({ local: { storage: localStorage(), editable: true }, production: {} as TargetConfig }),
    ).rejects.toThrow('Target "production"')
  })
})
