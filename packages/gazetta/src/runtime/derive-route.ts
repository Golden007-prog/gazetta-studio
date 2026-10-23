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
  const filled = route.replace(/:([^/]+)/g, (segment, name: string) => {
    if (!Object.hasOwn(captured, name)) {
      missing = true
      return segment
    }
    return captured[name]
  })
  return missing ? null : filled
}

/**
 * Percent-encode a derived route for use as a redirect target, leaving
 * `:param` placeholders byte-identical. A placeholder's name is the page
 * folder's bracketed name — `posts/[post.slug]`, `posts/[slúg]` — and the
 * captured values are keyed by that exact name, so encoding it here would
 * break the match in `fillRouteParams`. Only the literal parts (the page
 * names) carry characters that need encoding (#1126).
 */
export function encodeRoutePattern(route: string): string {
  return route
    .split(/(:[^/]+)/g)
    .map(part => (part.startsWith(':') ? part : encodeURI(part)))
    .join('')
}
