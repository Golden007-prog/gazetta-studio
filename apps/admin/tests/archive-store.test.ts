/**
 * Cut 10 MVP — archive store state-machine tests.
 *
 * Pins the locked Pinia store contract: askArchive opens the
 * archive-confirm dialog; askPurge opens purge-confirm; unarchive is
 * a one-click action with no modal; close returns to idle. Tests
 * stub `fetch` to keep the suite hermetic.
 *
 * Per rule 26 (test-isolation paranoia): each test gets a fresh
 * Pinia + a fresh fetch mock.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { useArchiveStore, type ArchiveTarget } from '../src/client/stores/archive.js'
import { setActiveTargetProvider } from '../src/client/api/_request.js'

const fetchMock = vi.fn()

beforeEach(() => {
  setActivePinia(createPinia())
  fetchMock.mockReset()
  // Stub global fetch — the store calls fetch directly via API_BASE.
  vi.stubGlobal('fetch', fetchMock)
})

afterEach(() => {
  // _request.ts active-target provider is module-level; reset to null
  // after every test so cross-test leakage can't masquerade as a passing
  // assertion (rule 26).
  setActiveTargetProvider(null)
})

const live: ArchiveTarget = { kind: 'page', name: 'landing', archived: false }
const archived: ArchiveTarget = { kind: 'page', name: 'old-landing', archived: true, currentAliasOf: 'home' }

describe('useArchiveStore — state machine', () => {
  it('starts in idle / hidden', () => {
    const store = useArchiveStore()
    expect(store.status).toBe('idle')
    expect(store.dialogVariant).toBe('hidden')
    expect(store.item).toBe(null)
  })

  it('askArchive transitions to archive-confirming and surfaces archive-confirm variant', () => {
    const store = useArchiveStore()
    store.askArchive(live)
    expect(store.status).toBe('archive-confirming')
    expect(store.dialogVariant).toBe('archive-confirm')
    expect(store.item).toEqual(live)
  })

  it('askPurge transitions to purge-confirming and surfaces purge-confirm variant', () => {
    const store = useArchiveStore()
    store.askPurge(archived)
    expect(store.status).toBe('purge-confirming')
    expect(store.dialogVariant).toBe('purge-confirm')
    expect(store.item).toEqual(archived)
  })

  it('close from any state returns to idle', () => {
    const store = useArchiveStore()
    store.askArchive(live)
    expect(store.status).toBe('archive-confirming')
    store.close()
    expect(store.status).toBe('idle')
    expect(store.item).toBe(null)
  })
})

describe('useArchiveStore — confirmArchive', () => {
  it('POSTs to /archive with aliasOf and returns true on success', async () => {
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ ok: true, name: 'landing', archivedAt: '2026-05-09T00:00:00Z', aliasOf: 'home' }),
    })
    const store = useArchiveStore()
    store.askArchive(live)
    const ok = await store.confirmArchive({ aliasOf: 'home' })
    expect(ok).toBe(true)
    expect(store.status).toBe('idle') // closed after success
    expect(fetchMock).toHaveBeenCalledOnce()
    const [url, init] = fetchMock.mock.calls[0]
    expect(url).toContain('/pages/landing/archive')
    expect((init as RequestInit).method).toBe('POST')
    expect((init as RequestInit).body).toBe(JSON.stringify({ aliasOf: 'home' }))
  })

  it('POSTs without body when aliasOf is omitted (pure soft-delete)', async () => {
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ ok: true, name: 'landing', archivedAt: '2026-05-09T00:00:00Z' }),
    })
    const store = useArchiveStore()
    store.askArchive(live)
    await store.confirmArchive({})
    const init = fetchMock.mock.calls[0][1] as RequestInit
    expect(init.body).toBeUndefined()
  })

  it('transitions to error on 409 and exposes the error message', async () => {
    fetchMock.mockResolvedValueOnce({
      ok: false,
      status: 409,
      json: async () => ({ code: 'ARCHIVE_HAS_LIVE_REFS', message: 'live refs exist' }),
    })
    const store = useArchiveStore()
    store.askArchive(live)
    const ok = await store.confirmArchive({})
    expect(ok).toBe(false)
    expect(store.status).toBe('error')
    expect(store.errorMessage).toContain('409')
    expect(store.errorMessage).toContain('live refs exist')
  })
})

describe('useArchiveStore — unarchive', () => {
  it('one-click unarchive transitions to unarchiving and back to idle on success', async () => {
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ ok: true, name: 'old-landing' }),
    })
    const store = useArchiveStore()
    const promise = store.unarchive(archived)
    expect(store.status).toBe('unarchiving')
    expect(store.dialogVariant).toBe('hidden') // no modal for unarchive
    const ok = await promise
    expect(ok).toBe(true)
    expect(store.status).toBe('idle')
  })

  it('surfaces error on failure', async () => {
    fetchMock.mockResolvedValueOnce({
      ok: false,
      status: 500,
      json: async () => ({ message: 'storage failure' }),
    })
    const store = useArchiveStore()
    const ok = await store.unarchive(archived)
    expect(ok).toBe(false)
    expect(store.status).toBe('error')
    expect(store.errorMessage).toContain('storage failure')
  })
})

describe('useArchiveStore — confirmPurge', () => {
  it('DELETEs /purge and returns true on success', async () => {
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ ok: true, name: 'old-landing' }),
    })
    const store = useArchiveStore()
    store.askPurge(archived)
    const ok = await store.confirmPurge()
    expect(ok).toBe(true)
    expect(store.status).toBe('idle')
    const [url, init] = fetchMock.mock.calls[0]
    expect(url).toContain('/pages/old-landing/purge')
    expect((init as RequestInit).method).toBe('DELETE')
  })

  it('appends ?force=true when force option is set', async () => {
    fetchMock.mockResolvedValueOnce({ ok: true, json: async () => ({ ok: true, name: 'x' }) })
    const store = useArchiveStore()
    store.askPurge(archived)
    await store.confirmPurge({ force: true })
    const url = fetchMock.mock.calls[0][0] as string
    expect(url).toContain('?force=true')
  })

  it('transitions to purge-blocked on 409 DELETE_BLOCKED with structured arrays', async () => {
    fetchMock.mockResolvedValueOnce({
      ok: false,
      status: 409,
      json: async () => ({
        code: 'DELETE_BLOCKED',
        aliases: [{ kind: 'page', name: 'old-landing' }],
        liveRefs: [{ kind: 'page', name: 'home' }],
      }),
    })
    const store = useArchiveStore()
    store.askPurge(archived)
    const ok = await store.confirmPurge()
    expect(ok).toBe(false)
    expect(store.status).toBe('purge-blocked')
    expect(store.dialogVariant).toBe('purge-blocked')
    expect(store.blockedAliases).toEqual([{ kind: 'page', name: 'old-landing' }])
    expect(store.blockedLiveRefs).toEqual([{ kind: 'page', name: 'home' }])
  })

  it('surfaces the NOT_ARCHIVED reason on purge of a live item (#1341)', async () => {
    fetchMock.mockResolvedValueOnce({
      ok: false,
      status: 409,
      json: async () => ({ code: 'NOT_ARCHIVED', error: 'Page "landing" is not archived - archive it first' }),
    })
    const store = useArchiveStore()
    store.askPurge(live)
    const ok = await store.confirmPurge()
    expect(ok).toBe(false)
    expect(store.status).toBe('error')
    expect(store.errorMessage).toContain('archive it first')
  })
})

describe('useArchiveStore — Cut 12 setAlias + restoreBlocker', () => {
  it('setAlias PATCHes /alias and retries the purge', async () => {
    const store = useArchiveStore()
    store.askPurge(archived)
    // PATCH alias success
    fetchMock.mockResolvedValueOnce({ ok: true, json: async () => ({ ok: true, name: 'old-landing' }) })
    // Retry purge success
    fetchMock.mockResolvedValueOnce({ ok: true, json: async () => ({ ok: true, name: 'old-landing' }) })

    const ok = await store.setAlias({ kind: 'page', name: 'old-landing' }, null)
    expect(ok).toBe(true)
    expect(fetchMock).toHaveBeenCalledTimes(2)
    const [patchUrl, patchInit] = fetchMock.mock.calls[0]
    expect(patchUrl).toContain('/pages/old-landing/alias')
    expect((patchInit as RequestInit).method).toBe('PATCH')
    expect((patchInit as RequestInit).body).toBe(JSON.stringify({ aliasOf: null }))
  })

  it('restoreBlocker POSTs /unarchive and retries the purge', async () => {
    const store = useArchiveStore()
    store.askPurge(archived)
    // POST unarchive success
    fetchMock.mockResolvedValueOnce({ ok: true, json: async () => ({ ok: true, name: 'old-landing' }) })
    // Retry purge success
    fetchMock.mockResolvedValueOnce({ ok: true, json: async () => ({ ok: true, name: 'old-landing' }) })

    const ok = await store.restoreBlocker({ kind: 'page', name: 'old-landing' })
    expect(ok).toBe(true)
    const [unarchUrl, unarchInit] = fetchMock.mock.calls[0]
    expect(unarchUrl).toContain('/pages/old-landing/unarchive')
    expect((unarchInit as RequestInit).method).toBe('POST')
  })

  it('retryPurge after one blocker resolved still surfaces remaining blockers', async () => {
    const store = useArchiveStore()
    store.askPurge(archived)
    // PATCH alias success
    fetchMock.mockResolvedValueOnce({ ok: true, json: async () => ({ ok: true }) })
    // Retry purge — STILL BLOCKED (remaining liveRef)
    fetchMock.mockResolvedValueOnce({
      ok: false,
      status: 409,
      json: async () => ({ code: 'DELETE_BLOCKED', aliases: [], liveRefs: [{ kind: 'page', name: 'still-here' }] }),
    })

    const ok = await store.setAlias({ kind: 'page', name: 'old-landing' }, null)
    expect(ok).toBe(false)
    expect(store.status).toBe('purge-blocked')
    expect(store.blockedAliases).toEqual([])
    expect(store.blockedLiveRefs).toEqual([{ kind: 'page', name: 'still-here' }])
  })
})

/**
 * Wire-level plumbing contract — the archive store's HTTP wrappers must
 * route through `_request.ts`'s `apiUrl()` (active-target injection) and
 * `authHeaders()` (the documented header pass-through seam) like every
 * other admin API module. Without this, an operator with `active=staging`
 * clicks Archive and the server (which reads `c.req.query('target')` and
 * falls back to the default when absent) silently mutates the DEFAULT
 * target instead of staging — a misroute that produces no error and is
 * only visible by inspecting which target ended up dirty.
 *
 * The cited rule is `apps/admin/src/client/api/_request.ts:1-21`'s file
 * header — every API module imports `apiUrl` + `authHeaders` and never
 * builds raw `${API_BASE}/...` URLs.
 */
