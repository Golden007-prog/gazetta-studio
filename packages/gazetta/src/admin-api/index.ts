import { Hono } from 'hono'
import { join } from 'node:path'
import { hostname } from 'node:os'
import { randomBytes } from 'node:crypto'
import { logger } from 'hono/logger'
import type { StorageProvider, TargetConfig } from '../types.js'
import { scanTemplates } from '../templates-scan.js'
import { memoizeAsync } from '../concurrency.js'
import { createTargetRegistryView } from '../targets.js'
import { createHistoryProvider } from '../history-provider.js'
import { isHistoryEnabled, getHistoryRetention } from '../types.js'
import {
  createSourceContext,
  staticSourceResolver,
  registrySourceResolver,
  type SourceContext,
  type SourceContextResolver,
} from './source-context.js'
import { authMiddleware } from './middleware/auth.js'
import { principalMiddleware } from './middleware/principal.js'
import { auditMiddleware } from './middleware/audit.js'
import { resolveAuthProviderFromManifest } from '../auth/index.js'
import {
  AuditConfigSchema,
  AuditConfigurationError,
  createHistoryAuditProvider,
  DEFAULT_AUDIT_CONFIG,
  type AuditConfig,
  type AuditProvider,
} from '../audit/index.js'
import { runAuditPrune } from './audit-prune-runner.js'
import { siteRoutes } from './routes/site.js'
import { pageRoutes } from './routes/pages.js'
import { fragmentRoutes } from './routes/fragments.js'
import { defaultValidatorRegistry } from '../validation/default-registry.js'
import { templateRoutes } from './routes/templates.js'
import { previewRoutes } from './routes/preview.js'
import { publishRoutes } from './routes/publish.js'
import { compareRoutes } from './routes/compare.js'
import { fieldRoutes } from './routes/fields.js'
import { historyRoutes } from './routes/history.js'
import { assetRoutes } from './routes/assets.js'
import { systemRoutes } from './routes/system.js'
import { auditRoutes } from './routes/audit.js'
import { validationRoutes } from './routes/validation.js'
import { healthRoutes } from './routes/health.js'
import { meRoutes } from './routes/me.js'
import { archiveRoutes } from './routes/archive.js'
import { renameRoutes } from './routes/rename.js'
import { redirectRoutes } from './routes/redirects.js'
import { warnOnCapabilityGaps } from '../runtime/capability-gap-warnings.js'
import { HookRegistry, type HookContribution } from '../hooks/index.js'

export interface BuildHooksRegistryOptions {
  /**
   * Factory contributions from `site.config.ts admin.hooks`.
   * Each contribution carries a `source` + array of phase /
   * handler / options entries.
   *
   * Default per-handler priority is **100** (factory band) when
   * the contribution doesn't specify one explicitly. Site-local
   * factories that want to run last can pass `priority: 1000`
   * via per-entry options.
   */
  contributions?: ReadonlyArray<HookContribution>
}

/**
 * Convenience boot helper: construct a HookRegistry, populate it
 * from `admin.hooks` factory contributions, seal it, return it.
 *
 * Per design-hooks.md "Registration (Q4 locked — factory
 * contributions only)". Site-local hooks AND npm-distributed
 * plugins both produce `HookContribution` from a factory call;
 * both wire identically through `admin.hooks` in `site.config.ts`.
 *
 * Sequence:
 *   1. For each contribution → for each `hooks[i]` entry →
 *      register with the contribution's source identity.
 *   2. Seal — subsequent registrations throw
 *      RegistrationAfterInitError.
 *
 * `contributions` is optional; an empty registry is a valid
 * result for sites without hooks.
 */
export async function buildHooksRegistry(opts: BuildHooksRegistryOptions = {}): Promise<HookRegistry> {
  const registry = new HookRegistry()
  if (opts.contributions) {
    for (const contribution of opts.contributions) {
      for (const entry of contribution.hooks) {
        // Default factory-supplied hook priority to the factory
        // band (100). Per-entry options.priority overrides.
        const options = { priority: 100, ...(entry.options ?? {}) }
        registry.register(entry.phase, entry.handler, options, contribution.source)
      }
    }
  }
  registry.seal()
  return registry
}
import { startCacheStatsLogger } from './cache-stats-logger.js'

