import { test as base, type Page } from '@playwright/test'
import { cp, mkdir } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawn, type ChildProcess } from 'node:child_process'
import { rmSafe } from './_helpers/rm-safe.js'

const here = dirname(fileURLToPath(import.meta.url))
const repoRoot = resolve(here, '../..')
const starterDir = resolve(repoRoot, 'examples/starter')

interface TestSite {
  baseURL: string
  projectDir: string
}

/**
 * Worker-scoped fixture: each Playwright worker gets its own copy of the
 * starter site under `.tmp/e2e-{workerIdx}/project/`, with its own dev server
 * on port 3100+workerIdx. Tests never mutate the real repo.
 *
 * Override playwright's `baseURL` so `page.goto('/admin')` hits the worker's
 * server automatically.
 */
/**
 * Worker option: an `admin.auth` config for this worker's site copy. Specs
 * that need a trust mode set it with `test.use({ siteAdminAuth: {...} })`;
 * Playwright gives them their own worker (own copy, own dev server).
 */
type SiteAdminAuth = Record<string, unknown> | undefined

export const test = base.extend<{ page: Page }, { testSite: TestSite; baseURL: string; siteAdminAuth: SiteAdminAuth }>({
  siteAdminAuth: [undefined, { option: true, scope: 'worker' }],

  // Capture browser console + page errors.
  // - Console errors and uncaught exceptions fail the test (silent bugs fly
  //   under text-assertion radar; this catches Vue runtime errors, unhandled
  //   rejections, PrimeVue warnings that shouldn't ship).
  // - All captured logs are attached to the report on any failure (including
  //   ones we trigger ourselves), for diagnosis.
  //
  // Tests that intentionally exercise an error path can opt out with
  //   test.info().annotations.push({ type: 'allow-console-errors' })
  // before the assertion that triggers the error.
  page: async ({ page }, use, testInfo) => {
    const logs: string[] = []
    const errors: string[] = []
    page.on('console', msg => {
      const entry = `[${msg.type()}] ${msg.text()}`
      logs.push(entry)
      if (msg.type() === 'error') errors.push(entry)
    })
    page.on('pageerror', err => {
      const entry = `[pageerror] ${err.message}`
      logs.push(entry)
      errors.push(entry)
    })
    await use(page)
    const allowErrors = testInfo.annotations.some(a => a.type === 'allow-console-errors')
    const shouldFail = !allowErrors && errors.length > 0 && testInfo.status === testInfo.expectedStatus
    if (testInfo.status !== testInfo.expectedStatus || shouldFail) {
      if (logs.length) {
        process.stderr.write(
          `\n===== BROWSER CONSOLE for ${testInfo.title} =====\n${logs.join('\n')}\n===== END =====\n`,
        )
        await testInfo.attach('browser-console.log', { body: logs.join('\n'), contentType: 'text/plain' })
      }
    }
    if (shouldFail) {
      throw new Error(
        `Test passed but emitted ${errors.length} browser console error(s):\n` +
          errors
            .slice(0, 5)
            .map(e => '  ' + e)
            .join('\n') +
          (errors.length > 5 ? `\n  …and ${errors.length - 5} more` : '') +
          `\n\nAdd test.info().annotations.push({ type: 'allow-console-errors' }) to opt out if intentional.`,
      )
    }
  },

  testSite: [
    async ({ siteAdminAuth }, use, workerInfo) => {
      const workerDir = resolve(repoRoot, '.tmp', `e2e-${workerInfo.workerIndex}`)
      const projectDir = resolve(workerDir, 'project')
      const port = 3100 + workerInfo.workerIndex

      await rmSafe(workerDir)
      await mkdir(workerDir, { recursive: true })
      await cp(starterDir, projectDir, {
        recursive: true,
        filter: src => !src.includes('/dist') && !src.includes('/node_modules') && !src.includes('/.tmp'),
      })

      // Swap the azure-blob 'production' target for a filesystem one with
      // environment:production. Azurite isn't reachable in CI and takes 10s to
      // time out, which would drop it from the target registry and break tests
      // that click [data-testid="publish-target-production"]. Using a local
      // filesystem target preserves the prod semantics (badge + confirmation
      // prompt via environment: production) without a network dependency.
      //
      // The starter is TS config now; locate the `production: {` block and
      // walk its braces to find the matching close — regex on nested braces
      // is brittle.
      const { readFile, writeFile: writeFileFs } = await import('node:fs/promises')
      const siteConfigPath = resolve(projectDir, 'sites/main/site.config.ts')
      const ts = await readFile(siteConfigPath, 'utf-8')
      const startIdx = ts.indexOf('production: {')
      if (startIdx === -1) {
        throw new Error('Could not locate `production: {` in starter site.config.ts')
      }
      const openIdx = ts.indexOf('{', startIdx)
      let depth = 1
      let i = openIdx + 1
      while (i < ts.length && depth > 0) {
        const ch = ts[i]
        if (ch === '{') depth++
        else if (ch === '}') depth--
        i++
      }
      if (depth !== 0) {
        throw new Error('Unbalanced braces in starter site.config.ts production block')
      }
      let endIdx = i
      if (ts[endIdx] === ',') endIdx++
      const replacement =
        `production: {\n` +
        `      environment: 'production',\n` +
        `      storage: { type: 'filesystem', path: './dist/prod-test' },\n` +
        `    },`
      let config = ts.slice(0, startIdx) + replacement + ts.slice(endIdx)
      if (siteAdminAuth) {
        const anchor = 'defineSite({'
        if (!config.includes(anchor)) throw new Error('Could not locate `defineSite({` in starter site.config.ts')
        config = config.replace(anchor, `${anchor}\n  admin: { auth: ${JSON.stringify(siteAdminAuth)} },`)
      }
      await writeFileFs(siteConfigPath, config)

      const server = spawnDev(projectDir, port)
      try {
        await waitForServer(port, server)
      } catch (err) {
        server.kill('SIGTERM')
        throw err
      }

      try {
        await use({ baseURL: `http://localhost:${port}`, projectDir })
      } finally {
        server.kill('SIGTERM')
        await new Promise<void>(resolveP => server.once('exit', () => resolveP()))
        // Always clean — Playwright preserves test-results/ for debugging separately
        await rmSafe(workerDir).catch(() => {})
      }
    },
    { scope: 'worker' },
  ],

  // Override baseURL so every page.goto('/...') lands on the worker's server
  baseURL: async ({ testSite }, use) => {
    await use(testSite.baseURL)
  },
})

