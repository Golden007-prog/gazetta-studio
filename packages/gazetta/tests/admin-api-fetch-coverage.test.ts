/**
 * Mutation-coverage tests for `POST /api/fetch` in
 * `src/admin-api/routes/publish.ts` (lines 881-944) — closes the
 * NoCoverage bulk reported on issue #703. Today's test surface for
 * `/api/fetch` is schema-only ([apps/admin/tests/api-contract.test.ts](../../../apps/admin/tests/api-contract.test.ts)
 * only parses response shapes); the route handler itself — 63 lines
 * of body-parsing, target lookup, discovery walk, and copy path —
 * has no behavioral test.
 *
 * Each test names the mutation surface it kills.
 *
 * Per [team-preferences.md rule 31](.claude/rules/team-preferences.md):
 * API-first tier for the admin-api surface; mutation testing is the
 * discovery tool, route handlers are the test subject.
 */
import { describe, expect, it } from 'vitest'
import type { Hono } from 'hono'
import { createAdminApp } from '../src/admin-api/index.js'
import { createSourceContext } from '../src/admin-api/source-context.js'
import { memoryStorage, type MemoryStorage } from './_helpers/memory-storage.js'

interface Built {
  app: Hono
  sourceStorage: MemoryStorage
  remoteStorage: MemoryStorage
}

/**
 * Two-target setup: `local` is the editable source (destination for
 * fetches); `remote` is the target we fetch from. Both are memory
 * storages; `remote` gets pre-seeded per test with whatever content
 * the fetch is expected to copy back.
 */
function buildApp(): Built {
  const sourceStorage = memoryStorage()
  const remoteStorage = memoryStorage()

  const targetConfigs = {
    local: { storage: sourceStorage, type: 'esi' as const, environment: 'local' as const, editable: true },
    remote: { storage: remoteStorage, type: 'esi' as const, environment: 'staging' as const },
  }

  const source = createSourceContext({
    storage: sourceStorage,
    siteDir: '',
    projectSiteDir: '/test-project',
    manifest: { name: 'test-site', targets: targetConfigs },
  })

  const app = createAdminApp({
    source,
    siteDir: '/test-project',
    templatesDir: '/test-project/templates',
    targets: new Map([
      ['local', sourceStorage],
      ['remote', remoteStorage],
    ]),
    targetConfigs,
    disableCacheStatsLogger: true,
  })

  return { app, sourceStorage, remoteStorage }
}

describe('POST /api/fetch — input validation (covers publish.ts:886-890)', () => {
  it('returns 400 with a specific message when the `source` field is missing', async () => {
    // Kills the string literal at line 886 (`'Missing "source" target
    // name'` → `""`). The error prose IS the contract; a mutation to
    // empty string produces the same 400 status but a different (empty)
    // body message that the admin UI can't display meaningfully.
    const { app } = buildApp()

    const res = await app.request('/api/fetch', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    })

    expect(res.status).toBe(400)
    const body = (await res.json()) as { error: string }
    expect(body.error).toBe('Missing "source" target name')
  })

  it('returns 400 when the requested source target is not registered', async () => {
    // Kills the string-template mutation at line 890
    // (`\`Unknown target: ${body.source}\`` → `""`) AND the
    // ConditionalExpression at line 889 (`!targetStorage` → `false`
    // would skip the guard and proceed with an undefined
    // targetStorage, throwing later — the 400-with-error-body
    // contract catches the mutation via response shape).
    const { app } = buildApp()

    const res = await app.request('/api/fetch', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ source: 'does-not-exist' }),
    })

    expect(res.status).toBe(400)
    const body = (await res.json()) as { error: string }
    expect(body.error).toBe('Unknown target: does-not-exist')
  })
})

