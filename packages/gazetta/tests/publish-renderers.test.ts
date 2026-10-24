/**
 * Pure-fn renderer tests — Cut 2 of publish pipeline extraction.
 *
 * Each renderer is a pure fn: takes resolved item + context, returns
 * RenderOutput descriptor. No I/O. Tests assert on output shape +
 * invariants per render mode.
 *
 * Per testing-plan.md priority 1.2 + Cut 2 strategy: real `loadSite`
 * against examples/starter so renderers exercise real templates +
 * fragment refs. Memory storage avoided here because renderers don't
 * touch storage — they consume the loaded `Site` and produce
 * descriptors.
 */
import { describe, expect, it } from 'vitest'
import { loadSite } from '../src/site-loader.js'
import {
  renderArchiveMarker,
  renderFragmentRendered,
  renderPageStatic,
  renderPageWithEsi,
  type PageRenderContext,
} from '../src/publish-renderers.js'
import { splitFragment } from '../src/assemble.js'
import { createContentRoot } from '../src/content-root.js'
import { outputHash, parsePublishedMarkers } from '../src/runtime/published-marker.js'
import { createFilesystemProvider } from '../src/providers/filesystem.js'
import { starterManifest, starterTargetDir, starterTemplatesDir } from './_helpers/starter.js'

async function loadStarterSite() {
  const storage = createFilesystemProvider(starterTargetDir)
  const contentRoot = createContentRoot(storage, '')
  const manifest = await starterManifest()
  return loadSite({ contentRoot, templatesDir: starterTemplatesDir, manifest })
}

describe('renderArchiveMarker — pure fn', () => {
  it('emits alias marker when aliasOf present', () => {
    const out = renderArchiveMarker({ aliasOf: 'home' })
    expect(out.indexFile).toBe('index.html')
    expect(out.indexHtml).toContain('alias=home')
    expect(out.archived).toBe(true)
    expect(out.files).toHaveLength(0)
  })

  it('emits gone marker when no aliasOf', () => {
    const out = renderArchiveMarker({})
    expect(out.indexHtml).toContain('gazetta:archived gone')
    expect(out.archived).toBe(true)
  })

  it('locale-suffixes index file', () => {
    const out = renderArchiveMarker({ aliasOf: 'home' }, 'fr')
    expect(out.indexFile).toBe('index.fr.html')
  })

  it('marker is single-line + first-200-bytes-readable', () => {
    const out = renderArchiveMarker({ aliasOf: 'home' })
    // Worker reads first 200 bytes; marker MUST fit + be the only line
    expect(out.indexHtml.length).toBeLessThan(200)
    expect(out.indexHtml.split('\n').filter(l => l.trim().length > 0)).toHaveLength(1)
  })
})

describe('renderPageWithEsi — pure fn', () => {
  it('throws on archived page (caller must dispatch to renderArchiveMarker)', async () => {
    const site = await loadStarterSite()
    // Synthesize an archived page entry into the loaded site.
    site.pages.set('archived-test', {
      ...site.pages.get('home')!,
      archived: true,
    })
    const ctx: PageRenderContext = { site }
    await expect(renderPageWithEsi('archived-test', ctx)).rejects.toThrow(/archived/i)
  })

  it('throws on missing page', async () => {
    const site = await loadStarterSite()
    const ctx: PageRenderContext = { site }
    await expect(renderPageWithEsi('does-not-exist', ctx)).rejects.toThrow(/not found/i)
  })

  it('returns ESI placeholders for @fragment refs in body', async () => {
    const site = await loadStarterSite()
    const ctx: PageRenderContext = { site }
    const out = await renderPageWithEsi('home', ctx)
    // Starter's home page references @header + @footer (or similar)
    expect(out.indexHtml).toMatch(/<!--esi:\/fragments\/[^>]+\/index\.html-->/)
  })

  it('produces hashed CSS file when components emit styles', async () => {
    const site = await loadStarterSite()
    const ctx: PageRenderContext = { site }
    const out = await renderPageWithEsi('home', ctx)
    // Starter's components have CSS — expect at least one hashed CSS
    const cssFiles = out.files.filter(f => f.path.endsWith('.css'))
    if (cssFiles.length > 0) {
      expect(cssFiles[0]?.path).toMatch(/styles\.[a-f0-9]{8}\.css$/)
    }
  })

  it('locale-suffixes index file when locale set', async () => {
    const site = await loadStarterSite()
    const ctx: PageRenderContext = { site, locale: 'fr' }
    const out = await renderPageWithEsi('home', ctx)
    expect(out.indexFile).toBe('index.fr.html')
  })

  it('renders the cache comment first per worker contract', async () => {
    const site = await loadStarterSite()
    const ctx: PageRenderContext = { site }
    const out = await renderPageWithEsi('home', ctx)
    expect(out.indexHtml.startsWith('<!--cache:')).toBe(true)
  })
})

