/**
 * Reviewer-log — durable record of every Agent B verdict for review-bot.
 *
 * Append-only JSONL (`bots/review-bot/reviewer-log.jsonl`). One line
 * per Agent B verdict on a proposed improvement: APPROVE, REJECT, or
 * NEEDS_HUMAN. Persists the reviewer's reasoning so the monthly
 * compactor can surface cross-candidate patterns into lessons-learned.md.
 *
 * Same shape as fix-bot's reviewer-log; the fingerprint differs
 * (Fingerprint from skip-list.ts — area + type + rule) because
 * review-bot's bot-output unit is a candidate, not an issue.
 *
 * Persistence: actions/cache@v4 keyed `review-bot-reviewer-log-v1`
 * per ADR-0011. Single-instance invariant via concurrency group.
 */
import * as shared from '../_lib/reviewer-log.js'
import type { Fingerprint } from './skip-list.js'

export interface ReviewerLogEntry {
  ts: string
  runId: string
  fingerprint: Fingerprint
  /** Short human-readable fingerprint label (area + type) for log scanning. */
  fingerprintLabel: string
  /** Attempt number within this candidate's generator-critic loop (1-N). */
  attempt: number
  verdict: 'approve' | 'reject' | 'needs-human'
  /** Reviewer's free-text reasoning. */
  reasoning: string
  /** One-line summary of what Agent A produced. */
  agentASummary: string
}

export function appendReviewerLog(absolutePath: string, entry: ReviewerLogEntry): void {
  shared.appendReviewerLog(absolutePath, entry)
}

export function tailReviewerLog(absolutePath: string, n: number): ReviewerLogEntry[] {
  return shared.tailReviewerLog<ReviewerLogEntry>(absolutePath, n)
}

export const pruneReviewerLog = shared.pruneReviewerLog

export const REVIEWER_LOG_PATH = 'bots/review-bot/reviewer-log.jsonl'
