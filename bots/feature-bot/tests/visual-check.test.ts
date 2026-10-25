import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { GhResult } from '../../_lib/release-assets.js'
import type { StorybookResult } from '../../_lib/storybook-server.js'
import {
  affectedStoryFiles,
  isInsideRepo,
  planShots,
  prepareVisualCheck,
  reviewerVisualInputs,
  SCREENSHOTS_UNAVAILABLE_NOTE,
  screenshotDir,
  storyScreenshotsSection,
  type VisualCheck,
} from '../visual-check.js'

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../..')
const REPO = { owner: 'gazetta-studio', repo: 'gazetta-studio' }
const C = 'apps/admin/src/client/components'

describe('affectedStoryFiles', () => {
  const existing = new Set([`${C}/Banner.stories.ts`, `${C}/ReviewBanner.stories.ts`])
  const exists = (p: string) => existing.has(p)

  it.each([
    ['a changed story file', [`${C}/Banner.stories.ts`], [`${C}/Banner.stories.ts`]],
    ['a changed component with a sibling story', [`${C}/ReviewBanner.vue`], [`${C}/ReviewBanner.stories.ts`]],
    ['a component without a story', [`${C}/SiteTree.vue`], []],
    ['a bots-only diff', ['bots/_lib/screenshot.ts', 'bots/README.md'], []],
    ['a deleted story file', [`${C}/Old.stories.ts`], []],
    ['component and story together, once', [`${C}/Banner.vue`, `${C}/Banner.stories.ts`], [`${C}/Banner.stories.ts`]],
  ])('%s', (_, changed, expected) => {
    expect(affectedStoryFiles(changed, exists)).toEqual(expected)
  })
})

describe('planShots', () => {
  const index = [
    { id: 'banner--error', title: 'B', name: 'Error', importPath: `${C}/Banner.stories.ts` },
    { id: 'banner--info', title: 'B', name: 'Info', importPath: `${C}/Banner.stories.ts` },
    { id: 'state-badge--dot', title: 'S', name: 'Dot', importPath: `${C}/StateBadge.stories.ts` },
  ]

  it('plans one shot per story of the affected files, named as release assets', () => {
    const shots = planShots(index, [`${C}/Banner.stories.ts`], { baseUrl: 'http://sb', issueNumber: 535, outDir: '/t' })
    expect(shots).toEqual([
      {
        storyId: 'banner--error',
        component: 'banner',
        state: 'error',
        url: 'http://sb/iframe.html?id=banner--error&viewMode=story',
        path: '/t/cut-535-banner-error.png',
      },
      expect.objectContaining({ storyId: 'banner--info', path: '/t/cut-535-banner-info.png' }),
    ])
  })

  it('caps the number of shots', () => {
    expect(
      planShots(index, [`${C}/Banner.stories.ts`], { baseUrl: 'x', issueNumber: 1, outDir: '/t', max: 1 }),
    ).toHaveLength(1)
  })
})

describe('screenshots stay out of the repository', () => {
  it('writes them under the OS temp dir, not the checkout', () => {
    const dir = screenshotDir(535, 1)
    expect(dir.startsWith(tmpdir())).toBe(true)
    expect(isInsideRepo(dir, REPO_ROOT)).toBe(false)
  })

  it('isInsideRepo tells the two apart', () => {
    expect(isInsideRepo(join(REPO_ROOT, 'bots', 'x.png'), REPO_ROOT)).toBe(true)
    expect(isInsideRepo(join(REPO_ROOT, '..', 'x.png'), REPO_ROOT)).toBe(false)
  })

  it('prepareVisualCheck skips without starting Storybook when the temp base is inside the checkout (#1412)', async () => {
    // TMPDIR pointing into the working tree would put screenshots
    // where Agent A's commit could pick them up.
    const prev = process.env.TMPDIR
    process.env.TMPDIR = join(REPO_ROOT, '.tmp-visual-check')
    try {
      let storybookStarted = false
      const result = await prepareVisualCheck(
        { cwd: REPO_ROOT, changedFiles: [`${C}/Banner.stories.ts`], issueNumber: 535, attempt: 1 },
        {
          exists: () => true,
          startStorybook: async (): Promise<StorybookResult> => {
            storybookStarted = true
            throw new Error('startStorybook must not be called')
          },
        },
      )
      expect(result).toEqual({ kind: 'skipped', reason: 'the screenshot folder is inside the repository' })
      expect(storybookStarted).toBe(false)
    } finally {
      if (prev === undefined) delete process.env.TMPDIR
      else process.env.TMPDIR = prev
    }
  })
})