describe('renderPageStatic — pure fn', () => {
  it('throws on archived page', async () => {
    const site = await loadStarterSite()
    site.pages.set('archived-test', { ...site.pages.get('home')!, archived: true })
    const ctx: PageRenderContext = { site }
    await expect(renderPageStatic('archived-test', ctx)).rejects.toThrow(/archived/i)
  })

  it('returns no separate hashed files (full-bake)', async () => {
    const site = await loadStarterSite()
    const ctx: PageRenderContext = { site }
    const out = await renderPageStatic('home', ctx)
    expect(out.files).toHaveLength(0)
  })

  it('emits well-formed HTML doctype', async () => {
    const site = await loadStarterSite()
    const ctx: PageRenderContext = { site }
    const out = await renderPageStatic('home', ctx)
    expect(out.indexHtml).toContain('<!DOCTYPE html>')
  })

  it("a locale page uses its own variant's title and description", async () => {
    const site = await loadStarterSite()
    const fr = site.pageLocales.get('home')!.locales.get('fr')!
    const out = await renderPageStatic('home', { site, locale: 'fr' })
    expect(out.indexHtml).toContain(`<title>${fr.metadata!.title}</title>`)
    expect(out.indexHtml).toContain(`<meta name="description" content="${fr.metadata!.description}">`)
    expect(out.indexHtml).not.toContain(site.pages.get('home')!.metadata!.title as string)
  })
})

describe('renderFragmentRendered — pure fn', () => {
  it('throws on missing fragment', async () => {
    const site = await loadStarterSite()
    await expect(renderFragmentRendered('does-not-exist', { site })).rejects.toThrow(/not found/i)
  })

  it('emits hashed CSS file when fragment has styles', async () => {
    const site = await loadStarterSite()
    const fragName = [...site.fragments.keys()][0]
    if (!fragName) return
    const out = await renderFragmentRendered(fragName, { site })
    const cssFiles = out.files.filter(f => f.path.startsWith(`fragments/${fragName}/styles.`))
    if (cssFiles.length > 0) {
      expect(cssFiles[0]?.path).toMatch(/styles\.[a-f0-9]{8}\.css$/)
    }
  })

  it('wraps body in head section when CSS or JS present', async () => {
    const site = await loadStarterSite()
    const fragName = [...site.fragments.keys()][0]
    if (!fragName) return
    const out = await renderFragmentRendered(fragName, { site })
    if (out.files.length > 0) {
      expect(out.indexHtml.startsWith('<head>')).toBe(true)
      expect(out.indexHtml).toContain('</head>')
    }
  })

  it('locale-suffixes index file when locale set', async () => {
    const site = await loadStarterSite()
    const fragName = [...site.fragments.keys()][0]
    if (!fragName) return
    const out = await renderFragmentRendered(fragName, { site, locale: 'fr' })
    expect(out.indexFile).toBe('index.fr.html')
  })
})

describe('published-version marker', () => {
  const MARKER_LINE = /^<!-- gazetta:published hash=[0-9a-f]{8} -->$/

  function markerLines(html: string): string[] {
    return html.split('\n').filter(l => MARKER_LINE.test(l))
  }

  it.each([
    ['ESI', renderPageWithEsi, '<!--cache:'],
    ['static', renderPageStatic, '<!DOCTYPE html>'],
  ] as const)('%s page: one marker right before </head>, line 1 unchanged', async (_label, render, firstLine) => {
    const site = await loadStarterSite()
    const out = await render('home', { site })
    const lines = out.indexHtml.split('\n')
    expect(lines[0].startsWith(firstLine)).toBe(true)
    expect(markerLines(out.indexHtml)).toHaveLength(1)
    expect(lines[lines.indexOf('</head>') - 1]).toMatch(MARKER_LINE)
  })

  it.each([
    ['ESI', renderPageWithEsi],
    ['static', renderPageStatic],
  ] as const)('%s page: the hash is of the output without the marker', async (_label, render) => {
    const site = await loadStarterSite()
    const out = await render('about', { site })
    const [line] = markerLines(out.indexHtml)
    const unmarked = out.indexHtml.replace(`${line}\n`, '')
    expect(parsePublishedMarkers(out.indexHtml).page).toBe(outputHash(unmarked))
  })

  it('fragment: the marker ends the body, hashed over the whole output', async () => {
    const site = await loadStarterSite()
    const out = await renderFragmentRendered('header', { site })
    const lines = out.indexHtml.split('\n')
    const last = lines[lines.length - 1]
    expect(last).toMatch(MARKER_LINE)
    expect(markerLines(out.indexHtml)).toHaveLength(1)
    const unmarked = lines.slice(0, -1).join('\n')
    expect(last).toBe(`<!-- gazetta:published hash=${outputHash(unmarked)} -->`)
    // The marker belongs to the body the worker inserts, not the head it hoists.
    expect(splitFragment(out.indexHtml).body.endsWith(last)).toBe(true)
  })

  it.each([
    ['alias', { aliasOf: 'welcome' }],
    ['gone', {}],
  ])('archive marker (%s) carries no published marker', (_label, page) => {
    const out = renderArchiveMarker(page)
    expect(out.indexHtml).not.toContain('gazetta:published')
  })
})
