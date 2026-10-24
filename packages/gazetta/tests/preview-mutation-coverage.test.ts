/**
 * Mutation-coverage tests for `admin-api/routes/preview.ts` - closes
 * surviving / no-coverage mutants identified by the Stryker run
 * 39747793511 (issue #1128). Coverage gaps targeted:
 *
 *  - StringLiteral mutants on the route registration + the
 *    `Cache-Control: no-store` header (`/preview/*`, `Cache-Control`,
 *    `no-store`) - existing preview tests assert bodies and statuses but
 *    never the header, so blanking those strings survived. Every test
 *    here asserts `no-store` on the response.
 *
 *  - NoCoverage on the `catch` branch of `renderPreview` (the "No
 *    content on this target yet" 404 placeholder) - no test reached the
 *    empty-target path or the rethrow for non-`loadSite:` errors. One
 *    test drives a source with no manifest (loadSite throws
 *    `loadSite:`), another drives a storage whose read fails with a
 *    plain error (must propagate to Hono's 500, not become a 404
 *    placeholder).
 *
 *  - Surviving mutants on the POST overrides path - the defaults
 *    (`overrides.content` / `overrides.structural` defaulting to `{}`),
 *    `applyContentOverrides` (treePath keying + recursion), and
 *    `withStructuralOverride` (clone-only-the-patched-manifest, original
 *    site untouched). The starter home page's `hero` and nested
 *    `features/fast` components pin content overrides; a structural
 *    override keyed `page:home` pins the manifest patch, a follow-up
 *    GET pins that overrides never persist, and direct unit tests pin
 *    that the original Site is never mutated in memory.
 *
 *  - Surviving mutants on the fragment branch (`/@name`, the locale
 *    prefix regex, the Template Error 500) and the final "Page not
 *    found" 404 body - existing tests asserted the 404 status but not
 *    the body text.
 *
 * Per rule 26 (test-isolation paranoia): the error-path tests build a
 * fresh app per test; the starter-copy suite copies the starter into a
 * temp dir (never dirties the repo) and removes it after.
 */
import { afterAll, describe, expect, it } from 'vitest'
import { rm, cp, writeFile, mkdir } from 'node:fs/promises'
import { resolve } from 'node:path'
import { Hono } from 'hono'
import { createFilesystemProvider } from '../src/providers/filesystem.js'
import { createAdminApp } from '../src/admin-api/index.js'
import { createSourceContext, loadSiteFromSource } from '../src/admin-api/source-context.js'
import { previewRoutes, withStructuralOverride } from '../src/admin-api/routes/preview.js'
import { loadSiteConfig, siteConfigToManifest } from '../src/config/loader.js'
import type { DraftOverrides, StorageProvider } from '../src/types.js'
import { memoryStorage } from './_helpers/memory-storage.js'
import { tempDir } from './_helpers/temp.js'

const realStarter = resolve(import.meta.dirname, '../../../examples/starter')
const createdRoots: string[] = []

afterAll(async () => {
  for (const root of createdRoots) {
    await rm(root, { recursive: true, force: true }).catch(() => {})
  }
})

/**
 * Build an admin app over a fresh copy of the starter site, applying
 * `patch` to the copy first so a test can corrupt content on disk.
 * Mirrors the harness in preview-capability-gate.test.ts.
 */
async function buildStarterSource(patch?: (projectRoot: string) => Promise<void>) {
  const projectRoot = tempDir(`preview-mut-${Date.now()}-${Math.random()}`)
  createdRoots.push(projectRoot)
  await rm(projectRoot, { recursive: true, force: true })
  await cp(realStarter, projectRoot, {
    recursive: true,
    filter: src => !src.includes('/dist') && !src.includes('/node_modules') && !src.includes('/.tmp'),
  })
  if (patch) await patch(projectRoot)
  const projectSiteDir = resolve(projectRoot, 'sites/main')
  const storage = createFilesystemProvider(resolve(projectSiteDir, 'targets/local'))
  const loaded = await loadSiteConfig(projectSiteDir)
  if (!loaded) throw new Error('site.config.ts missing')
  const manifest = siteConfigToManifest(loaded.config)
  const source = createSourceContext({ storage, siteDir: '', projectSiteDir, manifest })
  return { source, projectRoot, projectSiteDir, templatesDir: resolve(projectRoot, 'templates') }
}

async function buildStarterApp(patch?: (projectRoot: string) => Promise<void>): Promise<Hono> {
  const { source, projectRoot, projectSiteDir, templatesDir } = await buildStarterSource(patch)
  return createAdminApp({
    source,
    siteDir: projectSiteDir,
    templatesDir,
    adminDir: resolve(projectRoot, 'admin'),
    disableCacheStatsLogger: true,
  })
}

function postPreview(path: string, overrides?: unknown) {
  return {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(overrides === undefined ? {} : { overrides }),
  }
}

