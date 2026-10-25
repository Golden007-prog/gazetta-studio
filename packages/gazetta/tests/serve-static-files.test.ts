/**
 * #1249: static `gazetta serve` must answer stored non-page files with
 * their bytes unchanged and a content type from their extension. The
 * pre-fix fallback read every non-page path as UTF-8 text and answered
 * `c.html(...)` — corrupting binary files and typing robots.txt /
 * sitemap.xml as text/html.
 *
 * Cache matrix (locked in the issue discussion): fingerprinted publish
 * output under /assets/ is immutable; everything else gets one hour,
 * matching the ESI routes for robots.txt / sitemap.xml. Pages keep
 * their existing headers (max-age=0, must-revalidate + ETag).
 */
import { describe, expect, it } from 'vitest'
import { createServer } from '../src/serve.js'
import { memoryStorage } from './_helpers/memory-storage.js'

// Minimal valid PNG signature + a byte (0x89) that UTF-8 decoding would
// replace — proves the round-trip is byte-exact.
const PNG_BYTES = new Uint8Array([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0xff, 0xfe, 0xfd, 0x08, 0x05, 0x11, 0x14, 0x10, 0x77,
])

describe('static serve — stored non-page files (#1249)', () => {
  it('serves robots.txt as text/plain with the exact body', async () => {
    const storage = memoryStorage()
    storage.seed({ 'index.html': '<h1>home</h1>', 'robots.txt': 'User-agent: *\nDisallow:\n' })
    const app = createServer({ storage, type: 'static' })

    const res = await app.request('/robots.txt')

    expect(res.status).toBe(200)
    expect(res.headers.get('Content-Type')).toBe('text/plain')
    expect(await res.text()).toBe('User-agent: *\nDisallow:\n')
  })

  it('serves sitemap.xml as application/xml', async () => {
    const storage = memoryStorage()
    storage.seed({
      'index.html': '<h1>home</h1>',
      'sitemap.xml': '<?xml version="1.0"?><urlset></urlset>',
    })
    const app = createServer({ storage, type: 'static' })

    const res = await app.request('/sitemap.xml')

    expect(res.status).toBe(200)
    expect(res.headers.get('Content-Type')).toBe('application/xml')
  })

  it('serves a PNG byte-exact as image/png (no UTF-8 corruption)', async () => {
    const storage = memoryStorage()
    storage.seed({ 'index.html': '<h1>home</h1>' })
    storage.seedBytes({ 'assets/logo-abc12345.png': PNG_BYTES })
    const app = createServer({ storage, type: 'static' })

    const res = await app.request('/assets/logo-abc12345.png')

    expect(res.status).toBe(200)
    expect(res.headers.get('Content-Type')).toBe('image/png')
    const body = new Uint8Array(await res.arrayBuffer())
    expect(body).toEqual(PNG_BYTES)
  })

  it('sends Cache-Control for non-page files: immutable under /assets/, one hour elsewhere', async () => {
    const storage = memoryStorage()
    storage.seed({
      'index.html': '<h1>home</h1>',
      'robots.txt': 'User-agent: *\n',
      'sitemap.xml': '<?xml version="1.0"?><urlset></urlset>',
    })
    storage.seedBytes({ 'assets/logo-abc12345.png': PNG_BYTES })
    const app = createServer({ storage, type: 'static' })

    const asset = await app.request('/assets/logo-abc12345.png')
    expect(asset.headers.get('Cache-Control')).toBe('public, max-age=31536000, immutable')

    const robots = await app.request('/robots.txt')
    expect(robots.headers.get('Cache-Control')).toBe('public, max-age=3600')

    const sitemap = await app.request('/sitemap.xml')
    expect(sitemap.headers.get('Cache-Control')).toBe('public, max-age=3600')
  })

  it('keeps page headers and archive behavior unchanged', async () => {
    const storage = memoryStorage()
    storage.seed({ 'index.html': '<h1>home</h1>' })
    const app = createServer({ storage, type: 'static' })

    const res = await app.request('/')
    expect(res.status).toBe(200)
    expect(res.headers.get('Content-Type')).toContain('text/html')
    expect(res.headers.get('Cache-Control')).toBe('public, max-age=0, must-revalidate')
  })

  it('still answers the 404 page for missing paths', async () => {
    const storage = memoryStorage()
    storage.seed({ 'index.html': '<h1>home</h1>', '404.html': 'lost' })
    const app = createServer({ storage, type: 'static' })

    const res = await app.request('/no-such-file.txt')
    expect(res.status).toBe(404)
    expect(await res.text()).toBe('lost')
  })

  it('never exposes the underlying Node Buffer pool (small pooled file)', async () => {
    // The filesystem provider returns fs.readFile's Buffer as-is; small
    // files are views into Node's shared 8KB pool. The response must
    // contain exactly the file's bytes, not the pool allocation.
    const pool = Buffer.allocUnsafe(8192).fill(0x41)
    PNG_BYTES.forEach((b, i) => (pool[100 + i] = b))
    const pooled = pool.subarray(100, 100 + PNG_BYTES.length)
    const storage = memoryStorage()
    storage.seed({ 'index.html': '<h1>home</h1>' })
    storage.seedBytes({ 'assets/logo-abc12345.png': pooled })
    const app = createServer({ storage, type: 'static' })

    const res = await app.request('/assets/logo-abc12345.png')
    expect(res.status).toBe(200)
    const body = new Uint8Array(await res.arrayBuffer())
    expect(body.byteLength).toBe(PNG_BYTES.length)
    expect(body).toEqual(PNG_BYTES)
  })

  it('serves an empty file as zero bytes (no pool exposure)', async () => {
    const storage = memoryStorage()
    storage.seed({ 'index.html': '<h1>home</h1>' })
    storage.seedBytes({ 'empty.bin': Buffer.allocUnsafe(0) })
    const app = createServer({ storage, type: 'static' })

    const res = await app.request('/empty.bin')
    expect(res.status).toBe(200)
    expect((await res.arrayBuffer()).byteLength).toBe(0)
  })

  it('unknown extensions answer application/octet-stream', async () => {
    const storage = memoryStorage()
    storage.seed({ 'index.html': '<h1>home</h1>' })
    storage.seedBytes({ 'data.bin': new Uint8Array([1, 2, 3]) })
    const app = createServer({ storage, type: 'static' })

    const res = await app.request('/data.bin')
    expect(res.status).toBe(200)
    expect(res.headers.get('Content-Type')).toBe('application/octet-stream')
    expect(new Uint8Array(await res.arrayBuffer())).toEqual(new Uint8Array([1, 2, 3]))
  })
})
