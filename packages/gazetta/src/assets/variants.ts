/**
 * Responsive-variant generation for image assets.
 *
 * Single responsibility: given the original bytes of an image, produce
 * resized variants at the v1 target widths. No storage, no manifest, no
 * naming policy — callers (ingest pipeline) compose this with byte
 * persistence and manifest writing.
 *
 * v1 target widths: 400 / 800 / 1200 / 1600. Variants wider than the
 * source image are skipped (no upscaling — the browser's srcset picker
 * is happy with fewer candidates, and upscaled variants would be worse
 * than the original). Same format as input (JPEG → JPEG, PNG → PNG).
 *
 * Format conversion (WebP/AVIF emission) is a separate capability and
 * lives out of scope for this module.
 */
import sharp, { type FormatEnum, type Sharp } from 'sharp'

/** The v1 srcset ladder. Ordered ascending — callers rely on this. */
export const VARIANT_WIDTHS: readonly number[] = [400, 800, 1200, 1600]

export interface GeneratedVariant {
  /** Target width this variant was rendered at. */
  width: number
  /** The resized image bytes. */
  bytes: Uint8Array
}

/**
 * Generate responsive variants from a source image buffer. Produces one
 * variant per `VARIANT_WIDTHS` entry that is ≤ the source image's width.
 *
 * Same output format as the input (JPEG stays JPEG, PNG stays PNG) —
 * re-compression is implicit via sharp's encoder, which applies its
 * quality defaults. Explicit quality/compression tuning is deferred to
 * a future image-pipeline config module.
 *
 * Throws whatever sharp throws on unreadable input — the caller is
 * responsible for treating that as a hard ingest failure (per v1
 * contract: rollback + fail the upload).
 */
export async function generateVariants(source: Uint8Array): Promise<GeneratedVariant[]> {
  // Decode once, reuse for every target width — avoids re-parsing the
  // source for each resize.
  const base = sharp(source)
  const meta = await base.metadata()
  const sourceWidth = meta.width ?? 0
  const sourceFormat = meta.format
  if (!sourceFormat) {
    throw new Error('Image format could not be determined for variant generation')
  }

  const picked = VARIANT_WIDTHS.filter(w => w <= sourceWidth)

  const out: GeneratedVariant[] = []
  for (const width of picked) {
    // Re-construct per iteration; sharp pipelines are single-use once
    // `.toBuffer()` has run.
    const pipeline = sharp(source).resize({ width })
    const bytes = await toSourceFormat(pipeline, sourceFormat).toBuffer()
    out.push({ width, bytes: new Uint8Array(bytes) })
  }
  return out
}

/**
 * Route a sharp pipeline to the encoder matching the source format.
 * sharp auto-detects on `.toBuffer()` when the input had an explicit
 * format, but being explicit here keeps behavior deterministic and
 * makes future per-format quality tuning a one-line change.
 */
function toSourceFormat(pipeline: Sharp, format: Extract<keyof FormatEnum, string>): Sharp {
  switch (format) {
    case 'jpeg':
      return pipeline.jpeg()
    case 'png':
      return pipeline.png()
    default:
      // Should not be reached in v1 (ingest allowlist is JPEG + PNG).
      // If it does (future MIME expansion), the caller's rollback path
      // will fire on the thrown error — safer than silently defaulting.
      throw new Error(`Unsupported source format for variant generation: ${format}`)
  }
}
