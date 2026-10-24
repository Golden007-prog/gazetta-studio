/**
 * Did a closed cut actually land?
 *
 * "Closed" is not "landed". #517 (review-workflow Cut 3, review-state
 * storage) was closed — reason COMPLETED, closer a merged PR — by #557, a
 * one-file reviewer-prompt fix that only mentioned the cut. GitHub still
 * linked #557 as its closer. Every bot that read "closed + completed" as
 * "done" then built on storage that did not exist: feature-bot treated it as
 * a satisfied dependency, and cut-planner would have filed the next cut.
 *
 * So a cut counts as landed only when the merged PR that closed it names
 * the cut as its own work — in its title (`#N`), its head branch
 * (`feat/cut-N`), or feature-bot's PR marker (`feature-bot: issue=N`).
 * Verified against every completed cut on record: all landed ones pass,
 * #557's closure does not.
 *
 * A rebase merge puts the PR's own commits on main, and GitHub then records
 * the commit carrying the closing keyword as the closer (#523, closed by
 * #920's commit). Such a cut is checked against the merged PR that brought
 * the commit in (#1241).
 *
 * Shared by feature-bot and cut-planner, which must not import each other.
 */

export interface CloserPr {
  number: number
  title: string
  merged: boolean
  headRefName: string
  body: string | null
}

export interface CloseEvent {
  /** GitHub's `stateReason` for the latest close (`COMPLETED`, `NOT_PLANNED`, …), lower- or upper-case. */
  stateReason: string | null
  /**
   * The pull request recorded as the closer, or for a commit closer the merged
   * PR that brought the commit in; null when closed by hand, or by a commit no
   * merged PR brought in.
   */
  closer: CloserPr | null
}

export type Landing =
  /** A merged PR that names this cut closed it. */
  | 'landed'
  /** Closed as not planned (e.g. replaced by a re-decomposition). Not done, and not a defect. */
  | 'superseded'
  /** Closed as completed with no PR that names it — needs a human to say whether it landed. */
  | 'unverified'

/** Does the PR name the cut as its own work? */
function namesCut(pr: CloserPr, issueNumber: number): boolean {
  const n = String(issueNumber)
  return (
    new RegExp(`#${n}\\b`).test(pr.title) ||
    pr.headRefName === `feat/cut-${n}` ||
    new RegExp(`feature-bot: issue=${n}\\b`).test(pr.body ?? '')
  )
}

export function classifyLanding(issueNumber: number, event: CloseEvent): Landing {
  if ((event.stateReason ?? '').toLowerCase() === 'not_planned') return 'superseded'
  const pr = event.closer
  if (!pr?.merged) return 'unverified'
  return namesCut(pr, issueNumber) ? 'landed' : 'unverified'
}

/** Narrow GraphQL surface — `octokit.graphql` satisfies it. */
export type GraphqlClient = (query: string, variables: Record<string, unknown>) => Promise<unknown>

const CLOSE_EVENT_QUERY = `query($owner: String!, $repo: String!, $number: Int!) {
  repository(owner: $owner, name: $repo) {
    issue(number: $number) {
      timelineItems(itemTypes: [CLOSED_EVENT], last: 1) {
        nodes {
          ... on ClosedEvent {
            stateReason
            closer {
              __typename
              ... on PullRequest { number title merged headRefName body }
              ... on Commit { associatedPullRequests(first: 5) { nodes { number title merged headRefName body } } }
            }
          }
        }
      }
    }
  }
}`

/** The latest close event of an issue. Throws on API failure — callers decide how to degrade. */
export async function fetchCloseEvent(
  graphql: GraphqlClient,
  repo: { owner: string; repo: string },
  issueNumber: number,
): Promise<CloseEvent> {
  const res = (await graphql(CLOSE_EVENT_QUERY, { owner: repo.owner, repo: repo.repo, number: issueNumber })) as {
    repository?: {
      issue?: {
        timelineItems?: {
          nodes?: Array<{
            stateReason?: string | null
            closer?: (CloserPr & { __typename?: string; associatedPullRequests?: { nodes?: CloserPr[] } }) | null
          }>
        }
      }
    }
  }
  const node = res.repository?.issue?.timelineItems?.nodes?.at(-1)
  let closer: CloserPr | null = null
  if (node?.closer?.__typename === 'PullRequest') closer = node.closer
  if (node?.closer?.__typename === 'Commit') {
    // A stacked PR can carry the same commit, so prefer the merged one that names the cut.
    const merged = (node.closer.associatedPullRequests?.nodes ?? []).filter(pr => pr.merged)
    closer = merged.find(pr => namesCut(pr, issueNumber)) ?? merged[0] ?? null
  }
  return {
    stateReason: node?.stateReason ?? null,
    closer: closer
      ? {
          number: closer.number,
          title: closer.title,
          merged: closer.merged,
          headRefName: closer.headRefName,
          body: closer.body ?? null,
        }
      : null,
  }
}
