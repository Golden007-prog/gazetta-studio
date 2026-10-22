/**
 * HTTP routes for `/api/assets*`.
 *
 * Thin adapters. Each handler:
 *   1. resolves the active target's source context,
 *   2. delegates to the appropriate asset-domain operation,
 *   3. maps success to the HTTP response,
 *   4. delegates error-to-response translation to `respondWithAssetError`.
 *
 * No validation, storage, or orchestration logic in here — the asset
 * domain owns all of that (see `src/assets/`).
 */
import { Hono } from 'hono'
import { enumerateOverrideSlices } from '../../assets/asset-paths.js'
import { deleteAsset } from '../../assets/delete.js'
import { ingestAsset } from '../../assets/ingest.js'
import { ingestLocaleBytes } from '../../assets/ingest-locale.js'
import { listAssets, toSummary } from '../../assets/list.js'
import { readManifest } from '../../assets/manifest.js'
import { removeOverride } from '../../assets/remove-override.js'
import { renameAsset } from '../../assets/rename.js'
import { replaceAsset } from '../../assets/replace.js'
import { updateAssetMetadata, type AssetMetadataPatch } from '../../assets/update-metadata.js'
import { buildSelector, type Selector } from '../../schema/dimensions.js'
import { isValidLocale } from '../../locale.js'
import { isValidTheme } from '../../themes.js'
import { suggestAltForAsset } from '../../alt/route-handler.js'
import { respondWithAssetError } from '../error-response.js'
import { loadSiteFromSource, type SourceContextResolver } from '../source-context.js'
import { requireCapability } from '../middleware/capability.js'
import type { AuditEnv } from '../middleware/audit.js'
import {
  buildHookContext,
  dispatchAfterUpload,
  dispatchBeforeUpload,
  HookCancellation,
  HookTimeout,
  type HookRegistry,
  type UploadHookAsset,
} from '../../hooks/index.js'
import { makeAuditFiringEmitter } from '../hook-audit-emitter.js'

export interface AssetRoutesOptions {
  hooks?: HookRegistry
}

/**
 * Pull a Selector out of the request's query params, validating each
 * dimension's value as it reads. Returns `null` when no dimension is
 * set; throws a Response with a 400 body when any value is malformed.
 *
 * Per design, locale codes are BCP 47 (lowercase) and theme codes are
 * lowercase ASCII non-locale tokens. Reuses the same validators used
 * for filename parsing.
 */
function selectorFromQuery(c: { req: { query: (k: string) => string | undefined } }): Selector | null | Response {
  const locale = c.req.query('locale')
  const theme = c.req.query('theme')
  if (locale === undefined && theme === undefined) return null
  if (locale !== undefined && !isValidLocale(locale)) {
    return new Response(JSON.stringify({ code: 'BAD_REQUEST', message: `Invalid locale code: ${locale}` }), {
      status: 400,
      headers: { 'content-type': 'application/json' },
    })
  }
  if (theme !== undefined && !isValidTheme(theme)) {
    return new Response(JSON.stringify({ code: 'BAD_REQUEST', message: `Invalid theme code: ${theme}` }), {
      status: 400,
      headers: { 'content-type': 'application/json' },
    })
  }
  return buildSelector({
    ...(locale !== undefined ? { locale } : {}),
    ...(theme !== undefined ? { theme } : {}),
  })
}

/** Where assets live, relative to the target storage root. */
const ASSETS_ROOT = 'assets'

