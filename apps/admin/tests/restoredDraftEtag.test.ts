/**
 * A draft keeps the save-etag of the version it was made on (#1034,
 * design-offline.md "Detection mechanism"). After a reload, saving the
 * restored draft sends that etag as If-Match, so a colleague's save in
 * between gets the conflict banner instead of being overwritten. This
 * session's own successful writes move the recorded etag forward.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { api, StaleSaveError } from '../src/client/api/client.js'
import { useEditorActions } from '../src/client/composables/useEditorActions.js'
import { attachDraftPersistence, type DraftPersistenceHandle } from '../src/client/drafts/persistence.js'
import { createMemoryDraftStore } from '../src/client/drafts/memory-draft-store.js'
import type { DraftScope, DraftStore } from '../src/client/drafts/types.js'
import { useSaveConflictsStore } from '../src/client/stores/saveConflicts.js'
import { useSelectionStore } from '../src/client/stores/selection.js'
import { useSiteStore } from '../src/client/stores/site.js'

const scope: DraftScope = { site: 'main', owner: 'none:unknown:admin', target: 'local' }
const PATH = 'pages/home/page.json'
const components = [
  { name: 'hero', template: 'hero', content: { title: 'Hi' } },
  { name: 'features', template: 'features', content: {} },
]
const detail = {
  name: 'home',
  route: '/',
  template: 'page-default',
  content: { title: 'Home' },
  components,
  dir: 'pages/home',
  metadata: { title: 'Home' },
}

/** The page on the server: its current save-etag, and whether a write fails. */
interface Server {
  etag: string
  writes: number
  fail?: (payload: Record<string, unknown>) => boolean
}

let server: Server
let drafts: DraftStore
let handle: DraftPersistenceHandle | null = null

/** One tab session: fresh stores, drafts loaded from the shared draft store, `home` opened. */
async function openSession() {
  handle?.dispose()
  setActivePinia(createPinia())
  useSiteStore().$patch({ manifest: { name: 'main' } as never })
  handle = attachDraftPersistence(drafts, () => scope, { debounceMs: 0 })
  await handle.loaded()
  await useSelectionStore().selectPage('home')
  const actions = useEditorActions()
  await actions.openPageRoot()
  return actions
}

/** Someone else saves the page. */
function colleagueSaves() {
  server.etag = `theirs-${++server.writes}`
}

beforeEach(() => {
  drafts = createMemoryDraftStore()
  server = { etag: 'v1', writes: 0 }
  vi.spyOn(api, 'getTemplateSchema').mockResolvedValue({ properties: { title: { type: 'string' } } } as never)
  vi.spyOn(api, 'getPageWithEtag').mockImplementation(
    async () => ({ data: structuredClone(detail), etag: server.etag }) as never,
  )
  vi.spyOn(api, 'updatePage').mockImplementation(async (_name, payload, opts) => {
    if (opts?.ifMatch && opts.ifMatch !== server.etag) throw new StaleSaveError(structuredClone(detail), server.etag)
    if (server.fail?.(payload as Record<string, unknown>)) throw new Error('Internal Server Error')
    server.etag = `ours-${++server.writes}`
    return { ok: true, etag: server.etag } as never
  })
})
afterEach(() => {
  handle?.dispose()
  handle = null
  vi.restoreAllMocks()
})

const edits = {
  content: (actions: ReturnType<typeof useEditorActions>) => actions.markDirty({ title: 'Mine' }),
  structural: (actions: ReturnType<typeof useEditorActions>) =>
    actions.moveComponentStructural({ kind: 'page', name: 'home' }, components, 0, 1),
  metadata: (actions: ReturnType<typeof useEditorActions>) => actions.editMetadata('title', 'Mine'),
}

describe.each(Object.entries(edits))('a restored %s draft', (_lane, edit) => {
  async function leaveDraft() {
    const actions = await openSession()
    edit(actions)
    await handle!.flush()
  }

  it('gets the conflict banner when someone saved the page since', async () => {
    await leaveDraft()
    colleagueSaves()
    const actions = await openSession()
    expect(actions.hasPendingEdits.value).toBe(true)

    expect(await actions.save()).toBe(false)
    expect(useSaveConflictsStore().has(PATH)).toBe(true)
    expect(server.etag).toBe('theirs-1')
  })

  it('saves when the page is unchanged', async () => {
    await leaveDraft()
    const actions = await openSession()

    expect(await actions.save()).toBe(true)
    expect(useSaveConflictsStore().has(PATH)).toBe(false)
  })
})

describe('a draft left by a save that failed part-way', () => {
  it('saves after a reload: the write that landed is the base now', async () => {
    let actions = await openSession()
    edits.content(actions)
    edits.structural(actions)
    server.fail = payload => 'components' in payload
    expect(await actions.save()).toBe(false)
    expect(server.etag).toBe('ours-1')
    await handle!.flush()

    server.fail = undefined
    actions = await openSession()
    expect(actions.hasPendingEdits.value).toBe(true)
    expect(await actions.save()).toBe(true)
    expect(useSaveConflictsStore().has(PATH)).toBe(false)
  })
})

describe('a write on a newer version', () => {
  it("doesn't move a draft made on an older one", async () => {
    let actions = await openSession()
    await actions.openComponent('hero', 'hero')
    actions.markDirty({ title: 'Mine' })
    await handle!.flush()
    colleagueSaves()

    actions = await openSession()
    actions.markDirty({ title: 'Root' })
    expect(await actions.save()).toBe(true)
    await actions.openComponent('hero', 'hero')
    expect(await actions.save()).toBe(false)
    expect(useSaveConflictsStore().has(PATH)).toBe(true)
  })
})

describe('a draft stored with no version recorded', () => {
  it('saves over the current version, as before', async () => {
    await drafts.put(scope, 'edit', 'page:home::_root', {
      key: 'page:home::_root',
      editedContent: { title: 'Mine' },
      updatedAt: '2026-10-01T00:00:00.000Z',
    })
    colleagueSaves()
    const actions = await openSession()

    expect(await actions.save()).toBe(true)
    expect(api.updatePage).toHaveBeenLastCalledWith(
      'home',
      { content: { title: 'Mine' } },
      expect.objectContaining({ ifMatch: 'theirs-1' }),
    )
  })
})
