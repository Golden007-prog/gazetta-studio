/**
 * Audit retention pruner.
 *
 * Per design-audit.md "Retention": audit retention is configurable
 * independently from content history retention. Two dimensions:
 *
 *   - `events` — max event count kept across all per-instance JSONL
 *     files. When exceeded, oldest events evicted (timestamp-sort
 *     ascending; drop from the head).
 *   - `maxAgeMonths` — max age in months. Events older than the
 *     cutoff evicted regardless of count.
 *
 * Operator sets one or both. When neither set, the pruner is a no-op
 * (audit accumulates indefinitely until storage budget exhausted —
 * operator's choice; documented).
 *
 * # JSONL storage shape
 *
 * Per `HistoryAuditProvider`, events live in
 * `.gazetta/audit/events-{instance-id}.jsonl` — one file per admin
 * instance. The pruner walks every events file, parses lines into
 * AuditEvent objects, applies retention, and rewrites each file with
 * the surviving lines. Per-file rewrite preserves the per-instance
 * scoping (no cross-instance interleaving).
 *
 * # Multi-instance correctness
 *
 * Per-revision file granularity (each instance's file is independent)
 * means concurrent pruners on the same target converge. If instance A
 * is rewriting events-A.jsonl while instance B is rewriting
 * events-B.jsonl, no race. If two pruners on different hosts try to
 * rewrite the SAME events-A.jsonl simultaneously (two instances with
 * the same hostname / K_REVISION), the storage provider's atomic
 * write-then-rename keeps the file consistent — last-write-wins is
 * fine because both pruners compute the same surviving set from the
 * same input bytes.
 *
 * # In-process coordination with appends (#1414)
 *
 * The pruner writes the same `events-{instance}.jsonl` files the
 * HistoryAuditProvider appends to, and both run in the admin
 * process against the same storage object. A rewrite outside
 * the shared append queue loses an append that landed between
 * the pruner's read and its write — or resurrects evicted
 * events when the append's stale read wins the last write. So
 * the snapshot below decides WHICH events to evict, and each
 * file's rewrite runs as one queued task that re-reads the
 * file fresh and reapplies the plan. Cross-process pruners
 * still converge last-write-wins per the section above — the
 * queue only serializes within one process.
 *
 * # Why JSONL-line pruning, not whole-file deletion
 *
 * The pruner has to handle events file-by-file because:
 *   - Different instances have different event mixes; deleting an
 *     entire instance's file would lose events newer than the cutoff
 *   - Events within one instance's file span time; some pruned, some
 *     kept — selective line removal is the right granularity
 *
 * # Returns: PruneResult
 *
 * Diagnostic info for the caller's log + metrics. `eventsKept` and
 * `eventsEvicted` together = total events pre-prune.
 *
 * # SOLID lenses
 *
 *   - SRP: retention only; doesn't construct providers, doesn't
 *     audit pruner-events itself (would create recursion).
 *   - DIP: takes a StorageProvider — works against filesystem, R2,
 *     S3, Azure Blob uniformly.
 */
import type { StorageProvider } from '../types.js'
import { enqueueStorageTask } from './append-queue.js'
import { stateFolderPath } from '../state-folders.js'
import type { AuditEvent } from './types.js'

export interface AuditRetentionConfig {
  /** Max event count kept. When exceeded, oldest evicted. */
  events?: number
  /** Max age in months. Events older than the cutoff evicted. */
  maxAgeMonths?: number | null
}

export interface PruneResult {
  /** Number of events present before pruning. */
  eventsBefore: number
  /** Number of events surviving. */
  eventsKept: number
  /** Number of events evicted. */
  eventsEvicted: number
  /** Files rewritten (only files with at least one eviction). */
  filesRewritten: number
  /** Files inspected (every events file under .gazetta/audit/). */
  filesInspected: number
}

const AUDIT_DIR = stateFolderPath('audit')

/**
 * Walk the audit JSONL files, evict events that violate retention,
 * rewrite each affected file. No-op when retention config has neither
 * `events` nor `maxAgeMonths` set.
 */
