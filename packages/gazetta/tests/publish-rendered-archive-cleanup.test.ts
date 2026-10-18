/**
 * Coverage for `listHashedFiles` filter + `publishArchiveMarker` behavior in
 * `publish-rendered.ts`. Captures mutants surfaced by Stryker run 25621614362
 * (issue #308):
 *
 *   - Line 26 LogicalOperator/ConditionalExpression/Regex mutants on the
 *     filter predicate `(!isDirectory && /\.(css|js)$/.test && /\.[a-f0-9]{8}\./.test)`
 *   - Line 29 ArrayDeclaration mutant on the catch-block fallback `[]`
 *   - Line 74 NoCoverage on the locale-undefined branch (`'index.html'`)
 *   - Line 88 BooleanLiteral mutant on `noindex: true` for archived sidecars
 *
 * Strategy: drive `publishPageRendered` against an archived page (which
 * dispatches to the private `publishArchiveMarker`) with pre-seeded files in
 * the page directory so the cleanup pass exercises every filter branch.
 * memoryStorage avoids template loading because `isArchived(page)`
 * short-circuits before the renderer runs.
 */
import { describe, expect, it } from 'vitest'
import { publishPageRendered } from '../src/publish-compat.js'
import { createContentRoot } from '../src/content-root.js'
import { loadSite } from '../src/site-loader.js'
import { memoryStorage } from './_helpers/memory-storage.js'
import type { DirEntry, StorageProvider } from '../src/types.js'

async function setupArchivedSite(extraSeed: Record<string, string> = {}) {
  const source = memoryStorage()
  source.seed({
    'pages/landing/page.json': JSON.stringify({
      template: 'echo',
      archived: true,
      archivedAt: '2026-05-09T10:00:00Z',
      aliasOf: 'welcome',
    }),
    'pages/welcome/page.json': JSON.stringify({ template: 'echo' }),
    ...extraSeed,
  })
  const site = await loadSite({
    contentRoot: createContentRoot(source),
    manifest: { name: '(archive-cleanup-test)' },
  })
  return { source, site }
}

