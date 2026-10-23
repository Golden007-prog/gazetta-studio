/**
 * PR screenshots hosted as GitHub Release assets (ADR-0016 "Screenshots
 * embedded in the PR").
 *
 * Release assets because they are token-only (`gh release upload`), served
 * publicly as raw bytes that render inline, and never part of a branch: a
 * PNG committed to the cut branch would merge into `main`'s history under
 * every merge strategy. One rolling release holds every cut's assets; each
 * run prunes the assets of cuts whose PR is no longer open.
 *
 * Every function returns a result instead of throwing: screenshots are an
 * enhancement, and a hosting failure must never block a PR or a merge.
 */
import { spawnSync } from 'node:child_process'
import { basename } from 'node:path'

export const SCREENSHOT_RELEASE_TAG = 'bot-screenshots'

export interface RepoSlug {
  owner: string
  repo: string
}

export type GhResult = { ok: true; stdout: string } | { ok: false; error: string }
export type GhRunner = (args: readonly string[]) => GhResult

export const runGhCapture: GhRunner = args => {
  const r = spawnSync('gh', [...args], { stdio: ['ignore', 'pipe', 'pipe'], encoding: 'utf-8' })
  if (r.status === 0) return { ok: true, stdout: r.stdout ?? '' }
  return { ok: false, error: (r.stderr?.trim() || r.error?.message || `gh exited ${r.status}`).slice(0, 1000) }
}

function slugPart(s: string): string {
  return (
    s
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '') || 'x'
  )
}

/** `cut-{N}-{component}-{state}.png` — the cut prefix is what reconciliation keys on. */
export function screenshotAssetName(cut: number, component: string, state: string): string {
  return `cut-${cut}-${slugPart(component)}-${slugPart(state)}.png`
}

/** The cut number an asset belongs to, or null for anything else in the release. */
export function cutOfAsset(name: string): number | null {
  const m = /^cut-(\d+)-.+\.png$/.exec(name)
  return m ? Number(m[1]) : null
}

export function screenshotAssetUrl(repo: RepoSlug, name: string): string {
  return `https://github.com/${repo.owner}/${repo.repo}/releases/download/${SCREENSHOT_RELEASE_TAG}/${encodeURIComponent(name)}`
}

function repoArg(repo: RepoSlug): string[] {
  return ['-R', `${repo.owner}/${repo.repo}`]
}

function ensureRelease(repo: RepoSlug, gh: GhRunner): GhResult {
  const view = gh(['release', 'view', SCREENSHOT_RELEASE_TAG, ...repoArg(repo), '--json', 'tagName'])
  if (view.ok) return view
  return gh([
    'release',
    'create',
    SCREENSHOT_RELEASE_TAG,
    ...repoArg(repo),
    '--prerelease',
    '--title',
    'Bot screenshots',
    '--notes',
    'Story screenshots embedded in feature-bot PRs. Assets are deleted once their PR is merged or closed; this release stays as their container.',
  ])
}

export type UploadResult = { ok: true; assets: { name: string; url: string }[] } | { ok: false; error: string }

/**
 * Upload PNGs whose file names are already asset names
 * (`screenshotAssetName`). `--clobber` so a re-attempt of the same cut
 * replaces its earlier shots.
 */
export function uploadScreenshots(repo: RepoSlug, files: readonly string[], gh: GhRunner = runGhCapture): UploadResult {
  if (files.length === 0) return { ok: true, assets: [] }
  const release = ensureRelease(repo, gh)
  if (!release.ok)
    return { ok: false, error: `couldn't find or create the ${SCREENSHOT_RELEASE_TAG} release: ${release.error}` }
  const up = gh(['release', 'upload', SCREENSHOT_RELEASE_TAG, ...files, ...repoArg(repo), '--clobber'])
  if (!up.ok) return { ok: false, error: `upload failed: ${up.error}` }
  return {
    ok: true,
    assets: files.map(f => {
      const name = basename(f)
      return { name, url: screenshotAssetUrl(repo, name) }
    }),
  }
}

function listAssets(repo: RepoSlug, gh: GhRunner): { ok: true; names: string[] } | { ok: false; error: string } {
  const r = gh(['release', 'view', SCREENSHOT_RELEASE_TAG, ...repoArg(repo), '--json', 'assets'])
  if (!r.ok) {
    // No release yet means no assets to prune.
    if (/release not found|not found/i.test(r.error)) return { ok: true, names: [] }
    return r
  }
  try {
    const parsed = JSON.parse(r.stdout) as { assets?: { name?: string }[] }
    return { ok: true, names: (parsed.assets ?? []).map(a => a.name ?? '').filter(Boolean) }
  } catch (err) {
    return { ok: false, error: `unreadable release JSON: ${err}` }
  }
}

/** True when the cut's branch has an open PR; null when GitHub couldn't be asked. */
function cutHasOpenPr(repo: RepoSlug, cut: number, gh: GhRunner): boolean | null {
  const r = gh(['pr', 'list', ...repoArg(repo), '--head', `feat/cut-${cut}`, '--state', 'all', '--json', 'state'])
  if (!r.ok) return null
  try {
    const prs = JSON.parse(r.stdout) as { state?: string }[]
    return prs.some(p => p.state === 'OPEN')
  } catch {
    return null
  }
}

export interface ReconcileReport {
  deleted: string[]
  kept: string[]
  errors: string[]
}

/**
 * Delete the assets of every cut without an open PR (merged, closed, or
 * never opened). Assets of open PRs stay; when a PR's state can't be read
 * its assets stay too, since deleting a live PR's images is the worse
 * mistake and the next run tries again.
 */
export function reconcileScreenshotAssets(repo: RepoSlug, gh: GhRunner = runGhCapture): ReconcileReport {
  const report: ReconcileReport = { deleted: [], kept: [], errors: [] }
  const listed = listAssets(repo, gh)
  if (!listed.ok) {
    report.errors.push(listed.error)
    return report
  }
  const byCut = new Map<number, string[]>()
  for (const name of listed.names) {
    const cut = cutOfAsset(name)
    if (cut === null) continue
    byCut.set(cut, [...(byCut.get(cut) ?? []), name])
  }
  for (const [cut, names] of byCut) {
    const open = cutHasOpenPr(repo, cut, gh)
    if (open !== false) {
      report.kept.push(...names)
      if (open === null) report.errors.push(`couldn't read PR state for cut #${cut}; kept its screenshots`)
      continue
    }
    for (const name of names) {
      const del = gh(['release', 'delete-asset', SCREENSHOT_RELEASE_TAG, name, ...repoArg(repo), '--yes'])
      if (del.ok) report.deleted.push(name)
      else report.errors.push(`couldn't delete ${name}: ${del.error}`)
    }
  }
  return report
}
