// Wire-level plumbing (base URL, active-target injection, auth headers)
// lives in `_request.ts` and is shared with other API modules (e.g.
// `api/assets.ts`). Everything in this file is JSON-CRUD specific.
import { API_BASE as BASE, apiUrl, authHeaders, getActiveTarget } from './_request.js'

export { setActiveTargetProvider } from './_request.js'

/**
 * One validation issue surfaced from a save-delta block. Mirrors the server
 * Issue shape from packages/gazetta/src/admin-api/schemas/validation.ts.
 */
export interface ValidationIssue {
  validator: string
  severity: 'error' | 'warn' | 'info'
  message: string
  itemPath: string
  contentPath?: string
  suppressible?: boolean
}

/**
 * Thrown when a save / fragment-update returns 409 with VALIDATION_FAILED.
 * Carries the structured Issue array so the UI can surface the banner with
 * per-issue actions instead of just a string.
 */
export class ValidationFailedError extends Error {
  readonly code = 'VALIDATION_FAILED' as const
  readonly issues: readonly ValidationIssue[]
  constructor(issues: readonly ValidationIssue[]) {
    super(`Validation failed (${issues.length} issue${issues.length === 1 ? '' : 's'})`)
    this.name = 'ValidationFailedError'
    this.issues = issues
  }
}

/**
 * Thrown when POST /api/publish (or /api/publish/stream) returns 409 with
 * code PUBLISH_AUDIT_FAILED — the server-side publish gate ran the same
 * pre-publish audit the dialog uses and refused on remaining error-
 * severity issues. Carries the per-target `blocked` list so the UI can
 * surface the same audit-review UX a determined client tried to bypass.
 */
export class PublishAuditFailedError extends Error {
  readonly code = 'PUBLISH_AUDIT_FAILED' as const
  readonly blocked: ReadonlyArray<{ target: string; issues: ValidationIssue[] }>
  constructor(blocked: ReadonlyArray<{ target: string; issues: ValidationIssue[] }>) {
    super(`Publish blocked: ${blocked.length} target${blocked.length === 1 ? '' : 's'} have validation errors`)
    this.name = 'PublishAuditFailedError'
    this.blocked = blocked
  }
}

/**
 * Thrown when a save / fragment-update returns 409 with code STALE — the
 * server's etag changed between the client's read and write per
 * `design-offline.md` Q3. Carries the server's CURRENT manifest so the
 * conflict UX (Cut 10) can surface a field-by-field diff banner.
 *
 * `currentEtag` is the server's post-mismatch etag — the client uses it
 * to retry by either rebasing the local edit on top of the new manifest
 * or discarding the local edit.
 */
export class StaleSaveError extends Error {
  readonly code = 'STALE' as const
  readonly current: Record<string, unknown>
  readonly currentEtag: string
  constructor(current: Record<string, unknown>, currentEtag: string) {
    super('Save failed: the server has a newer version of this content')
    this.name = 'StaleSaveError'
    this.current = current
    this.currentEtag = currentEtag
  }
}

/**
 * Thrown when POST /api/{pages,fragments} returns 409 with code
 * ARCHIVED_NAME_CONFLICT per design-soft-delete.md Q5 I3 — the
 * requested name belongs to an archived item. Carries the archive
 * details so the UI can prompt Restore / Replace / Move-aside.
 */
export interface ArchivedNameConflictDetails {
  kind: 'page' | 'fragment'
  name: string
  archivedAt?: string
  archivedBy?: string
  aliasOf?: string
  /** True when the archive is a Manual Redirect — restore is refused (#1343). */
  redirect?: boolean
}
export class ArchivedNameConflictError extends Error {
  readonly code = 'ARCHIVED_NAME_CONFLICT' as const
  readonly archive: ArchivedNameConflictDetails
  constructor(archive: ArchivedNameConflictDetails) {
    super(`${archive.kind} "${archive.name}" is archived; choose Restore / Replace / Move aside`)
    this.name = 'ArchivedNameConflictError'
    this.archive = archive
  }
}

