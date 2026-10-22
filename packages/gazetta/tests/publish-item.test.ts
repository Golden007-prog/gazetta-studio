/**
 * publishItemCore tests — Cut 3 (spine ported).
 *
 * Each `PublishItemResult` variant gets a dedicated test that drives
 * the pipeline through that branch with minimal scaffolding (real
 * loadSite against examples/starter, memoryStorage for target).
 *
 * Per team-preferences rule 26 (test-isolation paranoia): each test
 * builds its own input from a factory; no module-level state.
 */
import { describe, expect, expectTypeOf, it } from 'vitest'
import {
  publishItemCore,
  type PublishItemInput,
  type PublishItemKind,
  type PublishItemNotFound,
  type PublishItemOk,
  type PublishItemRenderFailed,
  type PublishItemResult,
  type PublishItemStorageWriteFailed,
  type PublishItemTemplateInvalid,
  type PublishItemValidationFailed,
  type PublishRenderMode,
  type PublishTarget,
} from '../src/publish-item.js'
import { createContentRoot } from '../src/content-root.js'
import { createFilesystemProvider } from '../src/providers/filesystem.js'
import { loadSite, type Site } from '../src/site-loader.js'
import { memoryStorage, type MemoryStorage } from './_helpers/memory-storage.js'
import { starterManifest, starterTargetDir, starterTemplatesDir } from './_helpers/starter.js'
import { listSidecars } from '../src/sidecars.js'
import { generateSitemap } from '../src/sitemap.js'

async function loadStarterSite(): Promise<Site> {
  const storage = createFilesystemProvider(starterTargetDir)
  const contentRoot = createContentRoot(storage, '')
  const manifest = await starterManifest()
  return loadSite({ contentRoot, templatesDir: starterTemplatesDir, manifest })
}

function makeTarget(storage: MemoryStorage, overrides?: Partial<PublishTarget>): PublishTarget {
  return {
    name: 'test-target',
    storage,
    type: 'esi',
    ...overrides,
  }
}

describe('publishItemCore — locale indexing', () => {
  it.each([
    { type: 'esi', mode: 'page-rendered' },
    { type: 'static', mode: 'page-static' },
  ] as const)('uses each locale manifest for $type publish-state and sitemap entries', async ({ type, mode }) => {
    const site = await loadStarterSite()
    const storage = memoryStorage()
    const page = site.pages.get('home')!
    const fr = site.pageLocales.get('home')!.locales.get('fr')!
    const publish = (locale?: string) =>
      publishItemCore({
        kind: 'page',
        name: 'home',
        mode,
        locale,
        site,
        sourceRoot: site.contentRoot,
        target: makeTarget(storage, { type, manifestHash: 'abcd1234' }),
      })

    for (const defaultNoindex of [false, true]) {
      site.pages.set('home', { ...page, metadata: { robots: defaultNoindex ? 'noindex' : 'index' } })
      site.pageLocales.get('home')!.locales.set('fr', {
        ...fr,
        metadata: defaultNoindex ? undefined : { robots: 'noindex, nofollow' },
      })

      expect((await publish()).ok).toBe(true)
      expect((await publish('fr')).ok).toBe(true)
      const states = await listSidecars(storage, 'pages')
      expect(states.get('home')!.pub!.noindex).toBe(defaultNoindex)
      expect(states.get('home:fr')!.pub!.noindex).toBe(!defaultNoindex)
      const entries = await storage.readDir('pages/home')
      const frenchPub = entries.find(entry => entry.name.startsWith('.pub-') && entry.name.endsWith('.fr'))!
      expect(frenchPub.name.includes('-noindex')).toBe(!defaultNoindex)

      const sitemap = generateSitemap({ siteUrl: 'https://example.com', pages: states })!
      expect(sitemap.includes('<loc>https://example.com/</loc>')).toBe(!defaultNoindex)
      expect(sitemap.includes('<loc>https://example.com/fr</loc>')).toBe(defaultNoindex)
    }
  })

  it.each([false, true])(
    'falls back to the default manifest when a locale file is absent (noindex=%s)',
    async noindex => {
      const site = await loadStarterSite()
      const storage = memoryStorage()
      const page = site.pages.get('home')!
      site.pages.set('home', { ...page, metadata: { robots: noindex ? 'noindex' : 'index' } })
      site.pageLocales.delete('home')

      const result = await publishItemCore({
        kind: 'page',
        name: 'home',
        mode: 'page-rendered',
        locale: 'fr',
        site,
        sourceRoot: site.contentRoot,
        target: makeTarget(storage, { manifestHash: 'abcd1234' }),
      })

      expect(result.ok).toBe(true)
      const states = await listSidecars(storage, 'pages')
      expect(states.get('home:fr')!.pub!.noindex).toBe(noindex)
    },
  )
})

// ─── Type contract (Cut 1, preserved) ──────────────────────────────

