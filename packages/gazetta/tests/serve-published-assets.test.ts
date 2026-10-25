/**
 * #1330: published assets (content-addressed uploads under `assets/`) must
 * be served by every published-site server, not only `gazetta dev`. The
 * ESI `gazetta serve` app and the Cloudflare R2 worker answered /assets/*
 * with the page 404, and the shared route served `*.asset.json` manifests
 * to anyone who asked.
 *
 * RED on main: ESI createServer and createWorker return 404 for asset
 * bytes; the shared route answers manifests with 200 and Range requests
 * without a 206.
 */
import { describe, expect, it } from 'vitest'
import { Hono } from 'hono'
import { createServer } from '../src/serve.js'
import { createWorker } from '../src/workers/cloudflare-r2.js'
import { assetServeRoutes } from '../src/assets/serve-route.js'
import { memoryStorage, type MemoryStorage } from './_helpers/memory-storage.js'

const JPEG_BYTES = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 1, 2, 3, 4, 5])
const SVG_BYTES = new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg"/>')
const GIF_BYTES = new Uint8Array([0x47, 0x49, 0x46, 0x38, 0x39, 0x61])
const MP3_BYTES = new Uint8Array([0xff, 0xfb, 0x90, 0x00, 9, 9, 9])

function seededStorage(): MemoryStorage {
  const storage = memoryStorage()
  storage.seedBytes({
    'assets/hero-a3b2c1d4.jpg': JPEG_BYTES,
    'assets/vector-1b2c3d4e.svg': SVG_BYTES,
    'assets/anim-f5a6b7c8.gif': GIF_BYTES,
    'assets/track-9c8d7e6f.mp3': MP3_BYTES,
    'assets/hero.asset.json': new TextEncoder().encode('{"name":"hero"}'),
  })
  return storage
}

describe('ESI gazetta serve (createServer)', () => {
  const app = () => createServer({ storage: seededStorage() })

  it('answers 200 with byte-exact body, image/jpeg Content-Type, and hash ETag', async () => {
    const res = await app().request('/assets/hero-a3b2c1d4.jpg')
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toBe('image/jpeg')
    expect(res.headers.get('etag')).toBe('"a3b2c1d4"')
    expect(res.headers.get('cache-control')).toBe('public, max-age=31536000, immutable')
    expect(Buffer.from(await res.arrayBuffer()).equals(Buffer.from(JPEG_BYTES))).toBe(true)
  })

  it('answers 304 when If-None-Match matches the hash ETag', async () => {
    const res = await app().request('/assets/hero-a3b2c1d4.jpg', {
      headers: { 'If-None-Match': '"a3b2c1d4"' },
    })
    expect(res.status).toBe(304)
    expect(res.headers.get('etag')).toBe('"a3b2c1d4"')
  })

  it('answers 206 with the requested byte range', async () => {
    const res = await app().request('/assets/hero-a3b2c1d4.jpg', {
      headers: { Range: 'bytes=0-3' },
    })
    expect(res.status).toBe(206)
    expect(res.headers.get('content-range')).toBe(`bytes 0-3/${JPEG_BYTES.length}`)
    expect(Buffer.from(await res.arrayBuffer()).equals(Buffer.from(JPEG_BYTES.slice(0, 4)))).toBe(true)
  })

  it.each([
    ['/assets/vector-1b2c3d4e.svg', 'image/svg+xml'],
    ['/assets/anim-f5a6b7c8.gif', 'image/gif'],
    ['/assets/track-9c8d7e6f.mp3', 'audio/mpeg'],
  ])('serves %s as %s', async (path, mime) => {
    const res = await app().request(path)
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toBe(mime)
  })

  it('answers 404 for .asset.json manifests', async () => {
    const res = await app().request('/assets/hero.asset.json')
    expect(res.status).toBe(404)
  })
})