export interface AdminAppOptions {
  /**
   * Pre-built SourceContext — preferred when the caller controls source-content
   * resolution (e.g., derived from a TargetRegistry via createSourceContextFromRegistry).
   * When provided, `storage` is optional (the context carries its own).
   */
  source?: SourceContext
  siteDir: string
  /** Fallback source storage when `source` is not provided. */
  storage?: StorageProvider
  /** Directory containing template packages. Defaults to siteDir/templates. */
  templatesDir?: string
  /** Directory containing admin customizations (editors, fields). Defaults to siteDir/admin. */
  adminDir?: string
  /** Production mode — editors/fields are pre-bundled at /admin/editors/*.js */
  production?: boolean
  /** @deprecated Pre-initialized target providers. Pass `targetConfigs` for lazy init. */
  targets?: Map<string, StorageProvider>
  /** Target configurations — providers are initialized lazily on first publish/fetch/compare. */
  targetConfigs?: Record<string, TargetConfig>
  /**
   * Whether the source site has at least one archived page (#1305).
   * The boot capability-gap warning fires only then; callers that
   * loaded the site anyway (dev boot) pass the flag so a fresh site
   * boots without the warning. Defaults to true (warn), preserving
   * the previous behavior for callers that don't track archive state.
   */
  anyArchived?: boolean
  /**
   * Disable the periodic cache-stats logger. Defaults to false (logger
   * runs every 5 minutes). Tests pass true to avoid background timers
   * leaking into the test runtime.
   */
  disableCacheStatsLogger?: boolean
  /**
   * Pre-built hook registry. Construct via
   * `buildHooksRegistry({ contributions })` against
   * `manifest.admin?.hooks` from the loaded site config, then pass
   * the sealed registry here. When omitted, hook dispatch is a
   * no-op (sites without hooks pay zero overhead).
   *
   * Tests pass an empty (or pre-populated) registry directly.
   */
  hooks?: HookRegistry
  /**
   * Background validation scanner (Cut 2). Constructed by the boot path
   * via `createValidationScanner({...})` against the resolved source. The
   * admin app mounts the read-side route + SSE channel against this
   * instance. When omitted, `/api/validation/issues` returns an empty list
   * and the SSE channel emits no events.
   */
  validationScanner?: import('../validation/scanner.js').ValidationScanner | null
  /**
   * Validator registry override. Defaults to `defaultValidatorRegistry()`
   * which ships every Cut 1-4 validator. Tests pass a custom registry to
   * exercise the publish-audit + publish-gate paths with synthetic
   * pre-publish-stage validators.
   */
  validators?: import('../validation/registry.js').ValidatorRegistry
  /**
   * Disable the periodic audit retention pruner. Defaults to false
   * (pruner runs at boot + every 6 hours when audit retention is
   * configured). Tests pass true to avoid background timers leaking
   * into the test runtime; the boot pass and the interval both gate
   * on this flag.
   */
  disableAuditRetentionPruner?: boolean
}

type AdminApp = Hono & {
  invalidateTemplatesCache(): void
  /**
   * Drop AdminCache entries for content (page + fragment summaries)
   * across every SourceContext the resolver has built. Called by
   * `gazetta dev`'s file watcher on out-of-band manifest changes
   * (git pull, manual edit, e2e wipes) — those bypass the save
   * handler that would normally invalidate the cache.
   *
   * Production (`gazetta serve`) doesn't have a file watcher;
   * out-of-band changes there are vanishingly rare (manifests are
   * deployed-once artifacts).
   */
  invalidateContentCache(): Promise<void>
}

