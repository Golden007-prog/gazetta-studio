/**
 * Write routes that take a new item name (create, rename, redirect) must
 * refuse names that would leave the target folder: the name becomes a
 * folder path. Runs through createAdminApp on a filesystem target so a
 * write outside the target folder would land on disk.
 */
import { afterEach, describe, expect, it } from 'vitest'
import { mkdir, readdir, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { createAdminApp } from '../src/admin-api/index.js'
import { createSourceContext } from '../src/admin-api/source-context.js'
import { createFilesystemProvider } from '../src/providers/filesystem.js'
import { starterTemplatesDir } from './_helpers/starter.js'
import { tempDir } from './_helpers/temp.js'

const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

async function buildApp() {
  const root = tempDir(`item-name-validation-${Date.now()}-${Math.random().toString(36).slice(2)}`)
  roots.push(root)
  const target = join(root, 'targets', 'local')
  await mkdir(join(target, 'pages', 'home'), { recursive: true })
  await mkdir(join(target, 'fragments', 'header'), { recursive: true })
  await writeFile(
    join(target, 'pages', 'home', 'page.json'),
    JSON.stringify({ template: 'page-default', components: [] }),
  )
  await writeFile(
    join(target, 'fragments', 'header', 'fragment.json'),
    JSON.stringify({ template: 'header-layout', components: [] }),
  )
  const storage = createFilesystemProvider(target)
  const targetConfigs = { local: { storage, type: 'esi' as const, environment: 'local' as const, editable: true } }
  const source = createSourceContext({
    storage,
    siteDir: '',
    projectSiteDir: '/test-project',
    manifest: { name: 'test-site', targets: targetConfigs },
  })
  const app = createAdminApp({
    source,
    siteDir: '/test-project',
    templatesDir: starterTemplatesDir,
    targets: new Map([['local', storage]]),
    targetConfigs,
    disableCacheStatsLogger: true,
  })
  return { app, root, target }
}

/** Every file under `root` that isn't inside the target folder. */
async function filesOutside(root: string, target: string): Promise<string[]> {
  const found: string[] = []
  async function walk(dir: string) {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name)
      if (full === target) continue
      if (entry.isDirectory()) await walk(full)
      else found.push(full.slice(root.length + 1))
    }
  }
  await walk(root)
  return found
}

const post = (body: unknown) => ({
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(body),
})

describe('item names on write routes', { timeout: 30000 }, () => {
  it.each([
    ['POST /api/pages', '/api/pages', { name: '../../escaped', template: 'page-default' }],
    ['POST /api/fragments', '/api/fragments', { name: '../../escaped', template: 'header-layout' }],
    ['page rename', '/api/pages/home/rename', { to: '../../escaped', keepAlias: false }],
    ['fragment rename', '/api/fragments/header/rename', { to: '../../escaped', keepAlias: false }],
    ['page redirect from', '/api/page-redirects', { from: '../../escaped', to: 'home' }],
    ['page redirect to', '/api/page-redirects', { from: 'old', to: '../../escaped' }],
    ['fragment redirect from', '/api/fragment-redirects', { from: '../../escaped', to: 'header' }],
  ])('%s refuses a name with .. and writes nothing outside the target', async (_label, path, body) => {
    const { app, root, target } = await buildApp()

    const res = await app.request(path, post(body))

    expect(res.status).toBe(400)
    expect(await filesOutside(root, target)).toEqual([])
  })

  it('still creates nested pages', async () => {
    const { app } = await buildApp()

    const res = await app.request('/api/pages', post({ name: 'blog/post', template: 'page-default' }))

    expect(res.status).toBe(200)
  })
})
