/**
 * #1125: every publish writes a value unique to that publish to
 * `.gazetta/publish-generation` on the target, after the content and
 * site files and before the cache purge, in both publish paths, and
 * whether or not `cache.purge` is configured. The Cloudflare worker
 * keys its edge cache on it (worker-generation.test.ts).
 *
 * Verified fail-unfixed before commit: the admin-route and CLI
 * assertions fail on main, which writes no generation at all.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdir, mkdtemp, readFile, rm, writeFile, cp } from 'node:fs/promises'
import { join, resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawn } from 'node:child_process'
import type { Hono } from 'hono'
import { createAdminApp } from '../src/admin-api/index.js'
import { createSourceContext } from '../src/admin-api/source-context.js'
import { createFilesystemProvider } from '../src/providers/filesystem.js'
import type { StorageProvider } from '../src/types.js'
import { starterTemplatesDir } from './_helpers/starter.js'

const purgeCalls: string[] = []

vi.mock('../src/publish-rendered.js', async importOriginal => {
  const original = await importOriginal<typeof import('../src/publish-rendered.js')>()
  return {
    ...original,
    createCloudflarePurge: () => ({
      purgeAll: async () => {
        purgeCalls.push('purgeAll')
      },
      purgeUrls: async (urls: string[]) => {
        purgeCalls.push(`purgeUrls:${urls.length}`)
      },
    }),
  }
})

function recordingStorage(inner: StorageProvider, log: string[]): StorageProvider {
  const writeFileBound = inner.writeFile.bind(inner)
  return {
    ...inner,
    writeFile: async (path: string, content: string) => {
      log.push(path)
      return writeFileBound(path, content)
    },
  } as StorageProvider
}

// In-process publishes that render the starter's templates. Alone they take
// about 0.5 s; in a loaded CI shard (CLI tests spawning processes, \`npm
// install\` in cli-init) 1.5-2.5 s locally and over 5 s on CI runners,
// past Vitest's default timeout (#1462).
describe('publish generation on the target (#1125)', { timeout: 30_000 }, () => {
  let root: string
  let app: Hono
  let writes: string[]

  beforeEach(async () => {
    purgeCalls.length = 0
    writes = []
    root = await mkdtemp('.tmp-publish-generation-')
    await mkdir(join(root, 'site', 'pages', 'home'), { recursive: true })
    await writeFile(
      join(root, 'site', 'pages', 'home', 'page.json'),
      JSON.stringify({ template: 'page-default', content: {} }),
    )
    await mkdir(join(root, 'site', 'fragments', 'footer'), { recursive: true })
    await writeFile(
      join(root, 'site', 'fragments', 'footer', 'fragment.json'),
      JSON.stringify({ template: 'footer-layout', content: {} }),
    )
    await mkdir(join(root, 'target'), { recursive: true })
    await mkdir(join(root, 'preview'), { recursive: true })

    const sourceStorage = recordingStorage(createFilesystemProvider(join(root, 'site')), writes)
    const targetStorage = recordingStorage(createFilesystemProvider(join(root, 'target')), writes)
    // A second destination without a CDN purge (the source can't be one, #1526).
    const previewStorage = recordingStorage(createFilesystemProvider(join(root, 'preview')), writes)
    const previewConfig = { storage: previewStorage, type: 'esi' as const, environment: 'staging' as const }
    const targetConfig = {
      storage: targetStorage,
      type: 'esi' as const,
      environment: 'staging' as const,
      cache: { purge: { type: 'cloudflare' as const, apiToken: 'tok', zoneId: 'zone' } },
    }
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
      manifest: { name: 'test-site', targets: { local: localConfig, staging: targetConfig, preview: previewConfig } },
    })
    app = createAdminApp({
      source,
      siteDir: join(root, 'site'),
      templatesDir: starterTemplatesDir,
      targets: new Map([
        ['local', sourceStorage],
        ['staging', targetStorage],
        ['preview', previewStorage],
      ]),
      targetConfigs: { local: localConfig, staging: targetConfig, preview: previewConfig },
      disableCacheStatsLogger: true,
    })
  })

  afterEach(async () => {
    await rm(root, { recursive: true, force: true })
  })

  it('admin route: written after the content writes and before the purge', async () => {
    const res = await app.request('/api/publish', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ items: ['pages/home', 'fragments/footer'], targets: ['staging'] }),
    })
    expect(res.status).toBeLessThan(300)

    const generationAt = writes.indexOf('.gazetta/publish-generation')
    const contentAt = writes.findIndex(p => p.startsWith('pages/'))
    expect(generationAt).toBeGreaterThan(-1)
    expect(contentAt).toBeGreaterThan(-1)
    expect(generationAt).toBeGreaterThan(contentAt)
    expect(purgeCalls).toEqual(['purgeAll'])
    expect(writes.slice(generationAt + 1).every(p => p.startsWith('.gazetta/'))).toBe(true)

    const value = await readFile(join(root, 'target', '.gazetta', 'publish-generation'), 'utf8')
    expect(value.trim().length).toBeGreaterThan(0)
  })

  it('admin route: also written when no purge is configured', async () => {
    const res = await app.request('/api/publish', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ items: ['pages/home'], targets: ['preview'] }),
    })
    expect(res.status).toBeLessThan(300)
    expect(writes).toContain('.gazetta/publish-generation')
    expect(purgeCalls).toEqual([])
    const value = await readFile(join(root, 'preview', '.gazetta', 'publish-generation'), 'utf8')
    expect(value.trim().length).toBeGreaterThan(0)
  })
})

// CLI path: spawns the CLI against a temp copy of the starter site
// (filesystem targets only, no credentials or containers needed).
const here = dirname(fileURLToPath(import.meta.url))
const repoRoot = resolve(here, '../../..')
const starterDir = resolve(repoRoot, 'examples/starter')
const cliPath = resolve(repoRoot, 'packages/gazetta/src/cli/index.ts')
const tsxBin = resolve(repoRoot, 'node_modules/.bin/tsx')

function runCli(cwd: string, args: string[]): Promise<{ output: string; code: number }> {
  return new Promise(done => {
    const child = spawn(tsxBin, [cliPath, ...args], {
      cwd,
      env: { ...process.env, CI: 'true' },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let output = ''
    child.stdout?.on('data', d => (output += d.toString()))
    child.stderr?.on('data', d => (output += d.toString()))
    child.on('close', code => done({ output, code: code ?? 0 }))
  })
}

describe('gazetta publish - generation file (#1125)', { timeout: 180000 }, () => {
  let projectDir: string

  beforeEach(async () => {
    projectDir = join(await mkdtemp('.tmp-cli-generation-'), 'site')
    await cp(starterDir, projectDir, {
      recursive: true,
      filter: src => !src.includes('/node_modules') && !src.includes('/dist'),
    })
  })

  afterEach(async () => {
    await rm(dirname(projectDir), { recursive: true, force: true })
  })

  it('writes a unique generation to the target on each publish', async () => {
    const first = await runCli(projectDir, ['publish', 'staging'])
    expect(first.code).toBe(0)
    const generationFile = join(projectDir, 'sites', 'main', 'dist', 'staging', '.gazetta', 'publish-generation')
    const genA = (await readFile(generationFile, 'utf8')).trim()
    expect(genA.length).toBeGreaterThan(0)

    const second = await runCli(projectDir, ['publish', 'staging'])
    expect(second.code).toBe(0)
    const genB = (await readFile(generationFile, 'utf8')).trim()
    expect(genB).not.toBe(genA)
  })
})
