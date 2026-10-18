import { defineStore } from 'pinia'
import { ref, computed } from 'vue'
import { api, type PageDetail, type FragmentDetail, type PageSummary } from '../api/client.js'
import { useToastStore } from './toast.js'
import { usePreviewStore } from './preview.js'
import { useSiteStore } from './site.js'
import { useLocaleStore } from './locale.js'
import { manifestPath, useEditorEtagsStore } from './editorEtags.js'

/**
 * `locale` is the locale `detail` was loaded for (undefined = default).
 * Writes that save `detail`'s data go back to that locale's file, not
 * to whichever locale is active by the time they run.
 */
export type Selection =
  | { type: 'page'; name: string; detail: PageDetail; locale?: string }
  | { type: 'fragment'; name: string; detail: FragmentDetail; locale?: string }

export const useSelectionStore = defineStore('selection', () => {
  const toast = useToastStore()

  const selection = ref<Selection | null>(null)
  const fragmentHostPage = ref<PageSummary | null>(null)
  let selectController: AbortController | null = null

  // Convenience accessors
  const type = computed(() => selection.value?.type ?? null)
  const name = computed(() => selection.value?.name ?? null)
  const detail = computed(() => selection.value?.detail ?? null)

  /** Pages with static routes (no :params) — usable as fragment preview hosts */
  const staticPages = computed(() => useSiteStore().pages.filter(p => !p.route.includes(':')))

  const previewRoute = computed(() => {
    if (selection.value?.type === 'page') return selection.value.detail.route
    if (selection.value?.type === 'fragment') {
      if (fragmentHostPage.value) return fragmentHostPage.value.route
      return `/@${selection.value.name}`
    }
    return null
  })

  function resolveDefaultHostPage() {
    const pages = staticPages.value
    fragmentHostPage.value = pages.find(p => p.route === '/') ?? pages[0] ?? null
  }

  function setFragmentHostPage(pageName: string) {
    const page = staticPages.value.find(p => p.name === pageName)
    if (page) {
      fragmentHostPage.value = page
      usePreviewStore().invalidate()
    }
  }

  async function selectPage(pageName: string) {
    selectController?.abort()
    selectController = new AbortController()
    const { signal } = selectController
    try {
      const locale = useLocaleStore().effectiveLocale ?? undefined
      // getPageWithEtag captures the save-concurrency etag for the
      // offline save flow per design-offline.md Q3. Stored under the
      // manifest path so the save flow + conflict UX share one
      // source of truth.
      const { data: detail, etag } = await api.getPageWithEtag(pageName, { signal, locale })
      if (etag) useEditorEtagsStore().set(manifestPath('page', pageName, locale), etag)
      selection.value = { type: 'page', name: pageName, detail, locale }
      fragmentHostPage.value = null
      usePreviewStore().invalidate()
    } catch (err) {
      if ((err as Error).name === 'AbortError') return
      toast.showError(err, `Failed to load page "${pageName}"`)
    }
  }

  async function selectFragment(fragName: string) {
    selectController?.abort()
    selectController = new AbortController()
    const { signal } = selectController
    try {
      const locale = useLocaleStore().effectiveLocale ?? undefined
      const { data: detail, etag } = await api.getFragmentWithEtag(fragName, { signal, locale })
      if (etag) useEditorEtagsStore().set(manifestPath('fragment', fragName, locale), etag)
      selection.value = { type: 'fragment', name: fragName, detail, locale }
      if (!fragmentHostPage.value) resolveDefaultHostPage()
      usePreviewStore().invalidate()
    } catch (err) {
      if ((err as Error).name === 'AbortError') return
      toast.showError(err, `Failed to load fragment "${fragName}"`)
    }
  }

  /** Refresh the current selection's detail from the server */
  async function reload() {
    if (!selection.value) return
    try {
      if (selection.value.type === 'page') {
        const { data: detail, etag } = await api.getPageWithEtag(selection.value.name)
        if (etag) useEditorEtagsStore().set(manifestPath('page', selection.value.name), etag)
        selection.value = { type: 'page', name: selection.value.name, detail }
      } else {
        const { data: detail, etag } = await api.getFragmentWithEtag(selection.value.name)
        if (etag) useEditorEtagsStore().set(manifestPath('fragment', selection.value.name), etag)
        selection.value = { type: 'fragment', name: selection.value.name, detail }
      }
    } catch (err) {
      toast.showError(err, 'Failed to reload')
    }
  }

  return {
    selection,
    type,
    name,
    detail,
    previewRoute,
    fragmentHostPage,
    staticPages,
    selectPage,
    selectFragment,
    setFragmentHostPage,
    reload,
  }
})
