import { describe, it, expect, beforeEach, afterAll } from 'vitest'
import { mkdir, writeFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { compareTargets } from '../src/compare.js'
import { createFilesystemProvider } from '../src/providers/filesystem.js'
import { createContentRoot } from '../src/content-root.js'
import { sidecarNameFor } from '../src/hash.js'
import { tempDir } from './_helpers/temp.js'

const root = tempDir('compare-test-' + Date.now())
const siteDir = join(root, 'sites/main')
const targetDir = join(root, 'dist/staging')
const templatesDir = join(root, 'templates')

const source = createFilesystemProvider()
const sourceRoot = createContentRoot(source, siteDir)
let target = createFilesystemProvider(targetDir)

const TEMPLATE = `
export const schema = { type: 'object' }
export default ({ content }) => ({ html: '<p>' + (content?.title ?? '') + '</p>', css: '', js: '' })
`

async function reset() {
  await rm(root, { recursive: true, force: true })
  await mkdir(siteDir, { recursive: true })
  await mkdir(join(templatesDir, 'page'), { recursive: true })
  await writeFile(join(templatesDir, 'page/index.js'), TEMPLATE)
  await mkdir(join(siteDir, 'pages/home'), { recursive: true })
  await writeFile(
    join(siteDir, 'pages/home/page.json'),
    JSON.stringify({
      template: 'page',
      content: { title: 'Hello' },
    }),
  )
  await mkdir(join(siteDir, 'fragments/header'), { recursive: true })
  await writeFile(
    join(siteDir, 'fragments/header/fragment.json'),
    JSON.stringify({
      template: 'page',
      content: { title: 'Header' },
    }),
  )
  await mkdir(targetDir, { recursive: true })
  // Recreate target provider rooted at the (now-existing) targetDir
  target = createFilesystemProvider(targetDir)
}

beforeEach(reset)
afterAll(async () => {
  await rm(root, { recursive: true, force: true })
})

async function writeSidecar(dir: string, hash: string) {
  await mkdir(dir, { recursive: true })
  await writeFile(join(dir, sidecarNameFor(hash)), '')
}

describe('compareTargets', () => {
  it('returns firstPublish:true when target has no sidecars', async () => {
    const r = await compareTargets({ sourceRoot, target, templatesDir, projectRoot: root, manifest: { name: 'Test' } })
    expect(r.firstPublish).toBe(true)
    // Both pages and fragments are "added" since target is empty
    expect(r.added.sort()).toEqual(['fragments/header', 'pages/home'])
    expect(r.modified).toEqual([])
    expect(r.deleted).toEqual([])
  })

  it('returns unchanged when sidecars match', async () => {
    // First call to get the local hashes
    const r1 = await compareTargets({ sourceRoot, target, templatesDir, projectRoot: root, manifest: { name: 'Test' } })
    // Re-derive: we need the actual hashes — easiest is to publish "by hand" using r1.added
    // But we only have item names, not hashes. Easier: import hashManifest directly.
    const { hashManifest } = await import('../src/hash.js')
    const { scanTemplates, templateHashesFrom } = await import('../src/templates-scan.js')
    const { loadSite } = await import('../src/site-loader.js')
    const tpls = await scanTemplates(templatesDir, root)
    const tHashes = templateHashesFrom(tpls)
    const site = await loadSite({ siteDir, storage: source, templatesDir, manifest: { name: 'Test' } })
    for (const [name, page] of site.pages) {
      await writeSidecar(join(targetDir, 'pages', name), hashManifest(page, { templateHashes: tHashes }))
    }
    for (const [name, frag] of site.fragments) {
      await writeSidecar(join(targetDir, 'fragments', name), hashManifest(frag, { templateHashes: tHashes }))
    }

    const r2 = await compareTargets({ sourceRoot, target, templatesDir, projectRoot: root, manifest: { name: 'Test' } })
    expect(r2.firstPublish).toBe(false)
    expect(r2.unchanged.sort()).toEqual(['fragments/header', 'pages/home'])
    expect(r2.added).toEqual([])
    expect(r2.modified).toEqual([])
    expect(r1).toBeDefined()
  })

  it('detects modified when only the page metadata changed after a publish', async () => {
    const { hashManifest } = await import('../src/hash.js')
    const { scanTemplates, templateHashesFrom } = await import('../src/templates-scan.js')
    const { loadSite } = await import('../src/site-loader.js')
    const tHashes = templateHashesFrom(await scanTemplates(templatesDir, root))
    const site = await loadSite({ siteDir, storage: source, templatesDir, manifest: { name: 'Test' } })
    for (const [name, page] of site.pages) {
      await writeSidecar(join(targetDir, 'pages', name), hashManifest(page, { templateHashes: tHashes }))
    }
    for (const [name, frag] of site.fragments) {
      await writeSidecar(join(targetDir, 'fragments', name), hashManifest(frag, { templateHashes: tHashes }))
    }
    await writeFile(
      join(siteDir, 'pages/home/page.json'),
      JSON.stringify({ template: 'page', content: { title: 'Hello' }, metadata: { title: 'SEO title' } }),
    )

    const r = await compareTargets({ sourceRoot, target, templatesDir, projectRoot: root, manifest: { name: 'Test' } })
    expect(r.modified).toEqual(['pages/home'])
    expect(r.unchanged).toEqual(['fragments/header'])
  })

  it('detects modified when content changes locally', async () => {
    // Write a stale sidecar with wrong hash
    await writeSidecar(join(targetDir, 'pages/home'), '00000000')
    await writeSidecar(join(targetDir, 'fragments/header'), '00000000')

    const r = await compareTargets({ sourceRoot, target, templatesDir, projectRoot: root, manifest: { name: 'Test' } })
    expect(r.firstPublish).toBe(false)
    expect(r.modified.sort()).toEqual(['fragments/header', 'pages/home'])
  })

  it('detects deleted when target has items not present locally', async () => {
    await writeSidecar(join(targetDir, 'pages/home'), '00000000')
    await writeSidecar(join(targetDir, 'pages/old-page'), '11111111')

    const r = await compareTargets({ sourceRoot, target, templatesDir, projectRoot: root, manifest: { name: 'Test' } })
    expect(r.deleted).toContain('pages/old-page')
  })

  it('detects added when local has items not on target', async () => {
    // Add a new local page
    await mkdir(join(siteDir, 'pages/about'), { recursive: true })
    await writeFile(
      join(siteDir, 'pages/about/page.json'),
      JSON.stringify({
        template: 'page',
        content: { title: 'About' },
      }),
    )
    // Old sidecar for home so target isn't empty
    await writeSidecar(join(targetDir, 'pages/home'), '00000000')

    const r = await compareTargets({ sourceRoot, target, templatesDir, projectRoot: root, manifest: { name: 'Test' } })
    expect(r.added).toContain('pages/about')
  })

  it('reports invalid templates without failing the compare', async () => {
    // Break the template
    await writeFile(join(templatesDir, 'page/index.js'), 'this is not js!!!')
    const r = await compareTargets({ sourceRoot, target, templatesDir, projectRoot: root, manifest: { name: 'Test' } })
    expect(r.invalidTemplates.length).toBeGreaterThan(0)
    expect(r.invalidTemplates[0].name).toBe('page')
    // Compare still completes and lists items
    expect(r.added.length + r.modified.length + r.unchanged.length).toBeGreaterThan(0)
  })

  it('omits fragments when target is static (#119)', async () => {
    // Default (esi): fragments included
    const r1 = await compareTargets({ sourceRoot, target, templatesDir, projectRoot: root, manifest: { name: 'Test' } })
    expect(r1.added.some(x => x.startsWith('fragments/'))).toBe(true)

    // Static mode: fragments excluded from local + target walks
    const r2 = await compareTargets({
      sourceRoot,
      target,
      templatesDir,
      projectRoot: root,
      type: 'static',
      manifest: { name: 'Test' },
    })
    expect(r2.added.some(x => x.startsWith('fragments/'))).toBe(false)
    expect(r2.modified.some(x => x.startsWith('fragments/'))).toBe(false)
    expect(r2.unchanged.some(x => x.startsWith('fragments/'))).toBe(false)
    // Pages still compared normally
    expect(r2.added).toContain('pages/home')
  })

  it('static mode: fragment content change invalidates pages that use it', async () => {
    // Page bakes in @header.
    await writeFile(
      join(siteDir, 'pages/home/page.json'),
      JSON.stringify({
        template: 'page',
        content: { title: 'Hello' },
        components: ['@header'],
      }),
    )

    // Publish once: record the static-mode page hash on the target.
    const { hashManifest } = await import('../src/hash.js')
    const { scanTemplates, templateHashesFrom } = await import('../src/templates-scan.js')
    const { loadSite } = await import('../src/site-loader.js')
    const tpls = await scanTemplates(templatesDir, root)
    const tHashes = templateHashesFrom(tpls)
    let site = await loadSite({ siteDir, storage: source, templatesDir, manifest: { name: 'Test' } })
    const fragHashes = new Map<string, string>()
    for (const [n, f] of site.fragments) fragHashes.set(n, hashManifest(f, { templateHashes: tHashes }))
    for (const [n, p] of site.pages) {
      await writeSidecar(
        join(targetDir, 'pages', n),
        hashManifest(p, { templateHashes: tHashes, fragmentHashes: fragHashes }),
      )
    }

    // Sanity: unchanged before any edit.
    const r1 = await compareTargets({
      sourceRoot,
      target,
      templatesDir,
      projectRoot: root,
      type: 'static',
      manifest: { name: 'Test' },
    })
    expect(r1.unchanged).toContain('pages/home')

    // Mutate the fragment's content — page manifest untouched.
    await writeFile(
      join(siteDir, 'fragments/header/fragment.json'),
      JSON.stringify({
        template: 'page',
        content: { title: 'Header EDITED' },
      }),
    )

    // Page must show modified — its baked-in output is now stale.
    const r2 = await compareTargets({
      sourceRoot,
      target,
      templatesDir,
      projectRoot: root,
      type: 'static',
      manifest: { name: 'Test' },
    })
    expect(r2.modified).toContain('pages/home')
  })

  it('ignores fabricated source-side sidecar hashes — always re-hashes from manifests', async () => {
    // Compare must NOT trust source-side `.{hash}.hash` sidecars (they
    // could be stale after a template-source edit). It always recomputes
    // from the in-memory manifest. Proof: fabricate a matching pair on
    // source + target; the manifest hash differs from "deadbeef" so the
    // items show as modified, not unchanged.
    const fake = 'deadbeef'
    await writeSidecar(join(siteDir, 'pages/home'), fake)
    await writeSidecar(join(siteDir, 'fragments/header'), fake)
    await writeSidecar(join(targetDir, 'pages/home'), fake)
    await writeSidecar(join(targetDir, 'fragments/header'), fake)

    const r = await compareTargets({ sourceRoot, target, templatesDir, projectRoot: root, manifest: { name: 'Test' } })
    // With the cache dropped, the source's recomputed hash differs from
    // the fabricated target hash → items show as modified, not unchanged.
    expect(r.modified).toContain('pages/home')
    expect(r.modified).toContain('fragments/header')
    expect(r.unchanged).not.toContain('pages/home')
    expect(r.unchanged).not.toContain('fragments/header')
  })
})
