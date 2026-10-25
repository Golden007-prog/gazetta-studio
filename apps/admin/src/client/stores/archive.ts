/**
 * Archive lifecycle store — owns API calls + state for the archive /
 * unarchive / purge / rename modals.
 *
 * Per `design-soft-delete.md` Q7 J1 lock + Cut 10 implementation grilling
 * Q1-Q4: one Pinia store, one mode discriminator, one open/close API.
 * The site-tree's existing dirty-detection + the editor's read-only
 * banner consume the archive state directly from `useSiteStore`'s
 * `PageSummary.archived` field (Cut 7 schema extension).
 *
 * # State machine
 *
 *     idle ──askArchive(item)──▶ archive-confirming ──confirm()──▶ archiving ──ok──▶ idle
 *                                                                       │
 *                                                                       └──error──▶ error
 *     idle ──askPurge(item)──▶ purge-confirming ──confirm()──▶ purging ──ok──▶ idle
 *
 * # SOLID
 *
 *   - SRP: state + API dispatch. UI rendering lives in the SFCs;
 *     side effects (tree refresh, selection clear) live in the
 *     dispatching component. Mirrors the `useAssetsDeleteStore`
 *     pattern for consistency across destructive-op stores.
 *   - DIP: components dispatch actions; don't fetch directly.
 */
import { defineStore } from 'pinia'
import { computed, ref } from 'vue'
import { apiUrl, authHeaders } from '../api/_request.js'

export type ArchiveStatus =
  | 'idle'
  | 'archive-confirming'
  | 'archiving'
  | 'unarchiving'
  | 'purge-confirming'
  | 'purging'
  | 'purge-blocked'
  | 'error'

export type ArchiveDialogVariant = 'hidden' | 'archive-confirm' | 'purge-confirm' | 'purge-blocked' | 'error'

export interface ArchiveTarget {
  kind: 'page' | 'fragment'
  name: string
  /** True when the item is currently archived (drives purge vs archive flow). */
  archived: boolean
  /** Existing alias when the item is archived with an aliasOf. */
  currentAliasOf?: string
}

/** One alias-pointer or live-ref entry in a 409 DELETE_BLOCKED body. */
export interface PurgeBlocker {
  kind: 'page' | 'fragment'
  name: string
}

interface ArchiveSuccess {
  ok: true
  name: string
  archivedAt: string
  aliasOf?: string
}
interface UnarchiveSuccess {
  ok: true
  name: string
}
interface PurgeSuccess {
  ok: true
  name: string
}

