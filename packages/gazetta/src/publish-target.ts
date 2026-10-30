/**
 * Shared target-publish function (publish-undo cut 1, #1426): one
 * per-target publish pipeline used by the CLI (`gazetta publish`),
 * POST `/api/publish` and `/api/publish/stream`, and - in later cuts -
 * undo/rollback. Per target, in locked order:
 *
 *   0. publishApprovalGate - RESERVED no-op. Review workflow cuts
 *      12-13 build the real publish-approval gate here, before any
 *      write (design-publish-undo.md Q4 / design-target-removal.md
 *      Q13). Do not implement it in this cut.
 *   1. History record - one `publish` revision, baseline pre-publish.
 *   2. Source item copy - own files and ordinary subfolders for bare
 *      items, excluding descendant items; single variant manifests
 *      for `item:locale` forms.
 *   3. Render loop - `publishRun` (per-item renders, dependency
 *      indices, site manifest). Progress events pass through.
 *   4. sitemap.xml / robots.txt / host-format redirects - generated
 *      files are written or DELETED, never skipped: no sitemap
 *      content deletes sitemap.xml; no redirect rows deletes the
 *      redirects file (design-publish-undo.md Q4).
 *   5. `.gazetta/publish-generation` - always written, before the
 *      purge, whether or not a purge is configured (#1125).
 *   6. CDN purge - scope is the caller's explicit option
 *      (`purgeScope`), never caller detection: the CLI purges all;
 *      the admin purges all when fragments were published, else the
 *      published pages' URLs including locale variants. Missing
 *      apiToken/zone skips with a log line; a purge failure is
 *      logged, not thrown.
 *
 * Callers keep: target iteration and init, incremental filtering,
 * locale fan-out into ItemRefs, output formatting (console / SSE),
 * 404.html, and audit. publishRun keeps its per-item behaviour; its
 * step-13 history record and step-13b source copy move HERE so both
 * callers share exactly one history revision and one copy per target,
 * so callers must not pass `history` or `copySourceItems` to
 * publishRun when publishing through this function.
 */

import { createContentRoot, type ContentRoot } from './content-root.js'
import { createHistoryProvider } from './history-provider.js'
import { recordWrite, type WrittenItem } from './history-recorder.js'
import { isHistoryEnabled, getHistoryRetention, getType, type StorageProvider, type TargetConfig } from './types.js'
import { isValidLocale, localeFilename, localeFromFilename } from './locale.js'
import { publishItems } from './publish.js'
import { stateFolderPath } from './state-folders.js'
import { writePublishGeneration } from './publish-generation.js'
import { resolveEnvVars } from './targets.js'
import { trimTrailingSlashes } from './url.js'
import type { Site } from './site-loader.js'
import type { TemplateInfo } from './templates-scan.js'
import type { PublishItemRef, PublishRunResult } from './publish-run.js'

/** How wide the post-publish CDN purge goes. Callers decide; the
 * function never inspects who called. */
export type PurgeScope = 'all' | 'items'

export interface PublishToTargetInput {
  readonly targetName: string
  readonly targetStorage: StorageProvider
  readonly targetConfig: TargetConfig | undefined
  /** Source content root the manifests are copied from. */
  readonly sourceRoot: ContentRoot
  /** Recorded as the history revision's `source`. */
  readonly sourceName: string | undefined
  /** The loaded site the render loop and the redirects rows use. */
  readonly site: Site
  /** Site manifest (site.yaml) - publishRun, sitemap and redirects read it. */
  readonly siteManifest: PublishRunSiteManifest
  /**
   * Item strings (`pages/about`, `pages/about:fr`, `fragments/footer`).
   * Drive the history record, the manifest copy and - for
   * `purgeScope: 'items'` - the set of URLs to purge. Bare items copy
   * their own files and ordinary subfolders, excluding descendant items;
   * history records their default and translation manifests only.
   * Locale-qualified items copy and record exactly that variant.
   */
  readonly items: readonly string[]
  /** Render-loop input; publishRun treats it verbatim. */
  readonly itemRefs: readonly PublishItemRef[]
  readonly templateInfos: readonly TemplateInfo[]
  /** Explicit purge scope - see PurgeScope. */
  readonly purgeScope: PurgeScope
  /** Progress events from publishRun, bridged to the caller's output. */
  readonly onProgress?: Parameters<typeof import('./publish-run.js').publishRun>[0]['onProgress']
  /**
   * Fired when the best-effort history record fails (the publish
   * continues). Callers format their own warning line.
   */
  readonly onHistoryError?: (message: string) => void
}

