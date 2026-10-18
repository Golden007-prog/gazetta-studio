/**
 * Page metadata is per locale file (page.fr.json has its own). The
 * editor loads the active locale's metadata, so its save must write that
 * same file. Reproduced 2026-10-18: editing the French page's title and
 * saving wrote it into page.json.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import PageMetadataEditor from '../src/client/components/PageMetadataEditor.vue'
import { api } from '../src/client/api/client.js'
import { PAGES_API, type PagesApi } from '../src/client/composables/api.js'
import { useLocaleStore } from '../src/client/stores/locale.js'
import { useSelectionStore } from '../src/client/stores/selection.js'
import { useSiteStore } from '../src/client/stores/site.js'

const detail = (title: string) => ({
  name: 'home',
  route: '/',
  template: 'page-default',
  content: {},
  components: [],
  dir: 'pages/home',
  metadata: { title },
})

beforeEach(() => {
  setActivePinia(createPinia())
  useSiteStore().$patch({ manifest: { name: 'main', locales: { default: 'en', supported: ['en', 'fr'] } } as never })
})
afterEach(() => vi.restoreAllMocks())

describe('the selection records the locale its page was loaded for', () => {
  it.each([
    ['fr', 'fr'],
    [null, undefined],
  ] as const)('active locale %s → selection.locale %s', async (active, expected) => {
    useLocaleStore().setLocale(active)
    vi.spyOn(api, 'getPageWithEtag').mockResolvedValue({ data: detail('T'), etag: null } as never)
    await useSelectionStore().selectPage('home')
    expect(useSelectionStore().selection?.locale).toBe(expected)
  })
})

describe('PageMetadataEditor saves to the locale it loaded', () => {
  async function editAndSave(locale: string | undefined) {
    const updatePage = vi.fn(async () => ({ ok: true }))
    const selection = useSelectionStore()
    selection.$patch({
      selection: { type: 'page', name: 'home', detail: detail('Gazetta — CMS Composable'), locale } as never,
    })
    vi.spyOn(selection, 'reload').mockResolvedValue(undefined as never)
    const wrapper = mount(PageMetadataEditor, {
      global: { provide: { [PAGES_API as symbol]: { updatePage } as unknown as PagesApi } },
    })
    await wrapper.find('[data-testid="meta-title"]').setValue('Titre modifié')
    await wrapper.find('[data-testid="metadata-save"]').trigger('click')
    await flushPromises()
    return updatePage
  }

  it('French page → writes page.fr.json', async () => {
    const updatePage = await editAndSave('fr')
    expect(updatePage).toHaveBeenCalledWith('home', { metadata: { title: 'Titre modifié' } }, { locale: 'fr' })
  })

  it('default locale → writes page.json (no locale)', async () => {
    const updatePage = await editAndSave(undefined)
    const [name, payload, opts] = updatePage.mock.calls[0] as unknown as [
      string,
      unknown,
      { locale?: string } | undefined,
    ]
    expect([name, payload]).toEqual(['home', { metadata: { title: 'Titre modifié' } }])
    expect(opts?.locale).toBeUndefined()
  })
})
