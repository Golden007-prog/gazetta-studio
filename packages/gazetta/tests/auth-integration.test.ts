/**
 * Cut 10 tests: end-to-end auth integration via createAdminApp.
 *
 * Validates the full stack:
 *   site.config.ts admin.auth → AuthConfigSchema parse →
 *   buildAuthProvider → principalMiddleware → requireCapability →
 *   route handler
 *
 * Strategy: build admin apps with different `admin.auth` blocks
 * patched into the source manifest, then make HTTP requests with
 * real header shapes per trust mode. Confirms:
 *
 *   - none mode: no headers needed; admin role granted
 *   - forwarded-user: untrusted source → 401; trusted source +
 *     valid header → 200; missing header on trusted source → 401
 *   - cloudflare-access: missing JWT → 401; signed valid JWT → 200;
 *     forged JWT → 401
 *
 * Each authenticated principal gets the configured defaultRole's
 * built-in capability set via expandRole(). Group-claim → role
 * mapping (via X-Forwarded-Groups + roleMapping config) is a
 * follow-up cut; v1 ships with everyone-gets-the-default-role.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { rm, cp } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { resolve } from 'node:path'
import { generateKeyPair, SignJWT, type JWTVerifyGetKey } from 'jose'
import type { Hono } from 'hono'
import { createFilesystemProvider } from '../src/providers/filesystem.js'
import { createAdminApp } from '../src/admin-api/index.js'
import { createSourceContext } from '../src/admin-api/source-context.js'
import { loadSiteConfig, siteConfigToManifest } from '../src/config/loader.js'
import {
  BUILT_IN_ROLES,
  buildAuthProvider,
  createCloudflareAccessAuthProvider,
  createForwardedUserAuthProvider,
  type AuthIdentityProvider,
  type Principal,
} from '../src/auth/index.js'
import { principalMiddleware } from '../src/admin-api/middleware/principal.js'
import { Hono as HonoCtor } from 'hono'
import { tempDir } from './_helpers/temp.js'

const realStarter = resolve(import.meta.dirname, '../../../examples/starter')

// Every project root, registered before anything can throw, so afterAll can wipe it.
const createdRoots: string[] = []

/**
 * Build an admin app with the supplied AuthIdentityProvider injected
 * directly. Sidesteps site.config.ts admin.auth parsing for cuts that
 * want to inject a pre-built provider (e.g., one with a test JWKS
 * factory). We do this by composing principalMiddleware over the
 * createAdminApp output — but createAdminApp already wires its own
 * principal middleware from site.config.ts; we'd be double-wiring.
 *
 * For tests where the admin.auth block can be expressed in
 * site.config.ts terms (none / forwarded-user / Cloudflare with default
 * JWKS factory), we patch the source manifest. For tests needing a
 * test-only JWKS factory (cloudflare-access verification), we bypass
 * createAdminApp and wire the routes directly.
 */
async function buildAppWithAuthBlock(authBlock: Record<string, unknown> | undefined) {
  const projectRoot = tempDir(`auth-integ-${Date.now()}-${Math.random()}`)
  createdRoots.push(projectRoot)
  await rm(projectRoot, { recursive: true, force: true })
  await cp(realStarter, projectRoot, {
    recursive: true,
    filter: src => !src.includes('/dist') && !src.includes('/node_modules') && !src.includes('/.tmp'),
  })
  const projectSiteDir = resolve(projectRoot, 'sites/main')
  const localTargetDir = resolve(projectSiteDir, 'targets/local')
  const storage = createFilesystemProvider(localTargetDir)

  const loaded = await loadSiteConfig(projectSiteDir)
  if (!loaded) throw new Error('site.config.ts missing')
  const manifest = siteConfigToManifest(loaded.config)
  // Patch the admin.auth block — the loader drops unknown fields,
  // but admin.auth is a reserved-slot loose record so anything
  // shape-valid passes through.
  if (authBlock) {
    manifest.admin = { ...(manifest.admin ?? {}), auth: authBlock }
  }
  const source = createSourceContext({ storage, siteDir: '', projectSiteDir, manifest })
  const app = createAdminApp({
    source,
    siteDir: projectSiteDir,
    templatesDir: resolve(projectRoot, 'templates'),
    adminDir: resolve(projectRoot, 'admin'),
    disableCacheStatsLogger: true,
  })
  return { app, projectRoot }
}

