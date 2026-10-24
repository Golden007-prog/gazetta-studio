/**
 * Manual Redirect creation — `POST /api/page-redirects` +
 * `POST /api/fragment-redirects`.
 *
 * Per `design-redirect-ui.md` Q2 (endpoint shape), Q4 (live-name collision
 * + normalize + edge-case rejections), Q7 (`create-redirect` audit action),
 * Q8 (capability gate `edit:pages` / `edit:fragments`).
 *
 * # Why two routes, not one
 *
 * The capability gate runs as Hono middleware that takes a literal
 * capability string. Computing the capability from the request body
 * (`kind` → `edit:pages | edit:fragments`) would require a one-off
 * middleware that reads the body, which isn't a pattern this codebase
 * uses elsewhere. Per impl-doc Q2 lock the two-route shape with a shared
 * handler body is the locked path: each route's capability is literal,
 * the handler body is one function (`createRedirect`), the kind is
 * supplied by the route binding rather than reconstructed.
 *
 * # SOLID lenses
 *
 *   - SRP: this module owns the manual redirect creation route. Doesn't
 *     reach into the archive / create-page primitives; uses narrow
 *     imports of the data-shape helpers (`isArchived`, `deriveRoute`,
 *     `loadSiteFromSource`) only. The route handlers are protocol
 *     translators (HTTP → typed call → HTTP); the policy lives in
 *     `createRedirect`.
 *   - DIP: handler depends on `SourceContextResolver`, history /
 *     audit / cache abstractions through their existing interfaces.
 *     Does NOT depend on the storage provider's concrete class.
 *   - ISP: extracting `createRedirect()` shared helper keeps each route
 *     handler thin — just the binding to the kind + the protocol
 *     boundary. Routes are single-purpose; the helper is single-purpose;
 *     no god functions.
 */
import { Hono } from 'hono'
import type { Context } from 'hono'
import { join } from 'node:path'

import type { SourceContextResolver, SourceContext } from '../source-context.js'
import { loadSiteFromSource } from '../source-context.js'
import { recordWrite } from '../../history-recorder.js'
import { requireCapability } from '../middleware/capability.js'
import { requireEditableTarget } from '../middleware/editable-target.js'
import { lookupManifest } from '../lookup-manifest.js'
import type { AuditEnv } from '../middleware/audit.js'
import { rebuildArchiveAliases } from '../../archive-aliases.js'
import { rebuildAssetRefs } from '../../assets/asset-deps.js'
import { rebuildFragmentDeps } from '../../fragment-deps.js'
import type { ItemRef } from '../../dep-sidecars.js'
import { deriveRoute } from '../../site-loader.js'
import { CreateRedirectRequestSchema, type CreateRedirectResponse } from '../schemas/redirects.js'
import type { ComponentManifest, FragmentManifest, PageManifest } from '../../types.js'

type RedirectKind = 'page' | 'fragment'

interface KindBinding {
  readonly kind: RedirectKind
  readonly capability: 'edit:pages' | 'edit:fragments'
  readonly dirRoot: 'pages' | 'fragments'
  readonly filename: 'page.json' | 'fragment.json'
  readonly label: 'Page' | 'Fragment'
}

const PAGE_BINDING: KindBinding = {
  kind: 'page',
  capability: 'edit:pages',
  dirRoot: 'pages',
  filename: 'page.json',
  label: 'Page',
}

const FRAGMENT_BINDING: KindBinding = {
  kind: 'fragment',
  capability: 'edit:fragments',
  dirRoot: 'fragments',
  filename: 'fragment.json',
  label: 'Fragment',
}

export function redirectRoutes(resolve: SourceContextResolver) {
  const editableTarget = requireEditableTarget(resolve)
  const app = new Hono<AuditEnv>()

  app.post('/api/page-redirects', requireCapability(PAGE_BINDING.capability), editableTarget, c =>
    handleCreateRedirect(c, resolve, PAGE_BINDING),
  )
  app.post('/api/fragment-redirects', requireCapability(FRAGMENT_BINDING.capability), editableTarget, c =>
    handleCreateRedirect(c, resolve, FRAGMENT_BINDING),
  )

  return app
}

