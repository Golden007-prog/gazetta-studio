/**
 * Keeps the pending-edit stores in the draft store, so unsaved work
 * survives a reload — for the right site, user and target only.
 *
 *   editorStructural  → kind 'structural'  (component reorder / add / remove)
 *   persistedEdits    → kind 'edit'        (field content, cross-page keys)
 *   editorMetadata    → kind 'metadata'    (page metadata, per page and locale)
 *
 * Writes are per record: after a debounce, only entries whose value
 * changed are put and only entries that went away are deleted. The
 * stores make a new entry object on every change, so comparing raw
 * references finds the changes. Nothing writes whole snapshots, so two
 * tabs don't delete each other's drafts.
 *
 * When the scope changes (the active target is first known, or switches),
 * pending writes go to the old scope first, then both stores are replaced
 * with the new scope's drafts. A null scope (identity unknown, or no
 * target yet) loads and writes nothing.
 */
import { toRaw, watch } from 'vue'
import type { ComponentEntry } from 'gazetta/types'
import { useEditorStructuralStore } from '../stores/editorStructural.js'
import { manifestFileKeyFromString } from '../utils/manifestFileKey.js'
import { type PersistedEdit, usePersistedEditsStore } from '../stores/persistedEdits.js'
import { type MetadataEntry, useEditorMetadataStore } from '../stores/editorMetadata.js'
import type { DraftKind, DraftScope, DraftStore } from './types.js'

const DEFAULT_DEBOUNCE_MS = 300

interface StructuralValue {
  original: ComponentEntry[]
  pending: ComponentEntry[]
}

/** One pending-edit store, seen as a map of key → entry the draft store can hold. */
interface Lane {
  kind: DraftKind
  /** Current entries, raw (not reactive proxies). */
  read(): Map<string, unknown>
  /** Replace the store's contents with loaded drafts. */
  replace(entries: Array<[string, unknown]>): void
  /** What to store for an entry. */
  serialize(entry: unknown): unknown
}

function structuralLane(): Lane {
  const store = useEditorStructuralStore()
  return {
    kind: 'structural',
    read: () => new Map([...store.entries].map(([k, v]) => [k, toRaw(v)])),
    replace(entries) {
      store.clearAll()
      for (const [k, value] of entries) {
        let key
        try {
          key = manifestFileKeyFromString(k)
        } catch {
          continue // a key shape this version doesn't know; keep the rest
        }
        const v = value as StructuralValue
        // The hydration primitive keeps `original` (the discard baseline) as stored.
        store._hydrateFromSnapshot(key, { original: v.original, pending: v.pending })
      }
    },
    serialize: entry => {
      const e = entry as StructuralValue
      return { original: e.original.slice(), pending: e.pending.slice() }
    },
  }
}

function editLane(): Lane {
  const store = usePersistedEditsStore()
  return {
    kind: 'edit',
    read: () => new Map([...store.entries].map(([k, v]) => [k, toRaw(v)])),
    replace(entries) {
      store._hydrateAll(
        entries.filter((pair): pair is [string, PersistedEdit] => {
          const v = pair[1] as PersistedEdit | null
          return !!v && typeof v.editedContent === 'object' && v.editedContent !== null
        }),
      )
    },
    serialize: entry => entry,
  }
}

function metadataLane(): Lane {
  const store = useEditorMetadataStore()
  return {
    kind: 'metadata',
    read: () => store._keptEntries(),
    replace: entries => store._hydrate(entries),
    serialize: entry => {
      const e = entry as MetadataEntry
      return { original: e.original, pending: e.pending }
    },
  }
}

export interface DraftPersistenceOptions {
  /** Delay between a store change and the write. Tests pass 0. */
  debounceMs?: number
}

export interface DraftPersistenceHandle {
  /** Resolves when the current scope's drafts are loaded into the stores. */
  loaded(): Promise<void>
  /** Write everything pending now. */
  flush(): Promise<void>
  /** Stop watching. Pending writes are not flushed; call flush() first if needed. */
  dispose(): void
}

/** The attached coordinator, so the editor can wait for drafts before reading one. */
let attached: DraftPersistenceHandle | null = null

/** Resolves once the current scope's drafts are in the stores (immediately if none attached). */
export function draftsLoaded(): Promise<void> {
  return attached?.loaded() ?? Promise.resolve()
}

export function attachDraftPersistence(
  drafts: DraftStore,
  scope: () => DraftScope | null,
  opts: DraftPersistenceOptions = {},
): DraftPersistenceHandle {
  const debounceMs = opts.debounceMs ?? DEFAULT_DEBOUNCE_MS
  const lanes = [structuralLane(), editLane(), metadataLane()]
  /** Per lane: the raw entry last written (or loaded) for each key, in `current`. */
  const written = new Map<DraftKind, Map<string, unknown>>(lanes.map(l => [l.kind, new Map()]))
  let current: DraftScope | null = null
  let loading = false
  let timer: ReturnType<typeof setTimeout> | null = null
  // Serialises loads and writes so a write never lands mid-load or under the wrong scope.
  let queue: Promise<void> = Promise.resolve()
  const enqueue = (job: () => Promise<void>) => {
    queue = queue.then(job, job)
    return queue
  }

  async function writeChanges(into: DraftScope | null): Promise<void> {
    if (!into) return
    for (const lane of lanes) {
      const seen = written.get(lane.kind)!
      const now = lane.read()
      for (const [key, entry] of now) {
        if (seen.get(key) === entry) continue
        await drafts.put(into, lane.kind, key, lane.serialize(entry))
        seen.set(key, entry)
      }
      for (const key of [...seen.keys()]) {
        if (now.has(key)) continue
        await drafts.delete(into, lane.kind, key)
        seen.delete(key)
      }
    }
  }

  async function load(next: DraftScope | null): Promise<void> {
    loading = true
    try {
      for (const lane of lanes) {
        lane.replace(next ? await drafts.list(next, lane.kind) : [])
        // What's in the store now matches what's stored for `next`.
        written.set(lane.kind, lane.read())
      }
      current = next
    } finally {
      loading = false
    }
  }

  const flush = () => {
    if (timer !== null) {
      clearTimeout(timer)
      timer = null
    }
    return enqueue(() => writeChanges(current))
  }

  const sameScope = (a: DraftScope | null, b: DraftScope | null) =>
    a === b || (!!a && !!b && a.site === b.site && a.owner === b.owner && a.target === b.target)

  const stopScope = watch(
    scope,
    next => {
      if (sameScope(next, current)) return
      void flush() // pending writes belong to the old scope
      enqueue(() => load(next))
    },
    { immediate: true },
  )

  const metadata = useEditorMetadataStore()
  const stores = [useEditorStructuralStore(), usePersistedEditsStore()]
  const stopStores = watch(
    () => [
      ...stores.map(s => [...s.entries.entries()]),
      [...metadata.entries.entries()],
      [...metadata.restored.entries()],
    ],
    () => {
      if (loading) return
      if (timer !== null) clearTimeout(timer)
      timer = setTimeout(() => {
        timer = null
        void enqueue(() => writeChanges(current))
      }, debounceMs)
    },
    { deep: true },
  )

  const handle: DraftPersistenceHandle = {
    loaded: () => queue,
    flush,
    dispose() {
      if (attached === handle) attached = null
      stopScope()
      stopStores()
      if (timer !== null) clearTimeout(timer)
      timer = null
    },
  }
  attached = handle
  return handle
}
