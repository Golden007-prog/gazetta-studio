import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { join } from 'node:path'
import { mkdir, writeFile, rm } from 'node:fs/promises'
import { extractLocale, matchAcceptLanguage, findPage, createServer, serveLocaleOptions } from '../src/serve.js'
import { createFilesystemProvider } from '../src/providers/filesystem.js'
import { memoryStorage } from './_helpers/memory-storage.js'
import { tempDir } from './_helpers/temp.js'

// ---------------------------------------------------------------------------
// extractLocale (pure, no I/O)
// ---------------------------------------------------------------------------

describe('extractLocale', () => {
  const locales = ['fr', 'de', 'pt-br']

  it('returns undefined locale for default path', () => {
    expect(extractLocale('/about', locales)).toEqual({ locale: undefined, path: '/about' })
  })

  it('extracts known locale prefix', () => {
    expect(extractLocale('/fr/about', locales)).toEqual({ locale: 'fr', path: '/about' })
  })

  it('extracts region locale prefix', () => {
    expect(extractLocale('/pt-br/about', locales)).toEqual({ locale: 'pt-br', path: '/about' })
  })

  it('handles root with locale', () => {
    expect(extractLocale('/fr', locales)).toEqual({ locale: 'fr', path: '/' })
  })

  it('ignores unknown locale prefix', () => {
    expect(extractLocale('/es/about', locales)).toEqual({ locale: undefined, path: '/es/about' })
  })

  it('returns identity for empty locales list', () => {
    expect(extractLocale('/fr/about', [])).toEqual({ locale: undefined, path: '/fr/about' })
  })

  it('handles root path without locale', () => {
    expect(extractLocale('/', locales)).toEqual({ locale: undefined, path: '/' })
  })

  it('handles deep paths', () => {
    expect(extractLocale('/de/blog/hello-world', locales)).toEqual({ locale: 'de', path: '/blog/hello-world' })
  })
})

// ---------------------------------------------------------------------------
// matchAcceptLanguage (pure, no I/O)
// ---------------------------------------------------------------------------

describe('matchAcceptLanguage', () => {
  const locales = ['en', 'fr', 'de']

  it('returns exact match', () => {
    expect(matchAcceptLanguage('fr', locales)).toBe('fr')
  })

  it('returns base language match', () => {
    expect(matchAcceptLanguage('fr-FR,fr;q=0.9,en;q=0.8', locales)).toBe('fr')
  })

  it('respects quality ordering', () => {
    expect(matchAcceptLanguage('en;q=0.5,de;q=0.9', locales)).toBe('de')
  })

  it('returns undefined when no match', () => {
    expect(matchAcceptLanguage('ja,zh;q=0.9', locales)).toBeUndefined()
  })

  it('returns undefined for empty header', () => {
    expect(matchAcceptLanguage(undefined, locales)).toBeUndefined()
  })

  it('returns undefined for empty locales', () => {
    expect(matchAcceptLanguage('fr', [])).toBeUndefined()
  })

  it('handles complex Accept-Language header', () => {
    expect(matchAcceptLanguage('en-US,en;q=0.9,fr;q=0.8,de;q=0.7', locales)).toBe('en')
  })

  it('falls back to base language when region not in list', () => {
    expect(matchAcceptLanguage('de-AT', locales)).toBe('de')
  })
})

// ---------------------------------------------------------------------------
// findPage with locale support (I/O against temp filesystem)
// ---------------------------------------------------------------------------

