/**
 * Audit context — the per-request helper handlers call to record
 * events. Constructed once per `createAdminApp` boot from the
 * resolved `admin.audit` config; injected into Hono's request
 * context as `c.var.audit` by middleware.
 *
 * # Why a context object, not a free function
 *
 * Recording an event takes the principal (per-request), the
 * configured providers (per-app), the privacy modes (per-app),
 * and the source-IP / userAgent (per-request). A free function
 * would force every handler to thread the per-app config alongside
 * the per-request data — boilerplate every handler repeats.
 *
 * The context wraps both: `c.var.audit.record({ action, outcome,
 * scope, metadata? })` is all the handler writes. The middleware
 * pre-binds the per-app config + per-request principal/headers.
 *
 * # SOLID lenses
 *
 *   - SRP: this module owns the recording-site-facing helper. The
 *     recorder dispatcher (Cut 3), pseudonymization (Cut 4), and
 *     individual providers (Cut 2) are independent concerns.
 *   - DIP: handlers depend on the `AuditContext` interface, not on
 *     `recordToAll` or specific providers.
 */
import type { AuditAction, AuditEvent, AuditOutcome, AuditProvider, AuditScope } from './index.js'
import type { ActorPseudonymMode } from './pseudonymize.js'
import type { SourceIpExtractionContext, SourceIpMode } from './source-ip.js'
import type { UserAgentMode } from './user-agent.js'
import type { AuditFailureLogger, RecordResult } from './recorder.js'
import type { Principal } from '../auth/index.js'
import { recordToAll } from './recorder.js'
import { pseudonymizeActor } from './pseudonymize.js'
import { extractSourceIp, processSourceIp } from './source-ip.js'
import { processUserAgent } from './user-agent.js'

/**
 * What the handler supplies. Everything else (actor, sourceIp,
 * userAgent, timestamp) the context derives from per-request +
 * per-app data.
 */
export interface RecordEventInput {
  action: AuditAction
  outcome: AuditOutcome
  scope: AuditScope
  /** Provider-specific extras: missingCapabilities, source target, restoredFrom, etc. */
  metadata?: Record<string, unknown>
}

export interface AuditContext {
  /**
   * Record an event. Returns the recorder result so strict-mode
   * callers can branch on `result.failed > 0` (per design-audit.md
   * "Strict mode opt-in"). Non-strict callers ignore the return.
   *
   * Never throws (per Universal Provider Requirement #5). Failures
   * surface in the result + structured log.
   */
  record(input: RecordEventInput): Promise<RecordResult>
  /**
   * True when the operator has opted into strict mode. Handlers
   * check this to decide whether to abort the write on failed
   * recording.
   */
  readonly strict: boolean
}

export interface AuditContextOptions {
  /** Configured providers (in fan-out order). */
  providers: ReadonlyArray<AuditProvider>
  /** Strict mode flag from `admin.audit.strict`. */
  strict: boolean
  /** Pseudonymization mode for actor.id. */
  actorPseudonym: ActorPseudonymMode
  /** Pseudonymization salt — required when actorPseudonym is sha256. */
  actorSalt?: string
  /** Source-IP recording mode. */
  recordSourceIp: SourceIpMode
  /** Source-IP hash salt — required when recordSourceIp is hashed. */
  sourceIpSalt?: string
  /** Trusted proxy count for X-Forwarded-For mode dispatch. */
  trustedProxyCount?: number
  /** User-agent recording mode. */
  recordUserAgent: UserAgentMode
  /**
   * Per-request data. Bound by the middleware before each route
   * runs.
   */
  principal: Principal
  /** Per-request headers (lowercase keys). */
  headers: ReadonlyMap<string, string>
  /** Address of the connection the request arrived on, when the server exposes it. */
  peerIp?: string
  /** Failure logger. */
  logFailure?: AuditFailureLogger
}

/**
 * Build a context for one request. Production wiring: middleware
 * runs after `principalMiddleware` (so c.var.principal is populated)
 * + before route handlers; constructs the context with the request's
 * principal + headers and stores it on `c.var.audit`.
 */
export function createAuditContext(opts: AuditContextOptions): AuditContext {
  return {
    strict: opts.strict,
    async record(input: RecordEventInput): Promise<RecordResult> {
      // Apply pseudonymization to the actor BEFORE constructing
      // the event. Cuts a class of bugs where the pre-pseudonym
      // actor leaks via metadata or per-provider serialization.
      const actor = pseudonymizeActor(opts.principal, opts.actorPseudonym, opts.actorSalt)

      // Source IP — extract per trust mode, then process per
      // operator's mode. Both are pure functions; either step
      // returns null → omit the field.
      const sourceIpCtx: SourceIpExtractionContext = {
        trustMode: opts.principal.trustMode,
        headers: opts.headers,
        peerIp: opts.peerIp,
        trustedProxyCount: opts.trustedProxyCount,
      }
      const rawIp = extractSourceIp(sourceIpCtx)
      const sourceIp = processSourceIp(rawIp, opts.recordSourceIp, opts.sourceIpSalt) ?? undefined

      // User agent — same dispatch.
      const rawUa = opts.headers.get('user-agent')
      const userAgent = processUserAgent(rawUa, opts.recordUserAgent) ?? undefined

      const event: AuditEvent = {
        timestamp: new Date().toISOString(),
        actor,
        action: input.action,
        outcome: input.outcome,
        scope: input.scope,
        ...(sourceIp !== undefined ? { sourceIp } : {}),
        ...(userAgent !== undefined ? { userAgent } : {}),
        ...(input.metadata !== undefined ? { metadata: input.metadata } : {}),
      }

      return recordToAll(event, {
        providers: opts.providers,
        strict: opts.strict,
        logFailure: opts.logFailure,
      })
    },
  }
}
