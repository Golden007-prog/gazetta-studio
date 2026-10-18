/**
 * IndexedDB draft store. Its own database — not the `AdminCache` one —
 * so drafts are never evicted and every write is its own transaction.
 *
 * Records are keyed `[site, owner, target, kind, key]`. IndexedDB orders
 * array keys element by element and sorts arrays after strings, so
 * `[...prefix]` to `[...prefix, []]` spans exactly the records that
 * start with that prefix.
 */
import { type IDBPDatabase, openDB } from 'idb'
import { type DraftIdentity, type DraftKind, type DraftScope, type DraftStore, plainCopy } from './types.js'

const DB_NAME = 'gazetta-drafts'
const DB_VERSION = 1
const DRAFTS = 'drafts'
const META = 'meta'
const LAST_IDENTITY = 'last-identity'

type DraftId = [site: string, owner: string, target: string, kind: DraftKind, key: string]

interface DraftRow {
  id: DraftId
  value: unknown
}

export interface IndexedDBDraftStoreOptions {
  /** Override the database name. Tests use a unique name per test. */
  dbName?: string
}

function prefixRange(prefix: readonly string[]): IDBKeyRange {
  return IDBKeyRange.bound([...prefix], [...prefix, []])
}

export async function createIndexedDBDraftStore(opts: IndexedDBDraftStoreOptions = {}): Promise<DraftStore> {
  const db: IDBPDatabase = await openDB(opts.dbName ?? DB_NAME, DB_VERSION, {
    upgrade(database) {
      database.createObjectStore(DRAFTS, { keyPath: 'id' })
      database.createObjectStore(META)
    },
  })

  return {
    durable: true,

    async list<T>(scope: DraftScope, kind: DraftKind): Promise<Array<[string, T]>> {
      const rows = (await db.getAll(DRAFTS, prefixRange([scope.site, scope.owner, scope.target, kind]))) as DraftRow[]
      return rows.map(row => [row.id[4], row.value as T])
    },

    async put<T>(scope: DraftScope, kind: DraftKind, key: string, value: T): Promise<void> {
      const row: DraftRow = { id: [scope.site, scope.owner, scope.target, kind, key], value: plainCopy(value) }
      await db.put(DRAFTS, row)
    },

    async delete(scope: DraftScope, kind: DraftKind, key: string): Promise<void> {
      await db.delete(DRAFTS, [scope.site, scope.owner, scope.target, kind, key])
    },

    async purgeOtherOwners(identity: DraftIdentity): Promise<number> {
      const tx = db.transaction(DRAFTS, 'readwrite')
      let deleted = 0
      let cursor = await tx.store.openCursor(prefixRange([identity.site]))
      while (cursor) {
        if ((cursor.value as DraftRow).id[1] !== identity.owner) {
          await cursor.delete()
          deleted++
        }
        cursor = await cursor.continue()
      }
      await tx.done
      return deleted
    },

    async lastIdentity(): Promise<DraftIdentity | null> {
      return ((await db.get(META, LAST_IDENTITY)) as DraftIdentity | undefined) ?? null
    },

    async setLastIdentity(identity: DraftIdentity): Promise<void> {
      await db.put(META, plainCopy(identity), LAST_IDENTITY)
    },
  }
}