// Minimal fake R2 bucket: byte storage plus the `get(key, { range })` shape
// the worker uses. `size` is always the full object size, like real R2.
function fakeBucket(files: Record<string, Uint8Array>) {
  return {
    async head(key: string) {
      const value = files[key]
      return value === undefined ? null : { size: value.length }
    },
    async get(key: string, options?: { range?: { offset: number; length?: number } }) {
      const value = files[key]
      if (value === undefined) return null
      const offset = options?.range?.offset ?? 0
      const end = options?.range?.length !== undefined ? offset + options.range.length : value.length
      const slice = value.slice(offset, Math.min(end, value.length))
      return {
        body: new ReadableStream<Uint8Array>({
          start(c) {
            c.enqueue(slice)
            c.close()
          },
        }),
        size: value.length,
        range: options?.range ? { offset, length: slice.length } : undefined,
      }
    },
  }
}

const ctx = { waitUntil: () => {}, passThroughOnException: () => {} } as never

function seededWorker() {
  const files = {
    'assets/hero-a3b2c1d4.jpg': JPEG_BYTES,
    'assets/vector-1b2c3d4e.svg': SVG_BYTES,
    'assets/anim-f5a6b7c8.gif': GIF_BYTES,
    'assets/track-9c8d7e6f.mp3': MP3_BYTES,
    'assets/hero.asset.json': new TextEncoder().encode('{"name":"hero"}'),
  }
  const worker = createWorker()
  return (path: string, headers?: Record<string, string>) =>
    worker.fetch(
      new Request(`https://example.com${path}`, { headers }),
      { SITE_BUCKET: fakeBucket(files) } as never,
      ctx,
    )
}

describe('Cloudflare R2 worker (createWorker)', () => {
  it('answers 200 with byte-exact body, image/jpeg Content-Type, and hash ETag', async () => {
    const res = await seededWorker()('/assets/hero-a3b2c1d4.jpg')
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toBe('image/jpeg')
    expect(res.headers.get('etag')).toBe('"a3b2c1d4"')
    expect(res.headers.get('cache-control')).toBe('public, max-age=31536000, immutable')
    expect(Buffer.from(await res.arrayBuffer()).equals(Buffer.from(JPEG_BYTES))).toBe(true)
  })

  it('answers 304 when If-None-Match matches the hash ETag', async () => {
    const res = await seededWorker()('/assets/hero-a3b2c1d4.jpg', { 'If-None-Match': '"a3b2c1d4"' })
    expect(res.status).toBe(304)
    expect(res.headers.get('etag')).toBe('"a3b2c1d4"')
  })

  it('answers 206 with exact Content-Range for a bounded Range', async () => {
    const res = await seededWorker()('/assets/hero-a3b2c1d4.jpg', { Range: 'bytes=0-3' })
    expect(res.status).toBe(206)
    expect(res.headers.get('content-range')).toBe(`bytes 0-3/${JPEG_BYTES.length}`)
    expect(Buffer.from(await res.arrayBuffer()).equals(Buffer.from(JPEG_BYTES.slice(0, 4)))).toBe(true)
  })

  it('answers 206 for an unbounded Range using the R2 object size', async () => {
    const res = await seededWorker()('/assets/hero-a3b2c1d4.jpg', { Range: 'bytes=4-' })
    expect(res.status).toBe(206)
    expect(res.headers.get('content-range')).toBe(`bytes 4-${JPEG_BYTES.length - 1}/${JPEG_BYTES.length}`)
    expect(Buffer.from(await res.arrayBuffer()).equals(Buffer.from(JPEG_BYTES.slice(4)))).toBe(true)
  })

  it.each([
    ['/assets/vector-1b2c3d4e.svg', 'image/svg+xml'],
    ['/assets/anim-f5a6b7c8.gif', 'image/gif'],
    ['/assets/track-9c8d7e6f.mp3', 'audio/mpeg'],
  ])('serves %s as %s', async (path, mime) => {
    const res = await seededWorker()(path)
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toBe(mime)
  })

  it('answers 404 for .asset.json manifests', async () => {
    const res = await seededWorker()('/assets/hero.asset.json')
    expect(res.status).toBe(404)
  })
})

describe('gazetta dev (shared asset route)', () => {
  it('answers 404 for .asset.json manifests', async () => {
    const storage = seededStorage()
    const app = new Hono()
    app.route(
      '/',
      assetServeRoutes(async () => storage),
    )
    const res = await app.request('/assets/hero.asset.json')
    expect(res.status).toBe(404)
  })
})

