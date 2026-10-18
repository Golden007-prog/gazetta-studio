import type { ManifestKey } from 'gazetta/types'

/**
 * One manifest file: a page or fragment in one locale. Locale variants are
 * whole files with their own components and metadata (page.fr.json), so an
 * edit made on `fr` belongs to `fr` only. Without the locale, a French
 * reorder restored after a reload was saved into page.json (#973).
 */
export type ManifestFileKey = ManifestKey & {
  /** Undefined for the default locale. */
  locale?: string
}

/** Unambiguous for any name: a JSON array. */
export function manifestFileKeyToString(key: ManifestFileKey): string {
  return JSON.stringify([key.kind, key.name, key.locale ?? ''])
}

export function manifestFileKeyFromString(s: string): ManifestFileKey {
  const parsed: unknown = JSON.parse(s)
  if (!Array.isArray(parsed) || parsed.length !== 3) throw new Error(`Invalid manifest file key: ${s}`)
  const [kind, name, locale] = parsed
  if ((kind !== 'page' && kind !== 'fragment') || typeof name !== 'string' || typeof locale !== 'string') {
    throw new Error(`Invalid manifest file key: ${s}`)
  }
  return locale ? { kind, name, locale } : { kind, name }
}
