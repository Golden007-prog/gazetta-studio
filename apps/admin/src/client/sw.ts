/// <reference lib="webworker" />
/**
 * Admin service worker — app-shell precache only per
 * `design-offline.md` Cut 11 scope.
 *
 * # What this SW does
 *
 *   - Precaches the admin SPA bundle (HTML/JS/CSS chunks listed in
 *     `self.__WB_MANIFEST` — injected by `vite-plugin-pwa`'s
 *     injectManifest strategy at build time).
 *   - Serves precached responses on cold-load when the network is
 *     unavailable. Without this, an offline cold-load gets "site
 *     can't be reached"; with this, the SPA bundle loads, the L6
 *     `IndexedDBCache` hydrates state, and the app renders.
 *   - Listens for `SKIP_WAITING` messages from the page so the
 *     update-available toast can activate the new SW immediately
 *     when the user clicks "Refresh."
 *
 * # What this SW does NOT do
 *
 *   - Background sync (deferred to v2 — replay queued saves while
 *     the tab is closed; the design-offline.md trade-off says
 *     "authors reopen admin to check sync status; replay-on-next-
 *     open is acceptable v1 UX")
 *   - Push notifications (deferred until `NotificationProvider`
 *     extension surface ships per `design-collaboration.md`)
 *   - Runtime API caching (admin-API responses cache through
 *     `IndexedDBCache` per Cut 2; SW doesn't intercept /api/*)
 *   - PWA install prompt (manifest.webmanifest disabled in
 *     vite.config.ts; v1 is offline-aware, not installable)
 *
 * # SOLID lenses
 *
 *   - SRP: this file owns "precache the app shell + handle update
 *     activation." Cache providers (IndexedDB, MemoryCache fallback)
 *     are siblings; the heartbeat + connection state lives in Pinia
 *     stores; conflict resolution lives in components.
 *   - Future extension: when v2 background sync ships, it lands as
 *     a separate fetch handler in this same file; the precache
 *     plumbing stays.
 */

import { precacheAndRoute, cleanupOutdatedCaches, createHandlerBoundToURL } from 'workbox-precaching'
import { NavigationRoute, registerRoute } from 'workbox-routing'
import { clientsClaim } from 'workbox-core'

declare const self: ServiceWorkerGlobalScope

// Precache the app shell. `__WB_MANIFEST` is replaced by
// vite-plugin-pwa at build time with the build's chunk manifest.
// In dev mode (where the SW doesn't run), the empty array is the
// type-correct fallback.
precacheAndRoute(self.__WB_MANIFEST ?? [])

// Drop precaches from previous SW versions. Without this, every
// release leaves the prior version's chunks in the user's cache
// storage indefinitely. cleanupOutdatedCaches reads the precache
// manifest and removes any cache entry that's not in the current
// build.
cleanupOutdatedCaches()

// Deep links offline. Any admin navigation (/admin/pages/home/edit, ...)
// tries the network first — `gazetta build` rewrites index.html with the
// custom-editor import map, so online the server's copy must win — and
// falls back to the precached shell when the network fails. Paths the
// server answers itself (API, preview iframe, ping, theme) are left alone.
const scope = new URL(self.registration.scope).pathname
const escaped = scope.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
const appShell = createHandlerBoundToURL('index.html')
registerRoute(
  new NavigationRoute(
    async options => {
      try {
        return await fetch(options.request)
      } catch {
        return appShell(options)
      }
    },
    { denylist: [new RegExp(`^${escaped}(api|preview|ping)(/|$)`), new RegExp(`^${escaped}theme\\.css$`)] },
  ),
)

// Take control of any open tabs immediately on activation. Without
// this, the new SW would only control tabs opened AFTER it activated
// — existing tabs would keep using the old SW until reload. With
// it, the user's "Refresh" toast click activates + claims at the
// same time.
clientsClaim()

/**
 * Update flow: the page detects a new SW version (via vite-plugin-pwa
 * + virtual:pwa-register), shows a toast with a "Refresh" action,
 * and on click sends `SKIP_WAITING` to this worker. We respond by
 * skipping the wait phase so the new SW activates immediately.
 *
 * Without skipWaiting, the new SW would sit in the `installed` state
 * until every tab using the old SW closed — which for a long-lived
 * admin tab is forever. The toast → click → skipWaiting handshake
 * gives the user explicit control over the activation moment.
 */
self.addEventListener('message', event => {
  if (event.data && (event.data as { type?: string }).type === 'SKIP_WAITING') {
    self.skipWaiting()
  }
})
