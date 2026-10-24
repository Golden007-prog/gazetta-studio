/**
 * Audit middleware — wires the audit subsystem into the per-request
 * Hono context.
 *
 * # What this middleware does
 *
 * 1. Reads `c.var.principal` (set by Cut 7's principalMiddleware).
 * 2. Builds an `AuditContext` for this request (with the principal,
 *    request headers, and peer IP bound).
 * 3. Stores the context on `c.var.audit` so route handlers can call
 *    `c.var.audit.record({...})`.
 *
 * # Wiring order
 *
 * Must run AFTER principalMiddleware (Cut 7) so `c.var.principal`
 * is populated. Must run BEFORE capability middleware (Cut 8) so
 * the capability-failure path can record `outcome: 'forbidden'`
 * audit events — that path needs `c.var.audit` available too.
 *
 * # SOLID lenses
 *
 *   - SRP: middleware-shaped wiring; doesn't construct providers
 *     (Cut 2 + Cut 5's boot path do that), doesn't dispatch (the
 *     recorder does that), doesn't process privacy fields (the
 *     context does that).
 *   - DIP: takes pre-built providers + privacy modes; doesn't read
 *     site.config.ts directly.
 */
import { getConnInfo } from '@hono/node-server/conninfo'
import type { Context } from 'hono'
import { createMiddleware } from 'hono/factory'
import {
  type ActorPseudonymMode,
  type AuditContext,
  type AuditFailureLogger,
  type AuditProvider,
  type SourceIpMode,
  type UserAgentMode,
  createAuditContext,
} from '../../audit/index.js'
import { unmapIPv4 } from '../../auth/ip-match.js'
import type { PrincipalEnv } from './principal.js'

/**
 * Hono context augmentation — readers see `c.var.audit` typed as
 * `AuditContext` (always populated; never undefined after this
 * middleware runs).
 */
export type AuditEnv = PrincipalEnv & {
  Variables: PrincipalEnv['Variables'] & {
    audit: AuditContext
  }
}

export interface AuditMiddlewareOptions {
  providers: ReadonlyArray<AuditProvider>
  strict: boolean
  actorPseudonym: ActorPseudonymMode
  actorSalt?: string
  recordSourceIp: SourceIpMode
  sourceIpSalt?: string
  trustedProxyCount?: number
  recordUserAgent: UserAgentMode
  logFailure?: AuditFailureLogger
}

export function auditMiddleware(opts: AuditMiddlewareOptions) {
  return createMiddleware<AuditEnv>(async (c, next) => {
    const principal = c.get('principal')
    const headers = new Map<string, string>()
    c.req.raw.headers.forEach((value, key) => {
      headers.set(key.toLowerCase(), value)
    })
    const peerIp = connectionAddress(c)
    const ctx = createAuditContext({
      providers: opts.providers,
      strict: opts.strict,
      actorPseudonym: opts.actorPseudonym,
      actorSalt: opts.actorSalt,
      recordSourceIp: opts.recordSourceIp,
      sourceIpSalt: opts.sourceIpSalt,
      trustedProxyCount: opts.trustedProxyCount,
      recordUserAgent: opts.recordUserAgent,
      principal,
      headers,
      peerIp,
      logFailure: opts.logFailure,
    })
    c.set('audit', ctx)
    await next()
  })
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
