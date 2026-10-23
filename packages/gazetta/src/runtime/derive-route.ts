/**
 * Derive a public route from a page folder name. Runtime-neutral — shared
 * by the Node server, the Cloudflare worker, and publish tooling.
 *
 *   home        → /
 *   about       → /about
 *   blog/[slug] → /blog/:slug
 */
export function deriveRoute(pageName: string): string {
  if (pageName === 'home') return '/'
  return '/' + pageName.replace(/\[([^\]]+)\]/g, ':$1')
}

/**
 * Substitute `:param` segments in a derived route with the request's
 * captured values. A route without parameters returns unchanged. A
 * parameter without a captured value returns null — there is no URL to
 * redirect to, so the caller answers 410 — whether the request captured
 * nothing at all (a plain page) or just not that segment (#1126).
 * Only the request's own captured keys count: a segment named like an
 * Object prototype member (`:constructor`) without a captured value is
 * missing, not inherited.
 */
export function fillRouteParams(route: string, params?: Record<string, string>): string | null {
  const captured = params ?? {}
  let missing = false
  const filled = route.replace(/:([A-Za-z0-9_-]+)/g, (segment, name: string) => {
    if (!Object.hasOwn(captured, name)) {
      missing = true
      return segment
    }
    return captured[name]
  })
  return missing ? null : filled
}
