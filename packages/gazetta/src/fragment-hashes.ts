/**
 * Composed fragment hashes for a site, resolved the way rendering resolves
 * a fragment reference: the locale variant (with fallback) and, for an
 * archived fragment, its alias target (#1090). One lookup per locale,
 * memoised, shared by compare, publish and render-for-analysis so they
 * write and read the same hashes.
 */
import { resolveFragmentArchiveAlias } from './archive-helpers.js'
import { composeFragmentHashes } from './hash.js'
import { resolveSiteLocales } from './locale.js'
import { lookupFragmentForLocale } from './resolver.js'
import type { Site } from './site-loader.js'
import type { FragmentManifest } from './types.js'

export type FragmentHashLookup = (locale?: string) => Map<string, string>

export function fragmentHashLookup(site: Site, templateHashes: Map<string, string>): FragmentHashLookup {
  const resolvedLocales = resolveSiteLocales(site.manifest) ?? undefined
  const byLocale = new Map<string, Map<string, string>>()
  return (locale?: string) => {
    const key = locale ?? ''
    const cached = byLocale.get(key)
    if (cached) return cached
    const lookup = (name: string) => lookupFragmentForLocale(name, { site, locale, resolvedLocales })
    const resolve = (name: string): FragmentManifest | null => {
      try {
        return (resolveFragmentArchiveAlias(name, lookup)?.manifest as FragmentManifest | undefined) ?? null
      } catch {
        // Archived without an alias, or an alias cycle: rendering fails too
        // (and validation reports it). Hash the manifest itself.
        return lookup(name)
      }
    }
    const hashes = composeFragmentHashes(site.fragments.keys(), resolve, templateHashes)
    byLocale.set(key, hashes)
    return hashes
  }
}
