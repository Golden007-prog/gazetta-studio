import { describe, it, expect } from 'vitest'
import { createServer } from '../src/serve.js'
import { archiveMarker } from '../src/runtime/archive-marker.js'
import { memoryStorage } from './_helpers/memory-storage.js'

const ARCHIVE_CACHE_CONTROL = 'max-age=300'
const LIVE_PAGE = '<!DOCTYPE html><html><body>Live page</body></html>'

function buildServer(seed: Record<string, string>, type: 'dynamic' | 'static' = 'dynamic') {
  const storage = memoryStorage()
  storage.seed(seed)
  return createServer({ storage, type })
}

function buildLocaleServer(seed: Record<string, string>) {
  const storage = memoryStorage()
  storage.seed(seed)
  return createServer({ storage, type: 'dynamic', locales: ['en', 'fr'], defaultLocale: 'en' })
}

function esiSeed(): Record<string, string> {
  return {
    'pages/home/index.html': LIVE_PAGE,
    'pages/live/index.html': `<!--cache:browser=60,edge=300-->\n${LIVE_PAGE}`,
    // Marker pages include an ESI reference: the archive response must be
    // returned before fragment composition runs.
    'pages/about/index.html':
      archiveMarker({ kind: 'alias', target: 'home' }) + '<!--esi:/fragments/header/index.html-->',
    'pages/legacy/index.html': archiveMarker({ kind: 'gone' }),
    'pages/old-docs/index.html': archiveMarker({ kind: 'alias', target: 'blog/[slug]' }),
    'pages/blog/[café]/index.html': archiveMarker({ kind: 'alias', target: 'posts/[café]' }),
    'pages/cafe/index.html': archiveMarker({ kind: 'alias', target: 'café' }),
    'pages/café/index.html': LIVE_PAGE,
    'pages/with-aliased-fragment/index.html':
      '<html><head></head><body>Page<!--esi:/fragments/old-header/index.html--></body></html>',
    'pages/with-gone-fragment/index.html':
      '<html><head></head><body>Page<!--esi:/fragments/gone-header/index.html--></body></html>',
    'pages/with-unresolved-fragment/index.html':
      '<html><head></head><body>Page<!--esi:/fragments/broken-header/index.html--></body></html>',
    'fragments/header/index.html': '<head><style>.header{color:red}</style></head><body>Header</body>',
    'fragments/old-header/index.html': archiveMarker({ kind: 'alias', target: 'header' }),
    'fragments/gone-header/index.html': archiveMarker({ kind: 'gone' }),
    'fragments/broken-header/index.html': archiveMarker({ kind: 'alias', target: 'missing-header' }),
    // Marker beyond the 200-byte detection window — not an archive marker.
    'pages/late/index.html': `${'x'.repeat(240)}\n${archiveMarker({ kind: 'gone' })}`,
    // Marker-like text inside a live page — not at byte 0.
    'pages/mention/index.html': '<p>Docs mention <!-- gazetta:archived alias=home --> inline</p>',
  }
}

