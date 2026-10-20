/**
 * HTTP-level tests for the `/api/assets` route. POST verifies the route
 * adapter correctly wires multipart → ingest → HTTP response; GET verifies
 * list → response. Ingest and list correctness themselves are covered by
 * assets-ingest.test.ts and assets-list.test.ts.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { Hono } from 'hono'
import sharp from 'sharp'
import { assetRoutes } from '../src/admin-api/routes/assets.js'
import { staticSourceResolver, createSourceContext } from '../src/admin-api/source-context.js'
import { createFilesystemProvider } from '../src/providers/filesystem.js'
import { principalMiddleware } from '../src/admin-api/middleware/principal.js'
import { tempDir } from './_helpers/temp.js'

const testDir = tempDir('http-assets-test-' + Date.now())

beforeEach(async () => {
  await mkdir(testDir, { recursive: true })
})

afterEach(async () => {
  await rm(testDir, { recursive: true, force: true })
})

function buildApp() {
  const storage = createFilesystemProvider(testDir)
  // Storage is already rooted at `testDir`, so siteDir within that root
  // is the empty string — otherwise content paths double the prefix.
  const source = createSourceContext({ storage, siteDir: '' })
  const resolve = staticSourceResolver(source)
  const app = new Hono()
  // Wire the principal middleware (none-mode by default → admin role)
  // so the capability gates on the routes are populated. Tests bypass
  // createAdminApp; they need to wire what createAdminApp wires.
  app.use('/api/*', principalMiddleware())
  app.route('/', assetRoutes(resolve))
  return { app, storage }
}

async function jpegBuffer(): Promise<Buffer> {
  return sharp({
    create: { width: 64, height: 48, channels: 3, background: { r: 128, g: 128, b: 128 } },
  })
    .jpeg()
    .toBuffer()
}

function multipartForm(fields: Record<string, string | { name: string; bytes: Uint8Array; type: string }>) {
  const form = new FormData()
  for (const [key, value] of Object.entries(fields)) {
    if (typeof value === 'string') {
      form.set(key, value)
    } else {
      form.set(key, new File([value.bytes], value.name, { type: value.type }))
    }
  }
  return form
}

describe('POST /api/assets', () => {
  it('201s a valid JPEG upload with alt', async () => {
    const { app } = buildApp()
    const bytes = await jpegBuffer()

    const res = await app.request('/api/assets', {
      method: 'POST',
      body: multipartForm({
        file: { name: 'hero.jpg', bytes: new Uint8Array(bytes), type: 'image/jpeg' },
        name: 'hero',
        alt: 'Hero banner',
      }),
    })

    expect(res.status).toBe(201)
    const body = await res.json()
    expect(body.manifest.name).toBe('hero')
    expect(body.manifest.mime).toBe('image/jpeg')
    expect(body.manifest.alt).toBe('Hero banner')
    expect(body.bytesPath).toMatch(/^assets\/hero-[0-9a-f]{8}\.jpg$/)

    // Bytes landed on disk
    const onDisk = await readFile(join(testDir, body.bytesPath))
    expect(Buffer.compare(onDisk, bytes)).toBe(0)
  })

  it('treats empty alt string as "decorative"', async () => {
    const { app } = buildApp()
    const bytes = await jpegBuffer()

    const res = await app.request('/api/assets', {
      method: 'POST',
      body: multipartForm({
        file: { name: 'hero.jpg', bytes: new Uint8Array(bytes), type: 'image/jpeg' },
        name: 'decorative-hero',
        alt: '',
      }),
    })

    expect(res.status).toBe(201)
    const body = await res.json()
    expect(body.manifest.alt).toBe('')
  })

  it('treats missing alt field as "not set" (null)', async () => {
    const { app } = buildApp()
    const bytes = await jpegBuffer()

    const res = await app.request('/api/assets', {
      method: 'POST',
      body: multipartForm({
        file: { name: 'hero.jpg', bytes: new Uint8Array(bytes), type: 'image/jpeg' },
        name: 'no-alt',
      }),
    })

    expect(res.status).toBe(201)
    const body = await res.json()
    expect(body.manifest.alt).toBeNull()
  })

  it('400s when file field is missing', async () => {
    const { app } = buildApp()
    const res = await app.request('/api/assets', {
      method: 'POST',
      body: multipartForm({ name: 'hero' }),
    })
    expect(res.status).toBe(400)
    expect(await res.json()).toEqual({ code: 'BAD_REQUEST', message: 'Missing or invalid "file" field' })
  })

  it.each([
    ['missing', undefined],
    ['empty', ''],
  ])('400s when name field is %s', async (_label, name) => {
    const { app } = buildApp()
    const bytes = await jpegBuffer()
    const fields: Parameters<typeof multipartForm>[0] = {
      file: { name: 'hero.jpg', bytes: new Uint8Array(bytes), type: 'image/jpeg' },
    }
    if (name !== undefined) fields.name = name
    const res = await app.request('/api/assets', { method: 'POST', body: multipartForm(fields) })
    expect(res.status).toBe(400)
    expect(await res.json()).toEqual({ code: 'BAD_REQUEST', message: 'Missing or invalid "name" field' })
  })

  it('400s with ASSET_MIME_MISMATCH for an unsupported format', async () => {
    const { app } = buildApp()
    const webp = await sharp({
      create: { width: 10, height: 10, channels: 3, background: { r: 0, g: 0, b: 0 } },
    })
      .webp()
      .toBuffer()

    const res = await app.request('/api/assets', {
      method: 'POST',
      body: multipartForm({
        file: { name: 'x.webp', bytes: new Uint8Array(webp), type: 'image/webp' },
        name: 'rejected',
      }),
    })

    expect(res.status).toBe(400)
    const body = await res.json()
    expect(body.code).toBe('ASSET_MIME_MISMATCH')
  })

  it('400s with ASSET_PATH_TRAVERSAL for a path-traversing name', async () => {
    const { app } = buildApp()
    const bytes = await jpegBuffer()

    const res = await app.request('/api/assets', {
      method: 'POST',
      body: multipartForm({
        file: { name: 'hero.jpg', bytes: new Uint8Array(bytes), type: 'image/jpeg' },
        name: '../etc/passwd',
      }),
    })

    expect(res.status).toBe(400)
    const body = await res.json()
    expect(body.code).toBe('ASSET_PATH_TRAVERSAL')
  })
})

describe('GET /api/assets', () => {
  it('returns an empty array when the target has no assets', async () => {
    const { app } = buildApp()
    const res = await app.request('/api/assets')
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual([])
  })

  it('lists uploaded assets', async () => {
    const { app } = buildApp()
    const bytes = await jpegBuffer()

    // Upload two assets
    await app.request('/api/assets', {
      method: 'POST',
      body: multipartForm({
        file: { name: 'a.jpg', bytes: new Uint8Array(bytes), type: 'image/jpeg' },
        name: 'asset-one',
        alt: 'First asset',
      }),
    })
    await app.request('/api/assets', {
      method: 'POST',
      body: multipartForm({
        file: { name: 'b.jpg', bytes: new Uint8Array(bytes), type: 'image/jpeg' },
        name: 'asset-two',
      }),
    })

    const res = await app.request('/api/assets')
    expect(res.status).toBe(200)
    const summaries = (await res.json()) as Array<{ name: string; alt: string | null }>
    expect(summaries).toHaveLength(2)
    expect(summaries.map(s => s.name).sort()).toEqual(['asset-one', 'asset-two'])
    const assetOne = summaries.find(s => s.name === 'asset-one')
    expect(assetOne?.alt).toBe('First asset')
  })

  it('returns summaries with expected shape', async () => {
    const { app } = buildApp()
    const bytes = await jpegBuffer()

    await app.request('/api/assets', {
      method: 'POST',
      body: multipartForm({
        file: { name: 'a.jpg', bytes: new Uint8Array(bytes), type: 'image/jpeg' },
        name: 'shape-test',
        alt: 'Shape',
      }),
    })

    const res = await app.request('/api/assets')
    const [summary] = (await res.json()) as Array<Record<string, unknown>>
    // Summary fields present
    expect(summary.name).toBe('shape-test')
    expect(summary.kind).toBe('embedded')
    expect(summary.mime).toBe('image/jpeg')
    expect(typeof summary.size).toBe('number')
    expect(typeof summary.hash).toBe('string')
    expect(summary.alt).toBe('Shape')
    // Private fields NOT in summary
    expect('uploadedBy' in summary).toBe(false)
  })
})

describe('GET /api/assets/:name', () => {
  it('returns a single-asset summary by name', async () => {
    const { app } = buildApp()
    const bytes = await jpegBuffer()

    await app.request('/api/assets', {
      method: 'POST',
      body: multipartForm({
        file: { name: 'a.jpg', bytes: new Uint8Array(bytes), type: 'image/jpeg' },
        name: 'single',
        alt: 'Single asset',
      }),
    })

    const res = await app.request('/api/assets/single')
    expect(res.status).toBe(200)
    const summary = (await res.json()) as Record<string, unknown>
    expect(summary.name).toBe('single')
    expect(summary.mime).toBe('image/jpeg')
    expect(summary.alt).toBe('Single asset')
    // Same summary shape as the list endpoint — no private fields.
    expect('uploadedBy' in summary).toBe(false)
  })

  it('404s when the asset does not exist', async () => {
    const { app } = buildApp()
    const res = await app.request('/api/assets/nope')
    expect(res.status).toBe(404)
    const body = await res.json()
    expect(body.code).toBe('ASSET_MANIFEST_NOT_FOUND')
  })
})

describe('DELETE /api/assets/:name', () => {
  async function uploadHero(app: Hono) {
    const bytes = await jpegBuffer()
    await app.request('/api/assets', {
      method: 'POST',
      body: multipartForm({
        file: { name: 'hero.jpg', bytes: new Uint8Array(bytes), type: 'image/jpeg' },
        name: 'hero',
        alt: 'Hero',
      }),
    })
  }

  it('204s when the asset has no refs', async () => {
    const { app } = buildApp()
    await uploadHero(app)

    const res = await app.request('/api/assets/hero', { method: 'DELETE' })
    expect(res.status).toBe(204)

    // Asset is gone from the list.
    const listRes = await app.request('/api/assets')
    expect(await listRes.json()).toEqual([])
  })

  it('409s with the usage list when a page references the asset', async () => {
    const { app } = buildApp()
    await uploadHero(app)

    // Seed a page referencing "hero" under the site root.
    const fs = await import('node:fs/promises')
    await fs.mkdir(join(testDir, 'pages/home'), { recursive: true })
    await fs.writeFile(
      join(testDir, 'pages/home/page.json'),
      JSON.stringify({
        template: 'page-default',
        route: '/',
        content: { hero: { _asset: 'hero' } },
      }),
    )

    const res = await app.request('/api/assets/hero', { method: 'DELETE' })
    expect(res.status).toBe(409)
    const body = (await res.json()) as {
      code: string
      assetName: string
      refs: Array<{ source: string; path: string; componentPath: string }>
    }
    expect(body.code).toBe('ASSET_IN_USE')
    expect(body.assetName).toBe('hero')
    expect(body.refs).toHaveLength(1)
    expect(body.refs[0]).toMatchObject({
      source: 'page',
      path: 'pages/home/page.json',
      componentPath: 'hero',
    })

    // Asset files are untouched.
    const listRes = await app.request('/api/assets')
    const list = (await listRes.json()) as Array<{ name: string }>
    expect(list.some(a => a.name === 'hero')).toBe(true)
  })

  it('404s when the asset does not exist', async () => {
    const { app } = buildApp()
    const res = await app.request('/api/assets/nope', { method: 'DELETE' })
    expect(res.status).toBe(404)
    const body = await res.json()
    expect(body.code).toBe('ASSET_MANIFEST_NOT_FOUND')
  })
})

describe('POST /api/assets/:name/replace-with/:newName', () => {
  async function uploadAsset(app: Hono, name: string) {
    const bytes = await jpegBuffer()
    await app.request('/api/assets', {
      method: 'POST',
      body: multipartForm({
        file: { name: `${name}.jpg`, bytes: new Uint8Array(bytes), type: 'image/jpeg' },
        name,
      }),
    })
  }

  it('204s on successful replace + rewrites refs', async () => {
    const { app } = buildApp()
    await uploadAsset(app, 'hero')
    await uploadAsset(app, 'banner')

    // Seed a page that references `hero`.
    const fs = await import('node:fs/promises')
    await fs.mkdir(join(testDir, 'pages/home'), { recursive: true })
    await fs.writeFile(
      join(testDir, 'pages/home/page.json'),
      JSON.stringify({
        template: 'page-default',
        route: '/',
        content: { hero: { _asset: 'hero' } },
      }),
    )

    const res = await app.request('/api/assets/hero/replace-with/banner', { method: 'POST' })
    expect(res.status).toBe(204)

    // Old asset gone.
    const list = (await (await app.request('/api/assets')).json()) as Array<{ name: string }>
    expect(list.map(a => a.name).sort()).toEqual(['banner'])

    // Page now references `banner`.
    const pageJson = JSON.parse(await fs.readFile(join(testDir, 'pages/home/page.json'), 'utf-8'))
    expect(pageJson.content.hero._asset).toBe('banner')
  })

  it('404s when the old asset is missing', async () => {
    const { app } = buildApp()
    await uploadAsset(app, 'banner')

    const res = await app.request('/api/assets/ghost/replace-with/banner', { method: 'POST' })
    expect(res.status).toBe(404)
  })

  it('404s when the new asset is missing', async () => {
    const { app } = buildApp()
    await uploadAsset(app, 'hero')

    const res = await app.request('/api/assets/hero/replace-with/ghost', { method: 'POST' })
    expect(res.status).toBe(404)
  })

  it('409s with structured body on kind mismatch', async () => {
    const { app } = buildApp()
    await uploadAsset(app, 'hero')
    await uploadAsset(app, 'banner')

    // Tamper with banner's manifest to fake a kind mismatch.
    const fs = await import('node:fs/promises')
    const manifestPath = join(testDir, 'assets/banner.asset.json')
    const m = JSON.parse(await fs.readFile(manifestPath, 'utf-8'))
    m.kind = 'downloadable'
    m.mime = 'application/pdf'
    await fs.writeFile(manifestPath, JSON.stringify(m, null, 2))

    const res = await app.request('/api/assets/hero/replace-with/banner', { method: 'POST' })
    expect(res.status).toBe(409)
    const body = (await res.json()) as {
      code: string
      oldKind: string
      oldMimeCategory: string
      newKind: string
      newMimeCategory: string
    }
    expect(body.code).toBe('ASSET_KIND_MISMATCH')
    expect(body.oldKind).toBe('embedded')
    expect(body.newKind).toBe('downloadable')
    expect(body.oldMimeCategory).toBe('image')
    expect(body.newMimeCategory).toBe('application')
  })
})

describe('POST /api/assets/:name/rename-to/:newName', () => {
  async function uploadAsset(app: Hono, name: string) {
    const bytes = await jpegBuffer()
    await app.request('/api/assets', {
      method: 'POST',
      body: multipartForm({
        file: { name: `${name}.jpg`, bytes: new Uint8Array(bytes), type: 'image/jpeg' },
        name,
      }),
    })
  }

  it('204s on successful rename + rewrites refs', async () => {
    const { app } = buildApp()
    await uploadAsset(app, 'hero')

    const fs = await import('node:fs/promises')
    await fs.mkdir(join(testDir, 'pages/home'), { recursive: true })
    await fs.writeFile(
      join(testDir, 'pages/home/page.json'),
      JSON.stringify({
        template: 'page-default',
        route: '/',
        content: { hero: { _asset: 'hero' } },
      }),
    )

    const res = await app.request('/api/assets/hero/rename-to/banner', { method: 'POST' })
    expect(res.status).toBe(204)

    // Old name gone, new name lives.
    const list = (await (await app.request('/api/assets')).json()) as Array<{ name: string }>
    expect(list.map(a => a.name).sort()).toEqual(['banner'])

    // Page now references `banner`.
    const pageJson = JSON.parse(await fs.readFile(join(testDir, 'pages/home/page.json'), 'utf-8'))
    expect(pageJson.content.hero._asset).toBe('banner')
  })

  it('404s when the source asset is missing', async () => {
    const { app } = buildApp()
    const res = await app.request('/api/assets/ghost/rename-to/banner', { method: 'POST' })
    expect(res.status).toBe(404)
  })

  it('409s with structured body on name collision', async () => {
    const { app } = buildApp()
    await uploadAsset(app, 'hero')
    await uploadAsset(app, 'banner')

    const res = await app.request('/api/assets/hero/rename-to/banner', { method: 'POST' })
    expect(res.status).toBe(409)
    const body = (await res.json()) as { code: string; newName: string }
    expect(body.code).toBe('ASSET_NAME_COLLISION')
    expect(body.newName).toBe('banner')
  })
})

describe('POST /api/assets/:name/locale-bytes', () => {
  async function uploadAsset(app: Hono, name: string) {
    const bytes = await jpegBuffer()
    await app.request('/api/assets', {
      method: 'POST',
      body: multipartForm({
        file: { name: `${name}.jpg`, bytes: new Uint8Array(bytes), type: 'image/jpeg' },
        name,
      }),
    })
  }

  it('201s on successful locale-bytes upload', async () => {
    const { app } = buildApp()
    await uploadAsset(app, 'hero')

    const overrideBytes = await jpegBuffer()
    const res = await app.request('/api/assets/hero/locale-bytes?locale=fr', {
      method: 'POST',
      body: multipartForm({ file: { name: 'hero.jpg', bytes: new Uint8Array(overrideBytes), type: 'image/jpeg' } }),
    })
    expect(res.status).toBe(201)
    const body = (await res.json()) as { manifest: { name: string; hash: string }; bytesPath: string }
    expect(body.manifest.name).toBe('hero')
    expect(body.bytesPath.endsWith('.fr.jpg')).toBe(true)
  })

  it('400s when no selector is provided', async () => {
    const { app } = buildApp()
    await uploadAsset(app, 'hero')

    const res = await app.request('/api/assets/hero/locale-bytes', {
      method: 'POST',
      body: multipartForm({
        file: { name: 'hero.jpg', bytes: new Uint8Array(await jpegBuffer()), type: 'image/jpeg' },
      }),
    })
    expect(res.status).toBe(400)
  })

  it('400s when the file field is missing', async () => {
    const { app } = buildApp()
    await uploadAsset(app, 'hero')
    const res = await app.request('/api/assets/hero/locale-bytes?locale=fr', {
      method: 'POST',
      body: multipartForm({ name: 'hero' }),
    })
    expect(res.status).toBe(400)
    expect(await res.json()).toEqual({ code: 'BAD_REQUEST', message: 'Missing or invalid "file" field' })
  })

  it('400s on invalid locale code', async () => {
    const { app } = buildApp()
    await uploadAsset(app, 'hero')
    const res = await app.request('/api/assets/hero/locale-bytes?locale=NOT-A-LOCALE-FORMAT', {
      method: 'POST',
      body: multipartForm({
        file: { name: 'hero.jpg', bytes: new Uint8Array(await jpegBuffer()), type: 'image/jpeg' },
      }),
    })
    expect(res.status).toBe(400)
  })

  it('404s when the asset does not exist', async () => {
    const { app } = buildApp()
    const res = await app.request('/api/assets/ghost/locale-bytes?locale=fr', {
      method: 'POST',
      body: multipartForm({
        file: { name: 'hero.jpg', bytes: new Uint8Array(await jpegBuffer()), type: 'image/jpeg' },
      }),
    })
    expect(res.status).toBe(404)
  })
})

describe('DELETE /api/assets/:name/locale-bytes', () => {
  async function uploadAsset(app: Hono, name: string) {
    const bytes = await jpegBuffer()
    await app.request('/api/assets', {
      method: 'POST',
      body: multipartForm({
        file: { name: `${name}.jpg`, bytes: new Uint8Array(bytes), type: 'image/jpeg' },
        name,
      }),
    })
  }

  async function uploadOverride(app: Hono, name: string, locale: string) {
    const bytes = await jpegBuffer()
    return app.request(`/api/assets/${name}/locale-bytes?locale=${locale}`, {
      method: 'POST',
      body: multipartForm({ file: { name: `${name}.jpg`, bytes: new Uint8Array(bytes), type: 'image/jpeg' } }),
    })
  }

  it('204s on successful override removal', async () => {
    const { app } = buildApp()
    await uploadAsset(app, 'hero')
    await uploadOverride(app, 'hero', 'fr')

    const res = await app.request('/api/assets/hero/locale-bytes?locale=fr', { method: 'DELETE' })
    expect(res.status).toBe(204)
  })

  it('400s when no selector is provided', async () => {
    const { app } = buildApp()
    const res = await app.request('/api/assets/hero/locale-bytes', { method: 'DELETE' })
    expect(res.status).toBe(400)
  })

  it('404s when the override does not exist', async () => {
    const { app } = buildApp()
    await uploadAsset(app, 'hero')
    const res = await app.request('/api/assets/hero/locale-bytes?locale=fr', { method: 'DELETE' })
    expect(res.status).toBe(404)
  })
})

describe('PATCH /api/assets/:name', () => {
  async function uploadAsset(app: Hono, name: string, alt: string | null = null) {
    const bytes = await jpegBuffer()
    const form = multipartForm({
      file: { name: `${name}.jpg`, bytes: new Uint8Array(bytes), type: 'image/jpeg' },
      name,
    })
    if (alt !== null) form.set('alt', alt)
    await app.request('/api/assets', { method: 'POST', body: form })
  }

  it('200s with the updated summary on alt change', async () => {
    const { app } = buildApp()
    await uploadAsset(app, 'hero')

    const res = await app.request('/api/assets/hero', {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ alt: 'Mountain sunset' }),
    })
    expect(res.status).toBe(200)
    const body = (await res.json()) as { manifest: { alt: string } }
    expect(body.manifest.alt).toBe('Mountain sunset')
  })

  it('treats explicit null as "clear alt" (three-state model)', async () => {
    const { app } = buildApp()
    await uploadAsset(app, 'hero', 'starts with text')

    const res = await app.request('/api/assets/hero', {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ alt: null }),
    })
    expect(res.status).toBe(200)
    const body = (await res.json()) as { manifest: { alt: string | null } }
    expect(body.manifest.alt).toBeNull()
  })

  it('treats empty string as "decorative"', async () => {
    const { app } = buildApp()
    await uploadAsset(app, 'hero')

    const res = await app.request('/api/assets/hero', {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ alt: '' }),
    })
    expect(res.status).toBe(200)
    const body = (await res.json()) as { manifest: { alt: string | null } }
    expect(body.manifest.alt).toBe('')
  })

  it('400s when alt is not string|null', async () => {
    const { app } = buildApp()
    await uploadAsset(app, 'hero')

    const res = await app.request('/api/assets/hero', {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ alt: 42 }),
    })
    expect(res.status).toBe(400)
    expect(await res.json()).toEqual({ code: 'BAD_REQUEST', message: 'alt must be string or null' })
  })

  it('400s on non-JSON body', async () => {
    const { app } = buildApp()
    await uploadAsset(app, 'hero')

    const res = await app.request('/api/assets/hero', {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: 'not json',
    })
    expect(res.status).toBe(400)
  })

  it('404s when the asset does not exist', async () => {
    const { app } = buildApp()
    const res = await app.request('/api/assets/ghost', {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ alt: 'x' }),
    })
    expect(res.status).toBe(404)
  })

  it('returns updated overrideLocales/themes alongside the patch', async () => {
    const { app } = buildApp()
    await uploadAsset(app, 'hero')

    const res = await app.request('/api/assets/hero', {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ alt: 'description' }),
    })
    const body = (await res.json()) as { manifest: { overrideLocales: string[]; overrideThemes: string[] } }
    expect(body.manifest.overrideLocales).toEqual([])
    expect(body.manifest.overrideThemes).toEqual([])
  })

  it('reports each override locale and theme once', async () => {
    const { app } = buildApp()
    await uploadAsset(app, 'hero')
    // Two slices share the `fr` locale; the summary lists it once.
    for (const query of ['locale=fr', 'locale=fr&theme=dark']) {
      const up = await app.request(`/api/assets/hero/locale-bytes?${query}`, {
        method: 'POST',
        body: multipartForm({
          file: { name: 'hero.jpg', bytes: new Uint8Array(await jpegBuffer()), type: 'image/jpeg' },
        }),
      })
      expect(up.status).toBe(201)
    }

    const res = await app.request('/api/assets/hero', {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ alt: 'description' }),
    })
    expect(res.status).toBe(200)
    const body = (await res.json()) as { manifest: { overrideLocales: string[]; overrideThemes: string[] } }
    expect(body.manifest.overrideLocales).toEqual(['fr'])
    expect(body.manifest.overrideThemes).toEqual(['dark'])
  })

  it('empty patch is a no-op (200 with current summary)', async () => {
    const { app } = buildApp()
    await uploadAsset(app, 'hero', 'preserved')

    const res = await app.request('/api/assets/hero', {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: '{}',
    })
    expect(res.status).toBe(200)
    const body = (await res.json()) as { manifest: { alt: string | null } }
    expect(body.manifest.alt).toBe('preserved')
  })

  describe('focalPoint patches', () => {
    it('200s with the updated focalPoint', async () => {
      const { app } = buildApp()
      await uploadAsset(app, 'hero')

      const res = await app.request('/api/assets/hero', {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ focalPoint: { x: 0.3, y: 0.7 } }),
      })
      expect(res.status).toBe(200)
      const body = (await res.json()) as { manifest: { focalPoint?: { x: number; y: number } } }
      expect(body.manifest.focalPoint).toEqual({ x: 0.3, y: 0.7 })
    })

    it('200s with focalPoint cleared on null', async () => {
      const { app } = buildApp()
      await uploadAsset(app, 'hero')
      // Set it first.
      await app.request('/api/assets/hero', {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ focalPoint: { x: 0.5, y: 0.5 } }),
      })
      // Clear.
      const res = await app.request('/api/assets/hero', {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ focalPoint: null }),
      })
      expect(res.status).toBe(200)
      const body = (await res.json()) as { manifest: { focalPoint?: { x: number; y: number } } }
      expect(body.manifest.focalPoint).toBeUndefined()
    })

    it.each([
      { x: -0.1, y: 0.5 },
      { x: 2.5, y: 0.5 },
      { x: 0.5, y: -0.1 },
      { x: 0.5, y: 1.5 },
    ])('400s when focalPoint %o is out of [0, 1]', async focalPoint => {
      const { app } = buildApp()
      await uploadAsset(app, 'hero')

      const res = await app.request('/api/assets/hero', {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ focalPoint }),
      })
      expect(res.status).toBe(400)
      expect(await res.json()).toEqual({ code: 'BAD_REQUEST', message: 'focalPoint x and y must be in [0, 1]' })
    })

    // The range is inclusive: the edges of the image are valid focal points.
    it.each([
      { x: 0, y: 0 },
      { x: 1, y: 1 },
    ])('accepts the boundary focalPoint %o', async focalPoint => {
      const { app } = buildApp()
      await uploadAsset(app, 'hero')

      const res = await app.request('/api/assets/hero', {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ focalPoint }),
      })
      expect(res.status).toBe(200)
      const body = (await res.json()) as { manifest: { focalPoint?: { x: number; y: number } } }
      expect(body.manifest.focalPoint).toEqual(focalPoint)
    })

    it.each([
      ['a string', 'not an object'],
      ['x not a number', { x: '0.5', y: 0.5 }],
      ['y not a number', { x: 0.5, y: '0.5' }],
      ['neither coordinate a number', { x: 'a', y: 'b' }],
    ])('400s when focalPoint is malformed (%s)', async (_label, focalPoint) => {
      const { app } = buildApp()
      await uploadAsset(app, 'hero')

      const res = await app.request('/api/assets/hero', {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ focalPoint }),
      })
      expect(res.status).toBe(400)
      expect(await res.json()).toEqual({
        code: 'BAD_REQUEST',
        message: 'focalPoint must be { x: number, y: number } or null',
      })
    })

    it('combined alt + focalPoint patch in one request', async () => {
      const { app } = buildApp()
      await uploadAsset(app, 'hero')

      const res = await app.request('/api/assets/hero', {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ alt: 'Mountains', focalPoint: { x: 0.6, y: 0.4 } }),
      })
      expect(res.status).toBe(200)
      const body = (await res.json()) as {
        manifest: { alt: string | null; focalPoint?: { x: number; y: number } }
      }
      expect(body.manifest.alt).toBe('Mountains')
      expect(body.manifest.focalPoint).toEqual({ x: 0.6, y: 0.4 })
    })
  })
})
