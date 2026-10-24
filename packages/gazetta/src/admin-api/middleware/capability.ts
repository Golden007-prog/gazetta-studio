/**
 * Capability-check middleware — gates a route on the principal's
 * having a specific capability.
 *
 * # Per-route opt-in
 *
 * Routes call `requireCapability('read:pages')` to attach a check
 * to a specific endpoint. The check runs after `principalMiddleware`
 * (so `c.var.principal` is populated). Anonymous principals (id
 * `'unknown'`) fail capability checks because their capability set
 * is empty — translates to 401 (not 403; per design-auth-rbac.md
 * the principal isn't authenticated yet).
 *
 * # Failure modes
 *
 *   - Principal is anonymous (no upstream auth) → 401 with
 *     WWW-Authenticate (matches the principal middleware's 401)
 *   - Principal is authenticated but lacks the capability → 403
 *     with structured body listing the missing capability and the
 *     principal's role
 *
 * # Composition
 *
 * Routes can wire multiple capability checks (e.g., a route that
 * needs both `read:pages` and `edit:pages` in different code paths
 * — the broader read check at the route level, narrower edit check
 * gating a specific operation). v1 ships single-capability gates;
 * multi-capability composition is left to the consumer.
 *
 * # SOLID lenses
 *
 *   - SRP: authorization gate + the denial audit record (design-audit.md
 *     "Recording scope (v1)" + "Dedup discipline": the layer that
 *     produces the outcome records once, and this middleware
 *     short-circuits before the handler runs). Doesn't extract
 *     identity (Cut 7's principalMiddleware does that).
 *   - DIP: depends on `capabilityGrants` pure function, not on
 *     the principal middleware's internals.
 */
import { createMiddleware } from 'hono/factory'
import { capabilityGrants, UNKNOWN_ACTOR_ID } from '../../auth/index.js'
import type { AuditAction, AuditScope } from '../../audit/index.js'
import type { AuditEnv } from './audit.js'

/**
 * design-audit.md "Recording scope (v1)": only write-attempt denials
 * are recorded. `read:*` denials are out of v1's recording scope, and
 * `configure:*` gates only read routes today, so both return null.
 */
function actionForCapability(capability: string): AuditAction | null {
  if (capability.startsWith('edit:')) return 'save'
  if (capability.startsWith('delete:')) return 'delete'
  if (capability.startsWith('publish:')) return 'publish'
  if (capability === 'restore:history') return 'restore'
  return null
}

/**
 * Item scope on the /api/pages|fragments|assets/:name routes that
 * carry one; site scope otherwise (design-audit.md scope rules).
 * The CLI mounts the admin app under /admin, so match the first
 * /api/<collection>/ segment anywhere in the path instead of
 * anchoring at the root. First match wins: a greedy :name can
 * itself contain later /api/.../ segments.
 */
function denialScope(path: string, name: string | undefined): AuditScope {
  if (name === undefined) return { kind: 'site' }
  const match = /(?:^|\/)api\/(pages|fragments|assets)\//.exec(path)
  if (match === null) return { kind: 'site' }
  const kind = match[1] === 'pages' ? 'page' : match[1] === 'fragments' ? 'fragment' : 'asset'
  return { kind, name }
}

/**
 * Build a middleware that requires the specified capability.
 * Returns 401 for anonymous requests, 403 for authenticated
 * requests lacking the capability.
 */
export function requireCapability(capability: string) {
  return createMiddleware<AuditEnv>(async (c, next) => {
    const principal = c.get('principal')
    // Record one audit event per denied WRITE attempt (#1192). The
    // denial response must never depend on audit availability:
    // record() never throws, and the context itself is absent when a
    // consumer wires requireCapability without auditMiddleware (the
    // mutation-coverage harnesses do), so the access is guarded too.
    const action = actionForCapability(capability)
    const recordDenial = (outcome: 'unauthenticated' | 'forbidden') =>
      action === null
        ? Promise.resolve()
        : (c.var.audit?.record({
            action,
            outcome,
            scope: denialScope(c.req.path, c.req.param('name')),
            metadata: { missingCapabilities: [capability] },
          }) ?? Promise.resolve())
    // Anonymous principal — no upstream identity. Translate to
    // 401 (not 403); the request hasn't authenticated yet.
    if (principal.id === UNKNOWN_ACTOR_ID && principal.role === 'unknown') {
      await recordDenial('unauthenticated')
      return c.json(
        { code: 'UNAUTHENTICATED' as const, error: `This endpoint requires capability "${capability}"` },
        401,
        { 'WWW-Authenticate': 'Bearer realm="gazetta-admin"' },
      )
    }
    // Authenticated principal — capability check.
    if (!capabilityGrants(principal.capabilities, capability)) {
      await recordDenial('forbidden')
      return c.json(
        {
          code: 'FORBIDDEN' as const,
          missing: [capability],
          role: principal.role,
          error: `Role "${principal.role}" does not have capability "${capability}"`,
        },
        403,
      )
    }
    await next()
  })
}
