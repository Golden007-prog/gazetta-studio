/**
 * Integration test for #1300: when `gazetta init`'s `npm install` fails,
 * init keeps the files it wrote, prints npm's error output, says how to
 * finish, skips the "Done!" outro and exits non-zero. Today's code swallows
 * the failure, prints "Done!" and exits 0, so the failure assertions fail
 * on it. npm is stubbed on PATH, so no network is involved and both the
 * failure and the success shape are deterministic.
 */
import { describe, it, expect, afterEach } from 'vitest'
import { spawn, type ChildProcess } from 'node:child_process'
import { chmod, mkdir, rm, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
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

/** Put a fake `npm` on PATH: exits 1 with an error line, or 0 silently. */
async function stubNpm(fails: boolean): Promise<string> {
  const binDir = join(workDir!, 'stub-bin')
  await mkdir(binDir, { recursive: true })
  const script = fails
    ? '#!/bin/sh\necho "npm ERR! code ESTUBBED\nnpm ERR! stubbed registry unreachable" >&2\nexit 1\n'
    : '#!/bin/sh\nexit 0\n'
  const npmPath = join(binDir, 'npm')
  await writeFile(npmPath, script)
  await chmod(npmPath, 0o755)
  return binDir
}

function runInit(dir: string, binDir: string): Promise<{ code: number | null; output: string }> {
  return new Promise((resolvePromise, reject) => {
    let output = ''
    const child = spawn(tsxBin, [cliPath, 'init', dir], {
      cwd: workDir!,
      env: { ...process.env, CI: 'true', PATH: `${binDir}:${process.env.PATH}` },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    children.push(child)
    child.stdout?.on('data', d => (output += d.toString()))
    child.stderr?.on('data', d => (output += d.toString()))
    const timer = setTimeout(() => {
      child.kill('SIGKILL')
      reject(new Error(`timed out waiting for init to exit\n${output}`))
    }, 60000)
    child.once('close', code => {
      clearTimeout(timer)
      resolvePromise({ code, output })
    })
  })
}

describe('gazetta init when npm install fails (#1300)', () => {
  it('exits non-zero, prints the npm error and skips "Done!"', async () => {
    workDir = tempDir(`init-install-failure-${Date.now()}`)
    await mkdir(workDir, { recursive: true })
    const binDir = await stubNpm(true)

    const result = await runInit('my-site', binDir)
    expect(result.code).toBe(1)
    expect(result.output).toContain('npm ERR! stubbed registry unreachable')
    expect(result.output).toContain('cd my-site && npm install')
    expect(result.output).not.toContain('Done!')
    // The files init wrote stay in place.
    expect(existsSync(join(workDir, 'my-site', 'package.json'))).toBe(true)
    expect(existsSync(join(workDir, 'my-site', 'sites/main/site.config.ts'))).toBe(true)
  }, 90000)

  it('a successful install keeps the current "Done!" behavior', async () => {
    workDir = tempDir(`init-install-success-${Date.now()}`)
    await mkdir(workDir, { recursive: true })
    const binDir = await stubNpm(false)

    const result = await runInit('my-site', binDir)
    expect(result.code).toBe(0)
    expect(result.output).toContain('Done!')
    expect(result.output).toContain('npx gazetta dev')
    expect(existsSync(join(workDir, 'my-site', 'package.json'))).toBe(true)
  }, 90000)
})