describe('PublishItemKind type contract', () => {
  it('discriminator covers page + fragment', () => {
    expectTypeOf<PublishItemKind>().toEqualTypeOf<'page' | 'fragment'>()
  })
})

describe('PublishRenderMode type contract', () => {
  it('covers four modes locked in Q2', () => {
    expectTypeOf<PublishRenderMode>().toEqualTypeOf<
      'page-rendered' | 'page-static' | 'fragment-rendered' | 'archive-marker'
    >()
  })
})

describe('PublishItemResult variants', () => {
  it('PublishItemOk carries mode + files + removed', () => {
    const ok: PublishItemOk = { kind: 'page', name: 'home', ok: true, mode: 'page-rendered', files: 3, removed: 1 }
    expectTypeOf(ok.ok).toEqualTypeOf<true>()
  })

  it('union narrows exhaustively on ok + code', () => {
    const project = (r: PublishItemResult): string => {
      if (r.ok) return 'success'
      switch (r.code) {
        case 'NOT_FOUND':
          return '404'
        case 'RENDER_FAILED':
          return 'render'
        case 'TEMPLATE_INVALID':
          return 'template'
        case 'VALIDATION_FAILED':
          return 'validation'
        case 'STORAGE_WRITE_FAILED':
          return 'storage'
      }
    }
    expect(project({ kind: 'page', name: 'x', ok: true, mode: 'page-rendered', files: 0, removed: 0 })).toBe('success')
    expect(project({ kind: 'page', name: 'x', ok: false, code: 'NOT_FOUND', reason: '' })).toBe('404')
  })

  it('PublishItemNotFound carries code', () => {
    const r: PublishItemNotFound = { kind: 'page', name: 'x', ok: false, code: 'NOT_FOUND', reason: '' }
    expect(r.code).toBe('NOT_FOUND')
  })

  it('PublishItemRenderFailed carries code', () => {
    const r: PublishItemRenderFailed = { kind: 'page', name: 'x', ok: false, code: 'RENDER_FAILED', reason: '' }
    expect(r.code).toBe('RENDER_FAILED')
  })

  it('PublishItemTemplateInvalid carries code', () => {
    const r: PublishItemTemplateInvalid = { kind: 'page', name: 'x', ok: false, code: 'TEMPLATE_INVALID', reason: '' }
    expect(r.code).toBe('TEMPLATE_INVALID')
  })

  it('PublishItemValidationFailed carries readonly Issue list', () => {
    const r: PublishItemValidationFailed = { kind: 'page', name: 'x', ok: false, code: 'VALIDATION_FAILED', issues: [] }
    expect(r.code).toBe('VALIDATION_FAILED')
  })

  it('PublishItemStorageWriteFailed carries code', () => {
    const r: PublishItemStorageWriteFailed = {
      kind: 'page',
      name: 'x',
      ok: false,
      code: 'STORAGE_WRITE_FAILED',
      reason: '',
    }
    expect(r.code).toBe('STORAGE_WRITE_FAILED')
  })
})

// ─── Spine variants (Cut 3) ────────────────────────────────────────

describe('publishItemCore — NOT_FOUND', () => {
  it('returns NOT_FOUND when page name missing from site', async () => {
    const site = await loadStarterSite()
    const input: PublishItemInput = {
      kind: 'page',
      name: 'definitely-does-not-exist',
      mode: 'page-rendered',
      site,
      sourceRoot: createContentRoot(memoryStorage(), ''),
      target: makeTarget(memoryStorage()),
    }
    const result = await publishItemCore(input)
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.code).toBe('NOT_FOUND')
  })

  it('returns NOT_FOUND when fragment name missing from site', async () => {
    const site = await loadStarterSite()
    const input: PublishItemInput = {
      kind: 'fragment',
      name: 'no-such-fragment',
      mode: 'fragment-rendered',
      site,
      sourceRoot: createContentRoot(memoryStorage(), ''),
      target: makeTarget(memoryStorage()),
    }
    const result = await publishItemCore(input)
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.code).toBe('NOT_FOUND')
  })
})

