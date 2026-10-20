function deepClone<T>(obj: T): T {
  return JSON.parse(JSON.stringify(obj))
}

import { computed, toRaw } from 'vue'
import type { DraftOverrides, ManifestKey } from 'gazetta/types'
import { manifestKeyToString } from 'gazetta/types'
import { useToastStore } from '../stores/toast.js'
import { usePreviewStore } from '../stores/preview.js'
import { useSelectionStore } from '../stores/selection.js'
import { usePublishStatusStore } from '../stores/publishStatus.js'
import { useActiveTargetStore } from '../stores/activeTarget.js'
import { useSiteStore } from '../stores/site.js'
import { useEditorStashStore } from '../stores/editorStash.js'
import { useEditorStructuralStore } from '../stores/editorStructural.js'
import {
  type MetadataKey,
  type MetadataTextField,
  type MetadataValue,
  useEditorMetadataStore,
} from '../stores/editorMetadata.js'
import { type ManifestFileKey, manifestFileKeyFromString } from '../utils/manifestFileKey.js'
import { useEditorPersistenceStore, type ManifestWrite } from '../stores/editorPersistence.js'
import { useEditorContentStore, type EditingTarget } from '../stores/editorContent.js'
import { useValidationIssuesStore } from '../stores/validationIssues.js'
import { type EditorSelection, selectionToStashKey, selectionToErrorLabel } from './editorSelection.js'
import { api, type PageMetadata, StaleSaveError, ValidationFailedError } from '../api/client.js'
import { useLocaleStore } from '../stores/locale.js'
import { useEditorEtagsStore, manifestPath } from '../stores/editorEtags.js'
import { useSaveConflictsStore } from '../stores/saveConflicts.js'
import { persistedEditKey, persistedEditKeyForSelection, usePersistedEditsStore } from '../stores/persistedEdits.js'
import { draftsLoaded } from '../drafts/persistence.js'

const MAX_RETRY_ATTEMPTS = 3
const BASE_RETRY_DELAY = 3000

/**
 * Editor action mediator — one entry point for all editor navigation.
 *
 * All component opens go through `navigate(sel)`. It handles stash,
 * abort, fetch, open, retry — in one place. The AbortController cancels
 * pending fetches when a new navigation starts, matching the pattern
 * already used in selection.ts for page/fragment loading.
 */
