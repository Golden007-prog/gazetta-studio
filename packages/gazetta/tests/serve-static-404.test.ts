/**
 * #1152 decision 9: static `gazetta serve` answers a missing path with the
 * target's own `404.html`, as plain hosts do, so a local preview looks
 * like the host. A target published before #1152 has no `404.html` and
 * keeps serve's one-line page.
 */
import { describe, expect, it } from 'vitest'
import { createServer } from '../src/serve.js'
import { memoryStorage } from './_helpers/memory-storage.js'

describe('static serve — missing paths', () => {
  it("answers with the target's 404.html and status 404", async () => {
    const storage = memoryStorage()
    storage.seed({
      'index.html': '<h1>home</h1>',
      '404.html': '<html><body>Custom lost page</body></html>',
    })
    const app = createServer({ storage, type: 'static' })

    const res = await app.request('/no-such-page')

    expect(res.status).toBe(404)
    expect(await res.text()).toBe('<html><body>Custom lost page</body></html>')
  })

  it('answers with the one-line page when the target has no 404.html', async () => {
    const storage = memoryStorage()
    storage.seed({ 'index.html': '<h1>home</h1>' })
    const app = createServer({ storage, type: 'static' })

    const res = await app.request('/no-such-page')

    expect(res.status).toBe(404)
    expect(await res.text()).toBe('<h1>404 — Page not found</h1>')
  })

  it('still serves existing pages with status 200', async () => {
    const storage = memoryStorage()
    storage.seed({ '/about/index.html': '<h1>about</h1>', '404.html': 'lost' })
    const app = createServer({ storage, type: 'static' })

    const res = await app.request('/about')

    expect(res.status).toBe(200)
    expect(await res.text()).toBe('<h1>about</h1>')
  })
})