/**
 * Shared route handler. The kind binding supplies the capability,
 * directory root (`pages` / `fragments`), manifest filename, and the
 * label used in error messages. Everything else is identical between
 * the two routes — the create-redirect lifecycle doesn't differ by
 * kind beyond which Map on `Site` is consulted (per `loadSiteFromSource`).
 */
async function handleCreateRedirect(
  c: Context<AuditEnv>,
  resolve: SourceContextResolver,
  binding: KindBinding,
): Promise<Response> {
  // Schema-validate the body. Catches missing fields + wrong types BEFORE
  // any storage access.
  let raw: unknown
  try {
    raw = await c.req.json()
  } catch {
    return c.json({ code: 'INVALID', error: 'Invalid JSON body' }, 400)
  }
  const parsed = CreateRedirectRequestSchema.safeParse(raw)
  if (!parsed.success) {
    return c.json(
      {
        code: 'INVALID',
        error: 'Invalid request body',
        issues: parsed.error.issues.map(i => ({ path: i.path.join('.'), message: i.message })),
      },
      400,
    )
  }
  const { from: fromRaw, to } = parsed.data

  // Normalize `from` per Q4 lock: strip leading slash, `:param` → `[param]`.
  // Keep `to` verbatim — alias targets are name-shaped already (clients
  // pass `products/featured`, not `/products/featured`).
  const from = normalizeFromName(fromRaw)

  // Edge-case rejections (absorbs old Cut 5). After normalize because:
  //   - `from: '/blog/:slug'` → normalize → 'blog/[slug]' → wildcard reject
  //   - `from: 'blog/:slug'` → normalize → 'blog/[slug]' → same reject
  //   - `from: 'blog/[slug]'` → normalize is identity → wildcard reject
  if (from === 'home') {
    return c.json(
      {
        code: 'INVALID',
        error:
          'Redirect from "home" is not supported in v1 — that route is the site root. To redirect the root, configure a target-level rewrite or use a worker-side route.',
      },
      400,
    )
  }
  if (containsWildcard(from)) {
    return c.json(
      {
        code: 'INVALID',
        error: `Wildcard from-routes (e.g. "${from}") are not supported in v1. To redirect dynamic paths, configure the worker route directly.`,
      },
      400,
    )
  }

  const source = await resolve(c.req.query('target'))
  const site = await loadSiteFromSource(source)

  // Live-name collision (Q4 lock C2) — hard refuse. No destructive
  // shortcut from a creation dialog; operator's deliberate two-step
  // (archive-or-rename first, then create redirect) protects against
  // accidental live-page removal.
  const existing = lookupManifest(site, binding.kind, from)
  if (existing && existing.archived !== true) {
    return c.json(
      {
        code: 'LIVE_NAME_CONFLICT',
        error: `The ${binding.label.toLowerCase()} "${from}" already exists as live content. To redirect this URL, first archive or rename "${from}", then create the redirect.`,
      },
      409,
    )
  }

  // Archived-name collision (Q4 lock + Q5 I3 inheritance from soft-delete).
  // Three resolution modes per `?onConflict`:
  //   - undefined → 409 ARCHIVED_NAME_CONFLICT with archive details
  //   - 'restore' → unarchive existing; skip create
  //   - 'replace' → purge existing, create new redirect
  //   - 'moveAside' → rename old archive with date suffix, create new
  const onConflict = c.req.query('onConflict')
  if (existing && existing.archived === true) {
    return handleArchivedConflict(c, source, binding, from, to, existing, onConflict)
  }

  // Alias target existence check. `to` must resolve to a live page or
  // fragment of the same kind. Cross-kind aliases (e.g., a page-redirect
  // pointing at a fragment) aren't valid runtime targets.
  const aliasTarget = lookupManifest(site, binding.kind, to)
  if (!aliasTarget || aliasTarget.archived === true) {
    return c.json(
      {
        code: 'ALIAS_TARGET_NOT_FOUND',
        error: `The ${binding.label.toLowerCase()} "${to}" does not exist as live content. The alias target must be a live ${binding.label.toLowerCase()}.`,
      },
      409,
    )
  }

  // Atomic write: archive manifest with `aliasOf` + history + audit + cache.
  await writeRedirectManifest(source, binding, from, to, c.var.principal.id)
  await c.var.audit.record({
    action: 'create-redirect',
    outcome: 'success',
    scope: { kind: binding.kind, name: from },
    metadata: { aliasOf: to },
  })

  const response: CreateRedirectResponse = {
    ok: true,
    from,
    to,
    kind: binding.kind,
    route: binding.kind === 'page' ? deriveRoute(from) : `/${from}`,
    targetRoute: binding.kind === 'page' ? deriveRoute(to) : `/${to}`,
  }
  return c.json(response, 201)
}