// Edge cases from sentry's review of #1438: conditionals must not answer
// for missing objects, unsatisfiable ranges answer 416 (not 500), and
// encoded null bytes never reach the storage layer.

describe('shared asset route edge cases', () => {
  const app = () => {
    const storage = seededStorage()
    const a = new Hono()
    a.route(
      '/',
      assetServeRoutes(async () => storage),
    )
    return a
  }

  it('answers 416, not 500, when the range start is past the object end', async () => {
    const res = await app().request('/assets/hero-a3b2c1d4.jpg', {
      headers: { Range: `bytes=${JPEG_BYTES.length + 5}-${JPEG_BYTES.length + 9}` },
    })
    expect(res.status).toBe(416)
    expect(res.headers.get('content-range')).toBe(`bytes */${JPEG_BYTES.length}`)
  })

  it('treats a backwards range (bytes=5-3) as no range', async () => {
    const res = await app().request('/assets/hero-a3b2c1d4.jpg', {
      headers: { Range: 'bytes=5-3' },
    })
    expect(res.status).toBe(200)
    expect(Buffer.from(await res.arrayBuffer()).equals(Buffer.from(JPEG_BYTES))).toBe(true)
  })

  it('clamps an over-long bounded range to the object end', async () => {
    const res = await app().request('/assets/hero-a3b2c1d4.jpg', {
      headers: { Range: 'bytes=8-9999' },
    })
    expect(res.status).toBe(206)
    expect(res.headers.get('content-range')).toBe(`bytes 8-${JPEG_BYTES.length - 1}/${JPEG_BYTES.length}`)
    expect(Buffer.from(await res.arrayBuffer()).equals(Buffer.from(JPEG_BYTES.slice(8)))).toBe(true)
  })

  it('answers 206 with exact bounds for an unbounded range', async () => {
    const res = await app().request('/assets/hero-a3b2c1d4.jpg', {
      headers: { Range: 'bytes=4-' },
    })
    expect(res.status).toBe(206)
    expect(res.headers.get('content-range')).toBe(`bytes 4-${JPEG_BYTES.length - 1}/${JPEG_BYTES.length}`)
    expect(Buffer.from(await res.arrayBuffer()).equals(Buffer.from(JPEG_BYTES.slice(4)))).toBe(true)
  })

  it('answers 400 for percent-encoded null bytes in the path', async () => {
    const res = await app().request('/assets/hero-a3b2c1d4%00.jpg')
    expect(res.status).toBe(400)
  })

  it('answers 400 for other encoded control characters in the path', async () => {
    const res = await app().request('/assets/hero-a3b2c1d4%1f.jpg')
    expect(res.status).toBe(400)
  })
})

describe('worker edge cases', () => {
  it('answers 404, not 304, for a matching ETag on a missing asset', async () => {
    const res = await seededWorker()('/assets/missing-a3b2c1d4.jpg', { 'If-None-Match': '"a3b2c1d4"' })
    expect(res.status).toBe(404)
  })

  it('answers 416, not 500, when the range start is past the object end', async () => {
    const res = await seededWorker()('/assets/hero-a3b2c1d4.jpg', {
      Range: `bytes=${JPEG_BYTES.length + 5}-${JPEG_BYTES.length + 9}`,
    })
    expect(res.status).toBe(416)
    expect(res.headers.get('content-range')).toBe(`bytes */${JPEG_BYTES.length}`)
  })

  it('clamps an over-long bounded range to the object end', async () => {
    const res = await seededWorker()('/assets/hero-a3b2c1d4.jpg', { Range: 'bytes=8-9999' })
    expect(res.status).toBe(206)
    expect(res.headers.get('content-range')).toBe(`bytes 8-${JPEG_BYTES.length - 1}/${JPEG_BYTES.length}`)
    expect(Buffer.from(await res.arrayBuffer()).equals(Buffer.from(JPEG_BYTES.slice(8)))).toBe(true)
  })

  it('answers 400 for percent-encoded null bytes in the path', async () => {
    const res = await seededWorker()('/assets/hero-a3b2c1d4%00.jpg')
    expect(res.status).toBe(400)
  })
})
