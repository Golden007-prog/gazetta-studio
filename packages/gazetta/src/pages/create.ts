/**
 * Page Create — POST handler logic for `/api/pages`.
 *
 * Different from `savePage`:
 *   - No etag precheck (nothing to compare against; new page)
 *   - No locale variant lookup (creates the default Page Manifest)
 *   - Name conflict resolution per `design-soft-delete.md` Q5 I3:
 *     - Live name in use → typed `LIVE_CONFLICT` outcome
 *     - Archived name in use, no `?onConflict` flag → typed
 *       `ARCHIVED_CONFLICT` outcome with archive details
 *     - Archived name in use, with mode → delegate to
 *       `resolveArchivedNameConflict` (restore / replace / moveAside)
 *   - Folder creation (`storage.mkdir(pageDir)`)
 *   - Initial sidecar wiring (`rebuildAssetRefs` /
 *     `rebuildFragmentDeps` against `null` → empty manifest)
 *   - Cache invalidation (`pages:`)
 *
 * Same as `savePage` for the post-resolution-or-create write itself —
 * eventually creates pass through `saveManifestCore` once the
 * "before is null" path lands. v1 keeps the create-time path
 * separate because it doesn't need validators / hooks / scanner /
 * audit-on-failure (a new empty page has no validation surface to
 * exercise yet).
 *
 * Per Q6 lock: separate `createPage` instead of folding into
 * `savePage` — Create has its own pre-write phase (conflict prompt,
 * mkdir, route derive) that update doesn't. Branchy A would merge
 * two distinct intents.
 */

import { join } from 'node:path'
import {
  resolveArchivedNameConflict,
  type ArchivedNameConflictMode,
  type ArchivedNameConflictResult,
} from '../admin-api/archived-name-conflict.js'
import type { SourceContext } from '../admin-api/source-context.js'
import { rebuildAssetRefs, type ItemRef } from '../assets/asset-deps.js'
import { rebuildFragmentDeps } from '../fragment-deps.js'
import { isManualRedirectArchive } from '../archive-helpers.js'
import { loadSiteFromSource } from '../admin-api/source-context.js'
import type { PageManifest } from '../types.js'
import type { SaveAuditRecorder, SavePrincipal } from '../manifest-save.js'

/**
 * Inputs to `createPage`. The body's already been Zod-validated by
 * the route — caller passes the parsed shape.
 */
export interface CreatePageInput {
  /** Page name (folder name under `pages/`). */
  readonly name: string
  /** Template the new page uses. */
  readonly template: string
  /** Optional initial content; defaults to `{ title: name }` when absent. */
  readonly content?: Record<string, unknown>
  /**
   * `?onConflict` query param: `'restore' | 'replace' | 'moveAside'`
   * or undefined. When undefined and an archived name conflict is
   * detected, returns `ARCHIVED_CONFLICT` so the route prompts the
   * client. When set, delegates to `resolveArchivedNameConflict`.
   */
  readonly onConflict?: string
  /** Source wiring + admin-api SourceContext (for archived-conflict resolver). */
  readonly source: SourceContext
  /** Authenticated principal driving this create. */
  readonly principal: SavePrincipal
  /** Audit recorder bound to the request. */
  readonly audit: SaveAuditRecorder
}

/**
 * Successful create — fresh page or restored-from-archive.
 * `resolution` is set when the create resolved an archive conflict;
 * absent for plain creates.
 */
interface CreatePageOk {
  readonly ok: true
  readonly name: string
  readonly resolution?: ArchivedNameConflictResult['kind']
}

/** Live (non-archived) page already exists at `name`. */
export interface CreatePageLiveConflict {
  readonly ok: false
  readonly code: 'LIVE_CONFLICT'
  readonly name: string
}

/**
 * Archived page exists at `name`. Caller hadn't sent `?onConflict`
 * → return the archive details so the client can prompt
 * Restore / Replace / Move-aside per Soft-Delete Q5 I3.
 */