/**
 * Resolve a per-process instance id for audit JSONL file naming.
 *
 * Chain per `design-logging.md`'s "Multi-instance correlation":
 *   1. `K_REVISION` env (Cloud Run; per-revision)
 *   2. `os.hostname()` — returns the pod name on K8s default config,
 *      machine hostname elsewhere
 *   3. Random 8-char hex (only when hostname is empty / unavailable)
 *
 * `process.env.HOSTNAME` is NOT in the chain — Linux containers
 * usually have it via the shell, but Node processes exec'd directly
 * may not inherit shell env, so HOSTNAME can be undefined on K8s
 * pods. `os.hostname()` calls gethostname(2) directly and is reliable
 * across runtimes.
 */
function resolveInstanceId(): string {
  if (process.env.K_REVISION) return process.env.K_REVISION
  try {
    const name = hostname()
    if (name) return name
  } catch {
    // hostname() can throw on some Wintertc-style runtimes — fall through.
  }
  return randomBytes(4).toString('hex')
}

/**
 * Create an admin API Hono app. Accepts a single options object.
 *
 * Target providers can be supplied either already-initialized via `targets`
 * (legacy), or as configs via `targetConfigs` (lazy init on first use).
 * Exactly one of these is expected when publish/fetch/compare routes are
 * used; both may be present (pre-initialized entries override configs).
 */
