/**
 * Archive / unarchive / purge routes for pages + fragments.
 *
 * Per `design-soft-delete.md`'s Cut 5 lock and the implementation
 * grilling Q1 (one `archive.ts` module mounting both kinds): the
 * lifecycle is the same shape for pages and fragments; the only
 * axis that differs is the manifest filename + ItemRef source.
 * Co-locating keeps "what does the archive lifecycle do?" answerable
 * by reading one file.
 *
 * # The six routes
 *
 *   POST   /api/pages/:name/archive       (capability: delete:pages)
 *   POST   /api/pages/:name/unarchive     (capability: edit:pages)
 *   DELETE /api/pages/:name/purge         (capability: delete:pages)
 *   POST   /api/fragments/:name/archive   (capability: delete:fragments)
 *   POST   /api/fragments/:name/unarchive (capability: edit:fragments)
 *   DELETE /api/fragments/:name/purge     (capability: delete:fragments)
 *
 * Capability assignment per implementation Q6 (locked F1): archive +
 * purge are delete-class; unarchive is edit-class. Symmetric authority
 * (delete-class to remove from production; edit-class to bring back).
 *
 * # Direct write, own pipeline (Q2 lock B1)
 *
 * Archive is a lifecycle event, not a content edit. Don't reuse the
 * PUT pipeline — it would fire `beforeSave` / `afterSave` hooks built
 * for content saves and run save-delta validation against the full
 * schema. Archive flips a manifest field; the audit `action` is
 * `archive` / `unarchive` / `purge`, NOT `save`.
 *
 * # Existing dep-sidecars untouched on archive (Q3 lock C1)
 *
 * Archived items keep their `asset-refs` and `fragment-deps` sidecars.
 * An archive still references its assets / fragments — that's why an
 * asset-purge attempt finds it. Tearing down on archive (and rebuilding
 * on unarchive) would silently break refs whenever an asset got purged
 * during the archive window. Tear-down happens on PURGE only.
 *
 * # `archive-aliases` reverse index (Cut 5a)
 *
 * Cut 5a shipped `archive-aliases.ts` — a per-edge sidecar at
 * `.gazetta/alias-targets/{aliasTarget}/{encoded-source-item}`. The
 * archive route writes it on archive-with-aliasOf. The purge route no
 * longer reads it: the index is derived state and isn't committed, so
 * a fresh clone or a `git pull` can leave it missing or stale (#1139).
 * The purge-blocked check finds aliasing archives from the loaded site
 * instead — an in-memory pass with no storage reads.
 *
 * # Purge-blocked: one 409 with both arrays (Q4 lock D1)
 *
 *   { code: 'DELETE_BLOCKED', aliases: [...], liveRefs: [...] }
 *
 * One 409, both arrays present. Surfaces every blocker in one
 * round-trip; lets the author resolve in any order. UI gets one panel
 * to render. Empty array when that class isn't blocking.
 *
 * # `?force=true` bypass (Q5 lock E1)
 *
 * Bypasses BOTH alias-pointers AND live-refs. One mental model — "I am
 * an operator overriding the safety check." Audit records what was
 * bypassed (`metadata.bypassedAliases` + `metadata.bypassedRefs`) so
 * forensics finds what broke. Validators surface dangling aliases on
 * the next save (P3); render emits 404 / errors on broken refs.
 *
 * # SOLID lenses
 *
 *   - SRP: this module owns the archive lifecycle. Doesn't touch the
 *     PUT pipeline (Q2 B1); doesn't touch dep-sidecars on archive
 *     (Q3 C1). Each function answers one question.
 *   - DIP: routes consume `SourceContextResolver` like every other
 *     route module; archive primitives consume the typed `ItemKind`
 *     parameter rather than branching on URL shape inside helpers.
 */
