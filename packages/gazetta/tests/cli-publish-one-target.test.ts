/**
 * `gazetta publish` on a site with a single target must stop with a
 * message instead of publishing the editing target into itself
 * (operations.md decision 2026-10-24, issue #1286). Rendering `local`
 * into `local` puts nothing anywhere a visitor can reach, yet printed
 * success.
 *
 * Spawns the CLI against a temp copy of the starter site whose
 * site.config.ts is rewritten to a single filesystem target, so no
 * credentials or containers are needed.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { spawn } from 'node:child_process'
import { cp, rm, writeFile, readdir, readFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { resolve, dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { tempDir } from './_helpers/temp.js'

const here = dirname(fileURLToPath(import.meta.url))
const repoRoot = resolve(here, '../../..')
const starterDir = resolve(repoRoot, 'examples/starter')
const cliPath = resolve(repoRoot, 'packages/gazetta/src/cli/index.ts')
const tsxBin = resolve(repoRoot, 'node_modules/.bin/tsx')

const ONE_TARGET_CONFIG = `import { defineSite, filesystemStorage } from 'gazetta'

export default defineSite({
  name: 'Gazetta Starter',
  version: '1.0.0',
  systemPages: ['404'],
  targets: {
    local: {
      storage: filesystemStorage({ path: './targets/local' }),
      publicStorage: false,
    },
  },
})
`

/** Sorted "path:hash" lines for every file under dir, so a publish run
 * that writes, edits or deletes anything in the target is detectable. */
async function snapshotTree(dir: string, prefix = ''): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true }).catch(() => [])
  const lines: string[] = []
  for (const e of entries) {
    const rel = prefix ? `${prefix}/${e.name}` : e.name
    if (e.isDirectory()) {
      lines.push(...(await snapshotTree(join(dir, e.name), rel)))
    } else {
      const hash = createHash('sha1')
        .update(await readFile(join(dir, e.name)))
        .digest('hex')
      lines.push(`${rel}:${hash}`)
    }
  }
  return lines.sort()
}

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

describe('gazetta publish on a one-target site', { timeout: 120000 }, () => {
  let projectDir: string

  beforeEach(async () => {
    projectDir = tempDir(`cli-publish-one-target-${Date.now()}-${Math.random().toString(36).slice(2)}`)
    await cp(starterDir, projectDir, {
      recursive: true,
      filter: src => !src.includes('/node_modules') && !src.includes('/dist'),
    })
    await writeFile(resolve(projectDir, 'sites/main/site.config.ts'), ONE_TARGET_CONFIG)
  })

  afterEach(async () => {
    await rm(projectDir, { recursive: true, force: true })
  })

  it('stops with a message and writes nothing when no target is given', async () => {
    const before = await snapshotTree(join(projectDir, 'sites/main/targets'))
    const res = await runCli(projectDir, ['publish'])

    expect(res.code).toBe(1)
    expect(res.output).toContain("This site has one target, so there's nowhere to publish to.")
    expect(res.output).toContain('Add a target in site.config.ts: https://gazetta.studio/docs\n')
    expect(await snapshotTree(join(projectDir, 'sites/main/targets'))).toEqual(before)
  })

  it('stops the same way when the single target is named explicitly', async () => {
    const before = await snapshotTree(join(projectDir, 'sites/main/targets'))
    const res = await runCli(projectDir, ['publish', 'local'])

    expect(res.code).toBe(1)
    expect(res.output).toContain("This site has one target, so there's nowhere to publish to.")
    expect(await snapshotTree(join(projectDir, 'sites/main/targets'))).toEqual(before)
  })
})

const TWO_TARGET_CONFIG = `import { defineSite, filesystemStorage } from 'gazetta'

export default defineSite({
  name: 'Gazetta Starter',
  version: '1.0.0',
  systemPages: ['404'],
  targets: {
    local: {
      storage: filesystemStorage({ path: './targets/local' }),
      publicStorage: false,
    },
    staging: {
      storage: filesystemStorage({ path: './dist/staging' }),
      publicStorage: false,
      environment: 'staging',
    },
  },
})
`

// Naming the editing source as the destination copies the site onto itself,
// and the parallel copies read each other's half-written temp files (#1526).
describe('gazetta publish into its editing source', { timeout: 120000 }, () => {
  let projectDir: string

  beforeEach(async () => {
    projectDir = tempDir(`cli-publish-into-source-${Date.now()}-${Math.random().toString(36).slice(2)}`)
    await cp(starterDir, projectDir, {
      recursive: true,
      filter: src => !src.includes('/node_modules') && !src.includes('/dist'),
    })
    await writeFile(resolve(projectDir, 'sites/main/site.config.ts'), TWO_TARGET_CONFIG)
  })

  afterEach(async () => {
    await rm(projectDir, { recursive: true, force: true })
  })

  it('refuses and writes nothing when the editing source is named', async () => {
    const before = await snapshotTree(join(projectDir, 'sites/main/targets'))
    const res = await runCli(projectDir, ['publish', 'local'])

    expect(res.code).toBe(1)
    expect(res.output).toContain('"local" is the editing source')
    expect(await snapshotTree(join(projectDir, 'sites/main/targets'))).toEqual(before)
  })
})