describe('useArchiveStore — wire-level plumbing (active-target + headers)', () => {
  it('archive POST routes through apiUrl(): URL carries ?target= when active target is set', async () => {
    setActiveTargetProvider(() => 'staging')
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ ok: true, name: 'landing', archivedAt: '2026-05-09T00:00:00Z' }),
    })
    const store = useArchiveStore()
    store.askArchive(live)
    await store.confirmArchive({})
    const url = String(fetchMock.mock.calls[0][0])
    expect(url).toMatch(/[?&]target=staging(?:&|$)/)
  })

  it('unarchive POST routes through apiUrl(): URL carries ?target= when active target is set', async () => {
    setActiveTargetProvider(() => 'production')
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ ok: true, name: 'old-landing' }),
    })
    const store = useArchiveStore()
    await store.unarchive(archived)
    const url = String(fetchMock.mock.calls[0][0])
    expect(url).toMatch(/[?&]target=production(?:&|$)/)
  })

  it('purge DELETE routes through apiUrl(): URL carries ?target= when active target is set', async () => {
    setActiveTargetProvider(() => 'staging')
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ ok: true, name: 'old-landing' }),
    })
    const store = useArchiveStore()
    store.askPurge(archived)
    await store.confirmPurge()
    const url = String(fetchMock.mock.calls[0][0])
    expect(url).toMatch(/[?&]target=staging(?:&|$)/)
  })

  it('purge DELETE preserves ?force=true alongside the injected ?target=', async () => {
    setActiveTargetProvider(() => 'staging')
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ ok: true, name: 'old-landing' }),
    })
    const store = useArchiveStore()
    store.askPurge(archived)
    await store.confirmPurge({ force: true })
    const url = String(fetchMock.mock.calls[0][0])
    expect(url).toContain('force=true')
    expect(url).toMatch(/[?&]target=staging(?:&|$)/)
  })

  it('patchAlias PATCH routes through apiUrl(): URL carries ?target= when active target is set', async () => {
    setActiveTargetProvider(() => 'staging')
    // PATCH alias
    fetchMock.mockResolvedValueOnce({ ok: true, json: async () => ({ ok: true }) })
    // Retry purge (so setAlias resolves cleanly without surfacing as error)
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ ok: true, name: 'old-landing' }),
    })
    const store = useArchiveStore()
    store.askPurge(archived)
    await store.setAlias({ kind: 'page', name: 'old-landing' }, null)
    const patchUrl = String(fetchMock.mock.calls[0][0])
    expect(patchUrl).toMatch(/[?&]target=staging(?:&|$)/)
  })

  it('does not send credentials: "include" on archive (same-origin admin; auth lives in upstream headers, not cookies)', async () => {
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ ok: true, name: 'landing', archivedAt: '2026-05-09T00:00:00Z' }),
    })
    const store = useArchiveStore()
    store.askArchive(live)
    await store.confirmArchive({})
    const init = fetchMock.mock.calls[0][1] as RequestInit
    expect(init.credentials).toBeUndefined()
  })

  it('does not send credentials: "include" on unarchive', async () => {
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ ok: true, name: 'old-landing' }),
    })
    const store = useArchiveStore()
    await store.unarchive(archived)
    const init = fetchMock.mock.calls[0][1] as RequestInit
    expect(init.credentials).toBeUndefined()
  })

  it('does not send credentials: "include" on purge', async () => {
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ ok: true, name: 'old-landing' }),
    })
    const store = useArchiveStore()
    store.askPurge(archived)
    await store.confirmPurge()
    const init = fetchMock.mock.calls[0][1] as RequestInit
    expect(init.credentials).toBeUndefined()
  })

  it('does not send credentials: "include" on patchAlias', async () => {
    fetchMock.mockResolvedValueOnce({ ok: true, json: async () => ({ ok: true }) })
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ ok: true, name: 'old-landing' }),
    })
    const store = useArchiveStore()
    store.askPurge(archived)
    await store.setAlias({ kind: 'page', name: 'old-landing' }, null)
    const init = fetchMock.mock.calls[0][1] as RequestInit
    expect(init.credentials).toBeUndefined()
  })
})