import { Hono } from 'hono'
import type { Context } from 'hono'
import { join } from 'node:path'
import type { SourceContextResolver } from '../source-context.js'
import { loadSiteFromSource } from '../source-context.js'
import { recordWrite } from '../../history-recorder.js'
import { requireCapability } from '../middleware/capability.js'
import { requireEditableTarget } from '../middleware/editable-target.js'
import { lookupManifest } from '../lookup-manifest.js'
import type { AuditEnv } from '../middleware/audit.js'
import type { ItemRef } from '../../dep-sidecars.js'
import type { Site } from '../../site-loader.js'
import { findArchivesAliasingInSite, findFragmentUsersInSite } from '../../site-users.js'
import { rebuildArchiveAliases } from '../../archive-aliases.js'
import { isManualRedirectArchive, REDIRECT_RESTORE_MESSAGE } from '../../archive-helpers.js'
import { rebuildAssetRefs } from '../../assets/asset-deps.js'
import { rebuildFragmentDeps } from '../../fragment-deps.js'
import {
  type AliasPointer,
  type ArchiveHasLiveRefs,
  type ArchiveResponse,
  ArchiveRequestSchema,
  type LiveRef,
  type PurgeBlocked,
  type PurgeNotArchived,
  type PurgeResponse,
  type SetAliasResponse,
  SetAliasRequestSchema,
  type UnarchiveResponse,
} from '../schemas/archive.js'
import type { ComponentManifest, FragmentManifest, PageManifest } from '../../types.js'
import {
  archiveReviewMetadata,
  buildAutoWithdrawEvent,
  resetReviewStateForItem,
  stripReviewStateForRestore,
} from './archive-review.js'

type ItemKind = 'page' | 'fragment'

export interface ItemHandle {
  /** ItemRef source axis (`page` | `fragment`); used for sidecar lookup. */
  refSource: ItemRef['source']
  /** The audit + scope kind. Same value as `refSource`; named for clarity. */
  scopeKind: ItemKind
  /** Manifest filename (`page.json` or `fragment.json`). */
  filename: string
  /** Verbose name used in error messages. */
  label: string
}

export const PAGE_HANDLE: ItemHandle = {
  refSource: 'page',
  scopeKind: 'page',
  filename: 'page.json',
  label: 'Page',
}

export const FRAGMENT_HANDLE: ItemHandle = {
  refSource: 'fragment',
  scopeKind: 'fragment',
  filename: 'fragment.json',
  label: 'Fragment',
}

/**
 * Background-scanner notification options for the archive lifecycle.
 *
 * Every archive transition (archive / unarchive / purge / setAlias)
 * is a manifest write — it must notify the validation scanner so
 * background-stage validators (P1: `referenced-archived-without-alias`,
 * P2: `dangling-alias`, P5: `aliasof-points-to-archived`) re-run on
 * the affected item and clear stale cache entries.
 *
 * Same shape as `manifest-save.ts`'s `scanner.rescan(cause)` call;
 * fire-and-forget — the route response doesn't block on scanner work.
 * Cross-foundation gap #6 from `testing-plan.md` punch list.
 */
export interface ArchiveRoutesOptions {
  scanner?: import('../../validation/scanner.js').ValidationScanner | null
}

