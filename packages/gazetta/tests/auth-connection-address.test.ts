/**
 * The trusted-proxy check (`forwarded-user`) and the Tailscale check use
 * the address of the connection the request arrived on, which the Node
 * server reports from its socket. Headers that name an address
 * (`X-Real-IP`, `X-Forwarded-For`, `CF-Connecting-IP`) don't count.
 */
import { Hono } from 'hono'
import { describe, expect, it } from 'vitest'
import { principalMiddleware } from '../src/admin-api/middleware/principal.js'
import {
  type AuthIdentityProvider,
  AuthenticationError,
  createForwardedUserAuthProvider,
  createTailscaleAuthProvider,
} from '../src/auth/index.js'

const ADDRESS_HEADERS = { 'x-real-ip': '10.0.0.5', 'x-forwarded-for': '10.0.0.5', 'cf-connecting-ip': '10.0.0.5' }

/** The env @hono/node-server passes to the app: the request's socket. */
const fromConnection = (remoteAddress: string) => ({ incoming: { socket: { remoteAddress } } })

function appWith(provider: AuthIdentityProvider) {
  const app = new Hono()
  app.use('*', principalMiddleware(provider))
  app.get('/whoami', c => c.json({ id: c.var.principal.id }))
  return app
}

describe('forwarded-user checks trustedProxies against the connection', () => {
  const provider = createForwardedUserAuthProvider({ trustedProxies: ['10.0.0.5'] })

  it('refuses identity headers on a connection from outside trustedProxies, whatever the headers say', async () => {
    const res = await appWith(provider).request(
      '/whoami',
      { headers: { ...ADDRESS_HEADERS, 'x-forwarded-user': 'mallory' } },
      fromConnection('203.0.113.9'),
    )

    expect(res.status).toBe(401)
  })

  it.each(['10.0.0.5', '::ffff:10.0.0.5'])('accepts them on a connection from a trusted proxy (%s)', async address => {
    const res = await appWith(provider).request(
      '/whoami',
      { headers: { 'x-forwarded-user': 'alice' } },
      fromConnection(address),
    )

    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ id: 'alice' })
  })

  it('refuses them when the connection address is unknown', async () => {
    const res = await appWith(provider).request('/whoami', {
      headers: { ...ADDRESS_HEADERS, 'x-forwarded-user': 'alice' },
    })

    expect(res.status).toBe(401)
  })

  it('ignores sourceIp when the provider is called directly', async () => {
    const request = {
      headers: new Map([['x-forwarded-user', 'mallory']]),
      sourceIp: '10.0.0.5',
      peerAddress: '203.0.113.9',
    }

    await expect(provider.extractPrincipal(request)).rejects.toBeInstanceOf(AuthenticationError)
  })
})

describe('tailscale accepts identity headers only from the local Tailscale Serve proxy', () => {
  const provider = createTailscaleAuthProvider({})

  it.each(['127.0.0.1', '::1', '::ffff:127.0.0.1'])('accepts them on a loopback connection (%s)', async address => {
    const res = await appWith(provider).request(
      '/whoami',
      { headers: { 'tailscale-user-login': 'alice@example.ts.net' } },
      fromConnection(address),
    )

    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ id: 'alice@example.ts.net' })
  })

  it('refuses them on a connection from another address', async () => {
    const res = await appWith(provider).request(
      '/whoami',
      { headers: { 'tailscale-user-login': 'mallory@example.ts.net' } },
      fromConnection('100.64.0.7'),
    )

    expect(res.status).toBe(401)
  })

  it('refuses them when the connection address is unknown', async () => {
    const res = await appWith(provider).request('/whoami', {
      headers: { 'tailscale-user-login': 'mallory@example.ts.net' },
    })

    expect(res.status).toBe(401)
  })

  it('treats a request without identity headers as anonymous, wherever it comes from', async () => {
    const res = await appWith(provider).request('/whoami', {}, fromConnection('100.64.0.7'))

    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ id: 'unknown' })
  })
})
