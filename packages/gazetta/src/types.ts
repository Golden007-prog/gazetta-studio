import type { AIProvider } from './ai/provider.js'
import type { AdminCache } from './cache/types.js'
import type { DeployAdapter } from './deploy/types.js'
import type { TransformAdapter } from './transforms/adapter.js'

/** Output of a rendered component */
export interface RenderOutput {
  html: string
  css: string
  js: string
  head?: string
}

/** Template function signature — generic over content type */
export type TemplateFunction<T extends Record<string, unknown> = Record<string, unknown>> = (params: {
  content?: T
  children?: RenderOutput[]
  params?: Record<string, string>
  /** Active locale code (e.g. 'fr', 'en'). Always provided by the renderer — defaults to site's locale or 'en'. */
  locale: string
}) => RenderOutput | Promise<RenderOutput>

/** Mount function for framework-agnostic custom editors */
export interface EditorMount {
  mount(
    el: HTMLElement,
    props: {
      content: Record<string, unknown>
      schema: Record<string, unknown>
      theme: 'dark' | 'light'
      onChange: (content: Record<string, unknown>) => void
      /** Base URL for loading custom field modules (dev mode: /@fs/ path) */
      fieldsBaseUrl?: string
      /**
       * Asset picker callback — used by embedded-asset field widgets to
       * open a "select one asset" modal. Admin supplies its own
       * implementation (Vue-rendered in the admin); the editor package
       * depends only on the abstract Promise-returning shape.
       *
       * Returns `{ _asset: name }` on confirm, `null` on cancel.
       */
      onPickAsset?: (options: {
        accept?: string[]
        currentAssetName?: string | null
      }) => Promise<{ _asset: string } | null>
    },
  ): void
  unmount(el: HTMLElement): void
}

/** Mount function for framework-agnostic custom field widgets */
export interface FieldMount {
  mount(
    el: HTMLElement,
    props: {
      value: unknown
      schema: Record<string, unknown>
      theme: 'dark' | 'light'
      onChange: (value: unknown) => void
    },
  ): void
  unmount(el: HTMLElement): void
}

/** Template module — what a template file exports */
export interface TemplateModule {
  default: TemplateFunction
  schema: unknown // ZodType — kept as unknown to avoid zod dependency in shared
}

/** Inline component — nested within a page or fragment manifest */
export interface InlineComponent {
  /**
   * Stable identifier for this component within its containing
   * manifest. Auto-generated on save when absent (per
   * `component-ids.ts`); preserved across reorders, edits, and
   * template switches. Used as the anchor for inline comments
   * (per `design-collaboration.md`) and per-component overrides
   * (future, per i18n #192). Fragment-reference strings (e.g.
   * `"@header"`) don't carry IDs — they point at a separate
   * manifest whose components have their own IDs.
   */
  id?: string
  name: string
  template: string
  content?: Record<string, unknown>
  components?: ComponentEntry[]
}

/** A component entry is either a fragment reference string ("@header") or an inline component object */
export type ComponentEntry = string | InlineComponent

/**
 * Archive state on a component manifest. Per `design-soft-delete.md` Q1
 * (storage shape): archive lives on the manifest itself as additive optional
 * fields — content state, not derived state.
 *
 * - `archived: true` flips the item out of the live tree. Renderer follows
 *   `aliasOf` when set; emits 410 / render-error otherwise (per Q2 F1).
 * - `archivedAt` / `archivedBy` are snapshots at archive time (per
 *   `design-audit.md`'s actor-snapshot pattern).
 * - `aliasOf` names the live target (page name OR fragment name);
 *   resolved per-kind (page → `deriveRoute`, fragment → `@aliasOf`).
 *   Q3 flatten-on-rename guarantees aliases never point at archives.
 *
 * `archived: false` is treated identically to `archived` absent — both
 * mean "live."
 */
export interface ArchiveFields {
  archived?: boolean
  archivedAt?: string
  archivedBy?: string
  aliasOf?: string
}

/**
 * Component manifest (base).
 *
 * `template` is optional at the type level — per design-redirect-ui.md
 * Q2 sub-decision A1, archived manifests (`archived: true`) may omit
 * the template field. Live manifests still require it; the
 * `PageManifestSchema` / `FragmentManifestSchema` refinements enforce
 * this at parse time. Consumers reading `template` must guard for
 * `undefined` when the manifest could be archived (or know via
 * narrowing that the path runs on live items only).
 */
export interface ComponentManifest extends ArchiveFields {
  template?: string
  content?: Record<string, unknown>
  components?: ComponentEntry[]
}

