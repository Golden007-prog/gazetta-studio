/**
 * What a static target's root `404.html` holds (#1152 decision 3, #1231):
 * the target's own `/404` page as published, or a minimal noindex page
 * when the target has none or holds it archived.
 */
import { describe, expect, it } from 'vitest'
import { archiveMarker } from '../src/runtime/archive-marker.js'
import { MINIMAL_404_HTML, static404Html } from '../src/static-404.js'
import { memoryStorage } from './_helpers/memory-storage.js'

const page = '<!doctype html><html><head><title>Not here</title></head><body>Lost</body></html>'

describe('static404Html', () => {
  it("returns the target's published /404 page", async () => {
    const storage = memoryStorage()
    storage.seed({ '404/index.html': page })

    expect(await static404Html(storage)).toBe(page)
  })

  it('returns the minimal noindex page while the target has no /404 page', async () => {
    const html = await static404Html(memoryStorage())

    expect(html).toBe(MINIMAL_404_HTML)
    expect(html).toContain('<meta name="robots" content="noindex">')
    expect(html).toContain('Page not found')
  })

  it("returns the minimal page when the target's /404 page is archived", async () => {
    const storage = memoryStorage()
    storage.seed({ '404/index.html': `${archiveMarker({ kind: 'gone' })}${page}` })

    expect(await static404Html(storage)).toBe(MINIMAL_404_HTML)
  })
})