/** Purge outcome, reported for the caller to format in its own output
 * style (CLI console lines and admin server log lines differ). */
export type PurgeOutcome =
  | { readonly kind: 'none' }
  | { readonly kind: 'skipped-no-token' }
  | { readonly kind: 'skipped-no-zone' }
  | { readonly kind: 'purged-all' }
  | { readonly kind: 'purged-urls'; readonly urls: string[] }
  | { readonly kind: 'failed'; readonly message: string }

type PublishRunSiteManifest = Parameters<typeof import('./publish-run.js').publishRun>[0]['siteManifest']

export interface PublishToTargetResult {
  /** publishRun's per-target aggregate. */
  readonly run: PublishRunResult['targets'][number] | undefined
  /** Manifest files copied in step 2. */
  readonly copiedFiles: number
  /** Generated files written in step 4 (sitemap/robots/redirects). */
  readonly generatedFiles: string[]
  /** Generated files deleted in step 4 (previously live, now empty). */
  readonly deletedFiles: string[]
  /** What the purge step did, for the caller to report. */
  readonly purge: PurgeOutcome
}

/**
 * The approval gate's place (review workflow cuts 12-13 build the real
 * gate here). A publish must pass the gate before ANY write - before
 * the history record - so a refused publish leaves the target and its
 * history untouched. No-op in this cut by design; do not add logic.
 */
async function publishApprovalGate(_input: PublishToTargetInput): Promise<void> {
  // Reserved: design-publish-undo.md Q4, design-target-removal.md Q13.
}

