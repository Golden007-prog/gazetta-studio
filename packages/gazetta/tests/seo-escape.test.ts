/**
 * Unit tests for `escapeAttr` — the XSS-prevention helper used across
 * `resolveSeoTags` to escape title / canonical / og:image / hreflang / lang
 * attribute values in generated `<head>` markup.
 *
 * Contract under test (from the docstring + the function's role in seo.ts):
 *   - Escapes `<` → `&lt;`, `&` → `&amp;`, `"` → `&quot;` — the three chars
 *     that break out of a double-quoted HTML attribute value.
 *   - Does NOT escape `>` or `'` — out of scope for double-quoted attrs.
 *   - Is NOT entity-aware — `&amp;` becomes `&amp;amp;` (every `&` is
 *     re-escaped regardless of context). The function operates on raw text;
 *     it does not detect already-encoded sequences.
 *   - Identity on empty / ASCII / unicode strings.
 *
 * Each test names its counterfactual — the mutation of the SUT that would
 * make the test fail — per the coverage-shape recipe's anti-tautology
 * discipline.
 */
import { describe, expect, it } from 'vitest'
import { escapeAttr, resolveSeoTags, type SeoContext } from '../src/seo.js'

describe('resolveSeoTags with a non-string siteUrl (#1110 review)', () => {
  it('a null siteUrl omits the canonical URL instead of throwing mid-render', async () => {
    // siteUrl crosses a loosely-validated boundary (target config is a
    // z.unknown passthrough; resolveSeoTags is also a public export), so
    // null is reachable at runtime even though the TS type forbids it.
    // The pre-helper `?.` chain tolerated it; the typeof guard keeps that.
    const seo = { siteUrl: null } as unknown as SeoContext
    let head: string | undefined
    expect(() => {
      head = resolveSeoTags({ seo, route: '/about' })
    }).not.toThrow()
    expect(head).not.toContain('rel="canonical"')
  })
})

describe('escapeAttr', () => {
  it('escapes < to &lt; (prevents tag-breakout in attribute value)', () => {
    // Counterfactual: removing `.replace(/</g, '&lt;')` from the helper makes
    // this return '<script>'. Changing the entity (e.g., to `&LT;`) also fails.
    expect(escapeAttr('<script>')).toBe('&lt;script>')
  })

  it('escapes & to &amp; (prevents entity injection)', () => {
    // Counterfactual: removing `.replace(/&/g, '&amp;')` returns 'a&b'.
    expect(escapeAttr('a&b')).toBe('a&amp;b')
  })

  it('escapes " to &quot; (prevents attribute-value breakout)', () => {
    // Counterfactual: removing `.replace(/"/g, '&quot;')` returns 'say "hi"'.
    // Swapping the entity to numeric form (`&#34;`) also fails.
    expect(escapeAttr('say "hi"')).toBe('say &quot;hi&quot;')
  })

  it('does NOT escape > (out of scope for double-quoted attribute escaping)', () => {
    // Counterfactual: a future "paranoid" maintainer adds
    // `.replace(/>/g, '&gt;')`. This test fails — locking the documented
    // narrow scope. (`>` is only a syntax char at end-of-tag, not inside a
    // quoted attribute value.)
    expect(escapeAttr('a>b')).toBe('a>b')
  })

  it("does NOT escape ' (callers wrap attributes in double quotes)", () => {
    // Counterfactual: someone adds `.replace(/'/g, '&apos;')` or `&#39;`.
    // This locks "double-quoted attributes" as the assumed call site —
    // the seo.ts callers emit `<meta content="..."` not `content='...'`.
    expect(escapeAttr("it's fine")).toBe("it's fine")
  })

  it('returns empty string unchanged', () => {
    // Counterfactual: helper throws on falsy input, or substitutes a default.
    expect(escapeAttr('')).toBe('')
  })

  it('passes ASCII text without special chars through unchanged', () => {
    // Counterfactual: helper applies overly-aggressive escaping (e.g., HTML
    // entity for every char) or normalizes whitespace.
    expect(escapeAttr('hello world 123')).toBe('hello world 123')
  })

  it('passes unicode through unchanged (no percent-encoding, no numeric entities)', () => {
    // Counterfactual: helper attempts to make output "URL-safe" by
    // percent-encoding non-ASCII, or substitutes numeric entities like
    // `&#xE9;` for `é`. Both would break the human-readable attribute UX
    // that hreflang / og:title rely on.
    expect(escapeAttr('héllo 日本 😀')).toBe('héllo 日本 😀')
  })

  it('escapes all three chars in composition with the correct replacement order', () => {
    // LOAD-BEARING. The implementation must replace `&` FIRST, then `"` and
    // `<` — otherwise the `&` introduced by escaping `<` to `&lt;` would
    // itself be re-escaped to `&amp;lt;`.
    //
    // Counterfactual: reorder the three `.replace()` calls so that `<` is
    // replaced before `&`. Input `<&"` would then produce
    // `&amp;lt;&amp;&quot;` instead of `&lt;&amp;&quot;`. This test pins the
    // ordering invariant that callers depend on.
    expect(escapeAttr('<&"')).toBe('&lt;&amp;&quot;')
  })

  it('double-encodes already-encoded entities (NOT entity-aware)', () => {
    // The helper is intentionally "dumb" — it operates on raw text, not on
    // pre-encoded HTML. Input `&amp;` becomes `&amp;amp;` because every `&`
    // is escaped, regardless of what follows.
    //
    // Counterfactual: a future refactor makes the helper "smart" with a
    // negative lookahead like `/&(?!amp;|lt;|quot;)/`. That would return
    // `&amp;` unchanged here. This test locks the documented behavior:
    // callers must feed RAW text, never pre-encoded HTML. Removing this
    // contract would silently double the encoded output of any caller that
    // re-escapes by mistake — a subtle bug, not an XSS regression. The test
    // makes the choice explicit.
    expect(escapeAttr('&amp;')).toBe('&amp;amp;')
  })
})