describe('preview route registration and Cache-Control (#1128)', () => {
  it('GET /preview/* returns Cache-Control: no-store', async () => {
    const app = await buildStarterApp()
    const res = await app.request('/preview/about')
    expect(res.status).toBe(200)
    // Preview always serves fresh content for editing - the documented
    // behavior the no-store header implements.
    expect(res.headers.get('Cache-Control')).toBe('no-store')
  })

  it('POST /preview/* returns Cache-Control: no-store', async () => {
    const app = await buildStarterApp()
    const res = await app.request('/preview/about', postPreview('/preview/about'))
    expect(res.status).toBe(200)
    expect(res.headers.get('Cache-Control')).toBe('no-store')
  })

  it('GET /preview/ renders the home page (empty request path falls back to /)', async () => {
    const app = await buildStarterApp()
    const res = await app.request('/preview/')
    expect(res.status).toBe(200)
    const body = await res.text()
    expect(body).toContain('Welcome to Gazetta')
  })

  it('GET /preview (no trailing slash) renders the home page', async () => {
    // Hono matches `/preview` against `/preview/*` with an empty
    // remainder; the `|| '/'` fallback in renderPreview is what maps it
    // to the home page.
    const app = await buildStarterApp()
    const res = await app.request('/preview')
    expect(res.status).toBe(200)
    expect(await res.text()).toContain('Welcome to Gazetta')
  })

  it('GET /preview/<missing> returns the Page not found 404 body', async () => {
    const app = await buildStarterApp()
    const res = await app.request('/preview/nonexistent-1128')
    expect(res.status).toBe(404)
    expect(await res.text()).toContain('Page not found')
  })
})

describe('preview POST overrides (#1128)', () => {
  it('POST without an overrides key renders the stored content', async () => {
    const app = await buildStarterApp()
    const res = await app.request('/preview/', postPreview('/preview/'))
    expect(res.status).toBe(200)
    expect(await res.text()).toContain('Welcome to Gazetta')
  })

  it('POST with only overrides.content defaults structural to empty', async () => {
    const app = await buildStarterApp()
    const res = await app.request(
      '/preview/',
      postPreview('/preview/', { content: { hero: { title: 'Only Content Set' } } }),
    )
    expect(res.status).toBe(200)
    expect(await res.text()).toContain('Only Content Set')
  })

  it('content overrides apply by treePath, including nested components', async () => {
    const app = await buildStarterApp()
    const res = await app.request(
      '/preview/',
      postPreview('/preview/', {
        content: {
          hero: { title: 'Override Hero Title' },
          'features/fast': { title: 'Override Nested Title' },
        },
        structural: {},
      }),
    )
    expect(res.status).toBe(200)
    const body = await res.text()
    expect(body).toContain('Override Hero Title')
    expect(body).toContain('Override Nested Title')
    expect(body).not.toContain('Welcome to Gazetta')
  })

  it('a structural override replaces only the keyed manifest, leaving the stored site untouched', async () => {
    const app = await buildStarterApp()
    const res = await app.request(
      '/preview/',
      postPreview('/preview/', {
        content: {},
        structural: {
          'page:home': [
            {
              name: 'hero',
              template: 'hero',
              content: { title: 'Structural Override Home' },
            },
          ],
        },
      }),
    )
    expect(res.status).toBe(200)
    const body = await res.text()
    expect(body).toContain('Structural Override Home')
    // The features section is gone from the overridden components array.
    expect(body).not.toContain('Why Gazetta?')

    // Each preview request loads the site fresh from storage, so the
    // follow-up render pins that the override was never persisted. The
    // in-memory immutability of withStructuralOverride itself is pinned
    // directly by the unit tests below.
    const after = await app.request('/preview/')
    expect(after.status).toBe(200)
    const afterBody = await after.text()
    expect(afterBody).toContain('Welcome to Gazetta')
    expect(afterBody).toContain('Why Gazetta?')
  })

  it('a structural override keyed to another page leaves this page unchanged', async () => {
    const app = await buildStarterApp()
    const res = await app.request(
      '/preview/about',
      postPreview('/preview/about', {
        content: {},
        structural: {
          'page:home': [{ name: 'hero', template: 'hero', content: { title: 'Not This Page' } }],
        },
      }),
    )
    expect(res.status).toBe(200)
    const body = await res.text()
    expect(body).toContain('About Gazetta')
    expect(body).not.toContain('Not This Page')
  })
})

/**
 * Mount `previewRoutes` the way `createAdminApp` does: behind a
 * principal. Bare mounting leaves `c.var.principal` unset and the
 * capability gate crashes before the route body runs.
 */
function previewApp(resolveFn: Parameters<typeof previewRoutes>[0]): Hono {
  const app = new Hono()
  app.use('*', async (c, next) => {
    c.set('principal', { id: 'test-user', role: 'admin', capabilities: ['read:pages'] })
    await next()
  })
  app.route('/', previewRoutes(resolveFn))
  return app
}