function spawnDev(cwd: string, port: number): ChildProcess {
  const cli = resolve(repoRoot, 'packages/gazetta/src/cli/index.ts')
  const tsxBin = resolve(repoRoot, 'node_modules/.bin/tsx')
  if (!existsSync(tsxBin)) throw new Error(`tsx not found at ${tsxBin}; run 'npm install' at repo root`)
  const server = spawn(tsxBin, [cli, 'dev', 'sites/main', '--port', String(port)], {
    cwd,
    // CI=true avoids the interactive publish confirm. Leave color control to
    // Playwright's FORCE_COLOR — overriding here triggers a Node warning.
    env: { ...process.env, CI: 'true' },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  // Surface Vite optimizer events and warnings — helpful for diagnosing flakes.
  // Request logs are filtered out to keep CI output manageable.
  server.stdout?.on('data', d => {
    const text = d.toString()
    // Skip verbose request logs (lines starting with request arrows)
    const important = text
      .split('\n')
      .filter((line: string) => line.trim() && !/^\s*(<--|-->)\s/.test(line))
      .join('\n')
    if (important.trim()) process.stderr.write(`[dev:${port}] ${important}${important.endsWith('\n') ? '' : '\n'}`)
  })
  server.stderr?.on('data', d => process.stderr.write(`[dev:${port}:err] ${d}`))
  return server
}

/**
 * Poll the server's /admin route until it responds 200 (or timeout).
 * If the child process exits before ready, surface the stderr so the test fails
 * with an actionable error instead of a mystery timeout.
 */
async function waitForServer(port: number, server: ChildProcess): Promise<void> {
  const timeoutMs = 30000
  const started = Date.now()

  const exitPromise = new Promise<never>((_, reject) => {
    server.once('exit', code => {
      reject(new Error(`gazetta dev on port ${port} exited prematurely (code ${code}) before serving /admin`))
    })
  })

  while (Date.now() - started < timeoutMs) {
    try {
      const res = await Promise.race([fetch(`http://localhost:${port}/admin`), exitPromise])
      if (res && res.status === 200) break
    } catch {
      // still starting — retry
    }
    await new Promise(r => setTimeout(r, 100))
  }
  if (Date.now() - started >= timeoutMs) {
    throw new Error(`gazetta dev on port ${port} did not become ready within ${timeoutMs}ms`)
  }
}

export { expect } from '@playwright/test'
