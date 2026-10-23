/**
 * Visual self-check for UX cuts (ADR-0016, review-workflow Cut 20).
 *
 * When a cut adds or changes a story or the component a story renders, the
 * orchestrator builds Storybook, screenshots each affected story before
 * Agent B runs, hands Agent B the URL and the PNG paths, and later embeds
 * the same PNGs in the PR body. Every step degrades to "no visual check":
 * the screenshots are advisory input to the review, never a gate.
 */
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, join, relative, resolve } from 'node:path'
import {
  type RepoSlug,
  type GhRunner,
  runGhCapture,
  screenshotAssetName,
  uploadScreenshots,
} from '../_lib/release-assets.js'
import { captureScreenshots, ensureChromium, type ShotOutcome } from '../_lib/screenshot.js'
import {
  readStoryIndex,
  runCommand,
  startStorybook,
  type RunCommand,
  type StoryEntry,
  type StorybookResult,
  storyUrl,
} from '../_lib/storybook-server.js'

const STORY_FILE = /\.stories\.(ts|js)$/
/** Bounds the capture time on a cut that touches a component used by many stories. */
export const MAX_SHOTS = 40

/**
 * The story files a diff affects: each changed story file, plus the sibling
 * `X.stories.ts` of each changed `X.vue` / `X.ts` component.
 */
export function affectedStoryFiles(changedFiles: readonly string[], exists: (path: string) => boolean): string[] {
  const out = new Set<string>()
  for (const file of changedFiles) {
    if (STORY_FILE.test(file)) {
      if (exists(file)) out.add(file)
      continue
    }
    const m = /^(.*)\.(vue|ts)$/.exec(file)
    if (!m) continue
    for (const ext of ['ts', 'js']) {
      const sibling = `${m[1]}.stories.${ext}`
      if (exists(sibling)) out.add(sibling)
    }
  }
  return [...out].sort()
}

export interface StoryShot {
  storyId: string
  /** Story id before `--`, e.g. `validation-banner`. */
  component: string
  /** Story id after `--`, e.g. `single-error`. */
  state: string
  url: string
  /** PNG path; its file name is the release asset name. */
  path: string
}

export function planShots(
  index: readonly StoryEntry[],
  storyFiles: readonly string[],
  o: { baseUrl: string; issueNumber: number; outDir: string; max?: number },
): StoryShot[] {
  const wanted = new Set(storyFiles)
  return index
    .filter(e => wanted.has(e.importPath))
    .slice(0, o.max ?? MAX_SHOTS)
    .map(e => {
      const [component, state = 'default'] = e.id.split('--')
      return {
        storyId: e.id,
        component,
        state,
        url: storyUrl(o.baseUrl, e.id),
        path: join(o.outDir, screenshotAssetName(o.issueNumber, component, state)),
      }
    })
}

/**
 * Where a cut's screenshots are written: the OS temp dir, never the
 * repository, so no screenshot can be committed with the cut.
 */
export function screenshotDir(issueNumber: number, attempt: number, base = tmpdir()): string {
  return join(base, 'feature-bot-screenshots', `cut-${issueNumber}-attempt${attempt}`)
}

export function isInsideRepo(path: string, repoRoot: string): boolean {
  const rel = relative(resolve(repoRoot), resolve(path))
  return rel === '' || (!rel.startsWith('..') && !rel.startsWith('/'))
}

export type VisualCheck =
  | { kind: 'none' }
  | { kind: 'skipped'; reason: string }
  | { kind: 'ready'; storybookUrl: string; shots: StoryShot[]; failures: string[]; stop(): Promise<void> }

export interface VisualCheckDeps {
  exists?: (path: string) => boolean
  run?: RunCommand
  startStorybook?: typeof startStorybook
  ensureChromium?: (cwd: string) => { ok: true } | { ok: false; error: string }
  capture?: (shots: { url: string; path: string }[]) => Promise<ShotOutcome[]>
}

/**
 * Build + serve Storybook and capture the affected stories. `none` when the
 * cut touches no story (nothing is built); `skipped` with a reason on any
 * failure. Never throws.
 */
