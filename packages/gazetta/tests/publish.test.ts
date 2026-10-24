import { describe, it, expect, beforeAll, beforeEach, afterEach } from 'vitest'
import { join, resolve } from 'node:path'
import { writeFile, mkdir, rm, readdir } from 'node:fs/promises'
import { createFilesystemProvider } from '../src/providers/filesystem.js'
import { filesystemStorage, r2Storage, s3Storage } from '../src/providers/factories.js'
import { publishItems, resolveDependencies } from '../src/publish.js'
import { publishPage } from '../src/pages/publish.js'
import { publishFragment } from '../src/fragments/publish.js'
import type { PublishItemResult, PublishTarget } from '../src/publish-item.js'
import type { StorageProvider } from '../src/types.js'
import { createContentRoot } from '../src/content-root.js'
import { loadSite, type Site } from '../src/site-loader.js'
import { tempDir } from './_helpers/temp.js'
import { starterManifest, starterTargetDir, starterTemplatesDir } from './_helpers/starter.js'

const testDir = tempDir('publish-test-' + Date.now())
const sourceDir = join(testDir, 'source')
const targetDir = join(testDir, 'target')

async function writeTestFile(base: string, path: string, content: string) {
  const full = join(base, path)
  await mkdir(join(full, '..'), { recursive: true })
  await writeFile(full, content)
}

type PublishOk = Extract<PublishItemResult, { ok: true }>
type PubOpts = { type?: PublishTarget['type']; manifestHash?: string; cache?: PublishTarget['cache']; locale?: string }

/**
 * Publish through the per-kind wrappers that `publishRun` calls per item
 * — the path the CLI and admin take. (These tests used to call the old
 * `publish-rendered.ts` functions, which nothing in production calls.)
 */
async function pubPage(name: string, site: Site, storage: StorageProvider, opts: PubOpts = {}): Promise<PublishOk> {
  const result = await publishPage({
    name,
    locale: opts.locale,
    site,
    sourceRoot: createContentRoot(storage),
    target: { name: 'test', storage, type: opts.type ?? 'esi', manifestHash: opts.manifestHash, cache: opts.cache },
  })
  if (!result.ok) throw new Error(`publishPage ${name}: ${result.code} ${result.reason}`)
  return result
}

async function pubFragment(name: string, site: Site, storage: StorageProvider, opts: PubOpts = {}): Promise<PublishOk> {
  const result = await publishFragment({
    name,
    locale: opts.locale,
    site,
    sourceRoot: createContentRoot(storage),
    target: { name: 'test', storage, type: opts.type ?? 'esi', manifestHash: opts.manifestHash },
  })
  if (!result.ok) throw new Error(`publishFragment ${name}: ${result.code} ${result.reason}`)
  return result
}

beforeEach(async () => {
  await mkdir(sourceDir, { recursive: true })
  await mkdir(targetDir, { recursive: true })
})

afterEach(async () => {
  await rm(testDir, { recursive: true, force: true })
})

describe('publishItems', () => {
  it('copies a single page directory', async () => {
    await writeTestFile(sourceDir, 'pages/home/page.json', JSON.stringify({ template: 'default' }))

    const source = createFilesystemProvider(sourceDir)
    const target = createFilesystemProvider(targetDir)

    const { copiedFiles } = await publishItems(createContentRoot(source), createContentRoot(target), ['pages/home'])
    expect(copiedFiles).toBe(1)
    expect(await target.exists('pages/home/page.json')).toBe(true)
  })

  it('copies multiple items', async () => {
    await writeTestFile(sourceDir, 'pages/home/page.json', JSON.stringify({ template: 'default' }))
    await writeTestFile(sourceDir, 'fragments/header/fragment.json', JSON.stringify({ template: 'header' }))

    const source = createFilesystemProvider(sourceDir)
    const target = createFilesystemProvider(targetDir)

    const { copiedFiles } = await publishItems(createContentRoot(source), createContentRoot(target), [
      'pages/home',
      'fragments/header',
    ])
    expect(copiedFiles).toBe(2)
    expect(await target.exists('pages/home/page.json')).toBe(true)
    expect(await target.exists('fragments/header/fragment.json')).toBe(true)
  })

  it('copies nested directory structure', async () => {
    await writeTestFile(sourceDir, 'pages/blog/[slug]/page.json', JSON.stringify({ template: 'article' }))

    const source = createFilesystemProvider(sourceDir)
    const target = createFilesystemProvider(targetDir)

    const { copiedFiles } = await publishItems(createContentRoot(source), createContentRoot(target), [
      'pages/blog/[slug]',
    ])
    expect(copiedFiles).toBe(1)
    expect(await target.exists('pages/blog/[slug]/page.json')).toBe(true)
  })

  it('preserves file content', async () => {
    const content = JSON.stringify({ template: 'page-default', metadata: { title: 'Home' } })
    await writeTestFile(sourceDir, 'pages/home/page.json', content)

    const source = createFilesystemProvider(sourceDir)
    const target = createFilesystemProvider(targetDir)

    await publishItems(createContentRoot(source), createContentRoot(target), ['pages/home'])
    const copied = await target.readFile('pages/home/page.json')
    expect(copied).toBe(content)
  })

  it('returns 0 for nonexistent items', async () => {
    const source = createFilesystemProvider(sourceDir)
    const target = createFilesystemProvider(targetDir)

    const { copiedFiles } = await publishItems(createContentRoot(source), createContentRoot(target), [
      'pages/nonexistent',
    ])
    expect(copiedFiles).toBe(0)
  })

  it('accepts ContentRoot inputs (preferred shape)', async () => {
    await writeTestFile(sourceDir, 'pages/home/page.json', JSON.stringify({ template: 'default' }))

    const source = createFilesystemProvider(sourceDir)
    const target = createFilesystemProvider(targetDir)

    const sourceRoot = createContentRoot(source)
    const targetRoot = createContentRoot(target)

    const { copiedFiles } = await publishItems(sourceRoot, targetRoot, ['pages/home'])
    expect(copiedFiles).toBe(1)
    expect(await target.exists('pages/home/page.json')).toBe(true)
  })
})

