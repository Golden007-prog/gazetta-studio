/**
 * Edits made while a save runs stay pending: what the save wrote becomes the
 * baseline. Before, the editor marked its content saved as it was when the
 * save finished, so text typed meanwhile looked saved but was never written,
 * and moves made meanwhile were dropped (both reproduced 2026-10-18).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { api } from '../src/client/api/client.js'
import { useEditorActions } from '../src/client/composables/useEditorActions.js'
import { useEditorContentStore } from '../src/client/stores/editorContent.js'
import { useEditorPersistenceStore } from '../src/client/stores/editorPersistence.js'
import { useEditorStashStore } from '../src/client/stores/editorStash.js'
import { useEditorStructuralStore } from '../src/client/stores/editorStructural.js'
import { usePersistedEditsStore } from '../src/client/stores/persistedEdits.js'
import { useSelectionStore } from '../src/client/stores/selection.js'

const home = { kind: 'page' as const, name: 'home' }
const components = [{ name: 'hero', template: 'hero', content: { title: 'Hi' } }, 'b', 'c']
const detail = { name: 'home', route: '/', template: 'page-default', content: {}, components, dir: 'pages/home' }
const ROOT_DRAFT = 'page:home::_root'

let finishers: Array<() => void> = []

beforeEach(() => {
  setActivePinia(createPinia())
  useSelectionStore().$patch({ selection: { type: 'page', name: 'home', detail: structuredClone(detail) } as never })
  vi.spyOn(api, 'getTemplateSchema').mockResolvedValue({ properties: { title: { type: 'string' } } } as never)
  vi.spyOn(api, 'getPageWithEtag').mockResolvedValue({ data: structuredClone(detail), etag: 'r' } as never)
  finishers = []
})
afterEach(() => vi.restoreAllMocks())

/** Writes that wait until the test lets them finish. */
function slowWrites() {
  return vi
    .spyOn(api, 'updatePage')
    .mockImplementation(() => new Promise(resolve => finishers.push(() => resolve({ ok: true, etag: 'v' } as never))))
}

/** Let each write finish in turn until the save resolves. */
async function finish(saving: Promise<boolean>): Promise<boolean> {
  let done = false
  void saving.then(() => (done = true))
  while (!done) {
    finishers.shift()?.()
    await new Promise(resolve => setTimeout(resolve, 0))
  }
  return saving
}

describe('content', () => {
  it('text typed while the save runs stays unsaved, and its draft is kept', async () => {
    const updatePage = slowWrites()
    const actions = useEditorActions()
    await actions.openPageRoot()
    actions.markDirty({ title: 'A' })
    const saving = actions.save()
    actions.markDirty({ title: 'AB' })
    expect(await finish(saving)).toBe(true)

    expect(updatePage.mock.calls.map(c => c[1])).toEqual([{ content: { title: 'A' } }])
    expect(useEditorContentStore().dirty).toBe(true)
    expect(usePersistedEditsStore().get(ROOT_DRAFT)?.editedContent).toEqual({ title: 'AB' })
  })

  it('without edits meanwhile, what was saved is clean and its draft is gone', async () => {
    slowWrites()
    const actions = useEditorActions()
    await actions.openPageRoot()
    actions.markDirty({ title: 'A' })
    expect(await finish(actions.save())).toBe(true)
    expect(useEditorContentStore().dirty).toBe(false)
    expect(usePersistedEditsStore().get(ROOT_DRAFT)).toBeNull()
  })

  it('a component opened elsewhere during the save: its stash entry and draft are cleared once written', async () => {
    slowWrites()
    const actions = useEditorActions()
    await actions.openPageRoot()
    actions.markDirty({ title: 'A' })
    const saving = actions.save()
    await actions.openComponent('hero', 'hero') // stashes the root as it was written
    expect(await finish(saving)).toBe(true)

    expect(useEditorStashStore().has('_root')).toBe(false)
    expect(usePersistedEditsStore().get(ROOT_DRAFT)).toBeNull()
    expect(actions.hasPendingEdits.value).toBe(false)
  })

  it('a stashed edit changed while the save runs stays pending', async () => {
    slowWrites()
    const actions = useEditorActions()
    await actions.openComponent('hero', 'hero')
    actions.markDirty({ title: 'H1' })
    await actions.openPageRoot() // hero stashed with H1
    const saving = actions.save()
    await actions.openComponent('hero', 'hero')
    actions.markDirty({ title: 'H2' })
    await actions.openPageRoot() // hero stashed again, with H2
    expect(await finish(saving)).toBe(true)

    expect(useEditorStashStore().entries.get('hero')?.editedContent).toEqual({ title: 'H2' })
    expect(usePersistedEditsStore().get('page:home::hero')?.editedContent).toEqual({ title: 'H2' })
  })
})

describe('moves', () => {
  it('a move made while the save runs stays pending, against the order written', async () => {
    const updatePage = slowWrites()
    const actions = useEditorActions()
    actions.moveComponentStructural(home, components, 0, 1) // b hero c
    const written = [components[1], components[0], components[2]]
    const saving = actions.save()
    actions.moveComponentStructural(home, written, 2, 0) // c b hero
    expect(await finish(saving)).toBe(true)

    expect(updatePage.mock.calls.map(c => c[1])).toEqual([{ components: written }])
    const [[, entry]] = useEditorStructuralStore().allEntries()
    expect(entry.original).toEqual(written)
    expect(entry.pending).toEqual([components[2], components[1], components[0]])
  })

  it('a move made back to the order written leaves nothing pending', async () => {
    slowWrites()
    const actions = useEditorActions()
    actions.moveComponentStructural(home, components, 0, 1) // b hero c
    const written = [components[1], components[0], components[2]]
    const saving = actions.save()
    actions.moveComponentStructural(home, written, 0, 2) // hero c b
    actions.moveComponentStructural(home, [components[0], components[2], components[1]], 2, 0) // b hero c
    expect(await finish(saving)).toBe(true)
    expect(useEditorStructuralStore().hasPendingEdits).toBe(false)
  })

  // Until the reload lands, the tree reads the order on disk wherever nothing
  // is pending, so dropping the entry first showed the pre-save order (#288).
  it('the order written stays pending, and the save running, until the reload lands', async () => {
    vi.spyOn(api, 'updatePage').mockResolvedValue({ ok: true, etag: 'v' } as never)
    const written = [components[1], components[0], components[2]]
    let land: (() => void) | undefined
    vi.spyOn(api, 'getPageWithEtag').mockImplementation(
      () =>
        new Promise(resolve => {
          land = () => resolve({ data: { ...structuredClone(detail), components: written }, etag: 'v' } as never)
        }),
    )
    const actions = useEditorActions()
    actions.moveComponentStructural(home, components, 0, 1)
    const saving = actions.save()
    await vi.waitFor(() => expect(land).toBeDefined())

    expect(useEditorStructuralStore().pendingFor(home)).toEqual(written)
    // Still saving, so the toolbar and Ctrl/Cmd+S don't start a second save.
    expect(useEditorPersistenceStore().saving).toBe(true)
    land?.()
    expect(await saving).toBe(true)
    expect(useEditorStructuralStore().hasPendingEdits).toBe(false)
  })

  it('a first move made while the save runs stays pending', async () => {
    slowWrites()
    const actions = useEditorActions()
    await actions.openPageRoot()
    actions.markDirty({ title: 'A' })
    const saving = actions.save()
    actions.moveComponentStructural(home, components, 0, 1)
    expect(await finish(saving)).toBe(true)
    expect(useEditorStructuralStore().hasPendingEdits).toBe(true)
  })
})
