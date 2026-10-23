/**
 * #1196: route-boundary item validation. Before the fix, `POST
 * /api/publish`, `/api/publish/stream` and `/api/fetch` built storage
 * paths straight from request item strings, so an item like
 * `pages/../../secret` copied a folder outside the site onto a path
 * outside the target. The routes now parse every item (known folder
 * prefixes get locale validation via `isValidLocale` and an existence
 * check; asset-style names get the same segment rules), answering 400
 * for a leading `/`, a backslash, an empty/`.`/`..` segment, or an
 * invalid locale, before anything is read or written.
 *
 * Verified fail-unfixed before commit: the three traversal tests fail
 * against the unpatched route - `/api/publish` and `/api/publish/stream`
 * answer 207 and copy `<root>/secret/` outside the target, `/api/fetch`
 * answers 200 and copies it into the destination.
 *
 * Fixtures are real filesystem trees in a temp folder with synthetic
 * content only.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Hono } from 'hono'
import { createAdminApp } from '../src/admin-api/index.js'
import { createSourceContext } from '../src/admin-api/source-context.js'
import { createFilesystemProvider } from '../src/providers/filesystem.js'
import { starterTemplatesDir } from './_helpers/starter.js'

let root: string
let app: Hono

const PAGE = JSON.stringify({ template: 'page-default', content: {} })

beforeEach(async () => {
  root = await mkdtemp('.tmp-item-validation-')
  // Source site at <root>/site; the "outside" folder is a sibling.
  await mkdir(join(root, 'site', 'pages', 'home'), { recursive: true })
  await writeFile(join(root, 'site', 'pages', 'home', 'page.json'), PAGE)
  await mkdir(join(root, 'site', 'pages', 'about'), { recursive: true })
  await writeFile(join(root, 'site', 'pages', 'about', 'page.json'), PAGE)
  await writeFile(join(root, 'site', 'pages', 'about', 'page.fr.json'), PAGE)
  await mkdir(join(root, 'site', 'pages', 'blog', '[slug]'), { recursive: true })
  await writeFile(join(root, 'site', 'pages', 'blog', '[slug]', 'page.json'), PAGE)
  await mkdir(join(root, 'site', 'fragments', 'footer'), { recursive: true })
  await writeFile(
    join(root, 'site', 'fragments', 'footer', 'fragment.json'),
    JSON.stringify({ template: 'footer-layout', content: {} }),
  )
  await mkdir(join(root, 'secret'), { recursive: true })
  await writeFile(join(root, 'secret', 'credentials.txt'), 'SYNTHETIC FIXTURE - NOT A REAL SECRET')
  await mkdir(join(root, 'x', 'y', 'target'), { recursive: true })

  const sourceStorage = createFilesystemProvider(join(root, 'site'))
  const targetStorage = createFilesystemProvider(join(root, 'x', 'y', 'target'))
  const targetConfig = { storage: targetStorage, type: 'esi' as const, environment: 'staging' as const }
  const localConfig = {
    storage: sourceStorage,
    type: 'esi' as const,
    environment: 'local' as const,
    editable: true,
  }
  const source = createSourceContext({
    storage: sourceStorage,
    siteDir: '',
    projectSiteDir: join(root, 'site'),
    manifest: { name: 'test-site', targets: { local: localConfig, staging: targetConfig } },
  })
  app = createAdminApp({
    source,
    siteDir: join(root, 'site'),
    templatesDir: starterTemplatesDir,
    targets: new Map([
      ['local', sourceStorage],
      ['staging', targetStorage],
    ]),
    targetConfigs: { local: localConfig, staging: targetConfig },
    disableCacheStatsLogger: true,
  })
})

afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

function postPublish(items: string[], stream = false) {
  return app.request(stream ? '/api/publish/stream' : '/api/publish', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ items, targets: ['staging'] }),
  })
}

describe('item path validation at the publish/fetch route boundary (#1196)', () => {
  it('/api/publish answers 400 for an item with a .. segment and copies nothing', async () => {
    const res = await postPublish(['pages/../../secret'])

    expect(res.status).toBe(400)
    expect(existsSync(join(root, 'x', 'y', 'secret'))).toBe(false)
    expect(existsSync(join(root, 'x', 'y', 'target', 'pages'))).toBe(false)
  })

  it('/api/publish/stream answers 400 for an item with a .. segment and copies nothing', async () => {
    const res = await postPublish(['pages/../../secret'], true)

    expect(res.status).toBe(400)
    expect(existsSync(join(root, 'x', 'y', 'secret'))).toBe(false)
    expect(existsSync(join(root, 'x', 'y', 'target', 'pages'))).toBe(false)
  })

  it('/api/fetch answers 400 for an item with a .. segment and copies nothing', async () => {
    // Without validation the fetch copies <root>/x/y/stolen into <root>/stolen (site/pages/../.. = root).
    mkdirSync(join(root, 'x', 'y', 'stolen'), { recursive: true })
    writeFileSync(join(root, 'x', 'y', 'stolen', 'credentials.txt'), 'SYNTHETIC FIXTURE - NOT A REAL SECRET')
    const res = await app.request('/api/fetch', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ source: 'staging', items: ['pages/../../stolen'] }),
    })

    expect(res.status).toBe(400)
    expect(existsSync(join(root, 'stolen', 'credentials.txt'))).toBe(false)
    expect(existsSync(join(root, 'x', 'y', 'stolen', 'credentials.txt'))).toBe(true)
  })

  it('answers 400 for an empty name, a dot segment, a leading slash, a backslash, and an invalid locale', async () => {
    for (const item of ['pages/', 'pages/./home', '/pages/home', 'pages\\home', 'pages/about:fr-x']) {
      const res = await postPublish([item])
      expect(res.status, item).toBe(400)
    }
  })

  it('answers 400 for a known-prefix item missing on the source', async () => {
    const res = await postPublish(['pages/nope'])

    expect(res.status).toBe(400)
  })

  it('still publishes valid items, including a locale variant and a nested dynamic page', async () => {
    let res = await postPublish(['pages/home'])
    expect(res.status).toBeLessThan(300)
    expect(existsSync(join(root, 'x', 'y', 'target', 'pages', 'home', 'page.json'))).toBe(true)

    res = await postPublish(['pages/about:fr'])
    expect(res.status).toBeLessThan(300)
    expect(existsSync(join(root, 'x', 'y', 'target', 'pages', 'about', 'page.fr.json'))).toBe(true)

    res = await postPublish(['pages/blog/[slug]'])
    expect(res.status).toBeLessThan(300)
    expect(existsSync(join(root, 'x', 'y', 'target', 'pages', 'blog', '[slug]', 'page.json'))).toBe(true)

    res = await postPublish(['fragments/footer'])
    expect(res.status).toBeLessThan(300)
    expect(existsSync(join(root, 'x', 'y', 'target', 'fragments', 'footer', 'fragment.json'))).toBe(true)
  })
})
