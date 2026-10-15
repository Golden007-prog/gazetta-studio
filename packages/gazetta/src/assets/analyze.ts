/**
 * Format-specific upload analyzers — the seam where formats contribute
 * manifest fields and supplementary files alongside the primary bytes.
 *
 * # Why a peer abstraction to `UploadPreprocessor`
 *
 * Preprocessors transform input bytes (SVG sanitization, future EXIF
 * orientation flatten, future HEIC→JPEG transcode). They run BEFORE
 * the hash — the sanitized/transformed bytes are what we content-
 * address.
 *
 * Analyzers read the final bytes (post-preprocess, hash settled) and
 * produce two kinds of output:
 *
 *   - **Manifest enrichment** — format-specific fields. Animated GIF
 *     contributes `animated: true`, `frames: N`, `duration: ms`.
 *     Audio contributes `duration`. PDF could contribute `pageCount`.
 *   - **Supplementary files** — extra byte writes alongside the
 *     primary asset. Animated images contribute a first-frame
 *     `poster.png`. Future PDF analysis contributes a first-page
 *     thumbnail. Future audio analysis contributes a waveform image.
 *
 * Folding manifest enrichment + bytes-transform into one interface
 * was rejected: distinct lifecycles (pre-hash vs post-hash), distinct
 * concerns, distinct test shapes. Two interfaces per SRP.
 *
 * # SOLID lenses
 *
 *   - SRP: each analyzer owns one format's "read bytes, return
 *     metadata + extras"
 *   - OCP: adding a format = new analyzer module + register; ingest
 *     unchanged
 *   - LSP: every analyzer honors `(mime, bytes) → AnalysisResult`
 *   - ISP: analyzer interface is small; ingest depends on the
 *     `runAnalyzers` function, not on individual analyzers
 *   - DIP: ingest depends on the abstraction; analyzers implement it
 *
 * Adding a new format-specific analyzer is one new module + one
 * registration. Ingest stays generic.
 */
import type { AssetManifest } from '../schema/types.js'

/**
 * Manifest fields an analyzer is allowed to set. Subset of
 * `AssetManifest` — analyzers can't change identity (`name`, `kind`,
 * `source`, `mime`, `hash`, `size`) or audit (`uploadedAt`,
 * `uploadedBy`). They contribute *characterization* fields:
 * dimensions, animation flags, duration, poster URL, focal point if
 * extractable from EXIF, etc.
 *
 * Listed explicitly (rather than `Partial<AssetManifest>`) so the
 * type system catches an analyzer that tries to override identity
 * fields by accident.
 */
interface ManifestEnrichment {
  /** Width in pixels — null for non-image formats. */
  width?: number | null
  /** Height in pixels — null for non-image formats. */
  height?: number | null
  /** Multi-frame indicator (GIF, APNG, animated WebP/AVIF). */
  animated?: boolean
  /** Frame count for animated content (≥ 1). */
  frames?: number
  /** Duration in milliseconds — animated images, video, audio. */
  duration?: number | null
  /** Relative path to the poster bytes (under assetsRoot). */
  poster?: string | null
}

/**
 * A supplementary file the analyzer wants written alongside the
 * primary asset bytes (and in the manifest's enrichment, where
 * relevant via `poster`/etc. paths). The runner adds these to the
 * write plan so they participate in atomic-rollback.
 */
interface SupplementaryFile {
  /** Path relative to `assetsRoot` — e.g. `hero-{hash}-poster.png`. */
  path: string
  /** Bytes to write. */
  bytes: Uint8Array
}

export interface AnalysisResult {
  /**
   * Fields to merge into the manifest. The runner validates that no
   * forbidden field is set; analyzers that try to set identity
   * fields are rejected at the type level (the interface excludes
   * them).
   */
  manifestPatch?: ManifestEnrichment
  /** Supplementary byte files to write. */
  supplementaryFiles?: readonly SupplementaryFile[]
}

/**
 * One format's analysis contract. Implementations are async (sharp
 * I/O is async) but otherwise pure — no storage access, no manifest
 * writing, no logging. The runner orchestrates side effects.
 *
 * `assetName` and `hash` are passed in so analyzers that produce
 * supplementary files can name them deterministically (e.g.
 * `{name}-{hash}-poster.png`).
 */
export interface UploadAnalyzer {
  /** Stable identifier for diagnostics (`'animated-image'`, `'audio'`). */
  readonly name: string
  /** Whether this analyzer applies to the given MIME. */
  matches(mime: string | null): boolean
  /**
   * Read the bytes; return manifest enrichment + supplementary files.
   * Throw on malformed input — runner wraps in a typed error.
   */
  analyze(input: AnalyzerInput): Promise<AnalysisResult>
}

export interface AnalyzerInput {
  /** Final, post-preprocess bytes. */
  bytes: Uint8Array
  /** Asset name (canonical, no extension). For supplementary file paths. */
  assetName: string
  /** Asset hash. For supplementary file paths. */
  hash: string
  /** Source extension (`jpg`, `png`, `gif`, ...). For format-specific decisions. */
  ext: string
  /** Sniffed MIME — analyzers don't need to re-sniff. */
  mime: string
}

/**
 * Default analyzer registry — what ingest uses out of the box.
 * Order matters when more than one matches; analyzer results
 * later in the list win on field conflicts. Today's order:
 *   1. `staticImageAnalyzer` — width/height for all images except SVG
 *   2. `animatedImageAnalyzer` — multi-frame detection + poster
 *   3. `audioAnalyzer` — duration via music-metadata
 *
 * Both image analyzers run for animated images (static contributes
 * canvas dimensions, animated contributes animation flags + poster).
 * Audio MIMEs trigger only the audio analyzer.
 */
import { animatedImageAnalyzer, staticImageAnalyzer } from './analyze-image.js'
import { audioAnalyzer } from './analyze-audio.js'

const defaultAnalyzers: readonly UploadAnalyzer[] = [staticImageAnalyzer, animatedImageAnalyzer, audioAnalyzer]

/**
 * Run the matching analyzer(s) for the given MIME. Returns the
 * merged enrichment + flattened supplementary files. Pass-through
 * (no enrichment, no extras) when no analyzer matches.
 *
 * Multiple analyzers matching the same MIME is allowed — results
 * are merged (later wins on field conflicts; supplementary files
 * concatenate). v1 exercises this for animated images: both static
 * and animated analyzers run.
 */
export async function runAnalyzers(
  input: AnalyzerInput,
  analyzers: readonly UploadAnalyzer[] = defaultAnalyzers,
): Promise<AnalysisResult> {
  let manifestPatch: ManifestEnrichment | undefined
  const supplementaryFiles: SupplementaryFile[] = []

  for (const analyzer of analyzers) {
    if (!analyzer.matches(input.mime)) continue
    const result = await analyzer.analyze(input)
    if (result.manifestPatch) {
      manifestPatch = { ...manifestPatch, ...result.manifestPatch }
    }
    if (result.supplementaryFiles) {
      supplementaryFiles.push(...result.supplementaryFiles)
    }
  }

  return {
    manifestPatch,
    supplementaryFiles: supplementaryFiles.length > 0 ? supplementaryFiles : undefined,
  }
}