describe('POST /api/fetch — discovery walk (covers publish.ts:900-927)', () => {
  it('fetches nested items when discovery lists only their parent directories', async () => {
    const { app, remoteStorage, sourceStorage } = buildApp()
    const files = {
      'pages/about/page.json': JSON.stringify({ template: 'parent' }),
      'pages/about/team/page.json': JSON.stringify({ template: 'child' }),
      'pages/about/team/page.fr.json': JSON.stringify({ template: 'child-fr' }),
      'fragments/header/fragment.json': JSON.stringify({ template: 'header' }),
      'fragments/header/nested/fragment.json': JSON.stringify({ template: 'nested' }),
    }
    remoteStorage.seed(files)

    const res = await app.request('/api/fetch', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ source: 'remote' }),
    })

    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ success: true, copiedFiles: 5, items: ['pages/about', 'fragments/header'] })
    for (const [key, value] of Object.entries(files)) expect(await sourceStorage.readFile(key)).toBe(value)
  })

  it('returns 404 when the target is empty and no explicit items were requested', async () => {
    // Kills the ConditionalExpression at line 929 (`items.length ===
    // 0` → `false` would skip the 404 and try to copy an empty
    // item list, producing a 200 with `copiedFiles: 0` instead of
    // the honest 404). Also kills the string literal `'No content
    // found on target'` → `""`.
    const { app } = buildApp()

    const res = await app.request('/api/fetch', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ source: 'remote' }),
    })

    expect(res.status).toBe(404)
    const body = (await res.json()) as { error: string }
    expect(body.error).toBe('No content found on target')
  })

  it('discovers pages on the remote target when no items are supplied', async () => {
    // Kills the string literal `'pages'` at line 906 → `""`
    // (mutation would probe an empty-string path, `exists('')`
    // returns false in memoryStorage, no pages discovered), the
    // ConditionalExpression at line 906 (`if (await
    // targetStorage.exists('pages'))` → `false` skips discovery
    // entirely), the BlockStatement inside the if (`{}` skips the
    // readDir + loop), and the ConditionalExpression at line 909
    // (`if (p.isDirectory)` → `false` skips push).
    const { app, remoteStorage, sourceStorage } = buildApp()
    remoteStorage.seed({
      'pages/home/page.json': JSON.stringify({ template: 'page-default', route: '/', content: {} }),
      'pages/about/page.json': JSON.stringify({ template: 'page-default', route: '/about', content: {} }),
    })

    const res = await app.request('/api/fetch', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ source: 'remote' }),
    })

    expect(res.status).toBe(200)
    const body = (await res.json()) as { success: boolean; copiedFiles: number; items: string[] }
    expect(body.success).toBe(true)
    expect(body.copiedFiles).toBeGreaterThan(0)
    expect(body.items.sort()).toEqual(['pages/about', 'pages/home'])
    // Side-effect verification: the fetch actually copied bytes to
    // the destination (source) storage — the request-handler
    // contract isn't just "return item names," it's "copy bytes."
    expect(await sourceStorage.exists('pages/home/page.json')).toBe(true)
    expect(await sourceStorage.exists('pages/about/page.json')).toBe(true)
  })

  it('discovers fragments on the remote target when no items are supplied', async () => {
    // Kills the string literal `'fragments'` at line 912 → `""`
    // (mutation would probe an empty-string path), the
    // ConditionalExpression at line 912 (`if (await
    // targetStorage.exists('fragments'))` → `false` skips discovery),
    // the BlockStatement at lines 913-916 (`{}` skips readDir +
    // loop), and the string template `\`fragments/${f.name}\``.
    const { app, remoteStorage, sourceStorage } = buildApp()
    remoteStorage.seed({
      'fragments/header/fragment.json': JSON.stringify({ template: 'header-layout' }),
      'fragments/footer/fragment.json': JSON.stringify({ template: 'footer-layout' }),
    })

    const res = await app.request('/api/fetch', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ source: 'remote' }),
    })

    expect(res.status).toBe(200)
    const body = (await res.json()) as { success: boolean; items: string[] }
    expect(body.items.sort()).toEqual(['fragments/footer', 'fragments/header'])
    expect(await sourceStorage.exists('fragments/header/fragment.json')).toBe(true)
    expect(await sourceStorage.exists('fragments/footer/fragment.json')).toBe(true)
  })

  it('discovers templates on the remote target when no items are supplied', async () => {
    // Kills the string literal `'templates'` at line 918 → `""`
    // (mutation would probe an empty-string path), the
    // ConditionalExpression at line 918 (`if (await
    // targetStorage.exists('templates'))` → `false` skips discovery),
    // and the BlockStatement at lines 919-922 (`{}` skips readDir +
    // loop).
    const { app, remoteStorage, sourceStorage } = buildApp()
    remoteStorage.seed({
      'templates/hero/index.tsx': 'export default () => ({ html: "", css: "", js: "" })',
      'templates/card/index.tsx': 'export default () => ({ html: "", css: "", js: "" })',
    })

    const res = await app.request('/api/fetch', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ source: 'remote' }),
    })

    expect(res.status).toBe(200)
    const body = (await res.json()) as { success: boolean; items: string[] }
    expect(body.items.sort()).toEqual(['templates/card', 'templates/hero'])
    expect(await sourceStorage.exists('templates/hero/index.tsx')).toBe(true)
    expect(await sourceStorage.exists('templates/card/index.tsx')).toBe(true)
  })

  it('discovers pages + fragments + templates together when all three are present', async () => {
    // Compound coverage — the sequential `if (await exists(...))`
    // blocks at lines 906 / 912 / 918 all fire in one request. Any
    // BlockStatement mutation to `{}` on one of the three drops the
    // corresponding entries from `items`. The union assertion
    // catches all three independent mutations.
    const { app, remoteStorage } = buildApp()
    remoteStorage.seed({
      'pages/home/page.json': JSON.stringify({ template: 'page-default', route: '/', content: {} }),
      'fragments/header/fragment.json': JSON.stringify({ template: 'header-layout' }),
      'templates/hero/index.tsx': 'export default () => ({ html: "", css: "", js: "" })',
    })

    const res = await app.request('/api/fetch', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ source: 'remote' }),
    })

    expect(res.status).toBe(200)
    const body = (await res.json()) as { items: string[] }
    expect(body.items.sort()).toEqual(['fragments/header', 'pages/home', 'templates/hero'])
  })
})

