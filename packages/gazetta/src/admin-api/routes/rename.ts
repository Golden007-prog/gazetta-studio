/**
 * Rename routes for pages + fragments.
 *
 * Per `design-soft-delete.md` Q3 (G1: flatten on rename) and Cut 6 of
 * the implementation plan: rename is a composite operation —
 *
 *   1. create-new: write the new manifest at `to` with copied content
 *   2. archive-old: archive the old name with `aliasOf: to`
 *   3. flatten cascade: walk archives where `aliasOf === fromName` and
 *      rewrite each to `aliasOf: to` (Q3 G1 invariant: aliases never chain)
 *
 * Single composite `action: 'rename'` audit event (Q8 M4 lock); the
 * component archive + create-new + flatten cascade do NOT emit their
 * own events.
 *
 * # Order matters for failure-mode safety (Q2 B1)
 *
 * Create-new first → archive-old second → flatten third. Why:
 *   - Step 1 fail: nothing changed; clean 500.
 *   - Step 2 fail: B exists live, A live; partial state surfaced as
 *     500 RENAME_PARTIAL; retry is idempotent.
 *   - Step 3 fail: A is archived → B; some archives still point at A
 *     (chain). Validator P3 surfaces the chain on next save; retry
 *     of the rename re-runs flatten (idempotent).
 *
 * # Conflict shape (Q3 C1)
 *
 *   - Live `to` exists → 409 NAME_COLLISION (caller picks different name)
 *   - Archived `to` exists → 409 ARCHIVED_NAME_CONFLICT (caller resolves
 *     via Cut 11's three-option prompt: Restore / Replace / Move aside)
 *
 * # Locale variants (Q5 E1)
 *
 * Whole-directory rename: `pages/old/{page.json, page.fr.json, page.es.json}`
 * → `pages/new/`. Locale variants share parent's archive state. Audit
 * `metadata.localeVariants: [...]` records which locales were affected.
 *
 * # Capability (Q6 F1)
 *
 * `edit:{kind}` — rename is content-state edit. Symmetric with unarchive.
 *
 * # Publish behavior (Q7 G1)
 *
 * Zero new publish-time logic. Archive's HTML comment marker (Cut 3)
 * handles the 301 redirect for worker-served targets; `_redirects`
 * (Cut 4) handles plain-static. Rename is just "create-new + archive
 * with aliasOf"; the published-state behavior is whatever archive
 * already delivers.
 *
 * # SOLID lenses
 *
 *   - SRP: this module owns rename's three-step composition. Doesn't
 *     reuse archive routes' HTTP handlers (they audit independently);
 *     does reuse the `archive-aliases` sidecar primitives.
 *   - DIP: depends on `rebuildArchiveAliases` + `findArchivesAliasingInSite`
 *     primitives, not their per-edge sidecar implementation details.
 */
import { Hono } from 'hono'
import type { Context } from 'hono'
import { join } from 'node:path'
import type { SourceContextResolver } from '../source-context.js'
import type { Site } from '../../site-loader.js'
import { findArchivesAliasingInSite } from '../../site-users.js'
import { loadSiteFromSource } from '../source-context.js'
import type { SourceContext } from '../source-context.js'
import { recordWrite } from '../../history-recorder.js'
import { requireCapability } from '../middleware/capability.js'
import { lookupManifest } from '../lookup-manifest.js'
import type { AuditEnv } from '../middleware/audit.js'
import type { ItemRef } from '../../dep-sidecars.js'
import { rebuildArchiveAliases } from '../../archive-aliases.js'
import { rebuildAssetRefs } from '../../assets/asset-deps.js'
import { rebuildFragmentDeps } from '../../fragment-deps.js'
import {
  RenameRequestSchema,
  type ArchivedNameConflict,
  type NameCollision,
  type RenameResponse,
  type RenamePartial,
} from '../schemas/rename.js'
import type { ComponentManifest, FragmentManifest, PageManifest } from '../../types.js'

type ItemKind = 'page' | 'fragment'

interface ItemHandle {
  refSource: ItemRef['source']
  scopeKind: ItemKind
  filename: string
  label: string
}

const PAGE_HANDLE: ItemHandle = {
  refSource: 'page',
  scopeKind: 'page',
  filename: 'page.json',
  label: 'Page',
}

const FRAGMENT_HANDLE: ItemHandle = {
  refSource: 'fragment',
  scopeKind: 'fragment',
  filename: 'fragment.json',
  label: 'Fragment',
}