export async function publishToTarget(input: PublishToTargetInput): Promise<PublishToTargetResult> {
  const {
    targetName,
    targetStorage,
    targetConfig,
    sourceRoot,
    sourceName,
    site,
    siteManifest,
    items,
    itemRefs,
    templateInfos,
    purgeScope,
    onProgress,
  } = input
  // Step 0 - the approval gate's place (no-op, see above).
  await publishApprovalGate(input)

  const targetRoot = createContentRoot(targetStorage)

  // Step 1 - history record. Runs BEFORE the manifest copy and the
  // render loop so the recorded baseline captures pre-publish state
  // and `undo` restores it (#1079). One `publish` revision per target
  // for every caller. Best-effort: a history failure never breaks the
  // publish (same rule publishRun's step 13 and the admin route used).
  if (targetConfig && isHistoryEnabled(targetConfig) && items.length > 0) {
    try {
      const history = createHistoryProvider({
        storage: targetStorage,
        retention: getHistoryRetention(targetConfig),
      })
      const historyItems = await collectPublishedItemsForHistory(sourceRoot, items)
      await recordWrite({
        history,
        contentRoot: targetRoot,
        operation: 'publish',
        source: sourceName,
        items: historyItems,
      })
    } catch (err) {
      input.onHistoryError?.((err as Error).message)
    }
  }

  // Step 2 - source item copy. Bare items copy their own files and
  // ordinary subfolders, excluding descendant items (publishItems).
  // A locale-qualified item (`pages/about:fr`) names one variant manifest,
  // copied directly - fail closed on anything isValidLocale rejects (#1174).
  const folderItems: string[] = []
  const variantKeys: string[] = []
  for (const it of items) {
    const m = /^(pages|fragments)\/([^:]+):([^:]+)$/.exec(it)
    if (m) {
      if (isValidLocale(m[3])) {
        variantKeys.push(`${m[1]}/${m[2]}/${localeFilename(m[1] === 'pages' ? 'page' : 'fragment', m[3])}`)
      }
    } else {
      folderItems.push(it)
    }
  }
  // A copy failure fails this target (reported through the same
  // PublishTargetResult shape publishRun would return): publishing
  // without the manifests would leave the step-1 revision describing
  // files the target does not have.
  let copiedFiles = 0
  try {
    copiedFiles = (await publishItems(sourceRoot, targetRoot, folderItems)).copiedFiles
  } catch (err) {
    const failureReason = `source manifest copy failed: ${err instanceof Error ? err.message : String(err)}`
    return {
      run: { name: targetName, failed: true, failureReason, filesWritten: 0, filesRemoved: 0 },
      copiedFiles: 0,
      generatedFiles: [],
      deletedFiles: [],
      purge: { kind: 'none' },
    }
  }
  let variantFiles = 0
  for (const key of variantKeys) {
    try {
      const content = await sourceRoot.storage.readFile(sourceRoot.path(key))
      await targetRoot.storage.writeFile(targetRoot.path(key), content)
      variantFiles++
    } catch {
      // Variant missing on source - publishRun's per-item result
      // reports the item instead.
    }
  }

  // Step 3 - render loop. publishRun owns per-item renders, dependency
  // indices and the site manifest; history and the source copy already
  // happened here, so it runs without its step 13/13b inputs.
  const { publishRun } = await import('./publish-run.js')
  const runResult = await publishRun({
    items: [...itemRefs],
    targets: [targetName],
    site,
    sourceRoot,
    siteManifest,
    targetStorages: new Map([[targetName, targetStorage]]),
    templateInfos: [...templateInfos],
    onProgress,
  })
  const run = runResult.targets.find(t => t.name === targetName)
  // A failed target stops here: the history revision and the manifest
  // copy already landed, but no generated files, no generation bump
  // and no purge - the callers report the failure as they did before
  // this cut (the admin route skipped these steps on a failed target;
  // the edge keeps serving the last good generation).
  if (run?.failed) {
    return {
      run,
      copiedFiles: copiedFiles + variantFiles,
      generatedFiles: [],
      deletedFiles: [],
      purge: { kind: 'none' },
    }
  }

  // Step 4 - generated files: written or deleted, never skipped.
  const generatedFiles: string[] = []
  const deletedFiles: string[] = []
  // 404.html at the root of a static target: plain hosts show it for
  // missing paths (#1152). It is a generated file like the others and
  // goes out before the generation and the purge, as both callers had
  // it (#1430 review).
  const targetType = targetConfig ? getType(targetConfig) : 'static'
  if (targetType === 'static') {
    const { writeStatic404 } = await import('./static-404.js')
    await writeStatic404(targetStorage)
    generatedFiles.push('404.html')
  }
  const siteUrl = targetConfig?.siteUrl
  if (siteUrl) {
    const { listSidecars } = await import('./sidecars.js')
    const { generateSitemap } = await import('./sitemap.js')
    const { generateRobotsTxt } = await import('./robots.js')
    const targetPageSidecars = await listSidecars(targetStorage, 'pages')

    // Merge source-side knowledge for the items published in THIS RUN
    // only: listSidecars may miss just-written entries on R2 due to
    // eventual list-after-write consistency, but a page the target
    // never received must not reach the sitemap (a partial publish
    // would point at 404s, #1430 review). The CLI publishes every
    // page, so its sitemap is unchanged.
    const now = new Date().toISOString()
    for (const ref of itemRefs) {
      if (ref.kind !== 'page') continue
      const key = ref.locale ? `${ref.name}:${ref.locale}` : ref.name
      if (targetPageSidecars.has(key)) continue
      const metadata = ref.locale
        ? site.pageLocales.get(ref.name)?.locales.get(ref.locale)?.metadata
        : site.pages.get(ref.name)?.metadata
      targetPageSidecars.set(key, {
        hash: '',
        pub: { lastPublished: now, noindex: !!metadata?.robots?.includes('noindex') },
      })
    }

    const { resolveSiteLocales, defaultLocaleFor, localeRoutePrefix } = await import('./locale.js')

    // hreflang groups - subpath alternates on this target plus
    // cross-domain alternates from other configured targets.
    const resolvedLoc = resolveSiteLocales(siteManifest)
    const defLoc = defaultLocaleFor(siteManifest)
    const hreflangGroups = new Map<string, { locale: string; url: string }[]>()
    if (resolvedLoc) {
      const allTargets = siteManifest.targets ?? {}
      const thisTargetLocales = targetConfig?.locales ?? resolvedLoc.supported
      const thisTargetDefault = targetConfig?.locale ?? defLoc
      for (const [pageName, page] of site.pages) {
        if (pageName.includes('[')) continue
        const alternates: { locale: string; url: string }[] = []
        if (thisTargetLocales.length > 1) {
          for (const loc of thisTargetLocales) {
            const prefix = localeRoutePrefix(loc, { ...resolvedLoc, default: thisTargetDefault })
            const route = page.route === '/' ? prefix || '/' : `${prefix}${page.route}`
            alternates.push({ locale: loc, url: `${siteUrl}${route}` })
          }
        } else {
          alternates.push({ locale: thisTargetLocales[0] ?? defLoc, url: `${siteUrl}${page.route}` })
        }
        for (const [otherName, otherConfig] of Object.entries(allTargets)) {
          if (otherName === targetName) continue
          if (!otherConfig.siteUrl) continue
          const otherLocales = otherConfig.locales ?? resolvedLoc.supported
          const otherDefault = otherConfig.locale ?? defLoc
          for (const loc of otherLocales) {
            if (alternates.some(a => a.locale === loc)) continue
            const prefix = localeRoutePrefix(loc, { ...resolvedLoc, default: otherDefault })
            const route = page.route === '/' ? prefix || '/' : `${prefix}${page.route}`
            alternates.push({ locale: loc, url: `${otherConfig.siteUrl}${route}` })
          }
        }
        if (alternates.length > 1) {
          hreflangGroups.set(pageName, alternates)
        }
      }
    }

    const sitemapXml = generateSitemap({
      siteUrl,
      pages: targetPageSidecars,
      systemPages: site.manifest.systemPages,
      hreflangGroups: hreflangGroups.size > 0 ? hreflangGroups : undefined,
      defaultLocale: defLoc,
    })
    if (sitemapXml) {
      await targetStorage.writeFile('sitemap.xml', sitemapXml)
      generatedFiles.push('sitemap.xml')
    } else if (await targetStorage.exists('sitemap.xml')) {
      // No URL content: delete a previously published sitemap rather
      // than leaving it live (design-publish-undo.md Q4).
      await targetStorage.rm('sitemap.xml')
      deletedFiles.push('sitemap.xml')
    }

    // robots.txt only at the domain root - Google ignores it at
    // subpaths. A source robots.txt takes precedence, as before.
    const isRootDeploy = !trimTrailingSlashes(new URL(siteUrl).pathname)
    if (isRootDeploy) {
      let robotsTxt: string
      try {
        robotsTxt = await sourceRoot.storage.readFile(sourceRoot.path('robots.txt'))
      } catch {
        robotsTxt = generateRobotsTxt({ siteUrl })
      }
      await targetStorage.writeFile('robots.txt', robotsTxt)
      generatedFiles.push('robots.txt')
    }
  } else if (await targetStorage.exists('sitemap.xml')) {
    // No site URL: there is no sitemap content, so a previously
    // published sitemap comes down rather than staying live
    // (design-publish-undo.md Q4: written or deleted, never skipped).
    await targetStorage.rm('sitemap.xml')
    deletedFiles.push('sitemap.xml')
  }

  // Host-format redirects file (e.g. _redirects). Per
  // design-soft-delete.md Q10: plain-static targets without a worker
  // can't read the per-page HTML marker; this file is the host glue
  // for archive-driven redirects. Independent of siteUrl - the format
  // determines whether to emit at all.
  const redirectsFormat = targetConfig?.redirects?.format
  if (redirectsFormat && redirectsFormat !== 'none') {
    const { emitRedirects } = await import('./runtime/redirects-emit.js')
    const { allPageEntries, deriveRoute } = await import('./site-loader.js')
    const { resolveSiteLocales, localeRoutePrefix } = await import('./locale.js')
    const archives: { from: string; to?: string }[] = []
    // One row per published route: a redirect keeps the visitor's
    // language (#1124). Locale variant entries share the parent's
    // archive state in v1 (per design-soft-delete.md future
    // directions), so rows expand from the default-locale entry.
    const resolvedLoc = resolveSiteLocales(siteManifest)
    // Rows mirror the static write path (staticPageIndexPath): default-
    // locale content is always published unprefixed - the target's
    // locales filter only gates variants - and each published variant
    // lives at /<locale>/. The site default is therefore always in the
    // row set, and prefixes never apply target.locale/defaultPrefix
    // overrides, which the static write path ignores.
    const siteDefault = resolvedLoc?.default ?? ''
    const rowLocales = resolvedLoc
      ? [siteDefault, ...(targetConfig?.locales ?? resolvedLoc.supported).filter(l => l !== siteDefault)]
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
        // publish only writes /<locale>/<page> when the page has that
        // version, while the archived page's own row exists for every
        // published route.
        const destEntry = entry.page.aliasOf ? site.pageLocales.get(entry.page.aliasOf) : undefined
        const destPrefix = loc === '' || loc === siteDefault || (destEntry?.locales.has(loc) ?? false) ? prefix : ''
        const to = baseTo === undefined ? undefined : baseTo === '/' ? destPrefix || '/' : `${destPrefix}${baseTo}`
        archives.push(to !== undefined ? { from, to } : { from })
      }
    }
    const result = emitRedirects(redirectsFormat, archives)
    if (result && result.body !== '') {
      await targetStorage.writeFile(result.filename, result.body)
      generatedFiles.push(result.filename)
    } else if (result && (await targetStorage.exists(result.filename))) {
      // No redirect rows remain: delete a previously published file
      // rather than leaving it live (design-publish-undo.md Q4).
      await targetStorage.rm(result.filename)
      deletedFiles.push(result.filename)
    }
  }

  // Step 5 - the publish generation: after the content and generated
  // files, before the purge, whether or not a purge is configured
  // (#1125).
  await writePublishGeneration(targetStorage)

  // Step 6 - CDN purge. Scope is the caller's explicit option. Missing
  // token or zone skips with a log line; a failure is logged, not
  // thrown. The outcome is returned for the caller to report in its
  // own output style.
  let purge: PurgeOutcome = { kind: 'none' }
  const purgeConfig = targetConfig?.cache?.purge
  if (purgeConfig?.type === 'cloudflare') {
    try {
      const apiToken = resolveEnvVars(purgeConfig.apiToken)
      if (!apiToken) {
        purge = { kind: 'skipped-no-token' }
      } else {
        const { createCloudflarePurge, lookupCloudflareZoneId } = await import('./publish-rendered.js')
        const zoneId =
          resolveEnvVars(purgeConfig.zoneId) ??
          (targetConfig?.siteUrl ? await lookupCloudflareZoneId(targetConfig.siteUrl, apiToken) : null)
        if (!zoneId) {
          purge = { kind: 'skipped-no-zone' }
        } else {
          const purgeClient = createCloudflarePurge(zoneId, apiToken)
          if (purgeScope === 'all') {
            await purgeClient.purgeAll()
            purge = { kind: 'purged-all' }
          } else if (targetConfig?.siteUrl) {
            const publishedPageNames = new Set(
              items.filter(i => i.startsWith('pages/')).map(i => i.replace('pages/', '').split(':')[0]),
            )
            const urls: string[] = []
            const { allPageEntries } = await import('./site-loader.js')
            for (const { name, page } of allPageEntries(site)) {
              if (publishedPageNames.has(name)) {
                urls.push(`${targetConfig.siteUrl}${page.route}`)
              }
            }
            if (urls.length > 0) {
              await purgeClient.purgeUrls(urls)
              purge = { kind: 'purged-urls', urls }
            }
          }
        }
      }
    } catch (err) {
      // Logged, not thrown (design-publish-undo.md cut 1): the publish
      // itself already succeeded.
      purge = { kind: 'failed', message: (err as Error).message }
    }
  }

  return {
    run,
    copiedFiles: copiedFiles + variantFiles,
    generatedFiles,
    deletedFiles,
    purge,
  }
}

