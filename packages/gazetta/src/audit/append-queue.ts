/**
 * In-process serialization for read-modify-write operations on one
 * storage object, keyed by file path.
 *
 * Cloud StorageProvider has no append primitive, so both the audit
 * appender (`HistoryAuditProvider`) and the retention pruner
 * (`pruneAuditEvents`) write whole files. Two overlapping
 * read-modify-write cycles on the same file race: the later write
 * overwrites whatever the earlier cycle wrote (#1257), and a pruner
 * rewrite outside the queue loses appends that landed between its
 * read and its write — or resurrects events it evicted (#1414).
 *
 * Keying is (storage object, file path) at module level, not per
 * provider object, because each createAdminApp builds its own
 * provider and two providers in one process can write the same
 * `events-{instance}.jsonl`. Keying by storage object keeps
 * independent storages independent; `createAdminApp` passes the same
 * `source.storage` to the audit provider and the prune runner, so
 * appends and prunes on one target serialize with each other.
 *
 * A failed task must not block later work: each task chains on the
 * previous one with the failure swallowed. The caller still gets its
 * own rejection (`recordToAll` handles append failures; the prune
 * runner logs and fails open). A storage operation that never
 * settles stalls later tasks for that file — the bound belongs in
 * the storage client's own timeouts, not here: a queue-level timeout
 * cannot abort the in-flight write, so the queue would advance while
 * the late write still lands and clobbers newer content.
 */
import type { StorageProvider } from '../types.js'

const queues = new WeakMap<StorageProvider, Map<string, Promise<void>>>()

export function enqueueStorageTask(storage: StorageProvider, path: string, task: () => Promise<void>): Promise<void> {
  let byPath = queues.get(storage)
  if (!byPath) {
    byPath = new Map()
    queues.set(storage, byPath)
  }
  const prev = byPath.get(path) ?? Promise.resolve()
  const run = prev.catch(() => {}).then(task)
  byPath.set(path, run)
  const cleanup = () => {
    if (byPath.get(path) === run) byPath.delete(path)
  }
  run.then(cleanup, cleanup)
  return run
}
