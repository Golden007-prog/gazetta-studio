import { defineStore } from 'pinia'
import { ref } from 'vue'
import { api, type PageSummary, type FragmentSummary, type SiteManifest } from '../api/client.js'
import { getActiveTarget } from '../api/_request.js'
import { readCached, readThrough } from '../queries/read-through.js'

export const useSiteStore = defineStore('site', () => {
  const manifest = ref<SiteManifest | null>(null)
  const pages = ref<PageSummary[]>([])
  const fragments = ref<FragmentSummary[]>([])
  const loading = ref(false)
  const error = ref<string | null>(null)

  let loadPromise: Promise<void> | null = null

  async function ensureLoaded() {
    if (manifest.value && !error.value) return
    if (loadPromise) return loadPromise
    return load()
  }

  async function load(retries = 5) {
    if (loadPromise) return loadPromise
    loadPromise = doLoad(retries)
    return loadPromise
  }

  async function doLoad(retries = 5) {
    loading.value = true
    error.value = null
    try {
      // Page and fragment lists depend on the target the request carries
      // (none on the very first load, before the target list is known).
      const target = getActiveTarget() ?? '(default)'
      const keys = { site: ['site'], pages: ['pages', target], fragments: ['fragments', target] } as const
      for (let attempt = 0; attempt <= retries; attempt++) {
        try {
          // allowCache false: a cached answer mustn't cut the retry loop short.
          const [site, pageList, fragmentList] = await Promise.all([
            readThrough(keys.site, () => api.getSite(), { allowCache: false }),
            readThrough(keys.pages, () => api.getPages(), { allowCache: false }),
            readThrough(keys.fragments, () => api.getFragments(), { allowCache: false }),
          ])
          manifest.value = site
          pages.value = pageList
          fragments.value = fragmentList
          return
        } catch (err) {
          const msg = (err as Error).message
          if (
            attempt < retries &&
            (msg.includes('502') || msg.includes('Failed to fetch') || msg.includes('not ready'))
          ) {
            await new Promise(r => setTimeout(r, 1000))
            continue
          }
          // Giving up: show the last answer we had, if we have all of it.
          const [site, pageList, fragmentList] = await Promise.all([
            readCached<SiteManifest>(keys.site),
            readCached<PageSummary[]>(keys.pages),
            readCached<FragmentSummary[]>(keys.fragments),
          ])
          if (site && pageList && fragmentList) {
            manifest.value = site
            pages.value = pageList
            fragments.value = fragmentList
            return
          }
          error.value = msg
          return
        }
      }
    } finally {
      loading.value = false
      loadPromise = null // Clear so subsequent load() calls actually re-fetch
    }
  }

  /** Force-refetch site content — used when the active target switches. */
  /** Force-refetch. Keeps current manifest visible until the new one
   *  arrives — otherwise the router-view briefly unmounts (drops the
   *  preview iframe, loses scroll/zoom) on active-target switches. */
  async function reload() {
    loadPromise = null
    return load()
  }

  return { manifest, pages, fragments, loading, error, load, reload, ensureLoaded }
})