export async function pruneAuditEvents(storage: StorageProvider, config: AuditRetentionConfig): Promise<PruneResult> {
  // No retention configured → no-op. Operator opted out or never opted in.
  const hasEventsCap = config.events !== undefined && config.events !== null
  const hasAgeCap = config.maxAgeMonths !== undefined && config.maxAgeMonths !== null && config.maxAgeMonths > 0
  if (!hasEventsCap && !hasAgeCap) {
    return { eventsBefore: 0, eventsKept: 0, eventsEvicted: 0, filesRewritten: 0, filesInspected: 0 }
  }

  // Compute the age cutoff once so all files use the same boundary.
  // `maxAgeMonths` is a real-month subtraction (Date.setMonth handles
  // leap years + variable month length); ISO-8601 string compare works
  // on the resulting timestamp.
  const ageCutoff = hasAgeCap ? computeAgeCutoff(config.maxAgeMonths!) : null

  // Walk the events directory. Missing dir = no events to prune.
  let entries: Awaited<ReturnType<StorageProvider['readDir']>>
  try {
    entries = await storage.readDir(AUDIT_DIR)
  } catch {
    return { eventsBefore: 0, eventsKept: 0, eventsEvicted: 0, filesRewritten: 0, filesInspected: 0 }
  }

  // Read every events file into memory with its source path. We need
  // the global event count for `events` cap enforcement (oldest-across-
  // files evicted, not per-file), so we collect all events first.
  const filesInspected: { path: string; events: AuditEvent[]; rawLineCount: number }[] = []
  for (const entry of entries) {
    if (entry.isDirectory) continue
    if (!entry.name.startsWith('events-') || !entry.name.endsWith('.jsonl')) continue
    const path = `${AUDIT_DIR}/${entry.name}`
    const content = await storage.readFile(path)
    const lines = content.split('\n')
    const events: AuditEvent[] = []
    let rawLineCount = 0
    for (const line of lines) {
      const trimmed = line.trim()
      if (!trimmed) continue
      rawLineCount++
      try {
        events.push(JSON.parse(trimmed) as AuditEvent)
      } catch {
        // Malformed line — skip + count as raw line so the rewrite
        // doesn't accidentally include it. Same posture as the reader
        // in HistoryAuditProvider.
      }
    }
    filesInspected.push({ path, events, rawLineCount })
  }

  const eventsBefore = filesInspected.reduce((sum, f) => sum + f.events.length, 0)
  if (eventsBefore === 0) {
    return {
      eventsBefore: 0,
      eventsKept: 0,
      eventsEvicted: 0,
      filesRewritten: 0,
      filesInspected: filesInspected.length,
    }
  }

  // Phase 1: age cutoff (per-file evaluation; events older than the
  // cutoff are evicted regardless of where they sit in the global
  // ordering).
  for (const file of filesInspected) {
    if (ageCutoff !== null) {
      file.events = file.events.filter(e => e.timestamp >= ageCutoff)
    }
  }

  // Phase 2: count cap (global). Build the global ordering once:
  // sort all surviving events by timestamp (oldest first), evict
  // from the head until we're under the cap. The eviction set is
  // matched back to its source file by reference identity.
  // Eviction plan as a key multiset (serialized event -> count), not
  // object identity: the queued rewrite re-parses the file fresh, so
  // identity no longer refers to the same objects. Identical events
  // (same JSON) are evicted one copy at a time via the count.
  const evictedKeys = new Map<string, number>()
  if (hasEventsCap) {
    const allSurviving: AuditEvent[] = []
    for (const file of filesInspected) {
      allSurviving.push(...file.events)
    }
    allSurviving.sort((a, b) => a.timestamp.localeCompare(b.timestamp))
    const overflow = allSurviving.length - config.events!
    for (const event of allSurviving.slice(0, Math.max(0, overflow))) {
      const key = evictionKey(event)
      evictedKeys.set(key, (evictedKeys.get(key) ?? 0) + 1)
    }
  }

  // Phase 3: rewrite each file whose surviving set differs from the
  // pre-prune set. Reasons a file rewrites:
  //   - age-cutoff already mutated `file.events`
  //   - count-cap is going to evict additional events
  //   - malformed JSONL lines on disk (rawLineCount > parsed events) —
  //     incidental hygiene; the line never made it through parse and
  //     wouldn't survive a re-read either, so we drop it during the
  //     rewrite. Doesn't count toward `eventsEvicted` (the metric
  //     reports parsed-event deltas only).
  let filesRewritten = 0
  let eventsKeptTotal = 0
  for (const file of filesInspected) {
    const surviving = applyEvictionPlan(file.events, evictedKeys)
    eventsKeptTotal += surviving.length
    const parsedDelta = file.events.length - surviving.length
    const malformedLines = file.rawLineCount - file.events.length
    if (parsedDelta === 0 && malformedLines === 0) continue
    // Rewrite as one task in the shared per-file queue (#1414), so it
    // serializes with appends to this file. The task re-reads the file
    // FRESH and reapplies the eviction plan: an append that landed
    // between the snapshot read and this rewrite survives (it is not
    // in the plan), and an evicted event cannot come back from a stale
    // buffer. A rewrite that finds nothing left to do skips the write
    // so it never clobbers a gap-append pointlessly.
    let wrote = false
    await enqueueStorageTask(storage, file.path, async () => {
      let freshContent: string
      try {
        freshContent = await storage.readFile(file.path)
      } catch {
        // File vanished between snapshot and rewrite — nothing to prune.
        return
      }
      const freshEvents: AuditEvent[] = []
      let freshRaw = 0
      for (const line of freshContent.split('\n')) {
        const trimmed = line.trim()
        if (!trimmed) continue
        freshRaw++
        try {
          freshEvents.push(JSON.parse(trimmed) as AuditEvent)
        } catch {
          // Malformed line — dropped on rewrite, same as the snapshot pass.
        }
      }
      const ageFiltered = ageCutoff !== null ? freshEvents.filter(e => e.timestamp >= ageCutoff) : freshEvents
      const freshSurviving = applyEvictionPlan(ageFiltered, evictedKeys)
      if (freshSurviving.length === freshEvents.length && freshRaw === freshEvents.length) return
      // JSONL convention: one event per line + trailing newline.
      // Empty file (all events pruned) → write an empty string so the
      // file remains as a marker (deleting would force concurrent
      // appenders to mkdir; safer to keep the file with a zero-line body).
      const rewritten = freshSurviving.map(e => JSON.stringify(e)).join('\n')
      await storage.writeFile(file.path, rewritten ? rewritten + '\n' : '')
      wrote = true
    })
    if (wrote) filesRewritten++
  }

  return {
    eventsBefore,
    eventsKept: eventsKeptTotal,
    eventsEvicted: eventsBefore - eventsKeptTotal,
    filesRewritten,
    filesInspected: filesInspected.length,
  }
}

