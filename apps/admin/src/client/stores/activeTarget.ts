/**
 * Active target — the single UX spine.
 *
 * Exactly one target is "active" at any moment. Tree, editor, preview, sync
 * indicators, publish defaults all orient around it. The active target can
 * be editable (author can save) or read-only (author can inspect). Switching
 * is cheap and reversible — never a commitment.
 *
 * Persistence: the URL query param `?target=<name>` is the source of truth.
 * The router guard syncs the URL → store on every navigation. No localStorage.
 */

import { defineStore } from 'pinia'
import { ref, computed } from 'vue'
import { api, type TargetInfo } from '../api/client.js'
import { readThrough } from '../queries/read-through.js'

/**
 * How the store obtains its list of targets. Injected so tests (and any
 * future multi-source setups) can swap the transport without mocking the
 * api client module.
 */
export type LoadTargets = () => Promise<TargetInfo[]>

export interface ActiveTargetStoreOptions {
  /** Override how the store loads its target list. Defaults to `api.getTargets()`. */
  loadTargets?: LoadTargets
}

/**
 * Pinia store for the active target. Accepts optional dependencies so tests
 * can wire in their own loaders and persistence without touching module
 * imports. In production both default to api.getTargets + localStorage.
 */
export const useActiveTargetStore = defineStore('activeTarget', () => {
  const targets = ref<TargetInfo[]>([])
  const activeTargetName = ref<string | null>(null)
  const loading = ref(false)
  const error = ref<string | null>(null)

  // Injected dependencies. Default to production wiring; tests (and any
  // future alternative backend) call configure() before load().
  let loadTargetsFn: LoadTargets = () => readThrough(['targets'], () => api.getTargets())

  /** Override the loader — call before load(). */
  function configure(opts: ActiveTargetStoreOptions) {
    if (opts.loadTargets) loadTargetsFn = opts.loadTargets
  }

  /** The default target name (first editable, or first). No ?target= needed in URL for this one. */
  const defaultTargetName = computed(() => pickDefault(targets.value))

  /** The full TargetInfo for the active target, or null if not loaded / not found. */
  const activeTarget = computed<TargetInfo | null>(() => {
    if (!activeTargetName.value) return null
    return targets.value.find(t => t.name === activeTargetName.value) ?? null
  })

  /** Whether the author can write to the active target. */
  const isActiveEditable = computed(() => activeTarget.value?.editable ?? false)

  /** All editable targets, in declaration order. */
  const editableTargets = computed(() => targets.value.filter(t => t.editable))

  /** All read-only targets, in declaration order. */
  const readOnlyTargets = computed(() => targets.value.filter(t => !t.editable))

  /**
   * Pick a sensible default when no saved preference exists:
   * first editable target, or first target, or null.
   */
  function pickDefault(list: TargetInfo[]): string | null {
    const editable = list.find(t => t.editable)
    if (editable) return editable.name
    return list[0]?.name ?? null
  }

  /**
   * In-flight `load()` promise — single-flight so the router guard can
   * await the same promise as App.vue's `onMounted` hook without firing
   * a second request. Cleared when load() finishes.
   */
  let loadPromise: Promise<void> | null = null

  /** Load the list of targets and resolve the active target name. */
  async function load(): Promise<void> {
    if (loadPromise) return loadPromise
    loadPromise = doLoad()
    try {
      await loadPromise
    } finally {
      loadPromise = null
    }
  }

  async function doLoad(): Promise<void> {
    loading.value = true
    error.value = null
    try {
      const list = await loadTargetsFn()
      targets.value = list

      // Pick default — the router guard will override with ?target= if present.
      activeTargetName.value = pickDefault(list)
    } catch (err) {
      error.value = (err as Error).message
      targets.value = []
      activeTargetName.value = null
    } finally {
      loading.value = false
    }
  }

  /**
   * Ensure the target list is loaded before resolving. Idempotent —
   * concurrent callers share one in-flight request. Used by the router
   * guard to make `?target=` resolution work on first navigation
   * (App.vue's `onMounted` may not have fired yet).
   */
  async function ensureLoaded(): Promise<void> {
    if (targets.value.length > 0 && !error.value) return
    return load()
  }

  /** Change the active target. Called by the router guard when ?target= changes. */
  function setActiveTarget(name: string) {
    if (!targets.value.some(t => t.name === name)) {
      throw new Error(`Unknown target: ${name}`)
    }
    activeTargetName.value = name
  }

  /** Reset to the default target (called when URL has no ?target=). */
  function resetToDefault() {
    activeTargetName.value = defaultTargetName.value
  }

  /** Clear the store (e.g., on logout or site switch). */
  function clear() {
    targets.value = []
    activeTargetName.value = null
    loading.value = false
    error.value = null
  }

  return {
    // state
    targets,
    activeTargetName,
    defaultTargetName,
    loading,
    error,
    // getters
    activeTarget,
    isActiveEditable,
    editableTargets,
    readOnlyTargets,
    // actions
    configure,
    load,
    ensureLoaded,
    setActiveTarget,
    resetToDefault,
    clear,
  }
})
