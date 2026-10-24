/**
 * Persisted-edits store per `design-offline.md` Cut 8b. Mirrors
 * the in-memory `editorStash` + the live `editorContent` dirty
 * state into a cross-reload-survivable bag of pure-data entries.
 *
 * # Why a separate store, not extend editorStash
 *
 * `editorStash` is intra-selection: keyed by `target.path` (`hero`,
 * `_root`, `@logo`). Two pages can have a component named `hero`;
 * the stash key collides. That's fine in-memory because the
 * stash is conceptually "OTHER things I was editing within this
 * page" — switching pages clears the home page's relevant context.
 *
 * Persistence demands cross-page correctness: dirty content on
 * `pages/home/_root` must NOT overlay on `pages/about/_root` after
 * a reload. So this store uses richer keys:
 *
 *   page:{name}:{locale?}:{path}
 *   fragment:{name}:{locale?}:{path}
 *
 * # SOLID lenses
 *
 *   - SRP: this store owns "what dirty/stashed edits exist that
 *     must survive reload, and where do they belong." It does NOT
 *     know how the editor consumes them (useEditorActions navigate
 *     seam) or how they get to disk (drafts/persistence).
 *   - DIP: tests + persistence coordinator depend on the typed
 *     API; the underlying Map is implementation detail.
 *
 * # What's persisted
 *
 * Only fields that survive serialization. The `EditingTarget`
 * carries a `save` closure — NOT serializable. We persist the
 * data the editor needs to recreate the edit:
 *
 *   - selectionKey (richer than stash key; survives cross-page)
 *   - editedContent (the dirty content the user typed)
 *   - base (the manifest's save-etag when the edit was made; sent as
 *     If-Match once the draft is restored, so a newer save conflicts)
 *
 * The save closure rebuilds via `useEditorActions.buildTarget(sel)`
 * on the navigate-back path; that's a pure function over the
 * fresh selection state.
 */
import { defineStore } from 'pinia'
import { computed, ref } from 'vue'
import type { EditorSelection } from '../composables/editorSelection.js'

/** The version of a manifest an edit was made on: the save-etag to send as If-Match. */
export interface DraftBase {
  /** Manifest path, as in the etag store (`pages/home/page.json`). */
  manifest: string
  etag: string
}

export interface PersistedEdit {
  /** Stable cross-page key for the (selection, locale, path) tuple. */
  key: string
  /** The author's dirty content. JSON-serializable. */
  editedContent: Record<string, unknown>
  /** ISO timestamp when the entry was last touched (for diagnostics). */
  updatedAt: string
  /** Absent on drafts stored before the version was recorded: those save over the current version. */
  base?: DraftBase
}

/**
 * Build the persistence key for a (kind, name, locale, path) tuple.
 * Same shape as the on-disk format; pure function.
 *
 * Examples:
 *   page:home::_root
 *   page:home:fr:_root          (French variant of home page root)
 *   page:home::hero             (hero component on default-locale home)
 *   fragment:header::logo       (logo component within header fragment)
 *   fragment:header::@root      (the fragment-edit page root)
 */
export function persistedEditKey(
  kind: 'page' | 'fragment',
  name: string,
  locale: string | undefined,
  path: string,
): string {
  return `${kind}:${name}:${locale ?? ''}:${path}`
}

/**
 * Build the persistence key from an EditorSelection + (kind, name).
 * The selection store knows kind+name; the selection knows the
 * within-target path. Returns null when the selection isn't a
 * persistable target (`fragmentLink` opens nothing — nothing to
 * persist).
 */
export function persistedEditKeyForSelection(
  sel: EditorSelection,
  kind: 'page' | 'fragment' | null,
  name: string | null,
  locale: string | undefined,
): string | null {
  if (!kind || !name) return null
  switch (sel.kind) {
    case 'root':
      return persistedEditKey(kind, name, locale, '_root')
    case 'component':
      return persistedEditKey(kind, name, locale, sel.path)
    case 'fragmentEdit':
      return persistedEditKey('fragment', sel.fragmentName, locale, '_root')
    case 'fragmentLink':
      return null
  }
}

export const usePersistedEditsStore = defineStore('persistedEdits', () => {
  const entries = ref<Map<string, PersistedEdit>>(new Map())

  function set(key: string, editedContent: Record<string, unknown>, base?: DraftBase): void {
    const next = new Map(entries.value)
    // The version is pinned when the edit starts; later edits keep it
    // (#1109). It moves only via rebase, after a write lands.
    const kept = entries.value.get(key)?.base ?? base
    next.set(key, { key, editedContent, updatedAt: new Date().toISOString(), ...(kept ? { base: kept } : {}) })
    entries.value = next
  }

  /** A write made on `from` succeeded with `to`: drafts made on `from` are now on `to`. */
  function rebase(manifest: string, from: string, to: string): void {
    let changed = false
    const next = new Map(entries.value)
    for (const [k, entry] of entries.value) {
      if (entry.base?.manifest !== manifest || entry.base.etag !== from) continue
      next.set(k, { ...entry, base: { manifest, etag: to } })
      changed = true
    }
    if (changed) entries.value = next
  }

  /**
   * A write on `manifest` conflicted: this session's pending entries (the
   * open editor and the stash) move to `to`, so the next Save goes through
   * (#1109). A draft never opened this session keeps the version it was
   * made on: it was no part of the conflict, and moving it would let its
   * later save skip the conflict check and silently overwrite the remote
   * change (#1233 review).
   */
  function rebaseOpened(keys: readonly string[], manifest: string, to: string): void {
    const wanted = new Set(keys)
    let changed = false
    const next = new Map(entries.value)
    for (const [k, entry] of entries.value) {
      if (!wanted.has(k) || entry.base?.manifest !== manifest) continue
      next.set(k, { ...entry, base: { manifest, etag: to } })
      changed = true
    }
    if (changed) entries.value = next
  }

  function get(key: string): PersistedEdit | null {
    return entries.value.get(key) ?? null
  }

  function has(key: string): boolean {
    return entries.value.has(key)
  }

  function clear(key: string): void {
    if (!entries.value.has(key)) return
    const next = new Map(entries.value)
    next.delete(key)
    entries.value = next
  }

  /** Drop every entry for one page or fragment in one locale, whatever its path. */
  function clearItem(kind: 'page' | 'fragment', name: string, locale: string | undefined): void {
    const prefix = persistedEditKey(kind, name, locale, '')
    const next = new Map([...entries.value].filter(([k]) => !k.startsWith(prefix)))
    if (next.size !== entries.value.size) entries.value = next
  }

  function clearAll(): void {
    entries.value = new Map()
  }

  /**
   * Internal hydration primitive used by the persistence
   * coordinator. Replaces the entire entries map atomically (one
   * reactive trigger) instead of N individual `set`s. App code
   * uses `set` / `clear`.
   */
  function _hydrateAll(replacements: Iterable<[string, PersistedEdit]>): void {
    entries.value = new Map(replacements)
  }

  const count = computed(() => entries.value.size)
  const hasAny = computed(() => entries.value.size > 0)

  return {
    entries,
    count,
    hasAny,
    set,
    get,
    has,
    clear,
    clearItem,
    clearAll,
    rebase,
    rebaseOpened,
    _hydrateAll,
  }
})