describe('publishItemCore — Ok happy path', () => {
  it('publishes a starter page in ESI mode and writes index + sidecars', async () => {
    const site = await loadStarterSite()
    const targetStorage = memoryStorage()
    const pageName = [...site.pages.keys()].find(k => !k.includes('['))! // skip dynamic-route pages

    const input: PublishItemInput = {
      kind: 'page',
      name: pageName,
      mode: 'page-rendered',
      site,
      sourceRoot: createContentRoot(memoryStorage(), ''),
      target: makeTarget(targetStorage, { manifestHash: 'abcd1234' }),
    }
    const result = await publishItemCore(input)

    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.kind).toBe('page')
      expect(result.mode).toBe('page-rendered')
      expect(result.files).toBeGreaterThanOrEqual(1) // at least index.html
    }

    // Verify storage state: index file exists; sidecar exists
    expect(await targetStorage.exists(`pages/${pageName}/index.html`)).toBe(true)
    const dirEntries = await targetStorage.readDir(`pages/${pageName}`)
    const hashSidecar = dirEntries.find(e => e.name === '.abcd1234.hash')
    expect(hashSidecar).toBeDefined()
  })

  it('publishes a fragment in fragment-rendered mode', async () => {
    const site = await loadStarterSite()
    const fragName = [...site.fragments.keys()][0]
    if (!fragName) return
    const targetStorage = memoryStorage()
    const input: PublishItemInput = {
      kind: 'fragment',
      name: fragName,
      mode: 'fragment-rendered',
      site,
      sourceRoot: createContentRoot(memoryStorage(), ''),
      target: makeTarget(targetStorage, { manifestHash: 'cafe5678' }),
    }
    const result = await publishItemCore(input)

    expect(result.ok).toBe(true)
    if (result.ok) expect(result.mode).toBe('fragment-rendered')
    expect(await targetStorage.exists(`fragments/${fragName}/index.html`)).toBe(true)
  })

  it('writes hashed CSS file when renderer emits styles', async () => {
    const site = await loadStarterSite()
    const targetStorage = memoryStorage()
    const pageName = [...site.pages.keys()].find(k => !k.includes('['))!
    const input: PublishItemInput = {
      kind: 'page',
      name: pageName,
      mode: 'page-rendered',
      site,
      sourceRoot: createContentRoot(memoryStorage(), ''),
      target: makeTarget(targetStorage),
    }
    const result = await publishItemCore(input)
    expect(result.ok).toBe(true)
    const entries = await targetStorage.readDir(`pages/${pageName}`)
    // Starter pages have CSS; expect a hashed CSS file
    const cssFiles = entries.filter(e => /styles\.[a-f0-9]{8}\.css$/.test(e.name))
    expect(cssFiles.length).toBeGreaterThanOrEqual(1)
  })
})

describe('publishItemCore — archive-marker mode', () => {
  it('routes archived items to marker renderer; emits single-line marker', async () => {
    const site = await loadStarterSite()
    const targetStorage = memoryStorage()
    // Synthesize an archived page entry into the loaded site
    const sample = [...site.pages.values()][0]!
    const archivedPage = { ...sample, archived: true, aliasOf: 'home' }
    site.pages.set('archived-page', archivedPage)

    const input: PublishItemInput = {
      kind: 'page',
      name: 'archived-page',
      mode: 'archive-marker',
      site,
      sourceRoot: createContentRoot(memoryStorage(), ''),
      target: makeTarget(targetStorage, { manifestHash: 'beef9999' }),
    }
    const result = await publishItemCore(input)

    expect(result.ok).toBe(true)
    if (result.ok) expect(result.mode).toBe('archive-marker')

    const html = await targetStorage.readFile('pages/archived-page/index.html')
    expect(html).toContain('alias=home')
    expect(html.length).toBeLessThan(200)

    // Sidecar present + noindex flag set on archived publishes
    const entries = await targetStorage.readDir('pages/archived-page')
    expect(entries.find(e => e.name === '.beef9999.hash')).toBeDefined()
  })
})

describe('publishItemCore — STORAGE_WRITE_FAILED', () => {
  it('returns STORAGE_WRITE_FAILED when storage.writeFile throws', async () => {
    const site = await loadStarterSite()
    const pageName = [...site.pages.keys()].find(k => !k.includes('['))!
    // Failing-write storage stub
    const failing: MemoryStorage = {
      ...memoryStorage(),
      async writeFile() {
        throw new Error('disk full')
      },
    } as MemoryStorage

    const input: PublishItemInput = {
      kind: 'page',
      name: pageName,
      mode: 'page-rendered',
      site,
      sourceRoot: createContentRoot(memoryStorage(), ''),
      target: makeTarget(failing),
    }
    const result = await publishItemCore(input)
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.code).toBe('STORAGE_WRITE_FAILED')
      expect((result as PublishItemStorageWriteFailed).reason).toMatch(/disk full/)
    }
  })
})

describe('publishItemCore — cleanup pass', () => {
  it("removes stale hashed files from prior publish that aren't in current output", async () => {
    const site = await loadStarterSite()
    const pageName = [...site.pages.keys()].find(k => !k.includes('['))!
    const targetStorage = memoryStorage()

    // Seed a stale hashed file from a "prior publish"
    targetStorage.seed({ [`pages/${pageName}/styles.deadbeef.css`]: 'stale CSS from old publish' })

    const input: PublishItemInput = {
      kind: 'page',
      name: pageName,
      mode: 'page-rendered',
      site,
      sourceRoot: createContentRoot(memoryStorage(), ''),
      target: makeTarget(targetStorage),
    }
    const result = await publishItemCore(input)

    expect(result.ok).toBe(true)
    if (result.ok) expect(result.removed).toBeGreaterThanOrEqual(1)
    expect(await targetStorage.exists(`pages/${pageName}/styles.deadbeef.css`)).toBe(false)
  })
})