describe('prepareVisualCheck', () => {
  const storyChange = [`${C}/Banner.stories.ts`]
  const exists = (p: string) => p === `${C}/Banner.stories.ts`
  let outputDir: string
  let stopped: number

  beforeEach(() => {
    outputDir = mkdtempSync(join(tmpdir(), 'vc-'))
    stopped = 0
    writeFileSync(
      join(outputDir, 'index.json'),
      JSON.stringify({
        entries: {
          a: { type: 'story', id: 'banner--error', importPath: `./${C}/Banner.stories.ts` },
          b: { type: 'story', id: 'banner--info', importPath: `./${C}/Banner.stories.ts` },
        },
      }),
    )
  })
  afterEach(() => rmSync(outputDir, { recursive: true, force: true }))

  const served = async (): Promise<StorybookResult> => ({
    kind: 'served',
    url: 'http://127.0.0.1:9',
    outputDir,
    stop: async () => {
      stopped++
    },
  })

  it('builds nothing for a cut that touches no story', async () => {
    let built = 0
    const r = await prepareVisualCheck(
      { cwd: REPO_ROOT, changedFiles: ['bots/x.ts'], issueNumber: 1, attempt: 1 },
      {
        exists,
        startStorybook: async () => {
          built++
          return served()
        },
      },
    )
    expect(r).toEqual({ kind: 'none' })
    expect(built).toBe(0)
  })

  it('is skipped, so the review runs without it, when the Storybook build fails', async () => {
    const r = await prepareVisualCheck(
      { cwd: REPO_ROOT, changedFiles: storyChange, issueNumber: 1, attempt: 1 },
      { exists, startStorybook: async () => ({ kind: 'skipped', reason: 'Storybook build failed: boom' }) },
    )
    expect(r).toEqual({ kind: 'skipped', reason: 'Storybook build failed: boom' })
  })

  it('stops the server and skips when Chromium cannot be installed', async () => {
    const r = await prepareVisualCheck(
      { cwd: REPO_ROOT, changedFiles: storyChange, issueNumber: 1, attempt: 1 },
      { exists, startStorybook: served, ensureChromium: () => ({ ok: false, error: 'offline' }) },
    )
    expect(r).toEqual({ kind: 'skipped', reason: "couldn't install Chromium: offline" })
    expect(stopped).toBe(1)
  })

  it('captures each affected story and keeps the server for Agent B', async () => {
    const asked: string[] = []
    const r = await prepareVisualCheck(
      { cwd: REPO_ROOT, changedFiles: storyChange, issueNumber: 7, attempt: 2 },
      {
        exists,
        startStorybook: served,
        ensureChromium: () => ({ ok: true }),
        capture: async shots => {
          asked.push(...shots.map(s => s.url))
          return shots.map((s, i) => (i === 0 ? { ...s, ok: true } : { ...s, ok: false, error: 'timeout' }))
        },
      },
    )
    expect(asked).toEqual([
      'http://127.0.0.1:9/iframe.html?id=banner--error&viewMode=story',
      'http://127.0.0.1:9/iframe.html?id=banner--info&viewMode=story',
    ])
    expect(r.kind).toBe('ready')
    if (r.kind !== 'ready') return
    expect(r.shots.map(s => basename(s.path))).toEqual(['cut-7-banner-error.png'])
    expect(r.failures).toEqual(['http://127.0.0.1:9/iframe.html?id=banner--info&viewMode=story: timeout'])
    expect(stopped).toBe(0)
  })

  it('skips when every screenshot fails', async () => {
    const r = await prepareVisualCheck(
      { cwd: REPO_ROOT, changedFiles: storyChange, issueNumber: 7, attempt: 1 },
      {
        exists,
        startStorybook: served,
        ensureChromium: () => ({ ok: true }),
        capture: async shots => shots.map(s => ({ ...s, ok: false as const, error: 'blank' })),
      },
    )
    expect(r.kind).toBe('skipped')
    expect(stopped).toBe(1)
  })
})

