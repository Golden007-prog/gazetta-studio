/**
 * Reviewer-log — durable record of every decision the
 * mutation-area-picker makes.
 *
 * Append-only JSONL (`bots/mutation-area-picker/reviewer-log.jsonl`).
 * One line per cron run: ADD, SWAP, REMOVE, or NOOP. Persists across
 * runs via `actions/cache@v4` (ADR-0011 pattern). The monthly
 * compactor reads recent entries and produces
 * `lessons-learned.md` patterns.
 *
 * The entry type is per-bot (bots keep separate memory); the file I/O
 * lives in `_lib/reviewer-log.ts`, generic over the entry type.
 *
 * NOTE: there is no Agent A / Agent B reviewer-loop here — the
 * decision is computed deterministically in the orchestrator. The
 * file is called `reviewer-log` for symmetry with the rest of the
 * bot ecosystem and because the empirical signals (Stryker results,
 * mutation-watcher fix-rates) ARE the implicit reviewers; each entry
 * records "what did the bot decide, with what evidence."
 */
import * as shared from '../_lib/reviewer-log.js'

type DecisionAction = 'add' | 'swap' | 'remove' | 'noop'

export interface ReviewerLogEntry {
  ts: string
  runId: string
  action: DecisionAction
  /** Module being added (ADD / SWAP) — null for REMOVE / NOOP. */
  addedModule: string | null
  /** Module being removed (REMOVE / SWAP) — null for ADD / NOOP. */
  removedModule: string | null
  /** Top inclusion score the bot saw this run (regardless of action). */
  topInclusionScore: number
  /** Worst (highest) eviction score among scoped modules — i.e. closest to graduating. */
  worstEvictionScore: number
  /** Estimated runtime cost in minutes after applying this decision (current + delta). */
  estimatedRuntimeAfterMinutes: number
  /** Human-readable summary of which rule fired. */
  reasoning: string
  /** Bootstrap week (1-4) when eviction logic is disabled; null afterwards. */
  bootstrapWeek: number | null
}

/**
 * Count distinct weekly run timestamps. Used to determine the
 * bootstrap-week counter (first 4 weeks: ADD-only, no eviction).
 *
 * "Distinct week" is approximated by counting unique YYYY-MM-DD
 * dates spanning >= 6 days from the oldest — protects against
 * accidental multiple runs in one day inflating the count.
 */
export function countWeeklyRuns(entries: ReviewerLogEntry[]): number {
  if (entries.length === 0) return 0
  const days = new Set(entries.map(e => e.ts.slice(0, 10)))
  return days.size
}

export function appendReviewerLog(absolutePath: string, entry: ReviewerLogEntry): void {
  shared.appendReviewerLog(absolutePath, entry)
}

export function readReviewerLog(absolutePath: string): ReviewerLogEntry[] {
  return shared.readReviewerLog<ReviewerLogEntry>(absolutePath)
}

export function tailReviewerLog(absolutePath: string, n: number): ReviewerLogEntry[] {
  return shared.tailReviewerLog<ReviewerLogEntry>(absolutePath, n)
}

export const pruneReviewerLog = shared.pruneReviewerLog

export const REVIEWER_LOG_PATH = 'bots/mutation-area-picker/reviewer-log.jsonl'