afterAll(async () => {
  for (const root of createdRoots) {
    await rm(root, { recursive: true, force: true }).catch(() => {})
  }
  for (const root of createdRoots) {
    expect(existsSync(root), `${root} left behind`).toBe(false)
  }
})

async function buildAndTrack(authBlock: Record<string, unknown> | undefined): Promise<Hono> {
  const { app } = await buildAppWithAuthBlock(authBlock)
  return app
}

// --- none mode (default) ----------------------------------------

describe('Cut 10 — none trust mode (default)', () => {
  it('no admin.auth → admin role granted; reads succeed', async () => {
    const app = await buildAndTrack(undefined)
    const res = await app.request('/api/pages')
    expect(res.status).toBe(200)
  })

  it('explicit { trust: "none" } → same as no admin.auth', async () => {
    const app = await buildAndTrack({ trust: 'none' })
    const res = await app.request('/api/pages')
    expect(res.status).toBe(200)
  })
})

// --- forwarded-user --------------------------------------------

describe('Cut 10 — forwarded-user trust mode', () => {
  it('untrusted source IP → 401', async () => {
    const app = await buildAndTrack({
      trust: 'forwarded-user',
      trustedProxies: ['10.0.0.0/8'],
    })
    const res = await app.request('/api/pages', {
      headers: {
        'X-Forwarded-User': 'alice',
        'X-Forwarded-For': '203.0.113.1', // not in 10.0.0.0/8
      },
    })
    expect(res.status).toBe(401)
    const body = await res.json()
    expect(body.code).toBe('UNAUTHENTICATED')
  })

  it('trusted source + valid X-Forwarded-User → 200 (editor role grants read:*)', async () => {
    const app = await buildAndTrack({
      trust: 'forwarded-user',
      trustedProxies: ['10.0.0.0/8'],
    })
    const res = await app.request('/api/pages', {
      headers: {
        'X-Forwarded-User': 'alice',
        'X-Forwarded-For': '10.0.0.5',
      },
    })
    expect(res.status).toBe(200)
  })

  it('forwarded-user editor cannot delete (no delete:* in editor role)', async () => {
    const app = await buildAndTrack({
      trust: 'forwarded-user',
      trustedProxies: ['10.0.0.0/8'],
    })
    const res = await app.request('/api/pages/home', {
      method: 'DELETE',
      headers: {
        'X-Forwarded-User': 'alice',
        'X-Forwarded-For': '10.0.0.5',
      },
    })
    expect(res.status).toBe(403)
    const body = await res.json()
    expect(body.code).toBe('FORBIDDEN')
    expect(body.missing).toEqual(['delete:pages'])
    expect(body.role).toBe('editor')
  })

  it('trusted source but missing X-Forwarded-User header → 401', async () => {
    const app = await buildAndTrack({
      trust: 'forwarded-user',
      trustedProxies: ['10.0.0.0/8'],
    })
    const res = await app.request('/api/pages', {
      headers: { 'X-Forwarded-For': '10.0.0.5' },
    })
    expect(res.status).toBe(401)
  })

  it('allowAnyOrigin: true bypasses source-IP check', async () => {
    const app = await buildAndTrack({
      trust: 'forwarded-user',
      allowAnyOrigin: true,
    })
    const res = await app.request('/api/pages', {
      headers: {
        'X-Forwarded-User': 'alice',
        'X-Forwarded-For': '8.8.8.8', // anywhere
      },
    })
    expect(res.status).toBe(200)
  })

  it('viewer role granted via defaultRole config works for reads', async () => {
    const app = await buildAndTrack({
      trust: 'forwarded-user',
      trustedProxies: ['10.0.0.0/8'],
    })
    // Default role from buildAuthProvider is editor. We can't override
    // through the schema yet (defaultRole field reserved for follow-up
    // role-mapping work), so this test confirms editor reads succeed.
    const res = await app.request('/api/pages', {
      headers: { 'X-Forwarded-User': 'bob', 'X-Forwarded-For': '10.0.0.5' },
    })
    expect(res.status).toBe(200)
  })

  it('AuthConfigSchema rejection at boot when neither trustedProxies nor allowAnyOrigin set', async () => {
    const before = createdRoots.length
    await expect(
      buildAndTrack({
        trust: 'forwarded-user',
      }),
    ).rejects.toThrow()
    // A build that throws still registers its starter copy for cleanup.
    expect(createdRoots.length).toBe(before + 1)
  })
})

