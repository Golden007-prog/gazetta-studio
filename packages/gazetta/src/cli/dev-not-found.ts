/**
 * `gazetta dev`'s answer for a URL no page matches: the path that was asked
 * for, and the routes the site has. The `html` tag escapes each value, so
 * the path and page names show as text.
 */
import type { Context } from 'hono'
import { html } from 'hono/html'
import type { Site } from '../site-loader.js'

export function devNotFound(pages: Site['pages']) {
  return (c: Context) => {
    const routes = [...pages.entries()].map(([n, p]) => `  ${p.route} → ${n}`).join('\n')
    return c.html(
      html`<pre style="padding:2rem">Page not found: ${c.req.path}\n\nAvailable:\n${routes}\n  /admin → CMS editor</pre>`,
      404,
    )
  }
}