async function request<T>(path: string, options?: RequestInit): Promise<T> {
  const res = await fetch(apiUrl(path), {
    ...options,
    headers: authHeaders({ 'Content-Type': 'application/json', ...(options?.headers as Record<string, string>) }),
  })
  if (!res.ok) {
    const body = await res.json().catch(() => ({ error: res.statusText }))
    if (res.status === 409 && body && typeof body === 'object') {
      if (body.code === 'VALIDATION_FAILED') throw new ValidationFailedError(body.issues ?? [])
      if (body.code === 'STALE') throw new StaleSaveError(body.current ?? {}, body.currentEtag ?? '')
      if (body.code === 'ARCHIVED_NAME_CONFLICT') throw new ArchivedNameConflictError(body.archive)
    }
    throw new Error(body.error ?? `Request failed: ${res.status}`)
  }
  return res.json()
}

/**
 * `request<T>` for endpoints that return the save-concurrency `ETag`
 * header (per design-offline.md Q3). Returns the parsed body plus the
 * unquoted etag value when present. Used by `getPageWithEtag` /
 * `getFragmentWithEtag` so offline-aware save flows can echo the etag
 * back as `If-Match` on the next save.
 */
async function requestWithEtag<T>(path: string, options?: RequestInit): Promise<{ data: T; etag: string | null }> {
  const res = await fetch(apiUrl(path), {
    ...options,
    headers: authHeaders({ 'Content-Type': 'application/json', ...(options?.headers as Record<string, string>) }),
  })
  if (!res.ok) {
    const body = await res.json().catch(() => ({ error: res.statusText }))
    if (res.status === 409 && body && typeof body === 'object') {
      if (body.code === 'VALIDATION_FAILED') throw new ValidationFailedError(body.issues ?? [])
      if (body.code === 'STALE') throw new StaleSaveError(body.current ?? {}, body.currentEtag ?? '')
    }
    throw new Error(body.error ?? `Request failed: ${res.status}`)
  }
  const data = (await res.json()) as T
  // RFC-7232 wraps the etag value in quotes; strip them for the typed
  // value the consumer stores. Re-quoted at If-Match send time.
  const raw = res.headers.get('ETag')
  const etag = raw ? raw.replace(/^"(.*)"$/, '$1') : null
  return { data, etag }
}

/**
 * POST to /publish/stream and parse SSE events as they arrive. Calls
 * onProgress for every event including the final 'done'. Returns the
 * 'done' event's results once the stream closes. Throws on 'fatal'.
 *
 * EventSource isn't usable here (it only supports GET), so we read the
 * response body as a stream and parse SSE manually.
 */
async function publishStream(
  items: string[],
  targets: string[],
  onProgress: (ev: PublishProgress) => void,
  options?: { source?: string; signal?: AbortSignal },
): Promise<PublishResult[]> {
  const body: Record<string, unknown> = { items, targets }
  if (options?.source) body.source = options.source
  const res = await fetch(`${BASE}/publish/stream`, {
    method: 'POST',
    headers: authHeaders({ 'Content-Type': 'application/json', Accept: 'text/event-stream' }),
    body: JSON.stringify(body),
    signal: options?.signal,
  })
  if (!res.ok || !res.body) {
    const body = await res.json().catch(() => ({ error: res.statusText }))
    if (
      res.status === 409 &&
      body &&
      typeof body === 'object' &&
      (body as { code?: string }).code === 'PUBLISH_AUDIT_FAILED'
    ) {
      throw new PublishAuditFailedError(
        (body as { blocked?: Array<{ target: string; issues: ValidationIssue[] }> }).blocked ?? [],
      )
    }
    throw new Error(body.error ?? `Stream failed: ${res.status}`)
  }

  const reader = res.body.pipeThrough(new TextDecoderStream()).getReader()
  let buffer = ''
  let results: PublishResult[] = []
  let fatalError: { error: string; invalidTemplates?: { name: string; errors: string[] }[] } | null = null

  while (true) {
    const { value, done } = await reader.read()
    if (done) break
    buffer += value
    // SSE events are separated by blank lines (\n\n)
    let idx: number
    while ((idx = buffer.indexOf('\n\n')) !== -1) {
      const raw = buffer.slice(0, idx)
      buffer = buffer.slice(idx + 2)
      const dataLines: string[] = []
      for (const line of raw.split('\n')) {
        if (line.startsWith('data:')) dataLines.push(line.slice(5).trim())
      }
      if (!dataLines.length) continue
      const ev = JSON.parse(dataLines.join('\n')) as PublishProgress
      onProgress(ev)
      if (ev.kind === 'done') results = ev.results
      else if (ev.kind === 'fatal') fatalError = { error: ev.error, invalidTemplates: ev.invalidTemplates }
    }
  }

  if (fatalError) {
    const err = new Error(fatalError.error) as Error & { invalidTemplates?: { name: string; errors: string[] }[] }
    if (fatalError.invalidTemplates) err.invalidTemplates = fatalError.invalidTemplates
    throw err
  }
  return results
}

