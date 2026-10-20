/**
 * Save writes the open editor only when it has an edit. An untouched open
 * editor written anyway adds a history revision and an audit `save` of
 * content nobody changed, and the toast's Undo restores only that write.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { api } from '../src/client/api/client.js'
import { useEditorActions } from '../src/client/composables/useEditorActions.js'
import { useSelectionStore } from '../src/client/stores/selection.js'

const components = [{ name: 'hero', template: 'hero', content: { title: 'Hi' } }]
const detail = { name: 'home', route: '/', template: 'page-default', content: {}, components, dir: 'pages/home' }

beforeEach(() => {
  setActivePinia(createPinia())
  useSelectionStore().$patch({ selection: { type: 'page', name: 'home', detail: structuredClone(detail) } as never })
  vi.spyOn(api, 'getTemplateSchema').mockResolvedValue({ properties: { title: { type: 'string' } } } as never)
  vi.spyOn(api, 'getPageWithEtag').mockResolvedValue({ data: structuredClone(detail), etag: 'r' } as never)
})
afterEach(() => vi.restoreAllMocks())

describe('save with the open editor untouched', () => {
  it('writes only the stashed component edit', async () => {
    const updatePage = vi.spyOn(api, 'updatePage').mockResolvedValue({ ok: true, etag: 'v' } as never)
    const actions = useEditorActions()
    await actions.openComponent('hero', 'hero')
    actions.markDirty({ title: 'H1' })
    await actions.openPageRoot() // hero stashed; root open and untouched

    expect(await actions.save()).toBe(true)

    expect(updatePage).toHaveBeenCalledTimes(1)
    expect(updatePage.mock.calls[0][1]).toEqual({
      components: [{ name: 'hero', template: 'hero', content: { title: 'H1' } }],
    })
    expect(actions.hasPendingEdits.value).toBe(false)
  })

  it('still writes the open editor when it is dirty', async () => {
    const updatePage = vi.spyOn(api, 'updatePage').mockResolvedValue({ ok: true, etag: 'v' } as never)
    const actions = useEditorActions()
    await actions.openPageRoot()
    actions.markDirty({ title: 'A' })

    expect(await actions.save()).toBe(true)

    expect(updatePage.mock.calls.map(c => c[1])).toEqual([{ content: { title: 'A' } }])
  })
})