export function renameRoutes(resolve: SourceContextResolver) {
  const app = new Hono<AuditEnv>()

  app.post('/api/pages/:name/rename', requireCapability('edit:pages'), c => handleRename(c, resolve, PAGE_HANDLE))
  app.post('/api/fragments/:name/rename', requireCapability('edit:fragments'), c =>
    handleRename(c, resolve, FRAGMENT_HANDLE),
  )

  return app
}

async function handleRename(c: Context<AuditEnv>, resolve: SourceContextResolver, handle: ItemHandle) {
  const fromName = c.req.param('name')
  if (!fromName) return c.json({ error: 'Missing name parameter' }, 400)

  const source = await resolve(c.req.query('target'))
  const site = await loadSiteFromSource(source)

  // Schema-validate body. `to` is required; `keepAlias` defaults true.
  let raw: unknown
  try {
    raw = await c.req.json()
  } catch {
    return c.json({ error: 'Invalid JSON body' }, 400)
  }
  const parsed = RenameRequestSchema.safeParse(raw)
  if (!parsed.success) {
    return c.json(
      {
        error: 'Invalid request body',
        issues: parsed.error.issues.map(i => ({ path: i.path.join('.'), message: i.message })),
      },
      400,
    )
  }
  const { to: toName, keepAlias } = parsed.data

  // No-op rename — return 200 quietly so callers can retry without
  // surprise. The author intent ("rename A to A") is satisfied.
  if (fromName === toName) {
    const response: RenameResponse = {
      ok: true,
      name: toName,
      fromName,
      flattenedAliases: [],
      localeVariants: [],
    }
    return c.json(response)
  }

  // Look up the source manifest.
  const fromManifest = lookupManifest(site, handle.scopeKind, fromName)
  if (!fromManifest) {
    return c.json({ error: `${handle.label} "${fromName}" not found` }, 404)
  }

  // Conflict checks (Q3 C1) — distinct 409 codes for the two flavors.
  const toManifest = lookupManifest(site, handle.scopeKind, toName)
  if (toManifest) {
    if (toManifest.archived === true) {
      const body: ArchivedNameConflict = {
        code: 'ARCHIVED_NAME_CONFLICT',
        toName,
        conflictKind: 'archived',
        archive: {
          ...(toManifest.archivedAt ? { archivedAt: toManifest.archivedAt } : {}),
          ...(toManifest.archivedBy ? { archivedBy: toManifest.archivedBy } : {}),
          ...(toManifest.aliasOf ? { aliasOf: toManifest.aliasOf } : {}),
        },
      }
      return c.json(body, 409)
    }
    const body: NameCollision = { code: 'NAME_COLLISION', toName, conflictKind: 'live' }
    return c.json(body, 409)
  }

  // Track step progress for I1's RENAME_PARTIAL response.
  const completed: Array<'create-new' | 'archive-old' | 'flatten-cascade'> = []

  // Locale variants for E1/E5: discover what's at the from-name dir.
  const localeEntry = handle.scopeKind === 'page' ? site.pageLocales.get(fromName) : site.fragmentLocales.get(fromName)
  const localeVariants = localeEntry ? [...localeEntry.locales.keys()] : []

  try {
    // ─── Step 1: create-new ─────────────────────────────────────────
    // Copy default manifest + every locale variant to the new path.
    // The new item is live (no archive fields); content stays identical.
    await createNew(source, handle, fromName, toName, fromManifest, localeEntry)
    completed.push('create-new')

    // ─── Step 2: archive-old ────────────────────────────────────────
    // Archive the old name. When keepAlias is true, set aliasOf: toName
    // so render emits 301. When false, pure soft-delete (410 / 404).
    await archiveOld(source, handle, fromName, fromManifest, keepAlias ? toName : undefined, c.var.principal.id)
    completed.push('archive-old')

    // ─── Step 3: flatten cascade ────────────────────────────────────
    // Q3 G1 invariant: any archive whose aliasOf was fromName now
    // points at toName instead. Parallel rewrites — each touches a
    // distinct manifest; no contention.
    const flattened = await flattenAliasChain(source, site, handle, fromName, toName)
    completed.push('flatten-cascade')

    // ─── Cache invalidation ─────────────────────────────────────────
    await Promise.all([
      source.cache.invalidatePrefix(`${handle.scopeKind}s:`),
      handle.scopeKind === 'fragment' ? source.cache.invalidatePrefix('pages:') : Promise.resolve(),
    ])

    // ─── Audit (Q8 H1) ──────────────────────────────────────────────
    // Single composite event. metadata.fromName + flattenedAliases +
    // localeVariants give forensics enough to reconstruct without
    // multi-row joins.
    const metadata: Record<string, unknown> = { fromName, keepAlias }
    if (flattened.length > 0) metadata.flattenedAliases = flattened
    if (localeVariants.length > 0) metadata.localeVariants = localeVariants
    await c.var.audit.record({
      action: 'rename',
      outcome: 'success',
      scope: { kind: handle.scopeKind, name: toName },
      metadata,
    })

    const response: RenameResponse = {
      ok: true,
      name: toName,
      fromName,
      flattenedAliases: flattened,
      localeVariants,
    }
    return c.json(response)
  } catch (err) {
    // Q9 I1: surface partial state. Each step is internally
    // idempotent — retrying the rename re-runs uncompleted steps.
    const allSteps: Array<'create-new' | 'archive-old' | 'flatten-cascade'> = [
      'create-new',
      'archive-old',
      'flatten-cascade',
    ]
    const remaining = allSteps.filter(s => !completed.includes(s))
    const partial: RenamePartial = {
      code: 'RENAME_PARTIAL',
      completed,
      remaining,
      error: (err as Error).message,
    }
    // Don't audit partial failures — the audit log records intent +
    // outcome of completed actions. A retry that succeeds will audit
    // normally with the full state. Forensics for the failure window
    // lives in operational logs (per design-logging.md), not audit.
    return c.json(partial, 500)
  }
}

