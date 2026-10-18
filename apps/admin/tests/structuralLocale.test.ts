/**
 * Structural edits belong to one locale file. Locale variants are whole
 * files with their own component list, so a reorder made on `fr` must
 * stay `fr`. Reproduced 2026-10-18: a French reorder, restored after a
 * reload in English and saved, wrote the French component list — French
 * hero text included — into page.json.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { api } from '../src/client/api/client.js'
import { useEditorActions } from '../src/client/composables/useEditorActions.js'
import { useEditorStructuralStore } from '../src/client/stores/editorStructural.js'
import { manifestFileKeyFromString, manifestFileKeyToString } from '../src/client/utils/manifestFileKey.js'
import { useLocaleStore } from '../src/client/stores/locale.js'
import { useSiteStore } from '../src/client/stores/site.js'

const home = { kind: 'page' as const, name: 'home' }
const components = ['@header', { name: 'hero', template: 'hero', content: { title: 'Bienvenue' } }, 'features']

beforeEach(() => {
  setActivePinia(createPinia())
  useSiteStore().$patch({ manifest: { name: 'main', locales: { default: 'en', supported: ['en', 'fr'] } } as never })
})
afterEach(() => vi.restoreAllMocks())

describe('structural keys carry the locale', () => {
  it.each([
    { ...home },
    { ...home, locale: 'fr' },
    { kind: 'fragment' as const, name: 'a:b/c' },
  ])('round-trips %o', key => {
    expect(manifestFileKeyFromString(manifestFileKeyToString(key))).toEqual(key)
  })

  it.each(['page:home', '["page"]', '["blog","x",""]', '["page",1,""]'])('rejects %s', bad => {
    expect(() => manifestFileKeyFromString(bad)).toThrow()
  })

  it('a reorder on fr is not pending on en', () => {
    useLocaleStore().setLocale('fr')
    useEditorActions().moveComponentStructural(home, components, 1, 2)
    useLocaleStore().setLocale(null)
    const store = useEditorStructuralStore()
    expect(store.pendingFor(home)).toBeNull()
    expect(store.pendingFor({ ...home, locale: 'fr' })).not.toBeNull()
  })

  it('save writes a fr reorder to the fr file, even while en is active', async () => {
    const updatePage = vi.spyOn(api, 'updatePage').mockResolvedValue({ ok: true, etag: 'e' } as never)
    useLocaleStore().setLocale('fr')
    const actions = useEditorActions()
    actions.moveComponentStructural(home, components, 1, 2)
    useLocaleStore().setLocale(null) // e.g. reloaded without ?locale=fr
    await actions.save()
    expect(updatePage).toHaveBeenCalledTimes(1)
    const [name, payload, opts] = updatePage.mock.calls[0]
    expect(name).toBe('home')
    expect(opts).toMatchObject({ locale: 'fr' })
    expect((payload as { components: unknown[] }).components).toEqual(['@header', 'features', components[1]])
  })

  it('the preview gets only the current locale, keyed by manifest', () => {
    const actions = useEditorActions()
    useLocaleStore().setLocale('fr')
    actions.moveComponentStructural(home, components, 1, 2)
    expect(Object.keys(actions.allOverrides.value.structural)).toEqual(['page:home'])
    useLocaleStore().setLocale(null)
    expect(actions.allOverrides.value.structural).toEqual({})
  })
})