describe('resolveDependencies', () => {
  it('includes the item itself', async () => {
    await writeTestFile(sourceDir, 'pages/home/page.json', JSON.stringify({ template: 'default' }))

    const storage = createFilesystemProvider(sourceDir)
    const deps = await resolveDependencies(createContentRoot(storage), ['pages/home'])
    expect(deps).toContain('pages/home')
  })

  it('accepts ContentRoot input (preferred shape)', async () => {
    await writeTestFile(
      sourceDir,
      'pages/home/page.json',
      JSON.stringify({
        template: 'default',
        components: ['@header', { name: 'hero', template: 'hero' }],
      }),
    )

    const storage = createFilesystemProvider(sourceDir)

    const root = createContentRoot(storage)

    const deps = await resolveDependencies(root, ['pages/home'])
    expect(deps).toContain('pages/home')
    expect(deps).toContain('fragments/header')
    expect(deps).toContain('templates/hero')
  })

  it('resolves template dependency', async () => {
    await writeTestFile(sourceDir, 'pages/home/page.json', JSON.stringify({ template: 'page-default' }))

    const storage = createFilesystemProvider(sourceDir)
    const deps = await resolveDependencies(createContentRoot(storage), ['pages/home'])
    expect(deps).toContain('templates/page-default')
  })

  it('resolves fragment dependencies', async () => {
    await writeTestFile(
      sourceDir,
      'pages/home/page.json',
      JSON.stringify({
        template: 'default',
        components: ['@header', { name: 'hero', template: 'hero' }],
      }),
    )

    const storage = createFilesystemProvider(sourceDir)
    const deps = await resolveDependencies(createContentRoot(storage), ['pages/home'])
    expect(deps).toContain('fragments/header')
    expect(deps).toContain('templates/hero')
  })

  it('resolves nested fragment dependencies', async () => {
    await writeTestFile(
      sourceDir,
      'pages/home/page.json',
      JSON.stringify({
        template: 'default',
        components: ['@header'],
      }),
    )
    await writeTestFile(
      sourceDir,
      'fragments/header/fragment.json',
      JSON.stringify({
        template: 'header-layout',
        components: [
          { name: 'logo', template: 'logo' },
          { name: 'nav', template: 'nav' },
        ],
      }),
    )

    const storage = createFilesystemProvider(sourceDir)
    const deps = await resolveDependencies(createContentRoot(storage), ['pages/home'])
    expect(deps).toContain('fragments/header')
    expect(deps).toContain('templates/header-layout')
    expect(deps).toContain('templates/logo')
    expect(deps).toContain('templates/nav')
  })

  it('deduplicates dependencies', async () => {
    await writeTestFile(
      sourceDir,
      'pages/home/page.json',
      JSON.stringify({ template: 'default', components: ['@header', '@footer'] }),
    )
    await writeTestFile(
      sourceDir,
      'pages/about/page.json',
      JSON.stringify({ template: 'default', components: ['@header', '@footer'] }),
    )

    const storage = createFilesystemProvider(sourceDir)
    const deps = await resolveDependencies(createContentRoot(storage), ['pages/home', 'pages/about'])
    const templateCount = deps.filter(d => d === 'templates/default').length
    expect(templateCount).toBe(1) // not duplicated
  })

  it('handles items without manifests', async () => {
    await mkdir(join(sourceDir, 'pages/empty'), { recursive: true })

    const storage = createFilesystemProvider(sourceDir)
    const deps = await resolveDependencies(createContentRoot(storage), ['pages/empty'])
    expect(deps).toContain('pages/empty')
    expect(deps).toHaveLength(1)
  })
})

