import { Hono } from 'hono'
import { streamSSE } from 'hono/streaming'
import { getType, getEnvironment, isEditable } from '../../types.js'
import type { StorageProvider, TargetConfig } from '../../types.js'
import { stateFolderPath } from '../../state-folders.js'
import { publishItems, resolveDependencies, findFragmentDependents, findDependentsFromSidecars } from '../../publish.js'
import { isValidLocale, normalizeLocale } from '../../locale.js'
import type { SourceContextResolver } from '../source-context.js'
import type { PublishResult } from '../../publish.js'
import { loadSiteFromSource } from '../source-context.js'
import { isAltAdapterConfigured } from '../../alt/factory.js'
import { resolveAltConfig } from '../../alt/config.js'
import { inspectTarget } from '../../runtime/runtime-capabilities.js'
import { scanTemplates, type TemplateInfo } from '../../templates-scan.js'
import { createContentRoot } from '../../content-root.js'
import { requireCapability } from '../middleware/capability.js'
import { capabilityGrants, type Principal } from '../../auth/index.js'
import type { AuditEnv } from '../middleware/audit.js'
import {
  buildHookContext,
  dispatchAfterPublish,
  dispatchBeforePublish,
  HookCancellation,
  HookTimeout,
  type HookRegistry,
  type PublishHookResult,
  type PublishItem,
} from '../../hooks/index.js'
import { makeAuditFiringEmitter } from '../hook-audit-emitter.js'
import { runPublishAudit } from '../../validation/publish-audit.js'
import type { Issue } from '../../validation/types.js'
import { isSafeItemName } from '../../item-name.js'
import { PublishAuditRequestSchema } from '../schemas/validation.js'

/**
 * Progress events streamed by runPublish. Consumed both by the SSE route
 * (forwarded to the client as event-stream messages) and the legacy
 * synchronous route (which only takes the final 'done').
 */
export type PublishProgress =
  | { kind: 'start'; targets: string[]; itemsPerTarget: number }
  | { kind: 'target-start'; target: string; total: number }
  | { kind: 'progress'; target: string; current: number; total: number; label: string }
  | { kind: 'target-result'; result: PublishResult }
  | { kind: 'done'; results: PublishResult[] }
  | { kind: 'fatal'; error: string; invalidTemplates?: { name: string; errors: string[] }[] }

export interface PublishRoutesOptions {
  hooks?: HookRegistry
  /**
   * Validator registry — used by `POST /api/publish/audit` to run
   * pre-publish-stage validators against items being published.
   * When omitted, the audit endpoint reports an empty issue list
   * (sites without validation infrastructure pay zero overhead).
   */
  validators?: import('../../validation/registry.js').ValidatorRegistry
  /**
   * Validation cache — passed to render-for-analysis under the audit
   * endpoint. Reuses the scanner's render-for-analysis cache so the
   * audit doesn't re-render pages already seen in the background scan.
   */
  cache?: import('../../cache/types.js').AdminCache
}

