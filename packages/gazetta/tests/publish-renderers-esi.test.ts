/**
 * `renderPageWithEsi` exact-output tests.
 *
 * The ESI page renderer turns `@fragment` refs into `<!--esi:-->` /
 * `<!--esi-head:-->` placeholders, bakes inline components into the
 * body, collects page-template + component css/js into hashed files,
 * and assembles the head in a fixed order the worker relies on. These
 * tests pin the whole document and the exact `files` list, so an extra
 * empty line, a dropped separator or a reordered head tag fails.
 *
 * Deterministic filesystem templates; component scope ids come from
 * `renderComponent` and are read off the output.
 *
 * Not testable: the `if (rendered.head)` / `if (pageOutput.head)`
 * guards. An empty head pushed into `localHeadParts` is dropped by the
 * head's `.filter(Boolean)` and only adds a newline to `templateHead`,
 * which SEO reads with `.includes`. The guards stay because `head` is
 * `string | undefined` and the arrays are `string[]`.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdir, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import { createFilesystemProvider } from '../src/providers/filesystem.js'
import { renderPageWithEsi } from '../src/publish-renderers.js'
import { loadSite } from '../src/site-loader.js'
import { tempDir } from './_helpers/temp.js'

let testDir: string
let sourceDir: string
let templatesDir: string

async function writeTestFile(base: string, path: string, content: string) {
  const full = join(base, path)
  await mkdir(join(full, '..'), { recursive: true })
  await writeFile(full, content)
}

async function writeTemplate(name: string, out: { html: string; css: string; js: string; head: string }) {
  await writeTestFile(
    templatesDir,
    `${name}/index.ts`,
    `import { z } from 'zod'
export const schema = z.object({})
export default () => (${JSON.stringify(out)})
`,
  )
}

/** Scope id `renderComponent` gave the component whose template emitted `inner`. */
function scopeOf(html: string, inner: string): string {
  const m = html.match(new RegExp(`<div data-gz="([0-9a-f]+)">${inner}</div>`))
  if (!m) throw new Error(`no scoped wrapper around ${inner}`)
  return m[1]!
}

function md5_8(s: string) {
  return createHash('md5').update(s).digest('hex').slice(0, 8)
}

async function loadTestSite(locales?: string[]) {
  return loadSite({
    siteDir: sourceDir,
    storage: createFilesystemProvider(),
    templatesDir,
    manifest: locales
      ? { name: '(esi-renderer)', locales: { default: 'en', supported: locales } }
      : { name: '(esi-renderer)' },
  })
}

let counter = 0
beforeEach(async () => {
  testDir = tempDir(`publish-renderers-esi-${Date.now()}-${counter++}`)
  sourceDir = join(testDir, 'source')
  templatesDir = join(testDir, 'templates')

  await writeTemplate('layout', { html: '<ignored>', css: 'body{}', js: '', head: '<meta name="layout">' })
  await writeTemplate('leaf', { html: '<leaf>', css: '.leaf{}', js: 'leaf()', head: '<meta name="leaf">' })
  await writeTemplate('script', { html: '<script-only>', css: '', js: 'two()', head: '' })
  await writeTemplate('bare', { html: '<bare>', css: '', js: '', head: '' })
  await writeTemplate('plain-layout', { html: '', css: '', js: '', head: '' })
  await writeTestFile(sourceDir, 'fragments/nav/fragment.json', JSON.stringify({ template: 'bare' }))
})

afterEach(async () => {
  await rm(testDir, { recursive: true, force: true })
})

