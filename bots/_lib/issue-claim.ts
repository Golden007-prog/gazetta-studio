/**
 * Whether someone is already working on an issue, so a bot doesn't open a
 * second PR for it. An issue is claimed when it has an assignee, or when an
 * open PR other than the bot's own branch references it. "Part of #N" counts:
 * a PR that fixes part of an issue is still work on it, and GitHub only links
 * PRs with closing keywords, so the timeline's cross-references are read
 * instead. (fix-bot duplicated outside PRs twice: #929 next to #925, #992
 * next to #957.)
 */
import type { GraphqlClient } from './cut-landing.js'

export type IssueClaim =
  | { kind: 'assignee'; login: string }
  | { kind: 'pull-request'; number: number; author: string | null }

type LinkedPr = {
  __typename?: string
  number?: number
  state?: string
  headRefName?: string
  author?: { login?: string } | null
}

export type ClaimQueryIssue = {
  assignees?: { nodes?: Array<{ login?: string } | null> }
  timelineItems?: { nodes?: Array<{ source?: LinkedPr | null; subject?: LinkedPr | null } | null> }
}

/** The first claim on an issue, or null when nobody else is on it. */
export function claimOf(issue: ClaimQueryIssue, ownBranch: string): IssueClaim | null {
  const assignee = issue.assignees?.nodes?.find(a => a?.login)?.login
  if (assignee) return { kind: 'assignee', login: assignee }
  for (const node of issue.timelineItems?.nodes ?? []) {
    const pr = node?.source ?? node?.subject
    if (pr?.__typename !== 'PullRequest' || pr.state !== 'OPEN' || pr.number === undefined) continue
    if (pr.headRefName === ownBranch) continue
    return { kind: 'pull-request', number: pr.number, author: pr.author?.login ?? null }
  }
  return null
}

export function describeClaim(claim: IssueClaim): string {
  return claim.kind === 'assignee'
    ? `assigned to @${claim.login}`
    : `open PR #${claim.number}${claim.author ? ` by @${claim.author}` : ''} already references it`
}

const CLAIM_QUERY = `query($owner: String!, $repo: String!, $number: Int!) {
  repository(owner: $owner, name: $repo) {
    issue(number: $number) {
      assignees(first: 10) { nodes { login } }
      timelineItems(itemTypes: [CROSS_REFERENCED_EVENT, CONNECTED_EVENT], last: 100) {
        nodes {
          ... on CrossReferencedEvent { source { __typename ... on PullRequest { number state headRefName author { login } } } }
          ... on ConnectedEvent { subject { __typename ... on PullRequest { number state headRefName author { login } } } }
        }
      }
    }
  }
}`

/** Throws on API failure — callers decide how to degrade. */
export async function fetchIssueClaim(
  graphql: GraphqlClient,
  repo: { owner: string; repo: string },
  issueNumber: number,
  ownBranch: string,
): Promise<IssueClaim | null> {
  const res = (await graphql(CLAIM_QUERY, { owner: repo.owner, repo: repo.repo, number: issueNumber })) as {
    repository?: { issue?: ClaimQueryIssue | null }
  }
  return claimOf(res.repository?.issue ?? {}, ownBranch)
}
