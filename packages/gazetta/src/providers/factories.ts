import { dirname, isAbsolute, resolve } from 'node:path'
import type { StorageKind, StorageProvider } from '../types.js'
import { createFilesystemProvider } from './filesystem.js'

/**
 * Anchor for relative filesystem paths during config evaluation. The config
 * loader sets this to the directory of the config file currently being
 * evaluated; `filesystemStorage()` reads it to resolve relative `path:`
 * arguments against the config file's directory rather than CWD.
 *
 * Why `globalThis` rather than a module-level variable: jiti loads the
 * operator's `site.config.ts` in a separate module graph from the host
 * process. The `gazetta` package the operator imports inside the config
 * is a different module instance from the one the loader imports — so
 * a module-level variable set by the loader doesn't reach the factory
 * called from the config. `globalThis` is shared across module graphs in
 * the same process, so the state crosses the boundary.
 *
 * Cleared in a `finally` block by the loader after evaluation completes,
 * preventing test harnesses + concurrent loads from leaking state.
 */
const ANCHOR_KEY = '__gazettaConfigAnchor__'

interface AnchorHolder {
  [ANCHOR_KEY]?: string | null
}

/** @internal — used by the config loader. Not part of the operator API. */
export function setConfigAnchor(absolutePath: string | null): void {
  ;(globalThis as AnchorHolder)[ANCHOR_KEY] = absolutePath
}

function getConfigAnchor(): string | null {
  return (globalThis as AnchorHolder)[ANCHOR_KEY] ?? null
}

/** @internal — derive a config anchor from a config file path. */
export function configAnchorFromFile(filePath: string): string {
  return dirname(filePath)
}

/**
 * Operator-facing storage provider factories. Operators import these into
 * `site.config.ts` and call them inline; the field's value IS the constructed
 * `StorageProvider` instance (Path X — see `design-provider-config.md`).
 *
 * Each factory:
 * 1. Validates required options at construction; throws Error with a message
 *    naming the missing/invalid field.
 * 2. Delegates to the internal `create*Provider` factory for the actual
 *    construction. Internal factories stay public for tests + advanced wiring.
 *
 * Optional SDK dependencies (Azure, AWS S3) are loaded lazily on first method
 * call so sites that don't use those providers don't pay the install cost.
 *
 * Filesystem path semantics: paths are resolved by Node's filesystem APIs
 * relative to `process.cwd()` (which is the project root when CLI commands
 * run). Default `path` is `./targets/local`; operators wanting per-target
 * paths specify them explicitly per the locked Phase 1 contract.
 */

export interface FilesystemStorageOptions {
  /** Storage root path. Relative paths resolve against CWD (project root
   *  when invoked via `gazetta` CLI). Absolute paths are used as-is.
   *  Default: `./targets/local`. */
  path?: string
}

/** Filesystem storage. Defaults `path` to `./targets/local`. Relative paths
 *  resolve against the directory of the `site.config.ts` (or
 *  `gazetta.config.ts`) that called this factory. Absolute paths are used
 *  as-is. Outside config-evaluation (tests, advanced wiring), relative
 *  paths fall back to CWD-relative resolution. */
export function filesystemStorage(opts: FilesystemStorageOptions = {}): StorageProvider {
  const path = opts.path ?? './targets/local'
  const anchor = getConfigAnchor()
  const root = isAbsolute(path) ? path : anchor ? resolve(anchor, path) : resolve(path)
  return { ...createFilesystemProvider(root), kind: 'filesystem' }
}

export interface R2StorageOptions {
  accountId: string
  bucket: string
  accessKeyId: string
  secretAccessKey: string
  /** Optional S3 region. Defaults to 'auto' for R2 per the SDK. */
  region?: string
}

/** Cloudflare R2 storage (S3-compatible). Requires `@aws-sdk/client-s3` +
 *  `@aws-sdk/lib-storage` as optional peer deps. */
export function r2Storage(opts: R2StorageOptions): StorageProvider {
  if (!opts.accountId) throw new Error('r2Storage: "accountId" is required')
  if (!opts.bucket) throw new Error('r2Storage: "bucket" is required')
  if (!opts.accessKeyId) {
    throw new Error(
      'r2Storage: "accessKeyId" is required. Set R2_ACCESS_KEY_ID and pass `process.env.R2_ACCESS_KEY_ID!`.\n' +
        '  Create an R2 API token at https://dash.cloudflare.com/<account>/r2/api-tokens',
    )
  }
  if (!opts.secretAccessKey) {
    throw new Error('r2Storage: "secretAccessKey" is required. Set R2_SECRET_ACCESS_KEY in your env.')
  }
  return lazyS3Provider(
    'r2',
    'r2Storage',
    {
      endpoint: `https://${opts.accountId}.r2.cloudflarestorage.com`,
      bucket: opts.bucket,
      accessKeyId: opts.accessKeyId,
      secretAccessKey: opts.secretAccessKey,
      region: opts.region,
    },
    'R2 storage requires @aws-sdk/client-s3 and @aws-sdk/lib-storage. ' +
      'Install them: npm install @aws-sdk/client-s3 @aws-sdk/lib-storage',
  )
}