export function publishRoutes(
  resolve: SourceContextResolver,
  preInitTargets?: Map<string, StorageProvider>,
  targetConfigs?: Record<string, TargetConfig>,
  templatesDir?: string,
  // Optional injected scanner — the admin-api server memoizes it and
  // clears the cache via its template file watcher. Default: fresh scan
  // on every call (used by the CLI and tests).
  scanTemplatesInjected?: (templatesDir: string, projectRoot: string) => Promise<TemplateInfo[]>,
  opts: PublishRoutesOptions = {},
) {
  const scan = scanTemplatesInjected ?? scanTemplates
  const hooks = opts.hooks
  const app = new Hono<AuditEnv>()

  /**
   * Route-boundary validation for user-supplied item paths (#1196).
   * Accepted forms: `pages/<name>[:<locale>]`, `fragments/<name>[:<locale>]`,
   * `templates/<name>`, `assets/<name>`. Every name segment must be
   * non-empty and not `.`/`..`; no leading `/`, no backslash; a locale
   * suffix must satisfy `isValidLocale`. The raw item used to be joined
   * straight onto a storage root, so `..` segments could read and copy
   * folders outside the site - anything failing these rules is rejected
   * before a path is built from it.
   */
  function parseRouteItem(item: string): { dir: string; knownPrefix: boolean } | null {
    if (item.startsWith('/') || item.includes('\\')) return null
    // Known folder prefixes get locale parsing + an existence check;
    // anything else is an asset-style name (toPublishItem's fallback)
    // and still gets the same segment rules, so no shape can carry a
    // `..` segment through.
    const m = /^(pages|fragments|templates|assets)\/(.+)$/.exec(item)
    const prefix = m ? m[1] : null
    let name = m ? m[2] : item
    if (prefix === 'pages' || prefix === 'fragments') {
      const ci = name.indexOf(':')
      if (ci >= 0) {
        if (!isValidLocale(name.slice(ci + 1))) return null
        name = name.slice(0, ci)
      }
    }
    if (!isSafeItemName(name)) return null
    // Existence is checked for folder items (pages/fragments/templates);
    // asset-style names pass the segment rules only.
    return { dir: prefix ? `${prefix}/${name}` : name, knownPrefix: prefix !== null && prefix !== 'assets' }
  }

  /**
   * Validate request items at the route boundary: shape via
   * parseRouteItem, then existence on the storage they will be read
   * from. Returns the error message for the first bad item, or null.
   */
  async function validateRequestItems(
    items: readonly string[],
    exists: (path: string) => Promise<boolean>,
  ): Promise<string | null> {
    for (const item of items ?? []) {
      const parsed = parseRouteItem(item)
      if (!parsed) return `Invalid item: ${item}`
      if (parsed.knownPrefix && !(await exists(parsed.dir))) return `Unknown item: ${item}`
    }
    return null
  }

  /**
   * Categorize an item path into the hook payload shape.
   * Items arrive as e.g. `pages/home`, `fragments/header`,
   * `assets/hero`. Hooks see kind + name + path; if the prefix
   * doesn't match, default to 'asset' (covers loose path forms).
   */
  function toPublishItem(itemPath: string): PublishItem {
    if (itemPath.startsWith('pages/')) {
      return { kind: 'page', name: itemPath.slice('pages/'.length), path: itemPath }
    }
    if (itemPath.startsWith('fragments/')) {
      return { kind: 'fragment', name: itemPath.slice('fragments/'.length), path: itemPath }
    }
    return {
      kind: 'asset',
      name: itemPath.startsWith('assets/') ? itemPath.slice('assets/'.length) : itemPath,
      path: itemPath,
    }
  }

  /**
   * Server-side publish gate (Validation Cut 4).
   *
   * Runs `runPublishAudit` for every (target × items) pair the request is
   * asking to publish, applies the per-target `publishAudit.strict`
   * promotion, and returns any error-severity issues. The publish
   * handlers refuse with 409 when this returns non-empty results — the
   * client-side audit modal is the polite UX, this gate is the
   * enforcement layer so a determined client can't bypass.
   *
   * Returns `{ target, issues }` per target that produced errors. Targets
   * with only warns/infos are omitted (errors-only gate).
   */
  async function evaluatePublishGate(
    source: import('../source-context.js').SourceContext,
    targetNames: ReadonlyArray<string>,
    itemPaths: ReadonlyArray<string>,
  ): Promise<Array<{ target: string; issues: Issue[] }>> {
    if (!opts.validators) return []
    const items: Array<{ kind: 'page' | 'fragment'; name: string }> = []
    for (const p of itemPaths) {
      const i = toPublishItem(p)
      if (i.kind === 'page' || i.kind === 'fragment') items.push({ kind: i.kind, name: i.name })
    }
    if (items.length === 0) return []
    const site = await loadSiteFromSource(source, {
      templatesDir: templatesDir ?? `${source.projectSiteDir}/templates`,
    })
    const blocked: Array<{ target: string; issues: Issue[] }> = []
    for (const targetName of targetNames) {
      const targetCfg = source.manifest?.targets?.[targetName]
      const strict = !!targetCfg?.publishAudit?.strict
      const issues = await runPublishAudit({
        items,
        site,
        contentRoot: source.contentRoot,
        storage: source.storage,
        registry: opts.validators,
        cache: source.cache,
        strict,
        targetLocales: targetCfg?.locales,
        templatesDir: site.templatesDir,
      })
      const errors = issues.filter(i => i.severity === 'error')
      if (errors.length > 0) blocked.push({ target: targetName, issues: errors })
    }
    return blocked
  }

  // Background target initialization — lazy, needs the resolved source's
  // projectSiteDir to resolve filesystem target paths. We call resolve()
  // once with undefined (→ default editable) to obtain projectSiteDir.
  let targets: Map<string, StorageProvider> | null = preInitTargets ?? null
  let initPromise: Promise<Map<string, StorageProvider>> | null = null

  async function getTargets(): Promise<Map<string, StorageProvider>> {
    if (targets) return targets
    if (!targetConfigs || Object.keys(targetConfigs).length === 0) {
      targets = new Map()
      return targets
    }
    if (!initPromise) {
      initPromise = (async () => {
        const { createTargetRegistry } = await import('../../targets.js')
        const t = await createTargetRegistry(targetConfigs)
        targets = t
        return t
      })().catch(() => {
        targets = new Map()
        return targets
      })
    }
    return initPromise
  }

  function getTargetConfig(name: string): TargetConfig | undefined {
    return targetConfigs?.[name]
  }

  // First-time dependents lookup against a source target needs the
  // `.gazetta/fragment-deps/` index to be present. Save handlers write
  // it incrementally on every save, but a fresh dev server pointed at
  // a content tree that's never been saved through admin will have an
  // empty index. Rebuild once per (source-target) and memoize the
  // in-flight Promise so concurrent tree badges share one walk.
  const fragmentDepsBackfill = new Map<string, Promise<void>>()
  async function ensureFragmentDepsIndex(source: import('../source-context.js').SourceContext): Promise<void> {
    const key = source.targetName ?? '__source__'
    let p = fragmentDepsBackfill.get(key)
    if (p) return p
    p = (async () => {
      const indexRoot = source.contentRoot.path(stateFolderPath('fragment-deps'))
      // Cheap existence probe — if any entry is present, the index has
      // been written at least once and incremental save handlers keep
      // it consistent thereafter.
      const exists = await source.storage.exists(indexRoot)
      if (exists) return
      const { rebuildDepIndex } = await import('../../publish-rendered.js')
      const { FRAGMENT_DEPS } = await import('../../fragment-deps.js')
      const site = await loadSiteFromSource(source)
      await rebuildDepIndex(FRAGMENT_DEPS, site, source.storage, source.contentRoot.rootPath)
    })().catch(err => {
      // Clear on failure so the next caller retries.
      fragmentDepsBackfill.delete(key)
      throw err
    })
    fragmentDepsBackfill.set(key, p)
    return p
  }

  app.get('/api/targets', requireCapability('read:pages'), async c => {
    const t = await getTargets()
    // Resolve once — the site manifest is the same across all
    // targets in this loop. resolve(undefined) returns the source
    // context whose .manifest holds `ai:` and `altText:`.
    const source = await resolve(undefined)
    const site = source.manifest
    return c.json(
      [...t.keys()].map(name => {
        const cfg = getTargetConfig(name)
        // AI alt-text capability — site + target inherit chain. When
        // the site manifest isn't available (legacy/test setups), the
        // feature is reported off uniformly.
        const altResolved = site ? resolveAltConfig(site, cfg) : null
        const altAvailable = site ? isAltAdapterConfigured(site, cfg) : false
        // Runtime capability inspection per
        // `feature-design-process.md`'s capability-gap UX discipline
        // (surface #2 — author-time modal data source). The admin
        // archive modal renders per-target capability badges from
        // these fields; Cut 10 wires the UI.
        const inspection = cfg
          ? inspectTarget(cfg)
          : { has: new Set<string>(), gaps: [] as Array<{ capability: string; reason: string }> }
        return {
          name,
          environment: cfg ? getEnvironment(cfg) : 'local',
          type: cfg ? getType(cfg) : 'static',
          editable: cfg ? isEditable(cfg) : true,
          altText: {
            available: altAvailable,
            // When not configured, the resolved value is null — surface
            // false rather than the hardcoded default so the UI doesn't
            // imply "auto-fire is on" for an unconfigured target.
            auto: altResolved?.auto ?? false,
          },
          capabilities: {
            has: [...inspection.has],
            gaps: inspection.gaps.map(g => ({ capability: g.capability, reason: g.reason })),
          },
        }
      }),
    )
  })

  /**
   * Reverse-dependency lookup for publish UI impact preview.
   * GET /api/dependents?item=fragments/header[&target=staging]
   *   → { pages: string[], fragments: string[] }
   *
   * Reads `.gazetta/fragment-deps/` per-edge sidecars on the requested
   * target (or the source when `target` is omitted or names the source).
   * Save handlers maintain the index incrementally; a fresh dev server
   * with no prior saves triggers a one-time rebuild via
   * `ensureFragmentDepsIndex`. Listings only, no content reads —
   * scales to 10k+ items.
   */
  app.get('/api/dependents', requireCapability('read:pages'), async c => {
    const item = c.req.query('item')
    if (!item || !item.startsWith('fragments/')) {
      return c.json({ error: 'Missing or invalid "item" query (must be fragments/<name>)' }, 400)
    }
    const fragmentName = item.slice('fragments/'.length)
    const targetName = c.req.query('target')
    const sourceName = c.req.query('source')
    try {
      const source = await resolve(sourceName)
      const isTargetTheSource = !targetName || targetName === source.targetName
      if (!isTargetTheSource) {
        const t = await getTargets()
        const targetStorage = t.get(targetName!)
        if (!targetStorage) return c.json({ error: `Unknown target: ${targetName}` }, 400)
        const result = await findDependentsFromSidecars(createContentRoot(targetStorage), { fragment: fragmentName })
        return c.json(result)
      }
      await ensureFragmentDepsIndex(source)
      const result = await findDependentsFromSidecars(source.contentRoot, { fragment: fragmentName })
      return c.json(result)
    } catch (err) {
      return c.json({ error: (err as Error).message }, 500)
    }
  })

  /**
   * Run a publish, yielding progress events. Both the synchronous
   * /api/publish route and the streaming /api/publish/stream route consume
   * this generator. Caller can short-circuit by returning false from the
   * iterator (or break) and we'll stop between items — but storage operations
   * already in flight will complete.
   *
   * Pre-flight validation (unknown targets, invalid templates) is reported as
   * 'fatal' before any 'target-start' event so callers can map to a 4xx.
   */
  async function* runPublish(
    items: string[],
    targetNames: string[],
    sourceName?: string,
  ): AsyncGenerator<PublishProgress> {
    if (!items?.length) {
      yield { kind: 'fatal', error: 'No items specified' }
      return
    }
    if (!targetNames?.length) {
      yield { kind: 'fatal', error: 'No targets specified' }
      return
    }

    // Resolve the source editable target for this publish run.
    let source: Awaited<ReturnType<SourceContextResolver>>
    try {
      source = await resolve(sourceName)
    } catch (err) {
      yield { kind: 'fatal', error: (err as Error).message }
      return
    }
    const { projectSiteDir } = source

    const t = await getTargets()
    for (const name of targetNames) {
      if (!t.has(name)) {
        yield { kind: 'fatal', error: `Unknown target: ${name}` }
        return
      }
    }

    const allItems = await resolveDependencies(source.contentRoot, items)

    console.log(`  Publishing to ${targetNames.length} target(s):`)
    console.log(`    Items: ${items.join(', ')} (+ ${allItems.length - items.length} dependencies)`)
    console.log(`    Targets: ${targetNames.join(', ')}`)

    const tdir = templatesDir ?? `${projectSiteDir}/templates`
    const projectRoot = projectSiteDir.replace(/\/sites\/[^/]+$/, '')
    const templateInfos = await scan(tdir, projectRoot)
    const invalidTpls = templateInfos.filter(t => !t.valid)
    if (invalidTpls.length) {
      yield {
        kind: 'fatal',
        error: 'Cannot publish: invalid templates',
        invalidTemplates: invalidTpls.map(t => ({ name: t.name, errors: t.errors })),
      }
      return
    }
    // Per Cut 7 cutover: per-item hash composition lives inside publishRun
    // (consumes templateInfos, computes per-item hashManifest including
    // fragmentHashes for static-mode pages). Route doesn't precompute.
    const site = await loadSiteFromSource(source, { templatesDir: tdir })

    yield { kind: 'start', targets: targetNames, itemsPerTarget: allItems.length }

    const results: PublishResult[] = []
    for (const targetName of targetNames) {
      const targetStorage = t.get(targetName)!
      const config = getTargetConfig(targetName)
      const isStatic = config ? getType(config) === 'static' : true
      const purgeConfig = config?.cache?.purge

      // Static mode bakes fragments into pages at publish time — if the user
      // picked @header, we must also republish every page that uses it.
      // Expand per-target so ESI targets still get the narrow item set.
      let targetItems = allItems
      if (isStatic) {
        const fragmentItems = items.filter(i => i.startsWith('fragments/'))
        if (fragmentItems.length) {
          const expanded = new Set(allItems)
          for (const frag of fragmentItems) {
            const name = frag.replace('fragments/', '')
            const deps = await findFragmentDependents(source.contentRoot, name)
            for (const p of deps.pages) expanded.add(`pages/${p}`)
          }
          targetItems = [...expanded]
        }
      }

      // Step count: source-copy + per-item render + manifest+index + (purge?)
      const total = 1 + targetItems.length + 1 + (purgeConfig?.type === 'cloudflare' ? 1 : 0)
      yield { kind: 'target-start', target: targetName, total }

      // Buffer for progress events. The route's outer generator yields
      // SSE frames; the shared publishToTarget call and publishRun's
      // onProgress callback can't yield directly (different generator).
      // Events are pushed into this queue inside callbacks and drained
      // after the call. Order preserved (publishRun runs items
      // sequentially per target); the event VALUES (current/total) are
      // computed in the callbacks exactly as before.
      const progressQueue: PublishProgress[] = []
      try {
        let totalFiles = 0

        // current starts at 1: the source-copy tick is consumed inside
        // the shared function and its 'source files' event is yielded
        // right after the call with this value.
        let current = 1

        // Item-string layout (`pages/home:fr`) split into ItemRefs. Static
        // targets emit only page items (fragments are baked); ESI emits
        // both. Static-mode page hash composition (fragmentHashes) is
        // handled inside publishRun when templateInfos is supplied.
        const itemRefs: { kind: 'page' | 'fragment'; name: string; locale?: string }[] = []
        for (const it of targetItems) {
          if (it.startsWith('pages/')) {
            const raw = it.replace('pages/', '')
            const [name, rawLocale] = raw.includes(':') ? raw.split(':') : [raw, undefined]
            const locale = rawLocale ? normalizeLocale(rawLocale) : undefined
            // Locale-qualified: just the requested variant. Else: default
            // + every supported locale (subject to target.locales filter).
            if (locale) {
              itemRefs.push({ kind: 'page', name, locale })
            } else {
              itemRefs.push({ kind: 'page', name })
              const pageLocales = site.pageLocales.get(name)
              if (pageLocales) {
                for (const loc of pageLocales.locales.keys()) {
                  if (config?.locales && !config.locales.includes(loc)) continue
                  itemRefs.push({ kind: 'page', name, locale: loc })
                }
              }
            }
          } else if (it.startsWith('fragments/') && !isStatic) {
            const raw = it.replace('fragments/', '')
            const [name, rawLocale] = raw.includes(':') ? raw.split(':') : [raw, undefined]
            const locale = rawLocale ? normalizeLocale(rawLocale) : undefined
            if (locale) {
              itemRefs.push({ kind: 'fragment', name, locale })
            } else {
              itemRefs.push({ kind: 'fragment', name })
              const fragLocales = site.fragmentLocales.get(name)
              if (fragLocales) {
                for (const loc of fragLocales.locales.keys()) {
                  if (config?.locales && !config.locales.includes(loc)) continue
                  itemRefs.push({ kind: 'fragment', name, locale: loc })
                }
              }
            }
          }
        }

        // Cutover (publish-undo cut 1, #1426): history record, source
        // manifest copy, render loop, sitemap/robots/redirects, the
        // publish generation and the CDN purge all run inside the
        // shared target-publish function. The route keeps target
        // iteration, the locale fan-out above, 404.html, SSE progress
        // emit and the post-publish cache invalidation. Purge scope is
        // explicit: a fragment publish purges everything, otherwise the
        // published pages' URLs.
        const { publishToTarget } = await import('../../publish-target.js')
        const shared = await publishToTarget({
          targetName,
          targetStorage,
          targetConfig: config,
          sourceRoot: source.contentRoot,
          sourceName,
          site,
          siteManifest: source.manifest ?? { name: '(publish)' },
          items: targetItems,
          itemRefs,
          templateInfos,
          purgeScope: targetItems.some(i => i.startsWith('fragments/')) ? 'all' : 'items',
          onProgress: ev => {
            if (ev.kind === 'item-done') {
              const label =
                (ev.result.kind === 'fragment' ? `@${ev.result.name}` : `pages/${ev.result.name}`) +
                (ev.result.locale ? `:${ev.result.locale}` : '')
              current++
              // SSE consumer reads per-item progress; admin UI updates X/N.
              // Yield is bridged via the outer generator below.
              progressQueue.push({ kind: 'progress', target: targetName, current, total, label })
            }
          },
          onHistoryError: message => {
            // History is a best-effort audit layer - a write failure
            // here must not break the publish itself.
            console.warn(`    ${targetName}: history record failed — ${message}`)
          },
        })

        totalFiles += shared.copiedFiles
        yield { kind: 'progress', target: targetName, current: 1, total, label: 'source files' }

        // publishRun doesn't throw on per-target init failure (assets
        // missing → target failed); surface as the same error the inline
        // path used to throw so the per-target try/catch projects to
        // `target-result success: false`.
        const tr = shared.run
        if (tr?.failed) {
          throw new Error(tr.failureReason ?? 'all items failed')
        }
        totalFiles += tr?.filesWritten ?? 0

        // Drain queued progress events from the publishRun callback.
        for (const ev of progressQueue) yield ev
        progressQueue.length = 0

        current++
        yield { kind: 'progress', target: targetName, current, total, label: 'site manifest' }

        // The shared function wrote 404.html for a static target (a
        // generated file, before the generation and the purge, #1430
        // review); generatedFiles carries it, so the count stays.
        totalFiles += shared.generatedFiles.length

        // Purge outcome, in the route's own log format. Missing token
        // or zone stays silent here, as before; a failure is logged,
        // not thrown (#1426).
        if (shared.purge.kind === 'purged-all') {
          console.log(`    ${targetName}: cache purged (all)`)
        } else if (shared.purge.kind === 'purged-urls') {
          console.log(`    ${targetName}: cache purged (${shared.purge.urls.join(', ')})`)
        } else if (shared.purge.kind === 'skipped-no-token') {
          console.log(`    ${targetName}: purge.apiToken not set, skipping cache purge`)
        } else if (shared.purge.kind === 'skipped-no-zone') {
          console.log(`    ${targetName}: zone not found, set purge.zoneId or siteUrl`)
        } else if (shared.purge.kind === 'failed') {
          console.warn(`    ${targetName}: cache purge failed: ${shared.purge.message}`)
        }
        if (purgeConfig?.type === 'cloudflare') {
          current++
          yield { kind: 'progress', target: targetName, current, total, label: 'cache purge' }
        }

        const result: PublishResult = { target: targetName, success: true, copiedFiles: totalFiles }
        results.push(result)
        console.log(`    ${targetName}: ${totalFiles} files`)

        // Publish wrote new manifests to the target's storage. Any
        // SourceContext for that target has a stale cached page /
        // fragment summary. Resolve the target's SourceContext (if
        // the resolver has built one) and invalidate. Cheap; covers
        // the case where the admin UI's active target is the publish
        // destination and the next /api/pages should reflect the
        // newly-published items.
        try {
          const targetSource = await resolve(targetName)
          await Promise.all([
            targetSource.cache.invalidatePrefix('pages:'),
            targetSource.cache.invalidatePrefix('fragments:'),
          ])
        } catch {
          // Resolver may not know this target (registry not configured;
          // legacy single-target setup). Cache invalidation is best-
          // effort; ignore.
        }

        yield { kind: 'target-result', result }
      } catch (err) {
        const error = (err as Error).message
        const result: PublishResult = { target: targetName, success: false, error, copiedFiles: 0 }
        results.push(result)
        console.error(`    ${targetName}: FAILED — ${error}`)
        yield { kind: 'target-result', result }
      }
    }

    yield { kind: 'done', results }
  }

  // Publish routes gate on `publish:non-production` as the baseline.
  // A target whose environment is 'production' additionally requires
  // `publish:production` on the principal (design-auth-rbac.md
  // "Failure mode"). productionGateFailure checks every requested
  // target right after the body is read and BEFORE any hook fires or
  // anything is written: one refused target refuses the whole
  // request, so a mixed staging + production publish never writes
  // the staging half (#1191).
  function productionGateFailure(
    principal: Principal,
    targetNames: ReadonlyArray<string | undefined>,
  ): { code: 'FORBIDDEN'; missing: string[]; role: string; error: string } | null {
    const writesProduction = targetNames.some(name => {
      if (name === undefined) return false
      const config = getTargetConfig(name)
      return config !== undefined && getEnvironment(config) === 'production'
    })
    if (!writesProduction) return null
    if (capabilityGrants(principal.capabilities, 'publish:production')) return null
    return {
      code: 'FORBIDDEN' as const,
      missing: ['publish:production'],
      role: principal.role,
      error: `Role "${principal.role}" does not have capability "publish:production"`,
    }
  }

  app.post('/api/publish', requireCapability('publish:non-production'), async c => {
    const body = (await c.req.json()) as { items: string[]; targets: string[]; source?: string }

    const productionForbidden = productionGateFailure(c.var.principal, body.targets)
    if (productionForbidden) {
      // #1192: record the denied production attempt with the same
      // event shape requireCapability uses for its 403s.
      await c.var.audit?.record({
        action: 'publish',
        outcome: 'forbidden',
        scope: { kind: 'site' },
        metadata: { missingCapabilities: ['publish:production'] },
      })
      return c.json(productionForbidden, 403)
    }

    // #1196: reject malformed or unknown items before anything reads
    // or writes a path built from them.
    const sourceForValidation = await resolve(body.source)
    const itemError = await validateRequestItems(body.items, p =>
      sourceForValidation.storage.exists(sourceForValidation.contentRoot.path(p)),
    )
    if (itemError) return c.json({ error: itemError }, 400)

    // #1526: publishing into the editing source copies the site onto
    // itself. Refuse before hooks, the gate or any write.
    const intoSource = body.targets?.find(t => t === sourceForValidation.targetName)
    if (intoSource) return c.json({ error: `Cannot publish to ${intoSource}: it is the editing source` }, 400)

    // beforePublish hooks per design-hooks.md "Publish lifecycle".
    // Hooks see the requested items + active target; can mutate
    // the item set (drop / reorder / extend) or throw to cancel
    // the operation. One dispatch per target — operators wanting
    // per-target item filtering branch on `target` inside their
    // handler.
    const hookCtx = hooks
      ? buildHookContext({
          principal: c.var.principal,
          storage: (await resolve(body.source)).storage,
          requestId: c.req.header('x-request-id') ?? crypto.randomUUID(),
          site: { name: undefined },
          auditEmit: makeAuditFiringEmitter(c.var.audit),
        })
      : null
    let finalItems = body.items
    if (hooks && hookCtx) {
      try {
        const inputItems = body.items.map(toPublishItem)
        // Dispatch once per target. Cancellation by any handler
        // aborts the entire publish (multi-target).
        let mutated: ReadonlyArray<PublishItem> = inputItems
        for (const target of body.targets) {
          mutated = await dispatchBeforePublish(hooks, target, mutated, hookCtx)
        }
        finalItems = mutated.map(i => i.path)
      } catch (err) {
        if (err instanceof HookCancellation || err instanceof HookTimeout) {
          // Per design-hooks.md Q3 audit lock: cancelled publishes
          // record outcome 'hook-cancelled' (not 'forbidden' — hook
          // policy is operator decision, not a capability denial).
          await c.var.audit.record({
            action: 'publish',
            outcome: 'hook-cancelled',
            scope: { kind: 'site' },
            metadata: {
              items: body.items,
              targets: body.targets,
              source: body.source,
              hookCancelled: err instanceof HookCancellation ? err.hookName : undefined,
              hookTimeout: err instanceof HookTimeout ? err.hookName : undefined,
            },
          })
          return c.json({ code: 'HOOK_CANCELLED' as const, hook: err.hookName, reason: err.message }, 409)
        }
        throw err
      }
    }

    // Server-side publish gate per design-validation.md Cut 4. Runs the
    // same `runPublishAudit` the client-side modal calls; refuses on
    // remaining error-severity issues so a determined client can't
    // bypass the dialog. `publishAudit.strict` is applied per-target.
    const sourceForGate = await resolve(body.source)
    const blocked = await evaluatePublishGate(sourceForGate, body.targets, finalItems)
    if (blocked.length > 0) {
      await c.var.audit.record({
        action: 'publish',
        outcome: 'validation-failed',
        scope: { kind: 'site' },
        metadata: {
          items: finalItems,
          targets: body.targets,
          source: body.source,
          blockedTargets: blocked.map(b => b.target),
        },
      })
      return c.json({ code: 'PUBLISH_AUDIT_FAILED' as const, blocked }, 409)
    }

    // Strict audit mode (#1393, design-audit.md "Strict mode
    // opt-in"): record the publish event BEFORE any target write;
    // a failed recording refuses the publish before anything
    // changes. The post-publish success record below is skipped
    // when this ran.
    const strictPreRecord = c.var.audit?.strict === true
    if (strictPreRecord) {
      const preResult = await c.var.audit.record({
        action: 'publish',
        outcome: 'success',
        scope: { kind: 'site' },
        metadata: { items: finalItems, targets: body.targets, source: body.source },
      })
      if (preResult.failed > 0) {
        return c.json(
          { code: 'AUDIT_FAILED' as const, message: 'Audit recording failed; publish refused (strict mode)' },
          500,
        )
      }
    }

    let results: PublishResult[] = []
    let fatal: PublishProgress | null = null
    for await (const ev of runPublish(finalItems, body.targets, body.source)) {
      if (ev.kind === 'fatal') fatal = ev
      else if (ev.kind === 'done') results = ev.results
    }
    if (fatal) {
      // Under strict mode the pre-write event already claims the
      // publish; a second event records the failure so the log
      // stays honest (#1393).
      if (strictPreRecord) {
        await c.var.audit.record({
          action: 'publish',
          outcome: 'write-failed',
          scope: { kind: 'site' },
          metadata: { items: finalItems, targets: body.targets, source: body.source },
        })
      }
      const status = fatal.error.startsWith('Cannot publish') ? 400 : 400
      return c.json(
        { error: fatal.error, ...(fatal.invalidTemplates ? { invalidTemplates: fatal.invalidTemplates } : {}) },
        status,
      )
    }
    const allSuccess = results.every(r => r.success)
    // Audit: one event per publish operation. metadata carries the
    // requested items + targets for forensic queries; per-item
    // events would explode volume on multi-item publishes.
    // Skipped when strict mode already recorded above (#1393).
    if (!strictPreRecord) {
      await c.var.audit.record({
        action: 'publish',
        outcome: 'success',
        scope: { kind: 'site' },
        metadata: { items: finalItems, targets: body.targets, source: body.source },
      })
    }

    // afterPublish hooks per design-hooks.md "Publish lifecycle"
    // step 5. Observational; failures logged. One dispatch per
    // target with that target's per-target result.
    if (hooks && hookCtx) {
      const finalPublishItems = finalItems.map(toPublishItem)
      for (const r of results) {
        const hookResult: PublishHookResult = {
          target: r.target,
          itemsPublished: r.success ? finalPublishItems : [],
          itemsFailed: r.success ? [] : finalPublishItems.map(item => ({ item, reason: r.error ?? 'unknown' })),
        }
        await dispatchAfterPublish(hooks, r.target, hookResult, hookCtx)
      }
    }

    return c.json({ results }, allSuccess ? 200 : 207)
  })

  app.post('/api/publish/stream', requireCapability('publish:non-production'), async c => {
    const body = (await c.req.json()) as { items: string[]; targets: string[]; source?: string }

    const streamProductionForbidden = productionGateFailure(c.var.principal, body.targets)
    if (streamProductionForbidden) {
      // #1192: record the denied production attempt with the same
      // event shape requireCapability uses for its 403s.
      await c.var.audit?.record({
        action: 'publish',
        outcome: 'forbidden',
        scope: { kind: 'site' },
        metadata: { missingCapabilities: ['publish:production'] },
      })
      return c.json(streamProductionForbidden, 403)
    }

    // #1196: reject malformed or unknown items before anything reads
    // or writes a path built from them (synchronous 400, before the
    // SSE stream opens - same surface as the sync route).
    const sourceForValidation = await resolve(body.source)
    const itemError = await validateRequestItems(body.items, p =>
      sourceForValidation.storage.exists(sourceForValidation.contentRoot.path(p)),
    )
    if (itemError) return c.json({ error: itemError }, 400)

    // #1526: publishing into the editing source copies the site onto
    // itself. Refuse before hooks, the gate or any write.
    const intoSource = body.targets?.find(t => t === sourceForValidation.targetName)
    if (intoSource) return c.json({ error: `Cannot publish to ${intoSource}: it is the editing source` }, 400)

    // beforePublish hooks fire BEFORE the SSE stream opens — a
    // cancellation surfaces as a 409 (synchronous) rather than as
    // an SSE 'fatal' event, matching the sync /api/publish path.
    const hookCtx = hooks
      ? buildHookContext({
          principal: c.var.principal,
          storage: (await resolve(body.source)).storage,
          requestId: c.req.header('x-request-id') ?? crypto.randomUUID(),
          site: { name: undefined },
          auditEmit: makeAuditFiringEmitter(c.var.audit),
        })
      : null
    let finalItems = body.items
    if (hooks && hookCtx) {
      try {
        let mutated: ReadonlyArray<PublishItem> = body.items.map(toPublishItem)
        for (const target of body.targets) {
          mutated = await dispatchBeforePublish(hooks, target, mutated, hookCtx)
        }
        finalItems = mutated.map(i => i.path)
      } catch (err) {
        if (err instanceof HookCancellation || err instanceof HookTimeout) {
          // Per design-hooks.md Q3 audit lock: cancelled publishes
          // record outcome 'hook-cancelled' (not 'forbidden' — hook
          // policy is operator decision, not a capability denial).
          await c.var.audit.record({
            action: 'publish',
            outcome: 'hook-cancelled',
            scope: { kind: 'site' },
            metadata: {
              items: body.items,
              targets: body.targets,
              source: body.source,
              hookCancelled: err instanceof HookCancellation ? err.hookName : undefined,
              hookTimeout: err instanceof HookTimeout ? err.hookName : undefined,
            },
          })
          return c.json({ code: 'HOOK_CANCELLED' as const, hook: err.hookName, reason: err.message }, 409)
        }
        throw err
      }
    }

    // Server-side publish gate (mirrors /api/publish). Surfaces as a
    // synchronous 409 before the SSE stream opens, so the client can
    // treat audit-failure identically across the two endpoints.
    const sourceForGate = await resolve(body.source)
    const blocked = await evaluatePublishGate(sourceForGate, body.targets, finalItems)
    if (blocked.length > 0) {
      await c.var.audit.record({
        action: 'publish',
        outcome: 'validation-failed',
        scope: { kind: 'site' },
        metadata: {
          items: finalItems,
          targets: body.targets,
          source: body.source,
          blockedTargets: blocked.map(b => b.target),
        },
      })
      return c.json({ code: 'PUBLISH_AUDIT_FAILED' as const, blocked }, 409)
    }

    // Strict audit mode (#1393): same pre-record as the sync route,
    // placed synchronously BEFORE the SSE stream opens so a failed
    // recording refuses the publish with AUDIT_FAILED and nothing
    // reaches the target. The admin's Publish button calls this
    // endpoint, so without it a strict site would still publish
    // from the admin UI.
    const strictPreRecord = c.var.audit?.strict === true
    if (strictPreRecord) {
      const preResult = await c.var.audit.record({
        action: 'publish',
        outcome: 'success',
        scope: { kind: 'site' },
        metadata: { items: finalItems, targets: body.targets, source: body.source },
      })
      if (preResult.failed > 0) {
        return c.json(
          { code: 'AUDIT_FAILED' as const, message: 'Audit recording failed; publish refused (strict mode)' },
          500,
        )
      }
    }

    return streamSSE(c, async stream => {
      let recordedSuccess = false
      let recordedWriteFailed = false
      const collectedResults: PublishResult[] = []
      // Under strict mode the pre-write record already claims the
      // publish; a fatal (yielded or thrown) gets one compensating
      // 'write-failed' event (#1393).
      const recordWriteFailed = async (): Promise<void> => {
        if (!strictPreRecord || recordedWriteFailed) return
        recordedWriteFailed = true
        await c.var.audit.record({
          action: 'publish',
          outcome: 'write-failed',
          scope: { kind: 'site' },
          metadata: { items: finalItems, targets: body.targets, source: body.source },
        })
      }
      try {
        for await (const ev of runPublish(finalItems, body.targets, body.source)) {
          if (stream.aborted) return
          await stream.writeSSE({ event: ev.kind, data: JSON.stringify(ev) })
          if (ev.kind === 'fatal') {
            await recordWriteFailed()
          }
          if (ev.kind === 'done') {
            // Record once per stream — same shape as the
            // synchronous /api/publish endpoint. Skipped when
            // strict mode already recorded above (#1393).
            if (!strictPreRecord) {
              await c.var.audit.record({
                action: 'publish',
                outcome: 'success',
                scope: { kind: 'site' },
                metadata: { items: finalItems, targets: body.targets, source: body.source },
              })
            }
            recordedSuccess = true
            collectedResults.push(...ev.results)
          }
        }
      } catch (err) {
        await recordWriteFailed()
        if (!stream.aborted) {
          await stream.writeSSE({
            event: 'fatal',
            data: JSON.stringify({ kind: 'fatal', error: (err as Error).message }),
          })
        }
      }
      // afterPublish hooks fire after the stream's `done` event —
      // observational; failures logged via ctx.log without
      // affecting the already-streamed response.
      if (hooks && hookCtx && recordedSuccess) {
        const finalPublishItems = finalItems.map(toPublishItem)
        for (const r of collectedResults) {
          const hookResult: PublishHookResult = {
            target: r.target,
            itemsPublished: r.success ? finalPublishItems : [],
            itemsFailed: r.success ? [] : finalPublishItems.map(item => ({ item, reason: r.error ?? 'unknown' })),
          }
          await dispatchAfterPublish(hooks, r.target, hookResult, hookCtx)
        }
      }
      // Avoid recording a duplicate when the loop completed without
      // a 'done' event (rare — happens if runPublish yields fatal
      // before done). Suppresses double-audit; the absence of a
      // success event is itself the forensic signal.
      void recordedSuccess
    })
  })

  app.post('/api/fetch', requireCapability('publish:non-production'), async c => {
    // `source` (body) — target to fetch FROM (a published target)
    // `destination` (body) — optional editable target to write INTO; defaults
    // to the resolver's default editable target (the author's current source)
    const body = (await c.req.json()) as { source: string; items?: string[]; destination?: string }
    if (!body.source) return c.json({ error: 'Missing "source" target name' }, 400)

    const t = await getTargets()
    const targetStorage = t.get(body.source)
    if (!targetStorage) return c.json({ error: `Unknown target: ${body.source}` }, 400)

    // Resolve the destination editable target for this fetch.
    let destination: Awaited<ReturnType<SourceContextResolver>>
    try {
      destination = await resolve(body.destination)
    } catch (err) {
      return c.json({ error: (err as Error).message }, 400)
    }

    // #1191: gate the RESOLVED destination. An omitted destination
    // resolves to the registry's default editable target, which can be
    // an editable production target; resolve() only reads, so nothing
    // is written before this check.
    const fetchProductionForbidden = productionGateFailure(c.var.principal, [
      destination.targetName ?? body.destination,
    ])
    if (fetchProductionForbidden) {
      // #1192: record the denied production attempt with the same
      // event shape requireCapability uses for its 403s.
      await c.var.audit?.record({
        action: 'publish',
        outcome: 'forbidden',
        scope: { kind: 'site' },
        metadata: { missingCapabilities: ['publish:production'] },
      })
      return c.json(fetchProductionForbidden, 403)
    }

    let items: string[]
    if (body.items?.length) {
      // #1196: same boundary validation against the fetch source.
      const itemError = await validateRequestItems(body.items, p => targetStorage.exists(p))
      if (itemError) return c.json({ error: itemError }, 400)
      items = body.items
    } else {
      items = []
      try {
        if (await targetStorage.exists('pages')) {
          const pages = await targetStorage.readDir('pages')
          for (const p of pages) {
            if (p.isDirectory) items.push(`pages/${p.name}`)
          }
        }
        if (await targetStorage.exists('fragments')) {
          const frags = await targetStorage.readDir('fragments')
          for (const f of frags) {
            if (f.isDirectory) items.push(`fragments/${f.name}`)
          }
        }
        if (await targetStorage.exists('templates')) {
          const tmpls = await targetStorage.readDir('templates')
          for (const t of tmpls) {
            if (t.isDirectory) items.push(`templates/${t.name}`)
          }
        }
      } catch (err) {
        return c.json({ error: `Failed to list target contents: ${(err as Error).message}` }, 500)
      }
    }

    if (items.length === 0) return c.json({ error: 'No content found on target' }, 404)

    console.log(`  Fetching ${items.length} items from "${body.source}":`)
    console.log(`    Items: ${items.join(', ')}`)

    try {
      const targetRoot = createContentRoot(targetStorage)
      const { copiedFiles } = await publishItems(targetRoot, destination.contentRoot, items, {
        includeNestedItems: true,
      })
      console.log(`    ${copiedFiles} files copied to working copy`)
      return c.json({ success: true, copiedFiles, items })
    } catch (err) {
      const error = (err as Error).message
      console.error(`    FAILED — ${error}`)
      return c.json({ error }, 500)
    }
  })

  /**
   * POST /api/publish/audit — runs pre-publish-stage validators against the
   * items operator is about to publish. Returns the consolidated `Issue[]`,
   * with `publishAudit.strict` promotion already applied (warns → errors)
   * for the destination target.
   *
   * The audit is read-only: it doesn't write to storage, doesn't fire hooks,
   * doesn't trigger publish. It's the pre-flight check the publish dialog
   * surfaces before the user clicks "Publish."
   *
   * Server-side enforcement of the audit happens at `POST /api/publish` —
   * this endpoint is the read surface; the gate is the publish handler
   * itself. Defense in depth: client-side dialog uses this endpoint for
   * display; server-side publish re-runs the same audit and refuses on
   * errors, so a determined client can't bypass.
   */
  app.post('/api/publish/audit', requireCapability('publish:non-production'), async c => {
    const parsed = PublishAuditRequestSchema.safeParse(await c.req.json().catch(() => null))
    if (!parsed.success) {
      return c.json({ error: 'expected { target: string, items: SavedItem[] }' }, 400)
    }
    const { target: targetName, items } = parsed.data

    const source = await resolve(c.req.query('target'))
    const site = await loadSiteFromSource(source, {
      templatesDir: templatesDir ?? `${source.projectSiteDir}/templates`,
    })
    const targetCfg = source.manifest?.targets?.[targetName]
    const strict = !!targetCfg?.publishAudit?.strict

    if (!opts.validators) {
      // No validator registry wired; return empty issues.
      return c.json({ issues: [], strict })
    }

    const issues = await runPublishAudit({
      items,
      site,
      contentRoot: source.contentRoot,
      storage: source.storage,
      registry: opts.validators,
      cache: source.cache,
      strict,
      targetLocales: targetCfg?.locales,
      templatesDir: site.templatesDir,
    })

    // Capability-gap UX surface #4 (pre-publish gate) per
    // `feature-design-process.md`'s capability-gap-UX discipline.
    // When the publish set includes any archived items, surface the
    // destination target's capability info so the publish dialog can
    // warn operators (e.g., "this target won't emit 301 redirects").
    const includesArchived = items.some(i => {
      const m = i.kind === 'page' ? site.pages.get(i.name) : site.fragments.get(i.name)
      return m?.archived === true
    })
    let capabilities: { has: string[]; gaps: Array<{ capability: string; reason: string }> } | undefined
    if (includesArchived && targetCfg) {
      const inspection = inspectTarget(targetCfg)
      capabilities = {
        has: [...inspection.has],
        gaps: inspection.gaps.map(g => ({ capability: g.capability, reason: g.reason })),
      }
    }
    return c.json({ issues, strict, ...(capabilities ? { capabilities } : {}) })
  })

  return app
}

/**
 * Build the history `items` for a publish — one entry per published
 * item, content = the source-side manifest. Records semantic authored
 * state (JSON manifests) rather than target-side artifacts (static
 * HTML, fragment indexes), so Restore is a content-level operation.
 *
 * `_targetRoot` is accepted for symmetry with `recordWrite`'s other
 * path-building needs; it's unused today because we hash source
 * content directly and let recordWrite overlay paths relative to the
 * target's rootPath (which is `''` for target-rooted storage, the
 * common case).
 */
