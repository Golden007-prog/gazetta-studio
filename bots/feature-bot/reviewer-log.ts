/**
 * Reviewer-log — durable record of every Agent B verdict for feature-bot.
 *
 * Append-only JSONL (`bots/feature-bot/reviewer-log.jsonl`). One line per
 * Agent B verdict: APPROVE, REJECT, NEEDS_INPUT, or NEEDS_HUMAN. Persists
 * the reviewer's reasoning so a future monthly compactor can surface
 * cross-cut patterns into lessons-learned.md (deferred — see
 * design-feature-bot.md "Memory" section + Q7 lock).
 *
 * Distinct from skip-list (per-cut rejection memory, gates future runs)
 * and lessons-learned.md (compacted prose loaded into Agent A's prompt).
 * The reviewer-log is the RAW SIGNAL the future compactor would read.
 *
 * Why per-bot: bot-specific fingerprint shape (`{ issueNumber }` here,
 * peer-rooted from fix-bot's) — same rule as skip-list. Rule 38
 * (symmetric-bot audits) keeps the file shape identical to fix-bot's so
 * the future compactor can be lifted across bots when it earns its place.
 */
import { appendFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs'
import type { IssueFingerprint } from './skip-list.js'

export interface ReviewerLogEntry {
  ts: string
  runId: string
  fingerprint: IssueFingerprint
  fingerprintLabel: string
  attempt: number
  /**
   * Feature-bot has four terminal states per Q6 (APPROVE / NEEDS_INPUT /
   * NEEDS_HUMAN) plus the within-loop REJECT-with-retry. The log records
   * the verdict-as-emitted so the compactor can later separate
   * NEEDS_INPUT (recoverable; maintainer answers) from NEEDS_HUMAN
   * (terminal; cut closed + skip-list).
   */
  verdict: 'approve' | 'reject' | 'needs-input' | 'needs-human'
  reasoning: string
  agentASummary: string
}

export function appendReviewerLog(absolutePath: string, entry: ReviewerLogEntry): void {
  appendFileSync(absolutePath, `${JSON.stringify(entry)}\n`)
}

function readReviewerLog(absolutePath: string): ReviewerLogEntry[] {
  if (!existsSync(absolutePath)) return []
  const raw = readFileSync(absolutePath, 'utf-8')
  const entries: ReviewerLogEntry[] = []
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue
    try {
      entries.push(JSON.parse(line) as ReviewerLogEntry)
    } catch {
      // malformed — skip
    }
  }
  return entries
}

export function tailReviewerLog(absolutePath: string, n: number): ReviewerLogEntry[] {
  return readReviewerLog(absolutePath).slice(-n)
}

/**
 * Truncate the file to the last `keepLast` entries — the future compactor
 * calls this AFTER producing its lessons-learned rewrite, so the cached
 * file stays bounded across months. Per ADR-0011 (cache-based
 * persistence), a future artifact-upload path is the place for
 * raw-history preservation if it ever earns its keep.
 */
export function pruneReviewerLog(absolutePath: string, keepLast: number): { dropped: number; kept: number } {
  const all = readReviewerLog(absolutePath)
  if (all.length <= keepLast) return { dropped: 0, kept: all.length }
  const kept = all.slice(-keepLast)
  writeFileSync(absolutePath, `${kept.map(e => JSON.stringify(e)).join('\n')}\n`)
  return { dropped: all.length - keepLast, kept: kept.length }
}

export const REVIEWER_LOG_PATH = 'bots/feature-bot/reviewer-log.jsonl'
