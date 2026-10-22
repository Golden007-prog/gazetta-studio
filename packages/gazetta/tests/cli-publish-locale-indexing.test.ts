/** #1048: ordinary incremental publish repairs old locale indexing state without changing source hashes. */
import { describe, it, expect } from 'vitest'
import { spawn } from 'node:child_process'
import { cp, mkdir, rm, readFile, writeFile, readdir } from 'node:fs/promises'
import { resolve } from 'node:path'
import { tempDir } from './_helpers/temp.js'
import { createFilesystemProvider } from '../src/providers/filesystem.js'
import { createContentRoot } from '../src/content-root.js'
import { listSidecars } from '../src/sidecars.js'
import { pubSidecarNameFor } from '../src/hash.js'
import { compareTargets } from '../src/compare.js'

const repoRoot = resolve(import.meta.dirname, '../../..')
const starterDir = resolve(repoRoot, 'examples/starter')
const cliPath = resolve(repoRoot, 'packages/gazetta/src/cli/index.ts')
const tsxBin = resolve(repoRoot, 'node_modules/.bin/tsx')

function runCli(cwd: string, args: string[]): Promise<{ output: string; code: number }> {
  return new Promise((done, reject) => {
    const child = spawn(tsxBin, [cliPath, ...args], {
      cwd,
      env: { ...process.env, CI: 'true' },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let output = ''
    child.stdout?.on('data', data => (output += data.toString()))
    child.stderr?.on('data', data => (output += data.toString()))
    child.on('error', reject)
    child.on('close', code => done({ output, code: code ?? 1 }))
  })
}

describe('gazetta publish — repairing previously published locale indexing', { timeout: 120000 }, () => {
  it('repairs both wrong locale flags without force or source edits and then compares unchanged', async () => {
    const projectDir = tempDir(`cli-locale-indexing-${Date.now()}-${Math.random().toString(36).slice(2)}`)
    try {
      await cp(starterDir, projectDir, {
        recursive: true,
        filter: src => !src.includes('/node_modules') && !src.includes('/dist'),
      })
      const siteDir = resolve(projectDir, 'sites/main')
      const sourceDir = resolve(siteDir, 'targets/local')
      const configPath = resolve(siteDir, 'site.config.ts')
      const config = await readFile(configPath, 'utf8')
      await writeFile(configPath, config.replace('staging: {', "staging: {\n      siteUrl: 'https://example.com',"))
      const page = JSON.parse(await readFile(resolve(sourceDir, 'pages/home/page.json'), 'utf8'))
      for (const [name, defaultNoindex] of [
        ['home', false],
        ['private', true],
      ] as const) {
        const dir = resolve(sourceDir, 'pages', name)
        await mkdir(dir, { recursive: true })
        await writeFile(
          resolve(dir, 'page.json'),
          JSON.stringify({ ...page, metadata: { robots: defaultNoindex ? 'noindex' : 'index' } }),
        )
        await writeFile(
          resolve(dir, 'page.fr.json'),
          JSON.stringify({ ...page, metadata: defaultNoindex ? undefined : { robots: 'noindex' } }),
        )
      }

      const targetDir = resolve(siteDir, 'dist/staging')
      const target = createFilesystemProvider(targetDir)
      const baseline = await runCli(projectDir, ['publish', 'staging', 'sites/main', '--force'])
      expect(baseline.code, baseline.output).toBe(0)
      const before = await listSidecars(target, 'pages')

      // Recreate the old bug's flags but keep each locale's correct content hash.
      for (const [name, oldNoindex] of [
        ['home', false],
        ['private', true],
      ] as const) {
        const dir = resolve(targetDir, 'pages', name)
        for (const entry of await readdir(dir)) {
          if (entry.startsWith('.pub-') && entry.endsWith('.fr')) await rm(resolve(dir, entry))
        }
        const publishedAt = new Date(before.get(`${name}:fr`)!.pub!.lastPublished)
        await writeFile(resolve(dir, pubSidecarNameFor(publishedAt, oldNoindex, 'fr')), '')
      }

      const published = await runCli(projectDir, ['publish', 'staging', 'sites/main'])
      expect(published.code, published.output).toBe(0)
      const after = await listSidecars(target, 'pages')
      expect(after.get('home:fr')!.pub!.noindex).toBe(true)
      expect(after.get('private:fr')!.pub!.noindex).toBe(false)
      for (const key of ['home', 'home:fr', 'private', 'private:fr']) {
        expect(after.get(key)!.hash).toBe(before.get(key)!.hash)
      }
      const sitemap = await readFile(resolve(targetDir, 'sitemap.xml'), 'utf8')
      expect(sitemap).toContain('<loc>https://example.com/</loc>')
      expect(sitemap).not.toContain('<loc>https://example.com/fr</loc>')
      expect(sitemap).not.toContain('<loc>https://example.com/private</loc>')
      expect(sitemap).toContain('<loc>https://example.com/fr/private</loc>')

      const comparison = await compareTargets({
        sourceRoot: createContentRoot(createFilesystemProvider(sourceDir), ''),
        target,
        templatesDir: resolve(projectDir, 'templates'),
        projectRoot: projectDir,
        type: 'static',
        manifest: { name: 'Gazetta Starter', locales: { default: 'en', supported: ['en', 'fr', 'ar', 'ja'] } },
      })
      expect(comparison.unchanged).toEqual(expect.arrayContaining(['pages/home:fr', 'pages/private:fr']))
      expect(comparison.modified).toEqual([])
    } finally {
      await rm(projectDir, { recursive: true, force: true })
    }
  })
})
