/**
 * Reviewer-log file I/O shared by every bot that keeps one.
 *
 * Append-only JSONL, one entry per line, persisted across runs via
 * actions/cache (ADR-0011). Each bot keeps its own log file and entry
 * type in `bots/{bot}/reviewer-log.ts` — the memory stays per-bot; only
 * the I/O is shared.
 */
import { appendFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs'

export function appendReviewerLog<T>(absolutePath: string, entry: T): void {
  appendFileSync(absolutePath, `${JSON.stringify(entry)}\n`)
}

/** Read the whole log; a missing file is empty and malformed lines are skipped. */
export function readReviewerLog<T>(absolutePath: string): T[] {
  if (!existsSync(absolutePath)) return []
  const raw = readFileSync(absolutePath, 'utf-8')
  const entries: T[] = []
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue
    try {
      entries.push(JSON.parse(line) as T)
    } catch {
      // malformed — skip; old schema or partial write
    }
  }
  return entries
}

export function tailReviewerLog<T>(absolutePath: string, n: number): T[] {
  return readReviewerLog<T>(absolutePath).slice(-n)
}

/**
 * Truncate the file to the last `keepLast` entries. A bot's compactor
 * calls this after rewriting lessons-learned.md so the cached file stays
 * bounded; dropped entries are gone (ADR-0011 — no raw-history archive).
 */
export function pruneReviewerLog(absolutePath: string, keepLast: number): { dropped: number; kept: number } {
  const all = readReviewerLog<unknown>(absolutePath)
  if (all.length <= keepLast) return { dropped: 0, kept: all.length }
  const kept = all.slice(-keepLast)
  writeFileSync(absolutePath, `${kept.map(e => JSON.stringify(e)).join('\n')}\n`)
  return { dropped: all.length - keepLast, kept: kept.length }
}
