/**
 * `HistoryAuditProvider` — v1 in-tree audit provider that stores
 * events in the target's `.gazetta/audit/events.jsonl` file.
 *
 * # Why JSONL, not extending Revisions
 *
 * Per `design-audit.md`: "Audit and history are conceptually peer
 * surfaces. v1 ships them unified in HistoryAuditProvider (writes a
 * revision on success; writes an audit event on every outcome)."
 *
 * The simplest unified shape: history-recorder keeps writing
 * Revisions for the success path (existing primitive, unchanged);
 * audit events live in a parallel JSONL file under the same
 * `.gazetta/` namespace. Failure outcomes (forbidden /
 * validation-failed / unauthenticated) write only to the audit log
 * (no content snapshot — there was no successful write to record).
 * Success outcomes write to BOTH (revision in `.gazetta/history/`,
 * audit event in `.gazetta/audit/events.jsonl`); the audit-event
 * carries the actor + outcome + scope context the revision shape
 * predates.
 *
 * The alternative — extending `Revision` with `actor` + `outcome` —
 * forces the existing history machinery to handle audit-only
 * revisions (no snapshot). Rather than complicate history-recorder
 * with optional-snapshot revision flow, the audit log gets its own
 * append-only file. v1 validation: simpler shape; same multi-instance
 * guarantees.
 *
 * # Multi-instance correctness
 *
 * One file per instance. Each admin process writes to
 * `events-{instance-id}.jsonl` so concurrent appends don't race.
 * Reads aggregate via `readDir` + concat. Same pattern as
 * design-audit.md "v2 reserved" notes for `FileAuditProvider`:
 * "filesystem POSIX `O_APPEND` for small writes; R2/S3/Azure use
 * per-instance file (`events.{instance-id}.jsonl`)".
 *
 * v1 is per-instance file unconditionally — no special-casing
 * filesystem vs cloud storage. Filesystem operators pay one extra
 * file per process (negligible); cloud-storage operators get the
 * concurrency safety they need.
 *
 * # SOLID lenses
 *
 *   - SRP: this provider only writes/reads JSONL. Recording dispatch,
 *     pseudonymization, and source-IP extraction live elsewhere.
 *   - LSP: implements `AuditProvider`; consumers don't know it's
 *     filesystem-backed.
 *   - DIP: takes a `StorageProvider` instance — works against
 *     filesystem, R2, S3, Azure Blob uniformly.
 */
import type { StorageProvider } from '../../types.js'
import type { AuditEvent, AuditQuery } from '../types.js'
import type { AuditProvider } from '../provider.js'

export interface HistoryAuditProviderOptions {
  /** Storage provider for the target. Audit events live under `.gazetta/audit/`. */
  storage: StorageProvider
  /**
   * Per-process instance identifier. Disambiguates JSONL file
   * names for multi-instance correctness. Production resolves
   * this from K_REVISION (Cloud Run) → os.hostname() → random
   * 8-char hex (per design-logging.md conventions).
   */
  instance: string
}

const AUDIT_DIR = '.gazetta/audit'

export function createHistoryAuditProvider(opts: HistoryAuditProviderOptions): AuditProvider {
  const { storage, instance } = opts
  const eventsPath = `${AUDIT_DIR}/events-${instance}.jsonl`

  async function appendEvent(event: AuditEvent): Promise<void> {
    // Read-modify-write per call. JSONL append-only on filesystem
    // would be cheaper, but cloud StorageProvider (R2/S3/Azure)
    // doesn't expose append — every write is whole-object replace.
    // The per-instance file scoping makes RMW safe (no other
    // instance writes to this file); the cost is one extra read
    // per event. Acceptable for v1 latency budget (50-200ms).
    let existing = ''
    try {
      existing = await storage.readFile(eventsPath)
    } catch {
      // First write — file doesn't exist yet. Create the directory
      // if the storage provider needs it (filesystem mkdir).
      await storage.mkdir(AUDIT_DIR).catch(() => {
        // Provider may not require mkdir (S3/R2 have no concept);
        // swallow.
      })
    }
    const line = JSON.stringify(event) + '\n'
    await storage.writeFile(eventsPath, existing + line)
  }

  async function readAllEvents(): Promise<AuditEvent[]> {
    // List all instance files + concat. readDir returns DirEntry
    // shapes; we filter to the events-*.jsonl pattern so unrelated
    // files (audit-index sidecars in the future) don't get parsed
    // as events.
    let entries: Awaited<ReturnType<StorageProvider['readDir']>>
    try {
      entries = await storage.readDir(AUDIT_DIR)
    } catch {
      // No audit directory yet — nothing to read.
      return []
    }
    const events: AuditEvent[] = []
    for (const entry of entries) {
      if (entry.isDirectory) continue
      if (!entry.name.startsWith('events-') || !entry.name.endsWith('.jsonl')) continue
      const content = await storage.readFile(`${AUDIT_DIR}/${entry.name}`)
      for (const line of content.split('\n')) {
        const trimmed = line.trim()
        if (!trimmed) continue
        try {
          events.push(JSON.parse(trimmed) as AuditEvent)
        } catch {
          // Malformed line — skip. A corrupt single line shouldn't
          // poison the whole query. Future: structured-log this.
        }
      }
    }
    return events
  }

  function matchesFilter(event: AuditEvent, filter: AuditQuery): boolean {
    if (filter.action && event.action !== filter.action) return false
    if (filter.outcome && event.outcome !== filter.outcome) return false
    if (filter.scope?.kind && event.scope.kind !== filter.scope.kind) return false
    if (filter.scope?.name && event.scope.name !== filter.scope.name) return false
    if (filter.actor) {
      const needle = filter.actor.toLowerCase()
      const idMatch = event.actor.id.toLowerCase().includes(needle)
      const emailMatch = event.actor.email?.toLowerCase().includes(needle) ?? false
      if (!idMatch && !emailMatch) return false
    }
    if (filter.since && event.timestamp < filter.since) return false
    if (filter.until && event.timestamp >= filter.until) return false
    return true
  }

  return {
    name: 'history',
    async record(event: AuditEvent): Promise<void> {
      await appendEvent(event)
    },
    async query(filter: AuditQuery): Promise<AuditEvent[]> {
      // Newest first, per the audit drawer's convention. Each instance's
      // file is in write order, and timestamps have millisecond resolution,
      // so back-to-back events often share one: reversing before the stable
      // sort keeps those newest-first too (#1244). Events from different
      // instances in the same millisecond have no recorded order.
      const all = (await readAllEvents()).reverse()
      all.sort((a, b) => b.timestamp.localeCompare(a.timestamp))
      const matched = all.filter(e => matchesFilter(e, filter))
      const limit = filter.limit ?? 100
      return matched.slice(0, Math.min(limit, 1000))
    },
    // queryUrl intentionally omitted — HistoryAuditProvider has
    // queryable storage; the drawer reads via query() directly.
  }
}
