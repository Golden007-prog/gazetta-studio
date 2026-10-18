/**
 * `GET /api/me` reports the principal the trust mode resolved for this
 * request. The admin client uses it to decide whose persisted drafts it
 * may load, so two different upstream users must get two different
 * answers.
 */
import { describe, expect, it } from 'vitest'
import { createAdminApp } from '../src/admin-api/index.js'
import { createSourceContext } from '../src/admin-api/source-context.js'
import { MeResponseSchema } from '../src/admin-api/schemas/me.js'
import type { SiteManifest } from '../src/types.js'
import { memoryStorage } from './_helpers/memory-storage.js'

function appWith(admin?: SiteManifest['admin']) {
  const storage = memoryStorage()
  const targetConfigs = { local: { storage, type: 'esi' as const, environment: 'local' as const, editable: true } }
  const manifest: SiteManifest = { name: 'test-site', targets: targetConfigs, ...(admin ? { admin } : {}) }
  return createAdminApp({
    source: createSourceContext({ storage, siteDir: '', projectSiteDir: '/p', manifest }),
    siteDir: '/p',
    templatesDir: '/p/templates',
    targets: new Map([['local', storage]]),
    targetConfigs,
    disableCacheStatsLogger: true,
  })
}

const forwardedUser = { auth: { trust: 'forwarded-user' as const, allowAnyOrigin: true } }

describe('GET /api/me', () => {
  it('reports the none-mode principal', async () => {
    const res = await appWith().request('/api/me')
    expect(res.status).toBe(200)
    expect(MeResponseSchema.parse(await res.json())).toEqual({ id: 'unknown', role: 'admin', trustMode: 'none' })
  })

  it('reports each forwarded user as themselves', async () => {
    const app = appWith(forwardedUser)
    const ask = async (user: string) =>
      MeResponseSchema.parse(await (await app.request('/api/me', { headers: { 'X-Forwarded-User': user } })).json())
    expect(await ask('alice')).toEqual({ id: 'alice', role: 'editor', trustMode: 'forwarded-user' })
    expect(await ask('bob')).toEqual({ id: 'bob', role: 'editor', trustMode: 'forwarded-user' })
  })

  it('rejects a request the trust mode cannot identify', async () => {
    const res = await appWith(forwardedUser).request('/api/me')
    expect(res.status).toBe(401)
  })
})
