/**
 * `GET /api/audit` — query forensic events from configured providers.
 *
 * Per design-audit.md "Audit drawer — query semantics":
 * each provider is one of two query shapes:
 *
 *   - **Query-capable** — implements `query()`. Returns events
 *     matching the filter. v1's `HistoryAuditProvider` is the only
 *     in-tree implementation.
 *   - **External-sink** — omits `query()`, optionally implements
 *     `queryUrl()` returning a deep-link to the operator's
 *     destination console.
 *
 * The route exposes BOTH: it asks every queryable provider for events
 * matching the filter and merges them; for non-queryable providers it
 * surfaces a `{ name, url }` reference that the drawer renders as a
 * "View in CloudWatch" link (or "configured but not queryable" when
 * `url` is null).
 *
 * # Why per-process providers, not per-source resolution
 *
 * Audit providers are admin-wide config (per `admin.audit` block),
 * not per-target. The route receives the providers array directly
 * from the boot block; same shape as `historyRoutes`.
 *
 * # Capability gating
 *
 * `read:audit-log` per design-audit.md and design-auth-rbac.md.
 * Built-in role `admin` grants via root wildcard `*`. Built-in
 * `editor` and `viewer` roles do NOT grant `read:audit-log` —
 * the prefix wildcard `read:*` they hold is wildcard-exempt for
 * audit (Cut 9). Operators wanting non-admin audit access declare
 * a custom role with `['read:*', 'read:audit-log']` explicitly.
 * Per design-auth-rbac.md "Audit-log read access is its own
 * capability — viewers don't see audit by default."
 *
 * # Response merging
 *
 * Events from multiple queryable providers merge by sort order
 * (newest first). Same-event dedup uses `(timestamp, actor.id,
 * action, scope)` tuple — providers writing the same event to
 * multiple sinks produce one logical event in the response.
 *
 * # Filter validation
 *
 * Action / outcome / scope.kind values are closed enums; the
 * provider validates each filter field before delegating. Invalid
 * values return 400 with the bad field. Missing filter fields are
 * treated as "no filter on that dimension."
 *
 * # SOLID lenses
 *
 *   - SRP: aggregator + dedup + filter parsing only. Doesn't audit
 *     itself (the read isn't a write); doesn't write events.
 *   - DIP: depends on `AuditProvider` interface, not on
 *     `HistoryAuditProvider`. v2 sinks slot in unchanged.
 *   - LSP: every provider's query result fits the same wire shape;
 *     consumers branch only on `outcome` for behavior.
 */
import { Hono } from 'hono'
import type { AuditEvent, AuditQuery } from '../../audit/types.js'
import type { AuditProvider } from '../../audit/provider.js'
import type { AuditEventWire, AuditExternalSinkWire, AuditQueryResponseWire } from '../schemas/audit.js'
import { AuditActionSchema, AuditOutcomeSchema, AuditScopeKindSchema } from '../schemas/audit.js'
import { requireCapability } from '../middleware/capability.js'

export interface AuditRoutesOptions {
  /**
   * Configured audit providers, in operator declaration order. The
   * route queries every provider implementing `query()`; non-
   * queryable providers contribute their `queryUrl()` instead.
   */
  providers: ReadonlyArray<AuditProvider>
}

const DEFAULT_LIMIT = 100
const MAX_LIMIT = 1000

