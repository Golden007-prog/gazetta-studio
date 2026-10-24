/**
 * Type contract for the DeployAdapter Pattern 1 Provider surface.
 *
 * Cut 1 of the deploy contract — the interface, capability extension,
 * and supporting types. Subsequent cuts add validators (Cut 2), the
 * first real adapter (Cut 3 — `cloudflareWorkersDeploy`), and docs
 * (Cut 4). Per ADR-0008, operators wire adapters via factory calls
 * returning a constructed `DeployAdapter`; the field type IS the
 * runtime interface.
 *
 * Reference: `.claude/rules/design-deploy.md` "The contract" section.
 *
 * Note: `supports: readonly TargetType[]` is forward-compatible with
 * `design-rendering.md` Q1's three-target-type taxonomy (`'static' |
 * 'esi' | 'dynamic'`). Today's `TargetType` is `'static' | 'dynamic'`;
 * Cut 1 of design-rendering.md widens it to include `'esi'`. Adapters
 * declaring `supports: ['static'] as const` today continue compiling
 * after that widening.
 */
import type { SiteManifest, StorageProvider, TargetConfig, TargetType } from '../types.js'
import type { Issue } from '../validation/types.js'

/**
 * The deploy adapter contract. One implementation per platform.
 *
 * - `name` — stable identifier for diagnostics, logs, validation
 *   messages. Kebab-case matching the `module:` convention in
 *   design-logging.md (e.g., `'cloudflare-workers'`, `'github-pages'`).
 *   Plugin adapters use their package name (`'@example/custom-deploy'`).
 * - `supports` — which target types this adapter supports. The
 *   `deploy-target-type-supported` validator (Cut 2) enforces
 *   compatibility against `target.type`.
 * - `execute(ctx)` — run the deploy. Throws `DeployError` variants on
 *   failure; returns `DeployResult` on success.
 * - `validate?(ctx)` — optional pre-flight validation for cross-field
 *   invariants beyond target-type compatibility (e.g., "Cloudflare
 *   Workers requires bucket binding"). Returns the standard `Issue[]`
 *   shape from design-validation.md; runs at `cli` + `pre-publish`
 *   stages of the validation framework.
 */
export interface DeployAdapter {
  readonly name: string
  readonly supports: readonly TargetType[]
  /**
   * Set by static copy adapters that upload only site files from the
   * target's storage to the host. The storage itself then stays private,
   * so `isPublicStorage` defaults such a target to private
   * (design-public-storage.md Q2).
   */
  readonly copiesSiteFiles?: true
  execute(ctx: DeployContext): Promise<DeployResult>
  validate?(ctx: ValidateContext): Issue[]
}

/**
 * Capability extension for adapters that bundle worker code
 * (Cloudflare Workers, Cloudflare Pages + Functions, Vercel Edge,
 * Netlify Edge, Deno Deploy). `gazetta build` detects this capability
 * via `'workerRuntimeConfig' in target.deploy` and reads the runtime
 * config at build time.
 *
 * Static-only adapters (GitHub Pages, S3 static, Netlify static,
 * CF Pages plain-static, Azure Blob static) do NOT implement this
 * interface — their `target.deploy` value satisfies just
 * `DeployAdapter`.
 *
 * Per Q1 of the design grilling: the capability split keeps
 * worker-bundling concerns out of the base contract; same pattern as
 * `BinaryCapableStorageProvider` in design-media-implementation.md.
 */
export interface WorkerCapableDeployAdapter extends DeployAdapter {
  /**
   * Returns the worker runtime config that `gazetta build` needs to
   * generate the worker code (R2 bucket binding name, route patterns,
   * KV bindings, etc.). Called at build time, not at execute time.
   */
  workerRuntimeConfig(): WorkerRuntimeConfig
}

