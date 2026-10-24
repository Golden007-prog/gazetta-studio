/**
 * `good first issue` supply (#1271): triage-bot adds the label to a
 * qualifying new bug only while fewer than GOOD_FIRST_ISSUE_TARGET open
 * issues carry it, so GitHub's /contribute page always lists a few. The
 * count is a fact the orchestrator looks up; whether a bug qualifies
 * (small, one area, says what should happen) is Claude's judgment.
 */
import type { Octokit } from '@octokit/rest'
import { findIssuesByLabels, type RepoIdentity } from '../_lib/github.js'

export const GOOD_FIRST_ISSUE_LABEL = 'good first issue'
export const GOOD_FIRST_ISSUE_TARGET = 3

/** Open issues with the label, or null when they can't be listed. */
export async function countOpenGoodFirstIssues(octokit: Octokit, repo: RepoIdentity): Promise<number | null> {
  try {
    const issues = await findIssuesByLabels(octokit, repo, { requireAll: [GOOD_FIRST_ISSUE_LABEL], excludeAny: [] })
    return issues.length
  } catch {
    return null
  }
}

/** Prompt inputs. An unknown count never lets the label through. */
export function goodFirstIssueInputs(openCount: number | null): string {
  const wanted = openCount !== null && openCount < GOOD_FIRST_ISSUE_TARGET
  return `OPEN_GOOD_FIRST_ISSUES=${openCount ?? 'unknown'}\nGOOD_FIRST_ISSUE_WANTED=${wanted ? 'yes' : 'no'}`
}
