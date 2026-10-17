/**
 * Reviewer-log — durable record of every Agent B verdict for
 * dead-code-watcher.
 *
 * Append-only JSONL (`bots/dead-code-watcher/reviewer-log.jsonl`).
 * One line per Agent B verdict: APPROVE, REJECT, or NEEDS_HUMAN.
 * Persists the reviewer's reasoning so the monthly compactor can
 * surface cross-run patterns into lessons-learned.md.
 *
 * Distinct from skip-list (per-fingerprint rejection memory, gates
 * future runs) and lessons-learned.md (compacted prose loaded into
 * Agent A's prompt). The reviewer-log is the RAW SIGNAL the
 * compactor reads to produce lessons.
 *
 * The log file and entry type are per-bot (bots keep separate
 * memory); the file I/O lives in `_lib/reviewer-log.ts`.
 */
import * as shared from '../_lib/reviewer-log.js'
import type { Fingerprint } from './skip-list.js'

export interface ReviewerLogEntry {
  /** ISO-8601 timestamp of the verdict. */
  ts: string
  /** GitHub Actions run ID (or 'local' for local invocation). */
  runId: string
  /** dead-code-watcher's knip fingerprint identifying what was reviewed. */
  fingerprint: Fingerprint
  /** Human-readable label (e.g. "file:src/foo.ts"). */
  fingerprintLabel: string
  /** Generator-critic loop iteration (1..MAX_ATTEMPTS). */
  attempt: number
  /** Reviewer's verdict. */
  verdict: 'approve' | 'reject' | 'needs-human'
  /** Reviewer's reasoning paragraph. */
  reasoning: string
  /** Agent A's claimed summary at the time of this verdict. */
  agentASummary: string
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

export const REVIEWER_LOG_PATH = 'bots/dead-code-watcher/reviewer-log.jsonl'
