import { describe, expect, it } from 'vitest'
import { isSafeItemName } from '../src/item-name.js'

describe('isSafeItemName', () => {
  it.each(['home', 'blog/post', 'blog/[slug]', 'about-us', 'v1.2', 'a/b/c'])('accepts %s', name => {
    expect(isSafeItemName(name)).toBe(true)
  })

  it.each(['', '/home', '..', '../x', 'a/../b', 'a/..', './x', 'a/.', 'a//b', 'a/', 'a\\b', '..\\x'])(
    'rejects %j',
    name => {
      expect(isSafeItemName(name)).toBe(false)
    },
  )
})