/**
 * Normalize the `from` field to a Gazetta name per Q4 lock:
 *   - strip leading `/` (operator may paste a URL from analytics)
 *   - convert `:param` to `[param]` (Hono route syntax → Gazetta dir
 *     naming convention; will be rejected below as wildcard)
 *
 * Idempotent: `normalize(normalize(x)) === normalize(x)` for all inputs.
 */
function normalizeFromName(input: string): string {
  let normalized = input
  while (normalized.startsWith('/')) normalized = normalized.slice(1)
  return normalized.replace(/:([a-zA-Z_][a-zA-Z0-9_]*)/g, '[$1]')
}

function containsWildcard(name: string): boolean {
  return /\[[^\]]+\]/.test(name)
}

/**
 * Build + write the redirect manifest. The manifest carries archive
 * fields ONLY — no `template`, no `content`, no `components`. Per Cut 1
 * schema refinement, an archived manifest doesn't require `template`
 * because the renderer short-circuits on the archive marker BEFORE any
 * template execution.
 *
 * Atomicity sequence (matches archive route):
 *   1. mkdir(itemDir) — idempotent if it already exists
 *   2. recordWrite() to history first — the recorder reads the
 *      pre-write state, so writing first would lose the baseline
 *   3. writeFile(manifestPath, serialized) — last-write-wins per save
 *   4. rebuildArchiveAliases(...) — writes the per-edge alias sidecar
 *      under .gazetta/alias-targets/{to}/{kind}.{from}
 *   5. cache.invalidatePrefix('pages:' or 'fragments:') — fragment edits
 *      also blow `pages:` because page summaries reflect fragment refs
 */
async function writeRedirectManifest(
  source: SourceContext,
  binding: KindBinding,
  from: string,
  to: string,
  actorId: string,
): Promise<void> {
  const itemDir = source.contentRoot.path(binding.dirRoot, from)
  const manifestPath = join(itemDir, binding.filename)
  await source.storage.mkdir(itemDir)

  const archivedAt = new Date().toISOString()
  const manifest: ComponentManifest = {
    archived: true,
    archivedAt,
    archivedBy: actorId,
    aliasOf: to,
  }
  const serialized = JSON.stringify(manifest, null, 2) + '\n'

  if (source.history) {
    await recordWrite({
      history: source.history,
      contentRoot: source.contentRoot,
      operation: 'save',
      items: [{ path: source.contentRoot.relative(manifestPath), content: serialized }],
    })
  }
  await source.storage.writeFile(manifestPath, serialized)

  // Per-edge sidecar at .gazetta/alias-targets/{to}/{kind}.{from}. Builds
  // the diff from null → archived-with-aliasOf, so the right edge gets
  // written regardless of prior state.
  const itemRef: ItemRef = { source: binding.kind, name: from }
  await rebuildArchiveAliases(source.contentRoot, itemRef, null, manifest)

  await Promise.all([
    source.cache.invalidatePrefix(`${binding.kind}s:`),
    binding.kind === 'fragment' ? source.cache.invalidatePrefix('pages:') : Promise.resolve(),
  ])
}

/**
 * Handle the three `?onConflict` modes when `from` resolves to an
 * existing archive. Mirrors `pages/create.ts`'s archive-name-conflict
 * branching but tailored to redirects:
 *
 *   - undefined → 409 ARCHIVED_NAME_CONFLICT body (clients prompt the
 *     author per soft-delete Q5 I3)
 *   - 'restore' → unarchive the existing archive; ignore `to` (the
 *     archive's content is what's being restored, not a redirect)
 *   - 'replace' → purge the existing archive + write a fresh redirect
 *     pointing at `to`
 *   - 'moveAside' → rename the existing archive with a date suffix
 *     (`<name>-archived-YYYYMMDD`), then write the new redirect at the
 *     original name
 *
 * Each path emits one audit event with the right action so forensic
 * reconstruction shows what happened.
 */