export const useArchiveStore = defineStore('archive', () => {
  const status = ref<ArchiveStatus>('idle')
  const item = ref<ArchiveTarget | null>(null)
  const errorMessage = ref<string | null>(null)
  /**
   * Cut 12 — populated when purge returns 409 DELETE_BLOCKED. Drives
   * the PurgeBlockedModal's per-row resolution UX.
   */
  const blockedAliases = ref<PurgeBlocker[]>([])
  const blockedLiveRefs = ref<PurgeBlocker[]>([])

  const dialogVariant = computed<ArchiveDialogVariant>(() => {
    switch (status.value) {
      case 'idle':
        return 'hidden'
      case 'error':
        return 'error'
      case 'archive-confirming':
      case 'archiving':
        return 'archive-confirm'
      case 'purge-confirming':
      case 'purging':
        return 'purge-confirm'
      case 'purge-blocked':
        return 'purge-blocked'
      case 'unarchiving':
        // Unarchive is a one-click action, no confirmation modal.
        return 'hidden'
    }
  })

  /** Open the archive-confirmation modal for a live item. */
  function askArchive(target: ArchiveTarget): void {
    item.value = target
    errorMessage.value = null
    status.value = 'archive-confirming'
  }

  /** Open the purge-confirmation modal (always asks for confirmation). */
  function askPurge(target: ArchiveTarget): void {
    item.value = target
    errorMessage.value = null
    status.value = 'purge-confirming'
  }

  /** Close the dialog. Safe to call from any state. */
  function close(): void {
    status.value = 'idle'
    item.value = null
    errorMessage.value = null
    blockedAliases.value = []
    blockedLiveRefs.value = []
  }

  /**
   * Fire POST /api/{kind}/:name/archive. Resolves true when archive
   * succeeded; false on error (status flips to 'error', errorMessage
   * populated). The 409 ARCHIVE_HAS_LIVE_REFS body surfaces as an
   * error today; Cut 12's resolve modal will handle it specifically.
   */
  async function confirmArchive(opts: { aliasOf?: string }): Promise<boolean> {
    if (!item.value) return false
    status.value = 'archiving'
    try {
      await postArchive(item.value.kind, item.value.name, opts.aliasOf)
      close()
      return true
    } catch (err) {
      errorMessage.value = (err as Error).message
      status.value = 'error'
      return false
    }
  }

  /**
   * Unarchive an archived item. One-click action — no confirmation
   * modal needed. The caller (typically ArchiveBanner) invokes
   * directly; the store transitions through `unarchiving` for the
   * loading state and back to idle on success.
   */
  async function unarchive(target: ArchiveTarget): Promise<boolean> {
    item.value = target
    errorMessage.value = null
    status.value = 'unarchiving'
    try {
      await postUnarchive(target.kind, target.name)
      close()
      return true
    } catch (err) {
      errorMessage.value = (err as Error).message
      status.value = 'error'
      return false
    }
  }

  /**
   * Fire DELETE /api/{kind}/:name/purge. On 409 DELETE_BLOCKED, the
   * store transitions to `purge-blocked` and exposes `blockedAliases`
   * / `blockedLiveRefs` so the PurgeBlockedModal can render the
   * resolution UI. On other errors transitions to `error`.
   */
  async function confirmPurge(opts: { force?: boolean } = {}): Promise<boolean> {
    if (!item.value) return false
    status.value = 'purging'
    try {
      await deletePurge(item.value.kind, item.value.name, opts.force)
      close()
      return true
    } catch (err) {
      if (err instanceof PurgeBlockedError) {
        blockedAliases.value = err.aliases
        blockedLiveRefs.value = err.liveRefs
        status.value = 'purge-blocked'
        return false
      }
      errorMessage.value = (err as Error).message
      status.value = 'error'
      return false
    }
  }

  /**
   * Edit an archive's `aliasOf` field. Used by the PurgeBlockedModal's
   * "Drop alias" action — author drops an alias-pointer's redirect so
   * the purge can proceed. Caller passes `aliasOf: null` to drop.
   */
  async function setAlias(target: PurgeBlocker, aliasOf: string | null): Promise<boolean> {
    try {
      await patchAlias(target.kind, target.name, aliasOf)
      // Refresh the blocker arrays — the alias-pointer that just got
      // dropped is no longer a blocker. Best-effort: re-issue the
      // purge to get fresh blocked arrays.
      return await retryPurge()
    } catch (err) {
      errorMessage.value = (err as Error).message
      return false
    }
  }

  /**
   * Restore (unarchive) one of the alias-pointers. Same idea as
   * setAlias — once unarchived, it's no longer an alias-pointer
   * blocking the purge.
   */
  async function restoreBlocker(target: PurgeBlocker): Promise<boolean> {
    try {
      await postUnarchive(target.kind, target.name)
      return await retryPurge()
    } catch (err) {
      errorMessage.value = (err as Error).message
      return false
    }
  }

  /**
   * Re-issue the purge after resolving a blocker. Returns true when
   * the purge completed; false when the purge is still blocked (the
   * blocked arrays update with the remaining blockers).
   */
  async function retryPurge(): Promise<boolean> {
    if (!item.value) return false
    return confirmPurge()
  }

  return {
    status,
    item,
    errorMessage,
    blockedAliases,
    blockedLiveRefs,
    dialogVariant,
    askArchive,
    askPurge,
    close,
    confirmArchive,
    unarchive,
    confirmPurge,
    setAlias,
    restoreBlocker,
    retryPurge,
  }
})

/**
 * Thrown when DELETE /purge returns 409 DELETE_BLOCKED. The store
 * catches it to transition to `purge-blocked` state with the
 * structured arrays.
 */
