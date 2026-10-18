/**
 * selection.reload() refreshes the selection in the locale it was loaded
 * for. It used to reload the default locale, so after a French save the
 * editor showed English data under ?locale=fr and the next save carried
 * the wrong save version (reproduced 2026-10-18).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { api } from '../src/client/api/client.js'
import { manifestPath, useEditorEtagsStore } from '../src/client/stores/editorEtags.js'
import { useLocaleStore } from '../src/client/stores/locale.js'
import { useSelectionStore } from '../src/client/stores/selection.js'
import { useSiteStore } from '../src/client/stores/site.js'

const detail = { name: 'home', route: '/', template: 'page-default', content: {}, components: [], dir: 'pages/home' }

beforeEach(() => {
  setActivePinia(createPinia())
  useSiteStore().$patch({ manifest: { name: 'main', locales: { default: 'en', supported: ['en', 'fr'] } } as never })
})
afterEach(() => vi.restoreAllMocks())

describe.each(['page', 'fragment'] as const)('reload of a %s', kind => {
  const loader = kind === 'page' ? 'getPageWithEtag' : 'getFragmentWithEtag'
  const select = (s: ReturnType<typeof useSelectionStore>) =>
    kind === 'page' ? s.selectPage('home') : s.selectFragment('home')

  it.each([
    ['fr', 'fr'],
    [null, undefined],
  ] as const)('loaded in %s → reloads in that locale', async (active, locale) => {
    useLocaleStore().setLocale(active)
    const load = vi.spyOn(api, loader).mockResolvedValue({ data: detail, etag: 'e1' } as never)
    const selection = useSelectionStore()
    await select(selection)

    load.mockResolvedValue({ data: detail, etag: 'e2' } as never)
    await selection.reload()

    expect(load.mock.lastCall?.[0]).toBe('home')
    expect((load.mock.lastCall?.[1] as { locale?: string } | undefined)?.locale).toBe(locale)
    expect(selection.selection?.locale).toBe(locale)
    expect(useEditorEtagsStore().get(manifestPath(kind, 'home', locale))).toBe('e2')
  })
})