async function handleArchivedConflict(
  c: Context<AuditEnv>,
  source: SourceContext,
  binding: KindBinding,
  from: string,
  to: string,
  existing: PageManifest | FragmentManifest,
  onConflict: string | undefined,
): Promise<Response> {
  if (!onConflict) {
    return c.json(
      {
        code: 'ARCHIVED_NAME_CONFLICT',
        archive: {
          kind: binding.kind,
          name: from,
          ...(existing.archivedAt ? { archivedAt: existing.archivedAt } : {}),
          ...(existing.archivedBy ? { archivedBy: existing.archivedBy } : {}),
          ...(existing.aliasOf ? { aliasOf: existing.aliasOf } : {}),
        },
      },
      409,
    )
  }

  if (onConflict === 'restore') {
    await unarchiveExisting(source, binding, from, existing)
    await c.var.audit.record({
      action: 'unarchive',
      outcome: 'success',
      scope: { kind: binding.kind, name: from },
    })
    const response: CreateRedirectResponse = {
      ok: true,
      from,
      to,
      kind: binding.kind,
      route: binding.kind === 'page' ? deriveRoute(from) : `/${from}`,
      targetRoute: binding.kind === 'page' ? deriveRoute(to) : `/${to}`,
    }
    return c.json(response, 201)
  }

  if (onConflict === 'replace') {
    await purgeExisting(source, binding, from, existing)
    await writeRedirectManifest(source, binding, from, to, c.var.principal.id)
    await c.var.audit.record({
      action: 'create-redirect',
      outcome: 'success',
      scope: { kind: binding.kind, name: from },
      metadata: { aliasOf: to, resolution: 'replace' },
    })
    const response: CreateRedirectResponse = {
      ok: true,
      from,
      to,
      kind: binding.kind,
      route: binding.kind === 'page' ? deriveRoute(from) : `/${from}`,
      targetRoute: binding.kind === 'page' ? deriveRoute(to) : `/${to}`,
    }
    return c.json(response, 201)
  }

  if (onConflict === 'moveAside') {
    const asideName = await pickAsideName(source, binding, from)
    await moveArchiveAside(source, binding, from, existing, asideName)
    await writeRedirectManifest(source, binding, from, to, c.var.principal.id)
    await c.var.audit.record({
      action: 'create-redirect',
      outcome: 'success',
      scope: { kind: binding.kind, name: from },
      metadata: { aliasOf: to, resolution: 'moveAside', movedTo: asideName },
    })
    const response: CreateRedirectResponse = {
      ok: true,
      from,
      to,
      kind: binding.kind,
      route: binding.kind === 'page' ? deriveRoute(from) : `/${from}`,
      targetRoute: binding.kind === 'page' ? deriveRoute(to) : `/${to}`,
    }
    return c.json(response, 201)
  }

  return c.json(
    {
      code: 'INVALID',
      error: `Invalid onConflict mode "${onConflict}". Expected one of: restore, replace, moveAside.`,
    },
    400,
  )
}

/**
 * Strip archive fields and write the manifest back. Same shape as
 * archive.ts's `handleUnarchive` minus the audit recording (caller emits).
 */
async function unarchiveExisting(
  source: SourceContext,
  binding: KindBinding,
  name: string,
  existing: PageManifest | FragmentManifest,
): Promise<void> {
  const itemDir = source.contentRoot.path(binding.dirRoot, name)
  const manifestPath = join(itemDir, binding.filename)

  const restored = { ...existing } as ComponentManifest & Record<string, unknown>
  delete restored.archived
  delete restored.archivedAt
  delete restored.archivedBy
  delete restored.aliasOf
  delete restored.dir
  delete restored.route

  const serialized = JSON.stringify(restored, null, 2) + '\n'

  if (source.history) {
    await recordWrite({
      history: source.history,
      contentRoot: source.contentRoot,
      operation: 'save',
      items: [{ path: source.contentRoot.relative(manifestPath), content: serialized }],
    })
  }
  await source.storage.writeFile(manifestPath, serialized)

  const itemRef: ItemRef = { source: binding.kind, name }
  await rebuildArchiveAliases(source.contentRoot, itemRef, existing, restored)

  await Promise.all([
    source.cache.invalidatePrefix(`${binding.kind}s:`),
    binding.kind === 'fragment' ? source.cache.invalidatePrefix('pages:') : Promise.resolve(),
  ])
}

