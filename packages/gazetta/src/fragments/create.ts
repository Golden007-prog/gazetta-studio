/**
 * Fragment Create — POST handler logic for `/api/fragments`.
 *
 * Peer of `pages/create.ts`. Differs from Page Create in three places:
 *
 *   1. Loader lookup: `site.fragments` (not `site.pages`)
 *   2. No `content` field on the manifest (Fragments don't ship
 *      initial content; templates supply defaults)
 *   3. Cache invalidation hits both `fragments:` AND `pages:` because
 *      Fragment References compose into Page summaries (same diff as
 *      `saveFragment` per Q3 lock)
 *
 * Decision tree is the same as `createPage`:
 *   - Live name in use → `LIVE_CONFLICT`
 *   - Archived name + no flag → `ARCHIVED_CONFLICT` with details
 *   - Archived name + mode → `resolveArchivedNameConflict`
 *   - Otherwise → fresh create
 */

import { join } from 'node:path'
import {
  resolveArchivedNameConflict,
  type ArchivedNameConflictMode,
  type ArchivedNameConflictResult,
} from '../admin-api/archived-name-conflict.js'
import type { SourceContext } from '../admin-api/source-context.js'
import { loadSiteFromSource } from '../admin-api/source-context.js'
import { rebuildAssetRefs, type ItemRef } from '../assets/asset-deps.js'
import { rebuildFragmentDeps } from '../fragment-deps.js'
import { isManualRedirectArchive } from '../archive-helpers.js'
import type { FragmentManifest } from '../types.js'
import type { SaveAuditRecorder, SavePrincipal } from '../manifest-save.js'

/** Inputs to `createFragment`. Body is already Zod-validated by the route. */
export interface CreateFragmentInput {
  /** Fragment name (folder name under `fragments/`). */
  readonly name: string
  /** Template the new fragment uses. */
  readonly template: string
  /** `?onConflict` query param when archived name in use. */
  readonly onConflict?: string
  /** Source wiring + admin-api SourceContext. */
  readonly source: SourceContext
  /** Authenticated principal driving this create. */
  readonly principal: SavePrincipal
  /** Audit recorder bound to the request. */
  readonly audit: SaveAuditRecorder
}

interface CreateFragmentOk {
  readonly ok: true
  readonly name: string
  readonly resolution?: ArchivedNameConflictResult['kind']
}

interface CreateFragmentLiveConflict {
  readonly ok: false
  readonly code: 'LIVE_CONFLICT'
  readonly name: string
}

interface CreateFragmentArchivedConflict {
  readonly ok: false
  readonly code: 'ARCHIVED_CONFLICT'
  readonly archive: {
    readonly kind: 'fragment'
    readonly name: string
    readonly archivedAt?: string
    readonly archivedBy?: string
    readonly aliasOf?: string
    /** True when the archive is a Manual Redirect — restore is refused (#1343). */
    readonly redirect?: boolean
  }
}

interface CreateFragmentInvalidMode {
  readonly ok: false
  readonly code: 'INVALID_CONFLICT_MODE'
  readonly mode: string
}

/** Restore mode targeted a Manual Redirect archive (#1343). */
interface CreateFragmentRedirectRestore {
  readonly ok: false
  readonly code: 'REDIRECT_RESTORE'
  readonly name: string
}

export type CreateFragmentResult =
  | CreateFragmentOk
  | CreateFragmentLiveConflict
  | CreateFragmentArchivedConflict
  | CreateFragmentInvalidMode
  | CreateFragmentRedirectRestore

/**
 * Create a Fragment. Wraps the conflict-resolution decision tree +
 * the fresh-create write path. Routes project the typed
 * `CreateFragmentResult` to HTTP (200 / 400 / 409).
 */
export async function createFragment(input: CreateFragmentInput): Promise<CreateFragmentResult> {
  const { source, name, template, onConflict, principal, audit } = input
  const { storage } = source
  const fragDir = source.contentRoot.path('fragments', name)
  const manifestPath = join(fragDir, 'fragment.json')

  if (await storage.exists(manifestPath)) {
    const site = await loadSiteFromSource(source)
    const existing = site.fragments.get(name)
    const isArchived = existing?.archived === true

    if (!isArchived) {
      return { ok: false, code: 'LIVE_CONFLICT', name }
    }

    if (!onConflict) {
      return {
        ok: false,
        code: 'ARCHIVED_CONFLICT',
        archive: {
          kind: 'fragment',
          name,
          ...(existing?.archivedAt ? { archivedAt: existing.archivedAt } : {}),
          ...(existing?.archivedBy ? { archivedBy: existing.archivedBy } : {}),
          ...(existing?.aliasOf ? { aliasOf: existing.aliasOf } : {}),
          // Manual Redirect archives cannot be restored (#1343) — tell
          // the client so the prompt doesn't offer Restore.
          ...(existing && isManualRedirectArchive(existing) ? { redirect: true } : {}),
        },
      }
    }

    const result = await resolveArchivedNameConflict({
      source,
      kind: 'fragment',
      name,
      existing: existing as FragmentManifest & { dir: string },
      mode: onConflict as ArchivedNameConflictMode,
      newTemplate: template,
      actorId: principal.id,
    })
    if (result.kind === 'invalid-mode') {
      return { ok: false, code: 'INVALID_CONFLICT_MODE', mode: onConflict }
    }
    // Manual Redirect targeted by restore (#1343) — routes project to 409.
    if (result.kind === 'redirect-restore') {
      return { ok: false, code: 'REDIRECT_RESTORE', name }
    }
    const action: 'unarchive' | 'archive' | 'rename' =
      result.kind === 'restored' ? 'unarchive' : result.kind === 'replaced' ? 'archive' : 'rename'
    await audit.record({
      // Same cast posture as `pages/create.ts`: the resolver's audit
      // events use the soft-delete vocabulary; the recorder type is
      // narrow to the save-flow values.
      action: action as unknown as 'save',
      outcome: 'success',
      scope: { kind: 'fragment', name },
      metadata: { onConflict },
    })
    await Promise.all([source.cache.invalidatePrefix('fragments:'), source.cache.invalidatePrefix('pages:')])
    return { ok: true, name, resolution: result.kind }
  }

  // Fresh create — no existing manifest.
  await storage.mkdir(fragDir)
  const manifest = { template, components: [] as unknown[] }
  await storage.writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`)

  const item: ItemRef = { source: 'fragment', name }
  await Promise.all([
    rebuildAssetRefs(source.contentRoot, item, null, manifest),
    rebuildFragmentDeps(source.contentRoot, item, null, manifest),
  ])
  // Fragment writes invalidate both summaries — page summaries reflect
  // resolvable fragment refs.
  await Promise.all([source.cache.invalidatePrefix('fragments:'), source.cache.invalidatePrefix('pages:')])
  return { ok: true, name }
}
