import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

// The too-old message in index.html and the minimum in docs/offline.md must
// state the same browser floor (#1399).
// Whitespace-flexible so doc line wraps cannot break the match.
const VERSION_PATTERN = /Chrome or Edge\s+(\d+)\+,\s+Firefox\s+(\d+)\+\s+or\s+Safari\s+([\d.]+)\+/

function repoFile(...candidates: string[]): string {
  for (const candidate of candidates) {
    const path = resolve(process.cwd(), candidate)
    if (existsSync(path)) return path
  }
  throw new Error(`not found from ${process.cwd()}: ${candidates.join(', ')}`)
}

const INDEX_HTML = repoFile('apps/admin/index.html', 'index.html')
const OFFLINE_DOC = repoFile('docs/offline.md', '../../docs/offline.md')

function minimumString(path: string): string {
  const match = readFileSync(path, 'utf8').match(VERSION_PATTERN)
  if (!match) throw new Error(`no minimum-browser string found in ${path}`)
  return `${match[1]}|${match[2]}|${match[3]}`
}

describe('supported-browser minimums', () => {
  it('index.html and docs/offline.md state the same minimum browsers', () => {
    expect(minimumString(OFFLINE_DOC)).toBe(minimumString(INDEX_HTML))
  })

  it('index.html runs the check before the module bundle', () => {
    const html = readFileSync(INDEX_HTML, 'utf8')
    const checkAt = html.indexOf('id="browser-too-old"')
    const bundleAt = html.indexOf('type="module"')
    expect(checkAt).toBeGreaterThan(-1)
    expect(bundleAt).toBeGreaterThan(-1)
    expect(checkAt).toBeLessThan(bundleAt)
  })
})
