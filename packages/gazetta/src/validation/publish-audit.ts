/**
 * Pre-publish audit orchestrator (Validation Cut 4).
 *
 * Runs every `pre-publish`-stage validator against the items the operator
 * is about to publish. Applies `publishAudit.strict` promotion (warns →
 * errors) when the target opts in. Returns the consolidated Issue[].
 *
 * This is the shared core that both the audit endpoint
 * (`POST /api/publish/audit`) and the publish gate
 * (server-side enforcement at `POST /api/publish`) call. Same code, same
 * results — operator can't bypass the gate by skipping the audit endpoint
 * because the publish handler runs the audit itself.
 *
 * # SOLID lenses
 *
 *   - SRP: this module orchestrates one pre-publish pass. Validators stay
 *     in their files; rendering stays in render-for-analysis.
 *   - DIP: depends on `ValidatorRegistry`, `AdminCache`, `Site` interfaces.
 *   - OCP: adding new pre-publish validators is one entry in the default
 *     registry; this module unchanged.
 */
import type { AdminCache } from '../cache/types.js'
import type { ContentRoot } from '../content-root.js'
import { localeFilename, normalizeLocale, resolveSiteLocales } from '../locale.js'
import { renderPageForAnalysis } from '../render-for-analysis.js'
import { lookupFragmentForLocale } from '../resolver.js'
import type { Site } from '../site-loader.js'
import type { StorageProvider } from '../types.js'
import type { ValidatorRegistry } from './registry.js'
import type { Issue, RenderedOutputAccess, SavedItem } from './types.js'

export interface RunPublishAuditOptions {
  /** Publish-list names may include a `:locale` suffix for a translation. */
  items: ReadonlyArray<{ kind: 'page' | 'fragment'; name: string }>
  site: Site
  contentRoot: ContentRoot
  storage: StorageProvider
  registry: ValidatorRegistry
  /** Reused render-for-analysis cache. When omitted, each call re-renders. */
  cache?: AdminCache
  /** Per-target strict flag — promotes warns to errors when true. */
  strict: boolean
  /** Destination locale filter for variants expanded from bare item names. */
  targetLocales?: readonly string[]
  templatesDir?: string
}

export async function runPublishAudit(opts: RunPublishAuditOptions): Promise<Issue[]> {
  const { items, site, contentRoot, storage, registry, cache, strict, targetLocales, templatesDir } = opts

  const validators = registry.forStage('pre-publish')
  if (validators.length === 0) return []

  // Match the route's publish fanout: bare items include destination-enabled
  // variants, while explicit locale requests retain the renderer's fallback.
  const savedItems: SavedItem[] = []
  const seen = new Set<string>()
  const resolvedLocales = resolveSiteLocales(site.manifest) ?? undefined
  function addItem(kind: SavedItem['kind'], name: string, locale?: string): void {
    const key = `${kind}:${name}:${locale ?? ''}`
    if (seen.has(key)) return
    const variant = kind === 'page' && locale ? site.pageLocales.get(name)?.locales.get(locale) : undefined
    const manifest =
      kind === 'page'
        ? (variant ?? site.pages.get(name))
        : lookupFragmentForLocale(name, { site, locale, resolvedLocales })
    let manifestLocale = variant ? locale : undefined
    if (kind === 'fragment') {
      for (const [candidateLocale, variant] of site.fragmentLocales.get(name)?.locales ?? []) {
        if (variant === manifest) {
          manifestLocale = candidateLocale
          break
        }
      }
    }
    if (!manifest) return
    seen.add(key)
    savedItems.push({
      kind,
      name,
      ...(locale ? { locale } : {}),
      itemPath: `${manifest.dir}/${localeFilename(kind, manifestLocale ?? null)}`,
    })
  }
  for (const i of items) {
    const [name, rawLocale] = i.name.split(':')
    const locale = rawLocale ? normalizeLocale(rawLocale) : undefined
    addItem(i.kind, name, locale)
    if (!locale) {
      const variants = i.kind === 'page' ? site.pageLocales.get(name) : site.fragmentLocales.get(name)
      for (const variantLocale of variants?.locales.keys() ?? []) {
        if (targetLocales && !targetLocales.includes(variantLocale)) continue
        addItem(i.kind, name, variantLocale)
      }
    }
  }
  if (savedItems.length === 0) return []

  const renderedOutput: RenderedOutputAccess | undefined =
    cache && templatesDir
      ? {
          async htmlFor(item: SavedItem) {
            if (item.kind !== 'page') return null
            const out = await renderPageForAnalysis(item.name, { site, cache, templatesDir, locale: item.locale })
            return out?.html ?? null
          },
        }
      : undefined

  const out: Issue[] = []
  for (const v of validators) {
    try {
      const issues = await v.validate({
        stage: 'pre-publish',
        site,
        contentRoot,
        storage,
        scope: { kind: 'pre-publish', items: savedItems },
        renderedOutput,
      })
      out.push(...issues)
    } catch (err) {
      out.push({
        validator: v.name,
        severity: 'info',
        message: `Validator "${v.name}" failed: ${(err as Error).message}`,
        itemPath: savedItems[0]?.itemPath ?? 'site',
      })
    }
  }

  // Strict promotion: warns become errors at the publish gate.
  if (strict) {
    return out.map(issue => (issue.severity === 'warn' ? { ...issue, severity: 'error' as const } : issue))
  }
  return out
}
