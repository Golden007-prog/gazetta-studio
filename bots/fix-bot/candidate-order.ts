/**
 * The order fix-bot works through its candidates in. Pure, so it can be
 * tested without running the bot (index.ts runs main() on import).
 */
import type { IssueSummary } from '../_lib/github.js'

export function orderCandidates(candidates: readonly IssueSummary[]): IssueSummary[] {
  return [...candidates].sort((a, b) => a.createdAt.localeCompare(b.createdAt))
}
