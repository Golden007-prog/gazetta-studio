/**
 * All tests that require Docker (MinIO + Azurite via docker-compose).
 * Docker-compose starts once, shared across all describe blocks.
 *
 * `npm test` runs this file in its own vitest pass, after the rest of the
 * admin suite (apps/admin/package.json). Run alongside the other files,
 * MinIO competes with vitest's workers for the runner's CPU and drops or
 * stalls connections (`socket hang up`, `ECONNRESET`, 5 s timeouts):
 * 7 failures in 160 CI runs alongside, 0 in 108 run alone (#879, #880).
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import { resolve } from 'node:path'
import { DockerComposeEnvironment, type StartedDockerComposeEnvironment } from 'testcontainers'
import {
  createFilesystemProvider,
  createContentRoot,
  loadSite,
  loadSiteConfig,
  siteConfigToManifest,
  type Site,
} from 'gazetta'
import { createS3Provider } from 'gazetta/providers/s3'
import { createAzureBlobProvider } from 'gazetta/providers/azure-blob'
import { publishItems, resolveDependencies } from 'gazetta'
import { publishPageRendered, publishFragmentRendered, publishSiteManifest } from 'gazetta'
import { runProviderConformance } from './_helpers/provider-conformance.js'
import { retryOnTransient } from './_helpers/retry-transient.js'

const projectRoot = resolve(import.meta.dirname, '../../../examples/starter')
const starterSiteDir = resolve(projectRoot, 'sites/main')
// Content lives under the local target (post-transformation layout).
const starterDir = resolve(starterSiteDir, 'targets/local')
const templatesDir = resolve(projectRoot, 'templates')

let _site: Site | null = null
async function getStarterSite(): Promise<Site> {
  if (_site) return _site
  const loaded = await loadSiteConfig(starterSiteDir)
  if (!loaded) throw new Error(`No site.config.ts at ${starterSiteDir}`)
  const manifest = siteConfigToManifest(loaded.config)
  _site = await loadSite({ siteDir: starterDir, storage: createFilesystemProvider(), templatesDir, manifest })
  return _site
}
const composeDir = resolve(import.meta.dirname, '../../..')

let env: StartedDockerComposeEnvironment
let minioEndpoint: string
let azuriteConnectionString: string

beforeAll(async () => {
  env = await new DockerComposeEnvironment(composeDir, 'docker-compose.yml').up()

  // Ports are unmapped in docker-compose.yml so parallel test runs /
  // locally-running Azurite don't collide on the fixed 10000 / 9000.
  // Discover the actual host-bound ports via testcontainers.
  const minio = env.getContainer('minio-1')
  minioEndpoint = `http://localhost:${minio.getMappedPort(9000)}`

  const azurite = env.getContainer('azurite-1')
  const blobPort = azurite.getMappedPort(10000)
  const queuePort = azurite.getMappedPort(10001)
  const tablePort = azurite.getMappedPort(10002)
  // Full dev connection string (what `UseDevelopmentStorage=true`
  // expands to internally), with the discovered host ports.
  // AccountName/AccountKey are the well-known Azurite dev credentials.
  const accountName = 'devstoreaccount1'
  const accountKey = 'Eby8vdM02xNOcqFlqUwJPLlmEtlCDXJ1OUzFT50uSRZ6IFsuFq2UVErCz4I6tq/K1SZFPTOtr/KBHBeksoGMGw=='
  azuriteConnectionString =
    `DefaultEndpointsProtocol=http;` +
    `AccountName=${accountName};` +
    `AccountKey=${accountKey};` +
    `BlobEndpoint=http://127.0.0.1:${blobPort}/${accountName};` +
    `QueueEndpoint=http://127.0.0.1:${queuePort}/${accountName};` +
    `TableEndpoint=http://127.0.0.1:${tablePort}/${accountName}`
}, 120000)

afterAll(async () => {
  // 60s: `env.down()` tears down the whole docker-compose environment
  // (stop + remove both containers), which exceeds vitest's 10s default
  // hook timeout on cold CI runners. This teardown hook — not any of the
  // startup hooks — is what actually flaked (trace: docker.test.ts:70;
  // all tests pass, then teardown times out). See #481.
  if (env) await env.down()
}, 60_000)

function s3(bucket: string) {
  const provider = createS3Provider({
    endpoint: minioEndpoint,
    bucket,
    accessKeyId: 'minioadmin',
    secretAccessKey: 'minioadmin',
    region: 'us-east-1',
  })
  return provider
}

// ---- StorageProvider conformance (shared battery) ----
// S3 (MinIO) and Azure Blob (Azurite) both satisfy the StorageProvider
// contract — same 8-test CRUD battery runs against both, so parity gaps
// get caught at test time, not in production.

runProviderConformance({
  name: 'S3 (MinIO)',
  make: async () => {
    const p = s3('conformance-s3')
    await p.init()
    return p
  },
})

runProviderConformance({
  name: 'Azure Blob (Azurite)',
  make: async () => {
    const p = createAzureBlobProvider({
      connectionString: azuriteConnectionString,
      container: 'conformance-azure',
    })
    await p.init()
    return p
  },
})

// ---- Azure Blob (Azurite) ----

describe('Azure Blob publish (Azurite)', () => {
  const source = createFilesystemProvider()
  let blobProvider: ReturnType<typeof createAzureBlobProvider>

  beforeAll(async () => {
    blobProvider = createAzureBlobProvider({
      connectionString: azuriteConnectionString,
      container: 'gazetta-test',
    })
    await blobProvider.init()
  })

  it('publishes a page to Azure Blob', async () => {
    const sourceRoot = createContentRoot(source, starterDir)
    const allItems = await resolveDependencies(sourceRoot, ['pages/home'])
    const { copiedFiles } = await publishItems(sourceRoot, createContentRoot(blobProvider), allItems)
    expect(copiedFiles).toBeGreaterThanOrEqual(1) // at least page.json (site config is TS, not copied raw)
    expect(await blobProvider.exists('pages/home/page.json')).toBe(true)
  })

  it('reads back published content', async () => {
    const content = await blobProvider.readFile('pages/home/page.json')
    expect(content).toContain('"template"') // JSON manifest
  })

  it('lists published files', async () => {
    const entries = await blobProvider.readDir('pages/home')
    expect(entries.map(e => e.name)).toContain('page.json')
  })
})

// ---- Rendered Publish (MinIO) ----

describe('Rendered publish (MinIO)', () => {
  const source = createFilesystemProvider()
  let target: ReturnType<typeof createS3Provider>
  let site: Site

  beforeAll(async () => {
    target = s3('publish-rendered-test')
    await target.init()
    // MinIO's testcontainers readiness probe tests port availability,
    // not bucket-metadata propagation. The first PUT against a
    // freshly-created bucket can race the propagation and drop the
    // socket mid-request as `socket hang up`. One cheap list, retried
    // on transient socket errors, flushes the race before the first
    // test's PutObject runs. See #880.
    await retryOnTransient(() => target.readDir(''))
    site = await getStarterSite()
  })

  it('publishes site manifest', async () => {
    await publishSiteManifest(createContentRoot(source, starterDir), target, site)
    const json = JSON.parse(await target.readFile('site.json'))
    expect(json.name).toBe('Gazetta Starter')
  })

  it('publishes a fragment as HTML with hashed CSS', async () => {
    const result = await publishFragmentRendered(
      'header',
      createContentRoot(source, starterDir),
      target,
      templatesDir,
      undefined,
      site,
    )
    expect(result.files).toBeGreaterThanOrEqual(2) // index.html + styles.{hash}.css
    const html = await target.readFile('fragments/header/index.html')
    expect(html).toContain('<head>')
    expect(html).toContain('stylesheet')
    expect(html).toContain('Gazetta') // body markup
  })

  it('publishes a page as HTML with ESI placeholders', async () => {
    await publishFragmentRendered(
      'footer',
      createContentRoot(source, starterDir),
      target,
      templatesDir,
      undefined,
      site,
    )
    const result = await publishPageRendered(
      'home',
      createContentRoot(source, starterDir),
      target,
      undefined,
      templatesDir,
      undefined,
      site,
    )
    expect(result.files).toBeGreaterThanOrEqual(2) // index.html + styles.{hash}.css

    const html = await target.readFile('pages/home/index.html')
    expect(html).toContain('<!DOCTYPE html>')
    expect(html).toContain('<!--esi:/fragments/header/index.html-->')
    expect(html).toContain('<!--esi-head:/fragments/header/index.html-->')
    expect(html).toContain('Welcome to Gazetta') // local component baked in
  })

  it('writes reverse fragment-deps sidecars on publish', async () => {
    const { publishDepIndices } = await import('gazetta')
    await publishDepIndices(createContentRoot(source, starterDir), target, site)
    // Per-edge zero-byte files: `.gazetta/fragment-deps/{frag}/{source}`.
    // Starter site references @header and @footer from the home page.
    const headerDir = await target.readDir('.gazetta/fragment-deps/header')
    expect(headerDir.map(e => e.name)).toContain('pages.home')
    const footerDir = await target.readDir('.gazetta/fragment-deps/footer')
    expect(footerDir.map(e => e.name)).toContain('pages.home')
  })
})

// ---- Edge Composition (S3-based, same logic as Cloudflare Worker with R2) ----

describe('Edge composition caching (MinIO)', () => {
  let app: import('hono').Hono

  beforeAll(async () => {
    const target = s3('worker-cache-test')
    await target.init()

    const source = createFilesystemProvider()
    const sourceRoot = createContentRoot(source, starterDir)
    const starterSite = await getStarterSite()
    await publishSiteManifest(sourceRoot, target, starterSite)
    await publishFragmentRendered('header', sourceRoot, target, templatesDir, undefined, starterSite)
    await publishFragmentRendered('footer', sourceRoot, target, templatesDir, undefined, starterSite)
    await publishPageRendered('home', sourceRoot, target, undefined, templatesDir, undefined, starterSite)
    await publishPageRendered('about', sourceRoot, target, undefined, templatesDir, undefined, starterSite)

    // Build a test app with ESI assembly (same logic as the Cloudflare Worker)
    const { Hono } = await import('hono')
    const storage = target
    const cache = new Map<string, { html: string; at: number }>()
    const TTL = 86400_000

    app = new Hono()

    app.post('/purge/all', () => {
      cache.clear()
      return new Response(JSON.stringify({ purged: 'all' }))
    })
    app.post('/purge/urls', async c => {
      const { urls } = (await c.req.json()) as { urls: string[] }
      let purged = 0
      for (const url of urls) {
        if (cache.delete(url)) purged++
      }
      return c.json({ purged })
    })

    app.get('*', async c => {
      const path = new URL(c.req.url).pathname
      const hit = cache.get(path)
      if (hit && Date.now() - hit.at < TTL) {
        return c.html(hit.html, 200, { 'Cache-Control': 'public, s-maxage=86400', 'X-Cache': 'HIT' })
      }

      // Find page by URL convention
      const pagePath = path === '/' ? 'pages/home/index.html' : `pages${path}/index.html`
      let pageHtml: string
      try {
        pageHtml = await storage.readFile(pagePath)
      } catch {
        return c.html('404', 404)
      }

      // ESI assembly: collect esi-head tags, read fragments, replace
      const esiHeadRegex = /<!--esi-head:(\/[^>]+)-->/g
      const esiBodyRegex = /<!--esi:(\/[^>]+)-->/g
      const fragmentPaths = new Set<string>()
      let m
      while ((m = esiHeadRegex.exec(pageHtml)) !== null) fragmentPaths.add(m[1])
      while ((m = esiBodyRegex.exec(pageHtml)) !== null) fragmentPaths.add(m[1])

      const fragments = new Map<string, { head: string; body: string }>()
      for (const fp of fragmentPaths) {
        try {
          const fragHtml = await storage.readFile(fp.slice(1))
          const hs = fragHtml.indexOf('<head>'),
            he = fragHtml.indexOf('</head>')
          if (hs !== -1 && he !== -1) {
            fragments.set(fp, {
              head: fragHtml.slice(hs + 6, he).trim(),
              body: (fragHtml.slice(0, hs) + fragHtml.slice(he + 7)).trim(),
            })
          } else {
            fragments.set(fp, { head: '', body: fragHtml })
          }
        } catch {
          fragments.set(fp, { head: '', body: `<!-- not found: ${fp} -->` })
        }
      }

      const headLines = new Set<string>()
      let html = pageHtml.replace(/<!--esi-head:(\/[^>]+)-->/g, (_m, p: string) => {
        const frag = fragments.get(p)
        if (frag?.head)
          for (const line of frag.head
            .split('\n')
            .map((l: string) => l.trim())
            .filter(Boolean))
            headLines.add(line)
        return ''
      })
      if (headLines.size > 0) html = html.replace('</head>', `  ${[...headLines].join('\n  ')}\n</head>`)
      html = html.replace(/<!--esi:(\/[^>]+)-->/g, (_m, p: string) => fragments.get(p)?.body ?? '')

      cache.set(path, { html, at: Date.now() })
      return c.html(html, 200, { 'Cache-Control': 'public, s-maxage=86400', 'X-Cache': 'MISS' })
    })
  })

  beforeEach(async () => {
    await app.request('/purge/all', { method: 'POST' })
  })

  it('serves a page from S3', async () => {
    const res = await app.request('/')
    expect(res.status).toBe(200)
    expect(await res.text()).toContain('Welcome to Gazetta')
  })

  it('returns MISS then HIT', async () => {
    expect((await app.request('/')).headers.get('x-cache')).toBe('MISS')
    expect((await app.request('/')).headers.get('x-cache')).toBe('HIT')
  })

  it('sets Cache-Control header', async () => {
    const res = await app.request('/')
    expect(res.headers.get('cache-control')).toContain('s-maxage=86400')
  })

  it('purge-all clears cache', async () => {
    await app.request('/')
    await app.request('/about')
    await app.request('/purge/all', { method: 'POST' })
    expect((await app.request('/')).headers.get('x-cache')).toBe('MISS')
    expect((await app.request('/about')).headers.get('x-cache')).toBe('MISS')
  })

  it('purge-urls clears only specified pages', async () => {
    await app.request('/')
    await app.request('/about')
    await app.request('/purge/urls', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ urls: ['/'] }),
    })
    expect((await app.request('/')).headers.get('x-cache')).toBe('MISS')
    expect((await app.request('/about')).headers.get('x-cache')).toBe('HIT')
  })

  it('returns 404 for unknown routes', async () => {
    expect((await app.request('/nonexistent')).status).toBe(404)
  })
})

// ---- Filesystem publish (no Docker needed but grouped here) ----

describe('Filesystem publish', () => {
  const source = createFilesystemProvider()
  const stagingDir = resolve(import.meta.dirname, '../../../dist/test-staging')
  const target = createFilesystemProvider(stagingDir)

  afterAll(async () => {
    const { rm } = await import('node:fs/promises')
    await rm(stagingDir, { recursive: true, force: true })
  })

  it('publishes a page with dependencies', async () => {
    const sourceRoot = createContentRoot(source, starterDir)
    const allItems = await resolveDependencies(sourceRoot, ['pages/home'])
    expect(allItems).toContain('pages/home')
    expect(allItems).toContain('templates/hero')
    expect(allItems).toContain('fragments/header')

    const { copiedFiles } = await publishItems(sourceRoot, createContentRoot(target), allItems)
    expect(copiedFiles).toBeGreaterThanOrEqual(1) // at least page.json (site config is TS, not copied raw)
    expect(await target.exists('pages/home/page.json')).toBe(true)
  })

  it('publishes a fragment', async () => {
    const sourceRoot = createContentRoot(source, starterDir)
    const allItems = await resolveDependencies(sourceRoot, ['fragments/header'])
    expect(allItems).toContain('templates/header-layout')
    const { copiedFiles } = await publishItems(sourceRoot, createContentRoot(target), allItems)
    expect(copiedFiles).toBeGreaterThanOrEqual(2)
  })
})