/** Fragment manifest (shared component) */
export interface FragmentManifest extends ComponentManifest {}

/**
 * Identifier for a structural override target — a page or fragment manifest.
 * Serialized as `page:{name}` / `fragment:{name}` for use as object keys.
 */
export type ManifestKey = { kind: 'page'; name: string } | { kind: 'fragment'; name: string }

export function manifestKeyToString(key: ManifestKey): string {
  return `${key.kind}:${key.name}`
}

export function manifestKeyFromString(s: string): ManifestKey {
  const i = s.indexOf(':')
  if (i < 0) throw new Error(`Invalid manifest key: ${s}`)
  const kind = s.slice(0, i)
  if (kind !== 'page' && kind !== 'fragment') throw new Error(`Invalid manifest key kind: ${kind}`)
  return { kind, name: s.slice(i + 1) }
}

/**
 * Pending draft overrides sent from the admin to the preview server.
 *
 * Two lanes, both required (use empty maps when nothing is pending):
 * - `content` — keyed by the component's tree path (or filesystem path); replaces
 *   the resolved component's `content` object.
 * - `structural` — keyed by `manifestKeyToString` (page:name | fragment:name);
 *   replaces the manifest's `components` array.
 */
export interface DraftOverrides {
  content: Record<string, Record<string, unknown>>
  structural: Record<string, ComponentEntry[]>
}

/** CDN cache purge configuration */
export interface PurgeConfig {
  type: 'cloudflare'
  /** API token with cache purge permission — use ${ENV_VAR} syntax */
  apiToken?: string
  /** Zone ID — auto-detected from siteUrl when not set */
  zoneId?: string
}

/** Cache configuration */
export interface CacheConfig {
  /** Browser cache TTL in seconds (max-age). Default: 0 */
  browser?: number
  /** Edge/CDN cache TTL in seconds (s-maxage). Default: 86400 */
  edge?: number
  /** CDN cache purge configuration */
  purge?: PurgeConfig
}

/** SEO metadata for a page — surfaced in <head> and used by sitemap generation. */
export interface PageMetadata {
  title?: string
  description?: string
  ogImage?: string
  canonical?: string
  /** Robots directive — e.g. "noindex", "nofollow", "noindex, nofollow".
   *  When set, emitted as `<meta name="robots" content="...">`.
   *  When absent, the tag is omitted (default: allow indexing). */
  robots?: string
}

/** Page manifest (routable component) */
export interface PageManifest extends ComponentManifest {
  route: string
  metadata?: PageMetadata
  cache?: CacheConfig
}

export type TargetEnvironment = 'local' | 'staging' | 'production'

export type TargetType = 'static' | 'dynamic'

/** Built-in storage factories, as reported by `StorageProvider.kind`. */
export type StorageKind = 'filesystem' | 'r2' | 's3' | 'azure'