export function archiveRoutes(resolve: SourceContextResolver, opts: ArchiveRoutesOptions = {}) {
  const editableTarget = requireEditableTarget(resolve)
  const app = new Hono<AuditEnv>()
  const scanner = opts.scanner ?? null

  // ─── Pages ────────────────────────────────────────────────────────
  app.post('/api/pages/:name/archive', requireCapability('delete:pages'), editableTarget, c =>
    handleArchive(c, resolve, PAGE_HANDLE, scanner),
  )
  app.post('/api/pages/:name/unarchive', requireCapability('edit:pages'), editableTarget, c =>
    handleUnarchive(c, resolve, PAGE_HANDLE, scanner),
  )
  app.delete('/api/pages/:name/purge', requireCapability('delete:pages'), editableTarget, c =>
    handlePurge(c, resolve, PAGE_HANDLE, scanner),
  )
  // Cut 12 — edit an archive's aliasOf (set / drop) from the
  // purge-blocked resolution modal. Capability `edit:` since this is
  // a content-state edit, not destruction (symmetric with unarchive).
  app.patch('/api/pages/:name/alias', requireCapability('edit:pages'), editableTarget, c =>
    handleSetAlias(c, resolve, PAGE_HANDLE, scanner),
  )

  // ─── Fragments ────────────────────────────────────────────────────
  app.post('/api/fragments/:name/archive', requireCapability('delete:fragments'), editableTarget, c =>
    handleArchive(c, resolve, FRAGMENT_HANDLE, scanner),
  )
  app.post('/api/fragments/:name/unarchive', requireCapability('edit:fragments'), editableTarget, c =>
    handleUnarchive(c, resolve, FRAGMENT_HANDLE, scanner),
  )
  app.delete('/api/fragments/:name/purge', requireCapability('delete:fragments'), editableTarget, c =>
    handlePurge(c, resolve, FRAGMENT_HANDLE, scanner),
  )
  app.patch('/api/fragments/:name/alias', requireCapability('edit:fragments'), editableTarget, c =>
    handleSetAlias(c, resolve, FRAGMENT_HANDLE, scanner),
  )

  return app
}

/**
 * Fire-and-forget: notify the scanner that a manifest write happened
 * for `handle.scopeKind` named `name`. Mirrors `manifest-save.ts`'s
 * scanner.rescan() call site shape.
 */
function notifyScanner(
  scanner: import('../../validation/scanner.js').ValidationScanner | null,
  handle: ItemHandle,
  name: string,
): void {
  if (!scanner) return
  const root = handle.scopeKind === 'page' ? 'pages' : 'fragments'
  const itemPath = `${root}/${name}/${handle.filename}`
  void scanner.rescan({
    kind: 'manifest',
    item: { kind: handle.scopeKind, name, itemPath },
  })
}

// ─── Archive ───────────────────────────────────────────────────────────

