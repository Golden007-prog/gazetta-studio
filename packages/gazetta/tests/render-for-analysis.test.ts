/**
 * Tests for render-for-analysis (Validation Cut 3).
 *
 * Exercises the cache contract using the starter site:
 *   - Renders the same HTML as preview/publish (same renderer underneath)
 *   - Cache hit on repeat call with unchanged inputs
 *   - Cache miss when content hash changes
 *   - Returns null gracefully on missing item / template error
 */
import { describe, expect, it } from 'vitest'
import { createFilesystemProvider } from '../src/providers/filesystem.js'
import { loadSite } from '../src/site-loader.js'
import { renderPageForAnalysis } from '../src/render-for-analysis.js'
import { createMemoryCache } from '../src/cache/memory.js'
import { starterTargetDir, starterTemplatesDir, starterManifest } from './_helpers/starter.js'

const storage = createFilesystemProvider()

describe('renderPageForAnalysis', () => {
  it('renders the home page to HTML', async () => {
    const site = await loadSite({
      siteDir: starterTargetDir,
      storage,
      templatesDir: starterTemplatesDir,
      manifest: await starterManifest(),
    })
    const cache = createMemoryCache()
    const out = await renderPageForAnalysis('home', { site, cache, templatesDir: starterTemplatesDir })
    expect(out).not.toBeNull()
    expect(out!.html.toLowerCase()).toContain('<!doctype html>')
    expect(out!.html).toContain('</html>')
    // Only publish marks output (design-live-check.md Q4).
    expect(out!.html).not.toContain('gazetta:published')
  })

  it('cache hit on repeat call returns the same output without re-render', async () => {
    const site = await loadSite({
      siteDir: starterTargetDir,
      storage,
      templatesDir: starterTemplatesDir,
      manifest: await starterManifest(),
    })
    const cache = createMemoryCache()
    const first = await renderPageForAnalysis('home', { site, cache, templatesDir: starterTemplatesDir })
    const second = await renderPageForAnalysis('home', { site, cache, templatesDir: starterTemplatesDir })
    expect(second).not.toBeNull()
    expect(second!.html).toBe(first!.html)
    // The cache holds exactly one entry for the home page (not 2).
    const stats = await cache.stats?.()
    expect(stats?.hits).toBe(1)
    expect(stats?.misses).toBe(1)
  })

  it('returns null when the page does not exist', async () => {
    const site = await loadSite({
      siteDir: starterTargetDir,
      storage,
      templatesDir: starterTemplatesDir,
      manifest: await starterManifest(),
    })
    const cache = createMemoryCache()
    const out = await renderPageForAnalysis('does-not-exist', {
      site,
      cache,
      templatesDir: starterTemplatesDir,
    })
    expect(out).toBeNull()
  })

  it('cache key includes locale — different locales render under different keys', async () => {
    const site = await loadSite({
      siteDir: starterTargetDir,
      storage,
      templatesDir: starterTemplatesDir,
      manifest: await starterManifest(),
    })
    const cache = createMemoryCache()
    await renderPageForAnalysis('home', { site, cache, templatesDir: starterTemplatesDir, locale: 'en' })
    await renderPageForAnalysis('home', { site, cache, templatesDir: starterTemplatesDir, locale: 'fr' })
    const stats = await cache.stats?.()
    expect(stats?.misses).toBe(2) // both are misses; locale segregates
  })
})
