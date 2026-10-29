/**
 * #1130, CLI end-to-end: `gazetta publish` to a plain-static target with
 * `redirects: { format: 'cloudflare' }` writes one `_redirects` row per
 * language the target publishes for each archived page, instead of only
 * the default-language row. The starter site declares en/fr/ar/ja
 * locales, so the alias and 410 rows appear unprefixed for English and
 * prefixed for every other published language.
 *
 * Runs the real CLI against a temp copy of examples/starter (matching
 * cli-publish-exit-code.test.ts). Pages are seeded into the editable
 * local target's storage (sites/main/targets/local/pages/), which is
 * where the CLI reads site content from. The staging target gets a
 * redirects format and receives the publish: publishing into the editing
 * source itself is refused (#1526).
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { spawn } from 'node:child_process'
import { cp, mkdir, rm, readFile, writeFile } from 'node:fs/promises'
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

async function seedArchivedPages(projectDir: string): Promise<void> {
  const pages: Record<string, object> = {
    landing: { template: 'page-default', content: {}, archived: true, aliasOf: 'welcome' },
    old: { template: 'page-default', content: {}, archived: true },
    welcome: { template: 'page-default', content: {} },
  }
  for (const [name, manifest] of Object.entries(pages)) {
    const dir = join(projectDir, 'sites/main/targets/local/pages', name)
    await mkdir(dir, { recursive: true })
    await writeFile(join(dir, 'page.json'), JSON.stringify(manifest))
  }
  // welcome gets a French version only: the fr row keeps the language,
  // ar/ja fall back to the default-language page (#1124 Q10).
  await writeFile(
    join(projectDir, 'sites/main/targets/local/pages/welcome/page.fr.json'),
    JSON.stringify({ template: 'page-default', content: {} }),
  )
}

async function addRedirectsFormat(projectDir: string): Promise<void> {
  const configPath = join(projectDir, 'sites/main/site.config.ts')
  const config = await readFile(configPath, 'utf8')
  const updated = config.replace('staging: {', "staging: {\n      redirects: { format: 'cloudflare' as const },")
  await writeFile(configPath, updated)
}

describe('gazetta publish — redirects rows per target language (#1130)', { timeout: 120000 }, () => {
  let projectDir: string

  beforeEach(async () => {
    projectDir = tempDir(`cli-publish-redirects-${Date.now()}-${Math.random().toString(36).slice(2)}`)
    await cp(starterDir, projectDir, {
      recursive: true,
      filter: src => !src.includes('/node_modules') && !src.includes('/dist'),
    })
    await seedArchivedPages(projectDir)
    await addRedirectsFormat(projectDir)
  })

  afterEach(async () => {
    await rm(projectDir, { recursive: true, force: true })
  })

  it('writes one _redirects row per published language for archived pages', async () => {
    const res = await runCli(projectDir, ['publish', 'staging', 'sites/main', '--force'])
    expect(res.code).toBe(0)

    const body = await readFile(join(projectDir, 'sites/main/dist/staging/_redirects'), 'utf8')
    expect(body).toContain('/landing  /welcome  301')
    expect(body).toContain('/fr/landing  /fr/welcome  301')
    // welcome has no ar/ja version: those rows point at the
    // default-language page instead of routes nothing published.
    expect(body).toContain('/ar/landing  /welcome  301')
    expect(body).toContain('/ja/landing  /welcome  301')
    expect(body).not.toContain('/ar/welcome')
    expect(body).not.toContain('/ja/welcome')
    expect(body).toContain('/old  /  410')
    expect(body).toContain('/fr/old  /  410')
    expect(body).toContain('/ar/old  /  410')
    expect(body).toContain('/ja/old  /  410')
  })

  it('deletes _redirects when the last archived page is unarchived and republished (#1426)', async () => {
    const first = await runCli(projectDir, ['publish', 'staging', 'sites/main', '--force'])
    expect(first.code).toBe(0)
    const redirectsPath = join(projectDir, 'sites/main/dist/staging/_redirects')
    await readFile(redirectsPath, 'utf8')

    // Unarchive both archived pages: no rows remain, and the published
    // file must come down rather than stay live (generated files are
    // written or deleted, never skipped).
    for (const name of ['landing', 'old']) {
      await writeFile(
        join(projectDir, 'sites/main/targets/local/pages', name, 'page.json'),
        JSON.stringify({ template: 'page-default', content: {} }),
      )
    }
    const second = await runCli(projectDir, ['publish', 'staging', 'sites/main', '--force'])
    expect(second.code).toBe(0)
    await expect(readFile(redirectsPath, 'utf8')).rejects.toThrow()
  })
})