/**
 * Purge an existing archive: rm the directory + tear down all dep
 * sidecars (archive-aliases, asset-refs, fragment-deps). Mirrors
 * archive.ts's `handlePurge` minus the live-refs / alias-pointers
 * checks (those are purge-blocked checks; replace inherits the operator's
 * intent to overwrite).
 */
async function purgeExisting(
  source: SourceContext,
  binding: KindBinding,
  name: string,
  existing: PageManifest | FragmentManifest,
): Promise<void> {
  const itemDir = source.contentRoot.path(binding.dirRoot, name)
  const manifestPath = join(itemDir, binding.filename)

  if (source.history) {
    await recordWrite({
      history: source.history,
      contentRoot: source.contentRoot,
      operation: 'save',
      items: [{ path: source.contentRoot.relative(manifestPath), content: null }],
    })
  }
  await source.storage.rm(itemDir)

  const itemRef: ItemRef = { source: binding.kind, name }
  await Promise.all([
    rebuildArchiveAliases(source.contentRoot, itemRef, existing, null),
    rebuildAssetRefs(source.contentRoot, itemRef, existing, null),
    rebuildFragmentDeps(source.contentRoot, itemRef, existing, null),
  ])

  await Promise.all([
    source.cache.invalidatePrefix(`${binding.kind}s:`),
    binding.kind === 'fragment' ? source.cache.invalidatePrefix('pages:') : Promise.resolve(),
  ])
}

/**
 * Pick a non-colliding aside name. Format: `<name>-archived-<YYYYMMDD>`
 * with `-N` counter on collision. Same shape as
 * `archived-name-conflict.ts`'s `pickAsideName` — kept inline because
 * the existing helper isn't exported.
 */
async function pickAsideName(source: SourceContext, binding: KindBinding, name: string): Promise<string> {
  const today = new Date().toISOString().slice(0, 10).replace(/-/g, '')
  const base = `${name}-archived-${today}`
  let candidate = base
  let counter = 1
  for (let i = 0; i < 100; i++) {
    const dir = source.contentRoot.path(binding.dirRoot, candidate)
    const exists = await source.storage.exists(join(dir, binding.filename))
    if (!exists) return candidate
    counter++
    candidate = `${base}-${counter}`
  }
  throw new Error(`Could not find a non-colliding aside name for "${name}" after 100 attempts`)
}

async function moveArchiveAside(
  source: SourceContext,
  binding: KindBinding,
  name: string,
  existing: PageManifest | FragmentManifest,
  asideName: string,
): Promise<void> {
  const oldDir = source.contentRoot.path(binding.dirRoot, name)
  const newDir = source.contentRoot.path(binding.dirRoot, asideName)
  await source.storage.mkdir(newDir)

  // Carry the existing archive shape forward to the aside path; strip
  // derived fields (dir, route) that don't belong on disk.
  const carried = { ...existing } as ComponentManifest & Record<string, unknown>
  delete carried.dir
  delete carried.route
  const carriedSerialized = JSON.stringify(carried, null, 2) + '\n'
  await source.storage.writeFile(join(newDir, binding.filename), carriedSerialized)
  await source.storage.rm(oldDir)

  // Sidecars: tear down at the OLD name, build at the new name.
  const oldRef: ItemRef = { source: binding.kind, name }
  const newRef: ItemRef = { source: binding.kind, name: asideName }
  await Promise.all([
    rebuildArchiveAliases(source.contentRoot, oldRef, existing, null),
    rebuildAssetRefs(source.contentRoot, oldRef, existing, null),
    rebuildFragmentDeps(source.contentRoot, oldRef, existing, null),
    rebuildArchiveAliases(source.contentRoot, newRef, null, carried),
    rebuildAssetRefs(source.contentRoot, newRef, null, carried),
    rebuildFragmentDeps(source.contentRoot, newRef, null, carried),
  ])
}
