/**
 * Coverage for `publishPageRendered` head-content assembly in
 * `publish-rendered.ts`. Captures mutants surfaced by Stryker run
 * 34576675605 (issue #811). Distinct from mutation-649 (per-child
 * accumulators + fragment path), mutation-726 (page-level CSS/JS
 * emit + unshift), and coverage (accumulator initial values); this
 * file covers the HEAD ASSEMBLY step AFTER accumulation + SEO
 * resolution:
 *
 *   - Line 207 StringLiteral (Survived) — `localHeadParts.join('\n')`
 *     → `""`. When mutated, `templateHead` becomes empty, so SEO's
 *     dedup check (`!templateHead?.includes('property="og:type"')`)
 *     is TRUE and SEO emits a duplicate og:type tag even when the
 *     template already provided one. Killed by asserting exactly ONE
 *     `<meta property="og:type">` in head when the template supplies
 *     it.
 *
 *   - Line 217 StringLiteral (Survived) — `<meta charset="UTF-8">` →
 *     `""`. The charset meta tag disappears from the head entirely
 *     (blank string is filtered out by `.filter(Boolean)` on line 225).
 *     Killed by asserting the exact charset meta tag.
 *
 *   - Line 218 StringLiteral (Survived) — `<meta name="viewport"
 *     content="width=device-width, initial-scale=1.0">` → `""`. Same
 *     shape as 217 for the viewport tag.
 *
 *   - Line 216-225 MethodExpression (Survived) — the `.join('\n  ')`
 *     call at line 226 is dropped, making `headContent` an array.
 *     Template-literal interpolation `${headContent}` uses default
 *     `Array.prototype.toString()` — elements joined by `,`. Killed
 *     by asserting the head contains `<meta charset="UTF-8">\n  <meta
 *     name="viewport"` (the specific `\n  ` delimiter).
 *
 *   - Line 226 StringLiteral (Survived) — `.join('\n  ')` → `.join("")`.
 *     Elements get concatenated with no separator. Same
 *     `<meta charset>\n  <meta name="viewport"` assertion catches
 *     both this mutant AND the 216-225 MethodExpression mutant.
 *
 * Equivalent mutants (documented so future triage doesn't re-litigate):
 *
 *   - Line 97 ArrayDeclaration `cleanupOldFiles(..., oldFiles, [])` →
 *     `["Stryker was here"]`. Only observable when `oldFiles` contains
 *     the literal sentinel path, which `listHashedFiles` cannot
 *     produce. Documented in `publish-rendered-coverage.test.ts` and
 *     `publish-rendered-mutation-726.test.ts`.
 *
 *   - Line 175 ArrayDeclaration `const newFiles: string[] = []` → same
 *     equivalence class as line 97. Documented in
 *     `publish-rendered-mutation-726.test.ts`.
 *
 *   - Line 146 StringLiteral `.startsWith('@')` → `.startsWith('')`.
 *     `resolver.ts:76-77` throws on non-`@`-prefixed string entries
 *     before this loop runs; only strings starting with `@` reach the
 *     check, and both `startsWith('@')` and `startsWith('')` return
 *     true for those. Documented in
 *     `publish-rendered-mutation-649.test.ts`.
 *
 * Strategy: real filesystem templates so jiti loads them normally,
 * matching the mutation-649 / mutation-726 file pattern. Deterministic
 * output lets assertions pin exact head content.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdir, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { createContentRoot } from '../src/content-root.js'
import { createFilesystemProvider } from '../src/providers/filesystem.js'
import { publishPageRendered } from '../src/publish-compat.js'
import { loadSite } from '../src/site-loader.js'
import { tempDir } from './_helpers/temp.js'

const testDir = tempDir('publish-rendered-mutation-811-' + Date.now())
const sourceDir = join(testDir, 'source')
const targetDir = join(testDir, 'target')
const templatesDir = join(testDir, 'templates')

async function writeTestFile(base: string, path: string, content: string) {
  const full = join(base, path)
  await mkdir(join(full, '..'), { recursive: true })
  await writeFile(full, content)
}

async function loadTestSite() {
  return loadSite({
    siteDir: sourceDir,
    storage: createFilesystemProvider(),
    templatesDir,
    manifest: { name: '(mutation-811)' },
  })
}

beforeEach(async () => {
  await mkdir(sourceDir, { recursive: true })
  await mkdir(targetDir, { recursive: true })
  await mkdir(templatesDir, { recursive: true })

  // Emits html only — head is empty. Used for the default head-assembly
  // assertions (charset, viewport, delimiter). No template head means
  // SEO's dedup checks see an empty string and emit their default tags,
  // so we get a predictable head shape.
  await mkdir(join(templatesDir, 'page-plain'), { recursive: true })
  await writeFile(
    join(templatesDir, 'page-plain/index.ts'),
    `import { z } from 'zod'
export const schema = z.object({})
export default ({ children }) => ({
  html: '<main>' + (children ?? []).map(c => c.html).join('') + '</main>',
  css: '',
  js: '',
  head: '',
})
`,
  )

  // Emits a <meta property="og:type"> in head. Used to test that
  // SEO's dedup detects the template's tag and does NOT emit its own
  // og:type. The mutant on line 207 (`localHeadParts.join('\n')` → "")
  // breaks the dedup by feeding "" into resolveSeoTags.
  await mkdir(join(templatesDir, 'page-og-type'), { recursive: true })
  await writeFile(
    join(templatesDir, 'page-og-type/index.ts'),
    `import { z } from 'zod'
export const schema = z.object({})
export default ({ children }) => ({
  html: '<main>' + (children ?? []).map(c => c.html).join('') + '</main>',
  css: '',
  js: '',
  head: '<meta property="og:type" content="article">',
})
`,
  )

  // Bare component — emits html only, no head. Used as a leaf so pages
  // have at least one child but the child doesn't pollute localHeadParts.
  await mkdir(join(templatesDir, 'echo-bare'), { recursive: true })
  await writeFile(
    join(templatesDir, 'echo-bare/index.ts'),
    `import { z } from 'zod'
export const schema = z.object({})
export default () => ({
  html: '<bare></bare>',
  css: '',
  js: '',
  head: '',
})
`,
  )
})

afterEach(async () => {
  await rm(testDir, { recursive: true, force: true })
})

describe('publishPageRendered — charset meta tag (kills line 217)', () => {
  it('emits the exact `<meta charset="UTF-8">` tag in head', async () => {
    // Line 217 mutation: template literal `<meta charset="UTF-8">` → "".
    // Empty strings are filtered out by `.filter(Boolean)` on line 225,
    // so the charset tag disappears from the assembled head entirely.
    //
    // Asserting the EXACT tag string catches the mutant.
    // `.toContain('charset')` would NOT — the `<html lang="en">` line
    // is nearby but doesn't include "charset", and no other line does.
    // Still, exact-match is the strongest form.
    await writeTestFile(
      sourceDir,
      'pages/charset/page.json',
      JSON.stringify({
        template: 'page-plain',
        components: [{ name: 'a', template: 'echo-bare' }],
      }),
    )
    const source = createFilesystemProvider(sourceDir)
    const site = await loadTestSite()
    const target = createFilesystemProvider(targetDir)

    await publishPageRendered('charset', createContentRoot(source), target, undefined, templatesDir, undefined, site)

    const html = await target.readFile('pages/charset/index.html')
    expect(html).toContain('<meta charset="UTF-8">')
  })
})

describe('publishPageRendered — viewport meta tag (kills line 218)', () => {
  it('emits the exact viewport meta tag in head', async () => {
    // Line 218 mutation: template literal
    // `<meta name="viewport" content="width=device-width, initial-scale=1.0">`
    // → "". Same shape as line 217 — empty string filtered out, viewport
    // tag disappears from head.
    //
    // The exact content string ("width=device-width, initial-scale=1.0")
    // matters — a StringLiteral mutant on part of the literal would also
    // surface as a broken assertion.
    await writeTestFile(
      sourceDir,
      'pages/viewport/page.json',
      JSON.stringify({
        template: 'page-plain',
        components: [{ name: 'a', template: 'echo-bare' }],
      }),
    )
    const source = createFilesystemProvider(sourceDir)
    const site = await loadTestSite()
    const target = createFilesystemProvider(targetDir)

    await publishPageRendered('viewport', createContentRoot(source), target, undefined, templatesDir, undefined, site)

    const html = await target.readFile('pages/viewport/index.html')
    expect(html).toContain('<meta name="viewport" content="width=device-width, initial-scale=1.0">')
  })
})

describe('publishPageRendered — head delimiter (kills lines 216-225 + 226)', () => {
  it('joins head elements with `\\n  ` (newline + 2 spaces), not empty string or comma', async () => {
    // Two related mutants:
    //   - Line 226 StringLiteral: `.join('\n  ')` → `.join("")`. Head
    //     elements concatenate without separator.
    //     Result: `<meta charset="UTF-8"><meta name="viewport"...`
    //   - Line 216-225 MethodExpression: `.filter(Boolean).join('\n  ')`
    //     drops the `.join(...)` call, leaving an array. Template-
    //     literal interpolation `${headContent}` stringifies the array
    //     via `Array.prototype.toString()` → comma-joined.
    //     Result: `<meta charset="UTF-8">,<meta name="viewport"...`
    //
    // Both mutants change the delimiter between the two guaranteed head
    // elements (charset + viewport). Asserting the exact substring
    // `<meta charset="UTF-8">\n  <meta name="viewport"` catches both.
    await writeTestFile(
      sourceDir,
      'pages/delim/page.json',
      JSON.stringify({
        template: 'page-plain',
        components: [{ name: 'a', template: 'echo-bare' }],
      }),
    )
    const source = createFilesystemProvider(sourceDir)
    const site = await loadTestSite()
    const target = createFilesystemProvider(targetDir)

    await publishPageRendered('delim', createContentRoot(source), target, undefined, templatesDir, undefined, site)

    const html = await target.readFile('pages/delim/index.html')
    // Exact delimiter shape: `>\n  <` between charset and viewport.
    // Empty-delimiter mutant produces `><`; drop-join mutant produces `>,<`.
    expect(html).toContain(
      '<meta charset="UTF-8">\n  <meta name="viewport" content="width=device-width, initial-scale=1.0">',
    )
    // Defense-in-depth: no comma-separated meta tags anywhere in head.
    const headMatch = html.match(/<head>([\s\S]*?)<\/head>/)
    expect(headMatch).toBeTruthy()
    expect(headMatch![1]).not.toMatch(/>,</)
  })
})

describe('publishPageRendered — templateHead dedup (kills line 207)', () => {
  it('does not duplicate `<meta property="og:type">` when the template already provides it', async () => {
    // Line 207 mutation: `const templateHead = localHeadParts.join('\n')`
    // → `""`. When mutated, `templateHead` is passed to `resolveSeoTags`
    // as an empty string, so SEO's dedup checks
    // (`!templateHead?.includes('property="og:type"')`) evaluate TRUE
    // and SEO emits its default `<meta property="og:type" content="website">`
    // even when the template already provided an og:type tag.
    //
    // Original: templateHead includes template's og:type → SEO skips
    //           its own og:type → exactly ONE og:type in head.
    // Mutant:   templateHead is "" → SEO does NOT skip → TWO og:type
    //           tags in head (template's "article" + SEO's "website").
    //
    // Asserting exactly one occurrence of `property="og:type"` catches
    // the mutant. Also asserting the template's specific value
    // ("article") won the coin toss over SEO's default ("website") is
    // load-bearing evidence the template's tag survived.
    await writeTestFile(
      sourceDir,
      'pages/og-type/page.json',
      JSON.stringify({
        template: 'page-og-type',
        components: [{ name: 'a', template: 'echo-bare' }],
      }),
    )
    const source = createFilesystemProvider(sourceDir)
    const site = await loadTestSite()
    const target = createFilesystemProvider(targetDir)

    await publishPageRendered('og-type', createContentRoot(source), target, undefined, templatesDir, undefined, site)

    const html = await target.readFile('pages/og-type/index.html')
    const headMatch = html.match(/<head>([\s\S]*?)<\/head>/)
    expect(headMatch).toBeTruthy()
    const head = headMatch![1]

    // Exactly one og:type tag in head.
    const ogTypeMatches = head.match(/property="og:type"/g) ?? []
    expect(ogTypeMatches).toHaveLength(1)

    // The template's `content="article"` is the surviving og:type. If
    // SEO also emitted its default (mutant behavior), we would see BOTH
    // `content="article"` and `content="website"` on separate lines.
    expect(head).toContain('<meta property="og:type" content="article">')
    expect(head).not.toContain('<meta property="og:type" content="website">')
  })
})
