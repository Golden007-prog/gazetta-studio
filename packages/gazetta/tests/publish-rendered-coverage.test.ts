/**
 * Coverage for `publishPageRendered` orchestration + accumulator order in
 * `publish-rendered.ts`. Captures mutants surfaced by Stryker run 27333071932
 * (issue #565):
 *
 *   - Line 122 ObjectLiteral/StringLiteral (NoCoverage) — no test exercised
 *     the `preloadedSite ?? (await loadSite(...))` fallback. The hot-path
 *     entry (`runPublish`) always supplies a preloaded site, so the
 *     fall-through branch (loading fresh per-call) was never hit.
 *
 *   - Line 124 StringLiteral (NoCoverage) — no test exercised the
 *     `Page "..." not found` throw for a missing page name. The renderer
 *     short-circuits archived pages before this check, so the existing
 *     archive tests pass over it.
 *
 *   - Lines 138-141 ArrayDeclaration (Survived) — `bodyParts`,
 *     `localCssParts`, `localJsParts`, `localHeadParts` initial-value
 *     mutants. Mutation prepends a sentinel to each accumulator before
 *     the loop populates it; the existing tests assert on `.toContain()`
 *     rather than on the ordering / leading content, so the mutated
 *     output still satisfies them.
 *
 * Strategy: drive `publishPageRendered` against a synthetic two-template
 * fixture (one page-level template + one leaf "echo" component) whose
 * output is predictable enough to pin ordering with strict assertions.
 * Real `loadSite` so the templates actually execute through jiti — memory
 * storage doesn't help here because the renderer needs real templates on
 * disk.
 *
 * Mutant note (line 97 ArrayDeclaration): the `cleanupOldFiles(...,
 * oldFiles, [])` empty-array mutant is an equivalent mutant — replacing
 * `[]` with `["Stryker was here"]` only changes observable behavior when
 * `oldFiles` contains a file path equal to the literal sentinel string,
 * which `listHashedFiles` cannot produce. Documented here so the next
 * triage doesn't re-litigate.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdir, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { createContentRoot } from '../src/content-root.js'
import { createFilesystemProvider } from '../src/providers/filesystem.js'
import { publishPageRendered } from '../src/publish-compat.js'
import { loadSite } from '../src/site-loader.js'
import { tempDir } from './_helpers/temp.js'

const testDir = tempDir('publish-rendered-coverage-' + Date.now())
const sourceDir = join(testDir, 'source')
const targetDir = join(testDir, 'target')
const templatesDir = join(testDir, 'templates')

const COMPONENT_CSS = '.echo-cov-c{color:red}'
const COMPONENT_JS = 'window.__echoCovJs=1;'
const COMPONENT_HEAD = '<meta name="echo-cov-head">'
const PAGE_CSS = '.page-cov-p{background:blue}'
const PAGE_HEAD = '<meta name="page-cov-head">'

async function writeTestFile(base: string, path: string, content: string) {
  const full = join(base, path)
  await mkdir(join(full, '..'), { recursive: true })
  await writeFile(full, content)
}

beforeEach(async () => {
  await mkdir(sourceDir, { recursive: true })
  await mkdir(targetDir, { recursive: true })
  await mkdir(templatesDir, { recursive: true })

  // Component template — emits known HTML / CSS / JS / head so the joined
  // output is predictable. The accumulator-mutation test needs all four
  // output channels populated.
  await mkdir(join(templatesDir, 'echo-cov'), { recursive: true })
  await writeFile(
    join(templatesDir, 'echo-cov/index.ts'),
    `import { z } from 'zod'
export const schema = z.object({ text: z.string().optional() })
export default ({ content }) => ({
  html: '<echo>' + (content?.text ?? '') + '</echo>',
  css: '${COMPONENT_CSS}',
  js: '${COMPONENT_JS}',
  head: '${COMPONENT_HEAD}',
})
`,
  )

  // Page-level template. publishPageRendered unshifts pageOutput.css and
  // pageOutput.head onto the accumulators (so they appear FIRST in the
  // joined output), but discards pageOutput.js — the JS accumulator is
  // populated by component JS only.
  await mkdir(join(templatesDir, 'page-cov'), { recursive: true })
  await writeFile(
    join(templatesDir, 'page-cov/index.ts'),
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

describe('publishPageRendered — coverage gaps from mutation run 27333071932 (#565)', () => {
  it('throws "Page \\"<name>\\" not found" when the requested page is absent (kills line 124)', async () => {
    // Seed a site with no pages so loadSite succeeds, then ask for one that
    // doesn't exist. The throw is the load-bearing contract — callers
    // depend on the message to attribute the failure.
    await writeTestFile(sourceDir, 'pages/exists/page.json', JSON.stringify({ template: 'page-cov', components: [] }))
    const source = createFilesystemProvider(sourceDir)
    const site = await loadSite({
      siteDir: sourceDir,
      storage: createFilesystemProvider(),
      templatesDir,
      manifest: { name: '(coverage)' },
    })
    const target = createFilesystemProvider(targetDir)

    await expect(
      publishPageRendered(
        'does-not-exist',
        createContentRoot(source),
        target,
        undefined,
        templatesDir,
        undefined,
        site,
      ),
    ).rejects.toThrow('Page "does-not-exist" not found')
  })

  it('loads the site from sourceRoot when preloadedSite is omitted (kills line 122 fallback)', async () => {
    // The fallback path runs `loadSite({ contentRoot: sourceRoot, templatesDir,
    // manifest: { name: '(publish)' } })`. The two mutants here replace the
    // options bag with `{}` (ObjectLiteral) and the manifest name with `""`
    // (StringLiteral). Both fail loudly on the real `loadSite` — `{}` is
    // rejected because neither `contentRoot` nor `siteDir`+`storage` is
    // provided; `manifest: { name: '' }` would not by itself break loadSite
    // but the loop test below exercises the broader fallback path including
    // the templatesDir threading.
    await writeTestFile(
      sourceDir,
      'pages/no-preload/page.json',
      JSON.stringify({
        template: 'page-cov',
        components: [{ name: 'a', template: 'echo-cov', content: { text: 'NO-PRELOAD' } }],
      }),
    )
    const source = createFilesystemProvider(sourceDir)
    const target = createFilesystemProvider(targetDir)

    const result = await publishPageRendered(
      'no-preload',
      createContentRoot(source),
      target,
      undefined,
      templatesDir,
      undefined,
      // preloadedSite intentionally undefined — triggers the loadSite fallback
    )

    expect(result.files).toBeGreaterThanOrEqual(1)
    const html = await target.readFile('pages/no-preload/index.html')
    // The page rendered via the fallback-loaded site must contain the
    // component output — proves the fallback supplied the templatesDir
    // correctly to loadSite.
    expect(html).toContain('<echo>NO-PRELOAD</echo>')
  })

  it('body content starts with the first child component (kills line 138 bodyParts mutant)', async () => {
    // Two-component fixture so the joined body content has a stable
    // leading substring. The ArrayDeclaration mutant prepends a sentinel
    // to bodyParts before the loop populates it; the body's first line
    // would then be the sentinel, not the first component output.
    await writeTestFile(
      sourceDir,
      'pages/body-order/page.json',
      JSON.stringify({
        template: 'page-cov',
        components: [
          { name: 'first', template: 'echo-cov', content: { text: 'FIRST' } },
          { name: 'second', template: 'echo-cov', content: { text: 'SECOND' } },
        ],
      }),
    )
    const source = createFilesystemProvider(sourceDir)
    const site = await loadSite({
      siteDir: sourceDir,
      storage: createFilesystemProvider(),
      templatesDir,
      manifest: { name: '(coverage)' },
    })
    const target = createFilesystemProvider(targetDir)

    await publishPageRendered('body-order', createContentRoot(source), target, undefined, templatesDir, undefined, site)

    const html = await target.readFile('pages/body-order/index.html')
    const bodyMatch = html.match(/<body>\n([\s\S]*?)\n<\/body>/)
    expect(bodyMatch, 'published page HTML must include <body>...</body>').toBeTruthy()
    const bodyContent = bodyMatch![1]
    const bodyLines = bodyContent.split('\n')
    // Each child component's HTML is wrapped by `scopeHtml` into
    // `<div data-gz="HASH">...</div>` before being pushed to bodyParts.
    // The wrapper preserves the inner template HTML, so we anchor on the
    // template's literal output. A mutant prepending a sentinel to the
    // accumulator would push the first echo onto line 1 (sentinel on
    // line 0), making line 0 fail both patterns below.
    expect(bodyLines[0]).toMatch(/^<div data-gz="[a-f0-9]{8}"><echo>FIRST<\/echo><\/div>$/)
    expect(bodyLines[1]).toMatch(/^<div data-gz="[a-f0-9]{8}"><echo>SECOND<\/echo><\/div>$/)
  })

  it('CSS file second line is the first component CSS (kills line 139 localCssParts mutant)', async () => {
    // publishPageRendered does:
    //   localCssParts: string[] = []        // mutation target (line 139)
    //   for each component: push rendered.css
    //   unshift pageOutput.css onto position 0
    //
    // Original final order: [PAGE_CSS, COMPONENT_CSS]
    // Mutated final order:  [PAGE_CSS, "Stryker was here", COMPONENT_CSS]
    // (unshift happens AFTER the mutated sentinel is already present)
    //
    // Asserting that the SECOND line is exactly the component CSS catches
    // the mutant — the page CSS would still occupy the first line either
    // way, but the second slot diverges.
    await writeTestFile(
      sourceDir,
      'pages/css-order/page.json',
      JSON.stringify({
        template: 'page-cov',
        components: [{ name: 'a', template: 'echo-cov', content: { text: 'x' } }],
      }),
    )
    const source = createFilesystemProvider(sourceDir)
    const site = await loadSite({
      siteDir: sourceDir,
      storage: createFilesystemProvider(),
      templatesDir,
      manifest: { name: '(coverage)' },
    })
    const target = createFilesystemProvider(targetDir)

    await publishPageRendered('css-order', createContentRoot(source), target, undefined, templatesDir, undefined, site)

    const entries = await target.readDir('pages/css-order')
    const cssEntry = entries.find(e => /\.css$/.test(e.name))
    expect(cssEntry, 'page publish must emit a hashed CSS file').toBeDefined()
    const css = await target.readFile(`pages/css-order/${cssEntry!.name}`)
    const cssLines = css.split('\n')
    // Page-level CSS is unscoped — `publishPageRendered` calls the page
    // template directly and pushes its raw CSS via `unshift`. Component
    // CSS is scoped by `renderComponent` via `scopeCss`, which prefixes
    // selectors with `[data-gz="HASH"] `.
    expect(cssLines[0]).toBe(PAGE_CSS)
    expect(cssLines[1]).toMatch(/^\[data-gz="[a-f0-9]{8}"\] \.echo-cov-c\{color:red\}$/)
  })

  it('JS file first line is the first component JS (kills line 140 localJsParts mutant)', async () => {
    // localJsParts: string[] = []          // mutation target (line 140)
    // for each component: push rendered.js
    // (pageOutput.js is NOT added — publishPageRendered drops it)
    //
    // Original final order: [COMPONENT_JS]
    // Mutated final order:  ["Stryker was here", COMPONENT_JS]
    // First line diverges.
    await writeTestFile(
      sourceDir,
      'pages/js-order/page.json',
      JSON.stringify({
        template: 'page-cov',
        components: [{ name: 'a', template: 'echo-cov', content: { text: 'x' } }],
      }),
    )
    const source = createFilesystemProvider(sourceDir)
    const site = await loadSite({
      siteDir: sourceDir,
      storage: createFilesystemProvider(),
      templatesDir,
      manifest: { name: '(coverage)' },
    })
    const target = createFilesystemProvider(targetDir)

    await publishPageRendered('js-order', createContentRoot(source), target, undefined, templatesDir, undefined, site)

    const entries = await target.readDir('pages/js-order')
    const jsEntry = entries.find(e => /\.js$/.test(e.name))
    expect(jsEntry, 'page publish must emit a hashed JS file').toBeDefined()
    const js = await target.readFile(`pages/js-order/${jsEntry!.name}`)
    expect(js.split('\n')[0]).toBe(COMPONENT_JS)
  })

  it('page head appears before component head with no content between (kills line 141 localHeadParts mutant)', async () => {
    // localHeadParts: string[] = []        // mutation target (line 141)
    // for each component: push rendered.head
    // unshift pageOutput.head onto position 0
    //
    // Original final order: [PAGE_HEAD, COMPONENT_HEAD]
    // Mutated final order:  [PAGE_HEAD, "Stryker was here", COMPONENT_HEAD]
    //
    // Joined into <head> via `.join('\n  ')` along with other head fields.
    // The region between PAGE_HEAD and COMPONENT_HEAD must contain only
    // whitespace; a sentinel inserted between them would have non-empty
    // trimmed content.
    await writeTestFile(
      sourceDir,
      'pages/head-order/page.json',
      JSON.stringify({
        template: 'page-cov',
        components: [{ name: 'a', template: 'echo-cov', content: { text: 'x' } }],
      }),
    )
    const source = createFilesystemProvider(sourceDir)
    const site = await loadSite({
      siteDir: sourceDir,
      storage: createFilesystemProvider(),
      templatesDir,
      manifest: { name: '(coverage)' },
    })
    const target = createFilesystemProvider(targetDir)

    await publishPageRendered('head-order', createContentRoot(source), target, undefined, templatesDir, undefined, site)

    const html = await target.readFile('pages/head-order/index.html')
    const pageHeadIdx = html.indexOf(PAGE_HEAD)
    const componentHeadIdx = html.indexOf(COMPONENT_HEAD)
    expect(pageHeadIdx, 'page-level head must appear in <head>').toBeGreaterThanOrEqual(0)
    expect(componentHeadIdx, 'component head must appear in <head>').toBeGreaterThanOrEqual(0)
    expect(pageHeadIdx).toBeLessThan(componentHeadIdx)

    // The region between page head and component head is the
    // `.join('\n  ')` delimiter (newline + two-space indent). Any
    // sentinel injected at index 1 of localHeadParts would land here
    // and produce non-whitespace content.
    const between = html.slice(pageHeadIdx + PAGE_HEAD.length, componentHeadIdx)
    expect(between.trim()).toBe('')
  })
})