// ─── Helpers ──────────────────────────────────────────────────────────

/**
 * Create the new manifest + all locale variants. Each variant is
 * written as a separate file; dep sidecars (asset-refs, fragment-deps)
 * are materialized via rebuild* calls so the new name's dep index
 * matches the old name's.
 */
async function createNew(
  source: SourceContext,
  handle: ItemHandle,
  fromName: string,
  toName: string,
  fromManifest: PageManifest | FragmentManifest,
  localeEntry:
    | import('../../site-loader.js').LocalizedEntry<(PageManifest | FragmentManifest) & { dir: string }>
    | undefined,
): Promise<void> {
  // Strip the loader's derived fields before persisting — `dir` is a
  // runtime projection, `route` is derived per-call from the directory
  // name (deriveRoute). The rename moves the directory, so route is
  // re-derived correctly on next loadSite without persisting it.
  const newManifest = stripDerivedFields(fromManifest)

  const newDir = source.contentRoot.path(`${handle.scopeKind}s`, toName)
  const newPath = join(newDir, handle.filename)
  await source.storage.mkdir(newDir)
  const serialized = JSON.stringify(newManifest, null, 2) + '\n'

  // History first per the existing PUT pattern.
  if (source.history) {
    await recordWrite({
      history: source.history,
      contentRoot: source.contentRoot,
      operation: 'save',
      items: [{ path: source.contentRoot.relative(newPath), content: serialized }],
    })
  }
  await source.storage.writeFile(newPath, serialized)

  // Locale variants — each as its own file with `page.{locale}.json`
  // / `fragment.{locale}.json` shape.
  if (localeEntry) {
    for (const [locale, variantManifest] of localeEntry.locales) {
      const variantStripped = stripDerivedFields(variantManifest)
      const variantFilename = handle.filename.replace(/\.json$/, `.${locale}.json`)
      const variantPath = join(newDir, variantFilename)
      const variantSerialized = JSON.stringify(variantStripped, null, 2) + '\n'
      if (source.history) {
        await recordWrite({
          history: source.history,
          contentRoot: source.contentRoot,
          operation: 'save',
          items: [{ path: source.contentRoot.relative(variantPath), content: variantSerialized }],
        })
      }
      await source.storage.writeFile(variantPath, variantSerialized)
    }
  }

  // Dep sidecars — the new item references the same assets/fragments
  // as the old item. Rebuild them at the new name.
  const newItem: ItemRef = { source: handle.refSource, name: toName }
  await Promise.all([
    rebuildAssetRefs(source.contentRoot, newItem, null, newManifest),
    rebuildFragmentDeps(source.contentRoot, newItem, null, newManifest),
  ])
  if (localeEntry) {
    const localeRebuilds: Promise<void>[] = []
    for (const [locale, variantManifest] of localeEntry.locales) {
      const variantStripped = stripDerivedFields(variantManifest)
      const variantItem: ItemRef = { source: handle.refSource, name: toName, locale }
      localeRebuilds.push(
        rebuildAssetRefs(source.contentRoot, variantItem, null, variantStripped),
        rebuildFragmentDeps(source.contentRoot, variantItem, null, variantStripped),
      )
    }
    await Promise.all(localeRebuilds)
  }
}

