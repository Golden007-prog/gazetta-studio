/**
 * Asset-upload validation policy. Pure — takes a candidate (name, claimed
 * size, claimed MIME, sniffed MIME) and throws a typed validation error on
 * the first failure. No I/O, no storage, no network.
 *
 * Keeping this pure means:
 * - Tests are trivial: pass candidate data in, assert the thrown class
 * - The same policy applies whether the caller is the HTTP route, a CLI
 *   import command, or the future paste-URL handler
 * - Policy evolves in one place
 *
 * Each validation failure throws a distinct `AssetValidationError`
 * subclass (`AssetNameInvalidError`, `AssetPathTraversalError`, etc.).
 * Callers that want to group all input-validation failures uniformly can
 * still pattern-match on the base `AssetValidationError`.
 */
import {
  AssetMimeMismatchError,
  AssetNameInvalidError,
  AssetNameReservedError,
  AssetPathTraversalError,
  AssetSizeExceededError,
} from './errors.js'
import { STATE_ROOT } from '../state-folders.js'

/**
 * Default per-asset upload size cap — 50 MB. Sites override per target
 * via `targets.{name}.assets.maxBytes` in `site.config.ts`. Targets that
 * don't override get this value.
 *
 * Why a default at all (per Q5):
 *   - DoS / OOM bound: ingest buffers the full upload in memory today
 *     (`collectBytes` in ingest.ts). Concurrent uploads × cap = peak
 *     memory; without a cap, one careless or malicious client can
 *     exhaust the admin process.
 *   - Storage-cost protection: a 200 MB raw photo × variant ladder ×
 *     locale overrides quickly compounds. The cap forces explicit
 *     opt-in for unusual sizes.
 *   - Worker-tier ceiling: Cloudflare Workers Free/Pro have a 100 MB
 *     response body limit — a target on that tier can't serve assets
 *     above it via the worker. Sites should lower the cap below the
 *     worker tier they're on.
 *
 * 50 MB is conservative for image-only v1. Sites with raw-photo
 * workflows (24-48 MP camera output) have headroom; sites on free
 * worker tiers should reduce explicitly.
 */
export const DEFAULT_ASSET_MAX_BYTES = 50 * 1024 * 1024

/**
 * @deprecated Renamed to `DEFAULT_ASSET_MAX_BYTES`. Use the per-target
 * config (`targets.{name}.assets.maxBytes`) for site-specific limits;
 * this constant is the fallback default. Kept exported until the next
 * major version so external callers (tests, integrations) don't break.
 */
export const ASSET_MAX_BYTES = DEFAULT_ASSET_MAX_BYTES

/**
 * v1 MIME allowlist. Image side: JPEG, PNG, SVG, GIF. Audio side:
 * MP3, WAV, FLAC, Opus, AAC, M4A, OGG.
 *
 *   - SVG is sanitized before persistence (`svg-sanitize.ts`)
 *   - GIF is checked for animation by `animatedImageAnalyzer`
 *   - Audio MIMEs are analyzed by `audioAnalyzer` for duration
 *     (`music-metadata`); personal-metadata stripping is a v1.5
 *     opt-in via a future preprocessor surface
 *
 * Animated WebP/AVIF, video, and documents widen via this set in
 * v1.1+. The analyzer/preprocessor abstractions accommodate each
 * format-specific need without orchestrator edits.
 */
export const ALLOWED_MIMES = new Set<string>([
  // Images
  'image/jpeg',
  'image/png',
  'image/svg+xml',
  'image/gif',
  // Audio
  'audio/mpeg',
  'audio/wav',
  'audio/x-wav',
  'audio/flac',
  'audio/x-flac',
  'audio/ogg',
  'audio/opus',
  'audio/aac',
  'audio/mp4',
  'audio/x-m4a',
])

/** Asset-name validation: lowercase ASCII-safe characters. */
const VALID_NAME = /^[a-z0-9][a-z0-9\-_]*(?:\.[a-z0-9]+)?$/
/** Max chars per asset name. */
const MAX_NAME_LENGTH = 200

/** Reserved name patterns — authors can't upload anything that would collide with internals. */
const RESERVED_PREFIXES = ['.', '_refs/', `${STATE_ROOT}/`]
const RESERVED_SUFFIXES = ['.asset.json']

export interface UploadCandidate {
  /** Desired asset name (what the author chose, pre-slug). */
  name: string
  /** Bytes received so far; the stream is still flowing. */
  claimedSize: number
  /** MIME sniffed from the bytes. Null when sniffing failed. */
  sniffedMime: string | null
}

/**
 * Per-target validation policy. Today carries the size cap; future
 * fields (allowed MIMEs subset, name pattern overrides) extend this
 * interface without changing the validator's signature.
 */
export interface UploadPolicy {
  /** Override the default per-target. When undefined, uses DEFAULT_ASSET_MAX_BYTES. */
  maxBytes?: number
}

/**
 * Validate an upload candidate against the per-target policy. Throws
 * the specific `AssetValidationError` subclass for the first failure
 * encountered — policy enforces fail-fast so the HTTP route returns a
 * single, specific reason to the client.
 *
 * `policy` is optional — callers that haven't migrated to per-target
 * config get the default size cap. Once asset routes thread the
 * target config through, `policy` is always present.
 */
export function validateUpload(candidate: UploadCandidate, policy: UploadPolicy = {}): void {
  assertName(candidate.name)
  assertSize(candidate.claimedSize, policy.maxBytes ?? DEFAULT_ASSET_MAX_BYTES)
  assertMime(candidate.sniffedMime)
}

function assertName(name: string): void {
  if (name.length === 0 || name.length > MAX_NAME_LENGTH) {
    throw new AssetNameInvalidError(name, `Asset name must be 1–${MAX_NAME_LENGTH} characters (got ${name.length})`)
  }

  // Path-traversal: `..`, leading `/`, or backslash anywhere
  if (name.includes('..') || name.startsWith('/') || name.includes('\\')) {
    throw new AssetPathTraversalError(name)
  }

  // Reserved prefixes and suffixes
  for (const prefix of RESERVED_PREFIXES) {
    if (name.startsWith(prefix)) {
      throw new AssetNameReservedError(name, prefix, 'prefix')
    }
  }
  for (const suffix of RESERVED_SUFFIXES) {
    if (name.endsWith(suffix)) {
      throw new AssetNameReservedError(name, suffix, 'suffix')
    }
  }

  // Character rules (lowercase ASCII, digits, hyphens, underscores, optional extension)
  if (!VALID_NAME.test(name)) {
    throw new AssetNameInvalidError(
      name,
      `Asset name must be lowercase ASCII letters/digits/hyphens/underscores with optional extension: ${name}`,
    )
  }
}

function assertSize(claimedSize: number, maxBytes: number): void {
  if (claimedSize <= 0 || claimedSize > maxBytes) {
    throw new AssetSizeExceededError(claimedSize, maxBytes)
  }
}

function assertMime(sniffedMime: string | null): void {
  if (!sniffedMime || !ALLOWED_MIMES.has(sniffedMime)) {
    throw new AssetMimeMismatchError(sniffedMime, [...ALLOWED_MIMES])
  }
}