describe('POST /api/fetch — explicit items path (covers publish.ts:900-902 + 933-938)', () => {
  it('honors an explicit `items` list, skipping the discovery walk', async () => {
    // Kills the ConditionalExpression at line 901 (`if
    // (body.items?.length)` → `false` would ignore explicit items
    // and fall into discovery, which would find both seeded pages
    // instead of the one requested).
    const { app, remoteStorage, sourceStorage } = buildApp()
    remoteStorage.seed({
      'pages/home/page.json': JSON.stringify({ template: 'page-default', route: '/', content: {} }),
      'pages/about/page.json': JSON.stringify({ template: 'page-default', route: '/about', content: {} }),
    })

    const res = await app.request('/api/fetch', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ source: 'remote', items: ['pages/home'] }),
    })

    expect(res.status).toBe(200)
    const body = (await res.json()) as { success: boolean; copiedFiles: number; items: string[] }
    expect(body.success).toBe(true)
    expect(body.items).toEqual(['pages/home'])
    // Discovery would have also copied about; explicit-items skips it.
    expect(await sourceStorage.exists('pages/home/page.json')).toBe(true)
    expect(await sourceStorage.exists('pages/about/page.json')).toBe(false)
  })

  it('returns success:true + accurate copiedFiles when the copy completes', async () => {
    // Kills the string literal on line 938 (`success: true` /
    // response-shape mutations that flip the boolean or return
    // structurally different shape). Also anchors the `copiedFiles`
    // number to the actual bytes copied — a mutation returning `0`
    // regardless would pass the type check but the assertion here
    // fails.
    const { app, remoteStorage } = buildApp()
    remoteStorage.seed({
      'pages/home/page.json': JSON.stringify({ template: 'page-default', route: '/', content: {} }),
    })

    const res = await app.request('/api/fetch', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ source: 'remote', items: ['pages/home'] }),
    })

    expect(res.status).toBe(200)
    const body = (await res.json()) as { success: boolean; copiedFiles: number }
    expect(body.success).toBe(true)
    // At least the page manifest was copied. publishItems may also
    // copy sidecars; assert a lower bound rather than an exact count
    // to survive sidecar policy changes.
    expect(body.copiedFiles).toBeGreaterThanOrEqual(1)
  })
})
