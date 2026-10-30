import { randomUUID } from 'node:crypto'
import { mkdir, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createMemoryCache } from '../src/cache/memory.js'
import { createContentRoot } from '../src/content-root.js'
import { renderPageForAnalysis } from '../src/render-for-analysis.js'
import { loadSite } from '../src/site-loader.js'
import { invalidateAllTemplates, invalidateTemplate } from '../src/template-loader.js'
import { memoryStorage } from './_helpers/memory-storage.js'
import { tempDir } from './_helpers/temp.js'

let testDir: string
let templatesDir: string

async function writeTemplate(name: string, marker = '') {
  const dir = join(templatesDir, name)
  await mkdir(dir, { recursive: true })
  await writeFile(
    join(dir, 'index.ts'),
    `export const schema = {}
export default ({ children = [] }) => ({
  html: ${JSON.stringify(marker)} + children.map(child => child.html).join(''),
  css: '',
  js: '',
})
`,
  )
}

beforeEach(async () => {
  invalidateAllTemplates()
  testDir = tempDir(`render-analysis-translated-templates-${randomUUID()}`)
  templatesDir = join(testDir, 'templates')
  await writeTemplate('layout')
  await writeTemplate('default-copy', 'default-language-copy')
  await writeTemplate('translated-only', 'before-template-change')
})

afterEach(async () => {
  invalidateAllTemplates()
  await rm(testDir, { recursive: true, force: true })
})

describe('translated template changes in render-for-analysis', () => {
  it.each([
    { kind: 'page', nested: false },
    { kind: 'page', nested: true },
    { kind: 'fragment', nested: false },
    { kind: 'fragment', nested: true },
  ])('invalidates the cached HTML for a translated $kind template (nested=$nested)', async ({ kind, nested }) => {
    const storage = memoryStorage()
    const defaultManifest = {
      template: 'layout',
      components: [{ name: 'copy', template: 'default-copy' }],
    }
    const translatedManifest = nested
      ? {
          template: 'layout',
          components: [
            {
              name: 'wrapper',
              template: 'layout',
              components: [{ name: 'copy', template: 'translated-only' }],
            },
          ],
        }
      : { template: 'translated-only' }
    storage.seed({
      'pages/home/page.json': JSON.stringify({
        ...defaultManifest,
        route: '/',
        ...(kind === 'fragment' ? { components: ['@message'] } : {}),
      }),
      ...(kind === 'page'
        ? { 'pages/home/page.fr.json': JSON.stringify({ ...translatedManifest, route: '/' }) }
        : {
            'fragments/message/fragment.json': JSON.stringify(defaultManifest),
            'fragments/message/fragment.fr.json': JSON.stringify(translatedManifest),
          }),
    })
    const site = await loadSite({
      contentRoot: createContentRoot(storage, ''),
      templatesDir,
      manifest: { name: 'translated-template-cache', locales: { default: 'en', supported: ['en', 'fr'] } },
    })
    const cache = createMemoryCache()
    const options = { site, cache, templatesDir, locale: 'fr' }
    const before = await renderPageForAnalysis('home', options)
    expect(before?.html).toContain('before-template-change')

    await writeTemplate('translated-only', 'after-template-change')
    // The file watcher invalidates the loaded template; retain the analysis cache.
    invalidateTemplate('translated-only')
    const after = await renderPageForAnalysis('home', options)

    expect(after?.html).toContain('after-template-change')
    expect(after?.html).not.toContain('before-template-change')
    expect(await cache.stats?.()).toMatchObject({ misses: 2, hits: 0 })
  })
})