describe('serve archive markers (dynamic/ESI)', () => {
  it('redirects an aliased page to the derived route of its target', async () => {
    const app = buildServer(esiSeed())
    const res = await app.request('http://localhost/about')

    expect(res.status).toBe(301)
    expect(res.headers.get('location')).toBe('/')
    expect(res.headers.get('cache-control')).toBe(ARCHIVE_CACHE_CONTROL)
  })

  it('answers 410 for a plain page whose alias route needs a parameter', async () => {
    const app = buildServer(esiSeed())
    const res = await app.request('http://localhost/old-docs')

    expect(res.status).toBe(410)
  })

  it('redirects an archived dynamic page filling a non-ASCII param name', async () => {
    const app = buildServer(esiSeed())
    const res = await app.request('http://localhost/blog/x')

    expect(res.status).toBe(301)
    expect(res.headers.get('location')).toBe('/posts/x')
  })

  it('percent-encodes non-Latin-1 alias targets', async () => {
    const app = buildServer(esiSeed())
    const res = await app.request('http://localhost/cafe')

    expect(res.status).toBe(301)
    expect(res.headers.get('location')).toBe('/caf%C3%A9')
  })

  it('handles a direct page index path through the asset route', async () => {
    const app = buildServer(esiSeed())
    const res = await app.request('http://localhost/pages/about/index.html')

    expect(res.status).toBe(301)
    expect(res.headers.get('location')).toBe('/')
    expect(res.headers.get('cache-control')).toBe(ARCHIVE_CACHE_CONTROL)
  })

  it('follows an archived fragment alias while composing ESI', async () => {
    const app = buildServer(esiSeed())
    const res = await app.request('http://localhost/with-aliased-fragment')

    expect(res.status).toBe(200)
    const body = await res.text()
    expect(body).toContain('Header')
    expect(body).not.toContain('gazetta:archived')
  })

  it('omits an ESI fragment archived without an alias', async () => {
    const app = buildServer(esiSeed())
    const res = await app.request('http://localhost/with-gone-fragment')

    expect(res.status).toBe(200)
    const body = await res.text()
    expect(body).toContain('Page')
    expect(body).toContain('<!-- fragment archived: @gone-header -->')
    expect(body).not.toContain('gazetta:archived')
  })

  it('omits an ESI fragment whose alias target does not resolve', async () => {
    const app = buildServer(esiSeed())
    const res = await app.request('http://localhost/with-unresolved-fragment')

    expect(res.status).toBe(200)
    const body = await res.text()
    expect(body).toContain('<!-- fragment archived: @broken-header -->')
    expect(body).not.toContain('gazetta:archived')
  })

  it('returns 410 Gone for a gone page', async () => {
    const app = buildServer(esiSeed())
    const res = await app.request('http://localhost/legacy')

    expect(res.status).toBe(410)
    expect(res.headers.get('cache-control')).toBe(ARCHIVE_CACHE_CONTROL)
  })

  it('leaves live pages untouched', async () => {
    const app = buildServer(esiSeed())
    const res = await app.request('http://localhost/')

    expect(res.status).toBe(200)
    expect(await res.text()).toContain('Live page')
    expect(res.headers.get('location')).toBeNull()
  })

  it('preserves ETag/304 behavior for live pages', async () => {
    const app = buildServer(esiSeed())
    const first = await app.request('http://localhost/live')
    expect(first.status).toBe(200)
    const etag = first.headers.get('etag')
    expect(etag).toBeTruthy()

    const second = await app.request('http://localhost/live', { headers: { 'If-None-Match': etag! } })
    expect(second.status).toBe(304)
  })

  it('ignores markers beyond the first 200 bytes', async () => {
    const app = buildServer(esiSeed())
    const res = await app.request('http://localhost/late')

    expect(res.status).toBe(200)
    expect(await res.text()).toContain('gazetta:archived gone')
  })

  it('ignores marker-like text that is not the first line', async () => {
    const app = buildServer(esiSeed())
    const res = await app.request('http://localhost/mention')

    expect(res.status).toBe(200)
    expect(await res.text()).toContain('Docs mention')
  })
})

describe('serve archived 404 fallback', () => {
  it('returns the built-in 404 instead of an archived 404 marker', async () => {
    const seed = esiSeed()
    seed['pages/404/index.html'] = archiveMarker({ kind: 'alias', target: 'home' })
    const app = buildServer(seed)

    const res = await app.request('http://localhost/missing')

    expect(res.status).toBe(404)
    const body = await res.text()
    expect(body).toContain('Page not found')
    expect(body).not.toContain('gazetta:archived')
  })
})

