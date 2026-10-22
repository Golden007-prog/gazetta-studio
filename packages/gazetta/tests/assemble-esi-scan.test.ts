import { describe, it, expect } from 'vitest'
import { assembleEsi, findEsiPaths, scanEsiMarkers } from '../src/assemble.js'

/**
 * The regex implementations scanEsiMarkers replaced, kept here as oracles so
 * the equivalence tests pin behavior against what actually ran before, not
 * against a re-reading of the requirements (issue #1114).
 */
function regexFindEsiPaths(html: string): string[] {
  const paths = new Set<string>()
  const regex = /<!--esi(?:-head)?:(\/[^>]+)-->/g
  let match
  while ((match = regex.exec(html)) !== null) paths.add(match[1])
  return [...paths]
}

function regexAssembleEsi(pageHtml: string, fragments: Map<string, { head: string; body: string }>): string {
  const esiHeadRegex = /<!--esi-head:(\/[^>]+)-->/g
  const esiBodyRegex = /<!--esi:(\/[^>]+)-->/g

  const esiHeadOrder: string[] = []
  const esiHeadRegex2 = /<!--esi-head:(\/[^>]+)-->/g
  let m
  while ((m = esiHeadRegex2.exec(pageHtml)) !== null) {
    if (!esiHeadOrder.includes(m[1])) esiHeadOrder.push(m[1])
  }

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

  let html = pageHtml
  const collectedCss = [...otherLines, ...cssLines].join('\n  ')
  let cssInserted = false
  html = html.replace(esiHeadRegex, () => {
    if (!cssInserted && collectedCss) {
      cssInserted = true
      return collectedCss
    }
    return ''
  })

  if (jsLines.length > 0) {
    html = html.replace('</head>', `  ${jsLines.join('\n  ')}\n</head>`)
  }

  html = html.replace(esiBodyRegex, (_match, path: string) => {
    const frag = fragments.get(path)
    return frag?.body ?? `<!-- fragment not found: ${path} -->`
  })

  return html
}

const trickyInputs = [
  '<!--esi:/a-->',
  '<!--esi:/-->', // a lone slash is not a path (the regex needed one more char)
  '<!--esi:-->', // empty path
  '<!--esi:/a', // unclosed
  '<!--esi:/a>b-->', // `>` before the closing marker
  '<!--esi:/a--x-->y', // dashes inside the path
  '<!--esi:/a <!--esi:/b-->', // an opening inside a would-be path
  '<!--e<!--esi:/x-->', // overlapping opening
  '<!--esi-head:/h.html--><!--esi:/b.html-->',
  '<!--esihead:/x.html-->', // missing colon
  '<!--esi-head:/h.html', // unclosed head marker
  '<!--esi:/a.html--><!--esi:/a.html-->', // duplicate markers
  'plain text with <!-- a comment -->',
]

const fragments = new Map([
  [
    '/a.html',
    {
      head: '<link rel="stylesheet" href="/a.css">\n<script type="module" src="/a.js"></script>',
      body: '<div>A</div>',
    },
  ],
  ['/b.html', { head: '<link rel="stylesheet" href="/b.css">', body: '<div>B</div>' }],
])

describe('scanEsiMarkers', () => {
  it('finds the same paths as the replaced regex on tricky inputs', () => {
    for (const html of trickyInputs) {
      expect(findEsiPaths(html)).toEqual(regexFindEsiPaths(html))
    }
  })

  it('assembles byte-identically to the replaced regexes on tricky inputs', () => {
    for (const html of trickyInputs) {
      expect(assembleEsi(html, fragments)).toBe(regexAssembleEsi(html, fragments))
    }
  })

  it('matches the replaced regexes on generated token soup', () => {
    // Deterministic PRNG so failures reproduce.
    let state = 42
    const rand = () => {
      state = (state * 1103515245 + 12345) % 2147483648
      return state / 2147483648
    }
    const tokens = [
      '<!--esi:',
      '<!--esi-head:',
      '<!--esi',
      '-->',
      '>',
      '/a.html',
      '/b.html',
      '/x y',
      'text',
      '<!--',
      '-',
    ]
    for (let i = 0; i < 500; i++) {
      const parts: string[] = []
      const count = Math.floor(rand() * 12)
      for (let j = 0; j < count; j++) parts.push(tokens[Math.floor(rand() * tokens.length)])
      const html = parts.join('')
      expect(findEsiPaths(html)).toEqual(regexFindEsiPaths(html))
      expect(assembleEsi(html, fragments)).toBe(regexAssembleEsi(html, fragments))
    }
  })

  it('reports marker kind, path and span', () => {
    const html = 'x<!--esi-head:/h.html-->y<!--esi:/b.html-->z'
    expect(scanEsiMarkers(html)).toEqual([
      { kind: 'head', path: '/h.html', start: 1, end: 24 },
      { kind: 'body', path: '/b.html', start: 25, end: 43 },
    ])
  })
})

describe('linear-time ESI scan (issue #1114)', () => {
  it('handles pages full of unclosed markers quickly', () => {
    // Pin: N unclosed openings scan in O(N). The 200 ms budget at the
    // issue's 20,000-opening scale fails a quadratic regression in
    // seconds while leaving slow runners a wide margin.
    const html = ('<!--esi:/' + 'a'.repeat(20)).repeat(20_000)
    const start = performance.now()
    expect(findEsiPaths(html)).toEqual([])
    expect(assembleEsi(html, fragments)).toBe(html)
    expect(performance.now() - start).toBeLessThan(200)
  })
})

describe('adversarial shapes stay linear', () => {
  it('repeated invalid openings before one closing marker', () => {
    // Pin: the first `>` and its `-->` verdict are found once and shared —
    // every opening that reaches the same `>` fails in constant time.
    const html = '<!--esi:/x>y '.repeat(20_000) + '-->'
    const start = performance.now()
    expect(findEsiPaths(html)).toEqual([])
    expect(performance.now() - start).toBeLessThan(200)
  })

  it('repeated pathless openings before one closing marker', () => {
    // Pin: an opening whose path fails the shape check is rejected without
    // rescanning the suffix.
    const html = '<!--esi:x '.repeat(20_000) + '-->'
    const start = performance.now()
    expect(findEsiPaths(html)).toEqual([])
    expect(performance.now() - start).toBeLessThan(200)
  })
})

describe('nested openings', () => {
  it('each API keeps its own legacy regex semantics on nested input', () => {
    // The old code was internally inconsistent on this shape: findEsiPaths'
    // combined regex consumed the outer marker, while assembleEsi's head-only
    // regex matched the inner head marker. The kind-filtered scans preserve
    // each API's own old semantics exactly, so even this malformed shape
    // assembles byte-identically to before.
    const html = '<!--esi:/a <!--esi-head:/b.html-->'
    expect(findEsiPaths(html)).toEqual(['/a <!--esi-head:/b.html'])
    const nested = new Map([['/b.html', { head: '<link rel="stylesheet" href="/b.css">', body: '<div>B</div>' }]])
    const result = assembleEsi(html, nested)
    expect(result).toBe(regexAssembleEsi(html, nested))
    // The old head-only regex matched the inner head marker, so the CSS is
    // inserted and the unclosed outer body opening is left in place.
    expect(result).toBe('<!--esi:/a <link rel="stylesheet" href="/b.css">')
  })
})
