/**
 * Sync status — per-target summaries of what's different from the source.
 *
 * For each non-active target, runs the compare API and exposes a compact
 * view: total changed-item count, firstPublish flag, loading, error. Used
 * by the top-bar sync indicators so authors see "staging · 3 behind" at a
 * glance without opening a dialog.
 *
 * Dependencies are injected (compare fn, targets list source) so tests
 * don't need to mock modules — matches the pattern established in R29.
 */

import { defineStore } from 'pinia'
import { ref, computed } from 'vue'
import { api, type CompareResult, type TargetInfo } from '../api/client.js'

export interface SyncStatus {
  /** Total items that differ from source (added + modified + deleted). */
  changedCount: number
  /** Target has no sidecars at all — first publish after migration or empty. */
  firstPublish: boolean
  /** Latest raw compare result, if detail is needed. */
  result: CompareResult
}

export type CompareFn = (target: string, options?: RequestInit) => Promise<CompareResult>
type ListTargetsFn = () => TargetInfo[]
export type ActiveTargetFn = () => string | null

export interface SyncStatusStoreOptions {
  /** Override how we compare; defaults to api.compare. */
  compareFn?: CompareFn
  /** Non-reactive snapshot of known targets. Required. */
  listTargets?: ListTargetsFn
  /** Active target name accessor. Required — we skip compare on the active. */
  activeTarget?: ActiveTargetFn
}

function summarize(result: CompareResult): SyncStatus {
  return {
    changedCount: result.added.length + result.modified.length + result.deleted.length,
    firstPublish: result.firstPublish,
    result,
  }
}

export const useSyncStatusStore = defineStore('syncStatus', () => {
  const statuses = ref(new Map<string, SyncStatus>())
  const loading = ref(new Set<string>())
  const errors = ref(new Map<string, string>())

  let compareFn: CompareFn = (target, options) => api.compare(target, options)
  let listTargets: ListTargetsFn = () => []
  let activeTargetFn: ActiveTargetFn = () => null

  function configure(opts: SyncStatusStoreOptions) {
    if (opts.compareFn) compareFn = opts.compareFn
    if (opts.listTargets) listTargets = opts.listTargets
    if (opts.activeTarget) activeTargetFn = opts.activeTarget
  }

  /** Status for a single target, if loaded. */
  function get(name: string): SyncStatus | null {
    return statuses.value.get(name) ?? null
  }

  function isLoading(name: string): boolean {
    return loading.value.has(name)
  }

  function errorFor(name: string): string | null {
    return errors.value.get(name) ?? null
  }

  /** Targets we should show sync status for — everything except the active. */
  const nonActiveTargets = computed<TargetInfo[]>(() => {
    const active = activeTargetFn()
    return listTargets().filter(t => t.name !== active)
  })

  /** Kick off compare for a single target. Errors are stored, not thrown. */
  async function refreshOne(name: string): Promise<void> {
    // Replace any in-flight fetch for this target.
    const currentLoading = new Set(loading.value)
    currentLoading.add(name)
    loading.value = currentLoading

    errors.value.delete(name)
    errors.value = new Map(errors.value)

    try {
      const result = await compareFn(name)
      const next = new Map(statuses.value)
      next.set(name, summarize(result))
      statuses.value = next
    } catch (err) {
      const nextErrs = new Map(errors.value)
      nextErrs.set(name, (err as Error).message)
      errors.value = nextErrs
    } finally {
      const next = new Set(loading.value)
      next.delete(name)
      loading.value = next
    }
  }

  /** Kick off compare for every non-active target. Awaits all. */
  async function refreshAll(): Promise<void> {
    const targets = nonActiveTargets.value.map(t => t.name)
    await Promise.all(targets.map(name => refreshOne(name)))
  }

  /** Drop any stored status for the given target (e.g., when it becomes active). */
  function invalidate(name: string): void {
    const next = new Map(statuses.value)
    next.delete(name)
    statuses.value = next
    const nextErrs = new Map(errors.value)
    nextErrs.delete(name)
    errors.value = nextErrs
  }

  function clear(): void {
    statuses.value = new Map()
    loading.value = new Set()
    errors.value = new Map()
  }

  return {
    // state
    statuses,
    loading,
    errors,
    // getters
    nonActiveTargets,
    // queries
    get,
    isLoading,
    errorFor,
    // actions
    configure,
    refreshOne,
    refreshAll,
    invalidate,
    clear,
  }
})
