import postcss from 'postcss'
import prefixer from 'postcss-prefix-selector'

/**
 * Hash a tree path to an 8-char hex string (FNV-1a).
 * Deterministic — same path always produces the same hash.
 * Works identically in Node and browser.
 */
export function hashPath(path: string): string {
  let hash = 0x811c9dc5
  for (let i = 0; i < path.length; i++) {
    hash ^= path.charCodeAt(i)
    hash = (hash * 0x01000193) >>> 0
  }
  return hash.toString(16).padStart(8, '0')
}

/**
 * Wraps HTML in a scoped container with a data-gz attribute.
 */
export function scopeHtml(html: string, scopeId: string): string {
  if (!html.trim()) return ''
  return `<div data-gz="${scopeId}">${html}</div>`
}

/**
 * Prefixes CSS selectors with a scope attribute selector using PostCSS.
 */
export function scopeCss(css: string, scopeId: string): string {
  if (!css.trim()) return ''

  const prefix = `[data-gz="${scopeId}"]`
  const result = postcss([
    prefixer({ prefix, transform: (_prefix: string, selector: string) => `${prefix} ${selector}` }),
  ]).process(css).css

  return result
}
