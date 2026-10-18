import { createRouter as createVueRouter, createWebHistory } from 'vue-router'
import EditorView from './components/EditorView.vue'
import DevPlayground from './components/DevPlayground.vue'
import { useSiteStore } from './stores/site.js'
import { useSelectionStore } from './stores/selection.js'
import { useEditingStore } from './stores/editing.js'
import { useUiModeStore } from './stores/uiMode.js'
import { useUnsavedGuardStore } from './stores/unsavedGuard.js'
import { useActiveTargetStore } from './stores/activeTarget.js'
import { useLocaleStore } from './stores/locale.js'

export function createRouter() {
  const base = import.meta.env.BASE_URL || '/'
  const router = createVueRouter({
    history: createWebHistory(base),
    routes: [
      { path: '/', component: EditorView, name: 'home' },
      { path: '/pages/:name', component: EditorView, name: 'page-browse' },
      { path: '/pages/:name/edit', component: EditorView, name: 'page-edit' },
      { path: '/fragments/:name', component: EditorView, name: 'fragment-browse' },
      { path: '/fragments/:name/edit', component: EditorView, name: 'fragment-edit' },
      { path: '/dev', component: DevPlayground, name: 'dev' },
      { path: '/dev/editor/:editor', component: DevPlayground, name: 'dev-editor' },
      { path: '/dev/field/:field', component: DevPlayground, name: 'dev-field' },
      { path: '/:pathMatch(.*)*', redirect: '/' },
    ],
  })

  // --- Persistent query params (locale, target) ---
  // Locale and target are navigation context that survives every route change.
  // We wrap router.push/replace to auto-inject the current values. Callers
  // use plain string pushes ('/pages/home/edit') and the context follows.
  // To REMOVE a param: pass it in the query object (LocalePicker sets
  // locale: undefined; ActiveTargetIndicator sets target explicitly).
  const PERSISTENT_KEYS = ['locale', 'target'] as const
  const _push = router.push.bind(router)
  const _replace = router.replace.bind(router)

  function withPersistentQuery(to: any): any {
    const current = router.currentRoute.value.query
    const preserve: Record<string, string> = {}
    for (const key of PERSISTENT_KEYS) {
      if (current[key]) preserve[key] = current[key] as string
    }
    if (Object.keys(preserve).length === 0) return to

    if (typeof to === 'string') {
      const url = new URL(to, 'http://x')
      for (const [k, v] of Object.entries(preserve)) {
        if (!url.searchParams.has(k)) url.searchParams.set(k, v)
      }
      return url.pathname + url.search + (url.hash || '')
    }
    // Object form: { path, query, hash } or { name, params, query }
    // Only inject keys the caller didn't explicitly provide.
    const query = { ...preserve, ...(to.query ?? {}) }
    // Remove keys explicitly set to undefined (intentional removal)
    for (const k of Object.keys(query)) {
      if (query[k] === undefined || query[k] === null) delete query[k]
    }
    return { ...to, query }
  }

  router.push = ((to: any) => _push(withPersistentQuery(to))) as typeof router.push
  router.replace = ((to: any) => _replace(withPersistentQuery(to))) as typeof router.replace

  router.beforeEach(async (to, from) => {
    const site = useSiteStore()
    await site.ensureLoaded()

    // Skip guard for non-editor routes
    const isDev = (name: string | undefined) => name?.toString().startsWith('dev')
    const isEditorRoute = !isDev(to.name?.toString()) && to.name !== 'home'
    const wasEditorRoute = from.name && !isDev(from.name.toString()) && from.name !== 'home'

    // Unsaved guard — check when leaving a page/fragment with pending edits
    if (wasEditorRoute) {
      const editing = useEditingStore()
      const fromName = from.params.name as string | undefined
      const toName = to.params.name as string | undefined
      const fromType = from.name?.toString().startsWith('page') ? 'page' : 'fragment'
      const toType = to.name?.toString().startsWith('page') ? 'page' : 'fragment'
      const fromEdit = from.name?.toString().endsWith('-edit')
      const toEdit = to.name?.toString().endsWith('-edit')
      const leavingPage = !isEditorRoute || fromName !== toName || fromType !== toType
      const leavingEdit = fromEdit && !toEdit
      const switchingLocale = (from.query.locale as string | undefined) !== (to.query.locale as string | undefined)

      if ((leavingPage || leavingEdit || switchingLocale) && editing.hasPendingEdits) {
        const guard = useUnsavedGuardStore()
        const result = await guard.guard()
        if (result === 'cancel') return false
        // A failed save keeps the edits and stays here; the save already
        // reported why.
        if (result === 'save' && !(await editing.save())) return false
        editing.clear()
      }
    }

    // Sync active target from URL query param.
    // ?target=staging → switch to staging. No ?target= → use default (first editable).
    // Only non-default targets appear in the URL — keeps default URLs clean.
    //
    // Await `ensureLoaded` so the first navigation's `?target=` lookup
    // finds the named target. App.vue's `onMounted` hook also kicks
    // off this load; both call sites share one in-flight promise via
    // single-flight, so awaiting here is cheap on subsequent navigations.
    // Without this, the first navigation runs before the targets list
    // is populated, `setActiveTarget(name)` throws, and the catch
    // clause silently strips `?target=` from the URL.
    const activeTarget = useActiveTargetStore()
    await activeTarget.ensureLoaded()
    const urlTarget = to.query.target as string | undefined
    if (urlTarget) {
      // Strip ?target= if it's the default — keep URLs clean
      if (urlTarget === activeTarget.defaultTargetName) {
        const { target: _, ...rest } = to.query
        return { ...to, query: rest }
      }
      if (urlTarget !== activeTarget.activeTargetName) {
        try {
          activeTarget.setActiveTarget(urlTarget)
        } catch {
          const { target: _, ...rest } = to.query
          return { ...to, query: rest }
        }
      }
    } else if (activeTarget.activeTargetName !== activeTarget.defaultTargetName) {
      // No ?target= — reset to default
      activeTarget.resetToDefault()
    }

    // Sync locale from URL query param
    const localeStore = useLocaleStore()
    const urlLocale = to.query.locale as string | undefined
    localeStore.setLocale(urlLocale ?? null)

    // Hydrate selection from route params
    if (isEditorRoute) {
      const selection = useSelectionStore()
      const uiMode = useUiModeStore()
      const name = to.params.name as string
      const type = to.name?.toString().startsWith('page') ? 'page' : 'fragment'
      const isEdit = to.name?.toString().endsWith('-edit')

      // Select page/fragment if different from current, or if locale changed
      const fromLocale = from.query.locale as string | undefined
      const toLocale = to.query.locale as string | undefined
      if (selection.type !== type || selection.name !== name || fromLocale !== toLocale) {
        if (type === 'page') await selection.selectPage(name)
        else await selection.selectFragment(name)
      }

      // Set mode
      if (isEdit && uiMode.mode !== 'edit') uiMode.enterEdit()
      else if (!isEdit && uiMode.mode === 'edit') uiMode.enterBrowse()
    } else if (to.name === 'home') {
      const uiMode = useUiModeStore()
      if (uiMode.mode === 'edit') uiMode.enterBrowse()
    }
  })

  return router
}
