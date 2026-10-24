import { describe, expect, it } from 'vitest'
import {
  appendFragmentMarker,
  insertPageMarker,
  outputHash,
  parsePublishedMarkers,
  publishedMarker,
} from '../src/runtime/published-marker.js'

const MARKER_LINE = /^<!-- gazetta:published hash=([0-9a-f]{8}) -->$/

const page = `<!--cache:browser=0,edge=86400-->
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
</head>
<body>
<h1>Hi</h1>
</body>
</html>`

function stripMarkerLines(html: string): string {
  return html
    .split('\n')
    .filter(line => !MARKER_LINE.test(line.trim()))
    .join('\n')
}

describe('publishedMarker', () => {
  it('formats the locked comment', () => {
    expect(publishedMarker('ab12cd34')).toBe('<!-- gazetta:published hash=ab12cd34 -->')
  })
})

describe('outputHash', () => {
  it('is an 8-hex prefix that changes with the input', () => {
    expect(outputHash('a')).toMatch(/^[0-9a-f]{8}$/)
    expect(outputHash('a')).not.toBe(outputHash('b'))
  })
})

describe('insertPageMarker', () => {
  it('puts the marker on its own line immediately before </head>, line 1 unchanged', () => {
    const marked = insertPageMarker(page)
    const lines = marked.split('\n')
    expect(lines[0]).toBe('<!--cache:browser=0,edge=86400-->')
    const closeIdx = lines.indexOf('</head>')
    expect(lines[closeIdx - 1]).toMatch(MARKER_LINE)
    expect(lines.filter(l => MARKER_LINE.test(l))).toHaveLength(1)
  })

  it('hashes the output without the marker', () => {
    const marked = insertPageMarker(page)
    expect(stripMarkerLines(marked)).toBe(page)
    expect(parsePublishedMarkers(marked).page).toBe(outputHash(page))
  })

  it('breaks the line when </head> is not at a line start', () => {
    const inline = '<html><head><title>x</title></head><body></body></html>'
    const marked = insertPageMarker(inline)
    expect(marked).toContain(`\n${publishedMarker(outputHash(inline))}\n</head>`)
  })

  it('leaves HTML without </head> unchanged', () => {
    expect(insertPageMarker('<p>no head</p>')).toBe('<p>no head</p>')
  })
})

describe('appendFragmentMarker', () => {
  it('ends the output with the marker, hashed without it', () => {
    const out = '<head>\n<link rel="stylesheet" href="/a.css">\n</head>\n<nav>x</nav>'
    const marked = appendFragmentMarker(out)
    expect(marked.startsWith(out)).toBe(true)
    expect(marked.endsWith(publishedMarker(outputHash(out)))).toBe(true)
  })
})

describe('parsePublishedMarkers', () => {
  it('round-trips a page marker and fragment markers in order', () => {
    const f1 = appendFragmentMarker('<header>h</header>')
    const f2 = appendFragmentMarker('<footer>f</footer>')
    const html = insertPageMarker(page).replace('<h1>Hi</h1>', `${f1}\n<h1>Hi</h1>\n${f2}`)
    expect(parsePublishedMarkers(html)).toEqual({
      page: outputHash(page),
      fragments: [outputHash('<header>h</header>'), outputHash('<footer>f</footer>')],
    })
  })

  it('treats markers in a truncated head as the page marker', () => {
    const truncated = insertPageMarker(page).split('</head>')[0]
    expect(parsePublishedMarkers(truncated)).toEqual({ page: outputHash(page), fragments: [] })
  })

  it('counts markers outside any head as fragment markers', () => {
    expect(parsePublishedMarkers(appendFragmentMarker('<nav></nav>'))).toEqual({
      page: null,
      fragments: [outputHash('<nav></nav>')],
    })
  })

  it.each([
    ['unmarked page', page],
    ['empty string', ''],
    ['malformed hash', '<head><!-- gazetta:published hash=xyz --></head>'],
    ['cut-off marker', '<head><!-- gazetta:published hash=ab12'],
    ['unbalanced tags', '</head><head><<<!-- -->'],
    ['non-string', 42 as unknown as string],
  ])('returns no markers for %s', (_label, input) => {
    expect(parsePublishedMarkers(input)).toEqual({ page: null, fragments: [] })
  })
})
