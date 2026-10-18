import { createApp } from 'vue'
import { createPinia } from 'pinia'
import PrimeVue from 'primevue/config'
import { VueQueryPlugin } from '@tanstack/vue-query'
import App from './App.vue'
import { createRouter } from './router.js'
import { selectBrowserCacheProvider } from './cache/provider-selector.js'
import { createAdminQueryClient, createGazettaClientPersister } from './queries/client.js'
import { createGazettaPersister } from './queries/persister.js'
import { useConnectionState } from './stores/connectionState.js'
import { attachPendingEditsPersistence, attachPersistedEditsPersistence } from './stores/_pendingEditsPersistence.js'
import { useServiceWorkerUpdate } from './composables/useServiceWorkerUpdate.js'
import 'primeicons/primeicons.css'
import './assets/tokens.css'
import './assets/base.css'
import { adminPreset } from './assets/preset.js'

// Async boot: provider selection probes IndexedDB before constructing
// the L6 cache. Vue's createApp is sync but Vue's plugin install can
// run after creation, so we resolve the provider first and feed it
// into the VueQueryPlugin install.
async function bootstrap(): Promise<void> {
  const provider = await selectBrowserCacheProvider()
  const queryClient = createAdminQueryClient()
  const persister = createGazettaPersister(provider.cache)
  const clientPersister = createGazettaClientPersister(persister)

  const app = createApp(App)
  app.use(createPinia())
  app.use(PrimeVue, {
    theme: {
      preset: adminPreset,
      options: { darkModeSelector: '.dark' },
    },
  })
  app.use(VueQueryPlugin, {
    queryClient,
    clientPersister,
  })
  app.use(createRouter())

  // Initialize the connection-state store so it auto-attaches
  // `navigator.onLine` listeners and starts probing /api/health
  // when degraded. Must run after Pinia install + before mount so
  // the first render sees a populated state.
  useConnectionState()

  // Wire pending-edits persistence on top of the L6 cache. Both
  // coordinators run in parallel — independent stores, independent
  // cache keys. Await both hydrations so the first editor render
  // sees structural reorders (Cut 8a) AND restored dirty content
  // (Cut 8b) that survived a previous session.
  const structuralPersistence = attachPendingEditsPersistence(provider.cache)
  const editsPersistence = attachPersistedEditsPersistence(provider.cache)
  await Promise.all([structuralPersistence.hydrated, editsPersistence.hydrated])

  // Register the service worker (production builds only; dev no-op).
  // Surfaces the "new version available" toast when an update lands.
  // Per Cut 11; SW source lives at src/client/sw.ts.
  useServiceWorkerUpdate()

  app.mount('#app')

  // User theme — append AFTER PrimeVue (which injects styles at runtime
  // via app.use(PrimeVue)) so user declarations win the cascade. Must be
  // INSIDE bootstrap and AFTER app.mount() so the order is deterministic
  // even when bootstrap awaits cache + persistence hydration. A static
  // <link> at module scope would race with PrimeVue's runtime injection.
  // The server returns an empty stylesheet when the user has no
  // admin/theme.css, so no onerror handling needed.
  {
    const link = document.createElement('link')
    link.rel = 'stylesheet'
    link.href = '/admin/theme.css'
    document.head.appendChild(link)
  }

  if (provider.degraded) {
    // Surface persistence degradation to operators via console for
    // now; the user-facing banner lands as a Vue component reading
    // a Pinia flag in a later cut. Reason field carries the probe
    // failure for diagnostic logs.
    console.warn(
      `[gazetta] offline persistence unavailable — using in-memory cache. Reason: ${provider.reason ?? 'unknown'}`,
    )
  }
}

void bootstrap()