describe('findPage', () => {
  const dir = tempDir('serve-locale-findpage-' + Date.now())

  beforeEach(async () => {
    await mkdir(join(dir, 'pages/home'), { recursive: true })
    await mkdir(join(dir, 'pages/about'), { recursive: true })
    await writeFile(join(dir, 'pages/home/index.html'), '<html>Home EN</html>')
    await writeFile(join(dir, 'pages/home/index.fr.html'), '<html>Home FR</html>')
    await writeFile(join(dir, 'pages/about/index.html'), '<html>About EN</html>')
  })

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true })
  })

  it('finds default page without locales', async () => {
    const storage = createFilesystemProvider(dir)
    const result = await findPage(storage, '/')
    expect(result).not.toBeNull()
    expect(result!.html).toContain('Home EN')
    expect(result!.locale).toBeUndefined()
  })

  it('finds locale-suffixed page', async () => {
    const storage = createFilesystemProvider(dir)
    const result = await findPage(storage, '/fr', ['fr', 'de'])
    expect(result).not.toBeNull()
    expect(result!.html).toContain('Home FR')
    expect(result!.locale).toBe('fr')
  })

  it('falls back to default when locale file missing', async () => {
    const storage = createFilesystemProvider(dir)
    const result = await findPage(storage, '/fr/about', ['fr', 'de'])
    expect(result).not.toBeNull()
    expect(result!.html).toContain('About EN')
    expect(result!.locale).toBe('fr')
  })

  it('returns null for missing page', async () => {
    const storage = createFilesystemProvider(dir)
    const result = await findPage(storage, '/nonexistent')
    expect(result).toBeNull()
  })

  it('finds dynamic route pages', async () => {
    const storage = createFilesystemProvider(dir)
    await mkdir(join(dir, 'pages/blog/[slug]'), { recursive: true })
    await writeFile(join(dir, 'pages/blog/[slug]/index.html'), '<html>Blog EN</html>')
    await writeFile(join(dir, 'pages/blog/[slug]/index.fr.html'), '<html>Blog FR</html>')

    const result = await findPage(storage, '/fr/blog/hello', ['fr'])
    expect(result).not.toBeNull()
    expect(result!.html).toContain('Blog FR')
    expect(result!.locale).toBe('fr')
  })

  it('dynamic route falls back to default locale', async () => {
    const storage = createFilesystemProvider(dir)
    await mkdir(join(dir, 'pages/blog/[slug]'), { recursive: true })
    await writeFile(join(dir, 'pages/blog/[slug]/index.html'), '<html>Blog EN</html>')

    const result = await findPage(storage, '/de/blog/hello', ['fr', 'de'])
    expect(result).not.toBeNull()
    expect(result!.html).toContain('Blog EN')
    expect(result!.locale).toBe('de')
  })
})

// ---------------------------------------------------------------------------
// Accept-Language redirect integration
// ---------------------------------------------------------------------------

describe('Accept-Language redirect', () => {
  const dir = tempDir('serve-locale-redirect-' + Date.now())

  beforeEach(async () => {
    await mkdir(join(dir, 'pages/home'), { recursive: true })
    await writeFile(join(dir, 'pages/home/index.html'), '<!--cache:browser=0,edge=0--><html>Home</html>')
    await writeFile(join(dir, 'pages/home/index.fr.html'), '<!--cache:browser=0,edge=0--><html>Accueil</html>')
  })

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true })
  })

  it('redirects to best locale match', async () => {
    const storage = createFilesystemProvider(dir)
    const app = createServer({ storage, locales: ['en', 'fr'], defaultLocale: 'en', detection: true })
    const res = await app.request('/', { headers: { 'Accept-Language': 'fr-FR,fr;q=0.9,en;q=0.8' } })
    expect(res.status).toBe(302)
    expect(res.headers.get('Location')).toBe('/fr')
  })

  it('does not redirect when Accept-Language matches default', async () => {
    const storage = createFilesystemProvider(dir)
    const app = createServer({ storage, locales: ['en', 'fr'], defaultLocale: 'en', detection: true })
    const res = await app.request('/', { headers: { 'Accept-Language': 'en-US,en;q=0.9' } })
    expect(res.status).toBe(200)
  })

  it('does not redirect when no Accept-Language', async () => {
    const storage = createFilesystemProvider(dir)
    const app = createServer({ storage, locales: ['en', 'fr'], defaultLocale: 'en', detection: true })
    const res = await app.request('/')
    expect(res.status).toBe(200)
  })

  it('does not redirect locale-prefixed paths', async () => {
    const storage = createFilesystemProvider(dir)
    const app = createServer({ storage, locales: ['en', 'fr'], defaultLocale: 'en', detection: true })
    const res = await app.request('/fr', { headers: { 'Accept-Language': 'de' } })
    expect(res.status).toBe(200)
    expect(await res.text()).toContain('Accueil')
  })

  it('does not redirect when detection is disabled', async () => {
    const storage = createFilesystemProvider(dir)
    const app = createServer({ storage, locales: ['en', 'fr'], defaultLocale: 'en', detection: false })
    const res = await app.request('/', { headers: { 'Accept-Language': 'fr-FR' } })
    expect(res.status).toBe(200)
  })

  it('respects locale cookie over Accept-Language', async () => {
    const storage = createFilesystemProvider(dir)
    const app = createServer({ storage, locales: ['en', 'fr'], defaultLocale: 'en', detection: true })
    const res = await app.request('/', {
      headers: { 'Accept-Language': 'de', Cookie: 'locale=fr' },
    })
    expect(res.status).toBe(302)
    expect(res.headers.get('Location')).toBe('/fr')
  })
})

