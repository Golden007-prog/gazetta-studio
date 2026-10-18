/**
 * The coordinator between the two pending-edit stores and the draft
 * store. What it must guarantee: drafts load only for the current
 * site/user/target, a change writes only its own record, a target switch
 * doesn't carry drafts across, and two tabs don't delete each other's
 * drafts (reproduced 2026-10-18 with the old snapshot persistence).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { nextTick, ref } from 'vue'
import { createPinia, setActivePinia } from 'pinia'
import { attachDraftPersistence, type DraftPersistenceHandle, draftsLoaded } from '../src/client/drafts/persistence.js'
import { createMemoryDraftStore } from '../src/client/drafts/memory-draft-store.js'
import type { DraftScope, DraftStore } from '../src/client/drafts/types.js'
import { structuralKeyToString, useEditorStructuralStore } from '../src/client/stores/editorStructural.js'
import { usePersistedEditsStore } from '../src/client/stores/persistedEdits.js'

const local: DraftScope = { site: 'main', owner: 'none:unknown:admin', target: 'local' }
const staging: DraftScope = { ...local, target: 'staging' }
const home = { kind: 'page' as const, name: 'home' }
const HOME = structuralKeyToString(home)
const edit = (title: string) => ({ key: 'x', editedContent: { title }, updatedAt: 't' })

let handles: DraftPersistenceHandle[] = []
const attach = (store: DraftStore, scope: () => DraftScope | null) => {
  const h = attachDraftPersistence(store, scope, { debounceMs: 0 })
  handles.push(h)
  return h
}

beforeEach(() => setActivePinia(createPinia()))
afterEach(() => {
  for (const h of handles) h.dispose()
  handles = []
})

describe('draft persistence', () => {
  it("loads the scope's drafts into both stores, keeping the discard baseline", async () => {
    const drafts = createMemoryDraftStore()
    await drafts.put(local, 'edit', 'page:home::hero', edit('Draft'))
    await drafts.put(local, 'structural', HOME, { original: ['a', 'b'], pending: ['b', 'a'] })

    await attach(drafts, () => local).loaded()

    expect(usePersistedEditsStore().get('page:home::hero')?.editedContent).toEqual({ title: 'Draft' })
    const entry = useEditorStructuralStore().allEntries()[0]
    expect(entry[0]).toBe(HOME)
    expect(entry[1].original).toEqual(['a', 'b'])
    expect(entry[1].pending).toEqual(['b', 'a'])
  })

  it('writes a changed entry and deletes a removed one, nothing else', async () => {
    const drafts = createMemoryDraftStore()
    await drafts.put(local, 'edit', 'page:about::_root', edit('Untouched'))
    const h = attach(drafts, () => local)
    await h.loaded()
    const put = vi.spyOn(drafts, 'put')

    usePersistedEditsStore().set('page:home::hero', { title: 'New' })
    useEditorStructuralStore().moveComponent(home, ['a', 'b'], 0, 1)
    await h.flush()

    expect(put.mock.calls.map(c => [c[1], c[2]])).toEqual([
      ['structural', HOME],
      ['edit', 'page:home::hero'],
    ])
    expect((await drafts.list(local, 'edit')).map(([k]) => k).sort()).toEqual(['page:about::_root', 'page:home::hero'])

    usePersistedEditsStore().clear('page:home::hero')
    await h.flush()
    expect((await drafts.list(local, 'edit')).map(([k]) => k)).toEqual(['page:about::_root'])
  })

  it('loading does not write anything back', async () => {
    const drafts = createMemoryDraftStore()
    await drafts.put(local, 'edit', 'page:home::hero', edit('Draft'))
    const put = vi.spyOn(drafts, 'put')
    const del = vi.spyOn(drafts, 'delete')
    const h = attach(drafts, () => local)
    await h.loaded()
    await nextTick()
    await h.flush()
    expect(put).not.toHaveBeenCalled()
    expect(del).not.toHaveBeenCalled()
  })

  it('with no scope, loads nothing and writes nothing', async () => {
    const drafts = createMemoryDraftStore()
    await drafts.put(local, 'edit', 'page:home::hero', edit('Draft'))
    const put = vi.spyOn(drafts, 'put')
    const h = attach(drafts, () => null)
    await h.loaded()
    expect(usePersistedEditsStore().count).toBe(0)
    usePersistedEditsStore().set('page:home::hero', { title: 'typed' })
    await h.flush()
    expect(put).not.toHaveBeenCalled()
  })

  it("a target switch saves pending writes to the old target and loads the new target's drafts", async () => {
    const drafts = createMemoryDraftStore()
    await drafts.put(staging, 'edit', 'page:home::_root', edit('Staging draft'))
    const scope = ref<DraftScope>(local)
    const h = attach(drafts, () => scope.value)
    await h.loaded()

    usePersistedEditsStore().set('page:about::_root', { title: 'Local draft' })
    scope.value = staging
    await nextTick()
    await h.loaded()

    expect([...usePersistedEditsStore().entries.keys()]).toEqual(['page:home::_root'])
    expect((await drafts.list(local, 'edit')).map(([k]) => k)).toEqual(['page:about::_root'])
    // Replacing the store's contents on the switch is a load, not a deletion.
    expect((await drafts.list(staging, 'edit')).map(([k]) => k)).toEqual(['page:home::_root'])
  })

  it('losing the scope (target reset) empties the stores; the drafts stay stored', async () => {
    const drafts = createMemoryDraftStore()
    await drafts.put(local, 'edit', 'page:home::_root', edit('Local draft'))
    const scope = ref<DraftScope | null>(local)
    const h = attach(drafts, () => scope.value)
    await h.loaded()

    scope.value = null
    await nextTick()
    await h.loaded()

    expect(usePersistedEditsStore().count).toBe(0)
    expect((await drafts.list(local, 'edit')).map(([k]) => k)).toEqual(['page:home::_root'])
  })

  it("two tabs don't delete each other's drafts", async () => {
    const drafts = createMemoryDraftStore()
    setActivePinia(createPinia())
    const tab1 = attach(drafts, () => local)
    const tab1Edits = usePersistedEditsStore()
    setActivePinia(createPinia())
    const tab2 = attach(drafts, () => local)
    const tab2Edits = usePersistedEditsStore()
    await Promise.all([tab1.loaded(), tab2.loaded()])

    tab1Edits.set('page:home::_root', { title: 'tab1' })
    await tab1.flush()
    tab2Edits.set('page:about::_root', { title: 'tab2' })
    await tab2.flush()

    expect((await drafts.list(local, 'edit')).map(([k]) => k).sort()).toEqual(['page:about::_root', 'page:home::_root'])
  })

  it('skips a structural draft with a key it cannot read, keeps the rest', async () => {
    const drafts = createMemoryDraftStore()
    await drafts.put(local, 'structural', 'not-a-manifest-key', { original: [], pending: [] })
    await drafts.put(local, 'structural', HOME, { original: ['a'], pending: [] })
    await attach(drafts, () => local).loaded()
    expect(
      useEditorStructuralStore()
        .allEntries()
        .map(([k]) => k),
    ).toEqual([HOME])
  })

  it('draftsLoaded() waits for the current load', async () => {
    const drafts = createMemoryDraftStore()
    await drafts.put(local, 'edit', 'page:home::hero', edit('Draft'))
    attach(drafts, () => local)
    await draftsLoaded()
    expect(usePersistedEditsStore().has('page:home::hero')).toBe(true)
  })
})
