/**
 * A redirect (archived with an alias) or a pure archive has no template:
 * there is nothing to edit, and the archive banner is the whole UI. The
 * editor used to fetch the schema of template "undefined" and show
 * "Failed to load" (reproduced 2026-10-18, #965).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { api } from '../src/client/api/client.js'
import { useEditorActions } from '../src/client/composables/useEditorActions.js'
import { useEditorContentStore } from '../src/client/stores/editorContent.js'
import { useSelectionStore } from '../src/client/stores/selection.js'

afterEach(() => vi.restoreAllMocks())
beforeEach(() => setActivePinia(createPinia()))

function seedRedirect(type: 'page' | 'fragment') {
  useSelectionStore().$patch({
    selection: {
      type,
      name: 'old-about',
      detail: {
        name: 'old-about',
        route: '/old-about',
        archived: true,
        aliasOf: 'about',
        components: [],
        dir: `${type}s/old-about`,
      },
    } as never,
  })
}

describe('opening an item without a template', () => {
  it.each(['page', 'fragment'] as const)('%s root: no schema request, no load error, nothing open', async type => {
    const getSchema = vi.spyOn(api, 'getTemplateSchema')
    seedRedirect(type)
    await useEditorActions().openPageRoot()
    expect(getSchema).not.toHaveBeenCalled()
    const ec = useEditorContentStore()
    expect(ec.loadError).toBeNull()
    expect(ec.path).toBeNull()
  })

  it('a fragment opened from its page link: no schema request, nothing open', async () => {
    const getSchema = vi.spyOn(api, 'getTemplateSchema')
    vi.spyOn(api, 'getFragmentWithEtag').mockResolvedValue({
      data: { name: 'old-header', archived: true, aliasOf: 'header' },
      etag: null,
    } as never)
    useSelectionStore().$patch({
      selection: {
        type: 'page',
        name: 'home',
        detail: { name: 'home', route: '/', template: 'page-default', content: {}, components: [], dir: 'pages/home' },
      } as never,
    })
    await useEditorActions().navigate({ kind: 'fragmentEdit', fragmentName: 'old-header' } as never)
    expect(getSchema).not.toHaveBeenCalled()
    expect(useEditorContentStore().loadError).toBeNull()
  })
})
