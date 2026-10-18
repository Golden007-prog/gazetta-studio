/**
 * save() reports whether it wrote everything. The unsaved-changes guard
 * navigates away only after a successful save; before this, it cleared
 * the editor even when the save failed, and the edits were lost.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { api, ValidationFailedError } from '../src/client/api/client.js'
import { useEditorActions } from '../src/client/composables/useEditorActions.js'
import { useEditorContentStore } from '../src/client/stores/editorContent.js'
import { useSelectionStore } from '../src/client/stores/selection.js'

beforeEach(() => {
  setActivePinia(createPinia())
  useSelectionStore().$patch({
    selection: {
      type: 'page',
      name: 'home',
      detail: { name: 'home', route: '/', template: 'page-default', content: {}, components: [], dir: 'pages/home' },
    } as never,
  })
  vi.spyOn(api, 'getTemplateSchema').mockResolvedValue({ properties: { title: { type: 'string' } } } as never)
})
afterEach(() => vi.restoreAllMocks())

async function dirtyRoot() {
  const actions = useEditorActions()
  await actions.openPageRoot()
  actions.markDirty({ title: 'Changed' })
  return actions
}

describe('save() result', () => {
  it('true when the write succeeds', async () => {
    vi.spyOn(api, 'updatePage').mockResolvedValue({ ok: true, etag: 'e' } as never)
    const actions = await dirtyRoot()
    expect(await actions.save()).toBe(true)
    expect(useEditorContentStore().dirty).toBe(false)
  })

  it.each([
    ['a server error', () => new Error('Request failed: 500')],
    ['a validation failure', () => new ValidationFailedError([])],
  ])('false on %s, and the edit stays pending', async (_, error) => {
    vi.spyOn(api, 'updatePage').mockRejectedValue(error())
    const actions = await dirtyRoot()
    expect(await actions.save()).toBe(false)
    expect(useEditorContentStore().dirty).toBe(true)
  })
})
