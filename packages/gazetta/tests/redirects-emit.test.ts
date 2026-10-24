/**
 * Redirects-emit tests — pin the wire format per design-soft-delete.md
 * Q10. Plain-static hosts read this file directly; format errors mean
 * broken redirects in production.
 *
 * Each emitter is a pure function; tests cover both archive kinds
 * (alias = 301, no alias = 410), the determinism / sort guarantee,
 * and the empty-archives edge case.
 */
import { describe, it, expect } from 'vitest'
import {
  emitCloudflareRedirects,
  emitJsonRedirects,
  emitNetlifyRedirects,
  emitRedirects,
  redirectsFilename,
  type ArchiveSummary,
} from '../src/runtime/redirects-emit.js'

const aliasArchive: ArchiveSummary = { from: '/landing', to: '/welcome' }
const goneArchive: ArchiveSummary = { from: '/old-page' }

describe('emitCloudflareRedirects', () => {
  it('emits a 301 row for an aliased archive', () => {
    expect(emitCloudflareRedirects([aliasArchive])).toBe('/landing  /welcome  301\n')
  })

  it('emits a 410 row for a soft-delete (no aliasOf)', () => {
    expect(emitCloudflareRedirects([goneArchive])).toBe('/old-page  /  410\n')
  })

  it('emits both kinds together, sorted alphabetically by source', () => {
    const out = emitCloudflareRedirects([
      { from: '/zeta', to: '/welcome' },
      { from: '/alpha' },
      { from: '/beta', to: '/welcome' },
    ])
    expect(out).toBe(['/alpha  /  410', '/beta  /welcome  301', '/zeta  /welcome  301', ''].join('\n'))
  })

  it('leaves out a row whose route contains whitespace, which would split it', () => {
    const out = emitCloudflareRedirects([
      { from: '/old', to: '/x\n/*  /elsewhere  200!\n/y' },
      { from: '/two words', to: '/welcome' },
      aliasArchive,
    ])
    expect(out).toBe('/landing  /welcome  301\n')
  })

  it('returns empty string for zero archives', () => {
    expect(emitCloudflareRedirects([])).toBe('')
  })

  it('is deterministic — same input → same output (per call)', () => {
    const archives = [{ from: '/c', to: '/x' }, { from: '/a' }, { from: '/b', to: '/y' }]
    const a = emitCloudflareRedirects(archives)
    const b = emitCloudflareRedirects([...archives].reverse())
    expect(a).toBe(b)
  })
})

describe('emitNetlifyRedirects', () => {
  it('matches Cloudflare format for the patterns we emit', () => {
    const archives = [aliasArchive, goneArchive]
    expect(emitNetlifyRedirects(archives)).toBe(emitCloudflareRedirects(archives))
  })
})

describe('emitJsonRedirects', () => {
  it('splits archives into redirects + gone arrays', () => {
    const out = JSON.parse(emitJsonRedirects([aliasArchive, goneArchive]))
    expect(out).toEqual({
      redirects: [{ from: '/landing', to: '/welcome', status: 301 }],
      gone: [{ path: '/old-page', status: 410 }],
    })
  })

  it('returns valid JSON with empty arrays when there are no archives', () => {
    const out = JSON.parse(emitJsonRedirects([]))
    expect(out).toEqual({ redirects: [], gone: [] })
  })

  it('sorts both arrays by source path for determinism', () => {
    const out = JSON.parse(
      emitJsonRedirects([
        { from: '/zeta', to: '/x' },
        { from: '/alpha' },
        { from: '/beta', to: '/y' },
        { from: '/aaa' },
      ]),
    )
    expect(out.redirects.map((r: { from: string }) => r.from)).toEqual(['/beta', '/zeta'])
    expect(out.gone.map((g: { path: string }) => g.path)).toEqual(['/aaa', '/alpha'])
  })

  it('emits trailing newline for POSIX-friendly file output', () => {
    expect(emitJsonRedirects([aliasArchive]).endsWith('\n')).toBe(true)
  })
})

describe('redirectsFilename', () => {
  it('returns _redirects for Cloudflare', () => {
    expect(redirectsFilename('cloudflare')).toBe('_redirects')
  })

  it('returns _redirects for Netlify', () => {
    expect(redirectsFilename('netlify')).toBe('_redirects')
  })

  it('returns redirects.json for json', () => {
    expect(redirectsFilename('json')).toBe('redirects.json')
  })
})