class PurgeBlockedError extends Error {
  readonly aliases: PurgeBlocker[]
  readonly liveRefs: PurgeBlocker[]
  constructor(aliases: PurgeBlocker[], liveRefs: PurgeBlocker[]) {
    super(`Purge blocked: ${aliases.length} alias-pointer(s), ${liveRefs.length} live ref(s)`)
    this.name = 'PurgeBlockedError'
    this.aliases = aliases
    this.liveRefs = liveRefs
  }
}

// ─── HTTP wrappers ─────────────────────────────────────────────────────
// Inline rather than parking on `api/client.ts` because the routes are
// archive-specific lifecycle ops, not the page/fragment CRUD shape. Wire
// plumbing (active-target injection via `apiUrl()`, header pass-through
// via `authHeaders()`) lives in `_request.ts` — see its file header for
// why same-origin admin doesn't need `credentials: 'include'`.

async function postArchive(kind: 'page' | 'fragment', name: string, aliasOf?: string): Promise<ArchiveSuccess> {
  const path = `/${kind}s/${encodeURIComponent(name)}/archive`
  const body = aliasOf ? JSON.stringify({ aliasOf }) : undefined
  const res = await fetch(apiUrl(path), {
    method: 'POST',
    headers: authHeaders(body ? { 'Content-Type': 'application/json' } : {}),
    body,
  })
  if (!res.ok) throw await readError(res, `Archive ${kind} "${name}"`)
  return (await res.json()) as ArchiveSuccess
}

async function postUnarchive(kind: 'page' | 'fragment', name: string): Promise<UnarchiveSuccess> {
  const path = `/${kind}s/${encodeURIComponent(name)}/unarchive`
  const res = await fetch(apiUrl(path), {
    method: 'POST',
    headers: authHeaders(),
  })
  if (!res.ok) throw await readError(res, `Unarchive ${kind} "${name}"`)
  return (await res.json()) as UnarchiveSuccess
}

async function deletePurge(kind: 'page' | 'fragment', name: string, force?: boolean): Promise<PurgeSuccess> {
  const qs = force ? '?force=true' : ''
  const path = `/${kind}s/${encodeURIComponent(name)}/purge${qs}`
  const res = await fetch(apiUrl(path), {
    method: 'DELETE',
    headers: authHeaders(),
  })
  if (!res.ok) {
    if (res.status === 409) {
      const body = (await res.json().catch(() => null)) as {
        code?: string
        aliases?: PurgeBlocker[]
        liveRefs?: PurgeBlocker[]
        error?: string
        message?: string
      } | null
      if (body?.code === 'DELETE_BLOCKED') {
        throw new PurgeBlockedError(body.aliases ?? [], body.liveRefs ?? [])
      }
      // Other 409 (e.g., NOT_ARCHIVED) → generic error with the body's
      // reason if present. The archive routes answer with `error`.
      const reason = body?.error ?? body?.message
      throw new Error(`Purge ${kind} "${name}" failed (409)${reason ? `: ${reason}` : ''}`)
    }
    throw await readError(res, `Purge ${kind} "${name}"`)
  }
  return (await res.json()) as PurgeSuccess
}

async function patchAlias(kind: 'page' | 'fragment', name: string, aliasOf: string | null): Promise<void> {
  const path = `/${kind}s/${encodeURIComponent(name)}/alias`
  const res = await fetch(apiUrl(path), {
    method: 'PATCH',
    headers: authHeaders({ 'Content-Type': 'application/json' }),
    body: JSON.stringify({ aliasOf }),
  })
  if (!res.ok) throw await readError(res, `Set alias for ${kind} "${name}"`)
}

async function readError(res: Response, prefix: string): Promise<Error> {
  let detail = ''
  try {
    const body = (await res.json()) as { error?: string; code?: string; message?: string }
    detail = body.message ?? body.error ?? body.code ?? ''
  } catch {
    detail = res.statusText
  }
  return new Error(`${prefix} failed (${res.status})${detail ? `: ${detail}` : ''}`)
}