// Summary + create request/response types come from the shared schema
// source-of-truth in gazetta/admin-api/schemas. Any drift between these
// and the server's Zod schema is a compile error at build time —
// enforced here rather than at runtime.
import type {
  PageSummary as PageSummaryShape,
  CreatePageRequest as CreatePageRequestShape,
  CreatePageResponse as CreatePageResponseShape,
  PageMetadata as PageMetadataShape,
  FragmentSummary as FragmentSummaryShape,
  CreateFragmentRequest as CreateFragmentRequestShape,
  CreateFragmentResponse as CreateFragmentResponseShape,
  TemplateSummary as TemplateSummaryShape,
  TemplateImpactItem as TemplateImpactItemShape,
  TemplateImpactResponse as TemplateImpactResponseShape,
  FieldSummary as FieldSummaryShape,
  TargetInfo as TargetInfoShape,
  TargetEnvironment as TargetEnvironmentShape,
  TargetType as TargetTypeShape,
  SiteManifest as SiteManifestShape,
  DependentsResponse as DependentsResponseShape,
  CompareResult as CompareResultShape,
  PublishResult as PublishResultShape,
  PublishProgress as PublishProgressShape,
  RevisionSummary as RevisionSummaryShape,
  RevisionOperation as RevisionOperationShape,
  ListHistoryResponse as ListHistoryResponseShape,
  RestoreRevisionResponse as RestoreRevisionResponseShape,
  FetchResponse as FetchResponseShape,
  CreateRedirectRequest as CreateRedirectRequestShape,
  CreateRedirectResponse as CreateRedirectResponseShape,
  AuditEventWire,
  AuditExternalSinkWire,
  AuditQueryResponseWire,
  AuditActionWire,
  AuditOutcomeWire,
  AuditScopeKindWire,
} from 'gazetta/admin-api/schemas'
export type PageSummary = PageSummaryShape
export type CreatePageRequest = CreatePageRequestShape
export type CreatePageResponse = CreatePageResponseShape
export type PageMetadata = PageMetadataShape
export type FragmentSummary = FragmentSummaryShape
export type CreateFragmentRequest = CreateFragmentRequestShape
export type CreateFragmentResponse = CreateFragmentResponseShape
export type TemplateSummary = TemplateSummaryShape
export type TemplateImpactItem = TemplateImpactItemShape
export type TemplateImpactResponse = TemplateImpactResponseShape
export type FieldSummary = FieldSummaryShape
export type TargetInfo = TargetInfoShape
export type TargetEnvironment = TargetEnvironmentShape
export type TargetType = TargetTypeShape
export type SiteManifest = SiteManifestShape
export type DependentsResponse = DependentsResponseShape
export type CompareResult = CompareResultShape
export type PublishResult = PublishResultShape
export type PublishProgress = PublishProgressShape
export type RevisionSummary = RevisionSummaryShape
export type RevisionOperation = RevisionOperationShape
export type ListHistoryResponse = ListHistoryResponseShape
export type RestoreRevisionResponse = RestoreRevisionResponseShape
export type FetchResponse = FetchResponseShape
export type CreateRedirectRequest = CreateRedirectRequestShape
export type CreateRedirectResponse = CreateRedirectResponseShape
export type AuditEvent = AuditEventWire
export type AuditExternalSink = AuditExternalSinkWire
export type AuditQueryResponse = AuditQueryResponseWire
export type AuditAction = AuditActionWire
export type AuditOutcome = AuditOutcomeWire
export type AuditScopeKind = AuditScopeKindWire

