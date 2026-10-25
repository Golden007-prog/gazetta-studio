/**
 * Integration test for #1318: `gazetta dev` serves the site's own 404 page
 * for unknown URLs and answers pages created while it runs, without a
 * restart. Spawns the dev server against a temp copy of the starter site.
 * The 404 and new-page assertions fail on code that registers routes and
 * the not-found list only at boot.
 *
 * Slow: one long-lived subprocess per test run.
 */
import { describe, it, expect, afterEach } from 'vitest'
import { spawn, type ChildProcess } from 'node:child_process'
import { cp, rm, mkdir, writeFile } from 'node:fs/promises'
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

describe('gazetta dev 404 page and pages created at runtime (#1318)', () => {
  it("serves the site's own 404 page, answers new pages without a restart, and only logs content-root manifest changes", async () => {
    projectDir = tempDir(`dev-404-new-pages-${Date.now()}`)
    await cp(starterDir, projectDir, { recursive: true })

    const port = 4900 + Math.floor(Math.random() * 100)
    let output = ''
    child = spawn(tsxBin, [cliPath, 'dev', '--host', '127.0.0.1', '-p', String(port)], {
      cwd: projectDir,
      env: { ...process.env, CI: 'true' },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    child.stdout?.on('data', d => (output += d.toString()))
    child.stderr?.on('data', d => (output += d.toString()))

    const base = `http://127.0.0.1:${port}/`
    await fetchWithRetry(base, 60000)

    // Unknown URL: the starter ships pages/404, so that page answers with
    // a 404 status (today: a plain route list).
    const missing = await fetch(`${base}nope`)
    expect(missing.status).toBe(404)
    expect(await missing.text()).toContain('Page Not Found')

    // A page created while the server runs answers 200 without a restart.
    const newPageDir = resolve(projectDir, 'sites/main/targets/local/pages/qa-new-page')
    await mkdir(newPageDir, { recursive: true })
    const newPageJson = JSON.stringify({
      template: 'page-default',
      metadata: { title: 'QA Runtime Page' },
      components: [
        '@header',
        { name: 'body', template: 'text-block', content: { body: '<p>created while the server ran</p>' } },
        '@footer',
      ],
    })
    await writeFile(resolve(newPageDir, 'page.json'), newPageJson)
    await waitFor(async () => {
      const res = await fetch(`${base}qa-new-page`)
      return res.status === 200 && (await res.text()).includes('created while the server ran')
    }, 20000)

    // A manifest under the content root is still noticed.
    await writeFile(resolve(newPageDir, 'page.json'), newPageJson)
    await waitFor(
      () => Promise.resolve(output.includes('Manifest changed: targets/local/pages/qa-new-page/page.json')),
      10000,
    )

    // A JSON file outside the content root is not logged as a manifest
    // change (its cache invalidation still runs; covered by the
    // target-switch e2e).
    // Let watcher events from the writes above settle first: they arrive
    // asynchronously, so a baseline taken immediately can still see them.
    await new Promise(r => setTimeout(r, 1500))
    const outputBefore = output.length
    await writeFile(resolve(projectDir, 'sites/main/scratch.json'), '{}')
    await new Promise(r => setTimeout(r, 1500))
    expect(output.slice(outputBefore)).not.toContain('Manifest changed')
  }, 120_000)
})
