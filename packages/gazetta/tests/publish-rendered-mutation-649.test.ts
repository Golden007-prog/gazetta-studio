/**
 * Coverage for `publishPageRendered` fragment-vs-local dispatch + accumulator
 * conditionals + language resolution in `publish-rendered.ts`. Captures mutants
 * surfaced by Stryker run 29308953418 (issue #649):
 *
 *   - Line 142 ArrayDeclaration (Survived) — `esiHeadTags: string[] = []`
 *     initial-value mutant. Prepending a sentinel leaks a bogus ESI head
 *     marker into the rendered <head> even when the page has no fragments.
 *   - Line 150 StringLiteral (NoCoverage) — the locale-suffixed fragment path
 *     `` `index.${locale}.html` `` was never exercised because no test
 *     combined a fragment reference with a locale.
 *   - Line 152 StringLiteral (Survived) — the ESI head marker template
 *     `` `<!--esi-head:/${fragPath}-->` ``. Any string mutation (empty
 *     string, altered prefix) slips a wrong marker into <head> that a
 *     `.toContain()`-style assertion would miss.
 *   - Line 157 ConditionalExpression (Survived) — `if (rendered.css)` →
 *     `true`. Forcing always-push means empty-CSS components inject blank
 *     entries into `localCssParts`, adding phantom newlines when joined.
 *   - Line 158 ConditionalExpression (Survived) — same shape for
 *     `if (rendered.js)`.
 *   - Line 164 ConditionalExpression (Survived) — `lang` fallback chain
 *     `seo?.locale || locale || 'en'`. Kills mutations that short-circuit
 *     a specific operand in the chain (proving each source has an
 *     independent effect).
 *
 * Mutants at lines 97 (cleanupOldFiles empty-array) and 146
 * (`startsWith('@')`) are equivalent and not tested here:
 *   - Line 97 is documented in `publish-rendered-coverage.test.ts` — the
 *     mutation only changes behavior for file paths equal to the literal
 *     sentinel, which `listHashedFiles` cannot produce.
 *   - Line 146 fires on non-`@`-prefixed string components, but
 *     `resolveComponent` in `resolver.ts:76` throws on those before the
 *     loop runs, so the check can never observe such an entry.
 *
 * Strategy: real filesystem templates so jiti loads them normally. Two
 * component templates — "echo-full" emits CSS/JS/head, "echo-bare" emits
 * none — plus a page-level template. A "nav" fragment is seeded so
 * `publishPageRendered`'s ESI branch executes with a real fragment ref.
 * Deterministic template output lets assertions pin exact head content
 * and CSS/JS ordering.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdir, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { createContentRoot } from '../src/content-root.js'
import { createFilesystemProvider } from '../src/providers/filesystem.js'
import { publishPageRendered } from '../src/publish-compat.js'
import { loadSite } from '../src/site-loader.js'
import { tempDir } from './_helpers/temp.js'

const testDir = tempDir('publish-rendered-mutation-649-' + Date.now())
const sourceDir = join(testDir, 'source')
const targetDir = join(testDir, 'target')
const templatesDir = join(testDir, 'templates')

const FULL_CSS = '.echo-full-c{color:red}'
const FULL_JS = 'window.__echoFullJs=1;'
const FULL_HEAD = '<meta name="echo-full-head">'
const PAGE_CSS = '.page-mut-p{background:blue}'
const PAGE_HEAD = '<meta name="page-mut-head">'

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
    manifest: { name: '(mutation-649)' },
  })
}

beforeEach(async () => {
  await mkdir(sourceDir, { recursive: true })
  await mkdir(targetDir, { recursive: true })
  await mkdir(templatesDir, { recursive: true })

  // Emits all four render channels (html, css, js, head). Used to prove
  // the always-push mutants (lines 157/158) DON'T fire when the guard is
  // truthy — those mutants force the push even when it shouldn't happen.
  await mkdir(join(templatesDir, 'echo-full'), { recursive: true })
  await writeFile(
    join(templatesDir, 'echo-full/index.ts'),
    `import { z } from 'zod'
export const schema = z.object({ text: z.string().optional() })
export default ({ content }) => ({
  html: '<full>' + (content?.text ?? '') + '</full>',
  css: '${FULL_CSS}',
  js: '${FULL_JS}',
  head: '${FULL_HEAD}',
})
`,
  )

  // Emits ONLY html — css/js/head are empty strings. Used to exercise the
  // false branch of the `if (rendered.css)` / `if (rendered.js)` guards.
  // A mutant that forces `true` pushes the empty string into the
  // accumulator, which then produces a phantom newline when joined.
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

  // Page-level template. Contributes PAGE_CSS + PAGE_HEAD (no JS —
  // publishPageRendered discards pageOutput.js).
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

  // Fragment used by the ESI-branch tests. Content doesn't matter — the
  // ESI branch never renders the fragment; it emits a placeholder that
  // the worker resolves at request time. But a valid fragment.json must
  // exist in the site or loadSite rejects unknown @-refs.
  await mkdir(join(templatesDir, 'nav-tpl'), { recursive: true })
  await writeFile(
    join(templatesDir, 'nav-tpl/index.ts'),
    `import { z } from 'zod'
export const schema = z.object({})
export default () => ({ html: '<nav>x</nav>', css: '', js: '' })
`,
  )
  await writeTestFile(sourceDir, 'fragments/nav/fragment.json', JSON.stringify({ template: 'nav-tpl' }))
})

afterEach(async () => {
  await rm(testDir, { recursive: true, force: true })
})

describe('publishPageRendered — ESI branch (kills lines 142, 150, 152)', () => {
  it('emits exact ESI head marker for each fragment ref (kills line 152 string template)', async () => {
    // Line 152: `esiHeadTags.push(\`<!--esi-head:/${fragPath}-->\`)`. Any
    // mutation to the template (empty string, changed prefix, altered path
    // interpolation) produces a marker the worker can't parse. Assert the
    // exact byte-for-byte marker appears in the head.
    await writeTestFile(
      sourceDir,
      'pages/with-frag/page.json',
      JSON.stringify({ template: 'page-mut', components: ['@nav'] }),
    )
    const source = createFilesystemProvider(sourceDir)
    const site = await loadTestSite()
    const target = createFilesystemProvider(targetDir)

    await publishPageRendered('with-frag', createContentRoot(source), target, undefined, templatesDir, undefined, site)

    const html = await target.readFile('pages/with-frag/index.html')
    // The head between `<head>` and `</head>` is what we care about.
    const headMatch = html.match(/<head>([\s\S]*?)<\/head>/)
    expect(headMatch, 'must have a <head> section').toBeTruthy()
    const head = headMatch![1]

    // Exact string. Any mutation (empty, altered prefix, changed path) breaks.
    expect(head).toContain('<!--esi-head:/fragments/nav/index.html-->')

    // The body must have the ESI body placeholder — same fragPath.
    expect(html).toContain('<!--esi:/fragments/nav/index.html-->')
  })

  it('uses locale-suffixed fragment path when locale is set (kills line 150 NoCoverage)', async () => {
    // Line 150: `const fragFile = locale ? \`index.${locale}.html\` : 'index.html'`.
    // The locale-suffix branch had no prior test — locale-having tests didn't
    // include fragment refs, and fragment-having tests didn't pass a locale.
    // This test crosses both to exercise the branch.
    await writeTestFile(
      sourceDir,
      'pages/with-frag-locale/page.json',
      JSON.stringify({ template: 'page-mut', components: ['@nav'] }),
    )
    const source = createFilesystemProvider(sourceDir)
    const site = await loadTestSite()
    const target = createFilesystemProvider(targetDir)

    await publishPageRendered(
      'with-frag-locale',
      createContentRoot(source),
      target,
      undefined,
      templatesDir,
      undefined,
      site,
      undefined,
      'fr',
    )

    const html = await target.readFile('pages/with-frag-locale/index.fr.html')
    expect(html).toContain('<!--esi-head:/fragments/nav/index.fr.html-->')
    expect(html).toContain('<!--esi:/fragments/nav/index.fr.html-->')
    // Non-locale path must NOT appear — proves the branch selected the
    // locale-suffixed variant and not the default.
    expect(html).not.toContain('<!--esi-head:/fragments/nav/index.html-->')
  })

  it('emits NO ESI head markers when page has no fragments (kills line 142 accumulator init)', async () => {
    // Line 142: `const esiHeadTags: string[] = []`. Mutant prepends a
    // sentinel. If the accumulator starts with `["Stryker was here"]`, that
    // string bleeds into the rendered <head> even for pages that never
    // reference a fragment. Assert the head has NO ESI head marker AND
    // no bogus content.
    await writeTestFile(
      sourceDir,
      'pages/no-frag/page.json',
      JSON.stringify({
        template: 'page-mut',
        components: [{ name: 'a', template: 'echo-full', content: { text: 'x' } }],
      }),
    )
    const source = createFilesystemProvider(sourceDir)
    const site = await loadTestSite()
    const target = createFilesystemProvider(targetDir)

    await publishPageRendered('no-frag', createContentRoot(source), target, undefined, templatesDir, undefined, site)

    const html = await target.readFile('pages/no-frag/index.html')
    const headMatch = html.match(/<head>([\s\S]*?)<\/head>/)
    expect(headMatch).toBeTruthy()
    const head = headMatch![1]

    // No ESI head markers at all — the accumulator was never pushed to.
    expect(head).not.toContain('<!--esi-head:')
    // A sentinel-mutation would leak the sentinel string here.
    expect(head).not.toContain('Stryker was here')
  })
})

describe('publishPageRendered — accumulator guards (kills lines 157, 158)', () => {
  it('does NOT push empty CSS into the accumulator (kills line 157 `if (rendered.css)` → true)', async () => {
    // Line 157: `if (rendered.css) localCssParts.push(rendered.css)`. The
    // mutant forces `true` — pushes even when `rendered.css === ''`. Empty
    // strings joined with '\n' produce phantom newlines.
    //
    // Setup: two components — echo-bare (no CSS) first, echo-full second.
    //   Original array after loop: ['scoped-full-css']
    //   Mutant array after loop:   ['', 'scoped-full-css']
    //   After `unshift(PAGE_CSS)`:
    //     Original: [PAGE_CSS, 'scoped-full-css']            → 2 lines
    //     Mutant:   [PAGE_CSS, '', 'scoped-full-css']        → 3 lines (blank in middle)
    //
    // Asserting exact line count catches the phantom blank.
    await writeTestFile(
      sourceDir,
      'pages/css-guard/page.json',
      JSON.stringify({
        template: 'page-mut',
        components: [
          { name: 'bare', template: 'echo-bare', content: { text: 'x' } },
          { name: 'full', template: 'echo-full', content: { text: 'y' } },
        ],
      }),
    )
    const source = createFilesystemProvider(sourceDir)
    const site = await loadTestSite()
    const target = createFilesystemProvider(targetDir)

    await publishPageRendered('css-guard', createContentRoot(source), target, undefined, templatesDir, undefined, site)

    const entries = await target.readDir('pages/css-guard')
    const cssEntry = entries.find(e => /\.css$/.test(e.name))
    expect(cssEntry, 'page must emit a hashed CSS file').toBeDefined()
    const css = await target.readFile(`pages/css-guard/${cssEntry!.name}`)
    const lines = css.split('\n')

    // Exactly 2 lines: page-level CSS (line 0), scoped echo-full CSS (line 1).
    // A mutant that pushes the bare component's '' produces 3 lines with a
    // blank slot between page CSS and scoped CSS.
    expect(lines).toHaveLength(2)
    expect(lines[0]).toBe(PAGE_CSS)
    expect(lines[1]).toMatch(/^\[data-gz="[a-f0-9]{8}"\] \.echo-full-c\{color:red\}$/)
    // Defense-in-depth: no empty line anywhere in the CSS output.
    expect(lines.every(l => l.length > 0)).toBe(true)
  })

  it('does NOT push empty JS into the accumulator (kills line 158 `if (rendered.js)` → true)', async () => {
    // Line 158: same shape as 157 for JS. `publishPageRendered` does NOT
    // unshift page-level JS (page template's `js` field is discarded), so
    // the accumulator only ever holds component JS.
    //   Original array after loop: [FULL_JS]                  → 1 line
    //   Mutant array after loop:   ['', FULL_JS]              → 2 lines (leading blank)
    await writeTestFile(
      sourceDir,
      'pages/js-guard/page.json',
      JSON.stringify({
        template: 'page-mut',
        components: [
          { name: 'bare', template: 'echo-bare', content: { text: 'x' } },
          { name: 'full', template: 'echo-full', content: { text: 'y' } },
        ],
      }),
    )
    const source = createFilesystemProvider(sourceDir)
    const site = await loadTestSite()
    const target = createFilesystemProvider(targetDir)

    await publishPageRendered('js-guard', createContentRoot(source), target, undefined, templatesDir, undefined, site)

    const entries = await target.readDir('pages/js-guard')
    const jsEntry = entries.find(e => /\.js$/.test(e.name))
    expect(jsEntry, 'page must emit a hashed JS file').toBeDefined()
    const js = await target.readFile(`pages/js-guard/${jsEntry!.name}`)
    const lines = js.split('\n')

    // Exactly 1 line — only the full component contributed JS.
    expect(lines).toHaveLength(1)
    expect(lines[0]).toBe(FULL_JS)
  })
})

describe('publishPageRendered — lang resolution (kills line 164)', () => {
  // Line 164: `const lang = seo?.locale || locale || 'en'`. The mutant
  // forces one operand along the chain, producing a wrong value. Three
  // tests exercise each source independently — asserting `<html lang="X">`
  // pins the resolved value.

  it('uses seo.locale when both seo.locale and locale are set (seo wins)', async () => {
    await writeTestFile(
      sourceDir,
      'pages/lang-seo/page.json',
      JSON.stringify({
        template: 'page-mut',
        components: [{ name: 'a', template: 'echo-full', content: { text: 'x' } }],
      }),
    )
    const source = createFilesystemProvider(sourceDir)
    const site = await loadTestSite()
    const target = createFilesystemProvider(targetDir)

    await publishPageRendered(
      'lang-seo',
      createContentRoot(source),
      target,
      undefined,
      templatesDir,
      undefined,
      site,
      { locale: 'de' }, // seo.locale set
      'fr', // locale set — should be shadowed by seo.locale
    )

    // Locale suffix used for filename; but lang inside HTML uses seo.locale.
    const html = await target.readFile('pages/lang-seo/index.fr.html')
    expect(html).toContain('<html lang="de">')
    // Sanity — the wrong lang must NOT appear.
    expect(html).not.toContain('<html lang="fr">')
    expect(html).not.toContain('<html lang="en">')
  })

  it('falls back to the render-time locale when seo.locale is absent', async () => {
    await writeTestFile(
      sourceDir,
      'pages/lang-locale/page.json',
      JSON.stringify({
        template: 'page-mut',
        components: [{ name: 'a', template: 'echo-full', content: { text: 'x' } }],
      }),
    )
    const source = createFilesystemProvider(sourceDir)
    const site = await loadTestSite()
    const target = createFilesystemProvider(targetDir)

    await publishPageRendered(
      'lang-locale',
      createContentRoot(source),
      target,
      undefined,
      templatesDir,
      undefined,
      site,
      {}, // seo present but no locale
      'fr', // locale should be picked
    )

    const html = await target.readFile('pages/lang-locale/index.fr.html')
    expect(html).toContain('<html lang="fr">')
    expect(html).not.toContain('<html lang="en">')
  })

  it('falls back to "en" when neither seo.locale nor locale is set', async () => {
    await writeTestFile(
      sourceDir,
      'pages/lang-default/page.json',
      JSON.stringify({
        template: 'page-mut',
        components: [{ name: 'a', template: 'echo-full', content: { text: 'x' } }],
      }),
    )
    const source = createFilesystemProvider(sourceDir)
    const site = await loadTestSite()
    const target = createFilesystemProvider(targetDir)

    await publishPageRendered(
      'lang-default',
      createContentRoot(source),
      target,
      undefined,
      templatesDir,
      undefined,
      site,
      // no seo, no locale
    )

    const html = await target.readFile('pages/lang-default/index.html')
    expect(html).toContain('<html lang="en">')
  })
})
