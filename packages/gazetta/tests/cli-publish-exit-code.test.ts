/**
 * `gazetta publish` must exit non-zero when any item fails to render
 * (cli.md "Exit Codes", operations.md "Template errors during publish").
 * CI relies on it: the gazetta.studio deploy and the PR site-build check
 * both run `publish` and trust its exit code.
 *
 * Spawns the CLI against a temp copy of the starter site and publishes to
 * its filesystem `local` target, so no credentials or containers are
 * needed.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { spawn } from 'node:child_process'
import { cp, rm, readFile, writeFile } from 'node:fs/promises'
import { resolve, dirname } from 'node:path'
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

describe('gazetta publish exit code', { timeout: 120000 }, () => {
  let projectDir: string

  beforeEach(async () => {
    projectDir = tempDir(`cli-publish-exit-${Date.now()}-${Math.random().toString(36).slice(2)}`)
    await cp(starterDir, projectDir, {
      recursive: true,
      filter: src => !src.includes('/node_modules') && !src.includes('/dist'),
    })
  })

  afterEach(async () => {
    await rm(projectDir, { recursive: true, force: true })
  })

  it('exits 0 when every item renders', async () => {
    const res = await runCli(projectDir, ['publish', 'staging', 'sites/main', '--force'])
    expect(res.output).not.toContain('RENDER_FAILED')
    expect(res.code).toBe(0)
  })

  it('exits non-zero and says how many failed when a template throws', async () => {
    const heroPath = resolve(projectDir, 'templates/hero/index.ts')
    const hero = await readFile(heroPath, 'utf8')
    await writeFile(
      heroPath,
      hero.replace(
        'export default template',
        "const broken: TemplateFunction = () => {\n  throw new Error('test: hero template throws')\n}\nexport default broken",
      ),
    )

    const res = await runCli(projectDir, ['publish', 'staging', 'sites/main', '--force'])

    expect(res.output).toContain('RENDER_FAILED')
    expect(res.output).toMatch(/\d+ failed/)
    expect(res.code).not.toBe(0)
  })
})
