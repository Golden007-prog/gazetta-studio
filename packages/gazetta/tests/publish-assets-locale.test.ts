/**
 * Integration tests for locale-aware asset publishing (#1350):
 *
 *  1. an asset with a locale bytes override publishes the override
 *     slice (manifest + bytes + variants), not just the default
 *     footprint
 *  2. an override added after a first publish reaches the target on
 *     the next publish (no whole-asset dedupe skip)
 *  3. an asset referenced only by a locale variant of an item
 *     (page.fr.json) is collected by the planner and copied
 *  4. a metadata edit (alt) after a first publish updates the
 *     target's default manifest on the next publish
 *
 * Real filesystem storage, same harness as publish-assets.test.ts.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { existsSync } from 'node:fs'
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import sharp from 'sharp'
import { ingestAsset } from '../src/assets/ingest.js'
import { ingestLocaleBytes } from '../src/assets/ingest-locale.js'
import { publishAssets } from '../src/assets/publish.js'
import { updateAssetMetadata } from '../src/assets/update-metadata.js'
import { createContentRoot } from '../src/content-root.js'
import { createFilesystemProvider } from '../src/providers/filesystem.js'
import { buildSelector } from '../src/schema/dimensions.js'
import { tempDir } from './_helpers/temp.js'

const testDir = tempDir('publish-assets-locale-test-' + Date.now())
const sourceDir = join(testDir, 'source')
const targetDir = join(testDir, 'target')

async function jpeg(width = 800, height = 400): Promise<Uint8Array> {
  const buf = await sharp({
    create: { width, height, channels: 3, background: { r: 128, g: 128, b: 128 } },
  })
    .jpeg()
    .toBuffer()
  return new Uint8Array(buf)
}

function streamOf(bytes: Uint8Array): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(c) {
      c.enqueue(bytes)
      c.close()
    },
  })
}

async function seedSourceAsset(name: string, bytes: Uint8Array) {
  const storage = createFilesystemProvider(sourceDir)
  return ingestAsset({
    storage,
    assetsRoot: 'assets',
    bytes: streamOf(bytes),
    requestedName: name,
    alt: null,
    uploadedBy: '',
  })
}

async function seedLocaleOverride(name: string, locale: string, bytes: Uint8Array) {
  const storage = createFilesystemProvider(sourceDir)
  return ingestLocaleBytes({
    storage,
    assetsRoot: 'assets',
    assetName: name,
    selector: buildSelector({ locale })!,
    bytes: streamOf(bytes),
  })
}

async function seedSourcePage(name: string, content: Record<string, unknown>, locale?: string) {
  const dir = join(sourceDir, 'pages', name)
  await mkdir(dir, { recursive: true })
  const file = locale ? `page.${locale}.json` : 'page.json'
  await writeFile(join(dir, file), JSON.stringify({ template: 'page-default', route: `/${name}`, content }))
}

function roots() {
  return {
    sourceRoot: createContentRoot(createFilesystemProvider(sourceDir)),
    targetRoot: createContentRoot(createFilesystemProvider(targetDir)),
  }
}

beforeEach(async () => {
  await mkdir(sourceDir, { recursive: true })
  await mkdir(targetDir, { recursive: true })
})

afterEach(async () => {
  await rm(testDir, { recursive: true, force: true })
})

describe('publishAssets - locale overrides (#1350)', () => {
  it('copies the locale override manifest, bytes, and variants', async () => {
    const { manifest } = await seedSourceAsset('hero', await jpeg(1000, 500))
    await seedLocaleOverride('hero', 'fr', await jpeg(1200, 600))
    await seedSourcePage('home', { hero: { _asset: 'hero' } })

    const result = await publishAssets({ ...roots(), itemNames: ['pages/home'] })
    expect(result.ok).toBe(true)

    // Default footprint landed.
    expect(existsSync(join(targetDir, 'assets/hero.asset.json'))).toBe(true)
    expect(existsSync(join(targetDir, `assets/hero-${manifest.hash}.jpg`))).toBe(true)

    // Override slice landed: manifest, primary bytes, variants.
    expect(existsSync(join(targetDir, 'assets/hero.asset.fr.json'))).toBe(true)
    const frManifest = JSON.parse(await readFile(join(sourceDir, 'assets/hero.asset.fr.json'), 'utf-8'))
    expect(existsSync(join(targetDir, `assets/hero-${frManifest.hash}.fr.jpg`))).toBe(true)
    for (const v of frManifest.variants ?? []) {
      expect(existsSync(join(targetDir, `assets/${v.path}`))).toBe(true)
    }
  })

  it('copies an override added after the first publish', async () => {
    await seedSourceAsset('hero', await jpeg(1000, 500))
    await seedSourcePage('home', { hero: { _asset: 'hero' } })

    const first = await publishAssets({ ...roots(), itemNames: ['pages/home'] })
    expect(first.ok).toBe(true)
    expect(existsSync(join(targetDir, 'assets/hero.asset.fr.json'))).toBe(false)

    await seedLocaleOverride('hero', 'fr', await jpeg(1200, 600))

    const second = await publishAssets({ ...roots(), itemNames: ['pages/home'] })
    expect(second.ok).toBe(true)
    if (!second.ok) return
    expect(second.copiedFiles).toBeGreaterThan(0)
    expect(existsSync(join(targetDir, 'assets/hero.asset.fr.json'))).toBe(true)
  })

  it('copies an asset referenced only by a locale variant of a page', async () => {
    const { manifest } = await seedSourceAsset('hero', await jpeg(1000, 500))
    await seedSourcePage('home', { title: 'no assets in the default locale' })
    await seedSourcePage('home', { hero: { _asset: 'hero' } }, 'fr')

    const result = await publishAssets({ ...roots(), itemNames: ['pages/home'] })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.copiedAssets).toBe(1)
    expect(existsSync(join(targetDir, `assets/hero-${manifest.hash}.jpg`))).toBe(true)
  })

  it('updates the target manifest when the alt changes after the first publish', async () => {
    await seedSourceAsset('hero', await jpeg(1000, 500))
    await seedSourcePage('home', { hero: { _asset: 'hero' } })

    const first = await publishAssets({ ...roots(), itemNames: ['pages/home'] })
    expect(first.ok).toBe(true)

    await updateAssetMetadata({
      storage: createFilesystemProvider(sourceDir),
      assetsRoot: 'assets',
      assetName: 'hero',
      patch: { alt: 'New alt text' },
    })

    const second = await publishAssets({ ...roots(), itemNames: ['pages/home'] })
    expect(second.ok).toBe(true)

    const targetManifest = JSON.parse(await readFile(join(targetDir, 'assets/hero.asset.json'), 'utf-8'))
    expect(targetManifest.alt).toBe('New alt text')
  })
})