/** Filter shape consumed by `GET /api/audit`. */
export interface AuditQueryFilter {
  action?: AuditAction
  outcome?: AuditOutcome
  scopeKind?: AuditScopeKind
  scopeName?: string
  actor?: string
  since?: string
  until?: string
  limit?: number
}

export interface InlineComponent {
  name: string
  template: string
  content?: Record<string, unknown>
  components?: ComponentEntry[]
}
export type ComponentEntry = string | InlineComponent

export interface PageDetail extends PageSummary {
  content?: Record<string, unknown>
  components?: ComponentEntry[]
  metadata?: PageMetadata
  dir: string
  /** Current locale (when loaded via ?locale=) */
  locale?: string
  /** Available locale codes for this page */
  locales?: string[]
}

export interface FragmentDetail extends FragmentSummary {
  content?: Record<string, unknown>
  components?: ComponentEntry[]
  dir: string
  locale?: string
  locales?: string[]
}

/**
 * `AssetSummary` is used by `listAssets` / `getAsset` below; the asset-
 * specific endpoints (`uploadAsset`, `deleteAsset`) and their typed
 * errors (`AssetInUseError`, `AssetKindMismatchError`) live in `./assets.ts`
 * — callers import those directly from `./assets.js`.
 */
import type { AssetSummary } from 'gazetta/schema'

