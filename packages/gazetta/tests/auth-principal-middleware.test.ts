/**
 * Cut 7 tests: principal middleware wiring + AuthConfig schema
 * → provider factory dispatch.
 *
 * Tests the middleware in isolation against a Hono app — confirms
 * c.var.principal is populated, anonymous fallback works, provider
 * exceptions surface as 401 with WWW-Authenticate, AuthConfigSchema-
 * driven factory dispatch produces the right provider per trust mode.
 */
import { describe, expect, it } from 'vitest'
import { Hono } from 'hono'
import {
  AuthConfigurationError,
  buildAuthProvider,
  noneAuthProvider,
  UNKNOWN_ACTOR_ID,
  type AuthIdentityProvider,
  type AuthRequest,
  type Principal,
} from '../src/auth/index.js'
import { principalMiddleware, type PrincipalEnv } from '../src/admin-api/middleware/principal.js'

// --- Middleware behavior --------------------------------------

function buildTestApp(provider?: AuthIdentityProvider) {
  const app = new Hono<PrincipalEnv>()
  app.use('/api/*', principalMiddleware(provider))
  app.get('/api/whoami', c => {
    const p = c.get('principal')
    return c.json({ id: p.id, role: p.role, trustMode: p.trustMode, capabilities: p.capabilities })
  })
  return app
}

describe('principalMiddleware (Cut 7)', () => {
  it('defaults to none mode when no provider is supplied', async () => {
    const app = buildTestApp()
    const res = await app.request('/api/whoami')
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.id).toBe(UNKNOWN_ACTOR_ID)
    expect(body.role).toBe('admin')
    expect(body.trustMode).toBe('none')
    expect(body.capabilities).toEqual(['*'])
  })

  it('uses the supplied provider', async () => {
    const provider: AuthIdentityProvider = {
      trustMode: 'forwarded-user',
      async extractPrincipal(): Promise<Principal> {
        return {
          id: 'alice',
          email: 'alice@example.com',
          role: 'editor',
          trustMode: 'forwarded-user',
          capabilities: ['read:*', 'edit:*'],
        }
      },
    }
    const app = buildTestApp(provider)
    const res = await app.request('/api/whoami')
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.id).toBe('alice')
    expect(body.role).toBe('editor')
  })

  it('synthesizes the unknown principal when provider returns null (anonymous)', async () => {
    const provider: AuthIdentityProvider = {
      trustMode: 'forwarded-user',
      async extractPrincipal(): Promise<Principal | null> {
        return null
      },
    }
    const app = buildTestApp(provider)
    const res = await app.request('/api/whoami')
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.id).toBe(UNKNOWN_ACTOR_ID)
    expect(body.role).toBe('unknown')
    expect(body.capabilities).toEqual([])
  })

  it('returns 401 with WWW-Authenticate when provider throws AuthenticationError', async () => {
    const { AuthenticationError } = await import('../src/auth/errors.js')
    const provider: AuthIdentityProvider = {
      trustMode: 'cloudflare-access',
      async extractPrincipal(): Promise<Principal> {
        throw new AuthenticationError('JWT verification failed: signature invalid')
      },
    }
    const app = buildTestApp(provider)
    const res = await app.request('/api/whoami')
    expect(res.status).toBe(401)
    expect(res.headers.get('www-authenticate')).toContain('Bearer')
    const body = await res.json()
    expect(body.code).toBe('UNAUTHENTICATED')
    expect(body.error).toContain('signature invalid')
  })

  it('does NOT swallow non-AuthenticationError throws', async () => {
    const provider: AuthIdentityProvider = {
      trustMode: 'cloudflare-access',
      async extractPrincipal(): Promise<Principal> {
        throw new Error('unexpected')
      },
    }
    const app = buildTestApp(provider)
    const res = await app.request('/api/whoami')
    expect(res.status).toBe(500)
  })

  it('passes request headers to the provider', async () => {
    let captured: AuthRequest | null = null
    const provider: AuthIdentityProvider = {
      trustMode: 'forwarded-user',
      async extractPrincipal(req: AuthRequest): Promise<Principal> {
        captured = req
        return {
          id: req.headers.get('x-forwarded-user') ?? 'unknown',
          role: 'editor',
          trustMode: 'forwarded-user',
          capabilities: [],
        }
      },
    }
    const app = buildTestApp(provider)
    const res = await app.request('/api/whoami', {
      headers: { 'X-Forwarded-User': 'bob', 'cf-connecting-ip': '203.0.113.1' },
    })
    expect(res.status).toBe(200)
    expect((await res.json()).id).toBe('bob')
    expect(captured!.sourceIp).toBe('203.0.113.1')
  })

  it('extracts source IP from X-Forwarded-For when CF-Connecting-IP is absent', async () => {
    let captured: AuthRequest | null = null
    const provider: AuthIdentityProvider = {
      trustMode: 'forwarded-user',
      async extractPrincipal(req: AuthRequest): Promise<Principal> {
        captured = req
        return { id: 'x', role: 'admin', trustMode: 'forwarded-user', capabilities: [] }
      },
    }
    const app = buildTestApp(provider)
    await app.request('/api/whoami', {
      headers: { 'X-Forwarded-For': '203.0.113.1, 10.0.0.1' },
    })
    // First entry per the X-Forwarded-For convention (leftmost = client)
    expect(captured!.sourceIp).toBe('203.0.113.1')
  })
})

// --- buildAuthProvider factory dispatch ----------------------

describe('buildAuthProvider (Cut 7)', () => {
  it('returns noneAuthProvider when config is undefined', () => {
    const provider = buildAuthProvider(undefined)
    expect(provider).toBe(noneAuthProvider)
    expect(provider.trustMode).toBe('none')
  })

  it('returns noneAuthProvider for trust: none config', () => {
    const provider = buildAuthProvider({ trust: 'none' })
    expect(provider.trustMode).toBe('none')
  })

  it('returns forwarded-user provider', () => {
    const provider = buildAuthProvider({ trust: 'forwarded-user', allowAnyOrigin: true })
    expect(provider.trustMode).toBe('forwarded-user')
  })

  it('throws AuthConfigurationError on forwarded-user with neither trustedProxies nor allowAnyOrigin', () => {
    // Schema rejects this; we test the factory dispatch by going
    // around the schema (operator could construct manifest
    // programmatically, bypassing validation).
    expect(() => buildAuthProvider({ trust: 'forwarded-user' } as never)).toThrow(AuthConfigurationError)
  })

  it('returns cloudflare-access provider', () => {
    const provider = buildAuthProvider({ trust: 'cloudflare-access', teamDomain: 'acme' })
    expect(provider.trustMode).toBe('cloudflare-access')
  })

  it('returns azure-easy-auth provider', () => {
    const provider = buildAuthProvider({ trust: 'azure-easy-auth' })
    expect(provider.trustMode).toBe('azure-easy-auth')
  })

  it('returns aws-cognito provider', () => {
    const provider = buildAuthProvider({
      trust: 'aws-cognito',
      region: 'us-east-1',
      albArn: 'arn:aws:elasticloadbalancing:us-east-1:111122223333:loadbalancer/app/gazetta/50dc6c495c0c9188',
    })
    expect(provider.trustMode).toBe('aws-cognito')
  })

  it('returns tailscale provider', () => {
    const provider = buildAuthProvider({ trust: 'tailscale' })
    expect(provider.trustMode).toBe('tailscale')
  })
})
