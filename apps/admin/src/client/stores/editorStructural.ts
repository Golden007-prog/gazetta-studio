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
 */
export const useEditorStructuralStore = defineStore('editorStructural', () => {
  const entries = reactive<Map<string, StructuralEntry>>(new Map())

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
    entries.delete(manifestFileKeyToString(key))
  }

  function clearAll() {
    entries.clear()
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
   * Hydration primitive — restore a previously-persisted entry with
   * both `original` and `pending` arrays as-is. Used by the pending-
   * edits persistence module at admin boot. Leading underscore flags
   * the method as internal: app code MUST use the intent-named
   * mutators (move / add / remove / discard) which preserve the
   * "original captured once" invariant. This bypasses that invariant
   * because the persisted snapshot IS the prior captured original.
   */
  function _hydrateFromSnapshot(key: ManifestFileKey, entry: StructuralEntry): void {
    entries.set(manifestFileKeyToString(key), {
      original: entry.original,
      pending: entry.pending,
    })
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
    moveComponent,
    addComponent,
    removeComponent,
    discard,
    clearAll,
    markWritten,
    pendingFor,
    hasPendingFor,
    allEntries,
    pendingCount,
    hasPendingEdits,
    _hydrateFromSnapshot,
  }
})