describe('publishArchiveMarker — listHashedFiles cleanup filter', () => {
  it('cleans only files matching all three conditions: not-dir AND css/js$ AND 8-hex hash', async () => {
    const { source, site } = await setupArchivedSite()
    const target = memoryStorage()

    // Pre-existing artifacts in the archive's page dir from a prior live publish.
    target.seed({
      'pages/landing/index.html': '<html>old live html</html>',
      // SHOULD be cleaned (matches all three predicate clauses):
      'pages/landing/styles.deadbeef.css': '/* hashed css */',
      'pages/landing/script.cafe1234.js': '/* hashed js */',
      // SHOULD remain — fails one or more predicate clauses:
      'pages/landing/styles.notvalid.css': '/* css ext but no 8-hex hash */',
      'pages/landing/styles.deadbeef.css.bak': '/* 8-hex hash but ext is .bak */',
      'pages/landing/data.deadbeef.json': '{"hashed":"json"}',
      // SHOULD remain — directory entry:
      'pages/landing/subdir/file.txt': 'nested file',
    })

    const result = await publishPageRendered(
      'landing',
      createContentRoot(source),
      target,
      undefined,
      undefined,
      undefined,
      site,
    )

    // Marker overwrote the pre-existing index.html.
    expect(await target.readFile('pages/landing/index.html')).toBe('<!-- gazetta:archived alias=welcome -->\n')

    // Files matching the full predicate were cleaned.
    expect(await target.exists('pages/landing/styles.deadbeef.css')).toBe(false)
    expect(await target.exists('pages/landing/script.cafe1234.js')).toBe(false)

    // CSS extension but no 8-hex hash → must remain (kills LogicalOperator
    // mutant that drops the hash check, and ConditionalExpression → true).
    expect(await target.exists('pages/landing/styles.notvalid.css')).toBe(true)

    // 8-hex hash but extension is .bak (regex requires `$` anchor on css|js)
    // → must remain (kills Regex mutant that strips the `$`).
    expect(await target.exists('pages/landing/styles.deadbeef.css.bak')).toBe(true)

    // 8-hex hash but no css/js extension → must remain (kills LogicalOperator
    // mutant that turns the second `&&` into `||`, where the hash check alone
    // would match).
    expect(await target.exists('pages/landing/data.deadbeef.json')).toBe(true)

    // Directory entry → must remain (kills ConditionalExpression → true).
    expect(await target.exists('pages/landing/subdir/file.txt')).toBe(true)

    expect(result.files).toBe(1)
    expect(result.removed).toBe(2)
  })

  it('writes index.html at the locale-undefined path (kills line 74 NoCoverage)', async () => {
    const { source, site } = await setupArchivedSite()
    const target = memoryStorage()

    await publishPageRendered('landing', createContentRoot(source), target, undefined, undefined, undefined, site)

    expect(await target.exists('pages/landing/index.html')).toBe(true)
    expect(await target.readFile('pages/landing/index.html')).toBe('<!-- gazetta:archived alias=welcome -->\n')
    // The locale-suffixed path must NOT exist when locale is undefined.
    expect(await target.exists('pages/landing/index.fr.html')).toBe(false)
  })

  it('writes index.{locale}.html when locale is set (companion to the locale-undefined branch)', async () => {
    const { source, site } = await setupArchivedSite()
    const target = memoryStorage()

    await publishPageRendered(
      'landing',
      createContentRoot(source),
      target,
      undefined,
      undefined,
      undefined,
      site,
      undefined,
      'fr',
    )

    expect(await target.exists('pages/landing/index.fr.html')).toBe(true)
    expect(await target.exists('pages/landing/index.html')).toBe(false)
  })

  it('encodes noindex:true into the publish sidecar for archived pages (kills line 88)', async () => {
    const { source, site } = await setupArchivedSite()
    const target = memoryStorage()

    await publishPageRendered(
      'landing',
      createContentRoot(source),
      target,
      undefined,
      undefined,
      'aabbccdd', // manifestHash triggers sidecar emission
      site,
    )

    const entries = await target.readDir('pages/landing')
    const pubSidecar = entries.find(e => e.name.startsWith('.pub-'))
    expect(pubSidecar, 'archived publish must emit a .pub-* sidecar when manifestHash provided').toBeDefined()
    expect(
      pubSidecar!.name.includes('-noindex'),
      `archived publish must encode the noindex flag in the sidecar filename; got ${pubSidecar!.name}`,
    ).toBe(true)
  })

  it('returns oldFiles=[] (catch path) when targetStorage.readDir throws', async () => {
    const { source, site } = await setupArchivedSite()
    const baseTarget = memoryStorage()
    // Wrap memory storage so readDir throws on the page dir (the file the
    // function tries to enumerate before cleanup). Other paths fall through
    // to the underlying memory storage so writeSidecars can still proceed.
    const target: StorageProvider = {
      ...baseTarget,
      async readDir(path: string): Promise<DirEntry[]> {
        if (path === 'pages/landing') throw new Error('simulated readDir failure')
        return baseTarget.readDir(path)
      },
    }

    const result = await publishPageRendered(
      'landing',
      createContentRoot(source),
      target,
      undefined,
      undefined,
      undefined,
      site,
    )

    expect(result.files).toBe(1)
    // Mutant `[]` → `["Stryker was here"]` would yield removed=1 because
    // cleanupOldFiles would try to rm the bogus sentinel path (memoryStorage's
    // rm is silent on missing paths, so the counter increments).
    expect(result.removed).toBe(0)
    // Marker still written despite the readDir failure.
    expect(await baseTarget.readFile('pages/landing/index.html')).toBe('<!-- gazetta:archived alias=welcome -->\n')
  })
})
