import { describe, expect, it, vi } from 'vitest'
import { countOpenGoodFirstIssues, goodFirstIssueInputs } from '../good-first-issue.js'

const repo = { owner: 'gazetta-studio', repo: 'gazetta-studio' }

function issue(number: number, extra: Record<string, unknown> = {}) {
  return {
    number,
    title: `Issue ${number}`,
    labels: [{ name: 'good first issue' }],
    created_at: '2026-10-24T00:00:00Z',
    user: { login: 'someone' },
    ...extra,
  }
}

describe('goodFirstIssueInputs', () => {
  it.each([
    [0, 'yes'],
    [2, 'yes'],
    [3, 'no'],
    [5, 'no'],
  ])('with %i open, a new one is wanted: %s', (open, wanted) => {
    expect(goodFirstIssueInputs(open)).toBe(`OPEN_GOOD_FIRST_ISSUES=${open}\nGOOD_FIRST_ISSUE_WANTED=${wanted}`)
  })

  it('says no when the count is unknown', () => {
    expect(goodFirstIssueInputs(null)).toBe('OPEN_GOOD_FIRST_ISSUES=unknown\nGOOD_FIRST_ISSUE_WANTED=no')
  })
})

describe('countOpenGoodFirstIssues', () => {
  it('counts open issues with the label, not pull requests', async () => {
    const listForRepo = vi.fn().mockResolvedValue({ data: [issue(1), issue(2), issue(3, { pull_request: {} })] })
    const octokit = { issues: { listForRepo } } as never

    expect(await countOpenGoodFirstIssues(octokit, repo)).toBe(2)
    expect(listForRepo.mock.calls[0]?.[0]).toMatchObject({ state: 'open', labels: 'good first issue' })
  })

  it("returns null when the issues can't be listed", async () => {
    const listForRepo = vi.fn().mockRejectedValue(new Error('rate limited'))
    const octokit = { issues: { listForRepo } } as never

    expect(await countOpenGoodFirstIssues(octokit, repo)).toBeNull()
  })
})
