/**
 * Tests for the gazetta.studio docs-page generator + sync check
 * (sites/gazetta.studio/scripts/docs-pages.ts).
 *
 * The generator turns docs/*.md + scripts/docs-nav.json into the published
 * /docs pages and nav fragment; the check fails CI when the committed pages
 * drift from the docs. Each documented failure condition names its fix, so
 * these tests assert on the fix text, not just the exit code.
 *
 * Tests spawn the script as a subprocess (node --import tsx), so no build
 * step is needed and the site files stay outside this package's tsconfig.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { spawnSync } from 'node:child_process'
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const repoRoot = resolve(here, '../../..')
const scriptPath = resolve(repoRoot, 'sites/gazetta.studio/scripts/docs-pages.ts')
const SPAWN_TIMEOUT = 60_000

function run(args: string[], cwd: string = repoRoot): { stdout: string; stderr: string; status: number | null } {
  const result = spawnSync(process.execPath, ['--import', 'tsx', scriptPath, ...args], {
    cwd,
    env: { ...process.env, NO_COLOR: '1' },
    encoding: 'utf-8',
    timeout: SPAWN_TIMEOUT,
  })
  return { stdout: result.stdout ?? '', stderr: result.stderr ?? '', status: result.status }
}

// --- Fixture: a miniature repo (docs + site + AGENTS.md) in .tmp ----------

const fixtureRoot = resolve(repoRoot, '.tmp', `site-docs-sync-${Date.now()}`)
const fixtureDocs = join(fixtureRoot, 'docs')
const fixtureSite = join(fixtureRoot, 'site')
const fixtureAgents = join(fixtureRoot, 'AGENTS.md')

const NAV = {
  banner: {
    text: 'Fixture banner.',
    securityClause: 'Release {version} lacks security fixes.',
    securityClauseVersion: '0.0.1',
    link: '[run from main](https://example.com/run-from-main)',
  },
  groups: [
    {
      title: 'Start',
      docs: [
        { file: 'getting-started.md', label: 'Getting started', description: 'Start here.' },
        { file: 'other.md', label: 'Other', description: 'Other page.' },
      ],
    },
  ],
  internal: [{ file: 'internal.md', title: 'Internal' }],
  removed: [],
}

const AGENTS = `# Fixture

**Public docs** (user-facing):
- \`docs/getting-started.md\` — Start here
- \`docs/other.md\` — Other page

**Design docs and team rules** live in \`.claude/rules/\`.
`

const GETTING_STARTED = `# Getting Started

See [the other page](./other.md), [a repo file](../README.md) and [an anchor](#install).

## Install

\`\`\`bash
npm install gazetta
\`\`\`
`

const OTHER = `# Other

Body text.
`

const INTERNAL = `# Internal

Not published.
`

function writeFixture(): void {
  mkdirSync(join(fixtureSite, 'scripts'), { recursive: true })
  writeFileSync(join(fixtureSite, 'scripts', 'docs-nav.json'), JSON.stringify(NAV, null, 2))
  mkdirSync(fixtureDocs, { recursive: true })
  writeFileSync(join(fixtureDocs, 'getting-started.md'), GETTING_STARTED)
  writeFileSync(join(fixtureDocs, 'other.md'), OTHER)
  writeFileSync(join(fixtureDocs, 'internal.md'), INTERNAL)
  writeFileSync(join(fixtureRoot, 'README.md'), '# Fixture readme\n')
  writeFileSync(fixtureAgents, AGENTS)
}

function fixtureArgs(extra: string[] = []): string[] {
  return [
    '--docs-dir',
    fixtureDocs,
    '--site-dir',
    fixtureSite,
    '--agents-md',
    fixtureAgents,
    '--version',
    '0.0.1',
    ...extra,
  ]
}

beforeAll(() => {
  writeFixture()
})

afterAll(() => {
  rmSync(fixtureRoot, { recursive: true, force: true })
})

describe('site docs sync check', () => {
  it(
    'the committed gazetta.studio docs pages are in sync with docs/',
    () => {
      const { stdout, stderr, status } = run(['--check'])
      expect(status, `${stdout}\n${stderr}`).toBe(0)
      expect(stdout).toContain('check passed')
    },
    SPAWN_TIMEOUT,
  )

  it(
    'write mode generates pages and the check then passes, idempotently',
    () => {
      const first = run(fixtureArgs())
      expect(first.status, `${first.stdout}\n${first.stderr}`).toBe(0)
      const second = run(fixtureArgs())
      expect(second.status).toBe(0)
      expect(second.stdout).toContain('0 written')
      const check = run(fixtureArgs(['--check']))
      expect(check.status, `${check.stdout}\n${check.stderr}`).toBe(0)
    },
    SPAWN_TIMEOUT,
  )

  it(
    'links between published docs become /docs/<slug> paths with GitHub-compatible anchors',
    () => {
      run(fixtureArgs())
      const index = JSON.parse(readFileSync(join(fixtureSite, 'targets/local/pages/docs/page.json'), 'utf-8')) as {
        components: { content?: string }[]
      }
      const content = index.components[2]?.content ?? ''
      expect(content).toContain('[the other page](/docs/other)')
      expect(content).toContain('[an anchor](#install)')
      expect(content).toContain('https://github.com/gazetta-studio/gazetta-studio/blob/main/README.md')
    },
    SPAWN_TIMEOUT,
  )

  it(
    'fails, naming "npm run docs:site", when a committed page is stale',
    () => {
      run(fixtureArgs())
      writeFileSync(join(fixtureDocs, 'other.md'), OTHER + '\nMore text.\n')
      const { stderr, status } = run(fixtureArgs(['--check']))
      expect(status).toBe(1)
      expect(stderr).toContain('run npm run docs:site')
      writeFileSync(join(fixtureDocs, 'other.md'), OTHER)
    },
    SPAWN_TIMEOUT,
  )

  it(
    'fails, naming the nav, when docs/ holds a file the nav does not mention',
    () => {
      run(fixtureArgs())
      writeFileSync(join(fixtureDocs, 'stray.md'), '# Stray\n')
      const { stderr, status } = run(fixtureArgs(['--check']))
      expect(status).toBe(1)
      expect(stderr).toContain('stray.md')
      expect(stderr).toContain('add it to a group or the internal list')
      rmSync(join(fixtureDocs, 'stray.md'))
    },
    SPAWN_TIMEOUT,
  )

  it(
    'fails, naming AGENTS.md, when the Public docs list differs from the nav',
    () => {
      run(fixtureArgs())
      writeFileSync(fixtureAgents, AGENTS.replace('- `docs/other.md` — Other page\n', ''))
      const { stderr, status } = run(fixtureArgs(['--check']))
      expect(status).toBe(1)
      expect(stderr).toContain('update the Public docs list in AGENTS.md')
      writeFileSync(fixtureAgents, AGENTS)
    },
    SPAWN_TIMEOUT,
  )

  it(
    'fails, naming the folder, when pages/docs/ holds a folder no published doc owns',
    () => {
      run(fixtureArgs())
      mkdirSync(join(fixtureSite, 'targets/local/pages/docs/bogus'), { recursive: true })
      writeFileSync(join(fixtureSite, 'targets/local/pages/docs/bogus/page.json'), '{}\n')
      const { stderr, status } = run(fixtureArgs(['--check']))
      expect(status).toBe(1)
      expect(stderr).toContain('does not belong to a published doc')
      rmSync(join(fixtureSite, 'targets/local/pages/docs/bogus'), { recursive: true, force: true })
    },
    SPAWN_TIMEOUT,
  )

  it(
    'fails with file and line when a doc has a dead link',
    () => {
      writeFileSync(join(fixtureDocs, 'other.md'), '# Other\n\nSee [missing](./missing.md).\n')
      const { stderr, status } = run(fixtureArgs(['--check']))
      expect(status).toBe(1)
      expect(stderr).toContain('other.md:3')
      expect(stderr).toContain('dead link')
      writeFileSync(join(fixtureDocs, 'other.md'), OTHER)
    },
    SPAWN_TIMEOUT,
  )

  it(
    'fails with file and line when a doc has raw HTML outside a code block',
    () => {
      writeFileSync(join(fixtureDocs, 'other.md'), '# Other\n\n<div class="x">raw</div>\n')
      const { stderr, status } = run(fixtureArgs(['--check']))
      expect(status).toBe(1)
      expect(stderr).toContain('other.md:3')
      expect(stderr).toContain('raw HTML')
      writeFileSync(join(fixtureDocs, 'other.md'), OTHER)
    },
    SPAWN_TIMEOUT,
  )

  it(
    'fails when a published doc has no H1',
    () => {
      writeFileSync(join(fixtureDocs, 'other.md'), '## No top heading\n\nText.\n')
      const { stderr, status } = run(fixtureArgs(['--check']))
      expect(status).toBe(1)
      expect(stderr).toContain('no H1')
      writeFileSync(join(fixtureDocs, 'other.md'), OTHER)
    },
    SPAWN_TIMEOUT,
  )

  it(
    'fails, naming the anchor, when a link targets a missing heading',
    () => {
      writeFileSync(join(fixtureDocs, 'other.md'), '# Other\n\nSee [start](./getting-started.md#nope).\n')
      const { stderr, status } = run(fixtureArgs(['--check']))
      expect(status).toBe(1)
      expect(stderr).toContain('missing anchor #nope')
      writeFileSync(join(fixtureDocs, 'other.md'), OTHER)
    },
    SPAWN_TIMEOUT,
  )
  it(
    'the banner names the Gazetta version and drops its security clause at the next release',
    () => {
      run(fixtureArgs())
      const page = () =>
        JSON.parse(readFileSync(join(fixtureSite, 'targets/local/pages/docs/other/page.json'), 'utf-8')) as {
          components: { content?: string }[]
        }
      expect(page().components[2]?.content).toContain('Release 0.0.1 lacks security fixes.')
      run(fixtureArgs(['--version', '9.9.9']))
      const bumped = page().components[2]?.content ?? ''
      expect(bumped).toContain('Fixture banner.')
      expect(bumped).not.toContain('security fixes')
      run(fixtureArgs())
      expect(page().components[2]?.content).toContain('Release 0.0.1 lacks security fixes.')
    },
    SPAWN_TIMEOUT,
  )

  it(
    'a folder listed in the nav removed list is neither flagged nor pruned',
    () => {
      run(fixtureArgs())
      writeFileSync(
        join(fixtureSite, 'scripts', 'docs-nav.json'),
        JSON.stringify({ ...NAV, removed: ['old-doc'] }, null, 2),
      )
      mkdirSync(join(fixtureSite, 'targets/local/pages/docs/old-doc'), { recursive: true })
      writeFileSync(join(fixtureSite, 'targets/local/pages/docs/old-doc/page.json'), '{}\n')
      const check = run(fixtureArgs(['--check']))
      expect(check.status, `${check.stdout}\n${check.stderr}`).toBe(0)
      run(fixtureArgs())
      expect(existsSync(join(fixtureSite, 'targets/local/pages/docs/old-doc/page.json'))).toBe(true)
      writeFileSync(join(fixtureSite, 'scripts', 'docs-nav.json'), JSON.stringify(NAV, null, 2))
      rmSync(join(fixtureSite, 'targets/local/pages/docs/old-doc'), { recursive: true, force: true })
    },
    SPAWN_TIMEOUT,
  )
})
