import { defineStore } from 'pinia'
import { reactive, computed, toRaw } from 'vue'
import type { ComponentEntry, InlineComponent } from 'gazetta/types'
import { type ManifestFileKey, manifestFileKeyToString } from '../utils/manifestFileKey.js'

/**
 * One pending structural edit — both the original (for discard) and the
 * current pending state. The original is captured the first time a mutation
 * is applied for a key; subsequent mutations operate on `pending`.
 */
export interface StructuralEntry {
  original: readonly ComponentEntry[]
  pending: ComponentEntry[]
}

/**
 * Pending structural changes (move / add / remove of components on a page or
 * fragment manifest). Peer to {@link useEditorStashStore} which holds pending
 * content edits. Both lanes are flushed atomically by the editor save pipeline.
 *
 * Single-page focus: in v1 the UX limits structural pending to the
 * currently-focused page/fragment. The store's Map is keyed by `ManifestFileKey`
 * for forward-compat — multi-page support is a UX call away, not a state
 * rewrite.
 *
 * Pure state — no side effects, no other-store dependencies. Mutations are
 * intent-named (move / add / remove) so callers express intent and the store
 * enforces array shape.
 *
 * Drafts restored from the draft store wait in `restored` until their page
 * is opened in that locale (`activate`): until then they don't count as
 * pending and no Save writes them. Restored at once, a reorder acted on
 * whichever page was open (#979).
 */
export const useEditorStructuralStore = defineStore('editorStructural', () => {
  const entries = reactive<Map<string, StructuralEntry>>(new Map())
  const restored = reactive<Map<string, StructuralEntry>>(new Map())

  /**
   * Replace an entry's `pending` with a new array reference. Vue's reactivity on
   * Map<string, T> tracks T as a value — replacing the value (rather than
   * mutating it in place) is what fires deep watchers like the ComponentTree's
   * tree-build watch. Splicing the existing array would silently fail to
   * trigger a re-render because the Map.get() still returns the same reference.
   */
  function setPending(key: ManifestFileKey, original: readonly ComponentEntry[], next: ComponentEntry[]) {
    const k = manifestFileKeyToString(key)
    const existing = entries.get(k)
    entries.set(k, {
      original: existing?.original ?? original.slice(),
      pending: next,
    })
  }

  function moveComponent(key: ManifestFileKey, current: readonly ComponentEntry[], fromIndex: number, toIndex: number) {
    if (fromIndex === toIndex) return
    if (fromIndex < 0 || fromIndex >= current.length) return
    if (toIndex < 0 || toIndex >= current.length) return
    const next = current.slice()
    const [moved] = next.splice(fromIndex, 1)
    next.splice(toIndex, 0, moved)
    setPending(key, current, next)
  }

  function addComponent(
    key: ManifestFileKey,
    current: readonly ComponentEntry[],
    component: InlineComponent | string,
    insertIndex?: number,
  ) {
    const next = current.slice()
    const idx = insertIndex ?? next.length
    next.splice(idx, 0, component)
    setPending(key, current, next)
  }

  function removeComponent(key: ManifestFileKey, current: readonly ComponentEntry[], atIndex: number) {
    if (atIndex < 0 || atIndex >= current.length) return
    const next = current.slice()
    next.splice(atIndex, 1)
    setPending(key, current, next)
  }

  /**
   * Drop the pending entry for a key, reverting to disk-loaded order on next read.
   * No-op when no entry exists for the key.
   */
  function discard(key: ManifestFileKey) {
    const k = manifestFileKeyToString(key)
    entries.delete(k)
    restored.delete(k)
  }

  /** Drop every pending entry. Restored drafts of pages not opened yet stay. */
  function clearActive() {
    entries.clear()
  }

  /** The page is open in this locale: its restored draft becomes pending. */
  function activate(key: ManifestFileKey) {
    const k = manifestFileKeyToString(key)
    const draft = restored.get(k)
    if (!draft) return
    restored.delete(k)
    if (!entries.has(k)) entries.set(k, draft)
  }

  /**
   * After a save wrote `written`: an entry whose order now is the one written
   * goes away. One changed while the save ran stays pending, with the written
   * order as its new baseline.
   */
  function markWritten(written: Array<[string, StructuralEntry]>) {
    for (const [k, entry] of written) {
      const now = entries.get(k)
      if (!now) continue
      const original = toRaw(entry).pending.slice()
      if (JSON.stringify(now.pending) === JSON.stringify(original)) entries.delete(k)
      else entries.set(k, { original, pending: toRaw(now).pending })
    }
  }

  /** Current pending components for a key, or null if no entry exists. */
  function pendingFor(key: ManifestFileKey): ComponentEntry[] | null {
    return entries.get(manifestFileKeyToString(key))?.pending ?? null
  }

  /**
   * Replace everything with drafts loaded from the draft store; they wait in
   * `restored`. `original` (the discard baseline) is kept as stored.
   */
  function _hydrate(drafts: Array<[ManifestFileKey, StructuralEntry]>) {
    entries.clear()
    restored.clear()
    for (const [key, entry] of drafts) {
      restored.set(manifestFileKeyToString(key), { original: entry.original, pending: entry.pending })
    }
  }

  /** What the draft store keeps: pending and restored entries, raw. */
  function _keptEntries(): Map<string, StructuralEntry> {
    const kept = new Map<string, StructuralEntry>()
    for (const [k, entry] of restored) kept.set(k, toRaw(entry))
    for (const [k, entry] of entries) kept.set(k, toRaw(entry))
    return kept
  }

  function hasPendingFor(key: ManifestFileKey): boolean {
    return entries.has(manifestFileKeyToString(key))
  }

  /** All pending entries — consumers iterate to build the save payload + preview overrides. */
  function allEntries(): Array<[string, StructuralEntry]> {
    return [...entries.entries()]
  }

  const pendingCount = computed(() => entries.size)
  const hasPendingEdits = computed(() => entries.size > 0)

  return {
    entries,
    restored,
    moveComponent,
    addComponent,
    removeComponent,
    discard,
    clearActive,
    activate,
    markWritten,
    pendingFor,
    hasPendingFor,
    allEntries,
    pendingCount,
    hasPendingEdits,
    _hydrate,
    _keptEntries,
  }
})
