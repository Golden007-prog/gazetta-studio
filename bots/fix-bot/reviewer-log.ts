/**
 * Reviewer-log — durable record of every Agent B verdict for fix-bot.
 *
 * Append-only JSONL (`bots/fix-bot/reviewer-log.jsonl`). One line per
 * Agent B verdict: APPROVE, REJECT, or NEEDS_HUMAN. Persists the
 * reviewer's reasoning so the monthly compactor can surface
 * cross-issue patterns into lessons-learned.md.
 *
 * Distinct from skip-list (per-issue rejection memory, gates future
 * runs) and lessons-learned.md (compacted prose loaded into Agent
 * A's prompt). The reviewer-log is the RAW SIGNAL the compactor
 * reads to produce lessons.
 *
 * Why per-bot: bot-specific fingerprint shape (`{issueNumber}` here,
 * knip Fingerprint in dead-code-watcher) — same rule as skip-list.
 */
import * as shared from '../_lib/reviewer-log.js'
import type { IssueFingerprint } from './skip-list.js'

export interface ReviewerLogEntry {
  ts: string
  runId: string
  fingerprint: IssueFingerprint
  fingerprintLabel: string
  attempt: number
  verdict: 'approve' | 'reject' | 'needs-human'
  reasoning: string
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

export const REVIEWER_LOG_PATH = 'bots/fix-bot/reviewer-log.jsonl'
