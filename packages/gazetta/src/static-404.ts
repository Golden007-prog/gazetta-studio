/**
 * `404.html` at a static target's root (design-soft-delete.md Q10, #1152
 * decision 3). Plain hosts (Cloudflare Pages, Netlify, GitHub Pages) show
 * a top-level `404.html` for paths with no file; without one, Cloudflare
 * Pages serves the homepage for every unknown path.
 */
import type { StorageProvider } from './types.js'
import type { Site } from './site-loader.js'
import { isArchived } from './archive-helpers.js'
import { renderPageStatic } from './publish-renderers.js'

export const STATIC_404_PATH = '404.html'

/** Shown when the site has no live `/404` page. */
export const MINIMAL_404_HTML = `<!doctype html>
<html>
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>Page not found</title>
</head>
<body>
<h1>Page not found</h1>
</body>
</html>
`

/**
 * The site's default-language `/404` page, rendered as a static target
 * serves it, or the minimal noindex page when the site has none (or it
 * can't be rendered).
 */
export async function static404Html(site: Site): Promise<string> {
  for (const [name, page] of site.pages) {
    if (page.route !== '/404') continue
    if (isArchived(page)) break
    try {
      const output = await renderPageStatic(name, { site })
      return output.indexHtml
    } catch {
      break
    }
  }
  return MINIMAL_404_HTML
}

/** Writes `404.html` at the target root. Every publish rewrites it, so it stays current. */
export async function writeStatic404(storage: StorageProvider, site: Site): Promise<void> {
  await storage.writeFile(STATIC_404_PATH, await static404Html(site))
}
