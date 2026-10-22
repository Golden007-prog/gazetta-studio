import { describe, it, expect } from 'vitest'
import { trimTrailingSlashes } from '../src/url.js'

describe('trimTrailingSlashes (#1067)', () => {
  it.each([
    ['', ''],
    ['/', ''],
    ['https://a.com', 'https://a.com'],
    ['https://a.com///', 'https://a.com'],
    ['https://a.com/path/', 'https://a.com/path'],
  ])('%s -> %s', (input, expected) => {
    expect(trimTrailingSlashes(input)).toBe(expected)
  })

  it('a 100,000-character run of slashes followed by a non-slash returns at once, unchanged', () => {
    // The input that makes /\/+$/ quadratic: a long slash run NOT at the end.
    const input = `${'/'.repeat(100_000)}x`
    const start = performance.now()
    expect(trimTrailingSlashes(input)).toBe(input)
    expect(performance.now() - start).toBeLessThan(100)
  })
})
