/**
 * SVG sanitization — strip script-execution surfaces, external network
 * references, and bloat-prone embedded data before the bytes ever touch
 * storage.
 *
 * Why SVG specifically: an SVG is XML and the spec allows scriptable
 * features (event handlers, `<script>`, `<foreignObject>` HTML embedding)
 * plus references to external resources via `href` / `xlink:href`. A
 * malicious SVG renders fine in a browser AND can exfiltrate data, fire
 * tracking pixels, or run JS in same-origin contexts.
 *
 * Design (per design-media.md → Security):
 *
 *   Strip:
 *     - <script>
 *     - event handlers (onload, onclick, onmouseover, etc.)
 *     - <foreignObject>           — embedded HTML (XSS surface)
 *     - <animate> with timed events
 *     - external `href` / `xlink:href` on <use>, <image>, <a>, <script>
 *       (any URL — privacy + XSS defense)
 *     - CSS that loads from the network: external url(), @import,
 *       image-set() or CSS escapes, in presentation attributes and
 *       `style` (the attribute is dropped) or in <style> (the element is
 *       dropped)
 *
 *   Keep:
 *     - <svg> root + path/shape/text/group elements
 *     - inline data: URIs (those are local; no network)
 *
 *   Warn:
 *     - embedded base64 data URI > 100 KB (bloat)
 *
 *   Reject:
 *     - embedded base64 data URI > 1 MB (bloat heuristic)
 *     - malformed XML (caller surfaces as upload validation failure)
 *
 * Hash + ingest contract: the hash is computed on the SANITIZED bytes,
 * not the input. A malicious SVG and a benign SVG that produce
 * identical sanitized output legitimately deduplicate. This means
 * re-uploading the "same" SVG that happens to have script tags as a
 * decoy hashes the same as a clean version — that's correct: content
 * addresses what we keep, not what we received.
 *
 * SSR-safe: `isomorphic-dompurify` works in Node without a DOM
 * polyfill, so we can sanitize at upload (Node) and at any future
 * server-side render path.
 */
import DOMPurify from 'isomorphic-dompurify'

const SVG_MIME = 'image/svg+xml'

/**
 * Soft warning: embedded base64 data URI larger than this triggers a
 * `large-base64` warning in the result. Authors might be embedding a
 * full PNG inside an SVG — usually a mistake.
 */
const BASE64_WARN_BYTES = 100 * 1024

/**
 * Hard reject: embedded base64 data URI larger than this fails
 * sanitization. Past this point the SVG is almost always carrying a
 * full image as a workaround that should be a separate asset.
 */
const BASE64_REJECT_BYTES = 1024 * 1024

export interface SvgSanitizeResult {
  /** Sanitized SVG bytes. UTF-8 encoded. */
  bytes: Uint8Array
  /** Non-fatal warnings (e.g., large embedded base64). Empty when clean. */
  warnings: readonly SvgSanitizeWarning[]
}

type SvgSanitizeWarning =
  | { code: 'large-base64'; sizeBytes: number; threshold: number }
  | { code: 'stripped-element'; tag: string }
  | { code: 'stripped-attribute'; attr: string; on: string }

/**
 * Thrown when sanitization can't proceed safely. Callers map to a
 * 400 Bad Request (it's a client-correctable input failure).
 */
export class SvgSanitizeError extends Error {
  readonly code: 'malformed-xml' | 'oversized-base64' | 'empty'
  constructor(code: 'malformed-xml' | 'oversized-base64' | 'empty', message: string) {
    super(message)
    this.code = code
    this.name = 'SvgSanitizeError'
  }
}

/**
 * Sanitize an SVG. Returns the cleaned bytes + any warnings.
 *
 * Throws `SvgSanitizeError` on inputs that can't be safely cleaned —
 * malformed XML, oversized embedded base64, or empty results after
 * sanitization (which would indicate the input was entirely
 * disallowed content).
 */
