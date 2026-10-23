import { describe, it, expect } from 'vitest'
import { deriveRoute, fillRouteParams } from '../src/runtime/derive-route.js'

describe('fillRouteParams param names (#1126)', () => {
  it('fills a hyphenated param name — `posts/[post-slug]` does not 410', () => {
    expect(fillRouteParams('/posts/:post-slug', { 'post-slug': 'hello' })).toBe('/posts/hello')
  })

  it('fills several captured values in one route, hyphenated included', () => {
    expect(fillRouteParams('/posts/:year/:post-slug', { year: '2024', 'post-slug': 'hi' })).toBe('/posts/2024/hi')
  })

  it('a segment named like an Object prototype member without a captured value is missing', () => {
    expect(fillRouteParams('/x/:constructor', {})).toBeNull()
    expect(fillRouteParams('/x/:toString', {})).toBeNull()
  })

  it('a prototype-named segment with a genuinely captured value fills', () => {
    expect(fillRouteParams('/x/:constructor', { constructor: 'real' })).toBe('/x/real')
  })

  it('routes without parameters are unchanged; a parameter with no captured value answers null', () => {
    expect(fillRouteParams('/posts/hello')).toBe('/posts/hello')
    expect(fillRouteParams('/blog/:slug')).toBeNull()
    expect(fillRouteParams('/blog/:slug', {})).toBeNull()
  })
})