describe('serve archive markers (localized)', () => {
  it('honors archive markers on locale-suffixed files', async () => {
    const seed = esiSeed()
    seed['pages/about/index.fr.html'] = archiveMarker({ kind: 'alias', target: 'home' })
    const app = buildLocaleServer(seed)

    const res = await app.request('http://localhost/fr/about')
    expect(res.status).toBe(301)
    expect(res.headers.get('location')).toBe('/fr')
    expect(res.headers.get('cache-control')).toBe(ARCHIVE_CACHE_CONTROL)
  })

  it('falls back to the first locale when defaultLocale is omitted', async () => {
    const seed = esiSeed()
    seed['pages/about/index.fr.html'] = archiveMarker({ kind: 'alias', target: 'home' })
    const storage = memoryStorage()
    storage.seed(seed)
    const app = createServer({ storage, type: 'dynamic', locales: ['en', 'fr'] })

    const res = await app.request('http://localhost/fr/about')
    expect(res.status).toBe(301)
    expect(res.headers.get('location')).toBe('/fr')
  })

  it('keeps the default-prefix locale on alias redirects', async () => {
    const seed = esiSeed()
    seed['pages/about/index.en.html'] = archiveMarker({ kind: 'alias', target: 'home' })
    const storage = memoryStorage()
    storage.seed(seed)
    const app = createServer({
      storage,
      type: 'dynamic',
      locales: ['en', 'fr'],
      defaultLocale: 'en',
      defaultPrefix: true,
    })

    const res = await app.request('http://localhost/en/about')
    expect(res.status).toBe(301)
    expect(res.headers.get('location')).toBe('/en')
  })

  it('keeps locale fallback for live pages without a locale file', async () => {
    const seed = esiSeed()
    seed['pages/guides/index.html'] = '<!DOCTYPE html><html><body>Guides EN</body></html>'
    const app = buildLocaleServer(seed)

    const res = await app.request('http://localhost/fr/guides')
    expect(res.status).toBe(200)
    expect(await res.text()).toContain('Guides EN')
    expect(res.headers.get('set-cookie')).toContain('locale=fr')
  })
})

describe('serve archive markers (static, localized)', () => {
  // Static targets store each language's version at the language's route.
  function buildStaticLocaleServer(seed: Record<string, string>) {
    const storage = memoryStorage()
    storage.seed(seed)
    return createServer({ storage, type: 'static', locales: ['en', 'fr'], defaultLocale: 'en' })
  }

  it('redirects to the destination default-language page when it has no version in the request language', async () => {
    const app = buildStaticLocaleServer({
      '/welcome/index.html': LIVE_PAGE,
      '/fr/landing/index.html': archiveMarker({ kind: 'alias', target: 'welcome' }),
    })

    const res = await app.request('http://localhost/fr/landing')
    expect(res.status).toBe(301)
    expect(res.headers.get('location')).toBe('/welcome')
    expect(res.headers.get('cache-control')).toBe(ARCHIVE_CACHE_CONTROL)
  })

  it('keeps the request language when the destination has a version in it', async () => {
    const app = buildStaticLocaleServer({
      '/welcome/index.html': LIVE_PAGE,
      '/fr/welcome/index.html': LIVE_PAGE,
      '/fr/landing/index.html': archiveMarker({ kind: 'alias', target: 'welcome' }),
    })

    const res = await app.request('http://localhost/fr/landing')
    expect(res.status).toBe(301)
    expect(res.headers.get('location')).toBe('/fr/welcome')
    expect(res.headers.get('cache-control')).toBe(ARCHIVE_CACHE_CONTROL)
  })

  it('does not prefix the default language on static targets with defaultPrefix on', async () => {
    // Static publish writes default-language pages unprefixed until #1146.
    const storage = memoryStorage()
    storage.seed({
      '/welcome/index.html': LIVE_PAGE,
      '/fr/landing/index.html': archiveMarker({ kind: 'alias', target: 'welcome' }),
    })
    const app = createServer({
      storage,
      type: 'static',
      locales: ['en', 'fr'],
      defaultLocale: 'en',
      defaultPrefix: true,
    })

    const res = await app.request('http://localhost/fr/landing')
    expect(res.status).toBe(301)
    expect(res.headers.get('location')).toBe('/welcome')
  })

  it('still keeps the request language with defaultPrefix on when the destination version exists', async () => {
    const storage = memoryStorage()
    storage.seed({
      '/welcome/index.html': LIVE_PAGE,
      '/fr/welcome/index.html': LIVE_PAGE,
      '/fr/landing/index.html': archiveMarker({ kind: 'alias', target: 'welcome' }),
    })
    const app = createServer({
      storage,
      type: 'static',
      locales: ['en', 'fr'],
      defaultLocale: 'en',
      defaultPrefix: true,
    })

    const res = await app.request('http://localhost/fr/landing')
    expect(res.status).toBe(301)
    expect(res.headers.get('location')).toBe('/fr/welcome')
  })
})

