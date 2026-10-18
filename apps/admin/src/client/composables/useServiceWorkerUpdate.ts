/// <reference types="vite-plugin-pwa/client" />
/**
 * Service-worker update flow per `design-offline.md` Cut 11
 * "Update detection UX":
 *
 *   - Boot registers the SW (via vite-plugin-pwa's
 *     `useRegisterSW` virtual module)
 *   - When a new SW version is detected, show a toast: "New version
 *     available — Refresh to update"
 *   - Author clicks "Refresh" → SW activates (skipWaiting) +
 *     reloads the tab
 *
 * The toast uses the existing `useToastStore.show(... { action })`
 * affordance — same UI surface as the post-save Undo prompt and
 * the back-to-previous-target after a target switch. Consistent
 * action affordance, consistent dismiss timing.
 *
 * # SOLID lenses
 *
 *   - SRP: this composable owns "update detection → toast prompt
 *     → activation handshake." It does NOT own the SW source
 *     (sw.ts) or the toast UI (App.vue / Toast.vue).
 *   - DIP: depends on the toast store interface, not on a specific
 *     toast UI component.
 *
 * # Why a composable, not a Pinia store
 *
 * The state is fundamentally tied to vite-plugin-pwa's reactive
 * registration object — the `needRefresh` ref is owned by the
 * plugin. A Pinia store would mirror that ref through another
 * layer for no benefit. Composable is the right shape: imported
 * once, runs side effects (register + watch), no consumer reads
 * its return value.
 *
 * # Production-only
 *
 * Vite's `useRegisterSW` is a no-op in dev because the SW isn't
 * built or registered there. Importing this composable in dev is
 * harmless (no-op subscription) — but the production behavior is
 * the only behavior that matters; it's tested by
 * tests/e2e/production-offline.test.ts (CI job `e2e-prod`).
 */
import { watch } from 'vue'
import { useRegisterSW } from 'virtual:pwa-register/vue'
import { useToastStore } from '../stores/toast.js'

/**
 * Wire up SW registration + update toast. Call once at admin boot
 * AFTER Pinia is installed (so `useToastStore` is resolvable).
 */
export function useServiceWorkerUpdate(): void {
  const { needRefresh, updateServiceWorker } = useRegisterSW({
    immediate: true,
    onRegisteredSW(_swUrl, registration) {
      // Periodic background check for new versions every hour
      // (default for long-lived admin tabs is "wait until next page
      // load" which never happens). 1h cadence gives operators a
      // reasonable upgrade window without polling aggressively.
      if (!registration) return
      setInterval(
        () => {
          // Best-effort — failures don't matter; the next interval
          // will retry. registration.update() returns a Promise we
          // don't need to await.
          void registration.update()
        },
        60 * 60 * 1000,
      )
    },
  })

  const toast = useToastStore()

  // Watch needRefresh; when it flips true, surface the toast with
  // a Refresh action that activates + reloads.
  watch(needRefresh, fresh => {
    if (!fresh) return
    toast.show('A new version is available', {
      type: 'info',
      action: {
        label: 'Refresh',
        handler: async () => {
          // updateServiceWorker(true) sends SKIP_WAITING to the SW
          // and reloads the page once the new SW takes control.
          // Per vite-plugin-pwa v0.13.2+, the boolean arg is unused
          // (reload always happens) but kept for API stability.
          await updateServiceWorker(true)
        },
      },
      // Sticky toast — operator may be mid-edit and want to delay
      // the refresh. The toast hangs around until they click
      // "Refresh" or dismiss.
      duration: 0,
    })
  })
}
