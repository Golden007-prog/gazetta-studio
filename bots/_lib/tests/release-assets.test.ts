import { describe, expect, it } from 'vitest'
import {
  cutOfAsset,
  type GhResult,
  reconcileScreenshotAssets,
  screenshotAssetName,
  screenshotAssetUrl,
  uploadScreenshots,
} from '../release-assets.js'

const REPO = { owner: 'gazetta-studio', repo: 'gazetta-studio' }

/** A fake `gh`: answers by matching the first args, records every call. */
function fakeGh(answer: (args: readonly string[]) => GhResult) {
  const calls: string[][] = []
  const gh = (args: readonly string[]) => {
    calls.push([...args])
    return answer(args)
  }
  return { gh, calls }
}

const ok = (stdout = ''): GhResult => ({ ok: true, stdout })
const fail = (error: string): GhResult => ({ ok: false, error })

describe('asset names', () => {
  it.each([
    [535, 'validation-banner', 'single-error', 'cut-535-validation-banner-single-error.png'],
    [11, 'Review Banner', 'Draft/Rejected!', 'cut-11-review-banner-draft-rejected.png'],
  ])('cut %i %s %s → %s', (cut, component, state, name) => {
    expect(screenshotAssetName(cut, component, state)).toBe(name)
    expect(cutOfAsset(name)).toBe(cut)
  })

  it('ignores assets that are not cut screenshots', () => {
    expect(cutOfAsset('notes.txt')).toBeNull()
    expect(cutOfAsset('cut-x-a.png')).toBeNull()
  })

  it('builds the public download URL', () => {
    expect(screenshotAssetUrl(REPO, 'cut-1-a-b.png')).toBe(
      'https://github.com/gazetta-studio/gazetta-studio/releases/download/bot-screenshots/cut-1-a-b.png',
    )
  })
})

describe('uploadScreenshots', () => {
  it('uploads to the existing release with --clobber and returns the public URLs', () => {
    const { gh, calls } = fakeGh(() => ok('{}'))
    const r = uploadScreenshots(REPO, ['/tmp/x/cut-5-banner-error.png'], gh)
    expect(r).toEqual({
      ok: true,
      assets: [
        {
          name: 'cut-5-banner-error.png',
          url: 'https://github.com/gazetta-studio/gazetta-studio/releases/download/bot-screenshots/cut-5-banner-error.png',
        },
      ],
    })
    expect(calls.map(c => c.slice(0, 2))).toEqual([
      ['release', 'view'],
      ['release', 'upload'],
    ])
    expect(calls[1]).toEqual(expect.arrayContaining(['bot-screenshots', '/tmp/x/cut-5-banner-error.png', '--clobber']))
  })

  it('creates the release when it does not exist yet', () => {
    const { gh, calls } = fakeGh(args => (args[1] === 'view' ? fail('release not found') : ok()))
    expect(uploadScreenshots(REPO, ['/t/cut-1-a-b.png'], gh).ok).toBe(true)
    expect(calls.map(c => c[1])).toEqual(['view', 'create', 'upload'])
    expect(calls[1]).toContain('--prerelease')
  })

  it.each([
    [
      'the upload fails',
      (a: readonly string[]) => (a[1] === 'upload' ? fail('HTTP 403') : ok()),
      /upload failed: HTTP 403/,
    ],
    ['the release cannot be created', () => fail('HTTP 403'), /couldn't find or create/],
  ])('returns a failure sentinel when %s', (_, answer, error) => {
    const { gh } = fakeGh(answer)
    const r = uploadScreenshots(REPO, ['/t/cut-1-a-b.png'], gh)
    expect(r.ok).toBe(false)
    expect(r.ok === false && r.error).toMatch(error)
  })

  it('does nothing for no files', () => {
    const { gh, calls } = fakeGh(() => ok())
    expect(uploadScreenshots(REPO, [], gh)).toEqual({ ok: true, assets: [] })
    expect(calls).toEqual([])
  })
})

describe('reconcileScreenshotAssets', () => {
  const assets = [
    'cut-1-banner-a.png',
    'cut-1-banner-b.png',
    'cut-2-banner-a.png',
    'cut-3-banner-a.png',
    'cut-4-banner-a.png',
    'README.txt',
  ]
  const prStates: Record<string, string[]> = {
    'feat/cut-1': ['OPEN'],
    'feat/cut-2': ['MERGED'],
    'feat/cut-3': ['CLOSED'],
    'feat/cut-4': [],
  }
  const answer = (args: readonly string[]): GhResult => {
    if (args[0] === 'release' && args[1] === 'view')
      return ok(JSON.stringify({ assets: assets.map(name => ({ name })) }))
    if (args[0] === 'pr') {
      const head = args[args.indexOf('--head') + 1]
      return ok(JSON.stringify(prStates[head].map(state => ({ state }))))
    }
    return ok()
  }

  it('keeps open PRs’ screenshots and deletes merged, closed and PR-less cuts’ screenshots', () => {
    const { gh, calls } = fakeGh(answer)
    const r = reconcileScreenshotAssets(REPO, gh)
    expect(r.kept.sort()).toEqual(['cut-1-banner-a.png', 'cut-1-banner-b.png'])
    expect(r.deleted.sort()).toEqual(['cut-2-banner-a.png', 'cut-3-banner-a.png', 'cut-4-banner-a.png'])
    expect(r.errors).toEqual([])
    const deletes = calls.filter(c => c[1] === 'delete-asset').map(c => c[3])
    expect(deletes).not.toContain('README.txt')
  })

  it('logs a failed delete and carries on with the rest', () => {
    const { gh } = fakeGh(args =>
      args[1] === 'delete-asset' && args[3] === 'cut-2-banner-a.png' ? fail('HTTP 500') : answer(args),
    )
    const r = reconcileScreenshotAssets(REPO, gh)
    expect(r.deleted.sort()).toEqual(['cut-3-banner-a.png', 'cut-4-banner-a.png'])
    expect(r.errors).toEqual(["couldn't delete cut-2-banner-a.png: HTTP 500"])
  })

  it('keeps a cut’s screenshots when its PR state cannot be read', () => {
    const { gh } = fakeGh(args => (args[0] === 'pr' ? fail('HTTP 502') : answer(args)))
    const r = reconcileScreenshotAssets(REPO, gh)
    expect(r.deleted).toEqual([])
    expect(r.kept).toHaveLength(5)
    expect(r.errors).toHaveLength(4)
  })

  it('has nothing to do when the release does not exist', () => {
    const { gh } = fakeGh(() => fail('release not found'))
    expect(reconcileScreenshotAssets(REPO, gh)).toEqual({ deleted: [], kept: [], errors: [] })
  })

  it('reports, without throwing, when the release cannot be listed', () => {
    const { gh } = fakeGh(() => fail('HTTP 401: Bad credentials'))
    expect(reconcileScreenshotAssets(REPO, gh).errors).toEqual(['HTTP 401: Bad credentials'])
  })
})
