/**
 * The order fix-bot works through its candidates in. Pure, so it can be
 * tested without running the bot (index.ts runs main() on import).
 *
 * Issues labelled `priority` go first: the maintainer applies it to Stage 1
 * gate items and to bugs that break deployed sites. Then oldest first, then
 * the lower issue number.
 */
import type { IssueSummary } from '../_lib/github.js'

export const PRIORITY_LABEL = 'priority'

export function orderCandidates(candidates: readonly IssueSummary[]): IssueSummary[] {
  const isPriority = (i: IssueSummary) => i.labels.includes(PRIORITY_LABEL)
  return [...candidates].sort((a, b) => {
    if (isPriority(a) !== isPriority(b)) return isPriority(a) ? -1 : 1
    if (a.createdAt !== b.createdAt) return a.createdAt.localeCompare(b.createdAt)
    return a.number - b.number
  })
}
