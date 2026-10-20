/**
 * Cut 6 tests: end-to-end upload hook firing.
 *
 * Validates the asset-route wiring: HookRegistry → assetRoutes →
 * POST /api/assets multipart → dispatchBeforeUpload → ingestAsset
 * → dispatchAfterUpload → 201 response.
 *
 * Strategy: mount assetRoutes directly under a Hono app with the
 * principal middleware (none-mode admin), seed a real JPEG via
 * sharp, post the multipart form, assert the hooks fire with the
 * expected shape AND ingestAsset wrote the (potentially mutated)
 * bytes.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdir, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { Hono } from 'hono'
import sharp from 'sharp'
import { assetRoutes } from '../src/admin-api/routes/assets.js'
import { staticSourceResolver, createSourceContext } from '../src/admin-api/source-context.js'
import { createFilesystemProvider } from '../src/providers/filesystem.js'
import { principalMiddleware } from '../src/admin-api/middleware/principal.js'
import { HookRegistry } from '../src/hooks/index.js'
import type {
  AfterUploadHook,
  BeforeUploadHook,
  HookContext,
  UploadHookAsset,
  UploadHookResult,
} from '../src/hooks/index.js'
import type { SiteManifest } from '../src/types.js'
import { tempDir } from './_helpers/temp.js'

const testDir = tempDir('http-hooks-upload-test-' + Date.now())

interface CapturedBefore {
  asset: UploadHookAsset
  byteLength: number
}
interface CapturedAfter {
  asset: UploadHookAsset
  result: UploadHookResult
}

let beforeCalls: CapturedBefore[]
let afterCalls: CapturedAfter[]

beforeEach(async () => {
  await mkdir(testDir, { recursive: true })
  beforeCalls = []
  afterCalls = []
})

afterEach(async () => {
  await rm(testDir, { recursive: true, force: true })
})

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

function buildApp(opts: { hooks?: HookRegistry; manifest?: SiteManifest } = {}) {
  const dir = join(testDir, `app-${Math.random().toString(36).slice(2, 8)}`)
  const storage = createFilesystemProvider(dir)
  const source = createSourceContext({ storage, siteDir: '', manifest: opts.manifest })
  const resolve = staticSourceResolver(source)
  const app = new Hono()
  app.use('/api/*', principalMiddleware())
  app.route('/', assetRoutes(resolve, opts))
  return { app, storage }
}

describe('Cut 6 — beforeUpload + afterUpload firing', () => {
  it('beforeUpload receives the raw asset metadata + bytes', async () => {
    const hooks = new HookRegistry()
    const recordBefore: BeforeUploadHook = async (asset, bytes, _ctx) => {
      beforeCalls.push({ asset, byteLength: bytes.byteLength })
      return { asset, bytes }
    }
    hooks.register('beforeUpload', recordBefore, { name: 'record-before' })
    hooks.seal()

    const { app } = buildApp({ hooks })
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
    expect(beforeCalls).toHaveLength(1)
    expect(beforeCalls[0].asset.name).toBe('hero')
    expect(beforeCalls[0].asset.mime).toBe('image/jpeg')
    expect(beforeCalls[0].asset.alt).toBe('Hero banner')
    expect(beforeCalls[0].byteLength).toBe(bytes.byteLength)
  })

  it('beforeUpload context carries the request id and site name', async () => {
    const hooks = new HookRegistry()
    let seen: HookContext | undefined
    const capture: BeforeUploadHook = async (asset, bytes, ctx) => {
      seen = ctx
      return { asset, bytes }
    }
    hooks.register('beforeUpload', capture, { name: 'capture' })
    hooks.seal()

    const { app } = buildApp({ hooks, manifest: { name: 'Test Site' } as SiteManifest })
    const bytes = await jpegBuffer()
    const res = await app.request('/api/assets', {
      method: 'POST',
      headers: { 'x-request-id': 'req-998' },
      body: multipartForm({
        file: { name: 'hero.jpg', bytes: new Uint8Array(bytes), type: 'image/jpeg' },
        name: 'hero',
      }),
    })
    expect(res.status).toBe(201)
    expect(seen?.requestId).toBe('req-998')
    expect(seen?.site.name).toBe('Test Site')
  })

  it('afterUpload fires with the persisted asset hash', async () => {
    const hooks = new HookRegistry()
    const recordAfter: AfterUploadHook = async (asset, result, _ctx) => {
      afterCalls.push({ asset, result })
    }
    hooks.register('afterUpload', recordAfter, { name: 'record-after' })
    hooks.seal()

    const { app } = buildApp({ hooks })
    const bytes = await jpegBuffer()
    const res = await app.request('/api/assets', {
      method: 'POST',
      body: multipartForm({
        file: { name: 'hero.jpg', bytes: new Uint8Array(bytes), type: 'image/jpeg' },
        name: 'hero',
      }),
    })
    expect(res.status).toBe(201)
    expect(afterCalls).toHaveLength(1)
    expect(afterCalls[0].asset.name).toBe('hero')
    expect(afterCalls[0].result.hash).toMatch(/^[a-f0-9]+$/)
  })

  it('beforeUpload mutates the asset name → ingestAsset persists under the new name', async () => {
    const hooks = new HookRegistry()
    const renameHook: BeforeUploadHook = async (asset, bytes, _ctx) => ({
      asset: { ...asset, name: `${asset.name}-renamed` },
      bytes,
    })
    hooks.register('beforeUpload', renameHook, { name: 'rename' })
    hooks.seal()

    const { app, storage } = buildApp({ hooks })
    const bytes = await jpegBuffer()
    const res = await app.request('/api/assets', {
      method: 'POST',
      body: multipartForm({
        file: { name: 'hero.jpg', bytes: new Uint8Array(bytes), type: 'image/jpeg' },
        name: 'hero',
      }),
    })
    expect(res.status).toBe(201)
    const body = (await res.json()) as { manifest: { name: string } }
    expect(body.manifest.name).toBe('hero-renamed')
    // Storage actually has the renamed manifest.
    expect(await storage.exists('assets/hero-renamed.asset.json')).toBe(true)
    expect(await storage.exists('assets/hero.asset.json')).toBe(false)
  })

  it('beforeUpload alt mutation flows through to the persisted manifest', async () => {
    const hooks = new HookRegistry()
    const autoAlt: BeforeUploadHook = async (asset, bytes, _ctx) => ({
      asset: { ...asset, alt: 'auto-generated alt text' },
      bytes,
    })
    hooks.register('beforeUpload', autoAlt, { name: 'auto-alt' })
    hooks.seal()

    const { app, storage } = buildApp({ hooks })
    const bytes = await jpegBuffer()
    const res = await app.request('/api/assets', {
      method: 'POST',
      body: multipartForm({
        file: { name: 'hero.jpg', bytes: new Uint8Array(bytes), type: 'image/jpeg' },
        name: 'hero',
        // No alt in the upload form — beforeUpload supplies it.
      }),
    })
    expect(res.status).toBe(201)
    const persisted = await storage.readFile('assets/hero.asset.json')
    const manifest = JSON.parse(persisted)
    expect(manifest.alt).toBe('auto-generated alt text')
  })

  it('beforeUpload throw returns 409 HOOK_CANCELLED with no storage write', async () => {
    const hooks = new HookRegistry()
    const reject: BeforeUploadHook = async () => {
      throw new Error('upload blocked')
    }
    hooks.register('beforeUpload', reject, { name: 'reject-uploads' })
    hooks.seal()

    const { app, storage } = buildApp({ hooks })
    const bytes = await jpegBuffer()
    const res = await app.request('/api/assets', {
      method: 'POST',
      body: multipartForm({
        file: { name: 'hero.jpg', bytes: new Uint8Array(bytes), type: 'image/jpeg' },
        name: 'hero',
      }),
    })
    expect(res.status).toBe(409)
    const body = (await res.json()) as { code: string; hook: string; reason: string }
    expect(body.code).toBe('HOOK_CANCELLED')
    expect(body.hook).toBe('reject-uploads')
    expect(body.reason).toContain('upload blocked')
    // Storage didn't get the manifest
    expect(await storage.exists('assets/hero.asset.json')).toBe(false)
  })

  it('upload works without hooks (opts.hooks undefined)', async () => {
    const { app, storage } = buildApp({})
    const bytes = await jpegBuffer()
    const res = await app.request('/api/assets', {
      method: 'POST',
      body: multipartForm({
        file: { name: 'hero.jpg', bytes: new Uint8Array(bytes), type: 'image/jpeg' },
        name: 'hero',
      }),
    })
    expect(res.status).toBe(201)
    expect(await storage.exists('assets/hero.asset.json')).toBe(true)
    // No hooks fired
    expect(beforeCalls).toHaveLength(0)
    expect(afterCalls).toHaveLength(0)
  })

  it('beforeUpload runs in priority order; mutations chain', async () => {
    const hooks = new HookRegistry()
    const trim: BeforeUploadHook = async (asset, bytes, _ctx) => ({
      asset: { ...asset, name: asset.name.trim() },
      bytes,
    })
    const lower: BeforeUploadHook = async (asset, bytes, _ctx) => ({
      asset: { ...asset, name: asset.name.toLowerCase() },
      bytes,
    })
    hooks.register('beforeUpload', trim, { name: 'trim', priority: 50 })
    hooks.register('beforeUpload', lower, { name: 'lower', priority: 100 })
    hooks.seal()

    const { app, storage } = buildApp({ hooks })
    const bytes = await jpegBuffer()
    const res = await app.request('/api/assets', {
      method: 'POST',
      body: multipartForm({
        file: { name: 'hero.jpg', bytes: new Uint8Array(bytes), type: 'image/jpeg' },
        name: '  HERO  ',
      }),
    })
    expect(res.status).toBe(201)
    // The persisted manifest's `name` is the post-hook value
    // (trim → lower-case). Filesystem is case-insensitive on
    // macOS APFS, so we assert via the manifest body, not via
    // case-sensitive storage.exists() probes.
    const body = (await res.json()) as { manifest: { name: string } }
    expect(body.manifest.name).toBe('hero')
    const persisted = await storage.readFile('assets/hero.asset.json')
    expect(JSON.parse(persisted).name).toBe('hero')
  })
})