export interface S3StorageOptions {
  endpoint: string
  bucket: string
  accessKeyId: string
  secretAccessKey: string
  region?: string
}

/** AWS S3 / MinIO / S3-compatible storage. Requires `@aws-sdk/client-s3` +
 *  `@aws-sdk/lib-storage`. */
export function s3Storage(opts: S3StorageOptions): StorageProvider {
  if (!opts.endpoint) throw new Error('s3Storage: "endpoint" is required')
  if (!opts.bucket) throw new Error('s3Storage: "bucket" is required')
  if (!opts.accessKeyId) throw new Error('s3Storage: "accessKeyId" is required')
  if (!opts.secretAccessKey) throw new Error('s3Storage: "secretAccessKey" is required')
  return lazyS3Provider(
    's3',
    's3Storage',
    {
      endpoint: opts.endpoint,
      bucket: opts.bucket,
      accessKeyId: opts.accessKeyId,
      secretAccessKey: opts.secretAccessKey,
      region: opts.region,
    },
    'S3 storage requires @aws-sdk/client-s3 and @aws-sdk/lib-storage. ' +
      'Install them: npm install @aws-sdk/client-s3 @aws-sdk/lib-storage',
  )
}

export interface AzureBlobStorageOptions {
  connectionString: string
  container: string
}

/** Azure Blob storage. Requires `@azure/storage-blob`. Use
 *  `connectionString: 'UseDevelopmentStorage=true'` for the Azurite emulator. */
export function azureBlobStorage(opts: AzureBlobStorageOptions): StorageProvider {
  if (!opts.connectionString) throw new Error('azureBlobStorage: "connectionString" is required')
  if (!opts.container) throw new Error('azureBlobStorage: "container" is required')
  return lazyAzureProvider(opts.connectionString, opts.container)
}

// --- internal helpers ---

interface S3FactoryArgs {
  endpoint: string
  bucket: string
  accessKeyId: string
  secretAccessKey: string
  region?: string
}

/**
 * Wraps the internal S3 factory in a lazy-init proxy: the SDK is imported on
 * the first method call, not at construction time. Construction always
 * succeeds with valid options; auth + connectivity errors surface on first
 * use (per Path X's construction-timing convention — see
 * `design-provider-config.md` "Construction timing").
 */
function lazyS3Provider(
  kind: StorageKind,
  factoryName: string,
  args: S3FactoryArgs,
  missingSdkMessage: string,
): StorageProvider {
  let real: StorageProvider | null = null
  const ensure = async (): Promise<StorageProvider> => {
    if (real) return real
    let createS3Provider: (a: S3FactoryArgs) => StorageProvider
    try {
      ;({ createS3Provider } = await import('./s3.js'))
    } catch {
      throw new Error(`${factoryName}: ${missingSdkMessage}`)
    }
    real = createS3Provider(args)
    return real
  }
  return makeLazyStorageProxy(kind, ensure)
}

function lazyAzureProvider(connectionString: string, container: string): StorageProvider {
  let real: StorageProvider | null = null
  const ensure = async (): Promise<StorageProvider> => {
    if (real) return real
    let createAzureBlobProvider: (a: { connectionString: string; container: string }) => StorageProvider
    try {
      ;({ createAzureBlobProvider } = await import('./azure-blob.js'))
    } catch {
      throw new Error(
        'azureBlobStorage: Azure Blob storage requires @azure/storage-blob. Install it: npm install @azure/storage-blob',
      )
    }
    real = createAzureBlobProvider({ connectionString, container })
    return real
  }
  return makeLazyStorageProxy('azure', ensure)
}

/**
 * Returns a `StorageProvider` whose methods all defer to a real provider
 * resolved on first invocation via `ensure()`. Per-method passthrough means
 * the proxy contract matches `StorageProvider` exactly without inheritance.
 *
 * `init()` is exposed because the internal S3 + Azure providers offer it for
 * connectivity probes (target registry's parallel-init pattern); the proxy
 * forwards to the real provider's `init` when present.
 *
 * `kind` is a plain field on the proxy so reading it never loads the SDK.
 */
function makeLazyStorageProxy(
  kind: StorageKind,
  ensure: () => Promise<StorageProvider>,
): StorageProvider & { init(): Promise<void> } {
  return {
    kind,
    async readFile(path) {
      return (await ensure()).readFile(path)
    },
    async readDir(path) {
      return (await ensure()).readDir(path)
    },
    async exists(path) {
      return (await ensure()).exists(path)
    },
    async writeFile(path, content) {
      return (await ensure()).writeFile(path, content)
    },
    async readBytes(path) {
      return (await ensure()).readBytes(path)
    },
    async writeBytes(path, content) {
      return (await ensure()).writeBytes(path, content)
    },
    async mkdir(path) {
      return (await ensure()).mkdir(path)
    },
    async rm(path) {
      return (await ensure()).rm(path)
    },
    async readStream(path, range) {
      return (await ensure()).readStream(path, range)
    },
    async writeStream(path, stream) {
      return (await ensure()).writeStream(path, stream)
    },
    async init() {
      const real = await ensure()
      const initFn = (real as StorageProvider & { init?: () => Promise<void> }).init
      if (typeof initFn === 'function') await initFn.call(real)
    },
  }
}
