/**
 * React rjsf widget for an embedded-asset schema field.
 *
 * Renders the current selection (thumbnail + name) or an empty state, with
 * a "Change" button that calls a picker callback injected via the form
 * context. The callback's body is the admin's `openAssetPicker` (which
 * uses Pinia internally) — this widget depends on the abstraction, not
 * the implementation.
 *
 * Dependency Inversion:
 * - Widget depends on `formContext.onPickAsset`, a Promise-returning fn
 * - The gazetta editor package knows nothing about how the picker is
 *   actually implemented (Vue, React, fullscreen, modal — anything goes)
 * - Admin wires its own implementation when it calls `createEditorMount`
 * - Cross-workspace import boundary is respected (no `apps/admin` imports
 *   from the `packages/gazetta` package)
 *
 * Asset summary fetch:
 * - On mount (and whenever `_asset` changes) the widget fetches the
 *   single-asset summary to render a thumbnail. Missing assets fall back
 *   to the empty state — graceful degradation matches the design doc's
 *   resolver principle.
 */
import React from 'react'
import type { WidgetProps } from '@rjsf/utils'
import { extFromMime } from '../assets/url.js'

interface AssetRefValue {
  _asset?: string
  alt?: string
  focalPoint?: { x: number; y: number }
}

interface AssetSummaryShape {
  name: string
  mime: string
  hash: string
  alt: string | null
}

/** Context the admin supplies — widget depends on the abstract shape. */
interface AssetPickerContext {
  onPickAsset?: (options: { accept?: string[]; currentAssetName?: string | null }) => Promise<{ _asset: string } | null>
  /** Admin API base (e.g. `/admin/api`) — preferred source for summary fetches */
  assetsApiBase?: string
}

function buildThumbnailUrl(summary: AssetSummaryShape): string | null {
  // Images only: any other asset kind (audio, ...) in an <img> is a broken image.
  if (!summary.mime.startsWith('image/')) return null
  const ext = extFromMime(summary.mime)
  if (!ext) return null
  return `/assets/${summary.name}-${summary.hash}.${ext}`
}

export function AssetEmbeddedWidget(props: WidgetProps) {
  const value = (props.value ?? {}) as AssetRefValue
  const assetName = value._asset ?? null

  const [summary, setSummary] = React.useState<AssetSummaryShape | null>(null)
  const [loadError, setLoadError] = React.useState<string | null>(null)

  // Fetch the current selection's summary for thumbnail + alt. Refetches
  // when the selected name changes (e.g., after picker confirms).
  React.useEffect(() => {
    if (!assetName) {
      setSummary(null)
      setLoadError(null)
      return
    }
    let cancelled = false
    // The widget mounts inside the admin's origin; relative URLs resolve
    // against the current page (admin SPA served under `/admin/` in prod,
    // `/` in dev-monorepo). The `/admin/api/...` prefix is added by the
    // admin's build — at runtime we fetch relative to the document.
    const ctx = props.formContext as AssetPickerContext | undefined
    const apiBase = ctx?.assetsApiBase ?? `${resolveAdminBase()}/api`
    fetch(`${apiBase}/assets/${encodeURIComponent(assetName)}`, {
      headers: { 'Content-Type': 'application/json' },
    })
      .then(async res => {
        if (cancelled) return
        if (!res.ok) {
          setSummary(null)
          setLoadError(`Asset "${assetName}" could not be loaded`)
          return
        }
        const data = (await res.json()) as AssetSummaryShape
        setSummary(data)
        setLoadError(null)
      })
      .catch(err => {
        if (!cancelled) {
          setLoadError((err as Error).message)
          setSummary(null)
        }
      })
    return () => {
      cancelled = true
    }
  }, [assetName])

  const accept = readAccept(props.schema)
  const thumbnail = summary ? buildThumbnailUrl(summary) : null

  async function onPick() {
    const onPickAsset = (props.formContext as AssetPickerContext | undefined)?.onPickAsset
    if (!onPickAsset) {
      // Admin didn't wire a picker implementation — nothing we can do.
      // eslint-disable-next-line no-console
      console.warn('[asset-widget] No onPickAsset callback provided in formContext')
      return
    }
    const picked = await onPickAsset({
      accept,
      currentAssetName: assetName ?? null,
    })
    if (!picked) return
    // Preserve per-reference overrides when the author re-picks.
    props.onChange({ ...value, _asset: picked._asset })
  }

  return (
    <div className="gz-asset-widget">
      <div className="gz-asset-widget-preview">
        {thumbnail ? (
          <img src={thumbnail} alt={summary?.alt ?? ''} />
        ) : loadError ? (
          <div className="gz-asset-widget-error">{loadError}</div>
        ) : assetName ? (
          <div className="gz-asset-widget-empty">Loading…</div>
        ) : (
          <div className="gz-asset-widget-empty">No asset selected</div>
        )}
      </div>
      <div className="gz-asset-widget-body">
        <div className="gz-asset-widget-name">{assetName ?? '—'}</div>
        <button type="button" className="gz-asset-widget-pick" data-testid="asset-widget-pick" onClick={onPick}>
          {assetName ? 'Change' : 'Pick'}
        </button>
        {!props.required && assetName && (
          <button
            type="button"
            className="gz-asset-widget-clear"
            data-testid="asset-widget-clear"
            onClick={() => props.onChange(undefined)}
          >
            Clear
          </button>
        )}
      </div>
    </div>
  )
}

/**
 * Resolve the admin API base URL from the current document. In the
 * monorepo dev setup the admin is served at `/admin/`; in site-project
 * dev it's at `/admin/` too; the admin SPA's document is always mounted
 * under the admin path, so we strip everything after `/admin/` and use
 * that as the base for `/api/...` calls.
 *
 * Keeps the widget free of Vite's `import.meta.env` (which would tie
 * this package to a Vite build and break its Node-only tsc).
 */
function resolveAdminBase(): string {
  if (typeof document === 'undefined') return ''
  const href = document.baseURI
  try {
    const url = new URL(href)
    // Strip trailing slash; the widget prepends its own `/api/...`.
    return url.pathname.replace(/\/$/, '')
  } catch {
    return ''
  }
}

/**
 * Read the `accept` filter from the JSON Schema's assetOptions metadata.
 * Zod's `.meta({ assetOptions })` emits the options as a sibling key on
 * the field's schema via `z.toJSONSchema()`.
 */
function readAccept(schema: unknown): string[] | undefined {
  if (!schema || typeof schema !== 'object') return undefined
  const opts = (schema as Record<string, unknown>).assetOptions
  if (!opts || typeof opts !== 'object') return undefined
  const accept = (opts as Record<string, unknown>).accept
  if (Array.isArray(accept) && accept.every(v => typeof v === 'string')) return accept as string[]
  return undefined
}
