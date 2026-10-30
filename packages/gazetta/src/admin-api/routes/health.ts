/**
 * `GET /api/health` — heartbeat for offline-mode connection
 * detection per `design-offline.md` Q2 ("hybrid `navigator.onLine` +
 * heartbeat"). Browser-side connection-state store calls this every
 * 5s when `navigator.onLine` is false OR a recent request failed,
 * backing off to 30s after repeated failures, returning to silent
 * once a heartbeat succeeds.
 *
 * # SOLID lenses
 *
 *   - SRP: this module owns "is the admin process reachable?". Cache
 *     stats live next door in `system.ts`; conflating them would
 *     couple browser-side connection-detection cadence to per-target
 *     cache-stats lookups, and would force the heartbeat through any
 *     future capability gates the system route picks up.
 *   - DIP: takes no dependencies — the route is genuinely stateless.
 *     The browser only needs "did the admin process answer at all?".
 *
 * # Why public + auth-free
 *
 * Per `design-offline.md`: lightweight; no DB query; no auth check.
 * Two reasons matter:
 *
 *   1. The browser must reach this endpoint while offline (where the
 *      browser THINKS the network is up but auth tokens may have
 *      expired). Gating on auth means an expired-token user appears
 *      "offline" even when the server is reachable — wrong UX.
 *   2. CDNs / edge runtimes can cache this response cheaply for
 *      `dynamic` targets behind a worker. Auth would defeat that.
 *
 * # Cacheable?
 *
 * Response includes a `timestamp` so accidentally-cached responses
 * don't lie about freshness. Operators behind a CDN should set the
 * cache TTL low (a few seconds at most); browsers don't cache by
 * default since EventSource / `fetch` cache semantics are GET-only
 * and the `timestamp` makes byte-identical responses unlikely.
 *
 * # Design-locked response shape
 *
 *   { ok: true, timestamp: '2026-05-06T15:23:04.567Z' }
 *
 * `ok: true` is always returned when the route reaches this handler
 * — by definition, a process that can serve the route is healthy
 * enough for the browser's "can I reach the server?" question. Any
 * deeper liveness check (DB, storage, cache) would be a separate
 * `/api/system/*` endpoint, NOT this one.
 */
import { Hono } from 'hono'

interface HealthResponse {
  ok: true
  /** ISO 8601 timestamp the server generated this response. */
  timestamp: string
}

/**
 * Build the health-check route. Takes no parameters — health is
 * process-level, not per-source.
 */
export function healthRoutes() {
  const app = new Hono()

  app.get('/api/health', c => {
    const body: HealthResponse = {
      ok: true,
      timestamp: new Date().toISOString(),
    }
    return c.json(body)
  })

  return app
}
