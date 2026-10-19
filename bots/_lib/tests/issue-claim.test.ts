import { describe, expect, it, vi } from 'vitest'
import { claimOf, describeClaim, fetchIssueClaim } from '../issue-claim.js'

const pr = (number: number, state: string, headRefName: string, author = 'someone') => ({
  source: { __typename: 'PullRequest', number, state, headRefName, author: { login: author } },
})

describe('claimOf', () => {
  it('an assignee claims the issue', () => {
    expect(claimOf({ assignees: { nodes: [{ login: 'vidit' }] } }, 'fix/issue-1')).toEqual({
      kind: 'assignee',
      login: 'vidit',
    })
  })

  it("an open PR on another branch claims it, whatever its wording (#957 said 'Part of #935')", () => {
    const issue = { timelineItems: { nodes: [pr(957, 'OPEN', 'test/publish-renderers-mutation-935', 'Vidit-Yadav')] } }
    expect(claimOf(issue, 'fix/issue-935')).toEqual({ kind: 'pull-request', number: 957, author: 'Vidit-Yadav' })
  })

  it("the bot's own open PR doesn't claim it", () => {
    expect(claimOf({ timelineItems: { nodes: [pr(992, 'OPEN', 'fix/issue-935')] } }, 'fix/issue-935')).toBeNull()
  })

  it('closed and merged PRs leave it free', () => {
    const issue = { timelineItems: { nodes: [pr(1, 'CLOSED', 'a'), pr(2, 'MERGED', 'b')] } }
    expect(claimOf(issue, 'fix/issue-9')).toBeNull()
  })

  it('a reference from another issue leaves it free', () => {
    const issue = { timelineItems: { nodes: [{ source: { __typename: 'Issue', number: 3, state: 'OPEN' } }] } }
    expect(claimOf(issue, 'fix/issue-9')).toBeNull()
  })

  it('a PR linked from the sidebar claims it', () => {
    const issue = {
      timelineItems: {
        nodes: [{ subject: { __typename: 'PullRequest', number: 4, state: 'OPEN', headRefName: 'x' } }],
      },
    }
    expect(claimOf(issue, 'fix/issue-9')).toEqual({ kind: 'pull-request', number: 4, author: null })
  })

  it('an issue with neither is free', () => {
    expect(claimOf({}, 'fix/issue-9')).toBeNull()
  })
})

describe('describeClaim', () => {
  it('names who has it', () => {
    expect(describeClaim({ kind: 'assignee', login: 'vidit' })).toBe('assigned to @vidit')
    expect(describeClaim({ kind: 'pull-request', number: 957, author: 'Vidit-Yadav' })).toBe(
      'open PR #957 by @Vidit-Yadav already references it',
    )
  })
})

describe('fetchIssueClaim', () => {
  it('queries the issue and reads its claim', async () => {
    const graphql = vi.fn().mockResolvedValue({
      repository: { issue: { timelineItems: { nodes: [pr(957, 'OPEN', 'test/x')] } } },
    })
    const claim = await fetchIssueClaim(graphql, { owner: 'o', repo: 'r' }, 935, 'fix/issue-935')
    expect(graphql).toHaveBeenCalledWith(expect.stringContaining('CROSS_REFERENCED_EVENT'), {
      owner: 'o',
      repo: 'r',
      number: 935,
    })
    expect(claim).toEqual({ kind: 'pull-request', number: 957, author: 'someone' })
  })
})