export function sanitizeSvg(input: Uint8Array): SvgSanitizeResult {
  const text = new TextDecoder('utf-8', { fatal: false }).decode(input).trim()
  if (text.length === 0) {
    throw new SvgSanitizeError('empty', 'Empty input — not a valid SVG')
  }

  // Fail fast on oversized embedded base64. We could trust DOMPurify
  // to leave it alone (data: URIs in <image> are valid), but the
  // bloat heuristic exists so the resulting asset isn't a 5 MB SVG
  // hiding a JPEG. Detect before sanitization to spare the parse.
  const oversized = findOversizedBase64(text)
  if (oversized !== null) {
    throw new SvgSanitizeError(
      'oversized-base64',
      `Embedded base64 data URI exceeds ${BASE64_REJECT_BYTES} bytes (got ${oversized}). Upload as a separate asset.`,
    )
  }

  const warnings: SvgSanitizeWarning[] = []

  // Track stripped elements + attributes via DOMPurify hooks for
  // diagnostic output, and filter URI-shaped attributes (href,
  // xlink:href) to allow only fragment refs (#id) and inline data:
  // URIs. NOTE: DOMPurify's `ALLOWED_URI_REGEXP` config option is
  // applied to ALL attribute values in some versions, not just
  // URI-shaped ones — `r="5"` on a <circle> would match against it
  // and be stripped. Hook-based filtering is the safe alternative.
  //
  // DOMPurify wraps non-document inputs in `<html><body>` for parsing;
  // its hooks fire on those wrapping elements as "stripped." Filter
  // out the wrapper tags so warnings only reflect content the author
  // actually wrote.
  const HOOK_NOISE = new Set(['html', 'head', 'body'])
  const ALLOWED_URI_PATTERN = /^(?:#|data:image\/(?:png|jpeg|gif|webp);base64,)/i
  const URI_BEARING_ATTRS = new Set(['href', 'xlink:href', 'src'])
  const removedElements = new Set<string>()
  const removedAttributes = new Set<string>()
  DOMPurify.removeAllHooks()
  DOMPurify.addHook('uponSanitizeElement', (node, data) => {
    if (HOOK_NOISE.has(data.tagName)) return
    if (!data.allowedTags[data.tagName]) {
      removedElements.add(data.tagName)
      return
    }
    if (data.tagName === 'style' && hasExternalCssReference(node.textContent ?? '')) {
      node.parentNode?.removeChild(node)
      removedElements.add('style')
    }
  })
  DOMPurify.addHook('uponSanitizeAttribute', (node, data) => {
    const ownerTag = node.nodeName.toLowerCase()
    // URI filtering: drop hrefs that aren't fragment-only or inline data:.
    if (URI_BEARING_ATTRS.has(data.attrName)) {
      if (data.attrValue && !ALLOWED_URI_PATTERN.test(data.attrValue)) {
        data.keepAttr = false
        removedAttributes.add(`${ownerTag}.${data.attrName}`)
        return
      }
    }
    if (HOOK_NOISE.has(ownerTag)) return
    // Presentation attributes (fill, filter, mask, …) and `style` are
    // parsed as CSS, so url() in them loads like an href would.
    if (data.attrValue && hasExternalCssReference(data.attrValue)) {
      data.keepAttr = false
      removedAttributes.add(`${ownerTag}.${data.attrName}`)
      return
    }
    if (!data.allowedAttributes[data.attrName]) {
      removedAttributes.add(`${ownerTag}.${data.attrName}`)
    }
  })

  let cleaned: string
  try {
    cleaned = DOMPurify.sanitize(text, {
      USE_PROFILES: { svg: true },
      // Strip these even within the SVG profile — they're allowed by
      // default but are XSS / privacy surfaces.
      FORBID_TAGS: ['foreignObject', 'script', 'a'],
      FORBID_ATTR: [
        // Event handlers — DOMPurify strips these by default in safe
        // mode but we explicit-list them so config drift doesn't reopen.
        'onload',
        'onclick',
        'onmouseover',
        'onmouseout',
        'onfocus',
        'onblur',
        'onbegin',
        'onend',
        'onrepeat',
        // URI-bearing attributes are filtered via the hook above.
      ],
      KEEP_CONTENT: false,
    })
  } catch (err) {
    DOMPurify.removeAllHooks()
    throw new SvgSanitizeError('malformed-xml', `Could not parse SVG: ${(err as Error).message}`)
  }
  DOMPurify.removeAllHooks()

  if (cleaned.trim().length === 0) {
    throw new SvgSanitizeError('empty', 'Sanitization produced empty output — input had no allowed content')
  }

  // Soft warning: large embedded base64 (didn't trip the hard reject).
  const softLarge = findLargestBase64(cleaned)
  if (softLarge !== null && softLarge >= BASE64_WARN_BYTES) {
    warnings.push({ code: 'large-base64', sizeBytes: softLarge, threshold: BASE64_WARN_BYTES })
  }

  for (const tag of removedElements) {
    warnings.push({ code: 'stripped-element', tag })
  }
  for (const attr of removedAttributes) {
    const [on, attrName] = attr.split('.')
    warnings.push({ code: 'stripped-attribute', attr: attrName ?? attr, on: on ?? '?' })
  }

  return {
    bytes: new TextEncoder().encode(cleaned),
    warnings,
  }
}

const CSS_URL = /url\(\s*(['"]?)\s*([^'")]*)\1\s*\)/gi
const LOCAL_CSS_URL = /^(?:#|data:image\/(?:png|jpeg|gif|webp);base64,)/i

/**
 * True when CSS text could load something from the network: a url()
 * that isn't `#id` or inline image data, `@import`, or `image-set()`
 * (which takes bare strings). Any backslash counts too, since a CSS
 * escape (`\75 rl(`) can spell url( past the pattern above.
 */
function hasExternalCssReference(css: string): boolean {
  if (css.includes('\\') || /@import|image-set\s*\(/i.test(css)) return true
  for (const m of css.matchAll(CSS_URL)) {
    if (!LOCAL_CSS_URL.test(m[2]!.trim())) return true
  }
  return false
}

/** Canonical IANA MIME for SVG. Re-exported so the preprocessor can match against it. */
export const SVG_MIME_TYPE = SVG_MIME

/**
 * Find the largest embedded base64 data URI in the text. Returns the
 * decoded byte size, or null when no data URIs are present.
 *
 * Approximation — base64 encodes 3 bytes per 4 chars (≈ 0.75 ratio).
 * Counting raw characters and multiplying gives byte estimates that
 * are off by ≤2 bytes (padding). Good enough for a size threshold.
 */
function findLargestBase64(text: string): number | null {
  // Anchor on `;base64,` then match the run of base64 chars + padding.
  const re = /;base64,([A-Za-z0-9+/=]+)/g
  let largest = 0
  let m: RegExpExecArray | null
  while ((m = re.exec(text)) !== null) {
    const charLen = m[1]!.length
    const bytes = Math.floor((charLen * 3) / 4)
    if (bytes > largest) largest = bytes
  }
  return largest > 0 ? largest : null
}

function findOversizedBase64(text: string): number | null {
  const largest = findLargestBase64(text)
  return largest !== null && largest > BASE64_REJECT_BYTES ? largest : null
}