export function useEditorActions() {
  const toast = useToastStore()
  const stash = useEditorStashStore()
  const structural = useEditorStructuralStore()
  const persistence = useEditorPersistenceStore()
  const ec = useEditorContentStore()
  const metadata = useEditorMetadataStore()

  // --- Navigation state ---

  let navController: AbortController | null = null
  let retryTimer: ReturnType<typeof setTimeout> | null = null
  let retryAttempt = 0

  function cancelPending() {
    navController?.abort()
    navController = null
    if (retryTimer !== null) {
      clearTimeout(retryTimer)
      retryTimer = null
    }
    retryAttempt = 0
  }

  // --- Cross-page persisted-edits key helper (Cut 8b) ---

  /**
   * Build the persisted-edits key for a (selection, target) pair.
   * Returns null when the active context isn't a persistable target
   * (no selection, no target, fragment-link host).
   */
  function persistedKeyForCurrent(): string | null {
    const sel = useSelectionStore()
    if (!sel.selection || !ec.target) return null
    const kind = sel.selection.type === 'page' ? 'page' : 'fragment'
    const locale = useLocaleStore().effectiveLocale ?? undefined
    return persistedEditKey(kind, sel.selection.name, locale, ec.target.path)
  }

  /** Same shape, but for a stash entry's target.path. */
  function persistedKeyForStashEntry(targetPath: string): string | null {
    const sel = useSelectionStore()
    if (!sel.selection) return null
    const kind = sel.selection.type === 'page' ? 'page' : 'fragment'
    const locale = useLocaleStore().effectiveLocale ?? undefined
    return persistedEditKey(kind, sel.selection.name, locale, targetPath)
  }

  // --- Stash ---

  function stashCurrent() {
    if (ec.dirty && ec.target && ec.content) {
      stash.stash(ec.target.path, ec.target, deepClone(ec.content))
      // Mirror into the cross-page persisted store (Cut 8b) so the
      // edit survives reload. The in-memory stash is keyed by
      // target.path which collides across pages; persistedEdits uses
      // the richer (kind, name, locale, path) tuple.
      const key = persistedKeyForCurrent()
      if (key) usePersistedEditsStore().set(key, deepClone(ec.content))
    }
  }

  // --- Schema + component lookup ---

  async function fetchSchema(templateName: string, signal: AbortSignal) {
    const response = await api.getTemplateSchema(templateName, { signal })
    const { hasEditor, editorUrl, fieldsBaseUrl, ...schema } = response as Record<string, unknown> & {
      hasEditor?: boolean
      editorUrl?: string
      fieldsBaseUrl?: string
    }
    return { schema, hasEditor: !!hasEditor, editorUrl, fieldsBaseUrl }
  }

  function resolveComponentPath(namePath: string): string {
    const sel = useSelectionStore()
    if (sel.type === 'fragment' && sel.name && namePath.startsWith(`@${sel.name}/`)) {
      return namePath.slice(`@${sel.name}/`.length)
    }
    return namePath
  }

  function findComponentByNamePath(namePath: string): { template: string; content: Record<string, unknown> } | null {
    const sel = useSelectionStore()
    const detail = sel.detail
    if (!detail?.components) return null

    const parts = resolveComponentPath(namePath).split('/')
    let components = detail.components as Array<
      string | { name: string; template: string; content?: Record<string, unknown>; components?: unknown[] }
    >

    for (let i = 0; i < parts.length; i++) {
      const comp = components.find(c => typeof c === 'object' && c.name === parts[i])
      if (!comp || typeof comp === 'string') return null
      if (i === parts.length - 1)
        return { template: comp.template, content: (comp.content as Record<string, unknown>) ?? {} }
      components = (comp.components ?? []) as typeof components
    }
    return null
  }

  /**
   * Etag-aware update wrapper. Reads the current If-Match from
   * `useEditorEtagsStore`, sends it on the PUT, updates the store
   * from the response on success, pushes to `useSaveConflictsStore`
   * on 409 STALE per design-offline.md Q3. Used by every save path
   * (root content, component content, fragment edit, structural).
   *
   * # Mid-save connection-loss handling (Cut 13)
   *
   * If the PUT itself fails with a network error (fetch rejects with
   * TypeError — DNS / refused / aborted), we don't know whether the
   * server received the save before the connection dropped. Two
   * possibilities:
   *
   *   (a) Server received + processed the save; the response was
   *       lost in transit. The on-disk manifest matches what we
   *       tried to save.
   *   (b) Server didn't receive the save. The on-disk manifest is
   *       still the pre-save state.
   *
   * We reconcile via a single GET-and-compare:
   *
   *   - GET the current manifest + etag
   *   - If GET also fails: surface the original network error;
   *     editor stays dirty so the author can retry manually
   *   - If server's current === pending: case (a). Advance the
   *     etag store; treat as silent success per design-offline.md
   *     Q4 "handled invisibly"
   *   - Else: case (b) OR case (a) with a concurrent third-party
   *     save in between. Surface as `StaleSaveError` so the normal
   *     conflict flow takes over
   *
   * Re-throws on (resolved) conflict + on the original network
   * error when GET also fails. Silent on case (a).
   */
  async function updateManifest(
    kind: 'page' | 'fragment',
    name: string,
    payload: Record<string, unknown>,
    pendingForConflict: Record<string, unknown>,
    /** Which locale file to write; defaults to the locale active now. `null` = the default locale. */
    forLocale?: string | null,
  ): Promise<void> {
    const locale = forLocale === undefined ? (useLocaleStore().effectiveLocale ?? undefined) : (forLocale ?? undefined)
    const path = manifestPath(kind, name, locale)
    const etags = useEditorEtagsStore()
    const ifMatch = etags.get(path) ?? undefined
    try {
      const updateFn = kind === 'page' ? api.updatePage : api.updateFragment
      const result = await updateFn(name, payload, { locale, ifMatch })
      if (result.etag) etags.set(path, result.etag)
    } catch (err) {
      if (err instanceof StaleSaveError) {
        useSaveConflictsStore().set({
          itemPath: path,
          current: err.current,
          currentEtag: err.currentEtag,
          pending: pendingForConflict,
        })
        // Update etag baseline so the next manual save (after the
        // author rebases) chains correctly.
        etags.set(path, err.currentEtag)
        throw err
      }
      // Network error path — try to reconcile via GET-and-compare.
      // TypeError is fetch's standard network-failure shape; HTTP
      // errors (4xx / 5xx) come back as `Error` from request<T>
      // and don't go through reconcile (a 5xx isn't ambiguous in
      // the same way; the server told us it failed).
      if (err instanceof TypeError) {
        await reconcileMidSaveDrop(kind, name, locale, pendingForConflict, path)
        return
      }
      throw err
    }
  }

  /**
   * Mid-save connection-loss reconcile. See updateManifest header
   * for the rationale. Called when the PUT failed with a network
   * error; we don't yet know whether the save landed.
   */
  async function reconcileMidSaveDrop(
    kind: 'page' | 'fragment',
    name: string,
    locale: string | undefined,
    pendingForConflict: Record<string, unknown>,
    path: string,
  ): Promise<void> {
    const etags = useEditorEtagsStore()
    let current: { template?: unknown; content?: unknown; components?: unknown }
    let currentEtag: string | null
    try {
      const fetchFn = kind === 'page' ? api.getPageWithEtag : api.getFragmentWithEtag
      const result = await fetchFn(name, { locale })
      current = result.data as { template?: unknown; content?: unknown; components?: unknown }
      currentEtag = result.etag
    } catch (getErr) {
      // GET failed too — surface the network error. The author's
      // local edits stay dirty (editor unchanged); they can retry
      // when connection comes back.
      throw getErr
    }

    // Compare server's current to the manifest the author tried to
    // save. Equal = case (a); the save actually landed before the
    // connection dropped.
    if (manifestsEquivalent(current, pendingForConflict)) {
      if (currentEtag) etags.set(path, currentEtag)
      // Silent success per design-offline.md Q4 "handled invisibly."
      return
    }

    // Different = case (b) or a concurrent save by someone else.
    // Surface as a stale-save conflict; the editor's banner +
    // diff view take over from here.
    const fallbackEtag = currentEtag ?? ''
    useSaveConflictsStore().set({
      itemPath: path,
      current: current as Record<string, unknown>,
      currentEtag: fallbackEtag,
      pending: pendingForConflict,
    })
    if (fallbackEtag) etags.set(path, fallbackEtag)
    throw new StaleSaveError(current as Record<string, unknown>, fallbackEtag)
  }

  /**
   * Compare two manifest snapshots for save-equivalence. Compares
   * the union of save-relevant fields (template, content,
   * components, route, metadata) via canonicalized JSON. Same shape
   * as the server's `computeSaveEtag` canonicalization; if the
   * server's etag would equal the etag of `pending`, they're
   * equivalent.
   *
   * We could call computeSaveEtag for both sides and compare hashes;
   * deep-equal via JSON canonicalization is cheaper for small
   * manifests and avoids the async crypto call on the reconcile
   * hot path.
   */
  function manifestsEquivalent(a: Record<string, unknown>, b: Record<string, unknown>): boolean {
    const fields = ['template', 'content', 'components', 'metadata', 'route'] as const
    const pickA: Record<string, unknown> = {}
    const pickB: Record<string, unknown> = {}
    for (const f of fields) {
      if (f in a) pickA[f] = a[f]
      if (f in b) pickB[f] = b[f]
    }
    return JSON.stringify(pickA, sortedKeyReplacer) === JSON.stringify(pickB, sortedKeyReplacer)
  }

  function sortedKeyReplacer(_key: string, value: unknown): unknown {
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      const out: Record<string, unknown> = {}
      for (const k of Object.keys(value as Record<string, unknown>).sort()) {
        out[k] = (value as Record<string, unknown>)[k]
      }
      return out
    }
    return value
  }

  function buildSaveFn(namePath: string): (content: Record<string, unknown>) => Promise<void> {
    return async (newContent: Record<string, unknown>) => {
      const sel = useSelectionStore()
      const detail = sel.detail
      if (!detail || !sel.selection) return

      const updatedComponents = deepClone(detail.components ?? [])
      const parts = resolveComponentPath(namePath).split('/')
      let components = updatedComponents as Array<
        string | { name: string; template: string; content?: Record<string, unknown>; components?: unknown[] }
      >

      for (let i = 0; i < parts.length; i++) {
        const idx = components.findIndex(c => typeof c === 'object' && c.name === parts[i])
        if (idx === -1) return
        const comp = components[idx] as {
          name: string
          template: string
          content?: Record<string, unknown>
          components?: unknown[]
        }
        if (i === parts.length - 1) {
          comp.content = newContent
        } else {
          components = (comp.components ?? []) as typeof components
        }
      }

      const kind = sel.selection.type === 'page' ? 'page' : 'fragment'
      // pendingForConflict is the manifest as the author tried to
      // save it — used by the conflict diff view to show "yours."
      const pending: Record<string, unknown> = {
        template: detail.template,
        content: detail.content,
        components: updatedComponents,
      }
      if (kind === 'page') {
        const pageDetail = detail as { metadata?: Record<string, unknown>; route?: string }
        if (pageDetail.metadata) pending.metadata = pageDetail.metadata
        if (pageDetail.route) pending.route = pageDetail.route
      }
      await updateManifest(kind, sel.selection.name, { components: updatedComponents }, pending)
    }
  }

  // --- Build an EditingTarget from a selection ---

  /**
   * Null when the item has no template — a redirect (archived with an
   * alias) or a pure archive has nothing to edit; the archive banner is
   * the whole UI for it.
   */
  async function buildTarget(sel: EditorSelection, signal: AbortSignal): Promise<EditingTarget | null> {
    const selStore = useSelectionStore()
    switch (sel.kind) {
      case 'root': {
        const d = selStore.detail
        const selection = selStore.selection
        if (!d || !selection) throw new Error('No page/fragment selected')
        const template = d.template
        if (!template) return null
        const pageContent = (d.content as Record<string, unknown>) ?? {}
        const { schema, hasEditor, editorUrl, fieldsBaseUrl } = await fetchSchema(template, signal)
        const kind = selection.type === 'page' ? ('page' as const) : ('fragment' as const)
        const saveFn = (c: Record<string, unknown>) => {
          // pending = the manifest the author tried to save — used
          // by the conflict diff view to show "yours."
          const pending: Record<string, unknown> = {
            template,
            content: c,
            components: d.components,
          }
          if (kind === 'page') {
            const pageDetail = d as { metadata?: Record<string, unknown>; route?: string }
            if (pageDetail.metadata) pending.metadata = pageDetail.metadata
            if (pageDetail.route) pending.route = pageDetail.route
          }
          return updateManifest(kind, selection.name, { content: c }, pending)
        }
        return {
          template,
          path: '_root',
          content: pageContent,
          schema,
          hasEditor,
          editorUrl,
          fieldsBaseUrl,
          save: saveFn,
        }
      }
      case 'component': {
        const comp = findComponentByNamePath(sel.path)
        if (!comp) throw new Error(`Component "${sel.path}" not found in page manifest`)
        // Use template from the manifest — sel.template may be empty when restoring from URL hash
        const templateName = sel.template || comp.template
        const { schema, hasEditor, editorUrl, fieldsBaseUrl } = await fetchSchema(templateName, signal)
        return {
          template: templateName,
          path: sel.path,
          content: comp.content,
          schema,
          hasEditor,
          editorUrl,
          fieldsBaseUrl,
          save: buildSaveFn(sel.path),
        }
      }
      case 'fragmentEdit': {
        const locale = useLocaleStore().effectiveLocale ?? undefined
        // getFragmentWithEtag captures the save-concurrency etag for
        // the offline save flow per design-offline.md Q3. The
        // selection store does the same on selectFragment; this path
        // (direct fragment-edit URL) is the other entry point.
        const { data: frag, etag } = await api.getFragmentWithEtag(sel.fragmentName, { signal, locale })
        if (etag) useEditorEtagsStore().set(manifestPath('fragment', sel.fragmentName, locale), etag)
        if (!frag.template) return null
        const fragContent = (frag.content as Record<string, unknown>) ?? {}
        const { schema, hasEditor, editorUrl, fieldsBaseUrl } = await fetchSchema(frag.template, signal)
        return {
          template: frag.template,
          path: `@${sel.fragmentName}`,
          content: fragContent,
          schema,
          hasEditor,
          editorUrl,
          fieldsBaseUrl,
          save: c => {
            const pending: Record<string, unknown> = {
              template: frag.template,
              content: c,
              components: frag.components,
            }
            return updateManifest('fragment', sel.fragmentName, { content: c }, pending)
          },
        }
      }
      case 'fragmentLink':
        throw new Error('fragmentLink does not produce an EditingTarget')
    }
  }

  // --- The single navigation entry point ---

  /**
   * Navigate to a component selection. Cancels any pending navigation,
   * stashes dirty edits, and opens the target.
   *
   * This is the only function that starts async editor loads. All
   * component tree clicks, hash restorations, and post-restore re-opens
   * go through here.
   */
  async function navigate(sel: EditorSelection) {
    cancelPending()
    stashCurrent()

    // Fragment links are synchronous — no fetch, no abort needed
    if (sel.kind === 'fragmentLink') {
      ec.showFragmentLink(sel.treePath)
      void draftsLoaded().then(activateDrafts)
      return
    }

    // Check in-memory stash before fetching. The in-memory stash is
    // intra-selection (keyed by target.path which collides across
    // pages); it picks up where the author left off within the
    // current page/fragment.
    const stashKey = selectionToStashKey(sel)
    if (stashKey) {
      const stashed = stash.restore(stashKey)
      if (stashed) {
        persistence.lastSaveError = null
        await ec.open(stashed.target, stashed.editedContent)
        usePreviewStore().invalidateDraft()
        return
      }
    }

    // Async fetch — cancellable via AbortController
    navController = new AbortController()
    const { signal } = navController
    try {
      const target = await buildTarget(sel, signal)
      if (!target) {
        // Nothing to edit (redirect / archived without a template).
        persistence.lastSaveError = null
        ec.clear()
        return
      }
      persistence.lastSaveError = null
      // Cut 8b: fall through to the cross-page persisted-edits store
      // for dirty content that survived a reload. Keys are richer
      // (kind, name, locale, path) so two pages with the same
      // component path don't collide. We check AFTER buildTarget
      // because the persisted entry has data only — the save closure
      // gets rebuilt by buildTarget; ec.open then overlays the
      // persisted dirty content onto the freshly-built target.
      const sl = useSelectionStore()
      const kind = sl.selection?.type === 'page' ? 'page' : sl.selection?.type === 'fragment' ? 'fragment' : null
      const name = sl.selection?.name ?? null
      const localeForKey = useLocaleStore().effectiveLocale ?? undefined
      const persistedKey = persistedEditKeyForSelection(sel, kind, name, localeForKey)
      // Drafts for this target may still be loading from the draft store.
      await draftsLoaded()
      if (signal.aborted) return
      activateDrafts()
      const persisted = persistedKey ? usePersistedEditsStore().get(persistedKey) : null
      if (persisted) {
        await ec.open(target, persisted.editedContent)
        // Promote: the entry is now live in the editor; remove from
        // the persisted store so a subsequent navigate-away → stash
        // → restore flow doesn't re-apply the same content twice.
        usePersistedEditsStore().clear(persistedKey!)
      } else {
        await ec.open(target)
      }
      usePreviewStore().invalidateDraft()
      retryAttempt = 0
    } catch (err) {
      if ((err as Error).name === 'AbortError') return
      ec.setLoadError(`Failed to load "${selectionToErrorLabel(sel)}": ${(err as Error).message}`)
      retryAttempt++
      if (retryAttempt < MAX_RETRY_ATTEMPTS) {
        const delay = BASE_RETRY_DELAY * 2 ** (retryAttempt - 1)
        retryTimer = setTimeout(() => {
          retryTimer = null
          navigate(sel)
        }, delay)
      }
    }
  }

  // --- Convenience wrappers (for backward compatibility) ---

  async function openComponent(namePath: string, templateName: string) {
    await navigate({ kind: 'component', path: namePath, template: templateName })
  }

  async function openPageRoot() {
    await navigate({ kind: 'root' })
  }

  async function openFragment(fragName: string) {
    await navigate({ kind: 'fragmentEdit', fragmentName: fragName })
  }

  function showFragmentLink(nameOrPath: string) {
    const fragmentName = nameOrPath.startsWith('@') ? nameOrPath.split('/')[0].slice(1) : nameOrPath
    const childPath = nameOrPath.includes('/') ? nameOrPath.split('/').slice(1).join('/') : null
    const treePath = nameOrPath.startsWith('@') ? nameOrPath : `@${nameOrPath}`
    navigate({ kind: 'fragmentLink', fragmentName, treePath, childPath })
  }

  // --- Content operations (with preview side effects) ---

  function markDirty(newContent: Record<string, unknown>) {
    ec.markDirty(newContent)
    usePreviewStore().invalidateDraft()
    // Mirror into the cross-page persisted store (Cut 8b) so the
    // live edit survives reload. The persistence coordinator
    // debounces writes to IndexedDB; we just keep the store
    // up-to-date on every keystroke.
    const key = persistedKeyForCurrent()
    if (key) usePersistedEditsStore().set(key, deepClone(newContent))
  }

  function revertStashed(componentPath: string) {
    stash.revert(componentPath)
    // Cut 8b: drop the cross-page persisted mirror for this stash
    // entry too — author explicitly chose to discard, not keep.
    const k = persistedKeyForStashEntry(componentPath)
    if (k) usePersistedEditsStore().clear(k)
    usePreviewStore().invalidateDraft()
  }

  /**
   * A row's revert button: undo what that row's dot marks, whether the row
   * is open or stashed. The page row also reverts the page's metadata, whose
   * form is part of the page row's editor. Pending moves and other rows'
   * edits stay.
   */
  function revertComponent(path: string) {
    if (ec.path === path) {
      ec.discard()
      const k = persistedKeyForCurrent()
      if (k) usePersistedEditsStore().clear(k)
    } else {
      revertStashed(path)
    }
    if (path === '_root') {
      const key = currentMetadataKey()
      if (key) metadata.discard(key)
    }
    usePreviewStore().invalidateDraft()
  }

  // --- Page metadata ---

  /** Restored structural and metadata drafts become pending once their page is open in that locale. */
  function activateDrafts() {
    const manifestKey = currentManifestKey()
    if (manifestKey) structural.activate(inCurrentLocale(manifestKey))
    const key = currentMetadataKey()
    if (key) metadata.activate(key)
  }

  /** The selected page's metadata as loaded, in the locale it was loaded for. */
  function loadedMetadata(): PageMetadata | null {
    const sel = useSelectionStore().selection
    return sel?.type === 'page' ? (sel.detail.metadata ?? null) : null
  }

  /** The selected page's metadata as the form shows it: pending if any, otherwise as loaded. */
  const metadataValue = computed<MetadataValue>(() => {
    const key = currentMetadataKey()
    return (key && metadata.pendingFor(key)) || loadedMetadata() || {}
  })

  function editMetadata(field: MetadataTextField, value: string) {
    const key = currentMetadataKey()
    if (key) metadata.setField(key, loadedMetadata(), field, value)
  }

  function setMetadataNoindex(on: boolean) {
    const key = currentMetadataKey()
    if (key) metadata.setNoindex(key, loadedMetadata(), on)
  }

  // --- Structural operations (with preview side effects) ---

  function moveComponentStructural(
    key: ManifestKey,
    current: readonly import('gazetta/types').ComponentEntry[],
    fromIndex: number,
    toIndex: number,
  ) {
    structural.moveComponent(inCurrentLocale(key), current, fromIndex, toIndex)
    usePreviewStore().invalidateDraft()
  }

  function addComponentStructural(
    key: ManifestKey,
    current: readonly import('gazetta/types').ComponentEntry[],
    component: import('gazetta/types').InlineComponent | string,
    insertIndex?: number,
  ) {
    structural.addComponent(inCurrentLocale(key), current, component, insertIndex)
    usePreviewStore().invalidateDraft()
  }

  function removeComponentStructural(
    key: ManifestKey,
    current: readonly import('gazetta/types').ComponentEntry[],
    atIndex: number,
  ) {
    structural.removeComponent(inCurrentLocale(key), current, atIndex)
    usePreviewStore().invalidateDraft()
  }

  /**
   * Drop the open editor + any stash entry for `path`. Used when removing a
   * component — the path is about to disappear from the manifest, so any
   * pending content under it would be orphaned by save. Other stash entries
   * and the structural pending state are not touched.
   */
  function clearEditorForRemovedPath(path: string) {
    if (ec.path === path) ec.clear()
    if (stash.has(path)) stash.revert(path)
    // Cut 8b: also drop the cross-page persisted mirror for this
    // path. The component is being removed from the manifest;
    // re-applying its persisted dirty content after a reload would
    // resurrect content that no longer has a home.
    const k = persistedKeyForStashEntry(path)
    if (k) usePersistedEditsStore().clear(k)
  }

  /**
   * Derive the manifest key for the currently-selected page or fragment.
   * Returns null when nothing is selected.
   */
  function currentManifestKey(): ManifestKey | null {
    const sel = useSelectionStore().selection
    if (!sel) return null
    return { kind: sel.type, name: sel.name }
  }

  /** The selected page's metadata key, in the locale its detail was loaded for. Null for fragments. */
  function currentMetadataKey(): MetadataKey | null {
    const sel = useSelectionStore().selection
    if (!sel || sel.type !== 'page') return null
    return sel.locale ? { kind: 'page', name: sel.name, locale: sel.locale } : { kind: 'page', name: sel.name }
  }

  /** The structural key for a manifest in the locale being edited now. */
  function inCurrentLocale(key: ManifestKey): ManifestFileKey {
    const locale = useLocaleStore().effectiveLocale ?? undefined
    return locale ? { ...key, locale } : { ...key }
  }

  /** Drop the stash and its persisted mirror. The stash only holds the selected page's edits. */
  function dropStash() {
    const persistedStore = usePersistedEditsStore()
    for (const [path] of stash.entries) {
      const k = persistedKeyForStashEntry(path)
      if (k) persistedStore.clear(k)
    }
    stash.clearAll()
  }

  /**
   * Page-level discard, for the conflict banner's "Discard my changes": the
   * open editor, stashed component edits, the page's structural edits and its
   * metadata.
   */
  function discard() {
    ec.discard()
    dropStash()
    const key = currentManifestKey()
    if (key) structural.discard(inCurrentLocale(key))
    const metadataKey = currentMetadataKey()
    if (metadataKey) metadata.discard(metadataKey)
    // Cut 8b: drop the cross-page persisted mirror for the current
    // edit. The author explicitly reverted; re-applying the dirty
    // content on reload would undo their intent.
    const persistedKey = persistedKeyForCurrent()
    if (persistedKey) usePersistedEditsStore().clear(persistedKey)
    usePreviewStore().invalidateDraft()
  }

  // --- Clear ---

  function clear() {
    cancelPending()
    // Drop the persisted mirror of exactly what is being discarded — the
    // open editor and this selection's stash. Not clearAll(): drafts of
    // pages not opened this session aren't pending edits, so the
    // unsaved-changes guard never asked about them.
    const currentKey = persistedKeyForCurrent()
    if (currentKey) usePersistedEditsStore().clear(currentKey)
    dropStash()
    ec.clear()
    persistence.saving = false
    persistence.lastSaveError = null
    structural.clearActive()
    metadata.clearActive()
  }

  // --- Save ---

  function buildUndoAction(): { label: string; handler: () => Promise<void> } | undefined {
    const active = useActiveTargetStore().activeTargetName
    if (!active) return undefined
    return {
      label: 'Undo',
      handler: async () => {
        try {
          await api.undoLastWrite(active)
          await refreshAfterRestore()
          toast.show('Undone')
        } catch (err) {
          toast.showError(err, 'Undo failed')
        }
      },
    }
  }

  /**
   * Build a ManifestWrite closure for one pending structural entry. The
   * closure POSTs the new components array via api.updatePage /
   * api.updateFragment when called by the persistence orchestrator.
   */
  function buildStructuralWrite(keyString: string, components: unknown[]): ManifestWrite {
    // Write to the locale the edit was made in, not whichever is active now.
    const key = manifestFileKeyFromString(keyString)
    return {
      label: keyString,
      write: async () => {
        // pending shape carries the structural change; if a conflict
        // surfaces, the diff view shows the components count change.
        const pending: Record<string, unknown> = { components }
        await updateManifest(key.kind, key.name, { components: components as never }, pending, key.locale ?? null)
      },
    }
  }

  /** One page's pending metadata, written to the locale it was edited in. */
  function buildMetadataWrite(keyString: string, pending: MetadataValue): ManifestWrite {
    const key = manifestFileKeyFromString(keyString)
    const value = toRaw(pending)
    return {
      label: keyString,
      write: () =>
        updateManifest('page', key.name, { metadata: value }, metadataConflictPending(key, value), key.locale ?? null),
    }
  }

  /**
   * The page as the author would have it after a metadata write: the
   * conflict view's "yours". The view lists every key of both sides, so
   * metadata alone would show the rest of the page as removed. Built from
   * the open page when the entry is its own; metadata only otherwise.
   */
  function metadataConflictPending(key: ManifestFileKey, value: MetadataValue): Record<string, unknown> {
    const sel = useSelectionStore().selection
    if (!sel || sel.type !== 'page' || sel.name !== key.name || sel.locale !== key.locale) return { metadata: value }
    const d = sel.detail
    return { template: d.template, content: d.content, components: d.components, route: d.route, metadata: value }
  }

  /**
   * After a save wrote `written` (component path → content JSON): the open
   * editor takes what was written as its baseline, stash entries still equal
   * to it go away, and a path's stored draft is cleared unless an edit made
   * since is pending there.
   */
  function markContentWritten(written: Map<string, string>) {
    const openWritten = ec.target ? written.get(ec.target.path) : undefined
    if (openWritten !== undefined) ec.markSaved(JSON.parse(openWritten))
    for (const [path, entry] of [...stash.entries]) {
      if (written.get(path) === JSON.stringify(entry.editedContent)) stash.revert(path)
    }
    const persistedStore = usePersistedEditsStore()
    for (const path of written.keys()) {
      if ((ec.target?.path === path && ec.dirty) || stash.has(path)) continue
      const k = persistedKeyForStashEntry(path)
      if (k) persistedStore.clear(k)
    }
  }

  /**
   * Save every pending edit. Resolves true when everything was written,
   * false when the save failed (the error is already shown as a toast or
   * the validation banner). Never throws. Callers that navigate after a
   * save must stop on false, or the unsaved edits are lost.
   */
  async function save(): Promise<boolean> {
    const current = ec.target && ec.content && ec.dirty ? { target: ec.target, content: ec.content } : null
    const stashedEntries = [...stash.values()]
    // What each content write sends, by component path. Edits made while the
    // save runs differ from it, so they stay pending afterwards.
    const writtenContent = new Map<string, string>()
    if (current) writtenContent.set(current.target.path, JSON.stringify(current.content))
    for (const [path, entry] of stash.entries) writtenContent.set(path, JSON.stringify(entry.editedContent))
    const structuralEntries = structural.allEntries()
    const metadataEntries = metadata.allEntries()
    const manifestWrites = [
      ...structuralEntries.map(([k, entry]) => buildStructuralWrite(k, entry.pending)),
      ...metadataEntries.map(([k, entry]) => buildMetadataWrite(k, entry.pending)),
    ]
    const validationStore = useValidationIssuesStore()
    const result = await persistence.save(current, stashedEntries, manifestWrites)
    if (result.success) {
      markContentWritten(writtenContent)
      structural.markWritten(structuralEntries)
      metadata.markWritten(metadataEntries)
      validationStore.clear()
      // Reload the affected manifests so selection.detail reflects the saved
      // structural and metadata changes — preview will repaint from disk on
      // the next fetch.
      if (structuralEntries.length > 0 || metadataEntries.length > 0) {
        await useSelectionStore().reload()
      }
      usePreviewStore().invalidate()
      usePublishStatusStore().refresh()
      toast.show('Saved', { action: buildUndoAction() })
      return true
    }
    if (result.validationError) {
      // 409 VALIDATION_FAILED — banner surface, not a toast. Issues are
      // pinned until the next successful save or explicit dismiss.
      validationStore.set(result.validationError.issues)
    } else {
      toast.showError(new Error(result.error), 'Failed to save')
    }
    return false
  }

  // --- Post-restore refresh ---

  async function refreshAfterRestore(): Promise<void> {
    const targetSnapshot = ec.target ? { template: ec.target.template, path: ec.target.path } : null
    clear()
    await useSiteStore().reload()
    await useSelectionStore().reload()
    if (targetSnapshot) {
      const sel: EditorSelection =
        targetSnapshot.path === '_root'
          ? { kind: 'root' }
          : { kind: 'component', path: targetSnapshot.path, template: targetSnapshot.template }
      await navigate(sel)
    }
    usePreviewStore().invalidate()
    usePublishStatusStore().refresh()
  }

  // --- Derived state ---

  const pendingCount = computed(() => stash.size + (ec.dirty ? 1 : 0) + structural.pendingCount + metadata.pendingCount)
  const hasPendingEdits = computed(() => pendingCount.value > 0)
  /** The selected page has unsaved metadata: part of the page row's dot. */
  const hasPendingMetadata = computed(() => {
    const key = currentMetadataKey()
    return !!key && metadata.hasPendingFor(key)
  })
  /**
   * Aggregated draft overrides for the preview server. Both lanes always
   * present; consumers send the whole shape over the wire (server contract is
   * `{ content, structural }` with both fields required).
   */
  const allOverrides = computed<DraftOverrides>(() => {
    const content: DraftOverrides['content'] = {}
    for (const entry of stash.entries) content[entry[0]] = entry[1].editedContent
    if (ec.path && ec.content && ec.dirty) content[ec.path] = ec.content

    const structuralOverrides: DraftOverrides['structural'] = {}
    // The preview renders the current locale and keys overrides by manifest.
    const locale = useLocaleStore().effectiveLocale ?? undefined
    for (const [k, entry] of structural.allEntries()) {
      const key = manifestFileKeyFromString(k)
      if (key.locale !== locale) continue
      structuralOverrides[manifestKeyToString(key)] = entry.pending
    }
    return { content, structural: structuralOverrides }
  })

  // --- Beforeunload guard ---

  if (typeof window !== 'undefined') {
    window.addEventListener('beforeunload', (e: BeforeUnloadEvent) => {
      if (hasPendingEdits.value) {
        e.preventDefault()
        e.returnValue = ''
      }
    })
  }

  return {
    // Primary entry point
    navigate,
    // Convenience wrappers (backward compat — callers can migrate to navigate() over time)
    openComponent,
    openPageRoot,
    openFragment,
    showFragmentLink,
    // Other actions
    markDirty,
    revertStashed,
    revertComponent,
    editMetadata,
    setMetadataNoindex,
    moveComponentStructural,
    addComponentStructural,
    removeComponentStructural,
    clearEditorForRemovedPath,
    discard,
    clear,
    save,
    refreshAfterRestore,
    // Derived state
    pendingCount,
    hasPendingEdits,
    hasPendingMetadata,
    metadataValue,
    hasPendingEdit: (path: string) => stash.has(path),
    allOverrides,
  }
}
