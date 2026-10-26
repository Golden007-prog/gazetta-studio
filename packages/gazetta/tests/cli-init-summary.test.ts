/**
 * The `gazetta init` summary must show the real content layout (#1188):
 * pages and fragments live under the local target's content root
 * (`targets/local/`), not directly under `sites/main/`. npm is stubbed on
 * PATH so the run is fast and deterministic.
 */
import { describe, it, expect, afterEach } from 'vitest'
import { spawn, type ChildProcess } from 'node:child_process'
import { chmod, mkdir, rm, writeFile } from 'node:fs/promises'
import { resolve, dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { tempDir } from './_helpers/temp.js'

const here = dirname(fileURLToPath(import.meta.url))
const repoRoot = resolve(here, '../../..')
const cliPath = resolve(repoRoot, 'packages/gazetta/src/cli/index.ts')
const tsxBin = resolve(repoRoot, 'node_modules/.bin/tsx')

let children: ChildProcess[] = []
let workDir: string | null = null

afterEach(async () => {
  for (const child of children) {
    if (child.exitCode !== null) continue
    child.kill('SIGTERM')
    await Promise.race([new Promise(r => child.once('close', r)), new Promise(r => setTimeout(r, 5000))])
  }
  children = []
  if (workDir) {
    await rm(workDir, { recursive: true, force: true })
    workDir = null
  }
})

describe('gazetta init summary', () => {
  it('shows content under targets/local/, not directly under sites/main/', { timeout: 120000 }, async () => {
    workDir = tempDir('cli-init-summary-' + Date.now())
    const binDir = join(workDir, 'stub-bin')
    await mkdir(binDir, { recursive: true })
    const npmPath = join(binDir, 'npm')
    await writeFile(npmPath, '#!/bin/sh\nexit 0\n')
    await chmod(npmPath, 0o755)

    let output = ''
    const code = await new Promise<number | null>((resolvePromise, reject) => {
      const child = spawn(tsxBin, [cliPath, 'init', join(workDir!, 'site')], {
        cwd: workDir!,
        env: { ...process.env, CI: 'true', PATH: `${binDir}:${process.env.PATH}` },
        stdio: ['ignore', 'pipe', 'pipe'],
      })
      children.push(child)
      child.stdout?.on('data', d => (output += d.toString()))
      child.stderr?.on('data', d => (output += d.toString()))
      child.once('error', reject)
      child.once('close', resolvePromise)
    })

    expect(code).toBe(0)
    // The summary names the local target's content root; pre-#1188 it never did.
    expect(output).toContain('targets/local/')
    // ... ordered ahead of the page/fragment entries nested beneath it,
    // after site.config.ts at the site level.
    const root = output.indexOf('targets/local/')
    expect(output.indexOf('site.config.ts')).toBeGreaterThanOrEqual(0)
    expect(output.indexOf('site.config.ts')).toBeLessThan(root)
    expect(output.indexOf('pages/home/')).toBeGreaterThan(root)
    expect(output.indexOf('fragments/header/')).toBeGreaterThan(root)
  })
})
