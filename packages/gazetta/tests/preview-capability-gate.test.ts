/**
 * Security regression test for the `/preview/*` route family.
 *
 * The preview routes render full page + fragment content (and accept
 * POST draft overrides). They are mounted at `/preview/*`, NOT under
 * `/api/*`, so the principal middleware that gates every other admin
 * route never ran for them — under a configured trust mode an
 * unauthenticated request could read any page's rendered content,
 * bypassing the trust mode entirely.
 *
 * These tests pin the capability gate: under a real trust mode an
 * unauthenticated preview request is rejected; an authenticated one
 * still renders. `none` mode (the default) stays open — preview keeps
 * working for solo / dev with no auth configured.
 */
import { afterAll, describe, expect, it } from 'vitest'
import { rm, cp } from 'node:fs/promises'
import { resolve } from 'node:path'
import type { Hono } from 'hono'
import { createFilesystemProvider } from '../src/providers/filesystem.js'
import { createAdminApp } from '../src/admin-api/index.js'
import { createSourceContext } from '../src/admin-api/source-context.js'
import { loadSiteConfig, siteConfigToManifest } from '../src/config/loader.js'
import { tempDir } from './_helpers/temp.js'
import { fromConnection } from './_helpers/connection.js'

const realStarter = resolve(import.meta.dirname, '../../../examples/starter')
const createdRoots: string[] = []

afterAll(async () => {
  for (const root of createdRoots) {
    await rm(root, { recursive: true, force: true }).catch(() => {})
  }
})

/**
 * Build an admin app over a fresh copy of the starter site, optionally
 * patching an `admin.auth` block into the source manifest. Mirrors the
 * setup in `auth-integration.test.ts`.
 */
async function buildApp(authBlock: Record<string, unknown> | undefined): Promise<Hono> {
  const projectRoot = tempDir(`preview-gate-${Date.now()}-${Math.random()}`)
  createdRoots.push(projectRoot)
  await rm(projectRoot, { recursive: true, force: true })
  await cp(realStarter, projectRoot, {
    recursive: true,
    filter: src => !src.includes('/dist') && !src.includes('/node_modules') && !src.includes('/.tmp'),
  })
  const projectSiteDir = resolve(projectRoot, 'sites/main')
  const storage = createFilesystemProvider(resolve(projectSiteDir, 'targets/local'))
  const loaded = await loadSiteConfig(projectSiteDir)
  if (!loaded) throw new Error('site.config.ts missing')
  const manifest = siteConfigToManifest(loaded.config)
  if (authBlock) manifest.admin = { ...(manifest.admin ?? {}), auth: authBlock }
  const source = createSourceContext({ storage, siteDir: '', projectSiteDir, manifest })
  return createAdminApp({
    source,
    siteDir: projectSiteDir,
    templatesDir: resolve(projectRoot, 'templates'),
    adminDir: resolve(projectRoot, 'admin'),
    disableCacheStatsLogger: true,
  })
}

// forwarded-user mode with a trusted proxy whitelist — a connection from
// 10.0.0.5 is trusted to set the forwarded headers; absence of
// `X-Forwarded-User` means no authenticated identity.
const FORWARDED_USER = { trust: 'forwarded-user', trustedProxies: ['10.0.0.0/8'] }
const FROM_PROXY = fromConnection('10.0.0.5')

describe('preview route capability gate', () => {
  it('GET /preview/* rejects an unauthenticated request under a real trust mode', async () => {
    const app = await buildApp(FORWARDED_USER)
    const res = await app.request('/preview/about', {}, FROM_PROXY) // trusted proxy, but no user
    expect(res.status).toBe(401)
    const body = await res.json()
    expect(body.code).toBe('UNAUTHENTICATED')
  })

  it('POST /preview/* (draft overrides) rejects an unauthenticated request', async () => {
    const app = await buildApp(FORWARDED_USER)
    const res = await app.request(
      '/preview/',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ overrides: { content: {}, structural: {} } }),
      },
      FROM_PROXY,
    )
    expect(res.status).toBe(401)
  })

  it('GET /preview/* still renders for an authenticated request', async () => {
    const app = await buildApp(FORWARDED_USER)
    const res = await app.request('/preview/about', { headers: { 'X-Forwarded-User': 'alice' } }, FROM_PROXY)
    expect(res.status).toBe(200)
    expect(await res.text()).toContain('About Gazetta')
  })

  it('none mode (default) leaves preview open — no regression for solo / dev', async () => {
    const app = await buildApp(undefined)
    const res = await app.request('/preview/about')
    expect(res.status).toBe(200)
    expect(await res.text()).toContain('About Gazetta')
  })
})