/** Target configuration in site.config.ts */
export interface TargetConfig {
  /**
   * Storage provider for this target. Operators construct via factory
   * functions imported from `gazetta` (e.g., `r2Storage({...})`,
   * `filesystemStorage()`, `s3Storage({...})`, `azureBlobStorage({...})`).
   * The field's value IS the constructed provider (Path X — see
   * `design-provider-config.md`).
   */
  storage: StorageProvider
  /**
   * Rendering model:
   * - `static`: pre-rendered at publish time, served from edge (no SSR at request)
   * - `dynamic`: composed/SSR'd at request time on Node/Bun server (ESI-style assembly)
   * Default: `dynamic` if worker configured, `static` otherwise.
   */
  type?: TargetType
  /**
   * Semantic intent of this target — drives UI treatment (confirmation
   * prompts, badges) and ops decisions. Default: 'local'. Production
   * targets must be marked explicitly — the default is safe, not
   * alarming; prod opt-in prevents accidental prod chrome on dev targets.
   */
  environment?: TargetEnvironment
  /**
   * Whether the author can save form-edits to this target and whether it
   * can receive publishes from the CMS. Default: `true` for `environment:
   * local` (or unset — local is the env default), `false` for `staging`
   * and `production`.
   * Override explicitly for hotfix-tolerant staging/prod setups
   * (`editable: true`) or locked-down local targets (`editable: false`).
   * A target whose storage is public (see `publicStorage`) defaults to
   * `false`, and must not set `true`: an editing target keeps history.
   */
  editable?: boolean
  /**
   * Whether visitors can reach this target's storage directly (a host
   * serving the bucket or folder as the site). A public target keeps no
   * history, audit or review state there. When unset, a target is private
   * only if its storage is `filesystemStorage()` and it sets
   * `editable: true`, or if its deploy adapter copies site files to the
   * host; every other target is assumed public. Set `false` for storage
   * visitors can't reach (e.g. a bucket served only through a worker).
   * Read the resolved value with `isPublicStorage(target)`.
   * See `.claude/rules/design-public-storage.md` Q5–Q6.
   */
  publicStorage?: boolean
  /** Base URL of the site (e.g. https://gazetta.studio) */
  siteUrl?: string
  /**
   * Locale subset this target serves. Inherits site-level `locales.supported`
   * when absent. A single-entry list (e.g. `[fr]`) makes the target
   * single-language — no URL prefix, no locale switching.
   */
  locales?: string[]
  /**
   * Default locale for this target. Inherits site-level `locale` when absent.
   * The default locale has no URL prefix (unless `defaultPrefix` is true).
   * For single-locale targets, auto-inferred from the `locales` list.
   */
  locale?: string
  /**
   * Override site-level `locales.defaultPrefix` for this target.
   */
  defaultPrefix?: boolean
  /**
   * Override site-level `locales.detection` for this target.
   */
  detection?: boolean
  cache?: CacheConfig
  /**
   * Per-target history / revisions (undo, rollback). Default: enabled
   * with 50-revision retention. Set `{ enabled: false }` to disable
   * entirely (no `.gazetta/history/` writes on save/publish) for
   * targets where the storage cost isn't worth it (e.g., ephemeral CI
   * preview targets).
   */
  history?: HistoryConfig
  /**
   * Image-transform delivery strategy. Operators construct via factory
   * functions imported from `gazetta` (e.g., `sharpAdapter()`,
   * `cloudflareAdapter({ zone })`). When unset, the resolver falls back
   * to the default sharp adapter — bytes serve from origin with
   * immutable cache headers. Path X — the field's value IS the
   * constructed adapter (see `design-provider-config.md`).
   */
  transforms?: TransformAdapter
  /**
   * Platform deploy strategy for this target. Operators construct via
   * factory functions imported from `gazetta` (e.g.,
   * `cloudflareWorkersDeploy({...})`, `githubPagesDeploy({...})`).
   * When unset, `gazetta deploy <target>` errors with "no deploy
   * adapter configured" — the operator either adds a `deploy:` field
   * or uses platform-native deploy tooling (container hosts run
   * `gazetta serve` and deploy via `flyctl` / `gcloud run deploy` /
   * etc. — see `docs/container-deployment.md`). Path X — the field's
   * value IS the constructed adapter (see `design-deploy.md` +
   * `design-provider-config.md`).
   *
   * Per Q4 lock of the deploy design pass: `gazetta publish` and
   * `gazetta deploy` are independent operations. Adapters that need
   * published content read `target.storage` themselves and surface
   * `DeployContentError` when missing.
   */
  deploy?: DeployAdapter
  /**
   * Per-target asset upload policy. Today carries the size cap; future
   * fields (MIME allowlist subset, name policy overrides) extend this
   * block additively. Default cap when unset: 50 MB
   * (DEFAULT_ASSET_MAX_BYTES in assets/validate.ts).
   *
   * Example use cases:
   *   - Cloudflare Workers Free tier: cap below 100 MB worker body limit
   *   - Self-hosted with nginx + S3: raise to 500 MB for raw-photo
   *     workflows
   *   - Locked-down prod target: cap at the smallest sensible value
   *     for the site's content
   */
  assets?: AssetUploadConfig
  /**
   * Host-format redirect manifest emitted at publish. Used by
   * plain-static targets (no worker): when archived pages exist, the
   * publish flow walks them and emits a `_redirects` (or equivalent)
   * file at the target root that the host runtime reads — Cloudflare
   * Pages and Netlify both honor this convention.
   *
   * Worker-served target types (static + ESI + dynamic) DON'T need
   * this — the worker reads the HTML marker on each archived page's
   * `pages/{name}/index.html` directly. Setting `redirects.format`
   * on a worker-served target is harmless but redundant.
   *
   * Defaults:
   *   - `cloudflare-pages` runtime hint → `cloudflare`
   *   - `netlify` runtime hint → `netlify`
   *   - else → `none` (no file emitted)
   *
   * Override when host-runtime is plain-static and operator wants
   * a structured form (`json`) for custom integrations.
   */
  redirects?: RedirectsConfig
  /**
   * Per-target alt-text behavior overrides. Inherits site-level
   * `altText:` block; only behavior fields can be overridden
   * (`auto`, `maxImageEdge`, `model`). Provider and credentials are
   * operationally global and don't appear at the target level.
   *
   * Common pattern: `{ auto: false }` on production targets for
   * review-first publishing workflows.
   */
  altText?: AltTextTargetConfig
  /**
   * Per-target review workflow override. Overrides the site-level block
   * wholesale (no per-field merge) when present; absent inherits from
   * `SiteManifest.reviewWorkflow` via `resolveReviewWorkflow`.
   *
   * Per `design-review-workflow.md` "Locked invariants": review is a
   * per-content concern (state lives on the source manifest). Per-target
   * `reviewWorkflow` exists so different targets can apply different
   * approval policies — e.g., staging uses 1-approver self-approval while
   * production runs the archetype-E 2-approver 4-eyes policy.
   */
  reviewWorkflow?: ReviewWorkflowConfig
  /**
   * Per-target publish-approval gate (separate from content review).
   * When true, publish events to this target require explicit publish
   * approval beyond content review (per `design-review-workflow.md`
   * "Per-target publish approval" lock).
   *
   * Distinct from `reviewWorkflow` — content review gates the source
   * manifest's lifecycle; this gates publish-event delivery to THIS
   * target. Common pattern: production with `requiresPublishApproval:
   * true` + staging without (publish to staging is friction-free; prod
   * requires the gate).
   *
   * Default: false (publish proceeds without approval).
   */
  requiresPublishApproval?: boolean
  /**
   * Number of publish-approval votes required before a publish event to
   * this target can fire. Positive integer; default 1.
   *
   * Only honored when `requiresPublishApproval: true`. Snapshotted on
   * the publish request at request time (matches `ReviewWorkflowConfig`'s
   * `requiredApprovers` lock — policy at decision time is documented).
   */
  requiredPublishApprovers?: number
  /**
   * Per-target publish-audit gate (Validation Cut 4). Drives the
   * pre-publish modal in the admin and the server-side publish gate.
   *
   * Default behavior (no `publishAudit` set):
   *   - errors block the publish
   *   - warns surface in the modal but don't block
   *   - infos are hidden by default
   *
   * `strict: true` promotes warns to errors at the publish gate —
   * useful for production targets where any quality issue should
   * stop the ship.
   */
  publishAudit?: PublishAuditConfig
}

