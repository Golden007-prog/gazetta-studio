/**
 * Connection state — 5-state model + hybrid `navigator.onLine` +
 * heartbeat per `design-offline.md` Q2 lock.
 *
 * # States
 *
 *   online        — recent successful request; quiet, no heartbeat
 *   degraded      — `navigator.onLine` false OR a request failed; 5s
 *                   heartbeat to /api/health; subtle "Connection
 *                   unstable" indicator
 *   offline       — N consecutive heartbeat failures; 30s heartbeat;
 *                   persistent "Offline" banner; Vue Query pauses
 *   reconnecting  — heartbeat succeeded after offline; queue replay
 *                   triggers; transition to online
 *
 * # Hybrid logic
 *
 *   - `navigator.onLine` change events → instant signal, but
 *     unreliable (browsers report online when network is broken /
 *     offline when it's fine). Used for instant UX feedback only.
 *   - GET /api/health heartbeat → confirms / corrects. Probes when
 *     state is degraded or offline; quiet when online.
 *
 * # Vue Query coupling
 *
 *   onlineManager.setOnline(state !== 'offline')
 *
 * Vue Query treats `true` as "fetch normally, replay mutations,"
 * `false` as "pause queries, queue mutations." `online` and
 * `reconnecting` and `degraded` all keep Vue Query active —
 * `degraded` is a UI hint, not a Vue Query gate. Only `offline`
 * pauses fetches.
 *
 * # SOLID lenses
 *
 *   - SRP: this store owns connection-state machine + heartbeat
 *     scheduling. Force-sync UI affordance and per-request failure
 *     reporting are public methods, not separate stores — they're
 *     two ways to drive the same state, not two distinct concerns.
 *   - DIP: heartbeat function + onlineManager + clock are injected
 *     via factory options so tests don't need real timers, real
 *     fetch, or real Vue Query.
 *   - OCP: queue replay (Cut 9) hooks via `onReconnect` callback;
 *     adding it doesn't require touching the state machine.
 */
import { defineStore } from 'pinia'
import { computed, onScopeDispose, ref } from 'vue'
import { onlineManager } from '@tanstack/vue-query'
import { API_BASE } from '../api/_request.js'

/** 5 connection states per `design-offline.md` Q2 lock. */
export type ConnectionStatus = 'online' | 'degraded' | 'offline' | 'reconnecting'

/** N heartbeat failures in `degraded` before transition to `offline`. */
const DEGRADED_TO_OFFLINE_THRESHOLD = 3
/** Heartbeat cadence in degraded mode (ms). */
const DEGRADED_HEARTBEAT_MS = 5_000
/** Heartbeat cadence in offline mode (ms). Longer to back off. */
const OFFLINE_HEARTBEAT_MS = 30_000

/**
 * Health endpoint path. Derived from the admin API base so it tracks
 * the mount point: the route lives on the admin app (`/admin/api/health`),
 * not the site root. A bare `/api/health` 404s under `gazetta dev`
 * (#1388) and only "worked" under `gazetta admin` by falling through
 * to the SPA fallback.
 */
const HEALTH_PATH = `${API_BASE}/health`

/**
 * Heartbeat probe contract. Returns true on success, false on
 * failure. Never throws — failures are signal, not exceptions.
 */
type HeartbeatFn = () => Promise<boolean>

/** Default heartbeat — raw fetch without auth wrappers. */
async function defaultHeartbeat(): Promise<boolean> {
  try {
    // No auth headers — heartbeat must work even when auth is
    // broken (token expired, etc.) so the user sees "online" rather
    // than misleading "offline."
    const res = await fetch(HEALTH_PATH, { method: 'GET', cache: 'no-store' })
    return res.ok
  } catch {
    return false
  }
}

export interface ConnectionStateOptions {
  /** Override the heartbeat probe. Tests pass a stub. */
  heartbeatFn?: HeartbeatFn
  /**
   * Disable the auto-installed `navigator.onLine` listeners + the
   * heartbeat scheduler. Tests opt out so they can drive transitions
   * synchronously via the public methods.
   */
  manualMode?: boolean
}

let optionsCache: ConnectionStateOptions = {}

/**
 * Configure the store before its first use. Tests call this with
 * `manualMode: true` to take control of timing. Production code
 * leaves the default (auto-attached listeners + scheduler).
 */
export function configureConnectionState(opts: ConnectionStateOptions): void {
  optionsCache = opts
}

