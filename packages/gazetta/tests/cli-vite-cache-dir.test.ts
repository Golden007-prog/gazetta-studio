import { describe, it, expect } from 'vitest'
import { join } from 'node:path'
import { viteCacheDir } from '../src/cli/vite-cache-dir.js'

describe('viteCacheDir (#1028)', () => {
  const tmp = join('/', 'tmp-root')

  it('gives two different site directories two different cache directories', () => {
    const a = viteCacheDir('/work/.tmp/e2e-0/project/sites/main', tmp)
    const b = viteCacheDir('/work/.tmp/e2e-1/project/sites/main', tmp)
    expect(a).not.toBe(b)
  })

  it('gives the same site directory the same cache directory', () => {
    expect(viteCacheDir('/work/sites/main', tmp)).toBe(viteCacheDir('/work/sites/main', tmp))
  })

  it('treats equivalent spellings of one path as the same site', () => {
    expect(viteCacheDir('/work/sites/main/', tmp)).toBe(viteCacheDir('/work/sites/../sites/main', tmp))
  })

  it('places the cache under the given temp directory', () => {
    expect(viteCacheDir('/work/sites/main', tmp).startsWith(tmp)).toBe(true)
  })
})