/**
 * Format the publish flow uses to emit a host-format redirect manifest
 * at the target root. Per design-soft-delete.md Q10: only the listed
 * external standards earn the aggregate-file exception; everything
 * else is sourced from the per-page HTML marker.
 *
 *   - `cloudflare`: `_redirects` file in Cloudflare Pages format.
 *     Lines: `<from>  <to>  301` for aliased archives, `<from>  /  410`
 *     for soft-deletes.
 *   - `netlify`: `_redirects` in Netlify's format (same syntax as
 *     Cloudflare for the patterns we emit).
 *   - `json`: `redirects.json` for custom integrations — structured
 *     `{ redirects: [...], gone: [...] }` shape; operator wires their
 *     own host glue.
 *   - `none`: no file emitted. Default for non-CDN-format storage.
 */
export type RedirectsFormat = 'cloudflare' | 'netlify' | 'json' | 'none'

/**
 * Per-target redirects-emit configuration. Set on
 * `targets.{name}.redirects`. Read at publish time when archived
 * pages exist on the target.
 */
export interface RedirectsConfig {
  /** Output file format. See `RedirectsFormat` for semantics. */
  format: RedirectsFormat
}

/**
 * Per-target publish-audit configuration. Set on `targets.{name}.publishAudit`.
 * Currently a single boolean — design-validation.md flags per-validator
 * severity overrides as deferred until concrete operator demand surfaces.
 */
export interface PublishAuditConfig {
  /**
   * When true, all warns at the publish gate are promoted to errors
   * (and therefore block the publish). Default: false. Operator opts
   * in for compliance-grade workflows where any quality issue should
   * stop production deployments.
   */
  strict?: boolean
}

/**
 * Cross-task AI configuration block (`ai:` in `site.config.ts`). Carries
 * fields used by ALL AI-powered tasks (alt-text in v1.5; future
 * translation, tag suggestion, summarization).
 *
 * Per-task config blocks (`altText:`, future `translation:`) inherit
 * `provider` and `defaultModel` from this base unless overridden.
 *
 * Vision-task-specific fields (e.g., `maxImageEdge`) DO NOT live here
 * — they sit on per-task blocks because they don't apply to text-only
 * tasks. Putting them on the cross-task base would be an ISP violation.
 *
 * See `.claude/rules/design-ai.md` for the three-layer architecture.
 */
