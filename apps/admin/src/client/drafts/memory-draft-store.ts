/**
 * In-memory draft store — the fallback when IndexedDB is unavailable
 * (mostly private browsing). Same contract as the IndexedDB store, but
 * drafts are lost on reload.
 */
import { type DraftIdentity, type DraftKind, type DraftScope, type DraftStore, plainCopy } from './types.js'

export function createMemoryDraftStore(): DraftStore {
  // Key: JSON of [site, owner, target, kind, key] — unambiguous for any strings.
  const rows = new Map<string, { id: [string, string, string, DraftKind, string]; value: unknown }>()
  let last: DraftIdentity | null = null
  const idOf = (scope: DraftScope, kind: DraftKind, key: string) =>
    [scope.site, scope.owner, scope.target, kind, key] as [string, string, string, DraftKind, string]

  return {
    durable: false,

    async list<T>(scope: DraftScope, kind: DraftKind): Promise<Array<[string, T]>> {
      const out: Array<[string, T]> = []
      for (const { id, value } of rows.values()) {
        if (id[0] === scope.site && id[1] === scope.owner && id[2] === scope.target && id[3] === kind) {
          out.push([id[4], plainCopy(value) as T])
        }
      }
      return out
    },

    async put<T>(scope: DraftScope, kind: DraftKind, key: string, value: T): Promise<void> {
      const id = idOf(scope, kind, key)
      rows.set(JSON.stringify(id), { id, value: plainCopy(value) })
    },

    async delete(scope: DraftScope, kind: DraftKind, key: string): Promise<void> {
      rows.delete(JSON.stringify(idOf(scope, kind, key)))
    },

    async purgeOtherOwners(identity: DraftIdentity): Promise<number> {
      let deleted = 0
      for (const [k, { id }] of rows) {
        if (id[0] === identity.site && id[1] !== identity.owner) {
          rows.delete(k)
          deleted++
        }
      }
      return deleted
    },

    async lastIdentity(): Promise<DraftIdentity | null> {
      return last ? { ...last } : null
    },

    async setLastIdentity(identity: DraftIdentity): Promise<void> {
      last = { ...identity }
    },
  }
}