/**
 * Integration: walk a Site's pages, derive the archive summary list,
 * and emit. Mirrors the wiring used by both `cli/index.ts` and
 * `admin-api/routes/publish.ts` — both consumers do exactly this
 * walk against `allPageEntries(site)`.
 *
 * Site is loaded from a fresh memoryStorage seeded with archived
 * page manifests; the walk picks up both alias and gone variants
 * and the emit produces the expected `_redirects` body.
 */
describe('publish-end wiring (walk site → emit)', () => {
  it('produces the right output for a mixed archive site', async () => {
    const { memoryStorage } = await import('./_helpers/memory-storage.js')
    const { loadSite, allPageEntries, deriveRoute } = await import('../src/site-loader.js')
    const source = memoryStorage()
    source.seed({
      'pages/home/page.json': JSON.stringify({ template: 'echo' }),
      'pages/landing/page.json': JSON.stringify({ template: 'echo', archived: true, aliasOf: 'welcome' }),
      'pages/welcome/page.json': JSON.stringify({ template: 'echo' }),
      'pages/old-page/page.json': JSON.stringify({ template: 'echo', archived: true }),
    })
    const { createContentRoot } = await import('../src/content-root.js')
    const site = await loadSite({
      contentRoot: createContentRoot(source),
      manifest: { name: '(test)' },
    })

    // The walk pattern used by both CLI and admin-API
    const archives: ArchiveSummary[] = []
    for (const entry of allPageEntries(site)) {
      if (entry.page.archived !== true) continue
      if (entry.locale) continue
      const from = deriveRoute(entry.name)
      const to = entry.page.aliasOf ? deriveRoute(entry.page.aliasOf) : undefined
      archives.push(to !== undefined ? { from, to } : { from })
    }

    const result = emitRedirects('cloudflare', archives)
    expect(result).not.toBeNull()
    expect(result!.filename).toBe('_redirects')
    // Deterministic sort — landing before old-page
    expect(result!.body).toBe(['/landing  /welcome  301', '/old-page  /  410', ''].join('\n'))
  })

  it('produces an empty body when no pages are archived (caller skips writing)', async () => {
    const { memoryStorage } = await import('./_helpers/memory-storage.js')
    const { loadSite, allPageEntries } = await import('../src/site-loader.js')
    const source = memoryStorage()
    source.seed({
      'pages/home/page.json': JSON.stringify({ template: 'echo' }),
    })
    const { createContentRoot } = await import('../src/content-root.js')
    const site = await loadSite({
      contentRoot: createContentRoot(source),
      manifest: { name: '(test)' },
    })

    const archives: ArchiveSummary[] = []
    for (const entry of allPageEntries(site)) {
      if (entry.page.archived !== true) continue
      archives.push({ from: '/' + entry.name })
    }

    expect(archives).toEqual([])
    const result = emitRedirects('cloudflare', archives)
    expect(result?.body).toBe('')
  })
})

describe('emitRedirects (orchestrator)', () => {
  it('returns null for format: none', () => {
    expect(emitRedirects('none', [aliasArchive])).toBeNull()
  })

  it('dispatches to the cloudflare emitter', () => {
    const out = emitRedirects('cloudflare', [aliasArchive])
    expect(out).toEqual({ filename: '_redirects', body: '/landing  /welcome  301\n' })
  })

  it('dispatches to the netlify emitter', () => {
    const out = emitRedirects('netlify', [goneArchive])
    expect(out).toEqual({ filename: '_redirects', body: '/old-page  /  410\n' })
  })

  it('dispatches to the json emitter', () => {
    const out = emitRedirects('json', [aliasArchive])
    expect(out?.filename).toBe('redirects.json')
    expect(JSON.parse(out!.body)).toEqual({
      redirects: [{ from: '/landing', to: '/welcome', status: 301 }],
      gone: [],
    })
  })

  it('returns empty body when there are no archives but format is set', () => {
    // Caller can choose to skip writing or write an empty file.
    expect(emitRedirects('cloudflare', [])).toEqual({ filename: '_redirects', body: '' })
  })
})