export async function handleArchive(
  c: Context<AuditEnv>,
  resolve: SourceContextResolver,
  handle: ItemHandle,
  scanner: import('../../validation/scanner.js').ValidationScanner | null = null,
) {
  const name = c.req.param('name')
  if (!name) return c.json({ error: 'Missing name parameter' }, 400)
  const source = await resolve(c.req.query('target'))
  const site = await loadSiteFromSource(source)

  const manifest = lookupManifest(site, handle.scopeKind, name)
  if (!manifest) return c.json({ error: `${handle.label} "${name}" not found` }, 404)

  // Schema-validate body — same MCP discipline as other admin-API
  // routes. `aliasOf` is optional; absence = pure soft-delete.
  let body: unknown = {}
  try {
    body = await c.req.json()
  } catch {
    // Empty body is fine (archive without aliasOf). Hono returns null
    // for empty body, JSON.parse throws on empty string — catch and
    // fall through.
  }
  const parsed = ArchiveRequestSchema.safeParse(body ?? {})
  if (!parsed.success) {
    return c.json(
      {
        error: 'Invalid request body',
        issues: parsed.error.issues.map(i => ({ path: i.path.join('.'), message: i.message })),
      },
      400,
    )
  }
  const aliasOf = parsed.data.aliasOf
  const force = c.req.query('force') === 'true'

  // P8 (save-handler check per design-soft-delete.md Q11): refuse
  // archive without aliasOf when live refs exist. Pure soft-delete
  // (no aliasOf) renders 410 / fragment-render error — silently
  // breaking any live reference. Author resolves by setting aliasOf
  // OR removing live refs. Admin `?force=true` bypasses; audit
  // records the bypass per Q5 E1 lock.
  //
  // Only fragments can be referenced from other items today (pages
  // can't be embedded). Pages get the check trivially-pass.
  if (!aliasOf && !force && manifest.archived !== true) {
    const liveRefs = collectLiveRefs(handle, site, name)
    if (liveRefs.length > 0) {
      const blocked: ArchiveHasLiveRefs = { code: 'ARCHIVE_HAS_LIVE_REFS', liveRefs }
      return c.json(blocked, 409)
    }
  }

  // Already archived? Idempotent — return current state. Avoids
  // double-emitting the audit event and double-writing the sidecar.
  if (manifest.archived === true) {
    const response: ArchiveResponse = {
      ok: true,
      name,
      archivedAt: manifest.archivedAt ?? new Date().toISOString(),
      ...(manifest.aliasOf ? { aliasOf: manifest.aliasOf } : {}),
    }
    return c.json(response)
  }

  // Build the post-archive manifest. Per Q1 lock A1: archive fields
  // are additive on the existing manifest; content + components stay
  // intact so unarchive restores them as-is.
  const principal = c.var.principal
  const archivedAt = new Date().toISOString()
  const archived: ComponentManifest = {
    ...manifest,
    archived: true,
    archivedAt,
    archivedBy: principal.id,
  }
  if (aliasOf) archived.aliasOf = aliasOf

  await writeManifest(source, handle, name, archived, manifest)

  // Write the archive-aliases sidecar (Cut 5a). The relation's
  // `extract` returns `{aliasOf}` only when archived === true AND
  // aliasOf is a non-empty string — so this call is correct whether
  // aliasOf was passed or not.
  const itemRef: ItemRef = { source: handle.refSource, name }
  await rebuildArchiveAliases(source.contentRoot, itemRef, manifest, archived)

  // Existing dep-sidecars (asset-refs, fragment-deps) are NOT touched
  // here per Q3 lock C1. The archive still references its assets +
  // fragments; that's why a future asset-purge will find the archive
  // and refuse cleanly. Tear-down happens on PURGE only.

  await Promise.all([
    source.cache.invalidatePrefix(`${handle.scopeKind}s:`),
    handle.scopeKind === 'fragment' ? source.cache.invalidatePrefix('pages:') : Promise.resolve(),
  ])
  // Audit metadata captures aliasOf and (when force bypass) the live
  // refs the operator overrode — forensics finds the broken refs
  // through the bypass list per Q5 E1 audit shape.
  // Cut 14 (fixed in #1344): also capture priorReviewState if the
  // item has a review sidecar in a non-draft state.
  const archiveMetadata: Record<string, unknown> = {
    ...(await archiveReviewMetadata(source.contentRoot, handle.scopeKind, name)),
  }
  if (aliasOf) archiveMetadata.aliasOf = aliasOf
  if (force) {
    archiveMetadata.forced = true
    const bypassedRefs = collectLiveRefs(handle, site, name)
    if (bypassedRefs.length > 0) archiveMetadata.bypassedRefs = bypassedRefs
  }
  // Cut 14 (fixed in #1344): when archiving an item whose review
  // sidecar is `pending-review`, emit the synthetic `review-withdraw`
  // event FIRST per design-soft-delete.md Q9 N-A.2. Approved state (no
  // synthetic withdraw) is captured via priorReviewState on the archive
  // event itself. No sidecar means draft: returns null, a no-op.
  const withdrawEvent = await buildAutoWithdrawEvent(source.contentRoot, handle.scopeKind, name)
  if (withdrawEvent) {
    await c.var.audit.record(withdrawEvent)
  }
  await c.var.audit.record({
    action: 'archive',
    outcome: 'success',
    scope: { kind: handle.scopeKind, name },
    metadata: Object.keys(archiveMetadata).length > 0 ? archiveMetadata : undefined,
  })
  // #1344: the archive consumed the item's review state (auto-withdraw
  // event and/or priorReviewState metadata carry the forensic record);
  // reset it to draft so a later restore starts clean per Q9 N-B.1.
  await resetReviewStateForItem(source.contentRoot, handle.scopeKind, name)
  // Background-stage validators (P1, P5) re-run on the archived item.
  // Fire-and-forget per `manifest-save.ts` shape; the scanner emits
  // its own SSE event when the pass completes.
  notifyScanner(scanner, handle, name)

  const response: ArchiveResponse = { ok: true, name, archivedAt, ...(aliasOf ? { aliasOf } : {}) }
  return c.json(response)
}

