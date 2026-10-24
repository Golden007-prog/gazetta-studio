/**
 * What a static target's root `404.html` holds (#1152 decision 3): the
 * site's default-language `/404` page, rendered as static publish renders
 * it, or a minimal noindex page when the site has no live `/404` page.
 */
import { describe, expect, it } from 'vitest'
import { loadSite } from '../src/site-loader.js'
import { renderPageStatic } from '../src/publish-renderers.js'
import { createContentRoot } from '../src/content-root.js'
import { createFilesystemProvider } from '../src/providers/filesystem.js'
import { MINIMAL_404_HTML, static404Html } from '../src/static-404.js'
import { starterManifest, starterTargetDir, starterTemplatesDir } from './_helpers/starter.js'

async function loadStarterSite() {
  const contentRoot = createContentRoot(createFilesystemProvider(starterTargetDir), '')
  return loadSite({ contentRoot, templatesDir: starterTemplatesDir, manifest: await starterManifest() })
}

describe('static404Html', () => {
  it("returns the site's default-language /404 page as static publish renders it", async () => {
    const site = await loadStarterSite()
    const expected = (await renderPageStatic('404', { site })).indexHtml

    const html = await static404Html(site)

    expect(html).toBe(expected)
    expect(html).not.toBe(MINIMAL_404_HTML)
  })

  it('returns the minimal noindex page when the site has no /404 page', async () => {
    const site = await loadStarterSite()
    site.pages.delete('404')

    const html = await static404Html(site)

    expect(html).toBe(MINIMAL_404_HTML)
    expect(html).toContain('<meta name="robots" content="noindex">')
    expect(html).toContain('Page not found')
  })

  it('returns the minimal page when the /404 page is archived', async () => {
    const site = await loadStarterSite()
    site.pages.set('404', { ...site.pages.get('404')!, archived: true })

    expect(await static404Html(site)).toBe(MINIMAL_404_HTML)
  })
})