describe('serve archive markers (static)', () => {
  function staticSeed(): Record<string, string> {
    return {
      'index.html': LIVE_PAGE,
      // static serve builds non-root paths with a leading slash.
      '/about/index.html': archiveMarker({ kind: 'alias', target: 'home' }),
      '/legacy/index.html': archiveMarker({ kind: 'gone' }),
      // Explicit /about/index.html falls back to the extensionless key.
      'about/index.html': archiveMarker({ kind: 'alias', target: 'home' }),
    }
  }

  it('redirects an aliased static page', async () => {
    const app = buildServer(staticSeed(), 'static')
    const res = await app.request('http://localhost/about')

    expect(res.status).toBe(301)
    expect(res.headers.get('location')).toBe('/')
    expect(res.headers.get('cache-control')).toBe(ARCHIVE_CACHE_CONTROL)
  })

  it('returns 410 for a gone static page', async () => {
    const app = buildServer(staticSeed(), 'static')
    const res = await app.request('http://localhost/legacy')

    expect(res.status).toBe(410)
    expect(res.headers.get('cache-control')).toBe(ARCHIVE_CACHE_CONTROL)
  })

  it('leaves live static pages untouched', async () => {
    const app = buildServer(staticSeed(), 'static')
    const res = await app.request('http://localhost/')

    expect(res.status).toBe(200)
    expect(await res.text()).toContain('Live page')
  })

  it('handles explicit /index.html archive paths', async () => {
    const app = buildServer(staticSeed(), 'static')
    const res = await app.request('http://localhost/about/index.html')

    expect(res.status).toBe(301)
    expect(res.headers.get('location')).toBe('/')
    expect(res.headers.get('cache-control')).toBe(ARCHIVE_CACHE_CONTROL)
  })
})

describe('serve archived dynamic-route aliases (#1126)', () => {
  const dynamicAliasSeed = (): Record<string, string> => ({
    'pages/blog/[slug]/index.html': archiveMarker({ kind: 'alias', target: 'posts/[slug]' }),
    'pages/news/[slug]/index.html': archiveMarker({ kind: 'alias', target: 'posts/[year]/[slug]' }),
  })

  it('redirects to the alias route with the captured params filled', async () => {
    const app = buildServer(dynamicAliasSeed())
    const res = await app.request('http://localhost/blog/hello')

    expect(res.status).toBe(301)
    expect(res.headers.get('location')).toBe('/posts/hello')
    expect(res.headers.get('cache-control')).toBe(ARCHIVE_CACHE_CONTROL)
  })

  it('keeps the request locale on the filled alias route', async () => {
    const seed = dynamicAliasSeed()
    seed['pages/blog/[slug]/index.fr.html'] = seed['pages/blog/[slug]/index.html']
    const app = buildLocaleServer(seed)

    const res = await app.request('http://localhost/fr/blog/hello')

    expect(res.status).toBe(301)
    expect(res.headers.get('location')).toBe('/fr/posts/hello')
  })

  it('answers 410 when an alias route segment has no captured value', async () => {
    const app = buildServer(dynamicAliasSeed())
    const res = await app.request('http://localhost/news/hello')

    expect(res.status).toBe(410)
    expect(res.headers.get('cache-control')).toBe(ARCHIVE_CACHE_CONTROL)
  })

  it('inserts an encoded slug without encoding it a second time', async () => {
    const app = buildServer(dynamicAliasSeed())
    const res = await app.request('http://localhost/blog/h%C3%A9llo')

    expect(res.status).toBe(301)
    expect(res.headers.get('location')).toBe('/posts/h%C3%A9llo')
  })

  it('answers 410 for a plain page archived with a parameterized alias', async () => {
    const app = buildServer({
      'pages/promo/index.html': archiveMarker({ kind: 'alias', target: 'posts/[slug]' }),
    })
    const res = await app.request('http://localhost/promo')

    expect(res.status).toBe(410)
    expect(res.headers.get('cache-control')).toBe(ARCHIVE_CACHE_CONTROL)
  })
})