describe('renderPageWithEsi — exact output', () => {
  it('composes body, hashed files, head order and cache comment exactly', async () => {
    await writeTestFile(
      sourceDir,
      'pages/home/page.json',
      JSON.stringify({
        route: '/',
        template: 'layout',
        components: [
          '@nav',
          { name: 'hero', template: 'leaf' },
          { name: 's', template: 'script' },
          { name: 'b', template: 'bare' },
        ],
      }),
    )
    const site = await loadTestSite()

    const out = await renderPageWithEsi('home', { site })

    const leaf = scopeOf(out.indexHtml, '<leaf>')
    const script = scopeOf(out.indexHtml, '<script-only>')
    const bare = scopeOf(out.indexHtml, '<bare>')
    // Page-template css comes before the children's css.
    const css = `body{}\n[data-gz="${leaf}"] .leaf{}`
    // A component with no css adds no css line; js joins in component order.
    const js = 'leaf()\ntwo()'
    const cssPath = `pages/home/styles.${md5_8(css)}.css`
    const jsPath = `pages/home/script.${md5_8(js)}.js`
    expect(out.files).toEqual([
      { path: cssPath, content: css },
      { path: jsPath, content: js },
    ])
    expect(out.indexFile).toBe('index.html')
    expect(out.archived).toBe(false)

    const head = [
      '<meta charset="UTF-8">',
      '<meta name="viewport" content="width=device-width, initial-scale=1.0">',
      '<meta property="og:type" content="website">\n  <meta name="twitter:card" content="summary">',
      '<meta name="layout">',
      '<meta name="leaf">',
      `<link rel="stylesheet" href="/${cssPath}">`,
      '<!--esi-head:/fragments/nav/index.html-->',
      `<script type="module" src="/${jsPath}"></script>`,
    ].join('\n  ')
    expect(out.indexHtml).toBe(
      `<!--cache:browser=0,edge=86400-->
<!DOCTYPE html>
<html lang="en">
<head>
  ${head}
</head>
<body>
<!--esi:/fragments/nav/index.html-->
<div data-gz="${leaf}"><leaf></div>
<div data-gz="${script}"><script-only></div>
<div data-gz="${bare}"><bare></div>
</body>
</html>`,
    )
  })

  it('emits no hashed files and no links when nothing has css/js/head', async () => {
    await writeTestFile(
      sourceDir,
      'pages/plain/page.json',
      JSON.stringify({ route: '/plain', template: 'plain-layout', components: [{ name: 'b', template: 'bare' }] }),
    )
    const site = await loadTestSite()

    const out = await renderPageWithEsi('plain', { site })

    expect(out.files).toEqual([])
    const bare = scopeOf(out.indexHtml, '<bare>')
    const head = [
      '<meta charset="UTF-8">',
      '<meta name="viewport" content="width=device-width, initial-scale=1.0">',
      '<meta property="og:type" content="website">\n  <meta name="twitter:card" content="summary">',
    ].join('\n  ')
    expect(out.indexHtml).toBe(
      `<!--cache:browser=0,edge=86400-->
<!DOCTYPE html>
<html lang="en">
<head>
  ${head}
</head>
<body>
<div data-gz="${bare}"><bare></div>
</body>
</html>`,
    )
  })

  it('locale-suffixes the fragment placeholders and index file; lang follows locale', async () => {
    await writeTestFile(
      sourceDir,
      'pages/home/page.json',
      JSON.stringify({ route: '/', template: 'plain-layout', components: ['@nav'] }),
    )
    const site = await loadTestSite(['en', 'fr'])

    const out = await renderPageWithEsi('home', { site, locale: 'fr' })

    expect(out.indexFile).toBe('index.fr.html')
    expect(out.indexHtml).toContain('<html lang="fr">')
    expect(out.indexHtml).toContain(
      '<meta name="twitter:card" content="summary">\n  <!--esi-head:/fragments/nav/index.fr.html-->\n</head>',
    )
    expect(out.indexHtml).toContain('<body>\n<!--esi:/fragments/nav/index.fr.html-->\n</body>')
  })

  it('seo.locale wins over ctx.locale for <html lang>', async () => {
    await writeTestFile(
      sourceDir,
      'pages/home/page.json',
      JSON.stringify({ route: '/', template: 'plain-layout', components: [] }),
    )
    const site = await loadTestSite(['en', 'fr'])

    const out = await renderPageWithEsi('home', { site, locale: 'fr', seo: { locale: 'fr-CA' } })

    expect(out.indexHtml).toContain('<html lang="fr-CA">')
  })

  it('passes template head to SEO dedup (no duplicate og:type)', async () => {
    await writeTemplate('og-layout', { html: '', css: '', js: '', head: '<meta property="og:type" content="article">' })
    await writeTestFile(
      sourceDir,
      'pages/home/page.json',
      JSON.stringify({ route: '/', template: 'og-layout', components: [] }),
    )
    const site = await loadTestSite()

    const out = await renderPageWithEsi('home', { site })

    expect(out.indexHtml.match(/property="og:type"/g)).toHaveLength(1)
    expect(out.indexHtml).toContain('content="article"')
  })

  it('cache comment: target config used when page sets none; page wins over target', async () => {
    await writeTestFile(
      sourceDir,
      'pages/a/page.json',
      JSON.stringify({ route: '/a', template: 'plain-layout', components: [] }),
    )
    await writeTestFile(
      sourceDir,
      'pages/b/page.json',
      JSON.stringify({ route: '/b', template: 'plain-layout', components: [], cache: { browser: 5, edge: 7 } }),
    )
    const site = await loadTestSite()
    const targetCache = { browser: 60, edge: 120 }

    const a = await renderPageWithEsi('a', { site, targetCache })
    const b = await renderPageWithEsi('b', { site, targetCache })

    expect(a.indexHtml.startsWith('<!--cache:browser=60,edge=120-->\n<!DOCTYPE html>')).toBe(true)
    expect(b.indexHtml.startsWith('<!--cache:browser=5,edge=7-->\n<!DOCTYPE html>')).toBe(true)
  })

  it('throws with the page name when the page is missing or archived', async () => {
    await writeTestFile(
      sourceDir,
      'pages/gone/page.json',
      JSON.stringify({ route: '/gone', archived: true, components: [] }),
    )
    const site = await loadTestSite()

    await expect(renderPageWithEsi('nope', { site })).rejects.toThrow('Page "nope" not found')
    await expect(renderPageWithEsi('gone', { site })).rejects.toThrow(
      'Page "gone" is archived; use renderArchiveMarker instead',
    )
  })
})
