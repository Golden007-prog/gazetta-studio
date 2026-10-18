/**
 * Which drafts a boot may load. A wrong answer either shows one user's
 * unsaved work to another (leak) or deletes work it shouldn't (loss), so
 * each of the three answers is pinned, plus what each does to the store.
 */
import { describe, expect, it } from 'vitest'
import { askIdentity, resolveDraftIdentity } from '../src/client/drafts/identity.js'
import { createMemoryDraftStore } from '../src/client/drafts/memory-draft-store.js'

const ME = { id: 'alice', role: 'editor', trustMode: 'forwarded-user' }
const SITE = { name: 'main' }

/** Fake fetch answering per path suffix. */
function fakeFetch(routes: Record<string, () => Response | Promise<Response>>): typeof fetch {
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input)
    const route = Object.keys(routes).find(suffix => url.endsWith(suffix))
    if (!route) throw new Error(`unexpected ${url}`)
    init?.signal?.throwIfAborted()
    return routes[route]()
  }) as typeof fetch
}
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })

describe('askIdentity', () => {
  it('is known when both answers are valid', async () => {
    const answer = await askIdentity({ fetch: fakeFetch({ '/me': () => json(ME), '/site': () => json(SITE) }) })
    expect(answer).toEqual({ kind: 'known', identity: { site: 'main', owner: 'forwarded-user:alice:editor' } })
  })

  it.each([
    ['/me is 401 (not signed in)', { '/me': () => json({ code: 'UNAUTHENTICATED' }, 401), '/site': () => json(SITE) }],
    [
      'the auth proxy answers with its login page',
      { '/me': () => new Response('<html>Sign in</html>', { status: 200 }), '/site': () => json(SITE) },
    ],
    ['/me lacks a field', { '/me': () => json({ id: 'alice', trustMode: 'x' }), '/site': () => json(SITE) }],
    ['/site lacks a name', { '/me': () => json(ME), '/site': () => json({}) }],
  ])('is unknown when %s', async (_, routes) => {
    expect(await askIdentity({ fetch: fakeFetch(routes) })).toEqual({ kind: 'unknown' })
  })

  it('is offline when the network fails', async () => {
    const down = (() => Promise.reject(new TypeError('Failed to fetch'))) as unknown as typeof fetch
    expect(await askIdentity({ fetch: down })).toEqual({ kind: 'offline' })
  })

  it('is offline when the server does not answer in time', async () => {
    const hang = ((_: unknown, init?: RequestInit) =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(init.signal!.reason))
      })) as typeof fetch
    expect(await askIdentity({ fetch: hang, timeoutMs: 20 })).toEqual({ kind: 'offline' })
  })
})

describe('resolveDraftIdentity', () => {
  const alice = { site: 'main', owner: 'forwarded-user:alice:editor' }
  const bob = { site: 'main', owner: 'forwarded-user:bob:editor' }

  async function storeWithBothDrafts() {
    const store = createMemoryDraftStore()
    await store.put({ ...alice, target: 'local' }, 'edit', 'a', { v: 1 })
    await store.put({ ...bob, target: 'local' }, 'edit', 'b', { v: 2 })
    await store.setLastIdentity(bob)
    return store
  }

  it("known: deletes other owners' drafts and remembers the identity", async () => {
    const store = await storeWithBothDrafts()
    expect(await resolveDraftIdentity(store, { kind: 'known', identity: alice })).toEqual(alice)
    expect(await store.list({ ...bob, target: 'local' }, 'edit')).toEqual([])
    expect(await store.list({ ...alice, target: 'local' }, 'edit')).toEqual([['a', { v: 1 }]])
    expect(await store.lastIdentity()).toEqual(alice)
  })

  it('known, same owner as last time: still purges drafts written by another owner since', async () => {
    const store = await storeWithBothDrafts()
    await store.setLastIdentity(alice)
    await resolveDraftIdentity(store, { kind: 'known', identity: alice })
    expect(await store.list({ ...bob, target: 'local' }, 'edit')).toEqual([])
  })

  it('offline: loads the last online identity and deletes nothing', async () => {
    const store = await storeWithBothDrafts()
    expect(await resolveDraftIdentity(store, { kind: 'offline' })).toEqual(bob)
    expect(await store.list({ ...alice, target: 'local' }, 'edit')).toHaveLength(1)
  })

  it('offline with no previous online boot: loads nothing', async () => {
    expect(await resolveDraftIdentity(createMemoryDraftStore(), { kind: 'offline' })).toBeNull()
  })

  it('unknown: loads nothing and deletes nothing', async () => {
    const store = await storeWithBothDrafts()
    expect(await resolveDraftIdentity(store, { kind: 'unknown' })).toBeNull()
    expect(await store.list({ ...alice, target: 'local' }, 'edit')).toHaveLength(1)
    expect(await store.list({ ...bob, target: 'local' }, 'edit')).toHaveLength(1)
    expect(await store.lastIdentity()).toEqual(bob)
  })
})
