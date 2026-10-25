/**
 * publishToTarget tests - the shared target-publish function
 * (publish-undo cut 1, #1426).
 *
 * Locks the per-target step order both callers now share: the
 * approval-gate place (a documented no-op in this cut) precedes the
 * history record, which precedes the manifest copy, the render loop,
 * the generated files (written or DELETED, never skipped), the
 * publish generation and the CDN purge. Purge scope is the caller's
 * explicit option.
 */
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { publishToTarget, type PurgeOutcome } from '../src/publish-target.js'
import { createContentRoot } from '../src/content-root.js'
import { createFilesystemProvider } from '../src/providers/filesystem.js'
import { createHistoryProvider } from '../src/history-provider.js'
import { PUBLISH_GENERATION_PATH } from '../src/publish-generation.js'
import { loadSite, type Site } from '../src/site-loader.js'
import { scanTemplates, type TemplateInfo } from '../src/templates-scan.js'
import type { SiteManifest, StorageProvider, TargetConfig } from '../src/types.js'
import { memoryStorage, type MemoryStorage } from './_helpers/memory-storage.js'
import { starterManifest, starterProjectRoot, starterTargetDir, starterTemplatesDir } from './_helpers/starter.js'

const purgeCalls: string[] = []

vi.mock('../src/publish-rendered.js', async importOriginal => {
  const original = await importOriginal<typeof import('../src/publish-rendered.js')>()
  return {
    ...original,
    createCloudflarePurge: () => ({
      purgeAll: async () => {
        purgeCalls.push('purgeAll')
      },
      purgeUrls: async (urls: string[]) => {
        purgeCalls.push(`purgeUrls:${urls.length}`)
      },
    }),
  }
})

let forceEmptySitemap = false

vi.mock('../src/sitemap.js', async importOriginal => {
  const original = await importOriginal<typeof import('../src/sitemap.js')>()
  return {
    ...original,
    generateSitemap: (input: Parameters<typeof original.generateSitemap>[0]) =>
      forceEmptySitemap ? null : original.generateSitemap(input),
  }
})

function recordingStorage(inner: MemoryStorage, log: string[]): StorageProvider {
  const writeFileBound = inner.writeFile.bind(inner)
  return {
    ...inner,
    writeFile: async (path: string, content: string) => {
      log.push(`write:${path}`)
      return writeFileBound(path, content)
    },
  } as StorageProvider
}

const PURGE_CONFIG = { type: 'cloudflare' as const, apiToken: 'tok', zoneId: 'zone' }

