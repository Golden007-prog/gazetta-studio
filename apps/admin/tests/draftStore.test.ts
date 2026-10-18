/**
 * Draft store contract, run against both implementations. The store is
 * the only copy of unsaved work, so the properties that matter are
 * isolation (site / owner / target / kind never leak into each other),
 * per-record writes (two tabs don't delete each other's drafts), and an
 * exact owner purge.
 */
import 'fake-indexeddb/auto'
import { describe, expect, it } from 'vitest'
import { createIndexedDBDraftStore } from '../src/client/drafts/idb-draft-store.js'
import { createMemoryDraftStore } from '../src/client/drafts/memory-draft-store.js'
import type { DraftScope, DraftStore } from '../src/client/drafts/types.js'

let counter = 0
const impls: Array<[string, () => Promise<{ open: () => Promise<DraftStore> }>]> = [
  [
    'IndexedDB',
    async () => {
      const dbName = `gazetta-drafts-test-${++counter}`
      return { open: () => createIndexedDBDraftStore({ dbName }) }
    },
  ],
  [
    'memory',
    async () => {
      const store = createMemoryDraftStore()
      return { open: async () => store }
    },
  ],
]

const alice: DraftScope = { site: 'main', owner: 'forwarded-user:alice:editor', target: 'local' }

describe.each(impls)('%s draft store', (_, make) => {
  it('lists what was put, by key', async () => {
    const store = await (await make()).open()
    await store.put(alice, 'edit', 'page:home::hero', { title: 'A' })
    await store.put(alice, 'edit', 'page:about::_root', { title: 'B' })
    expect(new Map(await store.list(alice, 'edit'))).toEqual(
      new Map([
        ['page:home::hero', { title: 'A' }],
        ['page:about::_root', { title: 'B' }],
      ]),
    )
  })

  it('put replaces and delete removes one record only', async () => {
    const store = await (await make()).open()
    await store.put(alice, 'edit', 'k1', { v: 1 })
    await store.put(alice, 'edit', 'k2', { v: 2 })
    await store.put(alice, 'edit', 'k1', { v: 3 })
    await store.delete(alice, 'edit', 'k2')
    await store.delete(alice, 'edit', 'missing')
    expect(await store.list(alice, 'edit')).toEqual([['k1', { v: 3 }]])
  })

  it.each([
    ['site', { ...alice, site: 'other-site' }],
    ['owner', { ...alice, owner: 'forwarded-user:bob:editor' }],
    ['target', { ...alice, target: 'staging' }],
  ] as const)('a different %s sees none of the drafts', async (_dim, other) => {
    const store = await (await make()).open()
    await store.put(alice, 'edit', 'page:home::hero', { title: 'A' })
    expect(await store.list(other, 'edit')).toEqual([])
  })

  it('keeps the two kinds apart', async () => {
    const store = await (await make()).open()
    await store.put(alice, 'edit', 'page:home', { a: 1 })
    await store.put(alice, 'structural', 'page:home', { b: 2 })
    expect(await store.list(alice, 'edit')).toEqual([['page:home', { a: 1 }]])
    expect(await store.list(alice, 'structural')).toEqual([['page:home', { b: 2 }]])
  })

  it("two handles on one database (two tabs) don't delete each other's drafts", async () => {
    const db = await make()
    const tab1 = await db.open()
    const tab2 = await db.open()
    await tab1.put(alice, 'edit', 'page:home::_root', { title: 'tab1' })
    await tab2.put(alice, 'edit', 'page:about::_root', { title: 'tab2' })
    const after = await (await db.open()).list(alice, 'edit')
    expect(after.map(([k]) => k).sort()).toEqual(['page:about::_root', 'page:home::_root'])
  })

  it('purges other owners of the same site only', async () => {
    const store = await (await make()).open()
    const bob = { ...alice, owner: 'forwarded-user:bob:editor' }
    const aliceOtherSite = { ...alice, site: 'other-site' }
    await store.put(alice, 'edit', 'a', { v: 1 })
    await store.put({ ...alice, target: 'staging' }, 'structural', 'a2', { v: 1 })
    await store.put(bob, 'edit', 'b', { v: 2 })
    await store.put({ ...bob, site: 'other-site' }, 'edit', 'b-other', { v: 3 })
    await store.put(aliceOtherSite, 'edit', 'c', { v: 4 })

    expect(await store.purgeOtherOwners({ site: 'main', owner: alice.owner })).toBe(1)

    expect(await store.list(alice, 'edit')).toEqual([['a', { v: 1 }]])
    expect(await store.list({ ...alice, target: 'staging' }, 'structural')).toEqual([['a2', { v: 1 }]])
    expect(await store.list(bob, 'edit')).toEqual([])
    // Other site untouched — including the other owner's draft there.
    expect(await store.list({ ...bob, site: 'other-site' }, 'edit')).toEqual([['b-other', { v: 3 }]])
    expect(await store.list(aliceOtherSite, 'edit')).toEqual([['c', { v: 4 }]])
  })

  it('stores a plain copy, not the live object', async () => {
    const store = await (await make()).open()
    const value = { title: 'before' }
    await store.put(alice, 'edit', 'k', value)
    value.title = 'mutated after put'
    expect(await store.list(alice, 'edit')).toEqual([['k', { title: 'before' }]])
  })

  it('remembers the last identity', async () => {
    const db = await make()
    expect(await (await db.open()).lastIdentity()).toBeNull()
    await (await db.open()).setLastIdentity({ site: 'main', owner: alice.owner })
    expect(await (await db.open()).lastIdentity()).toEqual({ site: 'main', owner: alice.owner })
  })
})
