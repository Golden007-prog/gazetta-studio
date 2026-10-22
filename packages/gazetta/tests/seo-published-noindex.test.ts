import { describe, expect, it } from 'vitest'
import { publishedPageNoindex } from '../src/seo.js'

describe('publishedPageNoindex', () => {
  it.each([
    { metadata: undefined, archived: false, expected: false },
    { metadata: { robots: 'index, follow' }, archived: false, expected: false },
    { metadata: { robots: 'nofollow' }, archived: false, expected: false },
    { metadata: { robots: 'noindex, nofollow' }, archived: false, expected: true },
    { metadata: { robots: 'index' }, archived: true, expected: true },
    { metadata: undefined, archived: true, expected: true },
  ])('returns $expected for metadata=$metadata and archived=$archived', ({ metadata, archived, expected }) => {
    expect(publishedPageNoindex(metadata, archived)).toBe(expected)
  })
})
