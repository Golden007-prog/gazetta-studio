/**
 * isInside (#1318): the dev watcher's content-root check must also work
 * on Windows, so every case runs against path.win32 and path.posix from
 * whichever host CI uses.
 */
import { describe, expect, it } from 'vitest'
import { posix, win32 } from 'node:path'
import { isInside } from '../src/cli/is-inside.js'

describe('isInside', () => {
  it('compares win32 paths case-insensitively, drive letters included', () => {
    expect(isInside('C:\\site\\targets\\local', 'c:\\site\\targets\\local\\pages\\home\\page.json', win32)).toBe(true)
  })

  it('treats a lookalike sibling as outside', () => {
    expect(isInside('C:\\site\\targets\\local', 'C:\\site\\targets\\local-old\\x.json', win32)).toBe(false)
    expect(isInside('/site/targets/local', '/site/targets/local-old/x.json', posix)).toBe(false)
  })

  it('treats a file on another drive as outside', () => {
    expect(isInside('C:\\site\\targets\\local', 'D:\\site\\targets\\local\\x.json', win32)).toBe(false)
  })

  it('contains the root itself', () => {
    expect(isInside('C:\\site\\targets\\local', 'c:\\site\\targets\\local', win32)).toBe(true)
    expect(isInside('/site/targets/local', '/site/targets/local', posix)).toBe(true)
  })

  it('contains posix children and excludes posix parents', () => {
    expect(isInside('/site/targets/local', '/site/targets/local/pages/home/page.json', posix)).toBe(true)
    expect(isInside('/site/targets/local', '/site/targets', posix)).toBe(false)
  })
})
