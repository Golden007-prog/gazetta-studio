/**
 * `404.html` at a static target's root (design-soft-delete.md Q10, #1152
 * decision 3). Plain hosts (Cloudflare Pages, Netlify, GitHub Pages) show
 * a top-level `404.html` for paths with no file; without one, Cloudflare
 * Pages serves the homepage for every unknown path.
 */
import type { StorageProvider } from './types.js'
import { staticPageIndexPath } from './publish-item.js'
import { parseArchiveMarker } from './runtime/archive-marker.js'

export const STATIC_404_PATH = '404.html'

/** Shown while the target has no published `/404` page. */
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
 * The target's own `/404` page in the default language, as published, or the
 * minimal noindex page when the target has none or holds it archived. Copying
 * what the target serves at `/404`, not rendering the source's page, keeps
 * unpublished edits of the 404 page off the target (#1231).
 */
export async function static404Html(storage: StorageProvider): Promise<string> {
  const published = staticPageIndexPath('/404')
  if (!(await storage.exists(published))) return MINIMAL_404_HTML
  const html = await storage.readFile(published)
  return parseArchiveMarker(html) ? MINIMAL_404_HTML : html
}

/**
 * Writes `404.html` at the target root. Callers run it after the publish's own
 * writes, so a `/404` page published in the same run is the one copied.
 */
export async function writeStatic404(storage: StorageProvider): Promise<void> {
  await storage.writeFile(STATIC_404_PATH, await static404Html(storage))
}