/**
 * Runtime metadata for the worker code `gazetta build` generates.
 *
 * - `bucketBinding` — name the worker code uses to access storage
 *   (e.g., `'SITE_BUCKET'` for the R2 binding). Adapter decides;
 *   wrangler.toml / equivalent platform config picks it up.
 * - `routes` — optional route patterns the worker should handle.
 *   When unset, the adapter relies on platform defaults (e.g.,
 *   Cloudflare Workers' `workers_dev = true` route).
 * - `bindings` — adapter-specific extras (Cloudflare KV / D1 /
 *   Queues, Vercel Edge Config, etc.). Opaque to `gazetta build`;
 *   the adapter consumes its own structure.
 */
export interface WorkerRuntimeConfig {
  readonly bucketBinding: string
  readonly routes?: readonly { pattern: string; zone?: string }[]
  readonly bindings?: Record<string, unknown>
}

/**
 * Context passed to `DeployAdapter.execute()`. Carries everything the
 * adapter needs to deploy without reading from globals.
 *
 * - `target` / `targetName` — the resolved target being deployed.
 * - `outputDir` — path to pre-rendered output (static + esi targets).
 *   Adapters that need bytes read from this path; adapters that don't
 *   (worker-only deploys to platforms reading from external storage
 *   at request time) ignore it.
 * - `storage` — the target's `StorageProvider`. Adapters that read
 *   content during deploy use this; adapters that don't ignore it.
 *   Per Q4 lock, the CLI doesn't gate on whether storage has been
 *   published; adapters that need published content surface a
 *   `DeployContentError` at execute time when missing.
 * - `env` — `process.env` passthrough. Adapters read platform-specific
 *   env vars (CLOUDFLARE_API_TOKEN, VERCEL_TOKEN, etc.) per their own
 *   documentation. Per Q7 lock: adapter-namespaced env vars matching
 *   platform SDK conventions.
 * - `logger` — module-scoped logger per design-logging.md. Adapter
 *   uses `logger.info({...}, 'message')` for operational events.
 * - `signal` — cancellation signal for long-running deploys. Adapters
 *   honor it best-effort; not all platform CLIs support mid-deploy
 *   cancellation.
 */
export interface DeployContext {
  readonly target: TargetConfig
  readonly targetName: string
  /** Site manifest, so deploy-time codegen can embed site-level settings
   * (e.g. resolved locales in the worker entry). */
  readonly site?: SiteManifest
  readonly outputDir: string
  readonly storage: StorageProvider
  readonly env: Record<string, string | undefined>
  readonly logger: DeployLogger
  readonly signal: AbortSignal
}

/**
 * Context passed to `DeployAdapter.validate?()`. Narrower than
 * `DeployContext` because pre-flight validation is a pure function
 * over config — no I/O, no env, no cancellation.
 */
export interface ValidateContext {
  readonly target: TargetConfig
  readonly targetName: string
}

/**
 * Result returned by `DeployAdapter.execute()` on success.
 *
 * - `url` — deployed URL when known. Some platforms surface one
 *   (Wrangler returns `https://workers-name.workers.dev` after
 *   deploy); others don't until DNS propagates. Optional.
 * - `details` — adapter-specific extras (Cloudflare worker version
 *   ID, Netlify deploy ID, etc.). Surfaced in CLI output for operator
 *   inspection. Opaque structure.
 */
export interface DeployResult {
  readonly url?: string
  readonly details?: Record<string, unknown>
}

/**
 * Minimal logger interface scoped to a deploy adapter. Mirrors the
 * shape from design-logging.md (and `HookLogger` in hooks/types.ts).
 * Concrete logger implementation lives in the logging foundation
 * (Tier 3); v1 deploy dispatch supplies a no-op logger or pino child
 * as available.
 *
 * No `trace` level — deploy is operator-tier, info-and-up sufficient.
 */
export interface DeployLogger {
  debug(obj: object | string, msg?: string): void
  info(obj: object | string, msg?: string): void
  warn(obj: object | string, msg?: string): void
  error(obj: object | string, msg?: string): void
}