export const api = {
  getSite: () => request<SiteManifest>('/site'),
  /** List pages. Without `target`, uses the active target (auto-appended).
   *  Pass `target` to list from a specific target — used when pre-checking
   *  item availability before switching the active target. */
  getPages: (opts?: { target?: string }) =>
    request<PageSummary[]>(opts?.target ? `/pages?target=${encodeURIComponent(opts.target)}` : '/pages'),
  getPage: (name: string, options?: RequestInit & { locale?: string }) => {
    const path = options?.locale ? `/pages/${name}?locale=${encodeURIComponent(options.locale)}` : `/pages/${name}`
    return request<PageDetail>(path, options)
  },
  /**
   * Same as `getPage` but also returns the server's save-etag (the
   * `ETag` response header per design-offline.md Q3). Offline-aware
   * save flows store this and echo it as `If-Match` on the next save
   * to detect mid-edit drift.
   */
  getPageWithEtag: (name: string, options?: RequestInit & { locale?: string }) => {
    const path = options?.locale ? `/pages/${name}?locale=${encodeURIComponent(options.locale)}` : `/pages/${name}`
    return requestWithEtag<PageDetail>(path, options)
  },
  createPage: (data: CreatePageRequest, opts?: { onConflict?: 'restore' | 'replace' | 'moveAside' }) => {
    const qs = opts?.onConflict ? `?onConflict=${opts.onConflict}` : ''
    return request<CreatePageResponse & { resolution?: string }>(`/pages${qs}`, {
      method: 'POST',
      body: JSON.stringify(data),
    })
  },
  deletePage: (name: string) => request<{ ok: boolean }>(`/pages/${name}`, { method: 'DELETE' }),
  updatePage: (name: string, data: Partial<PageDetail>, opts?: { locale?: string; ifMatch?: string }) => {
    const qs = opts?.locale ? `?locale=${encodeURIComponent(opts.locale)}` : ''
    const headers: Record<string, string> = {}
    if (opts?.ifMatch) headers['If-Match'] = `"${opts.ifMatch}"`
    return request<{ ok: boolean; etag?: string }>(`/pages/${name}${qs}`, {
      method: 'PUT',
      body: JSON.stringify(data),
      headers,
    })
  },
  /** List fragments. See getPages for the `target` option. */
  getFragments: (opts?: { target?: string }) =>
    request<FragmentSummary[]>(opts?.target ? `/fragments?target=${encodeURIComponent(opts.target)}` : '/fragments'),
  getFragment: (name: string, options?: RequestInit & { locale?: string }) => {
    const path = options?.locale
      ? `/fragments/${name}?locale=${encodeURIComponent(options.locale)}`
      : `/fragments/${name}`
    return request<FragmentDetail>(path, options)
  },
  /**
   * Same as `getFragment` but also returns the server's save-etag.
   * See `getPageWithEtag` for the rationale.
   */
  getFragmentWithEtag: (name: string, options?: RequestInit & { locale?: string }) => {
    const path = options?.locale
      ? `/fragments/${name}?locale=${encodeURIComponent(options.locale)}`
      : `/fragments/${name}`
    return requestWithEtag<FragmentDetail>(path, options)
  },
  createFragment: (data: CreateFragmentRequest, opts?: { onConflict?: 'restore' | 'replace' | 'moveAside' }) => {
    const qs = opts?.onConflict ? `?onConflict=${opts.onConflict}` : ''
    return request<CreateFragmentResponse & { resolution?: string }>(`/fragments${qs}`, {
      method: 'POST',
      body: JSON.stringify(data),
    })
  },
  deleteFragment: (name: string) => request<{ ok: boolean }>(`/fragments/${name}`, { method: 'DELETE' }),
  updateFragment: (name: string, data: Partial<FragmentDetail>, opts?: { locale?: string; ifMatch?: string }) => {
    const qs = opts?.locale ? `?locale=${encodeURIComponent(opts.locale)}` : ''
    const headers: Record<string, string> = {}
    if (opts?.ifMatch) headers['If-Match'] = `"${opts.ifMatch}"`
    return request<{ ok: boolean; etag?: string }>(`/fragments/${name}${qs}`, {
      method: 'PUT',
      body: JSON.stringify(data),
      headers,
    })
  },
  getTemplates: () => request<TemplateSummary[]>('/templates'),
  /**
   * Validation Cut 6 — items using a template + their issues from the
   * background scanner. Powers the DevPlayground "Impact" tab + the
   * toolbar banner's "View impact" link.
   */
  getTemplateImpact: (name: string, options?: RequestInit) =>
    request<TemplateImpactResponse>(`/templates/${name}/impact`, options),
  getTemplateSchema: (name: string, options?: RequestInit) =>
    request<Record<string, unknown>>(`/templates/${name}/schema`, options),
  getFields: () => request<FieldSummary[]>('/fields'),
  getTargets: () => request<TargetInfo[]>('/targets'),
  publish: (items: string[], targets: string[]) =>
    request<{ results: PublishResult[] }>('/publish', { method: 'POST', body: JSON.stringify({ items, targets }) }),
  publishStream,
  /**
   * Pre-publish audit (Validation Cut 4). Runs `pre-publish`-stage
   * validators against the items operator is about to publish, applies
   * `publishAudit.strict` promotion, and returns the consolidated
   * issues. The publish dialog calls this before launching the publish
   * stream so authors can fix / ignore-once / abort.
   */
  publishAudit: (target: string, items: ReadonlyArray<{ kind: 'page' | 'fragment'; name: string }>) =>
    request<{ issues: ValidationIssue[]; strict: boolean }>('/publish/audit', {
      method: 'POST',
      body: JSON.stringify({ target, items }),
    }),
  compare: (target: string, options?: RequestInit & { source?: string }) => {
    // `source` explicit wins. Otherwise fall back to the active-target
    // provider (server resolves its own default if neither is set).
    const src = options?.source ?? getActiveTarget()
    const qs = src
      ? `?target=${encodeURIComponent(target)}&source=${encodeURIComponent(src)}`
      : `?target=${encodeURIComponent(target)}`
    return request<CompareResult>(`/compare${qs}`, options)
  },
  getDependents: (item: string, options?: RequestInit) =>
    request<DependentsResponse>(`/dependents?item=${encodeURIComponent(item)}`, options),
  fetchFromTarget: (source: string, items?: string[]) =>
    request<FetchResponse>('/fetch', {
      method: 'POST',
      body: JSON.stringify({ source, items }),
    }),
  /** List revisions on a target, newest first. */
  listHistory: (target: string, limit = 50) =>
    request<ListHistoryResponse>(`/history?target=${encodeURIComponent(target)}&limit=${limit}`),
  /** Undo the most recent write on a target — restores the previous
   *  revision as a forward 'rollback'. 409 when there's nothing to undo. */
  undoLastWrite: (target: string) =>
    request<RestoreRevisionResponse>(`/history/undo?target=${encodeURIComponent(target)}`, {
      method: 'POST',
    }),
  /** Restore an arbitrary revision on a target. 404 when the id doesn't exist. */
  restoreRevision: (target: string, revisionId: string) =>
    request<RestoreRevisionResponse>(
      `/history/restore?target=${encodeURIComponent(target)}&id=${encodeURIComponent(revisionId)}`,
      { method: 'POST' },
    ),
  /**
   * Manual Redirect creation (page kind). Per `design-redirect-ui.md` Q2:
   * POST /api/page-redirects with body `{ from, to }`. Capability: `edit:pages`.
   *
   * `opts.onConflict` mirrors `createPage` — when the requested `from` name
   * collides with an existing archive, the first call returns 409
   * ARCHIVED_NAME_CONFLICT (thrown as `ArchivedNameConflictError`); the
   * dialog morphs to ArchivedNameConflictPrompt, author chooses Restore /
   * Replace / Move-aside, and the second call carries the chosen mode.
   *
   * Errors:
   *   - 400 INVALID            — wildcard from-route, from='home', etc.
   *   - 403 FORBIDDEN          — missing edit:pages
   *   - 409 LIVE_NAME_CONFLICT — from is a live page
   *   - 409 ARCHIVED_NAME_CONFLICT (typed) — needs onConflict resolution
   *   - 409 ALIAS_TARGET_NOT_FOUND — to doesn't exist as a live page
   */
  createPageRedirect: (data: CreateRedirectRequest, opts?: { onConflict?: 'restore' | 'replace' | 'moveAside' }) => {
    const qs = opts?.onConflict ? `?onConflict=${opts.onConflict}` : ''
    return request<CreateRedirectResponse>(`/page-redirects${qs}`, {
      method: 'POST',
      body: JSON.stringify(data),
    })
  },
  /** Manual Redirect creation (fragment kind). Capability: `edit:fragments`. */
  createFragmentRedirect: (
    data: CreateRedirectRequest,
    opts?: { onConflict?: 'restore' | 'replace' | 'moveAside' },
  ) => {
    const qs = opts?.onConflict ? `?onConflict=${opts.onConflict}` : ''
    return request<CreateRedirectResponse>(`/fragment-redirects${qs}`, {
      method: 'POST',
      body: JSON.stringify(data),
    })
  },
  /** List assets on the active target. Empty array when the target has none. */
  listAssets: () => request<AssetSummary[]>('/assets'),
  /** Fetch a single asset's summary by name. 404s when the asset doesn't exist. */
  getAsset: (name: string) => request<AssetSummary>(`/assets/${encodeURIComponent(name)}`),
  /** Query the audit log. Returns inline events from queryable
   *  providers + external-sink references for non-queryable
   *  providers. Per design-audit.md "Audit drawer — query semantics". */
  queryAudit: (filter: AuditQueryFilter = {}) => {
    const params = new URLSearchParams()
    if (filter.action) params.set('action', filter.action)
    if (filter.outcome) params.set('outcome', filter.outcome)
    if (filter.scopeKind) params.set('scopeKind', filter.scopeKind)
    if (filter.scopeName) params.set('scopeName', filter.scopeName)
    if (filter.actor) params.set('actor', filter.actor)
    if (filter.since) params.set('since', filter.since)
    if (filter.until) params.set('until', filter.until)
    if (filter.limit !== undefined) params.set('limit', String(filter.limit))
    const qs = params.toString()
    return request<AuditQueryResponse>(`/audit${qs ? `?${qs}` : ''}`)
  },
}
