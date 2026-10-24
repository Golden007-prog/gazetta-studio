/**
 * Principal middleware — wires the auth/RBAC layer (`packages/gazetta/src/auth/`)
 * into the Hono request context.
 *
 * # What this middleware does
 *
 * 1. On boot, constructs the configured `AuthIdentityProvider` from
 *    `admin.auth` in the loaded SiteManifest. Falls back to the
 *    `none`-mode provider when `admin.auth` is absent.
 * 2. On every request, calls `provider.extractPrincipal(req)` and
 *    attaches the result to `c.var.principal`.
 * 3. Anonymous requests (provider returns `null`) get a synthesized
 *    Principal with `id: 'unknown'` + `role: 'unknown'` + empty
 *    capabilities. The capability-check middleware (Cut 8) decides
 *    whether to allow these (none-mode or public routes) or 401.
 * 4. Provider throws (`AuthenticationError`) → 401 with the error
 *    message; doesn't leak details about the underlying failure.
 *
 * # Capability population
 *
 * For `forwarded-user` and `cloudflare-access` providers (which can
 * surface upstream group claims), this middleware would call
 * `resolveRole({ groups, mapping, customRoles })` to expand the
 * principal's capabilities. v1 wires the role-resolver in a
 * follow-up cut once one of the providers actually exposes group
 * claims through the AuthRequest shape — for now the providers
 * return `capabilities: []` and the operator's role mapping config
 * doesn't reach the resolver yet.
 *
 * # Why this is its own middleware (not folded into the existing one)
 *
 * The existing `authMiddleware` is a simple bearer-token guard for
 * `GAZETTA_TOKEN` — orthogonal to upstream-identity extraction.
 * They compose: bearer-token gates "is this request allowed to
 * reach the admin API at all"; principal middleware identifies
 * "who is the user behind this request." Most deployments use
 * one or the other (bearer-token for solo / dev; principal for
 * team CMS); some compose both (CI pipeline auth-token + upstream
 * Cloudflare Access for human users).
 *
 * # SOLID lenses
 *
 *   - SRP: extracts identity + attaches to context. Authorization
 *     (capability checks) is Cut 8's middleware.
 *   - DIP: depends on `AuthIdentityProvider` interface, not on
 *     specific provider classes.
 */
import { getConnInfo } from '@hono/node-server/conninfo'
import { createMiddleware } from 'hono/factory'
import type { Context } from 'hono'
import {
  AuthenticationError,
  type AuthIdentityProvider,
  type AuthRequest,
  type Principal,
  noneAuthProvider,
  UNKNOWN_ACTOR_ID,
} from '../../auth/index.js'
import { unmapIPv4 } from '../../auth/ip-match.js'

/**
 * Hono context augmentation — readers see `c.var.principal` typed
 * as `Principal` (always populated; never undefined after this
 * middleware runs).
 */
export type PrincipalEnv = {
  Variables: {
    principal: Principal
  }
}

/**
 * The synthetic anonymous principal returned when no upstream
 * identity is present. Surfaced as `id: 'unknown'`, `role:
 * 'unknown'`, no capabilities — Cut 8's capability-check middleware
 * 401s on any required capability.
 */
const ANONYMOUS_PRINCIPAL: Principal = {
  id: UNKNOWN_ACTOR_ID,
  role: 'unknown',
  trustMode: 'none',
  capabilities: [],
}

/**
 * Adapt a Hono request into the `AuthRequest` shape the auth/
 * providers expect. Headers come from Hono's case-insensitive
 * lookup; we normalize to lowercase keys for provider consistency.
 */
function toAuthRequest(c: Context): AuthRequest {
  const headers = new Map<string, string>()
  // Hono exposes headers via c.req.header() (single value). The
  // raw request headers are accessible via c.req.raw.headers
  // which is a fetch-style Headers object.
  const raw = c.req.raw.headers
  raw.forEach((value, key) => {
    headers.set(key.toLowerCase(), value)
  })
  // Source IP — Hono doesn't expose this directly; honest extraction
  // is per-platform (per design-audit.md's trust-mode-driven IP
  // section). v1 reads from a CF-Connecting-IP / X-Forwarded-For
  // best-effort; provider-specific extraction lands when the audit
  // foundation's source-IP recording (Cut 4 of audit) ships.
  const sourceIp =
    raw.get('cf-connecting-ip') ?? raw.get('x-real-ip') ?? extractFirstXffEntry(raw.get('x-forwarded-for'))
  return {
    headers,
    sourceIp: sourceIp ?? undefined,
    peerAddress: connectionAddress(c),
    method: c.req.method,
    url: c.req.url,
  }
}

/**
 * The connection's remote address, from `@hono/node-server`'s socket.
 * Undefined when the request didn't come through the Node server
 * (`app.request()` without an env in tests).
 */
function connectionAddress(c: Context): string | undefined {
  let address: string | undefined
  try {
    address = getConnInfo(c).remote.address
  } catch {
    return undefined
  }
  return address ? unmapIPv4(address) : undefined
}

function extractFirstXffEntry(xff: string | null): string | null {
  if (!xff) return null
  const first = xff.split(',')[0]?.trim()
  return first || null
}

/**
 * Build the principal middleware. Pass the configured provider OR
 * omit to fall back to `none` mode. Production wiring resolves the
 * provider from `site.config.ts admin.auth` at boot.
 */
export function principalMiddleware(provider: AuthIdentityProvider = noneAuthProvider) {
  return createMiddleware<PrincipalEnv>(async (c, next) => {
    let principal: Principal | null
    try {
      principal = await provider.extractPrincipal(toAuthRequest(c))
    } catch (err) {
      if (err instanceof AuthenticationError) {
        // Surface as 401 with the error message. The provider's
        // message is operator-facing diagnostic detail (e.g.,
        // "JWT verification failed: signature invalid"); we surface
        // it in a structured body. For external-facing 401s the
        // middleware could mask the message, but this is admin-API
        // only — operators benefit from the diagnostic context.
        return c.json({ code: 'UNAUTHENTICATED' as const, error: err.message }, 401, {
          'WWW-Authenticate': 'Bearer realm="gazetta-admin"',
        })
      }
      // Unexpected (non-AuthenticationError) — let Hono's default
      // error handler take over so the operator sees the stack.
      throw err
    }
    // Anonymous request — synthesize the unknown principal so
    // downstream middleware always has a Principal to read.
    c.set('principal', principal ?? ANONYMOUS_PRINCIPAL)
    await next()
  })
}
