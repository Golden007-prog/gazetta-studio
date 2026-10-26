/**
 * #1491: the Cloudflare worker answered 404 for URLs with a trailing
 * slash (`/about/`, `/fr/about/`) while `gazetta serve` and `gazetta dev`
 * normalize them to the slash-less route. The worker strips one
 * trailing slash before the page lookup: same response, no redirect,
 * the query string is kept and `/` itself is unchanged.
 *
 * Verified fail-unfixed before commit: `/about/` and the query-string
 * case answer 404 on main (the lookup builds `pages/about//index.html`)
 * and 200 with the normalization. The locale-prefixed case already
 * passed on main - extractLocale rebuilds the path from filtered
 * segments, dropping the trailing slash - and now locks that behavior.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { createWorker } from '../src/workers/cloudflare-r2.js'

const ABOUT_HTML = '<!DOCTYPE html><html><body>About</body></html>'
const ABOUT_FR_HTML = '<!DOCTYPE html><html><body>\u00c0 propos</body></html>'
const HOME_HTML = '<!DOCTYPE html><html><body>Home</body></html>'

function fakeBucket(seed: Record<string, string>) {
  const files = new Map(Object.entries(seed))
  return {
    async get(key: string) {
      const value = files.get(key)
      if (value === undefined) return null
      return {
        async text() {
          return value
        },
      }
    },
    async list() {
      return { delimitedPrefixes: [] as string[] }
    },
  }
}

let originalCaches: PropertyDescriptor | undefined

beforeEach(() => {
  originalCaches = Object.getOwnPropertyDescriptor(globalThis, 'caches')
  Object.defineProperty(globalThis, 'caches', {
    configurable: true,
    writable: true,
    value: {
      default: {
        match: async () => undefined,
        put: async () => {},
      },
    },
  })
})

afterEach(() => {
  if (originalCaches) Object.defineProperty(globalThis, 'caches', originalCaches)
  else delete (globalThis as { caches?: unknown }).caches
})

function fetchPage(app: ReturnType<typeof createWorker>, bucket: unknown, url: string) {
  return app.fetch(
    new Request(`https://example.com${url}`),
    { SITE_BUCKET: bucket } as never,
    { waitUntil: () => {}, passThroughOnException: () => {} } as never,
  )
}

describe('Cloudflare worker trailing-slash normalization (#1491)', () => {
  const bucket = fakeBucket({
    'pages/about/index.html': ABOUT_HTML,
    'pages/about/index.fr.html': ABOUT_FR_HTML,
    'pages/home/index.html': HOME_HTML,
  })

  it('/about/ answers like /about', async () => {
    const app = createWorker()
    const slash = await fetchPage(app, bucket, '/about/')
    expect(slash.status).toBe(200)
    expect(await slash.text()).toBe(await (await fetchPage(app, bucket, '/about')).text())
  })

  it('/fr/about/ answers like /fr/about on a locale route', async () => {
    const app = createWorker({ locales: ['fr'] })
    const slash = await fetchPage(app, bucket, '/fr/about/')
    expect(slash.status).toBe(200)
    expect(await slash.text()).toBe(await (await fetchPage(app, bucket, '/fr/about')).text())
  })

  it('keeps the query string on a trailing-slash URL', async () => {
    const app = createWorker()
    const res = await fetchPage(app, bucket, '/about/?ref=docs')
    expect(res.status).toBe(200)
  })

  it('/ itself is unchanged', async () => {
    const app = createWorker()
    const res = await fetchPage(app, bucket, '/')
    expect(res.status).toBe(200)
    expect(await res.text()).toBe(HOME_HTML)
  })
})