describe('page + fragment publish to an ESI target', () => {
  const starterDir = starterTargetDir
  const templatesDir = starterTemplatesDir
  const storage = createFilesystemProvider()
  const renderTargetDir = tempDir('render-test-' + Date.now())
  let site: Site

  beforeAll(async () => {
    const manifest = await starterManifest()
    site = await loadSite({ siteDir: starterDir, storage, templatesDir, manifest })
  })

  afterEach(async () => {
    await rm(renderTargetDir, { recursive: true, force: true })
  })

  it('publishes a page as HTML with ESI placeholders and hashed CSS', async () => {
    const target = createFilesystemProvider(renderTargetDir)
    const { files } = await pubPage('home', site, target, { type: 'esi' })
    expect(files).toBeGreaterThanOrEqual(2) // index.html + styles.{hash}.css

    // Check page HTML exists with ESI tags and title from content
    const html = await target.readFile('pages/home/index.html')
    expect(html).toContain('<!DOCTYPE html>')
    expect(html).toContain('<!--esi:/fragments/header/index.html-->')
    expect(html).toContain('Welcome to Gazetta')
    // ESI publish path now runs resolveSeoTags for <head> SEO injection.
    // metadata.title wins via the fallback chain.
    expect(html).toContain('<title>Gazetta — Composable CMS</title>')

    // Check hashed CSS exists
    const entries = await target.readDir('pages/home')
    const cssFiles = entries.filter(e => e.name.endsWith('.css'))
    expect(cssFiles.length).toBe(1)
    expect(cssFiles[0].name).toMatch(/^styles\.[a-f0-9]{8}\.css$/)
  })

  it('publishes a fragment as HTML with hashed CSS', async () => {
    const target = createFilesystemProvider(renderTargetDir)

    const { files } = await pubFragment('header', site, target)
    expect(files).toBeGreaterThanOrEqual(2) // index.html + styles.{hash}.css

    const html = await target.readFile('fragments/header/index.html')
    expect(html).toContain('<head>')
    expect(html).toContain('stylesheet')
    expect(html).toContain('Gazetta')

    const entries = await target.readDir('fragments/header')
    const cssFiles = entries.filter(e => e.name.endsWith('.css'))
    expect(cssFiles.length).toBe(1)
  })

  it('cleans up old hashed files when content changes', async () => {
    const target = createFilesystemProvider(renderTargetDir)

    // First publish

    await pubFragment('header', site, target)
    const entries1 = await target.readDir('fragments/header')
    const css1 = entries1.find(e => e.name.endsWith('.css'))!.name

    // Write a fake old hashed CSS file
    await target.writeFile(`fragments/header/styles.00000000.css`, '.old {}')
    const entriesBefore = await target.readDir('fragments/header')
    expect(entriesBefore.filter(e => e.name.endsWith('.css')).length).toBe(2)

    // Publish again — same content, same hash

    await pubFragment('header', site, target)
    const entriesAfter = await target.readDir('fragments/header')
    const cssAfter = entriesAfter.filter(e => e.name.endsWith('.css'))

    // Old fake file should be cleaned up, real file kept
    expect(cssAfter.length).toBe(1)
    expect(cssAfter[0].name).toBe(css1)
  })

  it('page publish cleans up old hashed JS files', async () => {
    const target = createFilesystemProvider(renderTargetDir)

    // First publish
    await pubPage('home', site, target, { type: 'esi' })

    // Write fake old files
    await target.writeFile('pages/home/styles.00000000.css', '.old {}')
    await target.writeFile('pages/home/script.00000000.js', '// old')

    // Publish again
    await pubPage('home', site, target, { type: 'esi' })
    const entries = await target.readDir('pages/home')
    const oldCss = entries.filter(e => e.name === 'styles.00000000.css')
    const oldJs = entries.filter(e => e.name === 'script.00000000.js')
    expect(oldCss.length).toBe(0)
    expect(oldJs.length).toBe(0)
  })

  it('bakes cache config comment into page HTML with defaults', async () => {
    const target = createFilesystemProvider(renderTargetDir)
    await pubPage('home', site, target, { type: 'esi' })
    const html = await target.readFile('pages/home/index.html')
    expect(html).toMatch(/^<!--cache:browser=0,edge=86400-->/)
    expect(html).toContain('<!DOCTYPE html>')
  })

  it('bakes target cache config into page HTML', async () => {
    const target = createFilesystemProvider(renderTargetDir)
    await pubPage('home', site, target, { type: 'esi', cache: { browser: 120, edge: 3600 } })
    const html = await target.readFile('pages/home/index.html')
    expect(html).toMatch(/^<!--cache:browser=120,edge=3600-->/)
  })

  it('cache comment is on first line before DOCTYPE', async () => {
    const target = createFilesystemProvider(renderTargetDir)
    await pubPage('home', site, target, { type: 'esi' })
    const html = await target.readFile('pages/home/index.html')
    const lines = html.split('\n')
    expect(lines[0]).toMatch(/^<!--cache:/)
    expect(lines[1]).toBe('<!DOCTYPE html>')
  })
})

