import { describe, it, expect } from 'vitest'
import { join } from 'node:path'
import { viteCacheDir } from '../src/cli/vite-cache-dir.js'

describe('viteCacheDir (#1028)', () => {
  const project = join('/', 'work', 'project')

  it('gives two different site directories two different cache directories', () => {
    const a = viteCacheDir('/work/.tmp/e2e-0/project/sites/main', project)
    const b = viteCacheDir('/work/.tmp/e2e-1/project/sites/main', project)
    expect(a).not.toBe(b)
  })

  it('gives the same site directory the same cache directory', () => {
    expect(viteCacheDir('/work/sites/main', project)).toBe(viteCacheDir('/work/sites/main', project))
  })

  it('treats equivalent spellings of one path as the same site', () => {
    expect(viteCacheDir('/work/sites/main/', project)).toBe(viteCacheDir('/work/sites/../sites/main', project))
  })

  it("places the cache in the project's node_modules, not the OS temp folder", () => {
    expect(viteCacheDir('/work/sites/main', project).startsWith(join(project, 'node_modules', '.vite'))).toBe(true)
  })
})
