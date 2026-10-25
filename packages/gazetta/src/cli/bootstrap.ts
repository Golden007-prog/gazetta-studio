/**
 * Shared bootstrap helpers for CLI commands and the dev server admin bootstrap.
 *
 * Responsibility: load site.config.ts from the project site directory, build a
 * TargetRegistry from its targets, and derive a SourceContext pointing at
 * the default editable target. Callers compose these primitives; the admin
 * API and `createServer` runtime take over from there.
 */

import { dirname, join } from 'node:path'
import { gazettaConfigToManifest, loadGazettaConfig, loadSiteConfig, siteConfigToManifest } from '../config/loader.js'
import { createTargetRegistry, createTargetRegistryView, EDITING_TARGET_EXAMPLE } from '../targets.js'
import type { GazettaManifest, SiteManifest, TargetConfig, StorageProvider } from '../types.js'
import { createSourceContextFromRegistry, type SourceContext } from '../admin-api/source-context.js'
import type { TargetRegistry } from '../targets.js'

export interface BootstrapResult {
  /** Loaded site manifest (derived from site.config.ts). */
  manifest: SiteManifest
  /** Target configurations declared in site.config.ts. */
  targetConfigs: Record<string, TargetConfig>
  /** Fully-initialized target registry (providers built, cloud targets connected). */
  registry: TargetRegistry
  /**
   * Optional gazetta-level manifest (from `gazetta.config.ts` at project root).
   * First rung of the three-rung config chain (gazetta → site → target).
   * Absent when no `gazetta.config.ts` exists.
   */
  gazettaManifest?: GazettaManifest
}

async function loadManifestFromConfig(projectSiteDir: string): Promise<SiteManifest> {
  const loaded = await loadSiteConfig(projectSiteDir)
  if (!loaded) {
    throw new Error(
      `No site.config.ts found in ${projectSiteDir}. ` +
        `Add a site.config.ts (using defineSite from 'gazetta') or run \`gazetta init\` to scaffold one.`,
    )
  }
  return siteConfigToManifest(loaded.config)
}

/**
 * Load the gazetta-level config (from `gazetta.config.ts` at project root).
 * Returns undefined when the file is absent — gazetta config is optional.
 *
 * The project root is the directory above the `sites/` parent of the
 * given `projectSiteDir`. For flat layouts (no `sites/` dir), we walk
 * up one level. The loader returns null when no config exists, and
 * we widen to `undefined` to match the GazettaManifest? optional shape.
 */
async function loadGazettaManifestFromProject(projectSiteDir: string): Promise<GazettaManifest | undefined> {
  // projectSiteDir is typically `<root>/sites/<name>` for multi-site layouts
  // or `<root>` for flat. Walk up to the directory that contains either
  // `sites/` or `package.json` — that's the project root where
  // `gazetta.config.ts` lives.
  const projectRoot = inferProjectRoot(projectSiteDir)
  const gazetta = await loadGazettaConfig(projectRoot)
  return gazetta ? gazettaConfigToManifest(gazetta) : undefined
}

function inferProjectRoot(projectSiteDir: string): string {
  // sites/<name> layout → walk up two levels
  const parent = dirname(projectSiteDir)
  if (parent.endsWith('/sites') || parent.endsWith('\\sites')) {
    return dirname(parent)
  }
  // Flat layout → projectSiteDir IS the project root
  return projectSiteDir
}

/**
 * A target without `storage` would otherwise fail later, with a TypeError from
 * whichever command first reads it (resolving public storage reads every
 * target's storage kind).
 */
function assertTargetsHaveStorage(targetConfigs: Record<string, TargetConfig>, configPath: string): void {
  for (const [name, config] of Object.entries(targetConfigs)) {
    if (!config?.storage) {
      throw new Error(
        `Target "${name}" in ${configPath} has no \`storage\`. Every target needs one, such as \`storage: filesystemStorage()\`.`,
      )
    }
  }
}

/**
 * Load site.config.ts, initialize all targets, and return a TargetRegistry view.
 * Throws if site.config.ts is missing or has no targets declared.
 */
/**
 * Hoist `gazetta.config.ts` defaults into the site manifest (object
 * fields only; a site-level value always wins). The config loader
 * applies the same merge to `SiteConfig` via `applyGazettaDefaults`,
 * but the CLI path works with manifests and previously never applied
 * it, so `defaults.cache` and `defaults.audit` were silently ignored
 * by dev, admin and publish (#1373).
 */
