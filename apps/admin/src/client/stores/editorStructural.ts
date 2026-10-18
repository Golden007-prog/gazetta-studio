import { defineStore } from 'pinia'
import { reactive, computed } from 'vue'
import type { ComponentEntry, InlineComponent, ManifestKey } from 'gazetta/types'

/**
 * Which manifest file a structural edit belongs to. Locale variants are
 * whole files with their own component list (page.fr.json), so a reorder
 * made on `fr` belongs to `fr` only. Without the locale, a French reorder
 * restored after a reload was saved into page.json — French content and
 * all (reproduced 2026-10-18).
 */
export type StructuralKey = ManifestKey & {
  /** Undefined for the default locale. */
  locale?: string
}

/** Unambiguous for any name: a JSON array. */
export function structuralKeyToString(key: StructuralKey): string {
  return JSON.stringify([key.kind, key.name, key.locale ?? ''])
}

export function structuralKeyFromString(s: string): StructuralKey {
  const parsed: unknown = JSON.parse(s)
  if (!Array.isArray(parsed) || parsed.length !== 3) throw new Error(`Invalid structural key: ${s}`)
  const [kind, name, locale] = parsed
  if ((kind !== 'page' && kind !== 'fragment') || typeof name !== 'string' || typeof locale !== 'string') {
    throw new Error(`Invalid structural key: ${s}`)
  }
  return locale ? { kind, name, locale } : { kind, name }
}

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
 * currently-focused page/fragment. The store's Map is keyed by `StructuralKey`
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
  function setPending(key: StructuralKey, original: readonly ComponentEntry[], next: ComponentEntry[]) {
    const k = structuralKeyToString(key)
    const existing = entries.get(k)
    entries.set(k, {
      original: existing?.original ?? original.slice(),
      pending: next,
    })
  }

  function moveComponent(key: StructuralKey, current: readonly ComponentEntry[], fromIndex: number, toIndex: number) {
    if (fromIndex === toIndex) return
    if (fromIndex < 0 || fromIndex >= current.length) return
    if (toIndex < 0 || toIndex >= current.length) return
    const next = current.slice()
    const [moved] = next.splice(fromIndex, 1)
    next.splice(toIndex, 0, moved)
    setPending(key, current, next)
  }

  function addComponent(
    key: StructuralKey,
    current: readonly ComponentEntry[],
    component: InlineComponent | string,
    insertIndex?: number,
  ) {
    const next = current.slice()
    const idx = insertIndex ?? next.length
    next.splice(idx, 0, component)
    setPending(key, current, next)
  }

  function removeComponent(key: StructuralKey, current: readonly ComponentEntry[], atIndex: number) {
    if (atIndex < 0 || atIndex >= current.length) return
    const next = current.slice()
    next.splice(atIndex, 1)
    setPending(key, current, next)
  }

  /**
   * Drop the pending entry for a key, reverting to disk-loaded order on next read.
   * No-op when no entry exists for the key.
   */
  function discard(key: StructuralKey) {
    entries.delete(structuralKeyToString(key))
  }

  function clearAll() {
    entries.clear()
  }

  /** Current pending components for a key, or null if no entry exists. */
  function pendingFor(key: StructuralKey): ComponentEntry[] | null {
    return entries.get(structuralKeyToString(key))?.pending ?? null
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
  function _hydrateFromSnapshot(key: StructuralKey, entry: StructuralEntry): void {
    entries.set(structuralKeyToString(key), {
      original: entry.original,
      pending: entry.pending,
    })
  }

  function hasPendingFor(key: StructuralKey): boolean {
    return entries.has(structuralKeyToString(key))
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
    pendingFor,
    hasPendingFor,
    allEntries,
    pendingCount,
    hasPendingEdits,
    _hydrateFromSnapshot,
  }
})
