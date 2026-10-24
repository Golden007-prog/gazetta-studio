import type { StorageProvider, TargetConfig } from './types.js'
import { isEditable } from './types.js'

/**
 * Target resolution surface used by route handlers and anything that needs
 * to act on a specific named target. Narrow by intent: route factories that
 * only list targets take `list()`; handlers that load content take `get()`;
 * publish-aware code reads `getConfig()` to branch on type or environment.
 *
 * Implementations decide how to initialize providers — eagerly at boot,
 * lazily on first access, or mocked for tests.
 */
export interface TargetRegistry {
  /** Resolve a target name to its storage provider. Throws if unknown. */
  get(name: string): StorageProvider
  /** Configuration for a target (type, environment, editable). */
  getConfig(name: string): TargetConfig | undefined
  /** All known target names. */
  list(): string[]
  /**
   * Name of the default editable target for this site. Throws if none exists.
   * Resolution: first target where `isEditable(config) === true`, in the order
   * they appear in site.config.ts.
   */
  defaultEditable(): string
}

export class UnknownTargetError extends Error {
  constructor(name: string) {
    super(`Unknown target: ${name}`)
    this.name = 'UnknownTargetError'
  }
}
/**
 * The config that gives a site its editing target. Storage is assumed public
 * unless the target says otherwise, and a public target isn't editable
 * (design-public-storage.md Q6), so a bare `filesystemStorage()` target
 * doesn't edit: `editable: true` makes it private and editable.
 */
export const EDITING_TARGET_EXAMPLE = 'targets: {\n  local: { storage: filesystemStorage(), editable: true },\n}\n'

export class NoEditableTargetError extends Error {
  constructor() {
    super(
      "No editable target is configured. Targets default to public storage, which isn't editable. " +
        `Mark your editing target in site.config.ts:\n\n${EDITING_TARGET_EXAMPLE}`,
    )
    this.name = 'NoEditableTargetError'
  }
}

/**
 * Build a TargetRegistry from already-initialized providers and their configs.
 * Per Phase 1 (Path X), storage providers are constructed by operator-facing
 * factories at config-eval time; the registry consumes the resulting
 * `StorageProvider` instances directly. Tests pass in-memory providers.
 */
export function createTargetRegistryView(
  providers: Map<string, StorageProvider>,
  configs: Record<string, TargetConfig>,
): TargetRegistry {
  const orderedNames = Object.keys(configs)
  return {
    get(name) {
      const p = providers.get(name)
      if (!p) throw new UnknownTargetError(name)
      return p
    },
    getConfig(name) {
      return configs[name]
    },
    list() {
      return [...orderedNames]
    },
    defaultEditable() {
      for (const name of orderedNames) {
        const cfg = configs[name]
        if (cfg && isEditable(cfg)) return name
      }
      throw new NoEditableTargetError()
    },
  }
}

/** Find all editable targets in declaration order. Pure helper. */
export function listEditableTargets(configs: Record<string, TargetConfig>): string[] {
  return Object.entries(configs)
    .filter(([, cfg]) => isEditable(cfg))
    .map(([name]) => name)
}

/**
 * Expand `${VAR}` placeholders in a string by reading from `process.env`.
 * Empty or undefined input passes through. Used by purge-config resolution
 * (`PurgeConfig.apiToken`, `zoneId`) where operators may reference env
 * vars without writing `process.env.X!` directly. Storage credentials
 * use `process.env.X!` at the factory call site (Path X) and don't go
 * through this helper.
 */
export function resolveEnvVars(value: string | undefined): string | undefined {
  if (!value) return value
  return value.replace(/\$\{(\w+)\}/g, (_, name) => process.env[name] ?? '')
}

/**
 * Per-target init timeout — guards against SDKs that hang on unreachable
 * endpoints instead of surfacing the connection error. 10s is generous for
 * cold-start against real cloud storage and still fast enough that a
 * missing local emulator doesn't wedge the dev server for long.
 */
const TARGET_INIT_TIMEOUT_MS = 10000

/**
 * Initialize all target providers in parallel, calling each provider's
 * optional `init()` method (used for connectivity probes by S3 / Azure).
 * Returns a `Map<targetName, StorageProvider>` ready for
 * `createTargetRegistryView`.
 *
 * Failed inits are logged and skipped — callers see a partial registry.
 * Slow inits time out at `TARGET_INIT_TIMEOUT_MS` so a hanging SDK doesn't
 * stall the whole boot.
 */
export async function createTargetRegistry(
  targets: Record<string, TargetConfig>,
): Promise<Map<string, StorageProvider>> {
  const registry = new Map<string, StorageProvider>()
  await Promise.all(
    Object.entries(targets).map(async ([name, config]) => {
      try {
        const initOne = async () => {
          const provider = config.storage
          const initFn = (provider as StorageProvider & { init?: () => Promise<void> }).init
          if (typeof initFn === 'function') {
            await initFn.call(provider)
          }
          return provider
        }
        const timeout = new Promise<never>((_, reject) =>
          setTimeout(
            () => reject(new Error(`init timed out after ${TARGET_INIT_TIMEOUT_MS}ms`)),
            TARGET_INIT_TIMEOUT_MS,
          ),
        )
        const provider = await Promise.race([initOne(), timeout])
        registry.set(name, provider)
      } catch (err) {
        console.warn(`  Warning: target "${name}" failed to initialize: ${(err as Error).message}`)
      }
    }),
  )
  return registry
}
