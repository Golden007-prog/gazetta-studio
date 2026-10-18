/**
 * Page metadata is per locale file (page.fr.json has its own). The
 * editor loads the active locale's metadata, so an edit belongs to that
 * locale and is saved there (the save itself: metadataLane.test.ts).
 * Reproduced 2026-10-18: editing the French page's title and saving
 * wrote it into page.json.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import PageMetadataEditor from '../src/client/components/PageMetadataEditor.vue'
import { api } from '../src/client/api/client.js'
import { useEditorMetadataStore } from '../src/client/stores/editorMetadata.js'
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

describe('PageMetadataEditor edits the locale it loaded', () => {
  it.each([
    ['fr', { kind: 'page', name: 'home', locale: 'fr' }, { kind: 'page', name: 'home' }],
    [undefined, { kind: 'page', name: 'home' }, { kind: 'page', name: 'home', locale: 'fr' }],
  ] as const)('loaded for %s: the edit is pending for that locale only', async (locale, key, other) => {
    useSelectionStore().$patch({
      selection: { type: 'page', name: 'home', detail: detail('Gazetta — CMS Composable'), locale } as never,
    })
    const wrapper = mount(PageMetadataEditor)
    await wrapper.find('[data-testid="meta-title"]').setValue('Titre modifié')
    expect(useEditorMetadataStore().pendingFor(key)).toStrictEqual({ title: 'Titre modifié' })
    expect(useEditorMetadataStore().pendingFor(other)).toBeNull()
  })
})