describe('page publish to a static target', () => {
  const projectRoot2 = resolve(import.meta.dirname, '../../../examples/starter')
  const starterDir = resolve(projectRoot2, 'sites/main/targets/local')
  const templatesDir = resolve(projectRoot2, 'templates')
  const storage = createFilesystemProvider()
  const staticTargetDir = tempDir('static-test-' + Date.now())
  let site: Site

  beforeAll(async () => {
    const manifest = await starterManifest()
    site = await loadSite({ siteDir: starterDir, storage, templatesDir, manifest })
  })

  afterEach(async () => {
    await rm(staticTargetDir, { recursive: true, force: true })
  })

  it('publishes fully assembled HTML at URL path', async () => {
    const target = createFilesystemProvider(staticTargetDir)

    await pubPage('home', site, target, { type: 'static' })
    const html = await target.readFile('index.html')
    expect(html).toContain('<!DOCTYPE html>')
    expect(html).toContain('Welcome to Gazetta')
    // Static publish uses renderPage which runs the SEO fallback chain.
    // metadata.title wins over content.title.
    expect(html).toContain('<title>Gazetta — Composable CMS</title>')
    // Fragments baked in
    expect(html).toContain('Gazetta') // from header
    expect(html).toContain('© 2026') // from footer
    // No ESI tags
    expect(html).not.toContain('<!--esi')
  })

  it('publishes about page at /about/index.html', async () => {
    const target = createFilesystemProvider(staticTargetDir)

    await pubPage('about', site, target, { type: 'static' })
    const html = await target.readFile('about/index.html')
    expect(html).toContain('About Gazetta')
    expect(html).not.toContain('<!--esi')
  })

  it('includes inline CSS and JS', async () => {
    const target = createFilesystemProvider(staticTargetDir)

    await pubPage('home', site, target, { type: 'static' })
    const html = await target.readFile('index.html')
    expect(html).toContain('<style>')
    // Counter JS should be inline
    expect(html).toContain('script type="module"')
  })

  it('no separate CSS/JS files', async () => {
    const target = createFilesystemProvider(staticTargetDir)

    await pubPage('home', site, target, { type: 'static' })
    const entries = await target.readDir('.')
    const cssOrJs = entries.filter(e => e.name.endsWith('.css') || e.name.endsWith('.js'))
    expect(cssOrJs.length).toBe(0)
  })
})

