/**
 * The package's public publish functions (`publishPageRendered`,
 * `publishPageStatic`, `publishFragmentRendered`) must write exactly what
 * the live pipeline writes — `publishPage` / `publishFragment`, the path
 * the CLI and admin take via `publishRun`. They used to be a second,
 * separate implementation; the two drifted and the tests only watched
 * this one, which hid two regressions (#958, #959).
 */
import { describe, it, expect, beforeAll } from 'vitest'
import { publishPageRendered, publishPageStatic, publishFragmentRendered } from '../src/index.js'
import { publishPage } from '../src/pages/publish.js'
import { publishFragment } from '../src/fragments/publish.js'
import { createContentRoot, type ContentRoot } from '../src/content-root.js'
import { createFilesystemProvider } from '../src/providers/filesystem.js'
import { loadSite, type Site } from '../src/site-loader.js'
import { memoryStorage, type MemoryStorage } from './_helpers/memory-storage.js'
import { starterManifest, starterTargetDir, starterTemplatesDir } from './_helpers/starter.js'

/**
 * Every file on the target, keyed by path. Normalised: publish timestamps,
 * and the starter `counter` template's random element id (it calls
 * Math.random(), so two renders of the same page differ) together with the
 * script filename hash that depends on it.
 */
function snapshot(storage: MemoryStorage): Record<string, string> {
  const dec = new TextDecoder()
  const norm = (t: string) =>
    t
      .replace(/\.pub-\d{8}T\d{6}Z/g, '.pub-TS')
      .replace(/counter-[a-z0-9]{1,8}\b/g, 'counter-ID')
      .replace(/script\.[a-f0-9]{8}\.js/g, 'script.HASH.js')
  return Object.fromEntries([...storage.dump()].map(([path, bytes]) => [norm(path), norm(dec.decode(bytes))]))
}

describe('public publish functions write what the live pipeline writes', () => {
  let site: Site
  let contentRoot: ContentRoot

  beforeAll(async () => {
    contentRoot = createContentRoot(createFilesystemProvider(starterTargetDir), '')
    site = await loadSite({ contentRoot, templatesDir: starterTemplatesDir, manifest: await starterManifest() })
  })

  const target = (storage: MemoryStorage, type: 'esi' | 'static') => ({
    name: 'live',
    storage,
    type,
    manifestHash: 'h1',
  })

  it.each([
    ['ESI page', 'home', undefined],
    ['ESI page, locale', 'home', 'fr'],
  ] as const)('publishPageRendered: %s', async (_, name, locale) => {
    const a = memoryStorage()
    const b = memoryStorage()
    await publishPageRendered(name, contentRoot, a, undefined, starterTemplatesDir, 'h1', site, undefined, locale)
    await publishPage({ name, locale, site, sourceRoot: contentRoot, target: target(b, 'esi') })
    expect(snapshot(a)).toEqual(snapshot(b))
  })

  it.each([
    ['static page', 'about', undefined],
    ['static page, locale', 'about', 'fr'],
    ['static home', 'home', undefined],
  ] as const)('publishPageStatic: %s', async (_, name, locale) => {
    const a = memoryStorage()
    const b = memoryStorage()
    await publishPageStatic(name, contentRoot, a, starterTemplatesDir, 'h1', site, undefined, locale)
    await publishPage({ name, locale, site, sourceRoot: contentRoot, target: target(b, 'static') })
    expect(snapshot(a)).toEqual(snapshot(b))
  })

  it('publishFragmentRendered: fragment', async () => {
    const a = memoryStorage()
    const b = memoryStorage()
    await publishFragmentRendered('header', contentRoot, a, starterTemplatesDir, 'h1', site)
    await publishFragment({ name: 'header', site, sourceRoot: contentRoot, target: target(b, 'esi') })
    expect(snapshot(a)).toEqual(snapshot(b))
  })

  it.each(['esi', 'static'] as const)('archived page on a %s target', async type => {
    const archivedSite: Site = { ...site, pages: new Map(site.pages) }
    const about = site.pages.get('about')!
    archivedSite.pages.set('about', { ...about, archived: true, aliasOf: 'home' } as typeof about)
    const a = memoryStorage()
    const b = memoryStorage()
    if (type === 'esi')
      await publishPageRendered('about', contentRoot, a, undefined, starterTemplatesDir, 'h1', archivedSite)
    else await publishPageStatic('about', contentRoot, a, starterTemplatesDir, 'h1', archivedSite)
    await publishPage({ name: 'about', site: archivedSite, sourceRoot: contentRoot, target: target(b, type) })
    expect(snapshot(a)).toEqual(snapshot(b))
  })

  it('throws when the item does not exist (unchanged contract)', async () => {
    await expect(
      publishPageStatic('nope', contentRoot, memoryStorage(), starterTemplatesDir, undefined, site),
    ).rejects.toThrow(/nope/)
  })
})