describe('publishToTarget (#1426)', () => {
  let site: Site
  let manifest: SiteManifest
  let templateInfos: TemplateInfo[]
  let sourceRoot: ReturnType<typeof createContentRoot>
  let innerTarget: MemoryStorage
  let events: string[]
  let targetStorage: StorageProvider
  let tmp: string

  const stagingConfig = (extra?: Partial<TargetConfig>): TargetConfig =>
    ({
      type: 'esi' as const,
      environment: 'staging' as const,
      siteUrl: 'https://example.com',
      ...extra,
    }) as TargetConfig

  // A publishable content page: not dynamic, not a system page (system
  // pages never qualify for the sitemap).
  const pageName = () =>
    [...site.pages.keys()].find(k => !k.includes('[') && !(site.manifest.systemPages ?? []).includes(k))!

  const publish = (targetConfig: TargetConfig, purgeScope: 'all' | 'items' = 'all') =>
    publishToTarget({
      targetName: 'staging',
      targetStorage,
      targetConfig,
      sourceRoot,
      sourceName: 'local',
      site,
      siteManifest: manifest,
      items: [`pages/${pageName()}`],
      itemRefs: [{ kind: 'page', name: pageName() }],
      templateInfos,
      purgeScope,
    })

  beforeEach(async () => {
    purgeCalls.length = 0
    forceEmptySitemap = false
    events = []
    site = await loadSite({
      contentRoot: createContentRoot(createFilesystemProvider(starterTargetDir), ''),
      templatesDir: starterTemplatesDir,
      manifest: await starterManifest(),
    })
    manifest = await starterManifest()
    sourceRoot = createContentRoot(createFilesystemProvider(starterTargetDir), '')
    templateInfos = await scanTemplates(starterTemplatesDir, starterProjectRoot)
    tmp = await mkdtemp('.tmp-publish-target-')
    innerTarget = memoryStorage()
    targetStorage = recordingStorage(innerTarget, events)
  })

  afterEach(async () => {
    await rm(tmp, { recursive: true, force: true })
  })

  it('runs the locked step order: history record, manifest copy, generated files, generation, purge', async () => {
    const result = await publish(stagingConfig({ cache: { purge: PURGE_CONFIG } }))

    expect(result.run?.failed).not.toBe(true)
    // The gate's place precedes every write; the first observable write
    // is the history revision (baseline + publish), before the copy.
    const copyIndex = events.indexOf(`write:pages/${pageName()}/page.json`)
    const generationIndex = events.indexOf(`write:${PUBLISH_GENERATION_PATH}`)
    expect(copyIndex).toBeGreaterThan(0)
    expect(events[0]).toMatch(/^write:.*history/)
    expect(generationIndex).toBeGreaterThan(copyIndex)
    // Generation is written before the purge (#1125).
    expect(purgeCalls).toEqual(['purgeAll'])
    expect(result.purge).toEqual({ kind: 'purged-all' })
    // Exactly one publish revision.
    const history = createHistoryProvider({ storage: innerTarget })
    const revisions = await history.listRevisions()
    expect(revisions.filter(r => r.operation === 'publish')).toHaveLength(1)
  })

  it('writes sitemap.xml when there is content and deletes it when the sitemap would be empty', async () => {
    const first = await publish(stagingConfig())
    expect(first.generatedFiles).toContain('sitemap.xml')
    expect(await innerTarget.exists('sitemap.xml')).toBe(true)

    forceEmptySitemap = true
    const second = await publish(stagingConfig())
    expect(second.generatedFiles).not.toContain('sitemap.xml')
    expect(second.deletedFiles).toContain('sitemap.xml')
    expect(await innerTarget.exists('sitemap.xml')).toBe(false)
  })

  it('deletes a previously published sitemap.xml when the target has no site URL', async () => {
    // Spec acceptance: with no URL for the sitemap there is no sitemap
    // content, and generated files are written or deleted, never
    // skipped - the stale file does not stay live.
    await innerTarget.writeFile('sitemap.xml', 'old sitemap')
    const result = await publish(stagingConfig({ siteUrl: undefined }))
    expect(result.generatedFiles).not.toContain('sitemap.xml')
    expect(result.deletedFiles).toContain('sitemap.xml')
    expect(await innerTarget.exists('sitemap.xml')).toBe(false)
  })

  it('deletes a previously published redirects file when no redirect rows remain', async () => {
    await innerTarget.writeFile('_redirects', 'old rows')
    const result = await publish(stagingConfig({ redirects: { format: 'cloudflare' } } as Partial<TargetConfig>))
    // The starter site has no archived pages, so no rows remain.
    expect(result.generatedFiles).not.toContain('_redirects')
    expect(result.deletedFiles).toContain('_redirects')
    expect(await innerTarget.exists('_redirects')).toBe(false)
  })

  it('writes the publish generation whether or not a purge is configured', async () => {
    const result = await publish(stagingConfig())
    expect(result.purge).toEqual({ kind: 'none' })
    expect(purgeCalls).toEqual([])
    expect(await innerTarget.exists(PUBLISH_GENERATION_PATH)).toBe(true)
  })

  it("purgeScope 'items' purges only the published pages' URLs", async () => {
    // The starter's about page has a French version: the purge covers
    // the published page's URLs including its locale variants, and no
    // other page's.
    const result = await publishToTarget({
      targetName: 'staging',
      targetStorage,
      targetConfig: stagingConfig({ cache: { purge: PURGE_CONFIG } }),
      sourceRoot,
      sourceName: 'local',
      site,
      siteManifest: manifest,
      items: ['pages/about'],
      itemRefs: [
        { kind: 'page', name: 'about' },
        { kind: 'page', name: 'about', locale: 'fr' },
      ],
      templateInfos,
      purgeScope: 'items',
    })
    expect(purgeCalls).toEqual(['purgeUrls:2'])
    expect(result.purge.kind).toBe('purged-urls')
    if (result.purge.kind === 'purged-urls') {
      expect(result.purge.urls).toContain('https://example.com/about')
      expect(result.purge.urls).toContain('https://example.com/fr/about')
    }
  })

  it('limits the source-side sitemap merge to the items published in this run (#1430 review)', async () => {
    // A partial publish must not list pages the target never received
    // (they would be 404 URLs): only this run's pages merge into the
    // target listing, alongside what the target already has.
    const siteRoot = join(tmp, 'site')
    await mkdir(join(siteRoot, 'pages', 'one'), { recursive: true })
    await writeFile(
      join(siteRoot, 'pages', 'one', 'page.json'),
      JSON.stringify({ template: 'page-default', content: {} }),
    )
    await mkdir(join(siteRoot, 'pages', 'two'), { recursive: true })
    await writeFile(
      join(siteRoot, 'pages', 'two', 'page.json'),
      JSON.stringify({ template: 'page-default', content: {} }),
    )
    const twoPageRoot = createContentRoot(createFilesystemProvider(siteRoot), '')
    const twoPageSite = await loadSite({
      contentRoot: twoPageRoot,
      templatesDir: starterTemplatesDir,
      manifest: await starterManifest(),
    })
    const result = await publishToTarget({
      targetName: 'staging',
      targetStorage,
      targetConfig: stagingConfig(),
      sourceRoot: twoPageRoot,
      sourceName: 'local',
      site: twoPageSite,
      siteManifest: manifest,
      items: ['pages/one'],
      itemRefs: [{ kind: 'page', name: 'one' }],
      templateInfos,
      purgeScope: 'all',
    })
    expect(result.run?.failed).not.toBe(true)
    const sitemap = await innerTarget.readFile('sitemap.xml')
    expect(sitemap).toContain('/one')
    expect(sitemap).not.toContain('/two')

    // A follow-up publish of the second page adds it: it is both on
    // the target (sidecar) and in this run's merge set.
    const second = await publishToTarget({
      targetName: 'staging',
      targetStorage,
      targetConfig: stagingConfig(),
      sourceRoot: twoPageRoot,
      sourceName: 'local',
      site: twoPageSite,
      siteManifest: manifest,
      items: ['pages/two'],
      itemRefs: [{ kind: 'page', name: 'two' }],
      templateInfos,
      purgeScope: 'all',
    })
    expect(second.run?.failed).not.toBe(true)
    const sitemap2 = await innerTarget.readFile('sitemap.xml')
    expect(sitemap2).toContain('/one')
    expect(sitemap2).toContain('/two')
  })

  it('stops before the generated files, generation and purge when the run fails (#1430 review)', async () => {
    // A target whose renders all fail keeps the history revision and
    // the manifest copy, but gets no sitemap, no 404, no generation
    // bump and no purge - the edge keeps serving the last good state.
    const failing = {
      ...innerTarget,
      writeFile: async (path: string, content: string) => {
        if (path.endsWith('.html')) throw new Error('render write exploded')
        return innerTarget.writeFile(path, content)
      },
    } as StorageProvider
    const result = await publishToTarget({
      targetName: 'staging',
      targetStorage: failing,
      targetConfig: { type: 'static', environment: 'staging', siteUrl: 'https://example.com' } as TargetConfig,
      sourceRoot,
      sourceName: 'local',
      site,
      siteManifest: manifest,
      items: [`pages/${pageName()}`],
      itemRefs: [{ kind: 'page', name: pageName() }],
      templateInfos,
      purgeScope: 'all',
    })
    expect(result.run?.failed).toBe(true)
    expect(result.generatedFiles).toEqual([])
    expect(result.purge).toEqual({ kind: 'none' })
    expect(purgeCalls).toEqual([])
    expect(await innerTarget.exists(PUBLISH_GENERATION_PATH)).toBe(false)
    expect(await innerTarget.exists('sitemap.xml')).toBe(false)
    expect(await innerTarget.exists('404.html')).toBe(false)
    // The manifest copy did land before the render loop.
    expect(await innerTarget.exists(`pages/${pageName()}/page.json`)).toBe(true)
  })

  it('writes 404.html for a static target before the generation and the purge (#1430 review)', async () => {
    const result = await publishToTarget({
      targetName: 'staging',
      targetStorage,
      targetConfig: {
        type: 'static',
        environment: 'staging',
        siteUrl: 'https://example.com',
        cache: { purge: PURGE_CONFIG },
      } as TargetConfig,
      sourceRoot,
      sourceName: 'local',
      site,
      siteManifest: manifest,
      items: [`pages/${pageName()}`],
      itemRefs: [{ kind: 'page', name: pageName() }],
      templateInfos,
      purgeScope: 'all',
    })
    expect(result.run?.failed).not.toBe(true)
    expect(await innerTarget.exists('404.html')).toBe(true)
    expect(result.generatedFiles[0]).toBe('404.html')
    const notFoundIndex = events.indexOf('write:404.html')
    const generationIndex = events.indexOf(`write:${PUBLISH_GENERATION_PATH}`)
    expect(notFoundIndex).toBeGreaterThan(-1)
    expect(generationIndex).toBeGreaterThan(notFoundIndex)
    expect(purgeCalls).toEqual(['purgeAll'])
  })

  it('a bare item records and copies the default plus every translation manifest', async () => {
    const localized = [...site.pageLocales.keys()][0]
    if (!localized) return
    const result = await publishToTarget({
      targetName: 'staging',
      targetStorage,
      targetConfig: stagingConfig(),
      sourceRoot,
      sourceName: 'local',
      site,
      siteManifest: manifest,
      items: [`pages/${localized}`],
      itemRefs: [{ kind: 'page', name: localized }],
      templateInfos,
      purgeScope: 'all',
    })
    expect(result.run?.failed).not.toBe(true)
    expect(await innerTarget.exists(`pages/${localized}/page.json`)).toBe(true)
    const history = createHistoryProvider({ storage: innerTarget })
    const revisions = await history.listRevisions()
    const publishes = revisions.filter(r => r.operation === 'publish')
    expect(publishes).toHaveLength(1)
    const rev = await history.readRevision(publishes[0]!.id)
    expect(Object.keys(rev.snapshot)).toContain(`pages/${localized}/page.json`)
    expect(Object.keys(rev.snapshot)).toContain(`pages/${localized}/page.fr.json`)
  })
})