export function createAdminApp(opts: AdminAppOptions): AdminApp {
  const app = new Hono()

  app.use(logger())
  // Bearer-token guard (legacy GAZETTA_TOKEN) — orthogonal to
  // upstream-identity extraction. Principal middleware ships
  // below once `source.manifest` is in scope.
  app.use('/api/*', authMiddleware())

  const templatesDir = opts.templatesDir ?? join(opts.siteDir, 'templates')
  const adminDir = opts.adminDir ?? join(opts.siteDir, 'admin')

  // scanTemplates spawns a worker thread per template (jiti import + graph
  // hash). On a 50-template project that's ~5s of CPU on every publish +
  // compare. Memoize at the server lifetime — the CLI's file watcher calls
  // invalidateTemplatesCache() below on any template change.
  //
  // Keyed by (dir, root) as a string; different sites on one server would
  // each get their own cache entry. For now there's only one site per
  // server so a single memoize is enough; swap for a Map<key, Memoized> if
  // we go multi-site per process.
  const cachedScan = memoizeAsync(async () =>
    scanTemplates(templatesDir, opts.siteDir.replace(/[\\/]sites[\\/][^\\/]+$/, '')),
  )
  const scan = (tDir: string, root: string) => (tDir === templatesDir ? cachedScan.get() : scanTemplates(tDir, root))

  // Prefer an externally-provided SourceContext. Fall back to constructing
  // one from opts.storage + opts.siteDir, which is the legacy shape.
  //
  // When `opts.source` is provided, its `history` field is used verbatim:
  // - With `opts.targetConfigs` non-empty, the registry resolver below
  //   constructs per-request SourceContext via `createSourceContextFromRegistry`
  //   and wires history through the `buildHistory` callback — `opts.source.history`
  //   is never consulted.
  // - With `opts.targetConfigs` empty/unset, the static resolver returns
  //   `opts.source` directly; the caller owns whether history is wired.
  let source: SourceContext
  if (opts.source) {
    source = opts.source
  } else {
    if (!opts.storage) {
      throw new Error('createAdminApp: either `source` or `storage` must be provided')
    }
    source = createSourceContext({
      storage: opts.storage,
      siteDir: opts.siteDir,
      history: buildHistoryForLegacySource(opts),
    })
  }

  // Capability-gap surface #1 (boot config validate) per
  // `feature-design-process.md`'s capability-gap-UX discipline.
  // Walks targets; warns about runtime capability gaps (e.g., a
  // plain-static target can't emit 301 redirects from archive
  // operations). Non-blocking — admin starts. Operators see the
  // warning during deploy so misconfiguration surfaces early.
  // #1305: only once the site has an archived page — a fresh site
  // gets no warning (the gap still shows in the archive dialog,
  // site health and the publish check). Callers that don't pass
  // `anyArchived` keep the warn-always behavior.
  if (source.manifest) warnOnCapabilityGaps(source.manifest, { anyArchived: opts.anyArchived ?? true })

  // Build the per-request source resolver. When target configs are
  // declared, routes honor `?target=<name>` to read from any known
  // target. Providers are initialized lazily so dev startup doesn't
  // pay the cost of connecting every cloud target just to serve the
  // editable local one.
  //
  // Without target configs (tests, single-target setups), the resolver
  // is static — always returns the bootstrap source.
  let resolveSource: SourceContextResolver
  if (opts.targetConfigs && Object.keys(opts.targetConfigs).length > 0) {
    // Start with whatever pre-initialized providers the caller supplied
    // (typically the editable source target from bootstrap). Missing
    // providers are built on demand via lazyInit below.
    const providers = new Map(opts.targets ?? [])
    const registry = createTargetRegistryView(providers, opts.targetConfigs)
    resolveSource = registrySourceResolver({
      registry,
      projectSiteDir: source.projectSiteDir,
      manifest: source.manifest,
      gazettaManifest: source.gazettaManifest,
      // The registry's filesystem targets are already content-rooted
      // (path=./targets/<key>); siteDir on the resolved context is empty.
      siteDir: '',
      lazyInit: async name => {
        const config = opts.targetConfigs![name]
        if (!config) return
        // Storage is already a constructed provider (Path X — operator-facing
        // factory ran at config-eval). Init the connection if the provider
        // exposes one (S3 + Azure use this for connectivity probes).
        const storage = config.storage
        const maybeInit = storage as StorageProvider & { init?: () => Promise<void> }
        if (typeof maybeInit.init === 'function') await maybeInit.init()
        providers.set(name, storage)
      },
      // Build a HistoryProvider per target, honoring the site.config.ts
      // `history` block (enabled/retention). Returns undefined when the
      // target has history turned off — routes no-op on absent provider.
      buildHistory: (name, storage) => {
        const config = opts.targetConfigs![name]
        if (!config || !isHistoryEnabled(config)) return undefined
        return createHistoryProvider({ storage, retention: getHistoryRetention(config) })
      },
    })
  } else {
    resolveSource = staticSourceResolver(source)
  }

  // Validator registry built once per app — Cut 1 ships the 5 reference-
  // existence validators; Cut 2+ extend the default registry. Tests can
  // override via opts.validators.
  const validators = opts.validators ?? defaultValidatorRegistry()

  // Principal middleware — extracts upstream identity (Cloudflare
  // Access JWT, X-Forwarded-User header, etc.) per the configured
  // trust mode in `site.config.ts admin.auth`. Falls back to
  // `none`-mode (anonymous + admin role) when no auth is configured.
  // Must run before route registration so handlers see c.var.principal.
  //
  // The auth config sits under SiteManifest.admin.auth as a loose
  // record (per the existing config schema's reserved-slot pattern);
  // we strict-parse it here against the typed AuthConfigSchema and
  // throw a clear AuthConfigurationError if the operator's block is
  // malformed.
  const authProvider = resolveAuthProviderFromManifest(source.manifest?.admin?.auth)
  app.use('/api/*', principalMiddleware(authProvider))
  // The preview routes are mounted at `/preview/*` (outside `/api/*`)
  // but render full page/fragment content — they need the same
  // identity extraction so their capability gate has a Principal to
  // check. Bearer-token (`authMiddleware`) is deliberately NOT applied
  // here: the admin's preview iframe fetch doesn't carry the token,
  // and upstream-identity (the configured trust mode) is what gates
  // content reads.
  app.use('/preview/*', principalMiddleware(authProvider))

  // Audit middleware — per design-audit.md "Recording timing".
  // Resolves admin.audit config; constructs the configured providers;
  // injects c.var.audit so handlers can call `c.var.audit.record(...)`.
  // Defaults to HistoryAuditProvider when admin.audit is absent
  // (zero-config audit; events stored under target's
  // .gazetta/audit/events-{instance}.jsonl).
  const rawAuditBlock = source.manifest?.admin?.audit as unknown
  let auditConfig: AuditConfig
  if (rawAuditBlock !== undefined) {
    const parsed = AuditConfigSchema.safeParse(rawAuditBlock)
    if (!parsed.success) {
      throw new AuditConfigurationError(
        `Invalid admin.audit block in site.config.ts: ${parsed.error.issues
          .map(i => `${i.path.join('.')}: ${i.message}`)
          .join('; ')}`,
      )
    }
    auditConfig = parsed.data
  } else {
    auditConfig = DEFAULT_AUDIT_CONFIG
  }
  // Salt env var resolution per design-audit.md "Salt management":
  // GAZETTA_AUDIT_ACTOR_SALT for actor pseudonymization;
  // GAZETTA_AUDIT_SOURCEIP_SALT for source-IP hashing.
  const actorPseudonym = auditConfig.actorPseudonym ?? 'none'
  const recordSourceIp = auditConfig.recordSourceIp ?? 'none'
  const recordUserAgent = auditConfig.recordUserAgent ?? 'none'
  if (actorPseudonym === 'sha256' && !process.env.GAZETTA_AUDIT_ACTOR_SALT) {
    throw new AuditConfigurationError(
      'admin.audit.actorPseudonym: sha256 requires the GAZETTA_AUDIT_ACTOR_SALT environment variable',
    )
  }
  if (recordSourceIp === 'hashed' && !process.env.GAZETTA_AUDIT_SOURCEIP_SALT) {
    throw new AuditConfigurationError(
      'admin.audit.recordSourceIp: hashed requires the GAZETTA_AUDIT_SOURCEIP_SALT environment variable',
    )
  }
  // Build the configured providers. v1 ships only HistoryAuditProvider;
  // v2 sinks (webhook, file, OTel, CloudWatch, etc.) extend the build
  // step here when they ship.
  const auditProviders: AuditProvider[] = []
  if (auditConfig.provider === 'history') {
    auditProviders.push(
      createHistoryAuditProvider({
        storage: source.storage,
        instance: resolveInstanceId(),
      }),
    )
  }
  app.use(
    '/api/*',
    auditMiddleware({
      providers: auditProviders,
      strict: auditConfig.strict ?? false,
      actorPseudonym,
      actorSalt: process.env.GAZETTA_AUDIT_ACTOR_SALT,
      recordSourceIp,
      sourceIpSalt: process.env.GAZETTA_AUDIT_SOURCEIP_SALT,
      trustedProxyCount: auditConfig.trustedProxyCount,
      trustMode: authProvider.trustMode,
      recordUserAgent,
    }),
  )

  app.route('/', siteRoutes(resolveSource))
  // Archive + rename routes must register BEFORE pageRoutes /
  // fragmentRoutes — those modules use `:name{.+}` greedy regex
  // parameters that would capture `landing/archive` (or `/rename`)
  // when these routes' literal-suffix paths would correctly capture
  // `landing` + the suffix. First-match-wins in Hono's routing trie
  // means specific suffixes register first.
  app.route('/', archiveRoutes(resolveSource, { scanner: opts.validationScanner ?? null }))
  app.route('/', renameRoutes(resolveSource))
  // Manual Redirect creation (`POST /api/{page,fragment}-redirects`). Per
  // `design-redirect-ui.md` Q2, two parallel routes with literal
  // capability gates + a shared handler body. Registers BEFORE the
  // greedy `pages` / `fragments` matchers — same first-match-wins
  // consideration as archive + rename above.
  app.route('/', redirectRoutes(resolveSource))
  app.route(
    '/',
    pageRoutes(resolveSource, validators, templatesDir, {
      hooks: opts.hooks,
      scanner: opts.validationScanner ?? null,
    }),
  )
  app.route(
    '/',
    fragmentRoutes(resolveSource, validators, templatesDir, {
      hooks: opts.hooks,
      scanner: opts.validationScanner ?? null,
    }),
  )
  app.route(
    '/',
    templateRoutes(resolveSource, templatesDir, adminDir, opts.production, {
      scanner: opts.validationScanner ?? null,
    }),
  )
  app.route('/', previewRoutes(resolveSource, templatesDir))
  app.route(
    '/',
    publishRoutes(resolveSource, opts.targets, opts.targetConfigs, templatesDir, scan, {
      hooks: opts.hooks,
      validators,
    }),
  )
  app.route('/', compareRoutes(resolveSource, opts.targets, opts.targetConfigs, templatesDir, scan))
  app.route('/', fieldRoutes(resolveSource, adminDir))
  app.route('/', historyRoutes(resolveSource, opts.targets, opts.targetConfigs))
  app.route('/', assetRoutes(resolveSource, { hooks: opts.hooks }))
  app.route('/', systemRoutes(resolveSource))
  app.route('/', auditRoutes({ providers: auditProviders }))
  app.route('/', validationRoutes({ scanner: opts.validationScanner ?? null }))
  app.route('/', healthRoutes())
  app.route('/', meRoutes())

  // Periodic cache stats log — fires every 5 minutes against the
  // bootstrap source's cache. Runs unobtrusively (timer.unref()
  // means it never blocks process exit). Tests pass
  // `disableCacheStatsLogger: true` to avoid background timers; the
  // route at /api/system/cache/stats still exposes on-demand
  // snapshots either way.
  if (!opts.disableCacheStatsLogger) {
    startCacheStatsLogger({ cache: source.cache })
  }

  // Audit retention pruner — when admin.audit.retention is configured
  // (events cap and/or maxAgeMonths), evict old / overflow events at
  // boot + every 6 hours per design-audit.md "Retention". No-op when
  // retention isn't configured (operator opted out / never opted in).
  // Same pattern as the cache stats logger: timer.unref() so it never
  // blocks process exit; tests pass `disableAuditRetentionPruner:
  // true` to keep background work out of the test runtime.
  if (
    !opts.disableAuditRetentionPruner &&
    auditConfig.provider === 'history' &&
    auditConfig.retention &&
    (auditConfig.retention.events !== undefined || auditConfig.retention.maxAgeMonths)
  ) {
    const retentionConfig = auditConfig.retention
    const runPrune = () =>
      runAuditPrune({
        storage: source.storage,
        retentionConfig: {
          events: retentionConfig.events,
          maxAgeMonths: retentionConfig.maxAgeMonths ?? null,
        },
      })
    // Boot pass.
    void runPrune()
    // 6-hour interval (21_600_000 ms). unref() so the process can exit
    // independently of this timer.
    const PRUNE_INTERVAL_MS = 6 * 60 * 60 * 1000
    const timer = setInterval(runPrune, PRUNE_INTERVAL_MS)
    timer.unref()
  }

  // Exposed for the CLI's template file watcher: clears the memoized scan
  // so the next publish/compare picks up template edits. Not part of the
  // Hono Request interface — the CLI casts the return.
  const appWithInvalidate = app as AdminApp
  appWithInvalidate.invalidateTemplatesCache = () => cachedScan.invalidate()
  appWithInvalidate.invalidateContentCache = async () => {
    await resolveSource.forEachBuilt(async ctx => {
      await Promise.all([ctx.cache.invalidatePrefix('pages:'), ctx.cache.invalidatePrefix('fragments:')])
    })
  }
  return appWithInvalidate
}

/**
 * Legacy path: caller passed raw `opts.storage` rather than a
 * SourceContext. No target name is available; default history to
 * enabled with default retention, assuming the common single-target
 * setup. Skipped when targetConfigs is absent — historical behavior
 * (tests that rely on no `.gazetta/` writes happening).
 */
function buildHistoryForLegacySource(opts: AdminAppOptions) {
  const configs = opts.targetConfigs
  if (!configs) return undefined
  // Pick the first editable target's config as the best-effort stand-in.
  // Non-editable targets don't receive saves anyway, so the legacy
  // single-storage path is necessarily an editable one.
  const firstEditable = Object.entries(configs).find(([, c]) => isHistoryEnabled(c))
  if (!firstEditable) return undefined
  return createHistoryProvider({
    storage: opts.storage!,
    retention: getHistoryRetention(firstEditable[1]),
  })
}
