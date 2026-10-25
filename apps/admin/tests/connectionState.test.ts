/**
 * Verify the 5-state model + transitions per `design-offline.md`
 * Q2 lock. Tests use `manualMode: true` so the scheduler is dormant
 * and we can drive transitions via `tick()` synchronously — no real
 * timers, no real fetch.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { setActivePinia, createPinia } from 'pinia'
import { onlineManager } from '@tanstack/vue-query'
import { configureConnectionState, useConnectionState } from '../src/client/stores/connectionState.js'

describe('default heartbeat health path (#1388)', () => {
  afterEach(() => {
    vi.unstubAllEnvs()
    vi.unstubAllGlobals()
    vi.resetModules()
  })

  it('the default connection check requests /admin/api/health', async () => {
    // The admin bundle is built with --base /admin/, so API_BASE is
    // /admin/api; a bare /api/health 404s under `gazetta dev`.
    vi.stubEnv('BASE_URL', '/admin/')
    vi.resetModules()
    const fetchMock = vi.fn().mockResolvedValue(new Response('{}', { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)
    const { configureConnectionState: configure, useConnectionState: useStore } = await import(
      '../src/client/stores/connectionState.js'
    )
    setActivePinia(createPinia())
    // No heartbeatFn override: the store must use the real default
    // heartbeat against the derived health path.
    configure({ manualMode: true })
    const store = useStore()
    await store.tick()
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(fetchMock.mock.calls[0][0]).toBe('/admin/api/health')
  })
})

describe('useConnectionState — 5-state model', () => {
  let heartbeatResult: boolean

  beforeEach(() => {
    setActivePinia(createPinia())
    heartbeatResult = true
    configureConnectionState({
      manualMode: true,
      heartbeatFn: async () => heartbeatResult,
    })
  })

  afterEach(() => {
    // Reset Vue Query's online flag so tests don't pollute each other.
    onlineManager.setOnline(true)
  })

  it('starts in `online` state when navigator.onLine is true', () => {
    const store = useConnectionState()
    expect(store.status).toBe('online')
    expect(onlineManager.isOnline()).toBe(true)
  })

  it('reportFailure() demotes online → degraded', () => {
    const store = useConnectionState()
    store.reportFailure()
    expect(store.status).toBe('degraded')
    // Vue Query stays online during degraded — it's a UI hint.
    expect(onlineManager.isOnline()).toBe(true)
  })

  it('three consecutive heartbeat failures: online → degraded → offline', async () => {
    const store = useConnectionState()
    heartbeatResult = false

    await store.tick()
    expect(store.status).toBe('degraded')
    await store.tick()
    expect(store.status).toBe('degraded')
    await store.tick()
    expect(store.status).toBe('offline')

    // Vue Query gates only on offline.
    expect(onlineManager.isOnline()).toBe(false)
  })

  it('successful heartbeat from `degraded` returns to `online`', async () => {
    const store = useConnectionState()
    heartbeatResult = false
    await store.tick()
    expect(store.status).toBe('degraded')

    heartbeatResult = true
    await store.tick()
    expect(store.status).toBe('online')
  })

  it('successful heartbeat from `offline` transitions through reconnecting → online', async () => {
    const store = useConnectionState()
    heartbeatResult = false
    await store.tick()
    await store.tick()
    await store.tick()
    expect(store.status).toBe('offline')

    heartbeatResult = true
    await store.tick()
    // V1 has no save queue — reconnecting collapses to online in
    // the same tick. When Cut 9 ships, this assertion changes.
    expect(store.status).toBe('online')
    expect(onlineManager.isOnline()).toBe(true)
  })

  it('consecutiveFailures resets on successful heartbeat', async () => {
    const store = useConnectionState()
    heartbeatResult = false
    await store.tick()
    await store.tick()
    expect(store.consecutiveFailures).toBe(2)

    heartbeatResult = true
    await store.tick()
    expect(store.consecutiveFailures).toBe(0)
  })

  it('reportFailure() is idempotent — multiple calls in degraded stay degraded', () => {
    const store = useConnectionState()
    store.reportFailure()
    store.reportFailure()
    store.reportFailure()
    expect(store.status).toBe('degraded')
    // Doesn't escalate to offline — only consecutive HEARTBEAT
    // failures do that. reportFailure is a kick, not a counter.
    expect(store.consecutiveFailures).toBe(1)
  })

  it('isAttention is true for any non-online state', async () => {
    const store = useConnectionState()
    expect(store.isAttention).toBe(false)
    store.reportFailure()
    expect(store.isAttention).toBe(true)
    heartbeatResult = false
    await store.tick()
    await store.tick()
    expect(store.status).toBe('offline')
    expect(store.isAttention).toBe(true)
  })

  it('navigator offline event demotes online → degraded immediately', () => {
    const store = useConnectionState()
    store._onNavigatorOffline()
    expect(store.status).toBe('degraded')
  })

  it('navigator online event from offline triggers a probe', async () => {
    const store = useConnectionState()
    heartbeatResult = false
    await store.tick()
    await store.tick()
    await store.tick()
    expect(store.status).toBe('offline')

    // The navigator event hands off to probeNow() which awaits the
    // heartbeat. Stub returns success now.
    heartbeatResult = true
    await new Promise(resolve => {
      // probeNow is async; chain a microtask after it resolves.
      void store.probeNow().then(resolve)
    })
    expect(store.status).toBe('online')
  })

  it('probeNow runs the heartbeat regardless of schedule', async () => {
    const store = useConnectionState()
    const heartbeat = vi.fn(async () => true)
    setActivePinia(createPinia())
    configureConnectionState({ manualMode: true, heartbeatFn: heartbeat })
    const store2 = useConnectionState()
    await store2.probeNow()
    expect(heartbeat).toHaveBeenCalledOnce()
  })
})
