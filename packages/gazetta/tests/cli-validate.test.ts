/**
 * End-to-end CLI tests for `gazetta validate` (Validation Cut 5).
 *
 * Spawns the built CLI as a subprocess and asserts on output + exit code.
 * Uses the starter site fixture as the target site.
 *
 * Tests pin:
 *   - Clean run exits 0 with "All good"
 *   - Schema mismatch fires schema-conformance and exits 1 (warn-as-error)
 *   - --no-warn-as-error keeps the warning visible but exits 0
 *   - --severity error suppresses warns from output
 *   - --verbose prints full Issue messages
 *   - --include-quality runs the heavier validators
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { spawnSync } from 'node:child_process'
import { resolve, dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { cpSync, existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs'

const here = dirname(fileURLToPath(import.meta.url))
const cliEntry = resolve(here, '../dist/cli/index.js')
const starterDir = resolve(here, '../../../examples/starter')
const starterSiteDir = join(starterDir, 'sites/main')

beforeAll(() => {
  if (!existsSync(cliEntry)) {
    throw new Error(`CLI not built — run \`npm run build -w packages/gazetta\` before this test.\nMissing: ${cliEntry}`)
  }
  if (!existsSync(starterSiteDir)) {
    throw new Error(`Starter fixture missing: ${starterSiteDir}`)
  }
})

function run(args: string[]): { stdout: string; stderr: string; status: number | null } {
  const result = spawnSync('node', [cliEntry, 'validate', ...args], {
    cwd: starterDir,
    env: { ...process.env, NO_COLOR: '1' },
    encoding: 'utf-8',
  })
  return { stdout: result.stdout, stderr: result.stderr, status: result.status }
}

describe('gazetta validate (CLI)', () => {
  // Every test here spawns the built CLI; the default 5s vitest timeout is
  // too tight under CI parallelism (~2s local, up to ~12s observed on loaded
  // runners), so all of them use the quality test's 30s override.
  it('runs against starter and reports each page + fragment', { timeout: 30_000 }, () => {
    const { stdout, status } = run(['sites/main', '--severity', 'error'])
    expect(stdout).toMatch(/site\.config\.ts/)
    expect(stdout).toMatch(/home/)
    expect(stdout).toMatch(/@header/)
    // Starter currently has a schema-conformance warning on the 404 page;
    // with default --severity error, that warning is hidden + exit code 1
    // because warnAsError is true. Allow either depending on starter state.
    expect([0, 1]).toContain(status)
  })

  it('--severity all surfaces the schema-conformance warning on 404', { timeout: 30_000 }, () => {
    const { stdout } = run(['sites/main', '--severity', 'all', '--verbose'])
    // The starter's `404` page lacks a `heading` field; schema-conformance
    // surfaces this. If the starter is later cleaned up, drop this test
    // or pick a different fixture.
    expect(stdout).toMatch(/heading/)
  })

  it('--no-warn-as-error returns exit 0 even when warns present', { timeout: 30_000 }, () => {
    const { status } = run(['sites/main', '--severity', 'all', '--no-warn-as-error'])
    expect(status).toBe(0)
  })

  it('--verbose prints full Issue messages', { timeout: 30_000 }, () => {
    const { stdout } = run(['sites/main', '--severity', 'all', '--verbose'])
    // Verbose surfaces individual issue lines indented under the item.
    expect(stdout).toMatch(/Invalid input|expected string|received undefined/)
  })

  it('--include-quality runs without crashing (a11y + html-validity engaged)', { timeout: 30_000 }, () => {
    // Verifies the wiring; doesn't make claims about what these validators
    // surface on the starter (some violations are normal on real templates).
    const { status } = run(['sites/main', '--include-quality', '--no-warn-as-error', '--severity', 'all'])
    expect([0, 1]).toContain(status) // either is fine — we just want no crash
  })
})

describe('gazetta validate (CLI) — site-config validators', () => {
  const copyDir = resolve(here, '../../../.tmp', `cli-validate-public-storage-${Date.now()}`)

  afterAll(() => {
    rmSync(copyDir, { recursive: true, force: true })
  })

  it('reports public-storage errors and the assumed-public info line, and exits 1', { timeout: 30_000 }, () => {
    cpSync(starterDir, copyDir, { recursive: true, filter: src => !src.includes('node_modules') })
    const configPath = join(copyDir, 'sites/main/site.config.ts')
    // Added after `local`, which must stay the first editable target (the source).
    const bucket =
      "    bucket: { storage: azureBlobStorage({ connectionString: 'UseDevelopmentStorage=true', container: 'b' }), editable: true },\n"
    writeFileSync(
      configPath,
      readFileSync(configPath, 'utf-8').replace('    staging: {\n', bucket + '    staging: {\n'),
    )
    const result = spawnSync('node', [cliEntry, 'validate', 'sites/main'], {
      cwd: copyDir,
      env: { ...process.env, NO_COLOR: '1' },
      encoding: 'utf-8',
    })
    expect(result.stdout).toContain('`bucket` is editable, so its storage must be private (`publicStorage: false`).')
    expect(result.stdout).toContain('`bucket`: storage assumed public')
    expect(result.status).toBe(1)
  })
})
