/**
 * `gazetta publish` records a history revision on the target (#1079):
 * after a CLI publish, `gazetta history` lists a `publish` revision and
 * `gazetta undo` restores the pre-publish state. Before the fix the CLI
 * path recorded nothing, so CLI publishes were invisible to history and
 * could not be undone.
 *
 * Publishes to the starter's `staging` target (./dist/staging), a real
 * filesystem target separate from the source content root, so the test
 * also covers the CLI writing source manifests to the target: the
 * revision describes files the target actually has, and undo restores
 * the target's pre-publish manifest. (The earlier local-target version
 * could not catch a missing manifest copy because source == target
 * there.)
 *
 * Spawns the CLI against a temp copy of the starter site (filesystem
 * targets only - no credentials or containers needed).
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { spawn } from 'node:child_process'
import { cp, rm, readFile } from 'node:fs/promises'
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

describe('gazetta publish - history recording (#1079)', { timeout: 180000 }, () => {
  let projectDir: string

  beforeEach(async () => {
    projectDir = tempDir(`cli-publish-history-${Date.now()}-${Math.random().toString(36).slice(2)}`)
    await cp(starterDir, projectDir, {
      recursive: true,
      filter: src => !src.includes('/node_modules') && !src.includes('/dist'),
    })
  })

  afterEach(async () => {
    await rm(projectDir, { recursive: true, force: true })
  })

  it('writes manifests to the target, lists a publish revision, and undo restores the pre-publish manifest', async () => {
    const sourcePage = resolve(projectDir, 'sites/main/targets/local/pages/home/page.json')
    const targetPage = resolve(projectDir, 'sites/main/dist/staging/pages/home/page.json')
    const before = await readFile(sourcePage, 'utf8')

    // Baseline publish: the original source lands on staging.
    let res = await runCli(projectDir, ['publish', 'staging', 'sites/main', '--force'])
    expect(res.code).toBe(0)
    // The CLI now copies the source manifests to the target (same
    // publishItems step as the admin route), so the target holds the
    // manifest its history revision describes.
    expect(await readFile(targetPage, 'utf8')).toBe(before)

    // Change the source page so the second publish has something to record.
    const edited = before.replace(/"title"\s*:\s*"[^"]*"/, '"title": "Edited by #1079 test"')
    expect(edited).not.toBe(before)
    await (await import('node:fs/promises')).writeFile(sourcePage, edited)
    res = await runCli(projectDir, ['publish', 'staging', 'sites/main', '--force'])
    expect(res.code).toBe(0)
    expect(await readFile(targetPage, 'utf8')).toBe(edited)

    // History lists publish revisions - before the fix there were none.
    res = await runCli(projectDir, ['history', 'staging', 'sites/main'])
    expect(res.code).toBe(0)
    expect(res.output).toContain('publish')

    // Undo restores the staging target's pre-publish manifest.
    res = await runCli(projectDir, ['undo', 'staging', 'sites/main', '--yes'])
    expect(res.code).toBe(0)
    expect(await readFile(targetPage, 'utf8')).toBe(before)
  })
})
