import { describe, expect, it, vi } from 'vitest'
import { type CloseEvent, classifyLanding, fetchCloseEvent } from '../cut-landing.js'

const pr = (over: Partial<NonNullable<CloseEvent['closer']>> = {}) => ({
  number: 1,
  title: 'unrelated',
  merged: true,
  headRefName: 'some-branch',
  body: null,
  ...over,
})

describe('classifyLanding', () => {
  it('#517: closed as completed by #557, a PR that only mentioned it, is unverified', () => {
    // Real closure, 2026-06-09: stateReason COMPLETED, closer = merged #557.
    const event: CloseEvent = {
      stateReason: 'COMPLETED',
      closer: pr({
        number: 557,
        title: 'fix(feature-bot): require Note: on REJECT (symmetric to #548 APPROVE Reasoning)',
        headRefName: 'fix/feature-bot-reject-note',
        body: "## Bug (surfaced by #517's escalation today)",
      }),
    }
    expect(classifyLanding(517, event)).toBe('unverified')
  })

  it.each([
    ['the PR title names the cut (human PR, e.g. #864 for #524)', { title: 'feat(ci): story gate (#524)' }],
    ['the head branch is feat/cut-N (feature-bot)', { headRefName: 'feat/cut-524' }],
    ["the body carries feature-bot's marker", { body: 'x\n<!-- feature-bot: issue=524 run=1 -->' }],
  ])('landed when %s', (_label, over) => {
    expect(classifyLanding(524, { stateReason: 'COMPLETED', closer: pr(over) })).toBe('landed')
  })

  it('does not match a longer number that merely starts with N', () => {
    expect(classifyLanding(52, { stateReason: 'COMPLETED', closer: pr({ title: 'fix (#524)' }) })).toBe('unverified')
    expect(classifyLanding(52, { stateReason: 'COMPLETED', closer: pr({ headRefName: 'feat/cut-524' }) })).toBe(
      'unverified',
    )
  })

  it('an unmerged closer is not a landing, even when it names the cut', () => {
    expect(classifyLanding(524, { stateReason: 'COMPLETED', closer: pr({ merged: false, title: '(#524)' }) })).toBe(
      'unverified',
    )
  })

  it('closed by hand (no PR closer) is unverified', () => {
    expect(classifyLanding(524, { stateReason: 'COMPLETED', closer: null })).toBe('unverified')
  })

  it('closed as not planned is superseded, whatever closed it', () => {
    expect(classifyLanding(524, { stateReason: 'NOT_PLANNED', closer: null })).toBe('superseded')
    expect(classifyLanding(524, { stateReason: 'not_planned', closer: pr({ title: '(#524)' }) })).toBe('superseded')
  })
})

describe('fetchCloseEvent', () => {
  const repo = { owner: 'o', repo: 'r' }
  const reply = (closer: unknown) => ({
    repository: { issue: { timelineItems: { nodes: [{ stateReason: 'COMPLETED', closer }] } } },
  })

  it('returns the PR closer from the latest close event', async () => {
    const graphql = vi.fn(async (_q: string, _v: Record<string, unknown>) =>
      reply({ __typename: 'PullRequest', number: 7, title: 't', merged: true, headRefName: 'b', body: null }),
    )
    expect(await fetchCloseEvent(graphql, repo, 5)).toEqual({
      stateReason: 'COMPLETED',
      closer: { number: 7, title: 't', merged: true, headRefName: 'b', body: null },
    })
    expect(graphql.mock.calls[0][1]).toEqual({ owner: 'o', repo: 'r', number: 5 })
  })

  it('a commit no merged PR brought in has no closer', async () => {
    const graphql = vi.fn(async () => reply({ __typename: 'Commit' }))
    expect((await fetchCloseEvent(graphql, repo, 5)).closer).toBeNull()
  })

  // A rebase merge puts the PR's own commits on main, and GitHub records the
  // commit carrying the closing keyword as the closer, not the PR (#1241).
  const commitCloser = (...prs: ReturnType<typeof pr>[]) =>
    reply({ __typename: 'Commit', associatedPullRequests: { nodes: prs } })
  const pr920 = pr({
    number: 920,
    title: 'feat: cut #523 — review-workflow Cut 9: extract <Banner> primitive + story',
    headRefName: 'feat/cut-523',
  })

  it('#523: a commit closer counts through the merged PR that brought it in', async () => {
    // Real closure: commit a455a0cc, brought in by #920, merged 2026-10-17.
    const event = await fetchCloseEvent(
      vi.fn(async () => commitCloser(pr920)),
      repo,
      523,
    )
    expect(event.closer).toEqual(pr920)
    expect(classifyLanding(523, event)).toBe('landed')
  })

  it('a commit closer prefers the merged PR that names the cut', async () => {
    const parent = pr({ number: 919, title: 'feat: stacked parent', headRefName: 'feat/parent' })
    const event = await fetchCloseEvent(
      vi.fn(async () => commitCloser(parent, pr920)),
      repo,
      523,
    )
    expect(event.closer?.number).toBe(920)
    expect(classifyLanding(523, event)).toBe('landed')
  })

  it('a commit only an unmerged PR carries is not a landing', async () => {
    const event = await fetchCloseEvent(
      vi.fn(async () => commitCloser(pr({ number: 930, merged: false, title: 'feat: cut #523' }))),
      repo,
      523,
    )
    expect(classifyLanding(523, event)).toBe('unverified')
  })

  it("a commit whose PR only mentions the cut is unverified, as #557's closure of #517 was", async () => {
    const event = await fetchCloseEvent(
      vi.fn(async () => commitCloser(pr({ number: 557, title: 'fix(feature-bot): require Note: on REJECT' }))),
      repo,
      517,
    )
    expect(classifyLanding(517, event)).toBe('unverified')
  })

  it('no close event yields no closer and no reason', async () => {
    const graphql = vi.fn(async () => ({ repository: { issue: { timelineItems: { nodes: [] } } } }))
    expect(await fetchCloseEvent(graphql, repo, 5)).toEqual({ stateReason: null, closer: null })
  })
})
