/**
 * Published-version marker per design-live-check.md Q4.
 *
 * Publish writes `<!-- gazetta:published hash=ab12cd34 -->` at the end of
 * each page's `<head>` and, on ESI targets, at the end of each fragment's
 * body. The hash is of the rendered output without the marker, so content,
 * template and asset-URL changes all change it. The live check reads the
 * markers back from what a host serves and compares them with what publish
 * wrote.
 *
 * Line 1 of a page is reserved for the cache comment and archive markers,
 * which the worker reads from the first bytes of the file; the published
 * marker never goes there.
 *
 * Fragment markers carry no name: the live check compares their hashes as a
 * set against the fragments publish wrote.
 */

import { createHash } from 'node:crypto'

const MARKER_RE = /<!-- gazetta:published hash=([0-9a-f]{8}) -->/g

/** The marker comment for an output hash. */
export function publishedMarker(hash: string): string {
  return `<!-- gazetta:published hash=${hash} -->`
}

/** 8-hex MD5 prefix of the rendered output, the `.{8hex}.hash` convention. */
export function outputHash(html: string): string {
  return createHash('md5').update(html).digest('hex').slice(0, 8)
}

/**
 * Insert the marker on its own line before the document's closing `</head>`.
 * The hash covers the HTML as given (without a marker). HTML with no
 * `</head>` is returned unchanged: there is no head to mark.
 */
export function insertPageMarker(html: string): string {
  const close = html.indexOf('</head>')
  if (close === -1) return html
  const marker = publishedMarker(outputHash(html))
  const atLineStart = close === 0 || html[close - 1] === '\n'
  return `${html.slice(0, close)}${atLineStart ? '' : '\n'}${marker}\n${html.slice(close)}`
}

/**
 * Add the marker at the end of a fragment's output. The body is the last
 * part of a fragment file (after any `<head>` section), so the marker ends
 * the body the worker puts at the ESI placeholder; the hash covers the whole
 * output, head section included.
 */
export function appendFragmentMarker(output: string): string {
  return `${output}\n${publishedMarker(outputHash(output))}`
}

export interface PublishedMarkers {
  /** Hash of the marker inside the document's `<head>`, or null. */
  page: string | null
  /** Hashes of markers outside the head, in document order. */
  fragments: string[]
}

/**
 * Read the markers from any HTML a host returns. Never throws.
 *
 * The head region runs from `<head` to the first `</head>`; when the closing
 * tag is missing (a truncated response) it runs to the end, so a page marker
 * isn't mistaken for a fragment's. Without a `<head`, every marker counts as
 * a fragment marker.
 */
export function parsePublishedMarkers(html: unknown): PublishedMarkers {
  const result: PublishedMarkers = { page: null, fragments: [] }
  if (typeof html !== 'string' || html.length === 0) return result
  const headStart = html.indexOf('<head')
  const closeAt = headStart === -1 ? -1 : html.indexOf('</head>', headStart)
  const headEnd = headStart === -1 ? -1 : closeAt === -1 ? html.length : closeAt
  for (const match of html.matchAll(MARKER_RE)) {
    const at = match.index ?? 0
    const inHead = headStart !== -1 && at > headStart && at < headEnd
    if (inHead) {
      if (result.page === null) result.page = match[1]
    } else {
      result.fragments.push(match[1])
    }
  }
  return result
}