/**
 * Cross-task AI configuration (`ai:` block in `site.config.ts` or
 * `gazetta.config.ts`). Per Path X (design-provider-config.md
 * Exception A — three-rung AI task config):
 *
 *   - `provider` is a constructed `AIProvider` instance (factory call)
 *   - `model` is a data-literal string used as the default for tasks
 *     that don't override it
 *
 * Per-task blocks (`altText:`, future `translation:`) carry per-task
 * data literals (systemPrompt, maxTokens). Per-target overrides under
 * `targets.X.altText.ai` accept the union for full per-target tuning.
 */
export interface AIConfig {
  /** Constructed AI provider instance (e.g., `anthropicProvider({...})`). */
  provider?: AIProvider
  /** Default model ID for tasks; per-task blocks may override. */
  model?: string
}

/**
 * Site-level (or gazetta-level) alt-text task config. Carries per-task
 * data literals only — provider lives on the cross-task `ai:` block.
 * Inherited via the three-rung chain (gazetta → site → target).
 */
export interface AltTextSiteConfig {
  /**
   * Operator-supplied system prompt; prepended to the system-composed
   * neutral prompt at request time. Custom prompt policies (full
   * replacement of the WCAG-grounded base) remain v1.6+ deferred.
   */
  systemPrompt?: string
  /** Generation token cap; provider derives from maxChars when absent. */
  maxTokens?: number
  /**
   * Whether upload flows auto-fire suggest after upload completes.
   * Default: `true`. Set `false` for review-first workflows. Behavior
   * field — read at request time, doesn't affect adapter construction.
   */
  auto?: boolean
  /**
   * Long-edge cap for the image bytes sent to the vision provider.
   * Default 768 (`MAX_EDGE` in `ai/vision-prep.ts`). Behavior field —
   * read at request time.
   */
  maxImageEdge?: number
}

/**
 * Per-target alt-text override.
 *
 * Two shapes per Path X (design-provider-config.md Exception A + B):
 *   - **Behavior fields at root** (`auto`, `maxImageEdge`): partial
 *     literals for runtime knobs the suggester reads per call (Exception B).
 *   - **`ai:` sub-block**: full per-task config override accepting
 *     `provider` (factory result), `model`, `systemPrompt`, `maxTokens`
 *     as data literals (Exception A's third rung).
 *
 * Common patterns:
 *   - `{ auto: false }` — review-first on production
 *   - `{ ai: { model: 'gpt-4o' } }` — higher-quality model on prod
 *   - `{ ai: { provider: openaiProvider({...}) } }` — different provider per target
 */
export interface AltTextTargetConfig {
  /** Override site-level `auto`. Common: `false` on production. */
  auto?: boolean
  /** Override site-level `maxImageEdge` for this target. */
  maxImageEdge?: number
  /**
   * Per-target AI overrides. All four fields are partial overrides on
   * the inherited chain; absent fields inherit naturally (target →
   * site → gazetta → per-provider default for `model`).
   */
  ai?: {
    /** Replace the inherited provider for this target only. */
    provider?: AIProvider
    /** Override the inherited model for this target only. */
    model?: string
    /** Override the inherited systemPrompt for this target only. */
    systemPrompt?: string
    /** Override the inherited maxTokens for this target only. */
    maxTokens?: number
  }
}

/**
 * Review workflow configuration. Carries the content-review state machine's
 * policy fields (per `design-review-workflow.md` "Locked invariants" + Cut 1).
 *
 * Set at site level via `SiteManifest.reviewWorkflow` for site-wide defaults,
 * or at target level via `TargetConfig.reviewWorkflow` to override per target.
 *
 * Absence = review is off (matches archetype A — solo). Operators enable by
 * setting `enabled: true` somewhere in the chain (site or target).
 *
 * `requiredApprovers` is snapshotted at submit time per the design's locked
 * "explicit-action invariant" — subsequent config changes don't rewrite
 * in-flight reviews. The runtime resolver consumes the snapshot, not this
 * config block, for any item already in `pending-review`.
 *
 * `invalidateOnSave: 'content-diff'` (default) only invalidates approval
 * when logical content changes; `'always'` invalidates on every save for
 * compliance archetypes (E).
 */
export interface ReviewWorkflowConfig {
  /** Whether review is required on this scope. Default: false. */
  enabled?: boolean
  /**
   * Number of approvals required before content reaches `approved` state.
   * Positive integer; default 1.
   */
  requiredApprovers?: number
  /**
   * Whether the submitter can be one of the approvers. Default true (archetypes
   * A/B). Compliance archetype E sets false to enforce 4-eyes.
   */
  allowSelfApproval?: boolean
  /**
   * What saves invalidate an existing `approved` state back to `draft`.
   * - `'content-diff'` (default): only logical content changes invalidate.
   *   Metadata-only edits (alt text on a referenced asset, etc.) don't.
   * - `'always'`: every save invalidates. Compliance-friendly.
   */
  invalidateOnSave?: 'content-diff' | 'always'
}

