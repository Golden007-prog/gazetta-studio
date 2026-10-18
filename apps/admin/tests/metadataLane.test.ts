/**
 * Page metadata as a pending lane in the editor (design-editor-ux.md,
 * "Page metadata is a pending lane"). The one Save writes it after the
 * other edits, to the locale it was edited in; the unsaved-changes guard
 * counts it; Discard and Don't Save drop it; a row's revert undoes only
 * what that row's dot marks.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { api, StaleSaveError } from '../src/client/api/client.js'
import { useEditorActions } from '../src/client/composables/useEditorActions.js'
import { useEditorContentStore } from '../src/client/stores/editorContent.js'
import { useEditorEtagsStore } from '../src/client/stores/editorEtags.js'
import { type MetadataKey, useEditorMetadataStore } from '../src/client/stores/editorMetadata.js'
import { useEditorStructuralStore } from '../src/client/stores/editorStructural.js'
import { useLocaleStore } from '../src/client/stores/locale.js'
import { useSaveConflictsStore } from '../src/client/stores/saveConflicts.js'
import { useSelectionStore } from '../src/client/stores/selection.js'
import { useSiteStore } from '../src/client/stores/site.js'

const home: MetadataKey = { kind: 'page', name: 'home' }
const loaded = { title: 'Home', robots: 'nofollow' }
const detail = {
  name: 'home',
  route: '/',
  template: 'page-default',
  content: {},
  components: [
    { name: 'hero', template: 'hero', content: { title: 'Hi' } },
    { name: 'features', template: 'features', content: {} },
  ],
  dir: 'pages/home',
  metadata: loaded,
}

function select(locale?: string) {
  useSelectionStore().$patch({
    selection: { type: 'page', name: 'home', detail: structuredClone(detail), locale } as never,
  })
}

const editTitle = (title: string, key: MetadataKey = home) =>
  useEditorMetadataStore().setField(key, loaded, 'title', title)

beforeEach(() => {
  setActivePinia(createPinia())
  useSiteStore().$patch({ manifest: { name: 'main', locales: { default: 'en', supported: ['en', 'fr'] } } as never })
  select()
  vi.spyOn(api, 'getTemplateSchema').mockResolvedValue({ properties: { title: { type: 'string' } } } as never)
  vi.spyOn(api, 'getPageWithEtag').mockResolvedValue({ data: structuredClone(detail), etag: 'reloaded' } as never)
})
afterEach(() => vi.restoreAllMocks())

describe('Save', () => {
  it('writes content, then moves, then metadata, each with the version the previous write returned', async () => {
    useEditorEtagsStore().set('pages/home/page.json', 'v1')
    const updatePage = vi
      .spyOn(api, 'updatePage')
      .mockResolvedValueOnce({ ok: true, etag: 'v2' } as never)
      .mockResolvedValueOnce({ ok: true, etag: 'v3' } as never)
      .mockResolvedValueOnce({ ok: true, etag: 'v4' } as never)
    const actions = useEditorActions()
    await actions.openPageRoot()
    actions.markDirty({ title: 'Root' })
    actions.moveComponentStructural({ kind: 'page', name: 'home' }, detail.components, 0, 1)
    editTitle('New title')

    expect(await actions.save()).toBe(true)
    expect(updatePage.mock.calls).toEqual([
      ['home', { content: { title: 'Root' } }, { locale: undefined, ifMatch: 'v1' }],
      ['home', { components: [detail.components[1], detail.components[0]] }, { locale: undefined, ifMatch: 'v2' }],
      ['home', { metadata: { title: 'New title', robots: 'nofollow' } }, { locale: undefined, ifMatch: 'v3' }],
    ])
    expect(useEditorMetadataStore().hasPendingEdits).toBe(false)
    expect(useSaveConflictsStore().has('pages/home/page.json')).toBe(false)
  })

  it('reloads the page afterwards, so the form shows what was saved', async () => {
    vi.spyOn(api, 'updatePage').mockResolvedValue({ ok: true, etag: 'v2' } as never)
    editTitle('New title')
    expect(await useEditorActions().save()).toBe(true)
    expect(api.getPageWithEtag).toHaveBeenCalledWith('home', { locale: undefined })
  })

  it('a stale version is a conflict: the save fails, the banner gets the whole page, the edit stays', async () => {
    vi.spyOn(api, 'updatePage').mockRejectedValue(new StaleSaveError({ metadata: { title: 'Theirs' } }, 'v9'))
    editTitle('Mine')
    expect(await useEditorActions().save()).toBe(false)
    expect(useSaveConflictsStore().get('pages/home/page.json')).toMatchObject({
      currentEtag: 'v9',
      pending: { template: 'page-default', components: detail.components, metadata: { title: 'Mine' } },
    })
    expect(useEditorMetadataStore().hasPendingFor(home)).toBe(true)
  })

  it('writes metadata edited on fr to page.fr.json, even when saved from another locale', async () => {
    select('fr')
    useLocaleStore().setLocale('fr')
    editTitle('Accueil', { ...home, locale: 'fr' })
    useLocaleStore().setLocale(null)
    select()
    const updatePage = vi.spyOn(api, 'updatePage').mockResolvedValue({ ok: true, etag: 'f2' } as never)
    expect(await useEditorActions().save()).toBe(true)
    expect(updatePage).toHaveBeenCalledWith(
      'home',
      { metadata: { title: 'Accueil', robots: 'nofollow' } },
      expect.objectContaining({ locale: 'fr' }),
    )
  })

  it('an edit made while the save runs stays pending, against what was written', async () => {
    let finish!: (value: unknown) => void
    vi.spyOn(api, 'updatePage').mockReturnValue(new Promise(resolve => (finish = resolve)) as never)
    editTitle('First')
    const saving = useEditorActions().save()
    editTitle('Second')
    finish({ ok: true, etag: 'v2' })
    expect(await saving).toBe(true)
    const [[, entry]] = useEditorMetadataStore().allEntries()
    expect(entry).toStrictEqual({
      original: { title: 'First', robots: 'nofollow' },
      pending: { title: 'Second', robots: 'nofollow' },
    })
  })

  it('an edit made while the save runs and typed back to what was written leaves nothing pending', async () => {
    let finish!: (value: unknown) => void
    vi.spyOn(api, 'updatePage').mockReturnValue(new Promise(resolve => (finish = resolve)) as never)
    editTitle('First')
    const saving = useEditorActions().save()
    editTitle('Firs')
    editTitle('First')
    finish({ ok: true, etag: 'v2' })
    expect(await saving).toBe(true)
    expect(useEditorMetadataStore().hasPendingFor(home)).toBe(false)
  })
})

describe('pending state', () => {
  it('counts for the unsaved-changes guard and the leave-page prompt', () => {
    const actions = useEditorActions()
    expect(actions.hasPendingEdits.value).toBe(false)
    editTitle('New')
    expect(actions.hasPendingEdits.value).toBe(true)
    expect(actions.pendingCount.value).toBe(1)
    expect(actions.hasPendingMetadata.value).toBe(true)
  })

  it("the conflict banner's Discard drops the page's metadata", () => {
    editTitle('New')
    useEditorActions().discard()
    expect(useEditorMetadataStore().hasPendingFor(home)).toBe(false)
  })

  it("Don't Save drops it", () => {
    editTitle('New')
    useEditorActions().clear()
    expect(useEditorMetadataStore().hasPendingEdits).toBe(false)
  })
})

describe("a row's revert undoes only what that row's dot marks", () => {
  it("the page row: the page's metadata", () => {
    editTitle('New')
    useEditorActions().revertComponent('_root')
    expect(useEditorMetadataStore().hasPendingFor(home)).toBe(false)
  })

  it("a component row, open: its own content; the page's metadata and moves stay", async () => {
    const actions = useEditorActions()
    await actions.openComponent('hero', 'hero')
    actions.markDirty({ title: 'Changed' })
    editTitle('New')
    actions.moveComponentStructural({ kind: 'page', name: 'home' }, detail.components, 0, 1)

    actions.revertComponent('hero')
    expect(useEditorContentStore().dirty).toBe(false)
    expect(useEditorMetadataStore().hasPendingFor(home)).toBe(true)
    expect(useEditorStructuralStore().hasPendingEdits).toBe(true)
  })
})
