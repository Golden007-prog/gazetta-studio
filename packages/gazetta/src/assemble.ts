/**
 * ESI assembly — pure string functions, no I/O, no platform deps.
 * Used by edge workers and Node servers to compose pages from fragments.
 */

/** Parse and strip cache comment from page HTML */
export function parseCacheComment(html: string): { html: string; browser: number; edge: number } {
  const match = html.match(/^<!--cache:browser=(\d+),edge=(\d+)-->\n/)
  if (!match) return { html, browser: 0, edge: 86400 }
  return {
    html: html.slice(match[0].length),
    browser: parseInt(match[1], 10),
    edge: parseInt(match[2], 10),
  }
}

/** Split fragment HTML into head and body sections */
export function splitFragment(html: string): { head: string; body: string } {
  const headStart = html.indexOf('<head>')
  const headEnd = html.indexOf('</head>')

  if (headStart === -1 || headEnd === -1) {
    return { head: '', body: html }
  }

  return {
    head: html.slice(headStart + 6, headEnd).trim(),
    body: (html.slice(0, headStart) + html.slice(headEnd + 7)).trim(),
  }
}

/** One ESI marker found by scanEsiMarkers */
export interface EsiMarker {
  kind: 'head' | 'body'
  path: string
  /** Index of the marker's opening '<' in the scanned HTML */
  start: number
  /** Index just past the marker's closing '-->' */
  end: number
}

/**
 * Find every ESI marker in linear time.
 *
 * A marker is `<!--esi:/path-->` or `<!--esi-head:/path-->` where the path
 * starts with `/` plus at least one more character and contains no `>`. An
 * opening with no `-->` after it, or with `>` before the `-->`, is not a
 * marker. This matches what the previous regexes matched, but indexOf
 * scanning does not backtrack: page HTML with many unclosed `<!--esi:`
 * openings took quadratic time before (CodeQL js/polynomial-redos), and
 * markers are scanned on every request in the worker and in `gazetta serve`.
 */
export function scanEsiMarkers(html: string, kinds: readonly ('head' | 'body')[] = ['head', 'body']): EsiMarker[] {
  const markers: EsiMarker[] = []
  let pos = 0
  // The first `>` found by the last forward scan, and whether it closes a
  // `-->`. A later opening whose path starts before knownGt shares that same
  // first `>` (the scan proved nothing in between is one), so it is reused
  // instead of rescanning.
  let knownGt = -1
  let knownGtCloses = false
  // Openings whose path starts at or before deadUntil are known not to be
  // markers: their first `>` does not close a `-->`.
  let deadUntil = -1

  while (pos < html.length) {
    const open = html.indexOf('<!--esi', pos)
    if (open === -1) break

    let kind: 'head' | 'body'
    let pathStart: number
    if (html.startsWith('-head:', open + 7)) {
      kind = 'head'
      pathStart = open + 13
    } else if (html.startsWith(':', open + 7)) {
      kind = 'body'
      pathStart = open + 8
    } else {
      // Not an ESI opening. Advance one character, like a failed regex match.
      pos = open + 1
      continue
    }

    if (!kinds.includes(kind)) {
      // Scanning for the other kind only: this opening is invisible, but an
      // opening of the wanted kind can still start inside it.
      pos = open + 1
      continue
    }

    if (pathStart <= deadUntil) {
      pos = open + 1
      continue
    }

    let gt: number
    if (pathStart <= knownGt) {
      gt = knownGt
    } else {
      gt = html.indexOf('>', pathStart)
      if (gt === -1) break
      knownGt = gt
      knownGtCloses = html.startsWith('-->', gt - 2)
    }

    if (!knownGtCloses) {
      // Every opening whose path reaches this same `>` fails the same way.
      deadUntil = gt
      pos = open + 1
      continue
    }

    const close = gt - 2
    const path = html.slice(pathStart, close)
    // Equivalent of `(\/[^>]+)`: a slash plus at least one character, no `>`.
    if (path.length > 1 && path.startsWith('/')) {
      markers.push({ kind, path, start: open, end: gt + 1 })
      // A consumed marker hides any '<!--esi' inside it, like regex lastIndex.
      pos = gt + 1
    } else {
      // Not a marker, but a `<!--esi` inside this opening's would-be path can
      // still start one (the same `>` and close apply to it without rescanning).
      pos = open + 1
    }
  }
  return markers
}

/** Replace each marker in place, reading positions from the scanned HTML */
function replaceEsiMarkers(html: string, markers: EsiMarker[], replacement: (marker: EsiMarker) => string): string {
  if (markers.length === 0) return html
  const parts: string[] = []
  let last = 0
  for (const marker of markers) {
    parts.push(html.slice(last, marker.start), replacement(marker))
    last = marker.end
  }
  parts.push(html.slice(last))
  return parts.join('')
}

/** Find all ESI paths referenced in the page HTML */
export function findEsiPaths(html: string): string[] {
  const paths = new Set<string>()
  for (const marker of scanEsiMarkers(html)) paths.add(marker.path)
  return [...paths]
}

/** Assemble page HTML with fragment head and body content */
export function assembleEsi(pageHtml: string, fragments: Map<string, { head: string; body: string }>): string {
  // Head-only scan, equivalent to the old `esiHeadRegex` / `esiHeadRegex2`
  // pair: a head marker nested inside an unclosed body opening is still
  // matched, exactly as the old head-only regex matched it.
  const markers = scanEsiMarkers(pageHtml, ['head'])

  // Collect ESI head order from page
  const esiHeadOrder: string[] = []
  for (const marker of markers) {
    if (!esiHeadOrder.includes(marker.path)) esiHeadOrder.push(marker.path)
  }

  // Collect CSS and JS separately, preserving fragment order, deduplicating
  const cssLines: string[] = []
  const jsLines: string[] = []
  const otherLines: string[] = []
  const seen = new Set<string>()

  for (const path of esiHeadOrder) {
    const frag = fragments.get(path)
    if (!frag?.head) continue
    for (const line of frag.head
      .split('\n')
      .map(l => l.trim())
      .filter(Boolean)) {
      if (seen.has(line)) continue
      seen.add(line)
      if (line.includes('rel="stylesheet"') || line.includes("rel='stylesheet'")) {
        cssLines.push(line)
      } else if (line.startsWith('<script')) {
        jsLines.push(line)
      } else {
        otherLines.push(line)
      }
    }
  }

  // Replace first esi-head with other + CSS, remove the rest
  const collectedCss = [...otherLines, ...cssLines].join('\n  ')
  let cssInserted = false
  let html = replaceEsiMarkers(pageHtml, markers, () => {
    if (!cssInserted && collectedCss) {
      cssInserted = true
      return collectedCss
    }
    return ''
  })

  // Insert JS before </head> (after all CSS, preserving fragment order)
  if (jsLines.length > 0) {
    html = html.replace('</head>', `  ${jsLines.join('\n  ')}\n</head>`)
  }

  // Replace esi body tags with fragment body content. Rescan rather than reuse
  // positions: the passes above rewrote the HTML, and their replacement text
  // could itself contain markers the body pass would have matched.
  html = replaceEsiMarkers(html, scanEsiMarkers(html, ['body']), marker => {
    const frag = fragments.get(marker.path)
    return frag?.body ?? `<!-- fragment not found: ${marker.path} -->`
  })

  return html
}