/** Per-target asset upload policy. */
export interface AssetUploadConfig {
  /**
   * Per-asset upload size cap in bytes. Validates against the bytes
   * actually received (sniffed at ingest time, not the client's
   * Content-Length claim). Default: 50 MB.
   */
  maxBytes?: number
}

/** Per-target history configuration. */
export interface HistoryConfig {
  /** Record revisions on save/publish. Default: true. */
  enabled?: boolean
  /**
   * Keep at most N most-recent revisions; oldest evicted on write.
   * Default: 50.
   */
  retention?: number
}

/** Determine rendering type for a target — centralised logic used by CLI and admin API */
export function getType(target: TargetConfig): TargetType {
  // Pre-Cut 3 fallback was `target.worker ? 'dynamic' : 'static'`.
  // With `target.worker` deleted, a WorkerCapableDeployAdapter
  // implies a worker is bundled — that's the new heuristic.
  if (target.type) return target.type
  if (target.deploy && 'workerRuntimeConfig' in target.deploy) return 'dynamic'
  return 'static'
}

/** Resolve a target's environment. Defaults to 'local' — production must be explicit. */
export function getEnvironment(target: TargetConfig): TargetEnvironment {
  return target.environment ?? 'local'
}

/**
 * Whether visitors can reach this target's storage directly. An explicit
 * `publicStorage` wins. Otherwise the target is private only when its
 * storage is a filesystem it explicitly edits, or when its deploy adapter
 * copies site files to the host; anything else is assumed public, so a
 * forgotten declaration never leaks history or audit data. `environment`
 * plays no part: it defaults to `'local'`, so it can't show privacy.
 */
export function isPublicStorage(target: TargetConfig): boolean {
  if (target.publicStorage !== undefined) return target.publicStorage
  if (target.storage.kind === 'filesystem' && target.editable === true) return false
  if (target.deploy?.copiesSiteFiles === true) return false
  return true
}

/**
 * Whether the author can save and receive publishes on this target from the CMS.
 * Public storage resolves first: a public target defaults to not editable.
 * Otherwise the default is true for `environment: local`, false for
 * `staging` / `production`.
 */
export function isEditable(target: TargetConfig): boolean {
  return target.editable ?? (isPublicStorage(target) ? false : getEnvironment(target) === 'local')
}

/** Default retention: keep the last 50 revisions. Matches design-publishing.md. */
export const DEFAULT_HISTORY_RETENTION = 50

/** Whether this target records history on save/publish. Default: true. */
export function isHistoryEnabled(target: TargetConfig): boolean {
  return target.history?.enabled ?? true
}

/**
 * Effective retention (max revisions) for this target. Defaults to
 * `DEFAULT_HISTORY_RETENTION`. Values ≤ 0 are clamped to 1 — retaining
 * zero revisions would mean every write evicts itself, which is
 * confusing; use `enabled: false` to disable entirely.
 */
export function getHistoryRetention(target: TargetConfig): number {
  const raw = target.history?.retention ?? DEFAULT_HISTORY_RETENTION
  return raw > 0 ? raw : 1
}

/**
 * Effective review workflow config for a target. Per the design's
 * "Configuration" lock: per-target block overrides site-level wholesale
 * (no per-field merge — operators set the whole block when they want
 * different policy on a target). Absence at both layers returns
 * `undefined`, which downstream consumers treat as review-off
 * (archetype A — solo).
 *
 * Pure resolver; no defaults applied. Callers that need a fully-
 * populated block parse it through `reviewWorkflowSchema` (which fills
 * in field defaults) or read `enabled` explicitly with `?? false`.
 *
 * The "wholesale override" rule matches the design doc's example
 * configurations: each target's reviewWorkflow block is a complete
 * policy specification, not a partial overlay. Per-field merge would
 * make it harder to reason about what's in effect (operator sees the
 * target block AND the site block, has to mentally combine); wholesale
 * override means the target block is THE policy when set.
 */
export function resolveReviewWorkflow(
  target: Pick<TargetConfig, 'reviewWorkflow'>,
  site: Pick<SiteManifest, 'reviewWorkflow'>,
): ReviewWorkflowConfig | undefined {
  return target.reviewWorkflow ?? site.reviewWorkflow
}

