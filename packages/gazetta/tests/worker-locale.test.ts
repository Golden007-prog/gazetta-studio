/**
 * Unit tests for Cloudflare Worker locale handling.
 * Uses a mock R2 bucket (in-memory Map) to test extractLocale,
 * findPage locale routing, and fragment locale fallback.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { createWorker } from '../src/workers/cloudflare-r2.js'

// We can't import the Worker directly (needs Cloudflare types at runtime).
// Instead, test the locale logic inline — same patterns as serve.ts tests
// but verifying the Worker's specific code paths.

// Extracted from workers/cloudflare-r2.ts — same logic
function extractLocale(requestPath: string, locales: string[]): { locale: string | undefined; path: string } {
  if (locales.length === 0) return { locale: undefined, path: requestPath }
  const parts = requestPath.split('/').filter(Boolean)
  if (parts.length > 0 && locales.includes(parts[0])) {
    return { locale: parts[0], path: '/' + parts.slice(1).join('/') || '/' }
  }
  return { locale: undefined, path: requestPath }
}

describe('Worker extractLocale', () => {
  const locales = ['fr', 'de', 'pt-br']

  it('extracts known locale prefix', () => {
    expect(extractLocale('/fr/about', locales)).toEqual({ locale: 'fr', path: '/about' })
  })

  it('handles root with locale', () => {
    expect(extractLocale('/fr', locales)).toEqual({ locale: 'fr', path: '/' })
  })

  it('returns undefined for unknown prefix', () => {
    expect(extractLocale('/es/about', locales)).toEqual({ locale: undefined, path: '/es/about' })
  })

  it('handles no locales configured', () => {
    expect(extractLocale('/fr/about', [])).toEqual({ locale: undefined, path: '/fr/about' })
  })

  it('extracts region code', () => {
    expect(extractLocale('/pt-br/about', locales)).toEqual({ locale: 'pt-br', path: '/about' })
  })
})

describe('Worker locale file lookup logic', () => {
  it('locale suffix produces correct index file path', () => {
    const locale = 'fr'
    const resolvedPath = '/about'
    const indexFile = locale ? `index.${locale}.html` : 'index.html'
    const pagePath = `pages${resolvedPath}/${indexFile}`
    expect(pagePath).toBe('pages/about/index.fr.html')
  })

  it('default locale uses index.html', () => {
    const locale = undefined
    const indexFile = locale ? `index.${locale}.html` : 'index.html'
    expect(indexFile).toBe('index.html')
  })

  it('home page with locale', () => {
    const locale = 'fr'
    const resolvedPath = '/'
    const indexFile = `index.${locale}.html`
    const pagePath = resolvedPath === '/' ? `pages/home/${indexFile}` : `pages${resolvedPath}/${indexFile}`
    expect(pagePath).toBe('pages/home/index.fr.html')
  })
})

describe('Worker fragment locale fallback regex', () => {
  it('strips locale suffix from fragment path', () => {
    const path = 'fragments/header/index.fr.html'
    const fallback = path.replace(/\/index\.[a-z-]+\.html$/, '/index.html')
    expect(fallback).toBe('fragments/header/index.html')
  })

  it('does not strip default fragment path', () => {
    const path = 'fragments/header/index.html'
    const fallback = path.replace(/\/index\.[a-z-]+\.html$/, '/index.html')
    expect(fallback).toBe('fragments/header/index.html') // unchanged
  })

  it('strips region code suffix', () => {
    const path = 'fragments/header/index.pt-br.html'
    const fallback = path.replace(/\/index\.[a-z-]+\.html$/, '/index.html')
    expect(fallback).toBe('fragments/header/index.html')
  })
})

// ---------------------------------------------------------------------------
// Real worker with the options the generated entry embeds (#1138)
// ---------------------------------------------------------------------------

interface FakeBucket {
  bucket: { get(key: string): Promise<unknown> }
}

function fakeBucket(seed: Record<string, string>): FakeBucket {
  const files = new Map(Object.entries(seed))
  return {
    bucket: {
      async get(key) {
        const value = files.get(key)
        if (value === undefined) return null
        return {
          async text() {
            return value
          },
        }
      },
    },
  }
}

describe('createWorker with embedded site locales', () => {
  const originalCaches = (globalThis as { caches?: unknown }).caches

  beforeEach(() => {
    Object.defineProperty(globalThis, 'caches', {
      configurable: true,
      writable: true,
      value: { default: { match: async () => undefined, put: async () => {} } },
    })
  })

  afterEach(() => {
    if (originalCaches) Object.defineProperty(globalThis, 'caches', originalCaches)
    else delete (globalThis as { caches?: unknown }).caches
  })

  it('serves a non-default language page', async () => {
    const { bucket } = fakeBucket({
      'pages/home/index.html': '<!DOCTYPE html><html><body>Home</body></html>',
      'pages/about/index.html': '<!DOCTYPE html><html><body>About</body></html>',
      'pages/about/index.fr.html': '<!DOCTYPE html><html><body>\u00c0 propos</body></html>',
    })
    const app = createWorker({ locales: ['en', 'fr'], defaultLocale: 'en', defaultPrefix: false })

    const res = await app.fetch(
      new Request('https://example.com/fr/about'),
      { SITE_BUCKET: bucket } as never,
      { waitUntil: () => {}, passThroughOnException: () => {} } as never,
    )
    expect(res.status).toBe(200)
    expect(await res.text()).toContain('\u00c0 propos')
  })
})