/**
 * Stable identity for one event across two parses of the same file.
 * The eviction plan is computed from the snapshot parse and applied
 * to the fresh re-parse inside the queued rewrite; JSON.stringify of
 * the parsed object is deterministic for identical input bytes.
 */
function evictionKey(event: AuditEvent): string {
  return JSON.stringify(event)
}

/**
 * Apply the eviction plan to a fresh event list. Clones the multiset
 * so the plan survives both the snapshot metrics pass and each
 * per-file rewrite task.
 */
function applyEvictionPlan(events: AuditEvent[], plan: Map<string, number>): AuditEvent[] {
  if (plan.size === 0) return events
  const remaining = new Map(plan)
  return events.filter(event => {
    const key = evictionKey(event)
    const n = remaining.get(key) ?? 0
    if (n === 0) return true
    remaining.set(key, n - 1)
    return false
  })
}

/**
 * Subtract `months` calendar months from `now` and return the ISO
 * timestamp boundary. Events with `timestamp >= cutoff` are kept;
 * older events evicted.
 *
 * Uses Date.setMonth so leap years and variable-length months are
 * handled correctly (3 months back from 2026-05-31 is 2026-02-28,
 * not 2026-02-31).
 */
function computeAgeCutoff(months: number): string {
  const cutoff = new Date()
  cutoff.setMonth(cutoff.getMonth() - months)
  return cutoff.toISOString()
}