/**
 * i18n configuration. Opt-in: absent = single-locale site.
 * Adding `locales` enables multi-locale support.
 *
 * Shape mirrors `themes: { default?, supported }` for project-wide
 * consistency: `default` is optional (falls back to `supported[0]`);
 * `supported` is required.
 */
export interface LocalesConfig {
  /** All supported locale codes (BCP 47). */
  supported: string[]
  /** Default locale code. Falls back to `supported[0]` when omitted. */
  default?: string
  /** Locale-specific fallback chains. E.g. `{ 'pt-BR': 'pt' }` → pt-BR falls back to pt before default. */
  fallbacks?: Record<string, string>
  /** Whether the default locale gets a URL prefix. Default: false (no prefix for default). */
  defaultPrefix?: boolean
  /** Enable Accept-Language detection and redirect. Default: false. */
  detection?: boolean
}

/**
 * Theme configuration. Opt-in: absent = single-theme site (no theme overrides
 * on assets). Themes are a peer override dimension to locales — assets can
 * declare locale-specific bytes, theme-specific bytes, or both.
 *
 * v1 enables themes on **assets only**. Page/fragment theme variants are
 * deferred; templates emit theme-aware CSS via PrimeVue tokens / class-based
 * cascade. See design-media.md and css-theming.md.
 */
export interface ThemesConfig {
  /** Supported theme names (lowercase ASCII, no dots). Conventionally `['light', 'dark']`. */
  supported: string[]
  /** Default theme name. Falls back to first in `supported`. */
  default?: string
}

/** Site manifest — runtime shape derived from site.config.ts */
export interface SiteManifest {
  name: string
  version?: string
  /**
   * i18n configuration. Absent = single-locale site (effective locale
   * falls back to 'en'). Default locale lives at `locales.default`
   * (or first in `locales.supported` when omitted) — the previous
   * top-level `locale` field is removed in this migration.
   */
  locales?: LocalesConfig
  /**
   * Theme configuration for asset overrides. Absent = no theme dimension
   * (assets are theme-agnostic). When set, assets can carry per-theme
   * byte overrides, and the resolver picks variants per render context.
   */
  themes?: ThemesConfig
  /** Default Open Graph image for pages that don't specify their own. */
  defaultOgImage?: string
  /**
   * Cross-task AI configuration. Carries shared concerns (provider,
   * default model). Per-task blocks (`altText:`) inherit these fields
   * unless they override.
   *
   * Absent = no AI features configured. The capability check
   * (`isAltAdapterConfigured`) treats absence as "AI is off."
   */
  ai?: AIConfig
  /**
   * Site-level alt-text task config. Inherits from `ai:` block; per-target
   * blocks (`TargetConfig.altText`) override behavior fields only.
   *
   * Absent = alt-text feature is off. Block presence + valid `provider`
   * (either here or inherited from `ai:`) means AI alt is configured.
   */
  altText?: AltTextSiteConfig
  /**
   * Site-level review workflow defaults. Per-target overrides under
   * `targets.{name}.reviewWorkflow` shadow this value wholesale; absent
   * target blocks inherit it via `resolveReviewWorkflow`.
   *
   * Absent at both layers = review off (archetype A, solo). Per
   * `design-review-workflow.md` "Configuration" + archetype walkthrough:
   * the common pattern is to set this at site level for archetypes B/D/E
   * (review on across the site) and override only specific targets when
   * their policy differs (e.g., compliance-grade prod, lighter staging).
   */
  reviewWorkflow?: ReviewWorkflowConfig
  systemPages?: string[]
  targets?: Record<string, TargetConfig>
  /**
   * AdminCache instance for the L4 admin / origin-server cache. Operators
   * construct via factory functions imported from `gazetta` (e.g.,
   * `memoryCache({...})`). Path X — the field's value IS the constructed
   * cache instance (see `design-provider-config.md`).
   *
   * When absent, sites inherit the gazetta-level cache instance (per
   * single-Site-per-process invariant — each process re-evaluates
   * `gazetta.config.ts` and gets its own fresh instance).
   */
  cache?: AdminCache
  /**
   * Reserved slot for foundational dimensions that ship behind config
   * blocks under `admin.*`: auth (this Cut), audit, plugins, hooks,
   * notifications, offline. Each block is loose-typed at the
   * SiteManifest layer — the consuming foundation strict-parses its
   * own block via the matching Zod schema (e.g., `AuthConfigSchema`)
   * at use time. This keeps SiteManifest stable across foundation
   * additions; foundations don't need to widen this type each time
   * a new block ships.
   */
  admin?: {
    auth?: unknown
    plugins?: unknown
    hooks?: unknown
    audit?: unknown
    notifications?: unknown
    offline?: unknown
  }
}

