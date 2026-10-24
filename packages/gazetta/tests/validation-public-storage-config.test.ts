/**
 * `public-storage-config` validator (design-public-storage.md Q6): config
 * that contradicts public storage is an error; a target assumed public
 * gets one info line. The starter, gazetta.studio and the target-matrix
 * fixture declare `publicStorage` and validate clean.
 */
import { resolve } from 'node:path'
import { createJiti } from 'jiti'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createContentRoot } from '../src/content-root.js'
import { filesystemStorage, r2Storage } from '../src/providers/factories.js'
import type { Site } from '../src/site-loader.js'
import type { StorageProvider, TargetConfig } from '../src/types.js'
import type { ValidatorInput } from '../src/validation/types.js'
import { defaultValidatorRegistry } from '../src/validation/default-registry.js'
import { logDefaultedPublicTargets, publicStorageConfig } from '../src/validation/validators/public-storage-config.js'
import { memoryStorage } from './_helpers/memory-storage.js'

const repoRoot = resolve(import.meta.dirname, '../../..')
const r2 = () => r2Storage({ accountId: 'a', bucket: 'b', accessKeyId: 'k', secretAccessKey: 's' })

function cliInput(targets: Record<string, TargetConfig>): ValidatorInput {
  const storage = memoryStorage()
  const site = {
    manifest: { name: 'test', targets },
    pages: new Map(),
    pageLocales: new Map(),
    fragments: new Map(),
    fragmentLocales: new Map(),
    contentRoot: createContentRoot(storage, ''),
    storage,
    siteDir: '',
    templatesDir: '',
  } as unknown as Site
  return {
    stage: 'cli',
    site,
    contentRoot: site.contentRoot,
    storage: storage as StorageProvider,
    scope: { kind: 'cli' },
  }
}

async function run(targets: Record<string, TargetConfig>) {
  return publicStorageConfig.validate(cliInput(targets))
}

afterEach(() => {
  vi.unstubAllEnvs()
})

describe('public-storage-config', () => {
  it('is registered for the cli stage', () => {
    expect(publicStorageConfig.stages).toEqual(['cli'])
    expect(defaultValidatorRegistry().forStage('cli')).toContain(publicStorageConfig)
  })

  it('errors on a public target with history enabled explicitly', async () => {
    const issues = await run({ production: { storage: r2(), publicStorage: true, history: { enabled: true } } })
    expect(issues).toHaveLength(1)
    expect(issues[0]).toMatchObject({ severity: 'error', itemPath: 'site.config.ts:targets.production' })
    expect(issues[0].message).toContain('history')
  })

  it('errors on a public target with editable: true explicitly', async () => {
    const issues = await run({ production: { storage: r2(), editable: true } })
    const errors = issues.filter(i => i.severity === 'error')
    expect(errors.map(i => i.message)).toEqual([
      '`production` is editable, so its storage must be private (`publicStorage: false`).',
    ])
  })

  it('reports an info line, and no error, for a cloud target assumed public', async () => {
    const issues = await run({ production: { storage: r2() } })
    expect(issues).toEqual([
      expect.objectContaining({
        severity: 'info',
        message:
          "`production`: storage assumed public, so history and audit aren't kept. Set `publicStorage: false` if visitors can't reach it.",
      }),
    ])
  })

  it('reports no info line for a target that declares publicStorage: true', async () => {
    expect(await run({ production: { storage: r2(), publicStorage: true } })).toEqual([])
  })

  it.each<[string, TargetConfig]>([
    ['explicit publicStorage: false', { storage: r2(), publicStorage: false, history: { enabled: true } }],
    ['an explicitly editable filesystem target', { storage: filesystemStorage({ path: '/tmp/x' }), editable: true }],
  ])('reports nothing for %s', async (_label, target) => {
    expect(await run({ t: target })).toEqual([])
  })

  it('logs the info line once per assumed-public target at admin boot', () => {
    const entries: Record<string, unknown>[] = []
    logDefaultedPublicTargets(
      {
        a: { storage: r2() },
        b: { storage: r2(), publicStorage: false },
        c: { storage: r2(), publicStorage: true },
      },
      e => entries.push(e),
    )
    expect(entries).toEqual([
      expect.objectContaining({ level: 'info', target: 'a', module: 'admin-api.public-storage' }),
    ])
    expect(entries[0].message).toContain('`a`: storage assumed public')
  })

  // Each row compiles the config and all of src/ through jiti (no module cache):
  // ~1s alone, over 11s on a loaded CI runner, so the default 5s is too tight.
  it.each([
    'examples/starter/sites/main/site.config.ts',
    'sites/gazetta.studio/site.config.ts',
    'tests/fixtures/sites/target-matrix/sites/main/site.config.ts',
  ])('%s sets publicStorage on every target and validates clean', { timeout: 60_000 }, async file => {
    vi.stubEnv('R2_ACCESS_KEY_ID', 'k')
    vi.stubEnv('R2_SECRET_ACCESS_KEY', 's')
    const jiti = createJiti(import.meta.url, {
      moduleCache: false,
      alias: { gazetta: resolve(import.meta.dirname, '../src/index.ts') },
    })
    const config = (await jiti.import(resolve(repoRoot, file), { default: true })) as {
      targets: Record<string, TargetConfig>
    }
    for (const [name, target] of Object.entries(config.targets)) {
      expect(typeof target.publicStorage, name).toBe('boolean')
    }
    expect(await run(config.targets)).toEqual([])
  })
})
