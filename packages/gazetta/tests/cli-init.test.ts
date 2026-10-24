/**
 * The site.config.ts `gazetta init` writes declares `publicStorage` on
 * every target (design-public-storage.md Q6), so a new site keeps
 * history on its editing target and validates with no public-storage
 * issue.
 */
import { execSync } from 'node:child_process'
import { rm } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { createJiti } from 'jiti'
import { afterEach, describe, expect, it } from 'vitest'
import { isEditable, isPublicStorage, type TargetConfig } from '../src/types.js'
import { publicStorageConfig } from '../src/validation/validators/public-storage-config.js'
import { createContentRoot } from '../src/content-root.js'
import type { Site } from '../src/site-loader.js'
import { memoryStorage } from './_helpers/memory-storage.js'
import { tempDir } from './_helpers/temp.js'

const testDir = tempDir('cli-init-public-storage-' + Date.now())

afterEach(async () => {
  await rm(testDir, { recursive: true, force: true })
})

describe('gazetta init site.config.ts', () => {
  it('sets publicStorage on every target and validates clean', { timeout: 120000 }, async () => {
    execSync(`node ${resolve(import.meta.dirname, '../dist/cli/index.js')} init ${testDir}`, { stdio: 'pipe' })
    const jiti = createJiti(import.meta.url, {
      moduleCache: false,
      alias: { gazetta: resolve(import.meta.dirname, '../src/index.ts') },
    })
    const config = (await jiti.import(join(testDir, 'sites/main/site.config.ts'), { default: true })) as {
      targets: Record<string, TargetConfig>
    }
    const targets = Object.entries(config.targets)
    expect(targets.length).toBeGreaterThan(0)
    for (const [name, target] of targets) {
      expect(typeof target.publicStorage, name).toBe('boolean')
    }
    // The scaffolded editing target stays private and editable.
    expect(isPublicStorage(config.targets.local)).toBe(false)
    expect(isEditable(config.targets.local)).toBe(true)

    const storage = memoryStorage()
    const site = {
      manifest: { name: 'init', targets: config.targets },
      contentRoot: createContentRoot(storage, ''),
      storage,
    } as unknown as Site
    const issues = await publicStorageConfig.validate({
      stage: 'cli',
      site,
      contentRoot: site.contentRoot,
      storage,
      scope: { kind: 'cli' },
    })
    expect(issues).toEqual([])
  })
})