const ready: VisualCheck = {
  kind: 'ready',
  storybookUrl: 'http://127.0.0.1:9',
  failures: [],
  stop: async () => {},
  shots: [
    { storyId: 'banner--error', component: 'banner', state: 'error', url: 'u1', path: '/t/cut-7-banner-error.png' },
    { storyId: 'banner--info', component: 'banner', state: 'info', url: 'u2', path: '/t/cut-7-banner-info.png' },
    {
      storyId: 'state-badge--dot',
      component: 'state-badge',
      state: 'dot',
      url: 'u3',
      path: '/t/cut-7-state-badge-dot.png',
    },
  ],
}

describe('reviewerVisualInputs', () => {
  it('gives Agent B the Storybook URL and every screenshot path', () => {
    const text = reviewerVisualInputs(ready)
    expect(text).toMatch(/^VISUAL_CHECK=ready$/m)
    expect(text).toMatch(/^STORYBOOK_URL=http:\/\/127\.0\.0\.1:9$/m)
    expect(text).toContain('- banner--error: /t/cut-7-banner-error.png  (u1)')
  })

  it.each([
    [{ kind: 'none' } as VisualCheck, /^VISUAL_CHECK=none/],
    [{ kind: 'skipped', reason: 'build failed' } as VisualCheck, /^VISUAL_CHECK=skipped \(build failed\)/],
  ])('says when there is nothing to look at', (check, line) => {
    expect(reviewerVisualInputs(check)).toMatch(line)
  })
})

describe('storyScreenshotsSection', () => {
  const okGh = () => {
    const calls: string[][] = []
    return {
      calls,
      gh: (args: readonly string[]): GhResult => {
        calls.push([...args])
        return { ok: true, stdout: '{}' }
      },
    }
  }

  it('uploads and embeds each screenshot inline, grouped by component', () => {
    const { gh, calls } = okGh()
    const md = storyScreenshotsSection(ready, REPO, gh)
    expect(md.startsWith('## Story screenshots')).toBe(true)
    expect(md).toContain('### `banner`')
    expect(md).toContain('### `state-badge`')
    expect(md).toContain(
      '![banner--error](https://github.com/gazetta-studio/gazetta-studio/releases/download/bot-screenshots/cut-7-banner-error.png)',
    )
    expect(md.indexOf('banner--info')).toBeLessThan(md.indexOf('### `state-badge`'))
    expect(calls.find(c => c[1] === 'upload')).toEqual(
      expect.arrayContaining(['/t/cut-7-banner-error.png', '/t/cut-7-state-badge-dot.png']),
    )
  })

  it('falls back to the note, and logs, when the upload fails', () => {
    const logs: string[] = []
    const md = storyScreenshotsSection(
      ready,
      REPO,
      args => (args[1] === 'upload' ? { ok: false, error: 'HTTP 403' } : { ok: true, stdout: '' }),
      m => logs.push(m),
    )
    expect(md).toBe(`## Story screenshots\n\n${SCREENSHOTS_UNAVAILABLE_NOTE}\n`)
    expect(logs[0]).toMatch(/HTTP 403/)
  })

  it('shows the note without uploading when the visual check was skipped', () => {
    const { gh, calls } = okGh()
    expect(storyScreenshotsSection({ kind: 'skipped', reason: 'x' }, REPO, gh)).toContain(SCREENSHOTS_UNAVAILABLE_NOTE)
    expect(calls).toEqual([])
  })

  it('adds no section to a PR that touches no story', () => {
    const { gh, calls } = okGh()
    expect(storyScreenshotsSection({ kind: 'none' }, REPO, gh)).toBe('')
    expect(calls).toEqual([])
  })
})
