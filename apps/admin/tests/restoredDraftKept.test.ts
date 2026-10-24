/**
 * #1108: a restored content draft stays in storage until it is saved
 * or discarded, so any number of reloads bring it back; and a fragment
 * edit opened from a page is persisted under the same key the restore
 * lookup uses, so it comes back after a reload like a component edit.
 *
 * Verified fail-unfixed before commit: on main the restore clears the
 * persisted entry as soon as it is applied (the first test fails: the
 * draft is gone from storage and the second reload shows the saved
 * content), and a fragment edit is stashed under
 * page:home:<locale>:@header but looked up under
 * fragment:header:<locale>:_root (the second test fails: the editor
 * shows the stored content).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { api } from '../src/client/api/client.js'
import { useEditorActions } from '../src/client/composables/useEditorActions.js'
import { useEditorContentStore } from '../src/client/stores/editorContent.js'
import { attachDraftPersistence, type DraftPersistenceHandle } from '../src/client/drafts/persistence.js'
import { createMemoryDraftStore } from '../src/client/drafts/memory-draft-store.js'
import type { DraftScope, DraftStore } from '../src/client/drafts/types.js'
import { useSelectionStore } from '../src/client/stores/selection.js'
import { useSiteStore } from '../src/client/stores/site.js'
import { manifestPath, useEditorEtagsStore } from '../src/client/stores/editorEtags.js'

const scope: DraftScope = { site: 'main', owner: 'none:unknown:admin', target: 'local' }
const detail = {
  name: 'home',
  route: '/',
  template: 'page-default',
  content: { title: 'Home' },
  components: [],
  dir: 'pages/home',
  metadata: { title: 'Home' },
}
const headerFragment = {
  name: 'header',
  template: 'header-layout',
  content: { title: 'Stored' },
  components: [],
  dir: 'fragments/header',
}

let drafts: DraftStore
let handle: DraftPersistenceHandle | null = null

async function freshSession() {
  handle?.dispose()
  setActivePinia(createPinia())
  useSiteStore().$patch({ manifest: { name: 'main' } as never })
  handle = attachDraftPersistence(drafts, () => scope, { debounceMs: 0 })
  await handle.loaded()
  await useSelectionStore().selectPage('home')
  return useEditorActions()
}

beforeEach(() => {
  drafts = createMemoryDraftStore()
  vi.spyOn(api, 'getTemplateSchema').mockResolvedValue({ properties: { title: { type: 'string' } } } as never)
  vi.spyOn(api, 'getPageWithEtag').mockImplementation(
    async () => ({ data: structuredClone(detail), etag: 'v1' }) as never,
  )
  vi.spyOn(api, 'getFragmentWithEtag').mockImplementation(
    async () => ({ data: structuredClone(headerFragment), etag: 'f1' }) as never,
  )
})

afterEach(() => {
  handle?.dispose()
  handle = null
  vi.restoreAllMocks()
})

describe('a restored content draft (#1108)', () => {
  it('stays in storage after it is restored, so a second reload brings it back', async () => {
    let actions = await freshSession()
    await actions.openPageRoot()
    actions.markDirty({ title: 'Mine' })
    await handle!.flush()
    expect((await drafts.list(scope, 'edit')).length).toBe(1)

    // First reload: the draft is restored into the editor and stays stored.
    actions = await freshSession()
    await actions.openPageRoot()
    expect(useEditorContentStore().dirty).toBe(true)
    expect(useEditorContentStore().content).toEqual({ title: 'Mine' })
    await handle!.flush()
    expect((await drafts.list(scope, 'edit')).length).toBe(1)

    // Second reload: still there, without a keystroke in between.
    actions = await freshSession()
    await actions.openPageRoot()
    expect(useEditorContentStore().content).toEqual({ title: 'Mine' })
  })

  it('a fragment edit opened from a page comes back after a reload', async () => {
    let actions = await freshSession()
    await actions.openPageRoot()
    await actions.openFragment('header')
    actions.markDirty({ title: 'Edited' })
    await handle!.flush()
    expect((await drafts.list(scope, 'edit')).length).toBe(1)

    actions = await freshSession()
    await actions.openFragment('header')
    expect(useEditorContentStore().content).toEqual({ title: 'Edited' })
  })
})

describe('Save and Discard are the only clears once a restore keeps the draft (#1108)', () => {
  it('after Save, a reload restores nothing (restored root draft)', async () => {
    let actions = await freshSession()
    await actions.openPageRoot()
    actions.markDirty({ title: 'Mine' })
    await handle!.flush()

    const updatePage = vi.spyOn(api, 'updatePage').mockResolvedValue({ ok: true, etag: 'v2' } as never)
    actions = await freshSession()
    await actions.openPageRoot()
    expect(useEditorContentStore().dirty).toBe(true)
    expect(await actions.save()).toBe(true)
    expect(updatePage).toHaveBeenCalledWith('home', expect.anything(), expect.objectContaining({ ifMatch: 'v1' }))
    await handle!.flush()
    expect((await drafts.list(scope, 'edit')).length).toBe(0)

    actions = await freshSession()
    await actions.openPageRoot()
    expect(useEditorContentStore().dirty).toBe(false)
  })

  it('after Discard, a reload restores nothing (restored root draft)', async () => {
    let actions = await freshSession()
    await actions.openPageRoot()
    actions.markDirty({ title: 'Mine' })
    await handle!.flush()

    actions = await freshSession()
    await actions.openPageRoot()
    expect(useEditorContentStore().dirty).toBe(true)
    actions.discard()
    await handle!.flush()
    expect((await drafts.list(scope, 'edit')).length).toBe(0)

    actions = await freshSession()
    await actions.openPageRoot()
    expect(useEditorContentStore().dirty).toBe(false)
    expect(useEditorContentStore().content).toEqual({ title: 'Home' })
  })

  it('after Save, a reload restores nothing (fragment edit opened from a page)', async () => {
    let actions = await freshSession()
    await actions.openFragment('header')
    actions.markDirty({ title: 'Edited' })
    await handle!.flush()

    const updateFragment = vi.spyOn(api, 'updateFragment').mockResolvedValue({ ok: true, etag: 'f2' } as never)
    actions = await freshSession()
    await actions.openFragment('header')
    expect(useEditorContentStore().content).toEqual({ title: 'Edited' })
    expect(await actions.save()).toBe(true)
    expect(updateFragment).toHaveBeenCalledWith('header', expect.anything(), expect.objectContaining({ ifMatch: 'f1' }))
    await handle!.flush()
    expect((await drafts.list(scope, 'edit')).length).toBe(0)

    actions = await freshSession()
    await actions.openFragment('header')
    expect(useEditorContentStore().content).toEqual({ title: 'Stored' })
  })

  it('after Discard, a reload restores nothing (fragment edit opened from a page)', async () => {
    let actions = await freshSession()
    await actions.openFragment('header')
    actions.markDirty({ title: 'Edited' })
    await handle!.flush()

    actions = await freshSession()
    await actions.openFragment('header')
    expect(useEditorContentStore().content).toEqual({ title: 'Edited' })
    actions.discard()
    await handle!.flush()
    expect((await drafts.list(scope, 'edit')).length).toBe(0)

    actions = await freshSession()
    await actions.openFragment('header')
    expect(useEditorContentStore().content).toEqual({ title: 'Stored' })
  })
})

describe('kept drafts vs later saves and page-level Discard (review follow-ups)', () => {
  it('a stored draft equal to the content just loaded is dropped, not kept', async () => {
    let actions = await freshSession()
    await actions.openPageRoot()
    actions.markDirty({ title: 'Mine' })
    await handle!.flush()

    // Another tab saved the same edit: the server now has it, at a newer etag.
    vi.spyOn(api, 'getPageWithEtag').mockImplementation(
      async () => ({ data: { ...structuredClone(detail), content: { title: 'Mine' } }, etag: 'v2' }) as never,
    )
    actions = await freshSession()
    await actions.openPageRoot()
    expect(useEditorContentStore().dirty).toBe(false)
    await handle!.flush()
    expect((await drafts.list(scope, 'edit')).length).toBe(0)

    // A later, different save must not see the old draft applied over it.
    vi.spyOn(api, 'getPageWithEtag').mockImplementation(
      async () => ({ data: { ...structuredClone(detail), content: { title: 'Theirs' } }, etag: 'v3' }) as never,
    )
    actions = await freshSession()
    await actions.openPageRoot()
    expect(useEditorContentStore().content).toEqual({ title: 'Theirs' })
    expect(useEditorContentStore().dirty).toBe(false)
  })

  it('Discard on a page clears a restored fragment draft not opened since the reload', async () => {
    vi.spyOn(api, 'getPageWithEtag').mockImplementation(
      async () => ({ data: { ...structuredClone(detail), components: ['@header'] }, etag: 'v1' }) as never,
    )
    let actions = await freshSession()
    await actions.openFragment('header')
    actions.markDirty({ title: 'Edited' })
    await handle!.flush()

    // Reload: open only the page root, then Discard without opening the fragment.
    actions = await freshSession()
    await actions.openPageRoot()
    actions.discard()
    await handle!.flush()
    expect((await drafts.list(scope, 'edit')).length).toBe(0)

    actions = await freshSession()
    await actions.openFragment('header')
    expect(useEditorContentStore().content).toEqual({ title: 'Stored' })
  })
})

describe('removing a fragment reference from a page (#1108 review)', () => {
  it('keeps the fragment draft: the fragment survives the unlink, shared across pages', async () => {
    vi.spyOn(api, 'getPageWithEtag').mockImplementation(
      async () => ({ data: { ...structuredClone(detail), components: ['@header'] }, etag: 'v1' }) as never,
    )
    let actions = await freshSession()
    await actions.openFragment('header')
    actions.markDirty({ title: 'Edited' })
    await handle!.flush()

    // The page unlinks the fragment; the fragment itself still exists.
    actions.clearEditorForRemovedPath('@header')
    await handle!.flush()
    expect((await drafts.list(scope, 'edit')).length).toBe(1)

    actions = await freshSession()
    await actions.openFragment('header')
    expect(useEditorContentStore().content).toEqual({ title: 'Edited' })
  })
})

describe("a fragment's own root has one editor (#1108 review)", () => {
  async function freshFragmentSession() {
    handle?.dispose()
    setActivePinia(createPinia())
    useSiteStore().$patch({ manifest: { name: 'main' } as never })
    handle = attachDraftPersistence(drafts, () => scope, { debounceMs: 0 })
    await handle.loaded()
    await useSelectionStore().selectFragment('header')
    return useEditorActions()
  }

  it('opening the fragment from the preview opens the root row', async () => {
    const actions = await freshFragmentSession()
    await actions.openFragment('header')
    expect(useEditorContentStore().path).toBe('_root')
  })

  it('revert after editing through both entry points keeps nothing stale', async () => {
    let actions = await freshFragmentSession()
    await actions.openPageRoot()
    actions.markDirty({ title: 'A' })
    await actions.openFragment('header')
    actions.markDirty({ title: 'B' })
    await actions.openPageRoot()
    actions.revertComponent('_root')
    await handle!.flush()
    expect(actions.hasPendingEdit('@header')).toBe(false)
    expect((await drafts.list(scope, 'edit')).length).toBe(0)

    actions = await freshFragmentSession()
    await actions.openPageRoot()
    expect(useEditorContentStore().content).toEqual({ title: 'Stored' })
    expect(useEditorContentStore().dirty).toBe(false)
  })
})

describe('a nested fragment draft under a host fragment (#1108 review)', () => {
  it('bases on the nested fragment: host etag untouched, draft base pinned for conflict checks', async () => {
    const footerFragment = {
      name: 'footer',
      template: 'footer-layout',
      content: { title: 'FStored' },
      components: [],
      dir: 'fragments/footer',
    }
    const versions: Record<string, string> = { header: 'h1', footer: 'f1' }
    vi.spyOn(api, 'getFragmentWithEtag').mockImplementation(async name => {
      const base = name === 'footer' ? footerFragment : headerFragment
      return { data: structuredClone(base), etag: versions[name] } as never
    })

    async function freshFragmentSession() {
      handle?.dispose()
      setActivePinia(createPinia())
      useSiteStore().$patch({ manifest: { name: 'main' } as never })
      handle = attachDraftPersistence(drafts, () => scope, { debounceMs: 0 })
      await handle.loaded()
      await useSelectionStore().selectFragment('header')
      return useEditorActions()
    }

    let actions = await freshFragmentSession()
    await actions.openFragment('footer')
    actions.markDirty({ title: 'Nested' })
    await handle!.flush()

    // Other tabs save both manifests since: fresh etags on the reload.
    versions.header = 'h2'
    versions.footer = 'f2'
    actions = await freshFragmentSession()
    await actions.openFragment('footer')
    expect(useEditorContentStore().content).toEqual({ title: 'Nested' })

    // The host's etag stays the fresh one; the draft pins the nested
    // fragment's base, so its save still conflict-checks.
    expect(useEditorEtagsStore().get(manifestPath('fragment', 'header', undefined))).toBe('h2')
    expect(useEditorEtagsStore().get(manifestPath('fragment', 'footer', undefined))).toBe('f1')
  })
})