export async function prepareVisualCheck(
  o: { cwd: string; changedFiles: readonly string[]; issueNumber: number; attempt: number },
  deps: VisualCheckDeps = {},
): Promise<VisualCheck> {
  const exists = deps.exists ?? ((p: string) => existsSync(resolve(o.cwd, p)))
  const storyFiles = affectedStoryFiles(o.changedFiles, exists)
  if (storyFiles.length === 0) return { kind: 'none' }

  const outDir = screenshotDir(o.issueNumber, o.attempt)
  const sb: StorybookResult = await (deps.startStorybook ?? startStorybook)({
    cwd: o.cwd,
    outputDir: join(dirname(outDir), `storybook-static-${basename(outDir)}`),
    run: deps.run ?? runCommand,
  })
  if (sb.kind === 'skipped') return sb

  const stopAndSkip = async (reason: string): Promise<VisualCheck> => {
    await sb.stop().catch(() => {})
    return { kind: 'skipped', reason }
  }
  const browser = (deps.ensureChromium ?? ensureChromium)(o.cwd)
  if (!browser.ok) return stopAndSkip(`couldn't install Chromium: ${browser.error}`)

  const shots = planShots(readStoryIndex(sb.outputDir), storyFiles, {
    baseUrl: sb.url,
    issueNumber: o.issueNumber,
    outDir,
  })
  if (shots.length === 0) return stopAndSkip(`no built story matches ${storyFiles.join(', ')}`)

  const outcomes = await (
    deps.capture ?? (s => captureScreenshots(s, undefined, { readySelector: '#storybook-root > *' }))
  )(shots.map(s => ({ url: s.url, path: s.path })))
  const ok = new Set(outcomes.filter(r => r.ok).map(r => r.path))
  const failures = outcomes.filter(r => !r.ok).map(r => `${r.url}: ${'error' in r ? r.error : ''}`)
  const captured = shots.filter(s => ok.has(s.path))
  if (captured.length === 0) return stopAndSkip(`every screenshot failed: ${failures.slice(0, 3).join('; ')}`)
  return { kind: 'ready', storybookUrl: sb.url, shots: captured, failures, stop: sb.stop }
}

/** The lines appended to Agent B's prompt. */
export function reviewerVisualInputs(check: VisualCheck): string {
  if (check.kind === 'none') return 'VISUAL_CHECK=none (the diff touches no story or story component)'
  if (check.kind === 'skipped') return `VISUAL_CHECK=skipped (${check.reason.slice(0, 300)})`
  const lines = check.shots.map(s => `- ${s.storyId}: ${s.path}  (${s.url})`)
  return `VISUAL_CHECK=ready
STORYBOOK_URL=${check.storybookUrl}
STORY_SCREENSHOTS=
${lines.join('\n')}${check.failures.length ? `\nSCREENSHOT_FAILURES=\n${check.failures.map(f => `- ${f}`).join('\n')}` : ''}`
}

export const SCREENSHOTS_UNAVAILABLE_NOTE = '_(story screenshots unavailable — run `npm run storybook` on the branch)_'

/**
 * The PR body's `## Story screenshots` section, grouped by component.
 * Empty string when the cut touched no story. On an upload failure the
 * section holds the fallback note, so the PR still opens.
 */
export function storyScreenshotsSection(
  check: VisualCheck,
  repo: RepoSlug,
  gh: GhRunner = runGhCapture,
  log: (msg: string) => void = () => {},
): string {
  if (check.kind === 'none') return ''
  if (check.kind === 'skipped') {
    log(`story screenshots unavailable: ${check.reason}`)
    return `## Story screenshots\n\n${SCREENSHOTS_UNAVAILABLE_NOTE}\n`
  }
  const uploaded = uploadScreenshots(
    repo,
    check.shots.map(s => s.path),
    gh,
  )
  if (!uploaded.ok) {
    log(`story screenshots unavailable: ${uploaded.error}`)
    return `## Story screenshots\n\n${SCREENSHOTS_UNAVAILABLE_NOTE}\n`
  }
  const urlByName = new Map(uploaded.assets.map(a => [a.name, a.url]))
  const groups = new Map<string, StoryShot[]>()
  for (const s of check.shots) groups.set(s.component, [...(groups.get(s.component) ?? []), s])
  const parts = ['## Story screenshots', '']
  for (const [component, shots] of groups) {
    parts.push(`### \`${component}\``, '')
    for (const s of shots) {
      const url = urlByName.get(basename(s.path))
      if (url) parts.push(`**${s.state}**`, '', `![${s.storyId}](${url})`, '')
    }
  }
  return parts.join('\n')
}
