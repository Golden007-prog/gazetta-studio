/**
 * Host-format redirect manifest emit per design-soft-delete.md Q10.
 *
 * Plain-static targets (no worker) can't read the per-page HTML
 * marker. They get a `_redirects` (or equivalent) file at the target
 * root that the host runtime reads. Cloudflare Pages and Netlify
 * both honor this convention; their syntax is identical for the
 * patterns we emit.
 *
 * Worker-served target types DON'T need this — the worker reads the
 * HTML marker directly per request.
 *
 * Pure functions: takes the archive summary list, returns the file
 * content as a string. Caller (publish.ts) writes to storage.
 *
 * SRP: this module owns the wire format. Walking the source for
 * archived pages is the caller's job. Adding a new host format
 * (e.g., a future Vercel-specific dialect) extends the file with a
 * new emit function and the type union — existing emitters
 * untouched.
 */
import type { RedirectsFormat } from '../types.js'

/**
 * Summary of one archived page contributing to the redirects file.
 *
 * `from`: source route (e.g. `/landing`). Includes leading slash;
 * empty path is the homepage `/`.
 * `to`: alias target route — only present when the archive has
 * `aliasOf` set. When absent, this entry is a 410 Gone.
 */
export interface ArchiveSummary {
  from: string
  to?: string
}

/**
 * Emit the `_redirects` file body. Cloudflare and Netlify share the
 * same syntax for the patterns we emit:
 *
 *   /from  /to  301        — permanent alias redirect
 *   /from  /    410        — soft-delete (gone)
 *
 * Cloudflare and Netlify both default to 301 when status is omitted,
 * but we emit it explicitly for forensic clarity. The `410` row uses
 * `/` as the destination because both hosts require a destination
 * column even for status-only rules; both will apply the status
 * regardless of where the destination points.
 *
 * Sorted by `from` so the output is deterministic across publishes.
 * Determinism matters because the file is content-addressed
 * downstream (host's CDN may cache it; same input = same output =
 * cache hit on republish without changes).
 */
export function emitCloudflareRedirects(archives: ReadonlyArray<ArchiveSummary>): string {
  // Fields are separated by whitespace, so a route containing any would
  // split its row into more fields or rows; such a row is left out.
  const rows = archives.filter(a => !/\s/.test(a.from) && (a.to === undefined || !/\s/.test(a.to)))
  if (rows.length === 0) return ''
  const sorted = [...rows].sort((a, b) => a.from.localeCompare(b.from))
  const lines = sorted.map(a => (a.to ? `${a.from}  ${a.to}  301` : `${a.from}  /  410`))
  return lines.join('\n') + '\n'
}

/**
 * Netlify uses the same `_redirects` grammar as Cloudflare for the
 * patterns we emit. Kept as a separate function so that future
 * Netlify-specific extensions (e.g., country-aware redirects via
 * `Country` headers) land here without forking Cloudflare.
 */
export function emitNetlifyRedirects(archives: ReadonlyArray<ArchiveSummary>): string {
  return emitCloudflareRedirects(archives)
}

/**
 * Structured JSON for custom host integrations. Operators with
 * non-Cloudflare/Netlify hosting wire their own glue (Caddy
 * `redir` directives, nginx rules, AWS CloudFront functions,
 * etc.) and consume this file at deploy time.
 *
 * Shape:
 *   {
 *     redirects: [{ from, to, status: 301 }, ...],
 *     gone:      [{ path, status: 410 }, ...]
 *   }
 *
 * Same sort order as Cloudflare/Netlify emit (alphabetical by
 * source path) so output is deterministic.
 */
export function emitJsonRedirects(archives: ReadonlyArray<ArchiveSummary>): string {
  const sorted = [...archives].sort((a, b) => a.from.localeCompare(b.from))
  const redirects = sorted.filter(a => a.to !== undefined).map(a => ({ from: a.from, to: a.to, status: 301 }))
  const gone = sorted.filter(a => a.to === undefined).map(a => ({ path: a.from, status: 410 }))
  return JSON.stringify({ redirects, gone }, null, 2) + '\n'
}

/**
 * The destination filename per format. Cloudflare and Netlify both
 * use `_redirects` at the site root; the JSON form lives at
 * `redirects.json`.
 */
export function redirectsFilename(format: Exclude<RedirectsFormat, 'none'>): string {
  switch (format) {
    case 'cloudflare':
    case 'netlify':
      return '_redirects'
    case 'json':
      return 'redirects.json'
  }
}

/**
 * Emit the file body for the given format. Returns null when the
 * format is `'none'` — callers skip writing entirely. Returns empty
 * string when there are no archives — caller decides whether to
 * write an empty file or skip.
 */
export function emitRedirects(
  format: RedirectsFormat,
  archives: ReadonlyArray<ArchiveSummary>,
): { filename: string; body: string } | null {
  if (format === 'none') return null
  const filename = redirectsFilename(format)
  switch (format) {
    case 'cloudflare':
      return { filename, body: emitCloudflareRedirects(archives) }
    case 'netlify':
      return { filename, body: emitNetlifyRedirects(archives) }
    case 'json':
      return { filename, body: emitJsonRedirects(archives) }
  }
}