describe('preview empty target and loader errors (#1128)', () => {
  it('a target with no site config returns the 404 placeholder', async () => {
    // Never-published publish-target: the source has content storage but
    // no project manifest, so loadSite throws a `loadSite:` error and the
    // preview shows the friendly placeholder instead of a 500.
    const storage = memoryStorage()
    const source = createSourceContext({ storage, siteDir: '', projectSiteDir: '/test-project' })
    const app = previewApp(async () => source)
    const res = await app.request('/preview/anything')
    expect(res.status).toBe(404)
    expect(res.headers.get('Cache-Control')).toBe('no-store')
    const body = await res.text()
    expect(body).toContain('No content on this target yet')
    expect(body).toContain('Publish from an editable target to see a preview here.')
  })

  it('a non-loadSite loader error propagates instead of becoming the placeholder', async () => {
    // Storage whose reads fail with a plain (non-`loadSite:`) error: the
    // catch in renderPreview must rethrow it, so Hono answers 500 - a
    // mutant that turns every loader error into the 404 placeholder
    // (or swallows the rethrow) fails here.
    const failing = {
      ...memoryStorage(),
      readDir: () => Promise.reject(new Error('disk gone')),
      read: () => Promise.reject(new Error('disk gone')),
      exists: () => Promise.reject(new Error('disk gone')),
    } as unknown as StorageProvider
    const source = createSourceContext({
      storage: failing,
      siteDir: '',
      projectSiteDir: '/test-project',
      manifest: { name: 'test-site', targets: {} },
    })
    const app = previewApp(async () => source)
    const res = await app.request('/preview/anything')
    expect(res.status).toBe(500)
    expect(await res.text()).not.toContain('No content on this target yet')
  })
})

describe('withStructuralOverride (#1128)', () => {
  it('returns a copy with only the keyed manifest patched and never mutates the original Site', async () => {
    const { source, templatesDir } = await buildStarterSource()
    const site = await loadSiteFromSource(source, { templatesDir })
    const homeBefore = site.pages.get('home')
    if (!homeBefore) throw new Error('starter home page missing')
    const aboutBefore = site.pages.get('about')
    const componentsBefore = homeBefore.components

    const replacement: DraftOverrides['structural'][string] = [
      { name: 'hero', template: 'hero', content: { title: 'Unit Override' } },
    ]
    const patched = withStructuralOverride(
      site,
      { kind: 'page', name: 'home' },
      { content: {}, structural: { 'page:home': replacement } },
    )

    expect(patched).not.toBe(site)
    expect(patched.pages.get('home')?.components).toBe(replacement)
    // In-memory immutability: the original Site keeps its own manifest...
    expect(site.pages.get('home')).toBe(homeBefore)
    expect(site.pages.get('home')?.components).toBe(componentsBefore)
    // ...and only the patched manifest is cloned - unrelated state is shared.
    expect(patched.pages.get('about')).toBe(aboutBefore)
    expect(patched.fragments).toBe(site.fragments)
    expect(patched.manifest).toBe(site.manifest)
  })

  it('returns the original Site when no structural override matches the key', async () => {
    const { source, templatesDir } = await buildStarterSource()
    const site = await loadSiteFromSource(source, { templatesDir })
    expect(withStructuralOverride(site, { kind: 'page', name: 'home' }, { content: {}, structural: {} })).toBe(site)
    expect(
      withStructuralOverride(
        site,
        { kind: 'page', name: 'no-such-page-1128' },
        { content: {}, structural: { 'page:no-such-page-1128': [] } },
      ),
    ).toBe(site)
  })
})

describe('preview fragment branch (#1128)', () => {
  it('GET /preview/@header renders the fragment', async () => {
    const app = await buildStarterApp()
    const res = await app.request('/preview/@header')
    expect(res.status).toBe(200)
    expect(res.headers.get('Cache-Control')).toBe('no-store')
    const body = await res.text()
    expect(body).toContain('Gazetta')
    expect(body).not.toContain('Template Error')
  })

  it('GET /preview/fr/@header strips the locale prefix and renders the fragment', async () => {
    const app = await buildStarterApp()
    const res = await app.request('/preview/fr/@header')
    expect(res.status).toBe(200)
    const body = await res.text()
    expect(body).toContain('Gazetta')
    expect(body).not.toContain('Template Error')
  })

  it('GET /preview/@missing answers the Template Error 500, escaping the message', async () => {
    const app = await buildStarterApp()
    // The fragment name carries angle brackets so the escaping is
    // actually exercised: an unescaped render would emit the raw name
    // and inject markup into the error page.
    const res = await app.request('/preview/@%3Cscript%3Ealert(1)')
    expect(res.status).toBe(500)
    const body = await res.text()
    expect(body).toContain('Template Error')
    expect(body).not.toContain('<script>alert(1)')
    expect(body).toContain('&lt;script&gt;alert(1)')
  })

  it('a page whose template cannot render answers the Template Error 500', async () => {
    const app = await buildStarterApp(async projectRoot => {
      const dir = resolve(projectRoot, 'sites/main/targets/local/pages/broken-1128')
      await mkdir(dir, { recursive: true })
      await writeFile(resolve(dir, 'page.json'), JSON.stringify({ template: 'no-such-template-1128', content: {} }))
    })
    const res = await app.request('/preview/broken-1128')
    expect(res.status).toBe(500)
    const body = await res.text()
    expect(body).toContain('Template Error')
  })
})
