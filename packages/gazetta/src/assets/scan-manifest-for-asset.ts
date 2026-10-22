/**
 * Scan a single page/fragment manifest for references to a given asset.
 *
 * Single responsibility: pure recursive walk of one manifest's content +
 * nested inline components, emitting an `AssetRef` per match. No I/O,
 * no site-wide knowledge — this is the inner kernel.
 *
 * Consumers:
 *   - `delete.ts` — `scanManifestForAsset` over the loaded site for
 *     the delete-block usage list (carries `componentPath` detail)
 *   - `asset-deps.ts` — `collectAssetRefs` feeds the `asset-refs`
 *     index builder's `extract`
 *   - `publish-plan.ts` — `collectAssetRefs` resolves each published
 *     manifest's asset dependencies
 *
 * Splitting the walker from the site loader lets both use the same
 * matching logic — the index writer can't call the site-wide scanner
 * for one-manifest updates (wrong granularity, wrong cost).
 *
 * Match shape:
 *   Any object value with a string-valued `_asset` property. The design
 *   reserves the `_` prefix for Gazetta-interpreted fields, so false
 *   positives require authors to violate the convention.
 */
import type { ComponentEntry, ComponentManifest } from '../types.js'
import type { AssetRef } from './refs.js'

export interface ScanManifestInput {
  /** The manifest being scanned (page or fragment). */
  readonly manifest: ComponentManifest
  /** Content-root-relative path of this manifest (for `AssetRef.path`). */
  readonly manifestPath: string
  /** Which `AssetRef.source` discriminator to tag matches with. */
  readonly source: 'page' | 'fragment'
  /** The asset name to look for. */
  readonly assetName: string
}

/**
 * The shape the walker operates on. Any object that might carry content
 * or nested components — covers both `ComponentManifest` (no `name`) and
 * inline components (`name` + the same `content`/`components`). One
 * interface, no union — the walker treats `name` as optional and the
 * structural-path computation falls back to the array index when it's
 * absent.
 */
interface Walkable {
  readonly name?: string
  readonly content?: Record<string, unknown>
  readonly components?: readonly ComponentEntry[]
}

/**
 * Walk `input.manifest` and return every reference to `assetName`. One
 * entry per match — a manifest that references the asset twice (in two
 * different inline components, or twice in the same content blob)
 * produces two entries with different `componentPath` values.
 */
export function scanManifestForAsset(input: ScanManifestInput): AssetRef[] {
  const out: AssetRef[] = []
  walkComponent(input.manifest, '', input, out)
  return out
}

/** Walk a component (page manifest, fragment manifest, or inline child). */
function walkComponent(comp: Walkable, componentPath: string, input: ScanManifestInput, out: AssetRef[]): void {
  if (comp.content) {
    scanValue(comp.content, componentPath, input, out)
  }
  // Fragment refs like "@header" don't carry content here — they're
  // scanned as their own manifests by the orchestrator.
  if (comp.components) {
    for (let i = 0; i < comp.components.length; i++) {
      const child = comp.components[i]
      if (typeof child === 'string') continue
      const childPath = componentPath ? `${componentPath}.${nameFor(child, i)}` : nameFor(child, i)
      walkComponent(child, childPath, input, out)
    }
  }
}

function nameFor(comp: { name?: string }, index: number): string {
  return comp.name ?? `[${index}]`
}

/**
 * Recursively walk a value looking for `{ _asset: "<assetName>", ... }`.
 * Matches only when `_asset` is a string equal to the target — avoids
 * false positives on numeric or unrelated keys.
 */
function scanValue(value: unknown, path: string, input: ScanManifestInput, out: AssetRef[]): void {
  if (value === null || typeof value !== 'object') return

  if (Array.isArray(value)) {
    for (let i = 0; i < value.length; i++) {
      scanValue(value[i], path ? `${path}[${i}]` : `[${i}]`, input, out)
    }
    return
  }

  const obj = value as Record<string, unknown>
  const assetField = obj._asset
  if (typeof assetField === 'string' && assetField === input.assetName) {
    out.push({
      source: input.source,
      path: input.manifestPath,
      // `null` means "the ref is at the manifest's top-level content" —
      // no sentinel string (like "<root>") for UI code to compare against.
      componentPath: path === '' ? null : path,
    })
    // Don't early-return — the asset ref object might itself contain
    // nested refs (a future template that composes embedded refs inside
    // an asset ref). Keep walking.
  }

  for (const [key, child] of Object.entries(obj)) {
    if (key === '_asset') continue
    scanValue(child, path ? `${path}.${key}` : key, input, out)
  }
}

/**
 * Collect every asset name referenced by `manifest`. Companion to
 * `scanManifestForAsset` but returns the *set* of names rather than
 * located refs — for callers that need the dependency list, not the
 * usage breadcrumb. Used by publish to know which assets to copy.
 */
export function collectAssetRefs(manifest: Walkable): Set<string> {
  const names = new Set<string>()
  collectFromComponent(manifest, names)
  return names
}

function collectFromComponent(comp: Walkable, out: Set<string>): void {
  if (comp.content) collectFromValue(comp.content, out)
  if (comp.components) {
    for (const child of comp.components) {
      if (typeof child === 'string') continue
      collectFromComponent(child, out)
    }
  }
}

function collectFromValue(value: unknown, out: Set<string>): void {
  if (value === null || typeof value !== 'object') return
  if (Array.isArray(value)) {
    for (const item of value) collectFromValue(item, out)
    return
  }
  const obj = value as Record<string, unknown>
  if (typeof obj._asset === 'string') out.add(obj._asset)
  for (const [key, child] of Object.entries(obj)) {
    if (key === '_asset') continue
    collectFromValue(child, out)
  }
}
