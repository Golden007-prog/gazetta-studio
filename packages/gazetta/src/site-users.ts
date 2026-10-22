/**
 * In-memory "who uses this item" lookups over a loaded site.
 *
 * The `.gazetta/` dependency indices are derived state and aren't
 * committed, so a fresh clone or a `git pull` can leave them missing
 * or stale (#1139). Checks that refuse or rewrite data find an item's
 * users from the loaded site instead, with the same extraction as the
 * index builders. No storage reads; an in-memory pass is milliseconds
 * at the 5K-page envelope.
 */
import { ARCHIVE_ALIASES } from './archive-aliases.js'
import type { ItemRef, ManifestLike } from './dep-sidecars.js'
import { FRAGMENT_DEPS } from './fragment-deps.js'
import { allFragmentEntries, allPageEntries, type Site } from './site-loader.js'

/**
 * Every archived page or fragment whose `aliasOf` is `name`, as
 * `ARCHIVE_ALIASES.extract` finds them. Locale variants are included
 * with their `locale` set when the variant's own manifest carries the
 * archive fields; in v1 variants share the parent's archive state, so
 * the default-locale entries are the canonical ones.
 */
export function findArchivesAliasingInSite(site: Site, name: string): ItemRef[] {
  const refs: ItemRef[] = []
  for (const entry of allPageEntries(site)) {
    if (ARCHIVE_ALIASES.extract(entry.page as ManifestLike).has(name)) {
      refs.push(
        entry.locale
          ? { source: 'page', name: entry.name, locale: entry.locale }
          : { source: 'page', name: entry.name },
      )
    }
  }
  for (const entry of allFragmentEntries(site)) {
    if (ARCHIVE_ALIASES.extract(entry.fragment as ManifestLike).has(name)) {
      refs.push(
        entry.locale
          ? { source: 'fragment', name: entry.name, locale: entry.locale }
          : { source: 'fragment', name: entry.name },
      )
    }
  }
  return refs
}

/**
 * Every page and fragment, including locale variants, whose components
 * reference `@name`, as `FRAGMENT_DEPS.extract` finds them. Results
 * carry bare names only: a referrer's archive state lives on its
 * default-locale manifest, and archived referrers are excluded (they
 * are aliased, not live).
 */
export function findFragmentUsersInSite(site: Site, name: string): ItemRef[] {
  const refs: ItemRef[] = []
  const seen = new Set<string>()
  for (const entry of allPageEntries(site)) {
    const key = `page:${entry.name}`
    if (seen.has(key)) continue
    if (!FRAGMENT_DEPS.extract(entry.page as ManifestLike).has(name)) continue
    seen.add(key)
    if (site.pages.get(entry.name)?.archived === true) continue
    refs.push({ source: 'page', name: entry.name })
  }
  for (const entry of allFragmentEntries(site)) {
    const key = `fragment:${entry.name}`
    if (seen.has(key)) continue
    if (!FRAGMENT_DEPS.extract(entry.fragment as ManifestLike).has(name)) continue
    seen.add(key)
    if (site.fragments.get(entry.name)?.archived === true) continue
    refs.push({ source: 'fragment', name: entry.name })
  }
  return refs
}