function applyManifestDefaults(manifest: SiteManifest, gazettaManifest?: GazettaManifest): SiteManifest {
  const defaults = gazettaManifest?.defaults
  if (!defaults) return manifest
  const admin = manifest.admin ?? {}
  return {
    ...manifest,
    cache: manifest.cache ?? defaults.cache,
    admin: { ...admin, audit: admin.audit ?? defaults.audit },
  }
}

export async function bootstrapFromSiteYaml(projectSiteDir: string): Promise<BootstrapResult> {
  const gazettaManifest = await loadGazettaManifestFromProject(projectSiteDir)
  const manifest = applyManifestDefaults(await loadManifestFromConfig(projectSiteDir), gazettaManifest)
  const targetConfigs = manifest.targets ?? {}

  if (Object.keys(targetConfigs).length === 0) {
    throw new Error(
      `No targets declared in ${join(projectSiteDir, 'site.config.ts')}. At least one target is required — ` +
        `add a local target:\n\n${EDITING_TARGET_EXAMPLE}`,
    )
  }
  assertTargetsHaveStorage(targetConfigs, join(projectSiteDir, 'site.config.ts'))

  const providers = await createTargetRegistry(targetConfigs)
  const registry = createTargetRegistryView(providers, targetConfigs)
  return { manifest, targetConfigs, registry, gazettaManifest }
}

export interface BuildSourceContextOptions {
  projectSiteDir: string
  /** Pre-loaded manifest to avoid re-loading site.config.ts when caller already has it. */
  manifest?: SiteManifest
  /** Explicit target name. Defaults to the registry's defaultEditable(). */
  targetName?: string
}

/**
 * High-level: load site.config.ts, init only the chosen editable target, return a
 * SourceContext and metadata. Cloud/remote targets are not initialized —
 * callers that need them (publish, fetch, compare) init on demand.
 *
 * Rationale: validate and dev-bootstrap only need the source (editable local)
 * target; initializing cloud targets upfront adds seconds of latency and
 * surfaces spurious failures when credentials aren't configured.
 */
export async function buildSourceContext(opts: BuildSourceContextOptions): Promise<{
  source: SourceContext
  manifest: SiteManifest
  targetConfigs: Record<string, TargetConfig>
  gazettaManifest?: GazettaManifest
}> {
  const gazettaManifest = await loadGazettaManifestFromProject(opts.projectSiteDir)
  const manifest = applyManifestDefaults(
    opts.manifest ?? (await loadManifestFromConfig(opts.projectSiteDir)),
    gazettaManifest,
  )
  const targetConfigs = manifest.targets ?? {}
  if (Object.keys(targetConfigs).length === 0) {
    throw new Error(
      `No targets declared in ${join(opts.projectSiteDir, 'site.config.ts')}. At least one target is required — ` +
        `add a local target:\n\n${EDITING_TARGET_EXAMPLE}`,
    )
  }
  assertTargetsHaveStorage(targetConfigs, join(opts.projectSiteDir, 'site.config.ts'))

  // Pick the editable target (explicit override or first editable in declaration order).
  const { isEditable } = await import('../types.js')
  const editableNames = Object.entries(targetConfigs)
    .filter(([, cfg]) => isEditable(cfg))
    .map(([n]) => n)
  if (editableNames.length === 0) {
    throw new Error(
      `No editable target in ${join(opts.projectSiteDir, 'site.config.ts')}. ` +
        `Targets default to public storage, which isn't editable. Mark your editing target:\n\n${EDITING_TARGET_EXAMPLE}`,
    )
  }
  const targetName = opts.targetName ?? editableNames[0]
  const config = targetConfigs[targetName]
  if (!config) {
    const { UnknownTargetError } = await import('../targets.js')
    throw new UnknownTargetError(targetName)
  }
  if (!isEditable(config)) {
    throw new Error(`Target "${targetName}" is not editable`)
  }

  // Storage is already a constructed provider (Path X — operator-facing
  // factory ran at config-eval). Init the connection if the provider
  // exposes one (S3 + Azure use this for connectivity probes).
  const storage = config.storage
  const initProvider = storage as StorageProvider & { init?: () => Promise<void> }
  if (typeof initProvider.init === 'function') {
    await initProvider.init()
  }

  // Build a single-target view; callers that need cross-target access call
  // bootstrapFromSiteYaml() instead (or use admin-api's lazy target init).
  const singleTargetProviders = new Map<string, StorageProvider>([[targetName, storage]])
  const registry = createTargetRegistryView(singleTargetProviders, targetConfigs)

  const source = createSourceContextFromRegistry({
    registry,
    targetName,
    projectSiteDir: opts.projectSiteDir,
    manifest,
    gazettaManifest,
  })

  return { source, manifest, targetConfigs, gazettaManifest }
}
