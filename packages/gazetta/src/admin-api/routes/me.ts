/**
 * `GET /api/me` — the requesting principal, as resolved by the
 * principal middleware.
 *
 * No capability gate. A request the trust mode can't identify still
 * reaches handlers, carrying the shared anonymous principal; this
 * route answers 401 for it instead, so the client never treats
 * "nobody" as an owner of persisted drafts (it loads none). The admin
 * client reads this at boot — see design-offline.md, "Unsaved drafts
 * live in their own store".
 */
import { Hono } from 'hono'
import { UNKNOWN_ACTOR_ID } from '../../auth/index.js'
import type { PrincipalEnv } from '../middleware/principal.js'
import type { MeResponse } from '../schemas/me.js'

export function meRoutes() {
  const app = new Hono<PrincipalEnv>()

  app.get('/api/me', c => {
    const { id, role, trustMode } = c.var.principal
    // Same anonymous test as the capability middleware.
    if (id === UNKNOWN_ACTOR_ID && role === 'unknown') {
      return c.json({ code: 'UNAUTHENTICATED' as const, error: 'Not signed in' }, 401, {
        'WWW-Authenticate': 'Bearer realm="gazetta-admin"',
      })
    }
    const body: MeResponse = { id, role, trustMode }
    return c.json(body)
  })

  return app
}
