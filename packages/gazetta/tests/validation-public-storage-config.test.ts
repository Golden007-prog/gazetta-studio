/**
 * `public-storage-config` validator (design-public-storage.md Q6): config
 * that contradicts public storage is an error; a target assumed public
 * gets one info line. The starter, gazetta.studio and the target-matrix
 * fixture declare every target private and validate clean.
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
/** Cloud-like storage the validator can read: no `kind`, so it resolves public by default. */
const cloud = (entries: Record<string, string> = {}) => {
  const storage = memoryStorage()
  storage.seed(entries)
  return storage
}

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
    const issues = await run({ production: { storage: cloud(), publicStorage: true, history: { enabled: true } } })
    expect(issues).toHaveLength(1)
    expect(issues[0]).toMatchObject({ severity: 'error', itemPath: 'site.config.ts:targets.production' })
    expect(issues[0].message).toContain('history')
  })

  it('errors on a public target with editable: true explicitly', async () => {
    const issues = await run({ production: { storage: cloud(), editable: true } })
    const errors = issues.filter(i => i.severity === 'error')
    expect(errors.map(i => i.message)).toEqual([
      '`production` is editable, so its storage must be private (`publicStorage: false`).',
    ])
  })

  it('reports an info line, and no error, for a cloud target assumed public', async () => {
    const issues = await run({ production: { storage: cloud() } })
    expect(issues).toEqual([
      expect.objectContaining({
        severity: 'info',
        message:
          "`production`: storage assumed public, so history and audit aren't kept. Set `publicStorage: false` if visitors can't reach it.",
      }),
    ])
  })

  it('reports no info line for a target that declares publicStorage: true', async () => {
    expect(await run({ production: { storage: cloud(), publicStorage: true } })).toEqual([])
  })

  it.each<[string, TargetConfig]>([
    ['explicit publicStorage: false', { storage: r2(), publicStorage: false, history: { enabled: true } }],
    ['an explicitly editable filesystem target', { storage: filesystemStorage({ path: '/tmp/x' }), editable: true }],
  ])('reports nothing for %s', async (_label, target) => {
    expect(await run({ t: target })).toEqual([])
  })

  it.each<[Record<string, string>, string]>([
    [{ '.gazetta/history/revisions/r.json': '{}' }, 'history'],
    [{ '.gazetta/audit/a.json': '{}' }, 'audit'],
    [{ '.gazetta/review/x.json': '{}' }, 'review'],
    [{ '.gazetta/history/index.json': '[]', '.gazetta/audit/a.json': '{}' }, 'history and audit'],
  ])('errors on a public target whose storage still holds %j', async (entries, list) => {
    const issues = await run({ production: { storage: cloud(entries), publicStorage: true } })
    expect(issues).toEqual([
      expect.objectContaining({
        severity: 'error',
        itemPath: 'site.config.ts:targets.production',
        message: `\`production\` is public but still holds ${list}; run \`gazetta state remove production\`.`,
      }),
    ])
  })

  it('reports nothing for a public target holding only safe state', async () => {
    const storage = cloud({ '.gazetta/publish-generation': 'g', '.gazetta/fragment-deps/h/pages.home': '' })
    expect(await run({ production: { storage, publicStorage: true } })).toEqual([])
  })

  it("never reads a private target's storage", async () => {
    const storage = cloud({ '.gazetta/history/index.json': '[]' })
    const readDir = vi.spyOn(storage, 'readDir')
    expect(await run({ production: { storage, publicStorage: false } })).toEqual([])
    expect(readDir).not.toHaveBeenCalled()
  })

  it('reports an error instead of throwing when the storage cannot be read', async () => {
    const storage = cloud()
    vi.spyOn(storage, 'readDir').mockRejectedValue(new Error('EACCES'))
    vi.spyOn(storage, 'exists').mockResolvedValue(true)
    const issues = await run({ production: { storage, publicStorage: true } })
    expect(issues).toEqual([expect.objectContaining({ severity: 'error' })])
    expect(issues[0].message).toContain("Couldn't check `production`'s storage")
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
  ])('%s marks every target private explicitly and validates clean', { timeout: 60_000 }, async file => {
    vi.stubEnv('R2_ACCESS_KEY_ID', 'k')
    vi.stubEnv('R2_SECRET_ACCESS_KEY', 's')
    const jiti = createJiti(import.meta.url, {
      moduleCache: false,
      alias: { gazetta: resolve(import.meta.dirname, '../src/index.ts') },
    })
    const config = (await jiti.import(resolve(repoRoot, file), { default: true })) as {
      targets: Record<string, TargetConfig>
    }
    // gazetta.studio's production keeps its history only while this holds.
    for (const [name, target] of Object.entries(config.targets)) {
      expect(target.publicStorage, name).toBe(false)
    }
    expect(await run(config.targets)).toEqual([])
  })
})
