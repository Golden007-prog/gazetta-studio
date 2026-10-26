import { describe, it, expect } from 'vitest'
import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { REQUIRED_NODE_RANGE } from '../src/node-floor.js'

// The repo's runtime dependency `write-file-atomic@8` declares
// `engines: "^22.22.2 || ^24.15.0 || >=26.0.0"`: Node 22.0-22.22.1, 23.x,
// 24.0-24.14 and 25.x are all unsupported. A user on one of those versions
// would pass a looser engines gate here and fail write-file-atomic's,
// surfacing a confusing EBADENGINE pointing at a transitive dep. Declaring
// the same range in src/node-floor.ts means the error surfaces at our
// package boundary with a clearer signal, and the drift test below keeps
// the two from disagreeing again.

const installedWriteFileAtomic = [
  resolve(import.meta.dirname, '../../../node_modules/write-file-atomic/package.json'),
  resolve(import.meta.dirname, '../node_modules/write-file-atomic/package.json'),
].find(candidate => existsSync(candidate))

describe('repo engines field', () => {
  it('the declared range matches write-file-atomic@8, the dependency that drives it', () => {
    const dep = JSON.parse(readFileSync(installedWriteFileAtomic!, 'utf-8'))
    expect(REQUIRED_NODE_RANGE).toBe(dep.engines.node)
  })

  it('root package.json declares the same node range', () => {
    const rootPkgPath = resolve(import.meta.dirname, '../../../package.json')
    const pkg = JSON.parse(readFileSync(rootPkgPath, 'utf-8'))
    expect(pkg.engines?.node).toBe(REQUIRED_NODE_RANGE)
  })

  it('the published gazetta package declares the same node range', () => {
    const gazettaPkgPath = resolve(import.meta.dirname, '../package.json')
    const pkg = JSON.parse(readFileSync(gazettaPkgPath, 'utf-8'))
    expect(pkg.engines?.node).toBe(REQUIRED_NODE_RANGE)
  })
})