/**
 * Project-level Gazetta runtime manifest — derived from `gazetta.config.ts`.
 * Carries cross-site defaults inherited by sites unless they override.
 *
 * Mirrors `GazettaConfig` (the user-input shape from the Zod schema) but
 * with the typed AI/cache shapes — at runtime the loader has already
 * constructed `AIProvider` / `AdminCache` instances from operator factory
 * calls, so the manifest carries those instances directly.
 */
export interface GazettaManifest {
  logLevel?: 'trace' | 'debug' | 'info' | 'warn' | 'error'
  telemetry?: boolean
  dev?: { port?: number; hostname?: string }
  /** Cross-site defaults inherited by sites unless overridden. */
  defaults?: {
    /** AdminCache instance constructed via `memoryCache({...})` factory. */
    cache?: AdminCache
    /** Audit defaults (loose record until audit foundation migrates to Path X). */
    audit?: Record<string, unknown>
  }
  /**
   * Cross-task AI defaults at gazetta level. First rung of the three-rung
   * chain (gazetta → site → target). Sites inherit per-field unless they
   * override.
   */
  ai?: AIConfig
  /**
   * Per-task AI defaults at gazetta level (alt-text in v1.5; future
   * translation, summarization). Carries data literals only; provider
   * lives on `ai:` block.
   */
  altText?: AltTextSiteConfig
  mcp?: { enabled?: boolean; port?: number }
}

/** Directory entry returned by StorageProvider.readDir */
export interface DirEntry {
  name: string
  isDirectory: boolean
}

/**
 * Byte range for `StorageProvider.readStream`.
 * Both `start` and `end` are inclusive (matches HTTP Range and Node `fs.createReadStream`).
 */
export interface ByteRange {
  start: number
  end: number
}

/**
 * Storage abstraction — filesystem, S3, R2, Azure Blob.
 *
 * Implementations must provide atomic writes from a reader's perspective
 * (filesystem uses write-then-rename; cloud PUT is naturally atomic per
 * object; multipart uploads commit atomically). `readStream` must honor
 * the optional `range` argument for video/audio seek.
 *
 * Three I/O patterns, each with a use case:
 *   - **Text** (`readFile` / `writeFile`): small string content
 *     (manifests, YAML, HTML). Encodes/decodes UTF-8 internally.
 *   - **Bytes** (`readBytes` / `writeBytes`): small binary content
 *     (asset bytes, history blobs). Buffer-shaped — bytes in, bytes
 *     out. No string round-trip.
 *   - **Stream** (`readStream` / `writeStream`): unbounded content
 *     (large uploads, range-served videos). Used by ingest and the
 *     asset-serve route.
 *
 * All three are part of the base contract, not separate capabilities —
 * every provider Gazetta ships supports them, and custom providers
 * must too. Authors writing a non-conforming provider get a compile-
 * time error rather than a runtime capability check that surfaces
 * at publish time.
 */
export interface StorageProvider {
  /**
   * Which built-in storage this is. Set by the built-in factories; custom
   * providers leave it unset. `isPublicStorage` reads it: only filesystem
   * storage can default to private.
   */
  readonly kind?: StorageKind
  readFile(path: string): Promise<string>
  readDir(path: string): Promise<DirEntry[]>
  exists(path: string): Promise<boolean>
  writeFile(path: string, content: string): Promise<void>
  mkdir(path: string): Promise<void>
  rm(path: string): Promise<void>
  /**
   * Read the full byte content of `path`. Bounded — for unbounded /
   * range-served reads, use `readStream`. Used by history-blob reads.
   */
  readBytes(path: string): Promise<Uint8Array>
  /**
   * Write `content` to `path` atomically. Bounded — for unbounded
   * uploads, use `writeStream`. Used by history-blob writes (and any
   * future write path that has bytes-in-hand and doesn't need
   * streaming).
   */
  writeBytes(path: string, content: Uint8Array): Promise<void>
  readStream(path: string, range?: ByteRange): Promise<ReadableStream<Uint8Array>>
  writeStream(path: string, stream: ReadableStream<Uint8Array>): Promise<void>
}

/** Resolved component ready for rendering */
export interface ResolvedComponent {
  template: TemplateFunction
  content?: Record<string, unknown>
  children: ResolvedComponent[]
  path?: string
  /** Component's position in the page tree (e.g., "hero", "@header/logo", "features/fast") */
  treePath?: string
}

/** Purge strategy for cache invalidation */
export interface PurgeStrategy {
  purgeAll(): Promise<void>
  purgeUrls(urls: string[]): Promise<void>
}
