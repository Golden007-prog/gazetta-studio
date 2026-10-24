/**
 * #1152 cut 1, CLI end-to-end: `gazetta publish` to a static target writes
 * `404.html` at the target root with the site's /404 page, and writes it
 * again on a publish where no item changed. An ESI target gets none.
 *
 * Runs the real CLI against a temp copy of examples/starter, whose
 * `staging` target is static and `esi-test` target is dynamic (ESI).
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { spawn } from 'node:child_process'
import { cp, readFile, rm } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { join, resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { tempDir } from './_helpers/temp.js'

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

describe('gazetta publish — 404.html at a static target root (#1152)', { timeout: 180000 }, () => {
  let projectDir: string

  beforeEach(async () => {
    projectDir = tempDir(`cli-publish-404-${Date.now()}-${Math.random().toString(36).slice(2)}`)
    await cp(starterDir, projectDir, {
      recursive: true,
      filter: src => !src.includes('/node_modules') && !src.includes('/dist'),
    })
  })

  afterEach(async () => {
    await rm(projectDir, { recursive: true, force: true })
  })

  it("writes the site's /404 page, and writes it again when nothing changed", async () => {
    const staticRoot = join(projectDir, 'sites/main/dist/staging')
    const first = await runCli(projectDir, ['publish', 'staging', 'sites/main'])
    expect(first.code, first.output).toBe(0)

    const html = await readFile(join(staticRoot, '404.html'), 'utf8')
    expect(html).toContain("The page you're looking for doesn't exist")
    expect(html).toBe(await readFile(join(staticRoot, '404/index.html'), 'utf8'))

    await rm(join(staticRoot, '404.html'))
    const second = await runCli(projectDir, ['publish', 'staging', 'sites/main'])
    expect(second.code, second.output).toBe(0)
    expect(second.output).toContain('unchanged (skipped)')
    expect(await readFile(join(staticRoot, '404.html'), 'utf8')).toBe(html)
  })

  it('writes no 404.html on an ESI target', async () => {
    const res = await runCli(projectDir, ['publish', 'esi-test', 'sites/main'])
    expect(res.code, res.output).toBe(0)
    expect(existsSync(join(projectDir, 'sites/main/dist/esi-test/404.html'))).toBe(false)
  })
})