/**
 * Archive the old name. When `aliasTarget` is set (keepAlias=true),
 * sets aliasOf so render emits a 301 to the new name. When undefined
 * (keepAlias=false), pure soft-delete; render emits 410.
 */
async function archiveOld(
  source: SourceContext,
  handle: ItemHandle,
  fromName: string,
  fromManifest: PageManifest | FragmentManifest,
  aliasTarget: string | undefined,
  archivedBy: string,
): Promise<void> {
  const oldDir = source.contentRoot.path(`${handle.scopeKind}s`, fromName)
  const oldPath = join(oldDir, handle.filename)
  const stripped = stripDerivedFields(fromManifest)
  const archived: ComponentManifest = {
    ...stripped,
    archived: true,
    archivedAt: new Date().toISOString(),
    archivedBy,
  }
  if (aliasTarget) archived.aliasOf = aliasTarget
  const serialized = JSON.stringify(archived, null, 2) + '\n'

  if (source.history) {
    await recordWrite({
      history: source.history,
      contentRoot: source.contentRoot,
      operation: 'save',
      items: [{ path: source.contentRoot.relative(oldPath), content: serialized }],
    })
  }
  await source.storage.writeFile(oldPath, serialized)

  // Update the archive-aliases sidecar for the old name's new state.
  const oldItem: ItemRef = { source: handle.refSource, name: fromName }
  await rebuildArchiveAliases(source.contentRoot, oldItem, fromManifest, archived)
}

/**
 * Walk archives where aliasOf === fromName; rewrite each to
 * aliasOf: toName. Returns the names of rewritten archives for the
 * audit trail. The aliasing archives come from the loaded site, not
 * the `.gazetta/alias-targets/` index: derived state isn't committed,
 * so a fresh clone or `git pull` can leave it missing or stale
 * (#1139).
 *
 * Per Q4 D1+D5: synchronous parallel rewrites. Each rewrite touches
 * a distinct manifest; no contention.
 */
async function flattenAliasChain(
  source: SourceContext,
  site: Site,
  handle: ItemHandle,
  fromName: string,
  toName: string,
): Promise<string[]> {
  const aliasingArchives = findArchivesAliasingInSite(site, fromName)
  if (aliasingArchives.length === 0) return []

  // Read each archive's current manifest, rewrite its aliasOf, write
  // back, update the sidecar diff. Filter by source kind to match
  // ItemHandle (page archives can alias pages; fragment archives can
  // alias fragments — we don't cross the boundary).
  const rewrites = aliasingArchives
    .filter(ref => ref.source === handle.refSource)
    .map(async ref => {
      const dir = source.contentRoot.path(`${handle.scopeKind}s`, ref.name)
      const path = join(dir, ref.locale ? handle.filename.replace(/\.json$/, `.${ref.locale}.json`) : handle.filename)
      const raw = await source.storage.readFile(path)
      const oldManifest = JSON.parse(raw) as ComponentManifest
      const newManifest: ComponentManifest = { ...oldManifest, aliasOf: toName }
      const serialized = JSON.stringify(newManifest, null, 2) + '\n'

      if (source.history) {
        await recordWrite({
          history: source.history,
          contentRoot: source.contentRoot,
          operation: 'save',
          items: [{ path: source.contentRoot.relative(path), content: serialized }],
        })
      }
      await source.storage.writeFile(path, serialized)
      await rebuildArchiveAliases(source.contentRoot, ref, oldManifest, newManifest)
      return ref.name
    })

  return Promise.all(rewrites)
}

/**
 * Strip the loader's derived fields. `dir` is the absolute storage
 * path; `route` is computed per-call from the directory name. Both
 * are runtime projections that don't belong in the persisted JSON.
 */
function stripDerivedFields(manifest: PageManifest | FragmentManifest): ComponentManifest {
  const stripped = { ...manifest } as ComponentManifest & Record<string, unknown>
  delete stripped.dir
  // `route` is derived per-call from the directory name — drop it so
  // the loader recomputes after rename. Locale variants have their
  // route derived as `prefix + parent.route`, also recomputed.
  delete stripped.route
  return stripped
}