export function assetRoutes(resolve: SourceContextResolver, opts: AssetRoutesOptions = {}) {
  const app = new Hono<AuditEnv>()
  const hooks = opts.hooks

  app.get('/api/assets', requireCapability('read:assets'), async c => {
    const source = await resolve(c.req.query('target'))
    try {
      const summaries = await listAssets({
        storage: source.storage,
        assetsRoot: ASSETS_ROOT,
      })
      return c.json(summaries)
    } catch (err) {
      const res = respondWithAssetError(c, err)
      if (res) return res
      throw err
    }
  })

  app.get('/api/assets/:name', requireCapability('read:assets'), async c => {
    const name = c.req.param('name')
    const source = await resolve(c.req.query('target'))
    try {
      const manifest = await readManifest(source.storage, ASSETS_ROOT, name)
      // Single-asset GET — discover overrides via the targeted scan.
      // Cheaper than the full list scan (one readDir of the asset's
      // parent dir) and gives the detail pane its locale chips without
      // a second round-trip.
      const slices = await enumerateOverrideSlices(source.storage, ASSETS_ROOT, manifest)
      const locales: string[] = []
      const themes: string[] = []
      for (const slice of slices) {
        const locale = slice.selector.get('locale')
        const theme = slice.selector.get('theme')
        if (locale !== undefined && !locales.includes(locale)) locales.push(locale)
        if (theme !== undefined && !themes.includes(theme)) themes.push(theme)
      }
      return c.json(toSummary(manifest, locales, themes))
    } catch (err) {
      const res = respondWithAssetError(c, err)
      if (res) return res
      throw err
    }
  })

  /**
   * PATCH /api/assets/:name — update asset metadata.
   *
   * Today's surface: alt only (per design-media.md three-state model).
   * Future: tags, title, description, focalPoint at the asset level.
   *
   * Wire shape preserves three-state alt:
   *   `{}`              — no change to alt
   *   `{"alt": "text"}` — meaningful description
   *   `{"alt": ""}`     — decorative
   *   `{"alt": null}`   — explicitly cleared (resolver falls back to '')
   *
   * Responses:
   *   200 OK            — { manifest }  (updated summary)
   *   400 Bad Request   — alt isn't string|null
   *   404 Not Found     — asset missing
   *   500 Storage       — underlying write failed
   */
  app.patch('/api/assets/:name', requireCapability('edit:assets'), async c => {
    const name = c.req.param('name')
    const source = await resolve(c.req.query('target'))

    let body: unknown
    try {
      body = await c.req.json()
    } catch {
      return c.json({ code: 'BAD_REQUEST', message: 'Invalid JSON body' }, 400)
    }
    if (!body || typeof body !== 'object' || Array.isArray(body)) {
      return c.json({ code: 'BAD_REQUEST', message: 'Body must be an object' }, 400)
    }

    const patch: AssetMetadataPatch = {}
    const raw = body as Record<string, unknown>
    if ('alt' in raw) {
      const v = raw.alt
      if (v !== null && typeof v !== 'string') {
        return c.json({ code: 'BAD_REQUEST', message: 'alt must be string or null' }, 400)
      }
      patch.alt = v
    }
    if ('focalPoint' in raw) {
      const v = raw.focalPoint
      if (v === null) {
        patch.focalPoint = null
      } else if (
        v !== null &&
        typeof v === 'object' &&
        typeof (v as Record<string, unknown>).x === 'number' &&
        typeof (v as Record<string, unknown>).y === 'number'
      ) {
        const fp = v as { x: number; y: number }
        if (fp.x < 0 || fp.x > 1 || fp.y < 0 || fp.y > 1) {
          return c.json({ code: 'BAD_REQUEST', message: 'focalPoint x and y must be in [0, 1]' }, 400)
        }
        patch.focalPoint = fp
      } else {
        return c.json({ code: 'BAD_REQUEST', message: 'focalPoint must be { x: number, y: number } or null' }, 400)
      }
    }

    try {
      const updated = await updateAssetMetadata({
        storage: source.storage,
        assetsRoot: ASSETS_ROOT,
        assetName: name,
        patch,
        history: source.history,
        contentRoot: source.contentRoot,
      })
      // Re-summarize with override locales so the client refresh shape
      // matches GET. Single-asset case uses the same enumerator.
      const slices = await enumerateOverrideSlices(source.storage, ASSETS_ROOT, updated)
      const locales: string[] = []
      const themes: string[] = []
      for (const slice of slices) {
        const locale = slice.selector.get('locale')
        const theme = slice.selector.get('theme')
        if (locale !== undefined && !locales.includes(locale)) locales.push(locale)
        if (theme !== undefined && !themes.includes(theme)) themes.push(theme)
      }
      return c.json({ manifest: toSummary(updated, locales, themes) })
    } catch (err) {
      const res = respondWithAssetError(c, err)
      if (res) return res
      throw err
    }
  })

  app.delete('/api/assets/:name', requireCapability('delete:assets'), async c => {
    const name = c.req.param('name')
    const source = await resolve(c.req.query('target'))
    try {
      await deleteAsset({
        storage: source.storage,
        assetsRoot: ASSETS_ROOT,
        siteDir: source.siteDir,
        assetName: name,
        manifest: source.manifest,
        history: source.history,
        contentRoot: source.contentRoot,
        // Load the site through the source's cache when the source has a
        // manifest; manifest-less sources fall through to deleteAsset's
        // own load with its `(refs-scan)` fallback (#1139).
        site: source.manifest ? await loadSiteFromSource(source) : undefined,
      })
      // 204 No Content — standard REST for successful delete with no body.
      return c.body(null, 204)
    } catch (err) {
      const res = respondWithAssetError(c, err)
      if (res) return res
      throw err
    }
  })

  /**
   * POST /api/assets/:name/replace-with/:newName — atomic replace.
   *
   * Rewrites every reference to `:name` across pages + fragments to
   * point at `:newName`, then deletes the old asset. One history
   * revision covers the whole operation.
   *
   * Responses:
   *   204 No Content        — success
   *   404 Not Found         — either asset missing
   *   409 Kind Mismatch     — kinds/MIME-categories differ
   *   500 Storage Failure   — underlying write/rm failed mid-operation
   */
  /**
   * POST /api/assets/:name/rename-to/:newName — atomic rename.
   *
   * Copies bytes + variants + manifest to `:newName`, rewrites every
   * reference across pages + fragments, and deletes the old asset.
   * One history revision covers the whole operation. URLs to the old
   * asset stay valid until refs are rewritten — safe-order per design.
   *
   * Responses:
   *   204 No Content        — success
   *   404 Not Found         — old asset missing
   *   409 Name Collision    — new name already taken
   *   500 Storage Failure   — underlying read/write/rm failed mid-operation
   */
  app.post('/api/assets/:name/rename-to/:newName', requireCapability('edit:assets'), async c => {
    const oldName = c.req.param('name')
    const newName = c.req.param('newName')
    const source = await resolve(c.req.query('target'))
    try {
      await renameAsset({
        storage: source.storage,
        assetsRoot: ASSETS_ROOT,
        siteDir: source.siteDir,
        oldName,
        newName,
        manifest: source.manifest,
        history: source.history,
        contentRoot: source.contentRoot,
      })
      return c.body(null, 204)
    } catch (err) {
      const res = respondWithAssetError(c, err)
      if (res) return res
      throw err
    }
  })

  app.post('/api/assets/:name/replace-with/:newName', requireCapability('edit:assets'), async c => {
    const oldName = c.req.param('name')
    const newName = c.req.param('newName')
    const source = await resolve(c.req.query('target'))
    try {
      await replaceAsset({
        storage: source.storage,
        assetsRoot: ASSETS_ROOT,
        siteDir: source.siteDir,
        oldName,
        newName,
        manifest: source.manifest,
        history: source.history,
      })
      return c.body(null, 204)
    } catch (err) {
      const res = respondWithAssetError(c, err)
      if (res) return res
      throw err
    }
  })

  /**
   * POST /api/assets/:name/suggest-alt — generate alt text for the
   * named asset using the configured AI adapter.
   *
   * Server fetches asset bytes from storage; client only passes the
   * name and target. Locale (?locale=fr) controls the language the
   * model writes in (direct generation, no translation pipeline).
   *
   * Refusals return 200 with `{ refused: true, refusalReason }` —
   * the API call succeeded; the model declined. UI consumers branch
   * on `refused` to decide whether to surface the text or the reason.
   *
   * Responses:
   *   200 OK            — { text, refused, refusalReason }
   *   400 Bad Request   — invalid locale code
   *   404 Not Found     — asset doesn't exist on this target
   *   502 Bad Gateway   — adapter call failed (network, auth, etc.)
   *   503 Unavailable   — no adapter configured / MIME unsupported
   */
  app.post('/api/assets/:name/suggest-alt', requireCapability('edit:assets'), async c => {
    const name = c.req.param('name')
    const localeRaw = c.req.query('locale')
    if (localeRaw !== undefined && !isValidLocale(localeRaw)) {
      return c.json({ code: 'BAD_REQUEST', message: `Invalid locale code: ${localeRaw}` }, 400)
    }
    const locale = localeRaw ?? 'en'

    const source = await resolve(c.req.query('target'))
    if (!source.manifest) {
      // Without the site manifest we can't read `ai:` / `altText:`
      // config. Treat as unconfigured rather than failing — same
      // posture as a missing block.
      return c.json(
        { code: 'AI_ADAPTER_UNAVAILABLE', message: 'Site manifest not available; AI alt-text not configured.' },
        503,
      )
    }

    const targetConfig = source.targetName ? source.manifest.targets?.[source.targetName] : undefined

    try {
      const result = await suggestAltForAsset({
        name,
        assetsRoot: ASSETS_ROOT,
        storage: source.storage,
        site: source.manifest,
        target: targetConfig,
        gazetta: source.gazettaManifest,
        locale,
      })

      switch (result.kind) {
        case 'ok': {
          // Audit the suggest-alt invocation per design-ai.md +
          // cross-foundation gap #4. Refusal is recorded as
          // metadata.refused: true (the API call succeeded; the
          // model declined — outcome stays 'success'). Provider
          // name + locale + refusalReason carried in metadata so
          // forensic queries can answer "why did this image not
          // get alt?" without re-fetching context.
          await c.var.audit.record({
            action: 'ai-suggest-alt',
            outcome: 'success',
            scope: { kind: 'asset', name },
            metadata: {
              provider: result.provider,
              locale,
              refused: result.suggestion.refused,
              ...(result.suggestion.refused && result.suggestion.refusalReason
                ? { refusalReason: result.suggestion.refusalReason }
                : {}),
            },
          })
          return c.json(result.suggestion, 200)
        }
        case 'unavailable':
          return c.json({ code: 'AI_ADAPTER_UNAVAILABLE', message: result.message }, 503)
        case 'failed':
          return c.json({ code: 'AI_ADAPTER_FAILED', message: result.message }, 502)
        case 'not-found':
          return c.json({ code: 'ASSET_MANIFEST_NOT_FOUND', message: result.message }, 404)
      }
    } catch (err) {
      const res = respondWithAssetError(c, err)
      if (res) return res
      throw err
    }
  })

  /**
   * POST /api/assets/:name/locale-bytes — upload a locale (or theme,
   * or compound) bytes override for an existing asset.
   *
   * Selector encoded as query: `?locale=fr` or `?locale=fr&theme=dark`.
   * Both absent is a 400 — this route exists to write a non-default
   * selector. Default-bytes upload uses POST /api/assets.
   *
   * Responses:
   *   201 Created           — { manifest, bytesPath }
   *   400 Bad Request       — invalid selector or empty selector
   *   404 Not Found         — asset doesn't exist
   *   409 Kind Mismatch     — override MIME category differs from default
   *   500 Storage Failure   — underlying write failed
   */
  app.post('/api/assets/:name/locale-bytes', requireCapability('edit:assets'), async c => {
    const name = c.req.param('name')
    const selectorOrErr = selectorFromQuery(c)
    if (selectorOrErr instanceof Response) return selectorOrErr
    if (selectorOrErr === null) {
      return c.json({ code: 'BAD_REQUEST', message: 'Selector required (locale and/or theme)' }, 400)
    }

    const source = await resolve(c.req.query('target'))
    const body = await c.req.parseBody()
    const file = body.file
    if (!(file instanceof File)) {
      return c.json({ code: 'BAD_REQUEST', message: 'Missing or invalid "file" field' }, 400)
    }

    const targetConfig = source.targetName ? source.manifest?.targets?.[source.targetName] : undefined
    const policy = targetConfig?.assets

    try {
      const result = await ingestLocaleBytes({
        storage: source.storage,
        assetsRoot: ASSETS_ROOT,
        assetName: name,
        selector: selectorOrErr,
        bytes: file.stream(),
        policy,
        history: source.history,
        contentRoot: source.contentRoot,
      })
      return c.json({ manifest: result.manifest, bytesPath: result.bytesPath }, 201)
    } catch (err) {
      const res = respondWithAssetError(c, err)
      if (res) return res
      throw err
    }
  })

  /**
   * DELETE /api/assets/:name/locale-bytes — remove one locale (or
   * theme, or compound) bytes override. The default asset is unaffected;
   * the locale falls back to default bytes after removal.
   *
   * Selector encoded as query (same shape as POST). Both absent is a
   * 400 — to delete the default asset, use DELETE /api/assets/:name.
   *
   * Responses:
   *   204 No Content        — success
   *   400 Bad Request       — invalid or empty selector
   *   404 Not Found         — asset or override doesn't exist
   *   500 Storage Failure   — underlying rm failed
   */
  app.delete('/api/assets/:name/locale-bytes', requireCapability('edit:assets'), async c => {
    const name = c.req.param('name')
    const selectorOrErr = selectorFromQuery(c)
    if (selectorOrErr instanceof Response) return selectorOrErr
    if (selectorOrErr === null) {
      return c.json({ code: 'BAD_REQUEST', message: 'Selector required (locale and/or theme)' }, 400)
    }

    const source = await resolve(c.req.query('target'))
    try {
      await removeOverride({
        storage: source.storage,
        assetsRoot: ASSETS_ROOT,
        siteDir: source.siteDir,
        assetName: name,
        selector: selectorOrErr,
        history: source.history,
        contentRoot: source.contentRoot,
        author: '',
      })
      return c.body(null, 204)
    } catch (err) {
      const res = respondWithAssetError(c, err)
      if (res) return res
      throw err
    }
  })

  app.post('/api/assets', requireCapability('edit:assets'), async c => {
    const source = await resolve(c.req.query('target'))

    // Hono's parseBody reads multipart into a { [field]: string | File } map.
    const body = await c.req.parseBody()
    const file = body.file
    const name = body.name
    const altRaw = body.alt

    if (!(file instanceof File)) {
      return c.json({ code: 'BAD_REQUEST', message: 'Missing or invalid "file" field' }, 400)
    }
    if (typeof name !== 'string' || name.length === 0) {
      return c.json({ code: 'BAD_REQUEST', message: 'Missing or invalid "name" field' }, 400)
    }
    // alt: absent → null, empty string → "" (decorative), string → the value
    const alt = typeof altRaw === 'string' ? altRaw : null

    // Pull per-target upload policy from site.config.ts. When the source
    // didn't resolve a named target (legacy static-resolver path) or
    // the site manifest isn't wired, ingest falls back to the default
    // size cap.
    const targetConfig = source.targetName ? source.manifest?.targets?.[source.targetName] : undefined
    const policy = targetConfig?.assets

    // beforeUpload hooks per design-hooks.md "Asset lifecycle".
    // Cut 6 wires hooks BEFORE the ingest pipeline (which runs the
    // existing UploadPreprocessor + UploadAnalyzer internally).
    // Hooks see raw bytes + initial metadata; their mutations flow
    // into ingestAsset.
    //
    // Design's "hooks AFTER preprocessor/analyzer" goal would
    // require ingestAsset to expose internal hook points; deferred
    // until concrete operator demand for analyzer-extracted EXIF
    // / dimensions in beforeUpload. Operators inspecting analyzer
    // output today use afterUpload (sees the persisted manifest).
    let uploadBytes: Uint8Array
    try {
      uploadBytes = new Uint8Array(await file.arrayBuffer())
    } catch (err) {
      return c.json({ code: 'BAD_REQUEST', message: `Failed to read file bytes: ${(err as Error).message}` }, 400)
    }
    let initialAsset: UploadHookAsset = {
      name,
      mime: file.type || 'application/octet-stream',
      size: uploadBytes.byteLength,
      ...(alt !== null ? { alt } : {}),
    }
    const hookCtx = hooks
      ? buildHookContext({
          principal: c.var.principal,
          storage: source.storage,
          target: source.targetName,
          requestId: c.req.header('x-request-id') ?? crypto.randomUUID(),
          site: { name: source.manifest?.name },
          auditEmit: makeAuditFiringEmitter(c.var.audit),
        })
      : null
    if (hooks && hookCtx) {
      try {
        const mutated = await dispatchBeforeUpload(hooks, initialAsset, uploadBytes, hookCtx)
        initialAsset = mutated.asset
        uploadBytes = mutated.bytes
      } catch (err) {
        if (err instanceof HookCancellation || err instanceof HookTimeout) {
          return c.json({ code: 'HOOK_CANCELLED' as const, hook: err.hookName, reason: err.message }, 409)
        }
        throw err
      }
    }

    try {
      const result = await ingestAsset({
        storage: source.storage,
        assetsRoot: ASSETS_ROOT,
        // Wrap the (possibly hook-mutated) bytes back into a stream
        // for ingestAsset's stream-shaped contract. One chunk; the
        // bytes are already in memory (we materialized above).
        bytes: new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(uploadBytes)
            controller.close()
          },
        }),
        requestedName: initialAsset.name,
        alt: initialAsset.alt ?? null,
        uploadedBy: '',
        policy,
        history: source.history,
        contentRoot: source.contentRoot,
      })
      // afterUpload hooks per design-hooks.md "Asset lifecycle"
      // step 5. Observational; failures logged. Sees the persisted
      // hash + final manifest fields (via the asset shape).
      if (hooks && hookCtx) {
        await dispatchAfterUpload(
          hooks,
          {
            ...initialAsset,
            // Manifest's hash is the canonical post-ingest digest.
            // initialAsset.size + name passed through unchanged.
          },
          { asset: initialAsset, hash: result.manifest.hash ?? '' },
          hookCtx,
        )
      }
      return c.json({ manifest: result.manifest, bytesPath: result.bytesPath }, 201)
    } catch (err) {
      const res = respondWithAssetError(c, err)
      if (res) return res
      throw err
    }
  })

  return app
}
