import { describe, it, expect } from 'vitest'
import { createServer } from '../src/serve.js'
import { isPublicSitePath } from '../src/public-site-path.js'
import type { ByteRange, DirEntry, StorageProvider } from '../src/types.js'

function memoryStorage(files: Record<string, string>): StorageProvider {
  const map = new Map(Object.entries(files))
  // Storage keys are root-relative without a leading slash; the static
  // route passes `requestPath.slice(1)` and `{path}/index.html`.
  const key = (path: string) => path.replace(/^\/+/, '')
  return {
    readFile: async path => {
      const content = map.get(key(path))
      if (content === undefined) throw new Error(`not found: ${path}`)
      return content
    },
    readDir: async (): Promise<DirEntry[]> => [],
    exists: async path => map.has(key(path)),
    writeFile: async (path, content) => void map.set(key(path), content),
    mkdir: async () => {},
    rm: async path => void map.delete(key(path)),
    readBytes: async path => {
      const content = map.get(key(path))
      if (content === undefined) throw new Error(`not found: ${path}`)
      return new TextEncoder().encode(content)
    },
    writeBytes: async (path, content) => void map.set(path, new TextDecoder().decode(content)),
    readStream: async (path, _range?: ByteRange) => {
      const content = map.get(key(path))
      if (content === undefined) throw new Error(`not found: ${path}`)
      return new ReadableStream({
        start: c => {
          c.enqueue(new TextEncoder().encode(content))
          c.close()
        },
      })
    },
    writeStream: async () => {},
  }
}

const AUDIT = '{"actor":"admin@example.com","action":"publish"}'

function staticApp() {
  return createServer({
    storage: memoryStorage({
      'index.html': '<h1>Home</h1>',
      'about/index.html': '<h1>About</h1>',
      'assets/hero-ab12cd34.jpg': 'JPEG-BYTES',
      '.well-known/security.txt': 'Contact: mailto:security@example.com',
      '.gazetta/audit/events-a.jsonl': AUDIT,
      'pages/home/.cf120e4b.hash': 'cf120e4b',
      'pages/home/page.json': '{"reviewState":"draft"}',
      'pages/home/page.fr.json': '{"reviewState":"draft"}',
      'pages/home/page.foo.bar.json': '{"reviewState":"draft"}',
      'assets/hero.asset.json': '{"uploadedBy":"admin@example.com"}',
    }),
    type: 'static',
  })
}

describe('static serve keeps private storage private', () => {
  it.each([
    '/.gazetta/audit/events-a.jsonl',
    '/pages/%2e%2e/.gazetta/audit/events-a.jsonl',
    '/fragments/%2E%2E/.gazetta/audit/events-a.jsonl',
  ])('GET %s returns 404 without the file content', async url => {
    const res = await staticApp().request(url)
    expect(res.status).toBe(404)
    expect(await res.text()).not.toContain(AUDIT)
  })

  it('returns 404 for a per-item sidecar', async () => {
    const res = await staticApp().request('/pages/home/.cf120e4b.hash')
    expect(res.status).toBe(404)
    expect(await res.text()).not.toContain('cf120e4b')
  })

  it('still serves the root page and nested index.html pages', async () => {
    const root = await staticApp().request('/')
    expect(root.status).toBe(200)
    expect(await root.text()).toContain('Home')
    const about = await staticApp().request('/about')
    expect(about.status).toBe(200)
    expect(await about.text()).toContain('About')
  })

  it('serves /.well-known/ files', async () => {
    const res = await staticApp().request('/.well-known/security.txt')
    expect(res.status).toBe(200)
    expect(await res.text()).toContain('security@example.com')
  })

  it.each([
    { url: '/pages/home/page.json', marker: 'reviewState' },
    { url: '/pages/home/page.fr.json', marker: 'reviewState' },
    { url: '/pages/home/page.foo.bar.json', marker: 'reviewState' },
    { url: '/assets/hero.asset.json', marker: 'uploadedBy' },
  ])('GET $url returns 404 without the manifest content', async ({ url, marker }) => {
    const res = await staticApp().request(url)
    expect(res.status).toBe(404)
    expect(await res.text()).not.toContain(marker)
  })

  it('returns 404 for a case variant of a manifest name', async () => {
    // Case-insensitive volumes resolve PAGE.JSON to the stored page.json.
    const res = await staticApp().request('/pages/home/PAGE.JSON')
    expect(res.status).toBe(404)
    expect(await res.text()).not.toContain('reviewState')
  })

  it('serves a normal asset', async () => {
    const res = await staticApp().request('/assets/hero-ab12cd34.jpg')
    expect(res.status).toBe(200)
    expect(await res.text()).toBe('JPEG-BYTES')
  })
})

describe('isPublicSitePath', () => {
  it.each([
    ['.gazetta/audit/events-a.jsonl'],
    ['/.gazetta/history/pages/home/abc123.html'],
    ['/pages/home/.cf120e4b.hash'],
    ['/pages/home/.pub-20261022'],
    ['/nested/.x/file.html'],
    ['/.well-known/.env'],
    ['/pages/home/page.json'],
    ['/pages/home/page.fr.json'],
    ['/pages/home/page.foo.bar.json'],
    ['/fragments/header/fragment.json'],
    ['/assets/hero.asset.json'],
    ['/assets/hero.asset.fr.json'],
    ['/pages/home/PAGE.JSON'],
    ['/assets/hero.Asset.JSON'],
  ])('private: %s', path => {
    expect(isPublicSitePath(path)).toBe(false)
  })

  it.each([
    ['/'],
    ['/about'],
    ['/pages/home/index.html'],
    ['/.well-known/security.txt'],
    ['/.well-known/acme-challenge/token-123'],
    ['/assets/hero-ab12cd34.jpg'],
    ['/feeds/page.jsonl'],
  ])('public: %s', path => {
    expect(isPublicSitePath(path)).toBe(true)
  })
})