// Soft-delete Cut 3: archived pages emit only the marker line as the
// published HTML — no body, no doctype, no CSS/JS. Worker reads the
// first 200 bytes and short-circuits with 301 / 410.
//
// Tests use memoryStorage where possible (the archived short-circuit
// returns BEFORE template loading; no jiti / filesystem needed). The
// cleanup test exercises the live-publish path first, which needs a
// real templatesDir on disk for jiti import.
describe('archived-page publish (Cut 3)', () => {
  it('ESI target: emits ONLY the alias marker for archived pages with aliasOf', async () => {
    const { memoryStorage } = await import('./_helpers/memory-storage.js')
    const { loadSite } = await import('../src/site-loader.js')
    const source = memoryStorage()
    const target = memoryStorage()
    source.seed({
      'pages/landing/page.json': JSON.stringify({
        template: 'echo',
        archived: true,
        archivedAt: '2026-05-09T10:00:00Z',
        archivedBy: 'alice@example.com',
        aliasOf: 'welcome',
      }),
      'pages/welcome/page.json': JSON.stringify({ template: 'echo' }),
    })
    const site = await loadSite({
      contentRoot: createContentRoot(source),
      templatesDir: '/__not-loaded__', // archived short-circuit returns before template loading
      manifest: { name: '(archive-test)' },
    })

    const result = await pubPage('landing', site, target, { type: 'esi' })

    expect(result.files).toBe(1)
    const html = await target.readFile('pages/landing/index.html')
    expect(html).toBe('<!-- gazetta:archived alias=welcome -->\n')
    expect(html).not.toContain('<!DOCTYPE')
    expect(html).not.toContain('<!--esi:')
    const entries = await target.readDir('pages/landing')
    const cssOrJs = entries.filter(e => e.name.endsWith('.css') || e.name.endsWith('.js'))
    expect(cssOrJs.length).toBe(0)
  })

  it('ESI target: emits the gone marker for pure soft-delete (no aliasOf)', async () => {
    const { memoryStorage } = await import('./_helpers/memory-storage.js')
    const { loadSite } = await import('../src/site-loader.js')
    const source = memoryStorage()
    const target = memoryStorage()
    source.seed({
      'pages/landing/page.json': JSON.stringify({
        template: 'echo',
        archived: true,
        archivedAt: '2026-05-09T10:00:00Z',
      }),
    })
    const site = await loadSite({
      contentRoot: createContentRoot(source),
      manifest: { name: '(archive-test)' },
    })

    await pubPage('landing', site, target, { type: 'esi' })

    const html = await target.readFile('pages/landing/index.html')
    expect(html).toBe('<!-- gazetta:archived gone -->\n')
  })

  it('static target: emits ONLY the alias marker at the route URL path', async () => {
    const { memoryStorage } = await import('./_helpers/memory-storage.js')
    const { loadSite } = await import('../src/site-loader.js')
    const source = memoryStorage()
    const target = memoryStorage()
    source.seed({
      'pages/landing/page.json': JSON.stringify({ template: 'echo', archived: true, aliasOf: 'welcome' }),
      'pages/welcome/page.json': JSON.stringify({ template: 'echo' }),
    })
    const site = await loadSite({
      contentRoot: createContentRoot(source),
      manifest: { name: '(archive-test)' },
    })

    await pubPage('landing', site, target, { type: 'static' })

    // Static publish maps page.route to disk path: /landing → landing/index.html
    const html = await target.readFile('landing/index.html')
    expect(html).toBe('<!-- gazetta:archived alias=welcome -->\n')
  })

  it('static target: emits gone marker at /landing/index.html for soft-delete', async () => {
    const { memoryStorage } = await import('./_helpers/memory-storage.js')
    const { loadSite } = await import('../src/site-loader.js')
    const source = memoryStorage()
    const target = memoryStorage()
    source.seed({
      'pages/landing/page.json': JSON.stringify({ template: 'echo', archived: true }),
    })
    const site = await loadSite({
      contentRoot: createContentRoot(source),
      manifest: { name: '(archive-test)' },
    })

    await pubPage('landing', site, target, { type: 'static' })
    const html = await target.readFile('landing/index.html')
    expect(html).toBe('<!-- gazetta:archived gone -->\n')
  })

  it('writes the page content-hash sidecar for compare-targets even when archived', async () => {
    const { memoryStorage } = await import('./_helpers/memory-storage.js')
    const { loadSite } = await import('../src/site-loader.js')
    const source = memoryStorage()
    const target = memoryStorage()
    source.seed({
      'pages/landing/page.json': JSON.stringify({ template: 'echo', archived: true, aliasOf: 'welcome' }),
      'pages/welcome/page.json': JSON.stringify({ template: 'echo' }),
    })
    const site = await loadSite({ contentRoot: createContentRoot(source), manifest: { name: '(archive-test)' } })

    await pubPage('landing', site, target, { type: 'esi', manifestHash: 'abcd1234' })

    // .{hash}.hash + .pub-{ts} sidecars present in pages/landing/
    const entries = await target.readDir('pages/landing')
    expect(entries.some(e => e.name === '.abcd1234.hash')).toBe(true)
    expect(entries.some(e => e.name.startsWith('.pub-'))).toBe(true)
  })
})

// Real-template tests — exercise the live-render pipeline plus archive
// transitions; need a filesystem templates directory because the live
// path goes through jiti's import.
describe('archived-page publish — live-to-archive cleanup (Cut 3)', () => {
  const archiveTestDir = tempDir('archive-publish-test-' + Date.now())
  const archiveSourceDir = join(archiveTestDir, 'source')
  const archiveTargetDir = join(archiveTestDir, 'target')
  const archiveTemplatesDir = join(archiveTestDir, 'templates')

  beforeEach(async () => {
    await mkdir(archiveSourceDir, { recursive: true })
    await mkdir(archiveTargetDir, { recursive: true })
    await mkdir(join(archiveTemplatesDir, 'echo'), { recursive: true })
    await writeFile(
      join(archiveTemplatesDir, 'echo/index.ts'),
      `import { z } from 'zod'\nexport const schema = z.object({ text: z.string().optional() })\nexport default ({ content }) => ({ html: '<div>' + (content?.text ?? '') + '</div>', css: 'div { color: red; }', js: '', head: '' })\n`,
    )
  })

  afterEach(async () => {
    await rm(archiveTestDir, { recursive: true, force: true })
  })

  it('cleans up old hashed CSS/JS files when a previously-live page is archived', async () => {
    const { loadSite } = await import('../src/site-loader.js')
    await writeTestFile(
      archiveSourceDir,
      'pages/landing/page.json',
      JSON.stringify({ template: 'echo', content: { text: 'live' } }),
    )
    let site = await loadSite({
      siteDir: archiveSourceDir,
      storage: createFilesystemProvider(),
      templatesDir: archiveTemplatesDir,
      manifest: { name: '(archive-test)' },
    })
    const target = createFilesystemProvider(archiveTargetDir)

    // Live publish — emits index.html + styles.{hash}.css
    await pubPage('landing', site, target, { type: 'esi' })
    const liveEntries = await target.readDir('pages/landing')
    expect(liveEntries.some(e => /styles\.[a-f0-9]{8}\.css$/.test(e.name))).toBe(true)

    // Archive the page; republish should write ONLY the marker + clean CSS
    await writeTestFile(
      archiveSourceDir,
      'pages/landing/page.json',
      JSON.stringify({ template: 'echo', content: { text: 'live' }, archived: true, aliasOf: 'welcome' }),
    )
    await writeTestFile(archiveSourceDir, 'pages/welcome/page.json', JSON.stringify({ template: 'echo' }))
    site = await loadSite({
      siteDir: archiveSourceDir,
      storage: createFilesystemProvider(),
      templatesDir: archiveTemplatesDir,
      manifest: { name: '(archive-test)' },
    })
    const result = await pubPage('landing', site, target, { type: 'esi' })

    const html = await target.readFile('pages/landing/index.html')
    expect(html).toBe('<!-- gazetta:archived alias=welcome -->\n')
    const archiveEntries = await target.readDir('pages/landing')
    const cssOrJs = archiveEntries.filter(e => /\.[a-f0-9]{8}\.(css|js)$/.test(e.name))
    expect(cssOrJs.length).toBe(0)
    expect(result.removed).toBeGreaterThan(0)
  })

  it('non-archived pages still render normally (regression)', async () => {
    const { loadSite } = await import('../src/site-loader.js')
    await writeTestFile(
      archiveSourceDir,
      'pages/home/page.json',
      JSON.stringify({ template: 'echo', content: { text: 'live' } }),
    )
    const site = await loadSite({
      siteDir: archiveSourceDir,
      storage: createFilesystemProvider(),
      templatesDir: archiveTemplatesDir,
      manifest: { name: '(archive-test)' },
    })
    const target = createFilesystemProvider(archiveTargetDir)
    await pubPage('home', site, target, { type: 'esi' })

    const html = await target.readFile('pages/home/index.html')
    // Live page renders the full document — DOCTYPE + head + body + cache
    // comment. The archive short-circuit produces a single-line marker;
    // this assertion proves the live path is unchanged.
    expect(html).toContain('<!DOCTYPE html>')
    expect(html).toContain('<body>')
    expect(html).not.toContain('gazetta:archived')
  })
})

