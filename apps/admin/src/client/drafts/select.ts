/**
 * Pick the draft store: IndexedDB, or memory when IndexedDB is unusable.
 * `cacheDegraded` comes from the cache provider's probe (private browsing
 * mostly); a failure opening the drafts database falls back the same way.
 */
import { createIndexedDBDraftStore } from './idb-draft-store.js'
import { createMemoryDraftStore } from './memory-draft-store.js'
import type { DraftStore } from './types.js'

export async function selectDraftStore(cacheDegraded: boolean): Promise<DraftStore> {
  if (cacheDegraded) return createMemoryDraftStore()
  try {
    return await createIndexedDBDraftStore()
  } catch {
    return createMemoryDraftStore()
  }
}