/**
 * History item collection for the shared record: bare items record the
 * default manifest plus every translation manifest the folder copy
 * writes; locale-qualified items record exactly the requested variant.
 * (Moved from the admin route's collector; publishRun's step-13 rule
 * applied to what the copy actually writes.)
 */
async function collectPublishedItemsForHistory(
  sourceRoot: ContentRoot,
  publishedItems: readonly string[],
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
      // Fail closed on an invalid locale - it never reaches a path.
      if (isValidLocale(m[3])) names.push(localeFilename(base, m[3]))
    } else {
      // Bare item: record the default and translation manifests in this
      // item's own folder. Descendant items are neither copied nor recorded.
      names.push(localeFilename(base, null))
      try {
        const entries = await sourceRoot.storage.readDir(sourceRoot.path(dir))
        for (const e of entries) {
          if (e.isDirectory) continue
          const locale = localeFromFilename(e.name, base)
          if (locale && isValidLocale(locale)) names.push(localeFilename(base, locale))
        }
      } catch {
        // Folder missing on source - the default-manifest read below
        // skips the item the same way.
      }
    }
    for (const name of names) {
      const key = `${dir}/${name}`
      try {
        const content = await sourceRoot.storage.readFile(sourceRoot.path(key))
        out.push({ path: key, content })
      } catch {
        // Item missing on source - skip; snapshot stays as-was.
      }
    }
  }
  return out
}
