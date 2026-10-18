import { defineStore } from 'pinia'
import { computed, reactive, toRaw } from 'vue'
import type { PageMetadata } from '../api/client.js'
import { type ManifestFileKey, manifestFileKeyFromString, manifestFileKeyToString } from '../utils/manifestFileKey.js'

/** Page metadata as stored: the fields the form shows, plus any keys it doesn't. */
export type MetadataValue = NonNullable<PageMetadata> & Record<string, unknown>

/** The form's text fields. `robots` changes only through `setNoindex`. */
export type MetadataTextField = 'title' | 'description' | 'ogImage' | 'canonical'

/** Metadata belongs to pages only. */
export type MetadataKey = ManifestFileKey & { kind: 'page' }

export interface MetadataEntry {
  /** The metadata as loaded when the first edit was made: Discard's baseline. */
  original: Readonly<MetadataValue>
  pending: MetadataValue
}

/**
 * Whether a robots value hides the page from search engines. The publisher
 * sets the sitemap's noindex flag with the same test, so the checkbox and
 * the sitemap agree.
 */
export function hasNoindex(robots: unknown): boolean {
  return typeof robots === 'string' && robots.includes('noindex')
}

/** A plain copy. JSON, because the loaded value is often a Vue proxy, which structuredClone rejects. */
function copy(value: unknown): MetadataValue {
  return value && typeof value === 'object' && !Array.isArray(value) ? JSON.parse(JSON.stringify(value)) : {}
}

function canonical(value: unknown): string {
  return JSON.stringify(value, (_key, v: unknown) =>
    v && typeof v === 'object' && !Array.isArray(v)
      ? Object.fromEntries(
          Object.keys(v)
            .sort()
            .map(k => [k, (v as Record<string, unknown>)[k]]),
        )
      : v,
  )
}

/**
 * Unsaved page-metadata edits (SEO title, description, OG image, canonical,
 * robots), one entry per page and locale. Peer to the structural and content
 * lanes; the editor's one Save writes all three.
 *
 * An entry exists only while its pending value differs from the original, so
 * editing a field back to what was loaded clears it. The comparison ignores
 * key order: an emptied field typed back in returns as the last key.
 *
 * Editing keeps what the form doesn't show: `pending` starts as a copy of
 * the loaded metadata and each edit changes only its own field, so unknown
 * keys and other robots tokens survive. An emptied text field removes its key.
 *
 * Drafts restored from the draft store wait in `restored` until their page
 * is opened in that locale (`activate`): until then they don't count as
 * pending and no Save writes them. Restored at once, a draft would act on
 * whichever page is open (#979 shows this for reorders).
 */
export const useEditorMetadataStore = defineStore('editorMetadata', () => {
  const entries = reactive<Map<string, MetadataEntry>>(new Map())
  const restored = reactive<Map<string, MetadataEntry>>(new Map())

  function update(
    key: MetadataKey,
    loaded: PageMetadata | null,
    edit: (next: MetadataValue, original: Readonly<MetadataValue>) => void,
  ) {
    const k = manifestFileKeyToString(key)
    const existing = entries.get(k)
    const original = existing ? toRaw(existing.original) : copy(loaded)
    const next = copy(existing?.pending ?? original)
    edit(next, original)
    if (canonical(next) === canonical(original)) entries.delete(k)
    // A new entry object on every change: the draft store finds changes by reference.
    else entries.set(k, { original, pending: next })
  }

  function setField(key: MetadataKey, loaded: PageMetadata | null, field: MetadataTextField, value: string) {
    update(key, loaded, next => {
      if (value === '') delete next[field]
      else next[field] = value
    })
  }

  /**
   * Add or remove the `noindex` token of `robots`, keeping the others. The new
   * value is derived from the original rather than the last edit, so ticking
   * the box back restores the original string exactly.
   */
  function setNoindex(key: MetadataKey, loaded: PageMetadata | null, on: boolean) {
    update(key, loaded, (next, original) => {
      if (hasNoindex(original.robots) === on) {
        if ('robots' in original) next.robots = original.robots
        else delete next.robots
        return
      }
      const base = typeof original.robots === 'string' ? original.robots : ''
      if (on) {
        next.robots = base ? `noindex, ${base}` : 'noindex'
        return
      }
      const rest = base
        .split(',')
        .map(token => token.trim())
        .filter(token => token && !token.includes('noindex'))
      if (rest.length > 0) next.robots = rest.join(', ')
      else delete next.robots
    })
  }

  /** The unsaved metadata of a page, or null when it has none. */
  function pendingFor(key: MetadataKey): MetadataValue | null {
    return entries.get(manifestFileKeyToString(key))?.pending ?? null
  }

  function hasPendingFor(key: MetadataKey): boolean {
    return entries.has(manifestFileKeyToString(key))
  }

  /** Drop a page's unsaved metadata. */
  function discard(key: MetadataKey) {
    const k = manifestFileKeyToString(key)
    entries.delete(k)
    restored.delete(k)
  }

  /** Drop every pending entry. Restored drafts of pages not opened yet stay. */
  function clearActive() {
    entries.clear()
  }

  /** The page is open in this locale: its restored draft becomes pending. */
  function activate(key: MetadataKey) {
    const k = manifestFileKeyToString(key)
    const draft = restored.get(k)
    if (!draft) return
    restored.delete(k)
    if (!entries.has(k)) entries.set(k, draft)
  }

  /**
   * Replace everything with drafts loaded from the draft store; they wait in
   * `restored`. Records this version can't read are skipped.
   */
  function _hydrate(drafts: Array<[string, unknown]>) {
    entries.clear()
    restored.clear()
    for (const [k, value] of drafts) {
      let key
      try {
        key = manifestFileKeyFromString(k)
      } catch {
        continue
      }
      const v = value as Partial<MetadataEntry> | null
      const isObject = (x: unknown) => !!x && typeof x === 'object' && !Array.isArray(x)
      if (key.kind !== 'page' || !v || !isObject(v.original) || !isObject(v.pending)) continue
      restored.set(k, { original: copy(v.original), pending: copy(v.pending) })
    }
  }

  /** What the draft store keeps: pending and restored entries, raw. */
  function _keptEntries(): Map<string, MetadataEntry> {
    const kept = new Map<string, MetadataEntry>()
    for (const [k, entry] of restored) kept.set(k, toRaw(entry))
    for (const [k, entry] of entries) kept.set(k, toRaw(entry))
    return kept
  }

  /**
   * After a save wrote `written`: an entry whose value now is the one written
   * goes away. One edited while the save ran stays pending, with the written
   * value as its new baseline.
   */
  function markWritten(written: Array<[string, MetadataEntry]>) {
    for (const [k, entry] of written) {
      const now = entries.get(k)
      if (!now) continue
      const original = copy(entry.pending)
      if (canonical(now.pending) === canonical(original)) entries.delete(k)
      else entries.set(k, { original, pending: copy(now.pending) })
    }
  }

  /** Every pending entry with its string key — the save iterates these. */
  function allEntries(): Array<[string, MetadataEntry]> {
    return [...entries.entries()]
  }

  const pendingCount = computed(() => entries.size)
  const hasPendingEdits = computed(() => entries.size > 0)

  return {
    entries,
    restored,
    setField,
    setNoindex,
    pendingFor,
    hasPendingFor,
    discard,
    clearActive,
    activate,
    markWritten,
    allEntries,
    pendingCount,
    hasPendingEdits,
    _hydrate,
    _keptEntries,
  }
})
