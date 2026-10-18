/**
 * Restored reorder drafts wait for their page (#979), like metadata drafts
 * (design-editor-ux.md, "Kept across reload"). Until the page is opened in
 * that locale they don't count for the guard and no Save writes them; Don't
 * Save on another page keeps them stored.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { api } from '../src/client/api/client.js'
import { useEditorActions } from '../src/client/composables/useEditorActions.js'
import { attachDraftPersistence, type DraftPersistenceHandle } from '../src/client/drafts/persistence.js'
import { createMemoryDraftStore } from '../src/client/drafts/memory-draft-store.js'
import type { DraftScope } from '../src/client/drafts/types.js'
import { useEditorStructuralStore } from '../src/client/stores/editorStructural.js'
import { useSelectionStore } from '../src/client/stores/selection.js'
import { useSiteStore } from '../src/client/stores/site.js'
import { manifestFileKeyToString } from '../src/client/utils/manifestFileKey.js'

const local: DraftScope = { site: 'main', owner: 'none:unknown:admin', target: 'local' }
const HOME = manifestFileKeyToString({ kind: 'page', name: 'home' })
const components = [
  { name: 'hero', template: 'hero', content: {} },
  { name: 'features', template: 'features', content: {} },
]
const reorder = { original: components, pending: [components[1], components[0]] }

function select(name: string) {
  const detail = { name, route: `/${name}`, template: 'page-default', content: {}, components, dir: `pages/${name}` }
  useSelectionStore().$patch({ selection: { type: 'page', name, detail } as never })
}

let handle: DraftPersistenceHandle | null = null

async function restoreHomeReorder() {
  const drafts = createMemoryDraftStore()
  await drafts.put(local, 'structural', HOME, reorder)
  handle = attachDraftPersistence(drafts, () => local, { debounceMs: 0 })
  await handle.loaded()
  return drafts
}

beforeEach(() => {
  setActivePinia(createPinia())
  useSiteStore().$patch({ manifest: { name: 'main' } as never })
  vi.spyOn(api, 'getTemplateSchema').mockResolvedValue({ properties: {} } as never)
})
afterEach(() => {
  handle?.dispose()
  handle = null
  vi.restoreAllMocks()
})

describe('a restored reorder draft', () => {
  it("doesn't count or get saved on another page; opening its page makes it pending", async () => {
    await restoreHomeReorder()
    select('about')
    const actions = useEditorActions()
    await actions.openPageRoot()
    expect(actions.hasPendingEdits.value).toBe(false)
    const updatePage = vi.spyOn(api, 'updatePage').mockResolvedValue({ ok: true, etag: 'v2' } as never)
    vi.spyOn(api, 'getPageWithEtag').mockResolvedValue({ data: {}, etag: 'v2' } as never)
    await actions.save()
    expect(updatePage.mock.calls.map(([name]) => name)).not.toContain('home')

    select('home')
    await actions.openPageRoot()
    expect(actions.hasPendingEdits.value).toBe(true)
    expect(useEditorStructuralStore().hasPendingFor({ kind: 'page', name: 'home' })).toBe(true)
  })

  it("survives Don't Save on another page", async () => {
    const drafts = await restoreHomeReorder()
    select('about')
    const actions = useEditorActions()
    await actions.openPageRoot()
    actions.clear()
    await handle!.flush()
    expect(await drafts.list(local, 'structural')).toEqual([[HOME, reorder]])
  })
})