export const useConnectionState = defineStore('connectionState', () => {
  const opts = optionsCache
  const heartbeat = opts.heartbeatFn ?? defaultHeartbeat
  const manualMode = opts.manualMode ?? false

  // Status starts at the navigator's reported state. If the browser
  // says we're offline at boot, jump straight to `degraded` so the
  // first heartbeat probes immediately rather than waiting for the
  // first failure to demote us.
  const status = ref<ConnectionStatus>(typeof navigator !== 'undefined' && !navigator.onLine ? 'degraded' : 'online')
  const consecutiveFailures = ref(0)

  // Scheduled heartbeat handle. Re-set every transition that needs
  // a different cadence.
  let heartbeatHandle: ReturnType<typeof setTimeout> | null = null

  function clearHeartbeat(): void {
    if (heartbeatHandle !== null) {
      clearTimeout(heartbeatHandle)
      heartbeatHandle = null
    }
  }

  function syncVueQuery(): void {
    // Vue Query gate is binary; only `offline` pauses queries.
    onlineManager.setOnline(status.value !== 'offline')
  }

  function scheduleHeartbeat(delayMs: number): void {
    if (manualMode) return
    clearHeartbeat()
    heartbeatHandle = setTimeout(() => {
      void tick()
    }, delayMs)
  }

  /**
   * One heartbeat attempt. Public so tests can drive the scheduler
   * synchronously without touching real timers.
   */
  async function tick(): Promise<void> {
    const ok = await heartbeat()
    if (ok) {
      handleHeartbeatSuccess()
    } else {
      handleHeartbeatFailure()
    }
  }

  function handleHeartbeatSuccess(): void {
    consecutiveFailures.value = 0
    if (status.value === 'offline') {
      // Cleared offline — flag reconnecting so consumers fire queue
      // replay. The transition to `online` happens immediately
      // after; v1 doesn't yet have a queue to drain.
      status.value = 'reconnecting'
      syncVueQuery()
      // Reconnecting → online in the same tick. Cut 9's save queue
      // hook will introduce an awaitable replay step before this
      // transition; for now we just go straight through.
      status.value = 'online'
      syncVueQuery()
    } else if (status.value === 'degraded') {
      // Heartbeat after a transient failure — back to online.
      status.value = 'online'
      syncVueQuery()
    }
    clearHeartbeat()
  }

  function handleHeartbeatFailure(): void {
    consecutiveFailures.value += 1
    if (status.value === 'online' || status.value === 'reconnecting') {
      status.value = 'degraded'
      syncVueQuery()
    } else if (status.value === 'degraded' && consecutiveFailures.value >= DEGRADED_TO_OFFLINE_THRESHOLD) {
      status.value = 'offline'
      syncVueQuery()
    }
    // Schedule the next heartbeat at the cadence for the new state.
    scheduleHeartbeat(status.value === 'offline' ? OFFLINE_HEARTBEAT_MS : DEGRADED_HEARTBEAT_MS)
  }

  /**
   * Report a request failure (network error or server unavailable).
   * Demotes `online` to `degraded` immediately and kicks off a probe.
   * The save / list / etc. caller is the intended consumer; today
   * no caller wires this — Cut 9 (save queue) will be the first.
   */
  function reportFailure(): void {
    if (status.value === 'online') {
      status.value = 'degraded'
      consecutiveFailures.value = 1
      syncVueQuery()
      scheduleHeartbeat(0)
    }
  }

  /**
   * "Send now" affordance from the offline banner. Probes
   * immediately regardless of the scheduled cadence.
   */
  async function probeNow(): Promise<void> {
    clearHeartbeat()
    await tick()
  }

  function onNavigatorOnline(): void {
    // The browser thinks we're back. Don't trust it blindly — probe
    // to confirm. Per Q2: navigator.onLine is "instant UX signal,"
    // not authoritative.
    if (status.value === 'offline' || status.value === 'degraded') {
      void probeNow()
    }
  }

  function onNavigatorOffline(): void {
    // The browser says we're offline. Demote immediately so the UI
    // feels responsive; the heartbeat will confirm.
    if (status.value === 'online' || status.value === 'reconnecting') {
      status.value = 'degraded'
      syncVueQuery()
      scheduleHeartbeat(0)
    }
  }

  // Auto-attach navigator listeners + initial sync unless manualMode.
  if (!manualMode && typeof window !== 'undefined') {
    window.addEventListener('online', onNavigatorOnline)
    window.addEventListener('offline', onNavigatorOffline)
    // Honor initial offline state: schedule a probe so we discover
    // recovery without waiting for a navigator event.
    if (status.value === 'degraded') scheduleHeartbeat(0)
    // Cleanup when the store's effect scope tears down (e.g.
    // setActivePinia in tests). Pinia setup stores run inside an
    // effect scope, so onScopeDispose fires on store disposal.
    onScopeDispose(() => {
      window.removeEventListener('online', onNavigatorOnline)
      window.removeEventListener('offline', onNavigatorOffline)
      clearHeartbeat()
    })
  }

  // Initial Vue Query sync — at boot we're optimistic; if the
  // navigator already says offline, syncVueQuery() runs again above.
  syncVueQuery()

  return {
    status,
    consecutiveFailures,
    isOnline: computed(() => status.value === 'online'),
    isOffline: computed(() => status.value === 'offline'),
    /** True for any state UI should surface (degraded/offline/reconnecting). */
    isAttention: computed(() => status.value !== 'online'),
    tick,
    reportFailure,
    probeNow,
    // Test helpers (intentionally not part of the SRP-clean public
    // API but harmless on the Pinia store object).
    _onNavigatorOnline: onNavigatorOnline,
    _onNavigatorOffline: onNavigatorOffline,
  }
})