// ---------------------------------------------------------------------------
// Fragment locale fallback (integration via createServer)
// ---------------------------------------------------------------------------

describe('fragment locale fallback', () => {
  const dir = tempDir('serve-locale-fragment-' + Date.now())

  beforeEach(async () => {
    await mkdir(join(dir, 'pages/home'), { recursive: true })
    await mkdir(join(dir, 'fragments/header'), { recursive: true })
    // Page with ESI placeholder referencing locale fragment
    await writeFile(
      join(dir, 'pages/home/index.fr.html'),
      '<!--cache:browser=0,edge=0--><!DOCTYPE html><html><head><!--esi-head:/fragments/header/index.fr.html--></head><body><!--esi:/fragments/header/index.fr.html--></body></html>',
    )
    // Only default fragment exists (no French)
    await writeFile(
      join(dir, 'fragments/header/index.html'),
      '<head><style>h1{}</style></head><header>Header EN</header>',
    )
  })

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true })
  })

  it('falls back to default fragment when locale file missing', async () => {
    const storage = createFilesystemProvider(dir)
    const app = createServer({ storage, locales: ['en', 'fr'], defaultLocale: 'en' })
    const res = await app.request('/fr')
    expect(res.status).toBe(200)
    const html = await res.text()
    expect(html).toContain('Header EN')
  })

  it('uses locale fragment when it exists', async () => {
    const storage = createFilesystemProvider(dir)
    await writeFile(join(dir, 'fragments/header/index.fr.html'), '<head></head><header>Header FR</header>')
    const app = createServer({ storage, locales: ['en', 'fr'], defaultLocale: 'en' })
    const res = await app.request('/fr')
    expect(res.status).toBe(200)
    const html = await res.text()
    expect(html).toContain('Header FR')
    expect(html).not.toContain('Header EN')
  })
})

// ---------------------------------------------------------------------------
// serveLocaleOptions — the `gazetta serve` CLI entry point passes the site's
// resolved locales to createServer (#1138)
// ---------------------------------------------------------------------------

describe('serveLocaleOptions', () => {
  it('maps the site manifest locales to serve options', () => {
    expect(
      serveLocaleOptions({
        name: 'test',
        locales: { supported: ['en', 'fr'], default: 'en', defaultPrefix: false, detection: true },
      }),
    ).toEqual({ locales: ['en', 'fr'], defaultLocale: 'en', defaultPrefix: false, detection: true })
  })

  it('returns empty options when the site has no locales config', () => {
    expect(serveLocaleOptions({ name: 'test' })).toEqual({})
  })

  it('serves a non-default language page on a dynamic target', async () => {
    const storage = memoryStorage()
    storage.seed({
      'pages/home/index.html': '<!DOCTYPE html><html><body>Home</body></html>',
      'pages/about/index.html': '<!DOCTYPE html><html><body>About</body></html>',
      'pages/about/index.fr.html': '<!DOCTYPE html><html><body>\u00c0 propos</body></html>',
    })
    const app = createServer({
      storage,
      type: 'dynamic',
      ...serveLocaleOptions({ name: 'test', locales: { supported: ['en', 'fr'], default: 'en' } }),
    })

    const res = await app.request('http://localhost/fr/about')
    expect(res.status).toBe(200)
    expect(await res.text()).toContain('\u00c0 propos')
  })
})

describe('detection with defaultPrefix', () => {
  it('does not treat the default locale prefix as unlocalized', async () => {
    const storage = memoryStorage()
    storage.seed({
      'pages/about/index.en.html': '<!DOCTYPE html><html><body>About EN</body></html>',
      'pages/about/index.fr.html': '<!DOCTYPE html><html><body>\u00c0 propos</body></html>',
    })
    const app = createServer({
      storage,
      type: 'dynamic',
      locales: ['en', 'fr'],
      defaultLocale: 'en',
      defaultPrefix: true,
      detection: true,
    })

    const res = await app.request('http://localhost/en/about', { headers: { Cookie: 'locale=fr' } })
    expect(res.status).toBe(200)
    expect(await res.text()).toContain('About EN')
  })
})