export function auditRoutes(opts: AuditRoutesOptions) {
  const app = new Hono()

  app.get('/api/audit', requireCapability('read:audit-log'), async c => {
    // Filter parsing — closed enums validated against the schemas;
    // invalid values surface as 400 (operator typo, not server bug).
    const rawAction = c.req.query('action')
    const rawOutcome = c.req.query('outcome')
    const rawScopeKind = c.req.query('scopeKind')
    const rawScopeName = c.req.query('scopeName')
    const rawActor = c.req.query('actor')
    const rawSince = c.req.query('since')
    const rawUntil = c.req.query('until')
    const rawLimit = c.req.query('limit')

    const filter: AuditQuery = {}
    if (rawAction !== undefined) {
      const parsed = AuditActionSchema.safeParse(rawAction)
      if (!parsed.success) {
        return c.json({ error: `Invalid action: "${rawAction}"` }, 400)
      }
      filter.action = parsed.data
    }
    if (rawOutcome !== undefined) {
      const parsed = AuditOutcomeSchema.safeParse(rawOutcome)
      if (!parsed.success) {
        return c.json({ error: `Invalid outcome: "${rawOutcome}"` }, 400)
      }
      filter.outcome = parsed.data
    }
    if (rawScopeKind !== undefined || rawScopeName !== undefined) {
      filter.scope = {}
      if (rawScopeKind !== undefined) {
        const parsed = AuditScopeKindSchema.safeParse(rawScopeKind)
        if (!parsed.success) {
          return c.json({ error: `Invalid scopeKind: "${rawScopeKind}"` }, 400)
        }
        filter.scope.kind = parsed.data
      }
      if (rawScopeName !== undefined) filter.scope.name = rawScopeName
    }
    if (rawActor !== undefined) filter.actor = rawActor
    if (rawSince !== undefined) filter.since = rawSince
    if (rawUntil !== undefined) filter.until = rawUntil
    if (rawLimit !== undefined) {
      const n = Number(rawLimit)
      if (!Number.isFinite(n) || n <= 0) {
        return c.json({ error: `Invalid limit: "${rawLimit}"` }, 400)
      }
      filter.limit = Math.min(Math.floor(n), MAX_LIMIT)
    } else {
      filter.limit = DEFAULT_LIMIT
    }

    // Fan-out: every queryable provider contributes events; every
    // non-queryable provider contributes a sink reference. Both
    // arrays return to the drawer; the UI composes the four states.
    const queryableProviders = opts.providers.filter(p => typeof p.query === 'function')
    const nonQueryable = opts.providers.filter(p => typeof p.query !== 'function')

    const eventsFromProviders = await Promise.all(
      queryableProviders.map(async p => {
        try {
          // biome-ignore lint/style/noNonNullAssertion: filter above guarantees p.query is defined
          return await p.query!(filter)
        } catch {
          // Per design-audit.md "query() failures are fail-open per
          // Universal Provider Requirement #5": surface "audit query
          // unavailable" without throwing. Empty result keeps the
          // drawer rendering; operator's structured log catches the
          // provider failure.
          return [] as AuditEvent[]
        }
      }),
    )

    // Merge + dedup + sort-newest-first. Per design-audit.md "Recommended
    // operational pattern": run history + external-sink as peers; the
    // drawer dedups the inline copies via `event.id` (we use a synthetic
    // tuple since AuditEvent has no explicit id field — timestamp +
    // actor + action + scope + outcome is unique per attempt by
    // construction). outcome is part of the key: strict mode (#1393)
    // records a pre-write success event and a compensating
    // write-failed event for the SAME attempt, often within one
    // millisecond, and dropping either would misrepresent the attempt.
    const seen = new Set<string>()
    const merged: AuditEvent[] = []
    for (const events of eventsFromProviders) {
      for (const event of events) {
        const dedupKey = `${event.timestamp}:${event.actor.id}:${event.action}:${event.scope.kind}:${event.scope.name ?? ''}:${event.outcome}`
        if (seen.has(dedupKey)) continue
        seen.add(dedupKey)
        merged.push(event)
      }
    }
    // Sort newest first so the drawer's default "most recent" view
    // doesn't need client-side sorting. ISO-8601 strings sort
    // correctly via localeCompare.
    merged.sort((a, b) => b.timestamp.localeCompare(a.timestamp))
    // Re-apply the limit at the merge layer — individual providers
    // honor the limit per their own slice; merging two providers
    // could exceed it.
    const limited = merged.slice(0, filter.limit)

    // External-sink references: name + queryUrl() (or null when not
    // implemented or when queryUrl() returned null).
    const externalSinks: AuditExternalSinkWire[] = nonQueryable.map(p => ({
      name: p.name,
      url: p.queryUrl?.() ?? null,
    }))

    const body: AuditQueryResponseWire = {
      events: limited as AuditEventWire[],
      externalSinks,
    }
    return c.json(body)
  })

  return app
}
