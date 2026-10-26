/**
 * Fragment Save — kind-specific wrapper around `saveManifestCore`.
 *
 * Peer of `pages/save.ts`. Differs from Page Save in five places (per
 * Q3 lock — the 5 page-vs-fragment diffs):
 *
 *   1. Loader lookup: `site.fragments` + `site.fragmentLocales` (not
 *      `site.pages` / `site.pageLocales`)
 *   2. Filename: `fragment.json` / `fragment.{locale}.json`
 *   3. No `route` field (Fragments aren't routable) → `etagExtras` is
 *      empty; manifest assembly omits route preservation
 *   4. No `metadata` field carry-through
 *   5. Cache invalidation hits both `fragments:` AND `pages:` because
 *      Fragment References compose into Page summaries (a Fragment
 *      edit can change the rendered Page output)
 *
 * Plus one scanner difference: `RescanCause` is `{ kind: 'fragment',
 * name }` to walk transitive dependents via the Usage Sidecar
 * primitive `findDependentsFromSidecars` — Page Saves use
 * `{ kind: 'manifest', item }` to invalidate just the page.
 *
 * Everything downstream — etag check, validators, beforeSave hooks,
 * history, write, sidecars, audit, afterSave hooks — is the spine.
 */

import { join } from 'node:path'
import { ensureComponentIds } from '../component-ids.js'
import { isValidLocale } from '../locale.js'
import {
  saveManifestCore,
  type SaveAuditRecorder,
  type SavePrincipal,
  type SaveResult,
  type SaveSourceWiring,
} from '../manifest-save.js'
import type { FragmentManifest } from '../types.js'
import type { Site } from '../site-loader.js'
import type { ValidatorRegistry } from '../validation/registry.js'
import type { ValidationScanner } from '../validation/scanner.js'
import type { HookFiringEmitter, HookRegistry } from '../hooks/index.js'

/**
 * Inputs to `saveFragment`. Same shape as `SavePageInput` minus the
 * route field (Fragments aren't routable). Routes destructure their
 * request and pass the parts the pipeline needs.
 */
export interface SaveFragmentInput {
  /** Fragment name (folder name under `fragments/`). */
  readonly name: string
  /** BCP-47 locale when saving a Locale Variant; undefined for default. */
  readonly locale?: string
  /** Incoming manifest body (template/content/components). */
  readonly body: Partial<FragmentManifest> & Record<string, unknown>
  /** Optional save-etag for concurrency check. */
  readonly ifMatch?: string
  /** Loaded site (caller does `loadSiteFromSource(source)` once). */
  readonly site: Site
  /** Source wiring (cache, history, storage, contentRoot, manifest, targetName). */
  readonly source: SaveSourceWiring
  /** Authenticated principal driving this save. */
  readonly principal: SavePrincipal
  /** Audit recorder bound to the request. */
  readonly audit: SaveAuditRecorder
  /** Validator registry built once at admin boot. */
  readonly validators: ValidatorRegistry
  /** Hook registry; absent when no hooks contributed. */
  readonly hooks?: HookRegistry
  /** Audit-firing emitter for hook dispatch. */
  readonly hookAuditEmit?: HookFiringEmitter
  /** Background scanner; absent when scanner not enabled. */
  readonly scanner?: ValidationScanner
  /** Per-request correlation id; fresh UUID when absent. */
  readonly requestId?: string
}

/** Fragment-name-not-found — routes project to 404. */
export class FragmentNotFoundError extends Error {
  constructor(public readonly name: string) {
    super(`Fragment "${name}" not found`)
    this.name = 'FragmentNotFoundError'
  }
}

/** Invalid locale code per `isValidLocale` — routes project to 400. */
export class InvalidLocaleError extends Error {
  constructor(public readonly raw: string) {
    super(`Invalid locale code: "${raw}"`)
    this.name = 'InvalidLocaleError'
  }
}

/**
 * Save a Fragment Manifest. Wraps `saveManifestCore` with the
 * Fragment-specific resolution + assembly. Throws
 * `FragmentNotFoundError` / `InvalidLocaleError` for route-level
 * preconditions; returns `SaveResult` for save outcomes.
 */
export async function saveFragment(input: SaveFragmentInput): Promise<SaveResult> {
  let locale: string | undefined
  if (input.locale !== undefined) {
    if (!isValidLocale(input.locale)) throw new InvalidLocaleError(input.locale)
    locale = input.locale.toLowerCase()
  }

  const defaultFragment = input.site.fragments.get(input.name)
  if (!defaultFragment) throw new FragmentNotFoundError(input.name)

  // Archived fragments are read-only (design-soft-delete.md): refuse
  // before any validation or write, mirroring the page guard (#1340).
  if (defaultFragment.archived === true) {
    return { ok: false, code: 'ARCHIVED', message: 'Archived. Restore to edit.' }
  }
  const localeVariant = locale ? input.site.fragmentLocales.get(input.name)?.locales.get(locale) : undefined
  const fragment = localeVariant ?? defaultFragment

  const components = ensureComponentIds(input.body.components ?? fragment.components)
  // Fragments don't carry route or metadata. Plain three-field manifest.
  const manifest: Record<string, unknown> = {
    template: input.body.template ?? fragment.template,
    content: input.body.content ?? fragment.content,
    components,
  }

  const filename = locale ? `fragment.${locale}.json` : 'fragment.json'
  const manifestPath = join(defaultFragment.dir, filename)

  return saveManifestCore({
    kind: 'fragment',
    name: input.name,
    locale,
    manifest,
    before: fragment as unknown as Record<string, unknown>,
    manifestPath,
    ifMatch: input.ifMatch,
    site: input.site,
    // Fragment Saves invalidate `pages:` too because Fragment
    // References compose into Page summaries (Page summaries reflect
    // resolved fragment content). Order matches what fragments.ts
    // PUT did before the cutover.
    cacheInvalidatePrefixes: ['fragments:', 'pages:'],
    // No route or metadata to fold in — etag is pure manifest.
    etagExtras: {},
    source: input.source,
    audit: input.audit,
    principal: input.principal,
    hookAuditEmit: input.hookAuditEmit,
    validators: input.validators,
    hooks: input.hooks,
    scanner: input.scanner,
    // Scanner cause: Fragment Saves walk transitive dependents via
    // findDependentsFromSidecars (a fragment edit can affect every
    // page that references @{name}). The 'fragment' RescanCause
    // variant tells the scanner to expand the dependency set.
    scannerCause: { kind: 'fragment', name: input.name },
    requestId: input.requestId,
  })
}