// --- cloudflare-access (with test JWKS factory) -----------------

describe('Cut 10 — cloudflare-access trust mode (route-level fixture)', () => {
  // The default cloudflare-access provider uses createRemoteJWKSet
  // which requires HTTP. To test the full stack with signed tokens,
  // we wire the provider directly with a test JWKS factory.

  async function buildCfTestApp(audience?: string) {
    const { publicKey, privateKey } = await generateKeyPair('RS256')
    const jwksFactory: () => JWTVerifyGetKey = () => async () => publicKey
    const provider = createCloudflareAccessAuthProvider({
      teamDomain: 'acme',
      audience,
      jwksFactory,
    })
    // Build a tiny app with the principal middleware + a gated route.
    const { requireCapability } = await import('../src/admin-api/middleware/capability.js')
    const app = new HonoCtor()
    app.use('/api/*', principalMiddleware(provider))
    app.get('/api/test', requireCapability('read:pages'), c => c.json({ id: c.get('principal').id }))
    return { app, privateKey, sign: makeSigner(privateKey) }
  }

  function makeSigner(privateKey: CryptoKey) {
    return async (claims: Record<string, unknown>, opts: { iss?: string; aud?: string } = {}) => {
      const jwt = new SignJWT(claims)
        .setProtectedHeader({ alg: 'RS256', kid: 'test-key' })
        .setIssuedAt()
        .setExpirationTime('5m')
      if (opts.iss) jwt.setIssuer(opts.iss)
      if (opts.aud) jwt.setAudience(opts.aud)
      return jwt.sign(privateKey)
    }
  }

  it('missing JWT → 401', async () => {
    const { app } = await buildCfTestApp()
    const res = await app.request('/api/test')
    expect(res.status).toBe(401)
  })

  it('valid signed JWT → 200 (editor role grants read:*)', async () => {
    const { app, sign } = await buildCfTestApp()
    const token = await sign(
      { sub: 'cf-user-1', email: 'alice@example.com' },
      { iss: 'https://acme.cloudflareaccess.com' },
    )
    const res = await app.request('/api/test', {
      headers: { 'Cf-Access-Jwt-Assertion': token },
    })
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.id).toBe('cf-user-1')
  })

  it('forged JWT (signed by attacker key) → 401', async () => {
    const { app } = await buildCfTestApp()
    // Sign with a DIFFERENT key pair than the app's verification key.
    const { privateKey: attackerKey } = await generateKeyPair('RS256')
    const forged = await new SignJWT({ sub: 'admin' })
      .setProtectedHeader({ alg: 'RS256', kid: 'test-key' })
      .setIssuedAt()
      .setExpirationTime('5m')
      .setIssuer('https://acme.cloudflareaccess.com')
      .sign(attackerKey)
    const res = await app.request('/api/test', {
      headers: { 'Cf-Access-Jwt-Assertion': forged },
    })
    expect(res.status).toBe(401)
  })

  it('expired JWT → 401', async () => {
    const { app, sign: _sign, ...rest } = await buildCfTestApp()
    // Build a fresh app with same key pair, then sign an expired token.
    const { privateKey } = rest as { privateKey: CryptoKey }
    const past = Math.floor(Date.now() / 1000) - 10000
    const expiredToken = await new SignJWT({ sub: 'user' })
      .setProtectedHeader({ alg: 'RS256', kid: 'test-key' })
      .setIssuedAt(past)
      .setExpirationTime(past + 100)
      .setIssuer('https://acme.cloudflareaccess.com')
      .sign(privateKey)
    const res = await app.request('/api/test', {
      headers: { 'Cf-Access-Jwt-Assertion': expiredToken },
    })
    expect(res.status).toBe(401)
  })
})

// --- factory-direct provider tests (sanity) -------------------

describe('Cut 10 — buildAuthProvider integration', () => {
  it('returns a working Principal for none-mode end-to-end', async () => {
    const provider: AuthIdentityProvider = buildAuthProvider({ trust: 'none' })
    const principal = (await provider.extractPrincipal({ headers: new Map() })) as Principal
    expect(principal.role).toBe('admin')
    expect(principal.capabilities).toEqual(['*'])
  })

  it('admin built-in role grants every capability via wildcard', () => {
    expect(BUILT_IN_ROLES.admin).toEqual(['*'])
  })
})