describe('isEditable', () => {
  it('defaults to true for a private local target (explicit or unset environment)', async () => {
    const { isEditable } = await import('../src/types.js')
    const r2 = () => r2Storage({ accountId: 'a', bucket: 'b', accessKeyId: 'k', secretAccessKey: 's' })
    expect(isEditable({ storage: filesystemStorage({ path: './dist' }), publicStorage: false })).toBe(true)
    expect(isEditable({ storage: r2(), environment: 'local', publicStorage: false })).toBe(true)
    // Storage left to the default resolves public, so not editable
    expect(isEditable({ storage: r2() })).toBe(false)
    expect(isEditable({ storage: filesystemStorage({ path: './dist' }) })).toBe(false)
  })

  it('defaults to false for staging and production', async () => {
    const { isEditable } = await import('../src/types.js')
    expect(
      isEditable({
        storage: r2Storage({ accountId: 'a', bucket: 'b', accessKeyId: 'k', secretAccessKey: 's' }),
        environment: 'staging',
      }),
    ).toBe(false)
    expect(
      isEditable({
        storage: r2Storage({ accountId: 'a', bucket: 'b', accessKeyId: 'k', secretAccessKey: 's' }),
        environment: 'production',
      }),
    ).toBe(false)
  })

  it('respects explicit editable: false on local target', async () => {
    const { isEditable } = await import('../src/types.js')
    expect(isEditable({ storage: filesystemStorage({ path: './dist' }), editable: false })).toBe(false)
  })

  it('respects explicit editable: true on staging/production', async () => {
    const { isEditable } = await import('../src/types.js')
    expect(
      isEditable({
        storage: r2Storage({ accountId: 'a', bucket: 'b', accessKeyId: 'k', secretAccessKey: 's' }),
        environment: 'staging',
        editable: true,
      }),
    ).toBe(true)
    expect(
      isEditable({
        storage: r2Storage({ accountId: 'a', bucket: 'b', accessKeyId: 'k', secretAccessKey: 's' }),
        environment: 'production',
        editable: true,
      }),
    ).toBe(true)
  })
})

describe('getType', () => {
  // Import dynamically to avoid circular deps
  it('returns dynamic when worker-capable deploy adapter configured', async () => {
    const { getType } = await import('../src/types.js')
    const { cloudflareWorkersDeploy } = await import('../src/deploy/cloudflare-workers.js')
    expect(
      getType({
        storage: r2Storage({ accountId: 'a', bucket: 'b', accessKeyId: 'k', secretAccessKey: 's' }),
        deploy: cloudflareWorkersDeploy({ apiToken: 't', accountId: 'a', name: 'n', bucket: 'b' }),
      }),
    ).toBe('dynamic')
  })

  it('returns static when no deploy adapter', async () => {
    const { getType } = await import('../src/types.js')
    expect(getType({ storage: filesystemStorage({ path: './dist' }) })).toBe('static')
  })

  it('respects explicit type over deploy adapter inference', async () => {
    const { getType } = await import('../src/types.js')
    const { cloudflareWorkersDeploy } = await import('../src/deploy/cloudflare-workers.js')
    // Dynamic without deploy adapter (for gazetta serve)
    expect(
      getType({
        storage: s3Storage({ endpoint: 'http://x', bucket: 'b', accessKeyId: 'k', secretAccessKey: 's' }),
        type: 'dynamic',
      }),
    ).toBe('dynamic')
    // Static even with worker-capable adapter (explicit override)
    expect(
      getType({
        storage: r2Storage({ accountId: 'a', bucket: 'b', accessKeyId: 'k', secretAccessKey: 's' }),
        deploy: cloudflareWorkersDeploy({ apiToken: 't', accountId: 'a', name: 'n', bucket: 'b' }),
        type: 'static',
      }),
    ).toBe('static')
  })
})

