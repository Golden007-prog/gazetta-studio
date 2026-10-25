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
import { mkdtemp, rm } from 'node:fs/promises'
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

  const pageName = () => [...site.pages.keys()].find(k => !k.includes('['))!

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
    const result = await publish(stagingConfig({ cache: { purge: PURGE_CONFIG } }), 'items')
    expect(purgeCalls).toEqual(['purgeUrls:1'])
    expect(result.purge.kind).toBe('purged-urls')
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