// ─── Unarchive ─────────────────────────────────────────────────────────

async function handleUnarchive(
  c: Context<AuditEnv>,
  resolve: SourceContextResolver,
  handle: ItemHandle,
  scanner: import('../../validation/scanner.js').ValidationScanner | null = null,
) {
  const name = c.req.param('name')
  if (!name) return c.json({ error: 'Missing name parameter' }, 400)
  const source = await resolve(c.req.query('target'))
  const site = await loadSiteFromSource(source)

  const manifest = lookupManifest(site, handle.scopeKind, name)
  if (!manifest) return c.json({ error: `${handle.label} "${name}" not found` }, 404)

  // Already live? Idempotent — same rationale as archive's idempotent
  // branch.
  if (manifest.archived !== true) {
    const response: UnarchiveResponse = { ok: true, name }
    return c.json(response)
  }

  // A Manual Redirect's manifest carries only archive fields + aliasOf —
  // restoring would strip them and write `{}`, losing the redirect
  // (#1343). Refuse; delete the redirect or change where it points.
  if (isManualRedirectArchive(manifest)) {
    return c.json({ error: REDIRECT_RESTORE_MESSAGE }, 409)
  }

  // Strip the archive fields. Per Q6 lock D1: unarchive = flip the bit.
  // Content + components unchanged from archive time.
  // Cut 14: also strip `reviewState` per design-soft-delete.md Q9 N-B.1
  // (restore always to draft). Manifests never carry the field today;
  // the strip is defensive. The real state lives in the review sidecar
  // and is reset below (#1344).
  const restored: ComponentManifest = stripReviewStateForRestore(stripArchiveFields(manifest))

  await writeManifest(source, handle, name, restored, manifest)

  // #1344: reset the review sidecar so the restored item is in draft
  // per Q9 N-B.1, regardless of the state it had when archived.
  await resetReviewStateForItem(source.contentRoot, handle.scopeKind, name)

  // Tear down the archive-aliases sidecar — `extract` on a live manifest
  // returns the empty set, so the diff cleans up.
  const itemRef: ItemRef = { source: handle.refSource, name }
  await rebuildArchiveAliases(source.contentRoot, itemRef, manifest, restored)

  await Promise.all([
    source.cache.invalidatePrefix(`${handle.scopeKind}s:`),
    handle.scopeKind === 'fragment' ? source.cache.invalidatePrefix('pages:') : Promise.resolve(),
  ])
  await c.var.audit.record({
    action: 'unarchive',
    outcome: 'success',
    scope: { kind: handle.scopeKind, name },
  })
  // Background-stage validators re-run on the restored item — clears
  // stale archive-related issues from the scanner cache.
  notifyScanner(scanner, handle, name)

  const response: UnarchiveResponse = { ok: true, name }
  return c.json(response)
}

// ─── Set alias (Cut 12) ────────────────────────────────────────────────

/**
 * Edit an existing archive's `aliasOf` field. Set to a string to
 * point at a different live target; set to null to drop the alias
 * (pure soft-delete).
 *
 * Per Cut 12 grilling Q4 D1'': dedicated PATCH endpoint matches the
 * archive route family pattern. Only valid on archived items — live
 * items return 409 since their `aliasOf` is meaningless.
 *
 * Audit: emits `archive` action with `metadata.aliasEdited: true` so
 * forensics can distinguish alias-edits from initial archives.
 */