export interface CreatePageArchivedConflict {
  readonly ok: false
  readonly code: 'ARCHIVED_CONFLICT'
  readonly archive: {
    readonly kind: 'page'
    readonly name: string
    readonly archivedAt?: string
    readonly archivedBy?: string
    readonly aliasOf?: string
    /** True when the archive is a Manual Redirect — restore is refused (#1343). */
    readonly redirect?: boolean
  }
}

/** Caller sent `?onConflict=<unknown>`. Routes project to 400. */
export interface CreatePageInvalidMode {
  readonly ok: false
  readonly code: 'INVALID_CONFLICT_MODE'
  readonly mode: string
}

/** Restore mode targeted a Manual Redirect archive (#1343). */
export interface CreatePageRedirectRestore {
  readonly ok: false
  readonly code: 'REDIRECT_RESTORE'
  readonly name: string
}

export type CreatePageResult =
  | CreatePageOk
  | CreatePageLiveConflict
  | CreatePageArchivedConflict
  | CreatePageInvalidMode
  | CreatePageRedirectRestore

/**
 * Create a Page. Wraps the conflict-resolution decision tree + the
 * fresh-create write path. Routes project the typed `CreatePageResult`
 * to HTTP (200 / 400 / 409).
 */
export async function createPage(input: CreatePageInput): Promise<CreatePageResult> {
  const { source, name, template, content, onConflict, principal, audit } = input
  const { storage } = source
  const pageDir = source.contentRoot.path('pages', name)
  const manifestPath = join(pageDir, 'page.json')

  // Conflict path — manifest already exists at the target name.
  if (await storage.exists(manifestPath)) {
    const site = await loadSiteFromSource(source)
    const existing = site.pages.get(name)
    const isArchived = existing?.archived === true

    if (!isArchived) {
      return { ok: false, code: 'LIVE_CONFLICT', name }
    }

    // Archived conflict, no resolution flag → return structured
    // body so the client can prompt the author per Q5 I3.
    if (!onConflict) {
      return {
        ok: false,
        code: 'ARCHIVED_CONFLICT',
        archive: {
          kind: 'page',
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

    // Archived conflict + mode → delegate to the resolver.
    const result = await resolveArchivedNameConflict({
      source,
      kind: 'page',
      name,
      existing: existing as PageManifest & { dir: string },
      mode: onConflict as ArchivedNameConflictMode,
      newTemplate: template,
      newContent: content,
      actorId: principal.id,
    })
    if (result.kind === 'invalid-mode') {
      return { ok: false, code: 'INVALID_CONFLICT_MODE', mode: onConflict }
    }
    // Manual Redirect targeted by restore (#1343) — routes project to 409.
    if (result.kind === 'redirect-restore') {
      return { ok: false, code: 'REDIRECT_RESTORE', name }
    }
    // Audit one event per logical mode — mirror existing route shape.
    const action: 'unarchive' | 'archive' | 'rename' =
      result.kind === 'restored' ? 'unarchive' : result.kind === 'replaced' ? 'archive' : 'rename'
    await audit.record({
      // The audit recorder's typed shape limits action to save-flow values;
      // the resolver's audit events use the soft-delete vocabulary. Cast
      // through `unknown` keeps the recorder shape narrow without forcing a
      // wider union into the save pipeline's contract.
      action: action as unknown as 'save',
      outcome: 'success',
      scope: { kind: 'page', name },
      metadata: { onConflict },
    })
    await source.cache.invalidatePrefix('pages:')
    return { ok: true, name, resolution: result.kind }
  }

  // Fresh create path — no existing manifest at the target name.
  await storage.mkdir(pageDir)
  const manifest = {
    template,
    content: content ?? { title: name },
    components: [] as unknown[],
  }
  await storage.writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`)

  // Sidecar wiring — fresh manifest has empty components[] so the
  // diff against null is mostly a no-op today; wires the dep tracking
  // for the moment templates ship initial content with `_asset` or
  // `@fragment` refs.
  const item: ItemRef = { source: 'page', name }
  await Promise.all([
    rebuildAssetRefs(source.contentRoot, item, null, manifest),
    rebuildFragmentDeps(source.contentRoot, item, null, manifest),
  ])
  await source.cache.invalidatePrefix('pages:')
  return { ok: true, name }
}
