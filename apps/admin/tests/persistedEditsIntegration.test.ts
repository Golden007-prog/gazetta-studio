/**
 * End-to-end integration tests for Cut 8b — verifies the navigate
 * flow consults `usePersistedEditsStore` when the in-memory stash
 * misses, rebuilds the target via buildTarget, and overlays the
 * persisted dirty content via `ec.open(target, dirtyContent)`.
 *
 * Production paths exercised:
 *   - markDirty() mirrors to persisted store
 *   - stashCurrent() mirrors stash entries to persisted store
 *   - navigate() falls through to persisted store on stash miss
 *   - save() clears persisted entries on success
 *   - discard() / revertStashed() clean up persisted entries
 *
 * Selection state pre-seeded; api stubs return synthetic schemas
 * so buildTarget runs without a live server.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { setActivePinia, createPinia } from 'pinia'
import { api } from '../src/client/api/client.js'
import { useEditorActions } from '../src/client/composables/useEditorActions.js'
import { useEditorContentStore } from '../src/client/stores/editorContent.js'
import { useEditorStashStore } from '../src/client/stores/editorStash.js'
import { useSelectionStore } from '../src/client/stores/selection.js'
import { persistedEditKey, usePersistedEditsStore } from '../src/client/stores/persistedEdits.js'

afterEach(() => vi.restoreAllMocks())

beforeEach(() => setActivePinia(createPinia()))

function seedRootSelection(name = 'home') {
  const sel = useSelectionStore()
  sel.$patch({
    selection: {
      type: 'page',
      name,
      detail: {
        name,
        route: name === 'home' ? '/' : `/${name}`,
        template: 'page-default',
        content: {},
        components: [],
        dir: `pages/${name}`,
      },
    },
  })
}

function stubSchemaFetch() {
  vi.spyOn(api, 'getTemplateSchema').mockResolvedValue({
    properties: { title: { type: 'string' } },
  })
}

describe('Cut 8b — markDirty mirrors to persistedEdits', () => {
  it('persists current dirty content under the (kind, name, locale, path) key', async () => {
    stubSchemaFetch()
    seedRootSelection('home')
    const actions = useEditorActions()
    await actions.openPageRoot()

    actions.markDirty({ title: 'Live edit' })

    const persistedKey = persistedEditKey('page', 'home', undefined, '_root')
    const entry = usePersistedEditsStore().get(persistedKey)
    expect(entry).not.toBeNull()
    expect(entry!.editedContent).toEqual({ title: 'Live edit' })
  })

  it('uses cross-page-correct keys (does NOT collide between pages)', async () => {
    stubSchemaFetch()

    // Edit home/_root
    seedRootSelection('home')
    let actions = useEditorActions()
    await actions.openPageRoot()
    actions.markDirty({ title: 'Home edit' })

    // Edit about/_root via a fresh selection
    setActivePinia(createPinia())
    stubSchemaFetch()
    seedRootSelection('about')
    actions = useEditorActions()
    await actions.openPageRoot()
    actions.markDirty({ title: 'About edit' })

    // Both keys exist independently in the (about) store
    const aboutStore = usePersistedEditsStore()
    expect(aboutStore.get(persistedEditKey('page', 'about', undefined, '_root'))!.editedContent).toEqual({
      title: 'About edit',
    })
    // home key is from the previous Pinia (different keyspace);
    // verify the about key is the only one in this store.
    expect(aboutStore.count).toBe(1)
  })
})

describe('Cut 8b — stashCurrent mirrors stash entries', () => {
  it('persists a stash entry to the cross-page store', async () => {
    stubSchemaFetch()
    seedRootSelection('home')
    const actions = useEditorActions()

    // Open _root, dirty it, then navigate to a different selection
    // (here: a synthetic component selection on the same page).
    // stashCurrent fires on the next navigate() and mirrors the
    // dirty edit into both stash AND persistedEdits.
    await actions.openPageRoot()
    const ec = useEditorContentStore()
    actions.markDirty({ title: 'Stashing this' })
    expect(ec.dirty).toBe(true)

    // Trigger stashCurrent via a fresh navigate (stash happens
    // before the navigation's own buildTarget). Use an
    // intentionally-failing navigate so we don't need a real
    // component schema.
    await actions.navigate({ kind: 'fragmentLink', treePath: '@nope', fragmentName: 'nope' }).catch(() => {})

    const persistedKey = persistedEditKey('page', 'home', undefined, '_root')
    const entry = usePersistedEditsStore().get(persistedKey)
    expect(entry).not.toBeNull()
    expect(entry!.editedContent).toEqual({ title: 'Stashing this' })
  })
})

describe('Cut 8b — navigate restores persisted dirty content', () => {
  it('opens the target with persisted content when stash misses', async () => {
    stubSchemaFetch()
    seedRootSelection('home')

    // Pre-populate the persisted store as if a previous tab session
    // had stashed dirty content; simulates what hydration produces.
    const persistedStore = usePersistedEditsStore()
    const key = persistedEditKey('page', 'home', undefined, '_root')
    persistedStore.set(key, { title: 'Survived reload' })

    const actions = useEditorActions()
    await actions.openPageRoot()

    // Editor opens with the persisted content overlaid onto the
    // freshly-built target.
    const ec = useEditorContentStore()
    expect(ec.content).toEqual({ title: 'Survived reload' })
    // dirty=true because content !== savedJson
    expect(ec.dirty).toBe(true)

    // The persisted entry is consumed (promoted to live edit).
    // Verify it's been cleared from the store. Note that markDirty
    // mirrors back into the store on the next ec.markDirty call,
    // not on the open() — open() doesn't fire markDirty.
    expect(persistedStore.has(key)).toBe(false)
  })

  it('does NOT overlay persisted content from a different page', async () => {
    stubSchemaFetch()
    // Persisted entry for /about — but we're navigating to /home.
    const persistedStore = usePersistedEditsStore()
    persistedStore.set(persistedEditKey('page', 'about', undefined, '_root'), { title: 'About edit' })

    seedRootSelection('home')
    const actions = useEditorActions()
    await actions.openPageRoot()

    // Editor opens with the home target's clean content, NOT the
    // about persisted content.
    const ec = useEditorContentStore()
    expect(ec.content).toEqual({})
    expect(ec.dirty).toBe(false)

    // about's persisted entry untouched.
    expect(persistedStore.has(persistedEditKey('page', 'about', undefined, '_root'))).toBe(true)
  })
})

describe('Cut 8b — save success clears persisted entries', () => {
  it('clears the current edit and stashed-key entries on successful save', async () => {
    stubSchemaFetch()
    vi.spyOn(api, 'updatePage').mockResolvedValue({ ok: true, etag: 'fresh' })
    seedRootSelection('home')

    const actions = useEditorActions()
    await actions.openPageRoot()
    actions.markDirty({ title: 'Save me' })

    const persistedStore = usePersistedEditsStore()
    const key = persistedEditKey('page', 'home', undefined, '_root')
    expect(persistedStore.has(key)).toBe(true)

    await actions.save()

    // Persisted entry cleared after successful save — the content
    // is now on the server; re-applying after reload would resurrect
    // the dirty state.
    expect(persistedStore.has(key)).toBe(false)
  })
})

describe('Cut 8b — discard / revertStashed clean up persisted entries', () => {
  it('discard() clears the persisted entry for the current edit', async () => {
    stubSchemaFetch()
    seedRootSelection('home')
    const actions = useEditorActions()
    await actions.openPageRoot()
    actions.markDirty({ title: 'Going to discard' })

    const persistedStore = usePersistedEditsStore()
    const key = persistedEditKey('page', 'home', undefined, '_root')
    expect(persistedStore.has(key)).toBe(true)

    actions.discard()

    expect(persistedStore.has(key)).toBe(false)
  })

  it('revertStashed() clears the persisted entry for the reverted stash key', async () => {
    stubSchemaFetch()
    seedRootSelection('home')
    const actions = useEditorActions()

    // Pre-populate stash + persisted with a synthetic component
    // path (the contract is path-based; the in-memory stash itself
    // doesn't enforce that the path is currently selectable).
    const stash = useEditorStashStore()
    stash.stash(
      'hero',
      {
        template: 'hero',
        path: 'hero',
        content: { title: 'Stashed' },
        schema: {},
        save: async () => {},
      },
      { title: 'Stashed' },
    )
    const persistedStore = usePersistedEditsStore()
    const key = persistedEditKey('page', 'home', undefined, 'hero')
    persistedStore.set(key, { title: 'Stashed' })

    actions.revertStashed('hero')

    expect(persistedStore.has(key)).toBe(false)
  })
})

// clear() is what "Don't Save" runs (target switch, fragment navigation,
// leaving edit mode, deleting the open page). It must drop the persisted
// mirror of what it discards, or the discarded edit comes back on reload.
describe('clear() cleans up persisted entries for what it discards', () => {
  it('clears the persisted entry for the current edit', async () => {
    stubSchemaFetch()
    seedRootSelection('home')
    const actions = useEditorActions()
    await actions.openPageRoot()
    actions.markDirty({ title: 'Discarded by clear' })

    const persistedStore = usePersistedEditsStore()
    const key = persistedEditKey('page', 'home', undefined, '_root')
    expect(persistedStore.has(key)).toBe(true)

    actions.clear()

    expect(persistedStore.has(key)).toBe(false)
  })

  it('clears the persisted entries for stashed edits', async () => {
    stubSchemaFetch()
    seedRootSelection('home')
    const actions = useEditorActions()
    useEditorStashStore().stash(
      'hero',
      { template: 'hero', path: 'hero', content: { title: 'Stashed' }, schema: {}, save: async () => {} },
      { title: 'Stashed' },
    )
    const persistedStore = usePersistedEditsStore()
    const key = persistedEditKey('page', 'home', undefined, 'hero')
    persistedStore.set(key, { title: 'Stashed' })

    actions.clear()

    expect(persistedStore.has(key)).toBe(false)
  })

  it('keeps persisted drafts of other pages that were never opened this session', async () => {
    // Drafts restored at boot are not counted as pending edits until
    // their page is opened, so the unsaved-changes guard never asked
    // about them. clear() must not delete them.
    stubSchemaFetch()
    seedRootSelection('home')
    const persistedStore = usePersistedEditsStore()
    const other = persistedEditKey('page', 'about', undefined, '_root')
    persistedStore.set(other, { title: 'Unopened draft' })
    const actions = useEditorActions()
    await actions.openPageRoot()
    actions.markDirty({ title: 'Discarded by clear' })

    actions.clear()

    expect(persistedStore.has(other)).toBe(true)
  })
})