describe('findDependentsFromSidecars', () => {
  it('returns pages that reference a fragment via reverse fragment-deps sidecars', async () => {
    const { findDependentsFromSidecars } = await import('../src/publish.js')
    const target = createFilesystemProvider(targetDir)
    // Reverse-sidecar shape: .gazetta/fragment-deps/{frag}/{encoded-item}
    // (per step 13b — replaces the legacy .uses-* forward sidecars).
    await writeTestFile(targetDir, '.gazetta/fragment-deps/header/pages.home', '')
    await writeTestFile(targetDir, '.gazetta/fragment-deps/footer/pages.home', '')
    await writeTestFile(targetDir, '.gazetta/fragment-deps/header/pages.about', '')
    await writeTestFile(targetDir, '.gazetta/fragment-deps/header/pages.blog.[slug]', '')

    const r = await findDependentsFromSidecars(createContentRoot(target), { fragment: 'header' })
    expect(r.pages.sort()).toEqual(['about', 'blog/[slug]', 'home'])
    expect(r.fragments).toEqual([])
  })

  it('walks transitive fragment→fragment references', async () => {
    const { findDependentsFromSidecars } = await import('../src/publish.js')
    const target = createFilesystemProvider(targetDir)
    // header references inner-logo; home references header. Querying
    // inner-logo must BFS through header to find home.
    await writeTestFile(targetDir, '.gazetta/fragment-deps/inner-logo/fragments.header', '')
    await writeTestFile(targetDir, '.gazetta/fragment-deps/header/pages.home', '')

    const r = await findDependentsFromSidecars(createContentRoot(target), { fragment: 'inner-logo' })
    expect(r.pages).toEqual(['home'])
    expect(r.fragments).toEqual(['header'])
  })

  it('returns empty sets when target has no sidecars', async () => {
    const { findDependentsFromSidecars } = await import('../src/publish.js')
    const target = createFilesystemProvider(targetDir)
    const r = await findDependentsFromSidecars(createContentRoot(target), { fragment: 'header' })
    expect(r.pages).toEqual([])
    expect(r.fragments).toEqual([])
  })

  it('accepts baseDir for source-storage queries (unrooted provider)', async () => {
    const { findDependentsFromSidecars } = await import('../src/publish.js')
    const sourceDir = join(targetDir, '../source-root/sites/main')
    await writeTestFile(sourceDir, '.gazetta/fragment-deps/header/pages.home', '')
    const source = createFilesystemProvider()

    const r = await findDependentsFromSidecars(createContentRoot(source, sourceDir), { fragment: 'header' })
    expect(r.pages).toEqual(['home'])
  })
})

