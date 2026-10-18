/**
 * Unit tests for the active-target store.
 *
 * The store accepts an injected `loadTargets` dependency via `configure()`
 * — no module mocks, no global stubs needed. Target persistence is driven
 * by the URL query param (?target=), not localStorage.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { QueryClient } from '@tanstack/vue-query'
import { createPinia, setActivePinia } from 'pinia'
import type { TargetInfo } from '../src/client/api/client.js'
import { useActiveTargetStore, type LoadTargets } from '../src/client/stores/activeTarget.js'
import { api } from '../src/client/api/client.js'
import { configureReadThrough } from '../src/client/queries/read-through.js'

const TARGETS: TargetInfo[] = [
  { name: 'local', environment: 'local', type: 'static', editable: true, altText: { available: false, auto: false } },
  {
    name: 'staging',
    environment: 'staging',
    type: 'static',
    editable: false,
    altText: { available: false, auto: false },
  },
  {
    name: 'prod',
    environment: 'production',
    type: 'static',
    editable: false,
    altText: { available: false, auto: false },
  },
]

function fixedLoader(list: TargetInfo[]): LoadTargets {
  return async () => list
}

function failingLoader(message: string): LoadTargets {
  return async () => {
    throw new Error(message)
  }
}

beforeEach(() => {
  setActivePinia(createPinia())
})

describe('useActiveTargetStore', () => {
  it('picks the first editable target by default', async () => {
    const store = useActiveTargetStore()
    store.configure({ loadTargets: fixedLoader(TARGETS) })
    await store.load()
    expect(store.activeTargetName).toBe('local')
    expect(store.activeTarget?.environment).toBe('local')
  })

  it('falls back to the first target when none are editable', async () => {
    const readOnly: TargetInfo[] = [
      {
        name: 'staging',
        environment: 'staging',
        type: 'static',
        editable: false,
        altText: { available: false, auto: false },
      },
      {
        name: 'prod',
        environment: 'production',
        type: 'static',
        editable: false,
        altText: { available: false, auto: false },
      },
    ]
    const store = useActiveTargetStore()
    store.configure({ loadTargets: fixedLoader(readOnly) })
    await store.load()
    expect(store.activeTargetName).toBe('staging')
  })

  it('setActiveTarget updates the store', async () => {
    const store = useActiveTargetStore()
    store.configure({ loadTargets: fixedLoader(TARGETS) })
    await store.load()
    store.setActiveTarget('prod')
    expect(store.activeTargetName).toBe('prod')
  })

  it('setActiveTarget throws on unknown target', async () => {
    const store = useActiveTargetStore()
    store.configure({ loadTargets: fixedLoader(TARGETS) })
    await store.load()
    expect(() => store.setActiveTarget('missing')).toThrow(/Unknown target/)
  })

  it('isActiveEditable reflects the active target', async () => {
    const store = useActiveTargetStore()
    store.configure({ loadTargets: fixedLoader(TARGETS) })
    await store.load()
    expect(store.isActiveEditable).toBe(true)
    store.setActiveTarget('prod')
    expect(store.isActiveEditable).toBe(false)
  })

  it('editableTargets and readOnlyTargets partition the list', async () => {
    const store = useActiveTargetStore()
    store.configure({ loadTargets: fixedLoader(TARGETS) })
    await store.load()
    expect(store.editableTargets.map(t => t.name)).toEqual(['local'])
    expect(store.readOnlyTargets.map(t => t.name)).toEqual(['staging', 'prod'])
  })

  it('sets error and leaves state clean when loadTargets fails', async () => {
    const store = useActiveTargetStore()
    store.configure({ loadTargets: failingLoader('boom') })
    await store.load()
    expect(store.error).toBe('boom')
    expect(store.targets).toEqual([])
    expect(store.activeTargetName).toBe(null)
  })

  it('clear() resets state', async () => {
    const store = useActiveTargetStore()
    store.configure({ loadTargets: fixedLoader(TARGETS) })
    await store.load()
    expect(store.activeTargetName).toBe('local')
    store.clear()
    expect(store.targets).toEqual([])
    expect(store.activeTargetName).toBe(null)
    expect(store.error).toBe(null)
  })

  // The router guard runs on every navigation, including the first one,
  // before App.vue's `onMounted` fires `load()`. Without `ensureLoaded`
  // the guard's `?target=staging` lookup hits an empty `targets.value`
  // and `setActiveTarget('staging')` throws — the catch clause silently
  // strips `?target=` from the URL, the indicator stays on `local`, and
  // the e2e test fails. `ensureLoaded` lets the guard await the load
  // before checking. Single-flight semantics ensure App.vue's parallel
  // `load()` doesn't fire a second request.
  it('ensureLoaded loads when the targets list is empty', async () => {
    const store = useActiveTargetStore()
    let calls = 0
    store.configure({
      loadTargets: async () => {
        calls++
        return TARGETS
      },
    })
    await store.ensureLoaded()
    expect(store.targets).toHaveLength(3)
    expect(calls).toBe(1)
  })

  it('ensureLoaded is a no-op when targets are already loaded', async () => {
    const store = useActiveTargetStore()
    let calls = 0
    store.configure({
      loadTargets: async () => {
        calls++
        return TARGETS
      },
    })
    await store.load()
    expect(calls).toBe(1)
    await store.ensureLoaded()
    expect(calls).toBe(1) // didn't refetch
  })

  it('ensureLoaded shares one in-flight load across concurrent callers', async () => {
    const store = useActiveTargetStore()
    let calls = 0
    let resolveLoad!: () => void
    const blocked = new Promise<void>(r => {
      resolveLoad = r
    })
    store.configure({
      loadTargets: async () => {
        calls++
        await blocked
        return TARGETS
      },
    })
    // Two concurrent ensureLoaded calls — the second must reuse the first's promise.
    const a = store.ensureLoaded()
    const b = store.ensureLoaded()
    resolveLoad()
    await Promise.all([a, b])
    expect(calls).toBe(1)
  })

  it('ensureLoaded retries after a previous failure clears error', async () => {
    const store = useActiveTargetStore()
    let attempt = 0
    store.configure({
      loadTargets: async () => {
        attempt++
        if (attempt === 1) throw new Error('first call fails')
        return TARGETS
      },
    })
    // First call fails — error set, targets empty.
    await store.ensureLoaded()
    expect(store.error).toBe('first call fails')
    expect(attempt).toBe(1)
    // Second call must retry because `error` is set (a no-op here
    // would mean "I tried once, that's enough" — wrong shape for a
    // guard that runs on every navigation).
    await store.ensureLoaded()
    expect(store.error).toBe(null)
    expect(store.targets).toHaveLength(3)
    expect(attempt).toBe(2)
  })
})

describe('default loader reads through the query cache (Cut 5b)', () => {
  it('offline: picks the active target from the cached list without calling the API', async () => {
    const client = new QueryClient()
    const cached: TargetInfo[] = [{ name: 'local', editable: true } as TargetInfo]
    client.setQueryData(['targets'], cached)
    configureReadThrough({ client, restored: Promise.resolve(), isOffline: () => true })
    const getTargets = vi.spyOn(api, 'getTargets')
    try {
      setActivePinia(createPinia())
      const store = useActiveTargetStore()
      await store.load()
      expect(store.activeTargetName).toBe('local')
      expect(getTargets).not.toHaveBeenCalled()
    } finally {
      configureReadThrough(null)
      getTargets.mockRestore()
    }
  })
})
