import { createHash } from 'node:crypto'
import type { ComponentEntry, FragmentManifest, PageManifest } from './types.js'

const SIDECAR_RE = /^\.([0-9a-f]{8})\.hash(?:\.([a-z]{2}(?:-[a-z]+)?))?$/
const PUB_SIDECAR_RE = /^\.pub-(\d{8}T\d{6}Z)(-noindex)?(?:\.([a-z]{2}(?:-[a-z]+)?))?$/

/** Build a hash sidecar filename, optionally locale-suffixed. */
export function sidecarNameFor(hash: string, locale?: string): string {
  return locale ? `.${hash}.hash.${locale}` : `.${hash}.hash`
}

/** Parse a hash sidecar filename. Returns { hash, locale? } or null. */
export function parseSidecarName(entryName: string): string | null {
  const m = SIDECAR_RE.exec(entryName)
  return m ? m[1] : null
}

/** Parse locale from a hash sidecar filename. */
export function parseSidecarLocale(entryName: string): string | undefined {
  const m = SIDECAR_RE.exec(entryName)
  return m?.[2] ?? undefined
}

/**
 * Filename-safe encoding for fragment/template names. Fragments can be
 * subfolder-qualified (e.g. "buttons/primary"); we replace `/` with `.`
 * so the name works as a filename component and stays readable in
 * listings.
 *
 * Why `.`: per operations.md, refs are lowercase-kebab-case — `.` is
 * explicitly avoided in ref names ("confuses URL routing"), so using
 * it as the path separator in encoded form is collision-free with
 * the legal input alphabet (letters, digits, `-`, `_`, `/`).
 *
 * The prior `/` ↔ `__` scheme was ambiguous for any input containing
 * `_` (a legitimate character in names like `my_fragment`) — a lone
 * `_` adjacent to `/` encoded to `___` and decoded ambiguously.
 *
 * We reject `.` in inputs at encode time. It's already documented as
 * off-limits in ref names; enforcing it here turns a silent
 * round-trip bug into a loud error for anyone who tries.
 */
export function encodeRefName(name: string): string {
  if (name.includes('.')) {
    throw new Error(
      `Invalid reference name "${name}": dot is reserved for path encoding. ` +
        `Use lowercase-kebab-case with / for subfolders (e.g. "buttons/primary").`,
    )
  }
  return name.replace(/\//g, '.')
}
export function decodeRefName(name: string): string {
  return name.replace(/\./g, '/')
}

/** Compact ISO timestamp for `.pub-` sidecar filenames: `20260417T220000Z`. */
export function compactTimestamp(date: Date = new Date()): string {
  return date
    .toISOString()
    .replace(/[-:]/g, '')
    .replace(/\.\d{3}/, '')
}

/** Parse compact timestamp back to ISO string: `2026-04-17T22:00:00Z`. */
export function parseCompactTimestamp(compact: string): string {
  // 20260417T220000Z → 2026-04-17T22:00:00Z
  return `${compact.slice(0, 4)}-${compact.slice(4, 6)}-${compact.slice(6, 8)}T${compact.slice(9, 11)}:${compact.slice(11, 13)}:${compact.slice(13, 15)}Z`
}

export interface PubSidecar {
  lastPublished: string // ISO timestamp
  noindex: boolean
}

/** `.pub-20260417T220000Z`, `.pub-20260417T220000Z-noindex`, or `.pub-20260417T220000Z.fr` */
export function pubSidecarNameFor(date: Date = new Date(), noindex = false, locale?: string): string {
  const base = `.pub-${compactTimestamp(date)}${noindex ? '-noindex' : ''}`
  return locale ? `${base}.${locale}` : base
}

export function parsePubSidecarName(entryName: string): PubSidecar | null {
  const m = PUB_SIDECAR_RE.exec(entryName)
  if (!m) return null
  return {
    lastPublished: parseCompactTimestamp(m[1]),
    noindex: !!m[2],
  }
}

/** Parse locale from a pub sidecar filename. */
export function parsePubSidecarLocale(entryName: string): string | undefined {
  const m = PUB_SIDECAR_RE.exec(entryName)
  return m?.[3] ?? undefined
}

/**
 * Walk the component tree and substitute template/fragment refs with their
 * hashed forms (`"name#hash"`) using the provided maps. Returns a new
 * normalized structure — input is not mutated.
 *
 * `fragmentHashes` is only provided for static-mode targets where fragments
 * are baked into pages at publish time — a fragment content change must
 * invalidate every page that uses it. In ESI mode fragments are published
 * separately, so pages don't need fragment hashes in their own hash.
 */
function substituteHashes(
  components: ComponentEntry[] | undefined,
  templateHashes: Map<string, string>,
  fragmentHashes?: Map<string, string>,
): ComponentEntry[] | undefined {
  if (!components) return undefined
  return components.map(entry => {
    if (typeof entry === 'string') {
      if (!fragmentHashes || !entry.startsWith('@')) return entry
      const name = entry.slice(1)
      const h = fragmentHashes.get(name)
      return h ? `@${name}#${h}` : entry
    }
    const hash = templateHashes.get(entry.template)
    return {
      name: entry.name,
      template: hash ? `${entry.template}#${hash}` : entry.template,
      content: entry.content,
      components: substituteHashes(entry.components, templateHashes, fragmentHashes),
    }
  })
}

export interface HashManifestOptions {
  templateHashes: Map<string, string>
  /** Fragment content hashes — include only for static-mode page hashing. */
  fragmentHashes?: Map<string, string>
}

/**
 * Compute the content hash for a page or fragment manifest.
 *
 * Substitutes template references with `name#hash` form in memory (source files
 * are not modified), serializes with stable key ordering, then MD5s. A page's
 * metadata counts too: it renders into the page's `<head>`.
 *
 * Result: 8 hex chars.
 */
export function hashManifest(manifest: PageManifest | FragmentManifest, opts: HashManifestOptions): string {
  // Archived manifests may omit `template` (per design-redirect-ui.md
  // Q2 — schema refinement makes template conditionally optional when
  // `archived: true`). The hash still serializes deterministically:
  // missing template normalizes to null, same as content/components do.
  const template = manifest.template
  const rootHash = template !== undefined ? opts.templateHashes.get(template) : undefined
  const normalized: Record<string, unknown> = {
    template: template !== undefined ? (rootHash ? `${template}#${rootHash}` : template) : null,
    content: manifest.content ?? null,
    components: substituteHashes(manifest.components, opts.templateHashes, opts.fragmentHashes) ?? null,
  }
  // Only when it has a field: pages without metadata keep the hash they had
  // before metadata counted, and `{}` renders the same as no metadata.
  const metadata = 'metadata' in manifest ? manifest.metadata : undefined
  if (metadata && Object.keys(metadata).length > 0) normalized.metadata = metadata
  const json = JSON.stringify(normalized, sortedReplacer)
  return createHash('md5').update(json).digest('hex').slice(0, 8)
}

function sortedReplacer(_key: string, value: unknown): unknown {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    const out: Record<string, unknown> = {}
    for (const k of Object.keys(value as Record<string, unknown>).sort()) {
      out[k] = (value as Record<string, unknown>)[k]
    }
    return out
  }
  return value
}
