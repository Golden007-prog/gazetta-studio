/**
 * Integration test for #1353: `gazetta dev` reloads when site.config.ts
 * changes, per design-config.md. Spawns the dev server against a temp copy
 * of the starter site, edits the config, and asserts the new values take
 * effect without a restart. A config that fails to evaluate keeps serving
 * the last good one.
 *
 * Slow: one long-lived subprocess per test run.
 */
import { describe, it, expect, afterEach } from 'vitest'
import { spawn, type ChildProcess } from 'node:child_process'
import { cp, rm, readFile, writeFile } from 'node:fs/promises'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { tempDir } from './_helpers/temp.js'

const here = dirname(fileURLToPath(import.meta.url))
const repoRoot = resolve(here, '../../..')
const starterDir = resolve(repoRoot, 'examples/starter')
const cliPath = resolve(repoRoot, 'packages/gazetta/src/cli/index.ts')
const tsxBin = resolve(repoRoot, 'node_modules/.bin/tsx')

let child: ChildProcess | null = null
let projectDir: string | null = null

afterEach(async () => {
  if (child) {
    child.kill('SIGTERM')
    await new Promise(r => child!.once('close', r))
    child = null
  }
  if (projectDir) {
    await rm(projectDir, { recursive: true, force: true })
    projectDir = null
  }
})

async function fetchWithRetry(url: string, timeoutMs: number): Promise<string> {
  const deadline = Date.now() + timeoutMs
  let lastErr: unknown
  while (Date.now() < deadline) {
    try {
      const res = await fetch(url)
      if (res.status === 200) return await res.text()
      lastErr = new Error(`status ${res.status}`)
    } catch (err) {
      lastErr = err
    }
    await new Promise(r => setTimeout(r, 400))
  }
  throw lastErr instanceof Error ? lastErr : new Error(String(lastErr))
}

async function waitFor(predicate: () => Promise<boolean>, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (await predicate()) return
    await new Promise(r => setTimeout(r, 400))
  }
  throw new Error(`condition not met within ${timeoutMs}ms`)
}

describe('gazetta dev config reload (#1353)', () => {
  it('applies a locale edit from site.config.ts without a restart and keeps the last good config on error', async () => {
    projectDir = tempDir(`dev-config-reload-${Date.now()}`)
    await cp(starterDir, projectDir, { recursive: true })

    const port = 4700 + Math.floor(Math.random() * 200)
    let output = ''
    child = spawn(tsxBin, [cliPath, 'dev', '--host', '127.0.0.1', '-p', String(port)], {
      cwd: projectDir,
      env: { ...process.env, CI: 'true' },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    child.stdout?.on('data', d => (output += d.toString()))
    child.stderr?.on('data', d => (output += d.toString()))

    const base = `http://127.0.0.1:${port}/`
    const before = await fetchWithRetry(base, 60000)
    expect(before).toContain('lang="en"')

    // Edit the default locale while the server runs.
    const configPath = resolve(projectDir, 'sites/main/site.config.ts')
    const config = await readFile(configPath, 'utf-8')
    await writeFile(configPath, config.replace("default: 'en'", "default: 'fr'"))

    await waitFor(async () => (await fetchWithRetry(base, 10000)).includes('lang="fr"'), 20000)

    // A config that fails to evaluate keeps serving the last good config.
    await writeFile(configPath, 'export default defineSite({ name: ')
    await waitFor(async () => output.includes('Config reload failed'), 20000)
    const after = await fetchWithRetry(base, 10000)
    expect(after).toContain('lang="fr"')
  }, 120000)
})