describe('SEO publish integration', () => {
  const projectRoot2 = resolve(import.meta.dirname, '../../../examples/starter')
  const starterDir = resolve(projectRoot2, 'sites/main/targets/local')
  const templatesDir = resolve(projectRoot2, 'templates')
  const storage = createFilesystemProvider()
  const seoTargetDir = tempDir('seo-publish-test-' + Date.now())
  let seoManifest: Awaited<ReturnType<typeof starterManifest>>

  beforeAll(async () => {
    seoManifest = await starterManifest()
  })

  beforeEach(async () => {
    await mkdir(seoTargetDir, { recursive: true })
  })
  afterEach(async () => {
    await rm(seoTargetDir, { recursive: true, force: true })
  })

  it('.pub sidecar is written with timestamp after static publish', { timeout: 15_000 }, async () => {
    const target = createFilesystemProvider(seoTargetDir)
    const { hashManifest } = await import('../src/hash.js')
    const { loadSite } = await import('../src/site-loader.js')
    const { scanTemplates, templateHashesFrom } = await import('../src/templates-scan.js')

    const contentRoot = createContentRoot(storage, starterDir)
    const site = await loadSite({ contentRoot, templatesDir, manifest: seoManifest })
    const templateInfos = await scanTemplates(templatesDir, projectRoot2)
    const templateHashes = templateHashesFrom(templateInfos)
    const page = site.pages.get('home')!
    const hash = hashManifest(page, { templateHashes })

    const before = Date.now()
    await pubPage('home', site, target, { type: 'static', manifestHash: hash })
    const after = Date.now()

    // The .pub-* sidecar should exist on the target under pages/home/
    const entries = await target.readDir('pages/home')
    const pubFile = entries.find(e => e.name.startsWith('.pub-'))
    expect(pubFile).toBeDefined()
    expect(pubFile!.name).toMatch(/^\.pub-\d{8}T\d{6}Z$/)

    // Parse and check timestamp is within the test window.
    // compactTimestamp truncates milliseconds, so the parsed value
    // can be up to 1s before `before`. Use a 2s window.
    const { parsePubSidecarName } = await import('../src/hash.js')
    const parsed = parsePubSidecarName(pubFile!.name)
    expect(parsed).not.toBeNull()
    expect(parsed!.noindex).toBe(false)
    const ts = new Date(parsed!.lastPublished).getTime()
    expect(ts).toBeGreaterThanOrEqual(before - 2000)
    expect(ts).toBeLessThanOrEqual(after + 2000)
  })

  it('.pub sidecar has noindex flag when page metadata contains noindex', async () => {
    // Create a source with a noindex page
    const noindexSourceDir = tempDir('noindex-source-' + Date.now())
    await mkdir(join(noindexSourceDir, 'pages/secret'), { recursive: true })
    await writeFile(
      join(noindexSourceDir, 'pages/secret/page.json'),
      JSON.stringify({
        template: 'page-default',
        content: { title: 'Secret' },
        metadata: { robots: 'noindex' },
      }),
    )
    // No site config file needed: loadSite() below receives `manifest` directly.
    const target = createFilesystemProvider(seoTargetDir)
    const { hashManifest } = await import('../src/hash.js')
    const { loadSite } = await import('../src/site-loader.js')
    const { scanTemplates, templateHashesFrom } = await import('../src/templates-scan.js')

    const contentRoot = createContentRoot(createFilesystemProvider(), noindexSourceDir)
    const site = await loadSite({ contentRoot, templatesDir, manifest: seoManifest })
    const templateInfos = await scanTemplates(templatesDir, projectRoot2)
    const templateHashes = templateHashesFrom(templateInfos)
    const page = site.pages.get('secret')!
    const hash = hashManifest(page, { templateHashes })

    await pubPage('secret', site, target, { type: 'static', manifestHash: hash })

    const entries = await target.readDir('pages/secret')
    const pubFile = entries.find(e => e.name.startsWith('.pub-'))
    expect(pubFile).toBeDefined()
    expect(pubFile!.name).toMatch(/-noindex$/)

    const { parsePubSidecarName } = await import('../src/hash.js')
    const parsed = parsePubSidecarName(pubFile!.name)
    expect(parsed!.noindex).toBe(true)

    await rm(noindexSourceDir, { recursive: true, force: true })
  })

  it('sitemap.xml is generated from target sidecars after publish', async () => {
    const target = createFilesystemProvider(seoTargetDir)
    const { hashManifest } = await import('../src/hash.js')
    const { loadSite } = await import('../src/site-loader.js')
    const { scanTemplates, templateHashesFrom } = await import('../src/templates-scan.js')
    const { listSidecars } = await import('../src/sidecars.js')
    const { generateSitemap } = await import('../src/sitemap.js')

    const contentRoot = createContentRoot(storage, starterDir)
    const site = await loadSite({ contentRoot, templatesDir, manifest: seoManifest })
    const templateInfos = await scanTemplates(templatesDir, projectRoot2)
    const templateHashes = templateHashesFrom(templateInfos)

    // Publish home + about
    for (const name of ['home', 'about']) {
      const page = site.pages.get(name)!
      const hash = hashManifest(page, { templateHashes })
      await pubPage(name, site, target, { type: 'static', manifestHash: hash })
    }

    // Generate sitemap from target sidecars
    const sidecars = await listSidecars(target, 'pages')
    expect(sidecars.size).toBe(2)

    const xml = generateSitemap({
      siteUrl: 'https://example.com',
      pages: sidecars,
    })
    expect(xml).not.toBeNull()
    expect(xml).toContain('<loc>https://example.com/</loc>')
    expect(xml).toContain('<loc>https://example.com/about</loc>')
    expect(xml).toContain('<lastmod>')

    // Write and verify it's readable
    await target.writeFile('sitemap.xml', xml!)
    const stored = await target.readFile('sitemap.xml')
    expect(stored).toBe(xml)
  })

  it('robots.txt is generated with sitemap reference', async () => {
    const { generateRobotsTxt } = await import('../src/robots.js')
    const target = createFilesystemProvider(seoTargetDir)

    const txt = generateRobotsTxt({ siteUrl: 'https://example.com' })
    await target.writeFile('robots.txt', txt)

    const stored = await target.readFile('robots.txt')
    expect(stored).toContain('User-agent: *')
    expect(stored).toContain('Sitemap: https://example.com/sitemap.xml')
  })
})
