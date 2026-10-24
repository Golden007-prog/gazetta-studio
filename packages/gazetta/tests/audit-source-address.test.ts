/**
 * The audit middleware gives the source-IP extraction the address of the
 * connection the request arrived on, as the Node server's socket reports
 * it. In `none` and `tailscale` modes that address is what's recorded;
 * headers that name an address don't change it.
 */
import { Hono } from 'hono'
import { describe, expect, it } from 'vitest'
import { auditMiddleware, type AuditEnv } from '../src/admin-api/middleware/audit.js'
import { principalMiddleware } from '../src/admin-api/middleware/principal.js'
import type { AuditEvent, AuditProvider } from '../src/audit/index.js'
import { type AuthIdentityProvider, createForwardedUserAuthProvider, noneAuthProvider } from '../src/auth/index.js'
import { fromConnection } from './_helpers/connection.js'

const ADDRESS_HEADERS = { 'x-forwarded-for': '6.6.6.6', 'x-real-ip': '6.6.6.6', 'cf-connecting-ip': '6.6.6.6' }

function appRecordingWith(provider: AuthIdentityProvider) {
  const events: AuditEvent[] = []
  const capture: AuditProvider = {
    name: 'capture',
    async record(event) {
      events.push(event)
    },
  }
  const app = new Hono<AuditEnv>()
  app.use('*', principalMiddleware(provider))
  app.use(
    '*',
    auditMiddleware({
      providers: [capture],
      strict: false,
      actorPseudonym: 'none',
      recordSourceIp: 'raw',
      recordUserAgent: 'none',
      trustMode: provider.trustMode,
    }),
  )
  app.post('/save', async c => {
    await c.var.audit.record({ action: 'save', outcome: 'success', scope: { kind: 'page', name: 'home' } })
    return c.json({ ok: true })
  })
  return { app, events }
}

describe('audit records the connection address', () => {
  it.each(['203.0.113.9', '::ffff:203.0.113.9'])(
    'none mode: records %s as 203.0.113.9, whatever the headers say',
    async address => {
      const { app, events } = appRecordingWith(noneAuthProvider)

      const res = await app.request('/save', { method: 'POST', headers: ADDRESS_HEADERS }, fromConnection(address))

      expect(res.status).toBe(200)
      expect(events.map(e => e.sourceIp)).toEqual(['203.0.113.9'])
    },
  )

  it('none mode: leaves the field out when the connection address is unknown', async () => {
    const { app, events } = appRecordingWith(noneAuthProvider)

    await app.request('/save', { method: 'POST', headers: ADDRESS_HEADERS })

    expect(events).toHaveLength(1)
    expect(events[0]).not.toHaveProperty('sourceIp')
  })

  it('forwarded-user: records the entry the trusted proxy appended', async () => {
    const { app, events } = appRecordingWith(createForwardedUserAuthProvider({ trustedProxies: ['10.0.0.5'] }))

    await app.request(
      '/save',
      { method: 'POST', headers: { 'x-forwarded-user': 'alice', 'x-forwarded-for': '6.6.6.6, 203.0.113.1' } },
      fromConnection('10.0.0.5'),
    )

    expect(events.map(e => e.sourceIp)).toEqual(['203.0.113.1'])
  })

  it('forwarded-user: a request without an identity records the client the proxy appended', async () => {
    const { app, events } = appRecordingWith(createForwardedUserAuthProvider({ trustedProxies: ['10.0.0.5'] }))

    await app.request(
      '/save',
      { method: 'POST', headers: { 'x-forwarded-for': '6.6.6.6, 203.0.113.1' } },
      fromConnection('10.0.0.5'),
    )

    expect(events.map(e => e.sourceIp)).toEqual(['203.0.113.1'])
  })

  it('forwarded-user: leaves the field out when X-Forwarded-For is absent', async () => {
    const { app, events } = appRecordingWith(createForwardedUserAuthProvider({ trustedProxies: ['10.0.0.5'] }))

    await app.request(
      '/save',
      { method: 'POST', headers: { 'x-forwarded-user': 'alice', 'x-real-ip': '6.6.6.6' } },
      fromConnection('10.0.0.5'),
    )

    expect(events).toHaveLength(1)
    expect(events[0]).not.toHaveProperty('sourceIp')
  })
})
