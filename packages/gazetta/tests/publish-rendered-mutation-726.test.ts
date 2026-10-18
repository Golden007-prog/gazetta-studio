/**
 * Coverage for `publishPageRendered` page-level CSS/JS pipeline in
 * `publish-rendered.ts`. Captures mutants surfaced by Stryker run
 * 32329663340 (issue #726). Distinct from mutation-649 which covered
 * the per-child (component) accumulator branches; this file covers the
 * page-level unshift + hashed-file-emit branches AFTER accumulation:
 *
 *   - Line 167 ConditionalExpression (Survived) — `if (pageOutput.css)`
 *     → `true`. When the page template emits no CSS (`css: ''`), forcing
 *     the branch unshifts an empty string into `localCssParts`, adding a
 *     phantom leading newline to the joined `pageCss`.
 *   - Line 180 StringLiteral (Survived) — `let pageCssLink = ''` →
 *     `"Stryker was here!"`. When `pageCss` is empty, the inner
 *     assignment at line 187 never fires, so the initial value flows
 *     verbatim into the rendered `<head>`.
 *   - Line 181 ConditionalExpression (Survived) — `if (pageCss)` →
 *     `true`. Forcing the branch on an empty `pageCss` writes a bogus
 *     `styles.<hash>.css` file (hash of empty string) to the target,
 *     which asserting-no-CSS-file catches.
 *   - Line 187 StringLiteral (Survived) — the CSS link template literal
 *     `` `<link rel="stylesheet" href="/${cssPath}">` `` mutates to `` `` ``
 *     (empty). A `.toContain('.css')`-style assertion passes because the
 *     hashed filename appears elsewhere (sidecar filename), but the head
 *     is missing its link tag entirely.
 *   - Line 192 StringLiteral (Survived) — `localJsParts.join('\n')` →
 *     `""`. With a single JS part the delimiter doesn't matter; only a
 *     multi-JS-component test surfaces the mutation.
 *
 * PLUS parallel JS-side mutants (not listed in the top-8 of the issue
 * but structurally identical to 180/181/187 for JS and likely surviving
 * in the 97 unlisted mutants):
 *
 *   - Line 193 `let pageJsLink = ''` — same shape as 180.
 *   - Line 194 `if (pageJs)` — same shape as 181.
 *   - Line 200 `<script type="module" src="/${jsPath}"></script>` — same
 *     shape as 187.
 *
 * Equivalent mutants (documented so future triage doesn't re-litigate):
 *
 *   - Line 97 ArrayDeclaration `cleanupOldFiles(..., oldFiles, [])` →
 *     `["Stryker was here"]`. Only changes observable behavior when
 *     `oldFiles` contains the literal sentinel path, which
 *     `listHashedFiles` cannot produce. Already noted in
 *     `publish-rendered-coverage.test.ts`.
 *   - Line 146 StringLiteral `childEntry.startsWith('@')` → `""`.
 *     `resolver.ts:76` throws on non-`@`-prefixed string entries before
 *     the loop runs, so every string entry that reaches this check
 *     starts with `'@'`. Both `startsWith('@')` and `startsWith('')`
 *     return true for those entries; the mutation cannot change the
 *     branch selected. Already noted in `publish-rendered-mutation-649.test.ts`.
 *   - Line 175 ArrayDeclaration `const newFiles: string[] = []` →
 *     `["Stryker was here"]`. Same equivalence class as line 97 — the
 *     sentinel enters `cleanupOldFiles`'s `newSet` but no real
 *     `oldFile` path equals the sentinel string, so no observable
 *     change to which files get removed.
 *
 * Strategy: real filesystem templates so jiti loads them normally. Two
 * page templates ("page-empty" emits nothing, "page-mut" emits real
 * CSS/head), plus four component templates ("echo-bare" all-empty,
 * "echo-full" all-populated, "echo-js-a"/"echo-js-b" distinct JS).
 * Deterministic output lets assertions pin exact HTML tags with
 * regexes anchored on the hashed filename shape.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdir, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { createContentRoot } from '../src/content-root.js'
import { createFilesystemProvider } from '../src/providers/filesystem.js'
import { publishPageRendered } from '../src/publish-compat.js'
import { loadSite } from '../src/site-loader.js'
import { tempDir } from './_helpers/temp.js'

const testDir = tempDir('publish-rendered-mutation-726-' + Date.now())
const sourceDir = join(testDir, 'source')
const targetDir = join(testDir, 'target')
const templatesDir = join(testDir, 'templates')

const FULL_CSS = '.echo-full-c{color:red}'
const FULL_JS = 'window.__echoFullJs=1;'
const PAGE_CSS = '.page-mut-p{background:blue}'
const PAGE_HEAD = '<meta name="page-mut-head">'
const JS_A = 'window.__echoA=1;'
const JS_B = 'window.__echoB=2;'

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
    manifest: { name: '(mutation-726)' },
  })
}

beforeEach(async () => {
  await mkdir(sourceDir, { recursive: true })
  await mkdir(targetDir, { recursive: true })
  await mkdir(templatesDir, { recursive: true })

  // Emits html only — every other channel is an empty string. Used to
  // drive the empty-pageCss / empty-pageJs branches.
  await mkdir(join(templatesDir, 'echo-bare'), { recursive: true })
  await writeFile(
    join(templatesDir, 'echo-bare/index.ts'),
    `import { z } from 'zod'
export const schema = z.object({ text: z.string().optional() })
export default ({ content }) => ({
  html: '<bare>' + (content?.text ?? '') + '</bare>',
  css: '',
  js: '',
  head: '',
})
`,
  )

  // Emits all four channels — used for the exact-tag CSS/JS assertions
  // (page HAS CSS + JS, so link/script tags must be emitted).
  await mkdir(join(templatesDir, 'echo-full'), { recursive: true })
  await writeFile(
    join(templatesDir, 'echo-full/index.ts'),
    `import { z } from 'zod'
export const schema = z.object({ text: z.string().optional() })
export default ({ content }) => ({
  html: '<full>' + (content?.text ?? '') + '</full>',
  css: '${FULL_CSS}',
  js: '${FULL_JS}',
  head: '',
})
`,
  )

  // Two components with distinct JS strings — used for the multi-part
  // JS join test that pins the delimiter as '\n'.
  await mkdir(join(templatesDir, 'echo-js-a'), { recursive: true })
  await writeFile(
    join(templatesDir, 'echo-js-a/index.ts'),
    `import { z } from 'zod'
export const schema = z.object({})
export default () => ({ html: '<a></a>', css: '', js: '${JS_A}' })
`,
  )
  await mkdir(join(templatesDir, 'echo-js-b'), { recursive: true })
  await writeFile(
    join(templatesDir, 'echo-js-b/index.ts'),
    `import { z } from 'zod'
export const schema = z.object({})
export default () => ({ html: '<b></b>', css: '', js: '${JS_B}' })
`,
  )

  // Page-level template that emits NOTHING beyond its wrapper markup —
  // empty css/js/head. Drives the "no page-level CSS" branch mutants.
  await mkdir(join(templatesDir, 'page-empty'), { recursive: true })
  await writeFile(
    join(templatesDir, 'page-empty/index.ts'),
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

  // Page-level template with real CSS + head — used for the exact-tag
  // CSS assertion.
  await mkdir(join(templatesDir, 'page-mut'), { recursive: true })
  await writeFile(
    join(templatesDir, 'page-mut/index.ts'),
    `import { z } from 'zod'
export const schema = z.object({})
export default ({ children }) => ({
  html: '<main>' + (children ?? []).map(c => c.html).join('') + '</main>',
  css: '${PAGE_CSS}',
  js: '',
  head: '${PAGE_HEAD}',
})
`,
  )
})

afterEach(async () => {
  await rm(testDir, { recursive: true, force: true })
})

describe('publishPageRendered — empty page-CSS branch (kills lines 167, 180, 181)', () => {
  it('writes NO stylesheet file and emits NO link tag when nothing contributes CSS', async () => {
    // Setup: page-empty (no page-level CSS) + echo-bare (no component CSS).
    // Original behavior: `pageOutput.css === ''` skips line-167 unshift;
    // `pageCss === ''` skips line-181 emit block; `pageCssLink` stays `''`
    // (line 180) so no <link> tag reaches the head.
    //
    // Mutant behaviors this test defeats:
    //   - Line 167 forced true: unshifts '' into localCssParts. pageCss
    //     becomes '' still (join of one empty string) — no CSS file
    //     written, no link emitted. Actually equivalent when
    //     localCssParts starts empty. But when combined with the
    //     also-empty pageOutput.css and even a single bare component,
    //     the observable state stays "no CSS file, no link tag" — this
    //     test does NOT kill 167 alone. See second test in this suite
    //     for the load-bearing 167 kill.
    //   - Line 180 mutated to "Stryker was here!": that literal leaks
    //     into the rendered head because line 187's assignment never
    //     fires. Head-content assertion catches it.
    //   - Line 181 forced true: contentHash('') = 'd41d8cd9', writes
    //     `styles.d41d8cd9.css` (empty file) + emits a link tag.
    //     Directory-listing assertion catches the bogus file.
    await writeTestFile(
      sourceDir,
      'pages/no-css/page.json',
      JSON.stringify({
        template: 'page-empty',
        components: [{ name: 'a', template: 'echo-bare', content: { text: 'x' } }],
      }),
    )
    const source = createFilesystemProvider(sourceDir)
    const site = await loadTestSite()
    const target = createFilesystemProvider(targetDir)

    await publishPageRendered('no-css', createContentRoot(source), target, undefined, templatesDir, undefined, site)

    // Directory should contain index.html + sidecars only — no styles.*.css.
    const entries = await target.readDir('pages/no-css')
    const cssFiles = entries.filter(e => /\.css$/.test(e.name))
    expect(cssFiles, `no CSS file should be written; got: ${cssFiles.map(e => e.name).join(', ')}`).toHaveLength(0)

    const html = await target.readFile('pages/no-css/index.html')
    const headMatch = html.match(/<head>([\s\S]*?)<\/head>/)
    expect(headMatch, 'must have a <head> section').toBeTruthy()
    const head = headMatch![1]

    // No stylesheet link — line 187 template literal never fires when
    // pageCss is empty; if line 181 is mutated to `true`, it does fire
    // and this assertion catches the phantom link.
    expect(head).not.toContain('<link rel="stylesheet"')
    // No sentinel from line 180's mutant — must not leak into head.
    expect(head).not.toContain('Stryker was here')
  })

  it('does NOT unshift empty page-CSS into a page WITH component CSS (kills line 167)', async () => {
    // Setup: page-empty (pageOutput.css === '') + echo-full (has CSS).
    //   Original: line 167 skipped, localCssParts = [scoped-full-css]
    //             pageCss = scoped-full-css (1 line)
    //   Mutant (167 true): localCssParts.unshift('') runs anyway →
    //     localCssParts = ['', scoped-full-css]
    //     pageCss = '\n<scoped-full-css>' (LEADING NEWLINE — 2 lines,
    //     first blank)
    //
    // Asserting the CSS file starts with the scoped content (no leading
    // blank) catches the mutant. Also assert exactly 1 line.
    await writeTestFile(
      sourceDir,
      'pages/empty-page-full-comp/page.json',
      JSON.stringify({
        template: 'page-empty',
        components: [{ name: 'a', template: 'echo-full', content: { text: 'x' } }],
      }),
    )
    const source = createFilesystemProvider(sourceDir)
    const site = await loadTestSite()
    const target = createFilesystemProvider(targetDir)

    await publishPageRendered(
      'empty-page-full-comp',
      createContentRoot(source),
      target,
      undefined,
      templatesDir,
      undefined,
      site,
    )

    const entries = await target.readDir('pages/empty-page-full-comp')
    const cssEntry = entries.find(e => /\.css$/.test(e.name))
    expect(cssEntry, 'must emit exactly one CSS file').toBeDefined()
    const css = await target.readFile(`pages/empty-page-full-comp/${cssEntry!.name}`)

    // Exactly one line: scoped echo-full CSS. A mutant that unshifts
    // '' onto localCssParts produces 2 lines with the first blank.
    const lines = css.split('\n')
    expect(lines).toHaveLength(1)
    expect(lines[0]).toMatch(/^\[data-gz="[a-f0-9]{8}"\] \.echo-full-c\{color:red\}$/)
    // Defense-in-depth: no empty line anywhere.
    expect(css.startsWith('\n')).toBe(false)
  })
})

describe('publishPageRendered — empty page-JS branch (kills lines 193, 194)', () => {
  it('writes NO script file and emits NO script tag when nothing contributes JS', async () => {
    // Symmetric to the empty-page-CSS test. page-empty + echo-bare
    // means localJsParts is empty, pageJs === '', line 194 skipped,
    // pageJsLink stays '' (line 193). No script.*.js file emitted, no
    // script tag in head.
    //
    // Mutant behaviors this test defeats:
    //   - Line 193 → "Stryker was here!": leaks into rendered head.
    //   - Line 194 forced true: writes `script.d41d8cd9.js` (empty file
    //     hash) + emits a script tag.
    await writeTestFile(
      sourceDir,
      'pages/no-js/page.json',
      JSON.stringify({
        template: 'page-empty',
        components: [{ name: 'a', template: 'echo-bare', content: { text: 'x' } }],
      }),
    )
    const source = createFilesystemProvider(sourceDir)
    const site = await loadTestSite()
    const target = createFilesystemProvider(targetDir)

    await publishPageRendered('no-js', createContentRoot(source), target, undefined, templatesDir, undefined, site)

    const entries = await target.readDir('pages/no-js')
    const jsFiles = entries.filter(e => /\.js$/.test(e.name))
    expect(jsFiles, `no JS file should be written; got: ${jsFiles.map(e => e.name).join(', ')}`).toHaveLength(0)

    const html = await target.readFile('pages/no-js/index.html')
    const headMatch = html.match(/<head>([\s\S]*?)<\/head>/)
    expect(headMatch).toBeTruthy()
    const head = headMatch![1]

    expect(head).not.toContain('<script type="module"')
    expect(head).not.toContain('Stryker was here')
  })
})

describe('publishPageRendered — exact link/script tags (kills lines 187, 200)', () => {
  it('emits the EXACT stylesheet link tag pointing at the hashed CSS file (kills line 187)', async () => {
    // Line 187: pageCssLink = `<link rel="stylesheet" href="/${cssPath}">`.
    // StringLiteral mutation replaces the template literal with `` `` `` —
    // pageCssLink becomes ''. Head then has no <link> tag at all, even
    // though a styles.*.css file gets written (line 185 still runs).
    //
    // Asserting a regex-exact match of the tag pattern catches this —
    // .toContain('.css') would pass because the sidecar filename
    // (`styles.<hash>.css` mirrored in `.<hash>.hash`) still appears in
    // the target dir listing.
    await writeTestFile(
      sourceDir,
      'pages/css-tag/page.json',
      JSON.stringify({
        template: 'page-mut',
        components: [{ name: 'a', template: 'echo-full', content: { text: 'x' } }],
      }),
    )
    const source = createFilesystemProvider(sourceDir)
    const site = await loadTestSite()
    const target = createFilesystemProvider(targetDir)

    await publishPageRendered('css-tag', createContentRoot(source), target, undefined, templatesDir, undefined, site)

    const entries = await target.readDir('pages/css-tag')
    const cssEntry = entries.find(e => /^styles\.[a-f0-9]{8}\.css$/.test(e.name))
    expect(cssEntry, 'must emit a hashed CSS file').toBeDefined()

    const html = await target.readFile('pages/css-tag/index.html')
    // Exact tag string with the actual hashed path. Mutation to empty
    // template literal drops the whole tag.
    const expectedLink = `<link rel="stylesheet" href="/pages/css-tag/${cssEntry!.name}">`
    expect(html).toContain(expectedLink)
  })

  it('emits the EXACT script tag pointing at the hashed JS file (kills line 200)', async () => {
    // Parallel to line 187 for JS: pageJsLink = `<script type="module" src="/${jsPath}"></script>`.
    // Mutation to empty template literal drops the whole tag.
    await writeTestFile(
      sourceDir,
      'pages/js-tag/page.json',
      JSON.stringify({
        template: 'page-mut',
        components: [{ name: 'a', template: 'echo-full', content: { text: 'x' } }],
      }),
    )
    const source = createFilesystemProvider(sourceDir)
    const site = await loadTestSite()
    const target = createFilesystemProvider(targetDir)

    await publishPageRendered('js-tag', createContentRoot(source), target, undefined, templatesDir, undefined, site)

    const entries = await target.readDir('pages/js-tag')
    const jsEntry = entries.find(e => /^script\.[a-f0-9]{8}\.js$/.test(e.name))
    expect(jsEntry, 'must emit a hashed JS file').toBeDefined()

    const html = await target.readFile('pages/js-tag/index.html')
    const expectedScript = `<script type="module" src="/pages/js-tag/${jsEntry!.name}"></script>`
    expect(html).toContain(expectedScript)
  })
})

describe('publishPageRendered — multi-part JS join delimiter (kills line 192)', () => {
  it('joins multiple JS parts with a newline delimiter, not empty string', async () => {
    // Line 192: `const pageJs = localJsParts.join('\n')`. Mutation
    // replaces `'\n'` with `""`. With a single JS part the delimiter is
    // irrelevant; the mutant only shows up with 2+ parts.
    //
    //   Original: localJsParts = [JS_A, JS_B] → pageJs = 'JS_A\nJS_B' (2 lines)
    //   Mutant  : localJsParts = [JS_A, JS_B] → pageJs = 'JS_AJS_B'   (1 line)
    //
    // Asserting split-by-\n length + each line content catches it.
    // Also asserts the content-hash file naming (different bytes = different
    // hash) as a cross-check that the join produced distinct output.
    await writeTestFile(
      sourceDir,
      'pages/multi-js/page.json',
      JSON.stringify({
        template: 'page-empty',
        components: [
          { name: 'a', template: 'echo-js-a' },
          { name: 'b', template: 'echo-js-b' },
        ],
      }),
    )
    const source = createFilesystemProvider(sourceDir)
    const site = await loadTestSite()
    const target = createFilesystemProvider(targetDir)

    await publishPageRendered('multi-js', createContentRoot(source), target, undefined, templatesDir, undefined, site)

    const entries = await target.readDir('pages/multi-js')
    const jsEntry = entries.find(e => /\.js$/.test(e.name))
    expect(jsEntry, 'must emit exactly one JS file').toBeDefined()
    const js = await target.readFile(`pages/multi-js/${jsEntry!.name}`)

    // Exactly 2 lines: JS_A on line 0, JS_B on line 1. Mutation to
    // empty delimiter produces 1 line with both concatenated.
    const lines = js.split('\n')
    expect(lines).toHaveLength(2)
    expect(lines[0]).toBe(JS_A)
    expect(lines[1]).toBe(JS_B)
  })
})
