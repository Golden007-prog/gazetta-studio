import { Hono } from 'hono'
import { streamSSE } from 'hono/streaming'
import { getType, getEnvironment, isEditable, isHistoryEnabled, getHistoryRetention } from '../../types.js'
import type { StorageProvider, TargetConfig } from '../../types.js'
import { writePublishGeneration } from '../../publish-generation.js'
import { publishItems, resolveDependencies, findFragmentDependents, findDependentsFromSidecars } from '../../publish.js'
import { localeFilename, localeFromFilename, isValidLocale } from '../../locale.js'
import type { SourceContextResolver } from '../source-context.js'
import type { PublishResult } from '../../publish.js'
import { createCloudflarePurge, lookupCloudflareZoneId } from '../../publish-rendered.js'
import { loadSiteFromSource } from '../source-context.js'
import { resolveEnvVars } from '../../targets.js'
import { isAltAdapterConfigured } from '../../alt/factory.js'
import { resolveAltConfig } from '../../alt/config.js'
import { inspectTarget } from '../../runtime/runtime-capabilities.js'
import { scanTemplates, type TemplateInfo } from '../../templates-scan.js'
import { createContentRoot } from '../../content-root.js'
import { createHistoryProvider } from '../../history-provider.js'
import { recordWrite, type WrittenItem } from '../../history-recorder.js'
import { requireCapability } from '../middleware/capability.js'
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
import { trimTrailingSlashes } from '../../url.js'

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
    if (name.length === 0) return null
    for (const seg of name.split('/')) {
      if (seg === '' || seg === '.' || seg === '..') return null
    }
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
    const site = await loadSiteFromSource(source)
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
      const indexRoot = source.contentRoot.path('.gazetta', 'fragment-deps')
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

      let current = 0
      // Buffer for publishRun's progress events. The route's outer
      // generator yields SSE frames; publishRun's onProgress callback
      // can't yield directly (different generator). Push events into
      // this queue inside the callback; drain after publishRun resolves.
      // Order preserved (publishRun runs items sequentially per target).
      const progressQueue: PublishProgress[] = []
      try {
        let totalFiles = 0
        const targetRoot = createContentRoot(targetStorage)

        // History must record BEFORE the writes so the baseline
        // revision (emitted automatically by recordWrite on the first
        // call against this target) captures pre-publish state.
        // Otherwise "undo this publish" would restore the post-
        // publish state and no-op. See pages.ts save handler.
        if (config && isHistoryEnabled(config)) {
          try {
            const history = createHistoryProvider({
              storage: targetStorage,
              retention: getHistoryRetention(config),
            })
            const items = await collectPublishedItemsForHistory(source.contentRoot, targetRoot, targetItems)
            await recordWrite({
              history,
              contentRoot: targetRoot,
              operation: 'publish',
              source: sourceName,
              items,
            })
          } catch (err) {
            // History is a best-effort audit layer — a write failure
            // here must not break the publish itself.
            console.warn(`    ${targetName}: history record failed — ${(err as Error).message}`)
          }
        }

        // 1. Source copy
        // A locale-qualified item (`pages/about:fr`) names one manifest
        // variant, not a folder: publishItems would look for a literal
        // `about:fr` directory and copy nothing, leaving the target's
        // old translation manifest under its new HTML. Copy the variant
        // manifest directly; bare items keep the whole-folder copy.
        const folderItems: string[] = []
        const variantKeys: string[] = []
        for (const it of targetItems) {
          const m = /^(pages|fragments)\/([^:]+):([^:]+)$/.exec(it)
          if (m) {
            // The locale part names a file — fail closed on anything
            // isValidLocale rejects (path traversal, dots, bad shape).
            if (isValidLocale(m[3])) {
              variantKeys.push(`${m[1]}/${m[2]}/${localeFilename(m[1] === 'pages' ? 'page' : 'fragment', m[3])}`)
            }
          } else {
            folderItems.push(it)
          }
        }
        const { copiedFiles } = await publishItems(source.contentRoot, targetRoot, folderItems)
        let variantFiles = 0
        for (const key of variantKeys) {
          try {
            const content = await source.contentRoot.storage.readFile(source.contentRoot.path(key))
            await targetRoot.storage.writeFile(targetRoot.path(key), content)
            variantFiles++
          } catch {
            // Variant missing on source — publishRun's per-item result
            // reports the item instead.
          }
        }
        totalFiles += copiedFiles + variantFiles
        current++
        yield { kind: 'progress', target: targetName, current, total, label: 'source files' }

        // Cutover (Cut 7 of publish-pipeline-extraction): asset publish +
        // per-item render loop + dep indices + site manifest now go through
        // `publishRun`. The route keeps history record (above), source-copy
        // (publishItems above), sitemap/robots/redirects/purge (below) and
        // the SSE progress emit. publishRun's onProgress feeds the SSE
        // generator one progress event per item-done; admin's UI counts
        // items toward `total`.
        //
        // Item-string layout (`pages/home:fr`) split into ItemRefs. Static
        // targets emit only page items (fragments are baked); ESI emits
        // both. Static-mode page hash composition (fragmentHashes) is
        // handled inside publishRun when templateInfos is supplied.
        const itemRefs: { kind: 'page' | 'fragment'; name: string; locale?: string }[] = []
        for (const it of targetItems) {
          if (it.startsWith('pages/')) {
            const raw = it.replace('pages/', '')
            const [name, locale] = raw.includes(':') ? raw.split(':') : [raw, undefined]
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
            const [name, locale] = raw.includes(':') ? raw.split(':') : [raw, undefined]
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

        const { publishRun } = await import('../../publish-run.js')
        const runResult = await publishRun({
          items: itemRefs,
          targets: [targetName],
          site,
          sourceRoot: source.contentRoot,
          siteManifest: source.manifest ?? { name: '(publish)' },
          targetStorages: new Map([[targetName, targetStorage]]),
          templateInfos,
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
        })

        // publishRun doesn't throw on per-target init failure (assets
        // missing → target failed); surface as the same error the inline
        // path used to throw so the per-target try/catch projects to
        // `target-result success: false`.
        const tr = runResult.targets.find(t => t.name === targetName)
        if (tr?.failed) {
          throw new Error(tr.failureReason ?? 'all items failed')
        }
        totalFiles += tr?.filesWritten ?? 0

        // Drain queued progress events from the publishRun callback.
        for (const ev of progressQueue) yield ev
        progressQueue.length = 0

        current++
        yield { kind: 'progress', target: targetName, current, total, label: 'site manifest' }

        // 3a. 404.html at the root of a static target: plain hosts show it
        // for missing paths (#1152).
        if (isStatic) {
          const { writeStatic404 } = await import('../../static-404.js')
          await writeStatic404(targetStorage)
          totalFiles++
        }

        // 3b. Sitemap + robots.txt
        const siteUrl = config?.siteUrl
        if (siteUrl) {
          const { listSidecars } = await import('../../sidecars.js')
          const { generateSitemap } = await import('../../sitemap.js')
          const { generateRobotsTxt } = await import('../../robots.js')
          const targetPageSidecars = await listSidecars(targetStorage, 'pages')
          const sitemapXml = generateSitemap({
            siteUrl,
            pages: targetPageSidecars,
            systemPages: site.manifest.systemPages,
          })
          if (sitemapXml) {
            await targetStorage.writeFile('sitemap.xml', sitemapXml)
            totalFiles++
          }
          // robots.txt only at domain root — Google ignores it at subpaths.
          const isRootDeploy = !trimTrailingSlashes(new URL(siteUrl).pathname)
          if (isRootDeploy) {
            let robotsTxt: string
            try {
              robotsTxt = await source.contentRoot.storage.readFile(source.contentRoot.path('robots.txt'))
            } catch {
              robotsTxt = generateRobotsTxt({ siteUrl })
            }
            await targetStorage.writeFile('robots.txt', robotsTxt)
            totalFiles++
          }
        }

        // 3c. Host-format redirects file (e.g. _redirects). Per
        // design-soft-delete.md Q10: plain-static targets without a
        // worker can't read the per-page HTML marker; this file is the
        // host glue for archive-driven redirects. Independent of
        // siteUrl — the format determines whether to emit at all.
        const redirectsFormat = config?.redirects?.format
        if (redirectsFormat && redirectsFormat !== 'none') {
          const { emitRedirects } = await import('../../runtime/redirects-emit.js')
          const { allPageEntries, deriveRoute } = await import('../../site-loader.js')
          const { resolveSiteLocales, localeRoutePrefix } = await import('../../locale.js')
          const archives: { from: string; to?: string }[] = []
          // One row per published route: a redirect keeps the visitor's
          // language (#1124). Locale variant entries share the parent's
          // archive state in v1 (per `design-soft-delete.md` future
          // directions), so rows expand from the default-locale entry.
          const publishManifest = source.manifest ?? { name: '(publish)' }
          const resolvedLoc = resolveSiteLocales(publishManifest)
          // Rows mirror the static write path (staticPageIndexPath):
          // default-locale content is always published unprefixed — the
          // target's locales filter only gates variants — and each
          // published variant lives at /<locale>/. The site default is
          // therefore always in the row set, and prefixes never apply
          // target.locale/defaultPrefix overrides, which the static
          // write path ignores.
          const siteDefault = resolvedLoc?.default ?? ''
          const rowLocales = resolvedLoc
            ? [siteDefault, ...(config?.locales ?? resolvedLoc.supported).filter(l => l !== siteDefault)]
            : ['']
          for (const entry of allPageEntries(site)) {
            if (entry.page.archived !== true) continue
            if (entry.locale) continue
            const baseFrom = deriveRoute(entry.name)
            const baseTo = entry.page.aliasOf ? deriveRoute(entry.page.aliasOf) : undefined
            for (const loc of rowLocales) {
              const prefix = loc
                ? localeRoutePrefix(loc, { ...resolvedLoc!, default: siteDefault, defaultPrefix: false })
                : ''
              const from = baseFrom === '/' ? prefix || '/' : `${prefix}${baseFrom}`
              // A language with no destination version falls back to the
              // destination's default-language page (#1124 Q10): static
              // publish only writes /<locale>/<page> when the page has
              // that version, while the archived page's own row exists
              // for every published route.
              const destEntry = entry.page.aliasOf ? site.pageLocales.get(entry.page.aliasOf) : undefined
              const destPrefix =
                loc === '' || loc === siteDefault || (destEntry?.locales.has(loc) ?? false) ? prefix : ''
              const to =
                baseTo === undefined ? undefined : baseTo === '/' ? destPrefix || '/' : `${destPrefix}${baseTo}`
              archives.push(to !== undefined ? { from, to } : { from })
            }
          }
          const result = emitRedirects(redirectsFormat, archives)
          if (result && result.body !== '') {
            await targetStorage.writeFile(result.filename, result.body)
            totalFiles++
          }
        }

        // Generation after the content and site files, before the purge,
        // whether or not a purge is configured (#1125).
        await writePublishGeneration(targetStorage)

        // 4. Purge CDN cache
        if (purgeConfig?.type === 'cloudflare') {
          const apiToken = resolveEnvVars(purgeConfig.apiToken)
          const zoneId =
            resolveEnvVars(purgeConfig.zoneId) ??
            (config?.siteUrl && apiToken ? await lookupCloudflareZoneId(config.siteUrl, apiToken) : null)
          if (apiToken && zoneId) {
            const purge = createCloudflarePurge(zoneId, apiToken)
            const hasFragments = targetItems.some(i => i.startsWith('fragments/'))
            if (hasFragments) {
              await purge.purgeAll()
              console.log(`    ${targetName}: cache purged (all)`)
            } else if (config?.siteUrl) {
              const siteForUrls = await loadSiteFromSource(source, { templatesDir })
              const publishedPageNames = new Set(
                targetItems.filter(i => i.startsWith('pages/')).map(i => i.replace('pages/', '')),
              )
              // Collect URLs for all published pages including locale variants
              const urls: string[] = []
              const { allPageEntries } = await import('../../site-loader.js')
              for (const { name, page } of allPageEntries(siteForUrls)) {
                if (publishedPageNames.has(name)) {
                  urls.push(`${config.siteUrl}${page.route}`)
                }
              }
              if (urls.length > 0) {
                await purge.purgeUrls(urls)
                console.log(`    ${targetName}: cache purged (${urls.join(', ')})`)
              }
            }
          }
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
  // Production-target gating runs inside the handler when iterating
  // requested targets (per design-auth-rbac.md "Failure mode": publish
  // to a production target requires `publish:production`). Cut 9
  // ships the route-level gate; per-target enforcement lands when
  // the route is rewritten to consult the resolved target's
  // environment field.
  app.post('/api/publish', requireCapability('publish:non-production'), async c => {
    const body = (await c.req.json()) as { items: string[]; targets: string[]; source?: string }

    // #1196: reject malformed or unknown items before anything reads
    // or writes a path built from them.
    const sourceForValidation = await resolve(body.source)
    const itemError = await validateRequestItems(body.items, p =>
      sourceForValidation.storage.exists(sourceForValidation.contentRoot.path(p)),
    )
    if (itemError) return c.json({ error: itemError }, 400)

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

    let results: PublishResult[] = []
    let fatal: PublishProgress | null = null
    for await (const ev of runPublish(finalItems, body.targets, body.source)) {
      if (ev.kind === 'fatal') fatal = ev
      else if (ev.kind === 'done') results = ev.results
    }
    if (fatal) {
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
    await c.var.audit.record({
      action: 'publish',
      outcome: 'success',
      scope: { kind: 'site' },
      metadata: { items: finalItems, targets: body.targets, source: body.source },
    })

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

    // #1196: reject malformed or unknown items before anything reads
    // or writes a path built from them (synchronous 400, before the
    // SSE stream opens - same surface as the sync route).
    const sourceForValidation = await resolve(body.source)
    const itemError = await validateRequestItems(body.items, p =>
      sourceForValidation.storage.exists(sourceForValidation.contentRoot.path(p)),
    )
    if (itemError) return c.json({ error: itemError }, 400)

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

    return streamSSE(c, async stream => {
      let recordedSuccess = false
      const collectedResults: PublishResult[] = []
      try {
        for await (const ev of runPublish(finalItems, body.targets, body.source)) {
          if (stream.aborted) return
          await stream.writeSSE({ event: ev.kind, data: JSON.stringify(ev) })
          if (ev.kind === 'done') {
            // Record once per stream — same shape as the
            // synchronous /api/publish endpoint.
            await c.var.audit.record({
              action: 'publish',
              outcome: 'success',
              scope: { kind: 'site' },
              metadata: { items: finalItems, targets: body.targets, source: body.source },
            })
            recordedSuccess = true
            collectedResults.push(...ev.results)
          }
        }
      } catch (err) {
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
      const { copiedFiles } = await publishItems(targetRoot, destination.contentRoot, items)
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
    const body = await c.req.json().catch(() => null)
    if (!body || typeof body !== 'object') {
      return c.json({ error: 'invalid request body' }, 400)
    }
    const targetName = (body as { target?: unknown }).target
    const items = (body as { items?: unknown }).items
    if (typeof targetName !== 'string' || !Array.isArray(items)) {
      return c.json({ error: 'expected { target: string, items: SavedItem[] }' }, 400)
    }

    const source = await resolve(c.req.query('target'))
    const site = await loadSiteFromSource(source)
    const targetCfg = source.manifest?.targets?.[targetName]
    const strict = !!targetCfg?.publishAudit?.strict

    if (!opts.validators) {
      // No validator registry wired; return empty issues.
      return c.json({ issues: [], strict })
    }

    const issues = await runPublishAudit({
      items: items as Array<{ kind: 'page' | 'fragment'; name: string }>,
      site,
      contentRoot: source.contentRoot,
      storage: source.storage,
      registry: opts.validators,
      cache: source.cache,
      strict,
      templatesDir: site.templatesDir,
    })

    // Capability-gap UX surface #4 (pre-publish gate) per
    // `feature-design-process.md`'s capability-gap-UX discipline.
    // When the publish set includes any archived items, surface the
    // destination target's capability info so the publish dialog can
    // warn operators (e.g., "this target won't emit 301 redirects").
    const itemList = items as Array<{ kind: 'page' | 'fragment'; name: string }>
    const includesArchived = itemList.some(i => {
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
async function collectPublishedItemsForHistory(
  sourceRoot: import('../../content-root.js').ContentRoot,
  _targetRoot: import('../../content-root.js').ContentRoot,
  publishedItems: string[],
): Promise<WrittenItem[]> {
  const out: WrittenItem[] = []
  for (const item of publishedItems) {
    const m = /^(pages|fragments)\/([^:]+)(?::([^:]+))?$/.exec(item)
    if (!m) continue
    const base = m[1] === 'pages' ? 'page' : 'fragment'
    const dir = `${m[1]}/${m[2]}`
    const names: string[] = []
    if (m[3]) {
      // Locale-qualified: exactly the requested variant's manifest.
      // Fail closed on an invalid locale — it never reaches a path.
      if (isValidLocale(m[3])) names.push(localeFilename(base, m[3]))
    } else {
      // Bare item: the copy writes the whole folder, so record the
      // default manifest plus every translation manifest present —
      // publishRun's collectItemsForHistory rule applied to what the
      // route's copy actually writes.
      names.push(localeFilename(base, null))
      try {
        const entries = await sourceRoot.storage.readDir(sourceRoot.path(dir))
        for (const e of entries) {
          if (e.isDirectory) continue
          const locale = localeFromFilename(e.name, base)
          if (locale && isValidLocale(locale)) names.push(localeFilename(base, locale))
        }
      } catch {
        // Folder missing on source — the default-manifest read below
        // skips the item the same way.
      }
    }
    for (const name of names) {
      const key = `${dir}/${name}`
      const sourcePath = sourceRoot.path(key)
      try {
        const content = await sourceRoot.storage.readFile(sourcePath)
        out.push({ path: key, content })
      } catch {
        // Item missing on source (unusual — publish normally reads from
        // source manifests). Skip; snapshot stays as-was for this item.
      }
    }
  }
  return out
}