async function handleSetAlias(
  c: Context<AuditEnv>,
  resolve: SourceContextResolver,
  handle: ItemHandle,
  scanner: import('../../validation/scanner.js').ValidationScanner | null = null,
) {
  const name = c.req.param('name')
  if (!name) return c.json({ error: 'Missing name parameter' }, 400)
  const source = await resolve(c.req.query('target'))
  const site = await loadSiteFromSource(source)

  const manifest = lookupManifest(site, handle.scopeKind, name)
  if (!manifest) return c.json({ error: `${handle.label} "${name}" not found` }, 404)

  if (manifest.archived !== true) {
    return c.json({ error: `${handle.label} "${name}" is not archived; cannot set alias on a live item` }, 409)
  }

  // Schema-validate body. `aliasOf: null` is the canonical "drop" form.
  let raw: unknown
  try {
    raw = await c.req.json()
  } catch {
    return c.json({ error: 'Invalid JSON body' }, 400)
  }
  const parsed = SetAliasRequestSchema.safeParse(raw)
  if (!parsed.success) {
    return c.json(
      {
        error: 'Invalid request body',
        issues: parsed.error.issues.map(i => ({ path: i.path.join('.'), message: i.message })),
      },
      400,
    )
  }
  const { aliasOf } = parsed.data

  // Idempotent — return the current state when the alias didn't change.
  if (manifest.aliasOf === (aliasOf ?? undefined)) {
    const response: SetAliasResponse = { ok: true, name, ...(aliasOf ? { aliasOf } : {}) }
    return c.json(response)
  }

  // Build the updated manifest. Drop aliasOf when null; set when string.
  const updated: ComponentManifest = { ...manifest }
  if (aliasOf === null) delete updated.aliasOf
  else updated.aliasOf = aliasOf

  await writeManifest(source, handle, name, updated, manifest)

  // Update the archive-aliases sidecar — extract sees the new aliasOf
  // (or empty set when dropped) and the diff handles add/remove.
  const itemRef: ItemRef = { source: handle.refSource, name }
  await rebuildArchiveAliases(source.contentRoot, itemRef, manifest, updated)

  await Promise.all([
    source.cache.invalidatePrefix(`${handle.scopeKind}s:`),
    handle.scopeKind === 'fragment' ? source.cache.invalidatePrefix('pages:') : Promise.resolve(),
  ])
  await c.var.audit.record({
    action: 'archive',
    outcome: 'success',
    scope: { kind: handle.scopeKind, name },
    metadata: {
      aliasEdited: true,
      ...(aliasOf ? { aliasOf } : { aliasDropped: true }),
    },
  })
  // Re-validate after alias edit — P5 (`aliasof-points-to-archived`)
  // and P2 (`dangling-alias`) depend on the manifest's aliasOf field.
  notifyScanner(scanner, handle, name)

  const response: SetAliasResponse = { ok: true, name, ...(aliasOf ? { aliasOf } : {}) }
  return c.json(response)
}

// ─── Purge ─────────────────────────────────────────────────────────────

