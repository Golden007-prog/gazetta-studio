/**
 * Asset list — fetch the list of assets from the active target, cache in
 * memory, expose refresh semantics.
 *
 * Single responsibility: listing. No uploads, no selection, no modal state.
 *
 * Loading semantics:
 * - `loaded` is `false` until the first successful fetch completes
 * - `loading` is `true` only while a fetch is in flight (never overlaps —
 *   concurrent calls are deduped via an in-flight promise, not queued)
 * - `error` holds the last failure message; refresh clears it
 *
 * Injected api (`loadList`) matches the pattern in activeTarget.ts — tests
 * can swap the transport without mocking the api client module.
 */
import { defineStore } from 'pinia'
import { ref, computed } from 'vue'
import type { AssetSummary } from 'gazetta/schema'
import { api } from '../api/client.js'

type LoadAssetList = () => Promise<AssetSummary[]>

export interface AssetsListStoreOptions {
  loadList?: LoadAssetList
}

export const useAssetsListStore = defineStore('assetsList', () => {
  const assets = ref<AssetSummary[]>([])
  const loading = ref(false)
  const loaded = ref(false)
  const error = ref<string | null>(null)

  let inFlight: Promise<void> | null = null
  let loadList: LoadAssetList = () => api.listAssets()

  function configure(options: AssetsListStoreOptions): void {
    if (options.loadList) loadList = options.loadList
  }

  /** Fetch the list. Concurrent calls share the same in-flight promise. */
  async function refresh(): Promise<void> {
    if (inFlight) return inFlight
    loading.value = true
    error.value = null
    inFlight = (async () => {
      try {
        assets.value = await loadList()
        loaded.value = true
      } catch (err) {
        error.value = (err as Error).message
      } finally {
        loading.value = false
        inFlight = null
      }
    })()
    return inFlight
  }

  /** Drop the cache; next refresh refetches. Useful after a target switch. */
  function invalidate(): void {
    assets.value = []
    loaded.value = false
    error.value = null
  }

  /** Count of assets currently known to the store. */
  const count = computed(() => assets.value.length)

  return { assets, loading, loaded, error, count, refresh, invalidate, configure }
})