export async function handlePurge(
  c: Context<AuditEnv>,
  resolve: SourceContextResolver,
  handle: ItemHandle,
  scanner: import('../../validation/scanner.js').ValidationScanner | null = null,
  // The explicit `?permanent=true` delete routes pass allowLive: they
  // are the documented hard-delete intent for live items (#1341 only
  // closes the /purge routes).
  opts: { allowLive?: boolean } = {},
) {
  const name = c.req.param('name')
  if (!name) return c.json({ error: 'Missing name parameter' }, 400)
  const force = c.req.query('force') === 'true'
  const source = await resolve(c.req.query('target'))
  const site = await loadSiteFromSource(source)

  const manifest = lookupManifest(site, handle.scopeKind, name)
  if (!manifest) return c.json({ error: `${handle.label} "${name}" not found` }, 404)

  // Per Q4 lock D1: refuse on aliases AND live refs (one 409 with
  // both arrays). `?force=true` bypasses both per Q5 lock E1; admin
  // role gate is enforced by `requireCapability('delete:*')` paired
  // with the audit metadata recording what was bypassed.
  const aliases = collectAliases(site, name)
  const liveRefs = collectLiveRefs(handle, site, name)

  if (!force && (aliases.length > 0 || liveRefs.length > 0)) {
    const blocked: PurgeBlocked = { code: 'DELETE_BLOCKED', aliases, liveRefs }
    return c.json(blocked, 409)
  }

  // Purge is the permanent delete of an ARCHIVED item
  // (design-soft-delete.md): a live page or fragment must be
  // archived first so a mistaken call cannot skip the archive step
  // (#1341). `?force=true` does NOT bypass this refusal - force is
  // scoped to the alias / live-ref blockers above (maintainer call
  // on #1436); the explicit `?permanent=true` delete route
  // (allowLive) stays the way to hard-delete a live item.
  if (!opts.allowLive && manifest.archived !== true) {
    const notArchived: PurgeNotArchived = {
      code: 'NOT_ARCHIVED',
      error: `${handle.label} "${name}" is not archived - archive it first`,
    }
    return c.json(notArchived, 409)
  }

  // History first per pages.ts/fragments.ts pattern: the recorder's
  // first call scans pre-purge to build the baseline, then captures
  // the post-purge state. Writing first would lose the baseline.
  const itemDir = source.contentRoot.path(`${handle.scopeKind}s`, name)
  const manifestPath = join(itemDir, handle.filename)
  if (source.history) {
    await recordWrite({
      history: source.history,
      contentRoot: source.contentRoot,
      operation: 'save',
      items: [{ path: source.contentRoot.relative(manifestPath), content: null }],
    })
  }

  await source.storage.rm(itemDir)

  // Tear down dep-sidecars — purge IS edge removal. Asset-refs +
  // fragment-deps go away; archive-aliases tears down too. Per-locale
  // variants share the directory, but we tear down their sidecars
  // separately so the per-locale ItemRef variants are explicit.
  const itemRef: ItemRef = { source: handle.refSource, name }
  const teardowns: Promise<void>[] = [
    rebuildArchiveAliases(source.contentRoot, itemRef, manifest, null),
    rebuildAssetRefs(source.contentRoot, itemRef, manifest, null),
    rebuildFragmentDeps(source.contentRoot, itemRef, manifest, null),
  ]
  // Locale variants from the loader (when the item had any).
  const variantManifests = collectLocaleVariants(site, handle, name)
  for (const [loc, variant] of variantManifests) {
    const ref: ItemRef = { source: handle.refSource, name, locale: loc }
    teardowns.push(
      rebuildArchiveAliases(source.contentRoot, ref, variant, null),
      rebuildAssetRefs(source.contentRoot, ref, variant, null),
      rebuildFragmentDeps(source.contentRoot, ref, variant, null),
    )
  }
  await Promise.all(teardowns)

  await Promise.all([
    source.cache.invalidatePrefix(`${handle.scopeKind}s:`),
    handle.scopeKind === 'fragment' ? source.cache.invalidatePrefix('pages:') : Promise.resolve(),
  ])

  // Audit metadata captures the bypass when `?force=true` cleared
  // blockers — per Q8 audit shape (Q5 E1 lock). Forensics finds the
  // broken refs / dangling aliases by querying the bypass arrays.
  const metadata: Record<string, unknown> = {}
  if (manifest.archived === true) {
    if (manifest.archivedAt) metadata.archivedAt = manifest.archivedAt
    if (manifest.archivedBy) metadata.archivedBy = manifest.archivedBy
  }
  if (force) {
    metadata.forced = true
    if (aliases.length > 0) metadata.bypassedAliases = aliases
    if (liveRefs.length > 0) metadata.bypassedRefs = liveRefs
  }
  await c.var.audit.record({
    action: 'purge',
    outcome: 'success',
    scope: { kind: handle.scopeKind, name },
    metadata: Object.keys(metadata).length > 0 ? metadata : undefined,
  })
  // Item is gone — scanner clears any cached issues for this path.
  notifyScanner(scanner, handle, name)

  const response: PurgeResponse = { ok: true, name }
  return c.json(response)
}

// ─── Helpers ──────────────────────────────────────────────────────────

function collectLocaleVariants(
  site: Site,
  handle: ItemHandle,
  name: string,
): Array<[string, PageManifest | FragmentManifest]> {
  const localeEntry = handle.scopeKind === 'page' ? site.pageLocales.get(name) : site.fragmentLocales.get(name)
  if (!localeEntry) return []
  return [...localeEntry.locales.entries()]
}

async function writeManifest(
  source: import('../source-context.js').SourceContext,
  handle: ItemHandle,
  name: string,
  manifest: ComponentManifest,
  preManifest: PageManifest | FragmentManifest,
): Promise<void> {
  const itemDir = source.contentRoot.path(`${handle.scopeKind}s`, name)
  const manifestPath = join(itemDir, handle.filename)
  const serialized = JSON.stringify(stripDirAndRoute(manifest, preManifest, handle), null, 2) + '\n'

  // History record before write (same rationale as PUT handler).
  if (source.history) {
    await recordWrite({
      history: source.history,
      contentRoot: source.contentRoot,
      operation: 'save',
      items: [{ path: source.contentRoot.relative(manifestPath), content: serialized }],
    })
  }
  await source.storage.writeFile(manifestPath, serialized)
}

/**
 * Pages have a derived `route` field on the in-memory manifest (from
 * the directory name). Fragments don't carry serializable extras here.
 * The on-disk `page.json` only stores fields the author authors —
 * `route` and `dir` are runtime projections from the loader.
 */
function stripDirAndRoute(
  manifest: ComponentManifest,
  preManifest: PageManifest | FragmentManifest,
  _handle: ItemHandle,
): ComponentManifest {
  const stripped = { ...manifest } as ComponentManifest & Record<string, unknown>
  delete stripped.route
  delete stripped.dir
  // Preserve any author-stored fields not in our typed shape — copy
  // anything in preManifest that we didn't already include.
  void preManifest
  return stripped
}

function stripArchiveFields(manifest: ComponentManifest): ComponentManifest {
  const restored = { ...manifest } as ComponentManifest & Record<string, unknown>
  delete restored.archived
  delete restored.archivedAt
  delete restored.archivedBy
  delete restored.aliasOf
  return restored
}

/**
 * Read every archive whose `aliasOf` points at `name` from the loaded
 * site, with the same extraction as the `alias-targets` index builder.
 * The index is derived state and isn't committed, so a fresh clone or
 * a `git pull` can leave it missing or stale (#1139); an in-memory
 * pass over the site has no storage reads and is milliseconds at the
 * 5K-page envelope. Locale variants share their parent's archive
 * state, so results are deduped to bare names.
 */
function collectAliases(site: Site, name: string): AliasPointer[] {
  const aliases: AliasPointer[] = []
  const seen = new Set<string>()
  for (const ref of findArchivesAliasingInSite(site, name)) {
    const key = `${ref.source}:${ref.name}`
    if (seen.has(key)) continue
    seen.add(key)
    // Mark Manual Redirect archives so clients don't offer Restore —
    // restoring one would strip its manifest to `{}` (#1343).
    const manifest = ref.source === 'page' ? site.pages.get(ref.name) : site.fragments.get(ref.name)
    aliases.push({
      kind: ref.source,
      name: ref.name,
      ...(manifest && isManualRedirectArchive(manifest) ? { redirect: true } : {}),
    })
  }
  return aliases
}

/**
 * Collect live (non-archived) page/fragment refs for the target name
 * from the loaded site, with the same `@fragment` extraction as the
 * `fragment-deps` index builder. The index is derived state and isn't
 * committed, so a fresh clone or a `git pull` can leave it missing or
 * stale (#1139). Only fragments have referrers tracked this way.
 */
function collectLiveRefs(handle: ItemHandle, site: Site, name: string): LiveRef[] {
  if (handle.scopeKind !== 'fragment') return []
  return findFragmentUsersInSite(site, name).map(ref => ({ kind: ref.source, name: ref.name }))
}
