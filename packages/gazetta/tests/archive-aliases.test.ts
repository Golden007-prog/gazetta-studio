/**
 * archive-aliases sidecar tests — pin the per-edge index used by
 * the purge-blocked check (Cut 5+) per design-soft-delete.md Q4.
 *
 * Pattern matches `tests/sidecars.test.ts` for asset-refs and
 * fragment-deps: in-memory storage; assert the right files exist
 * after the diff; readDepsFor returns the expected items.
 *
 * The 5K-page envelope rule (team-preferences rule 24) is satisfied
 * by composition: this module is a thin binding over `dep-sidecars.ts`,
 * and `tests/perf-refs.bench.ts` already empirically validated the
 * generic per-edge sidecar pattern at 1000 items / multiple backends
 * (~5ms readDir on filesystem, sub-second on cloud). The full-flow
 * 5K-envelope check lives in Cut 5c's purge-route integration test.
 */
import { describe, it, expect } from 'vitest'
import { ARCHIVE_ALIASES, applyArchiveAliasesDiff, rebuildArchiveAliases } from '../src/archive-aliases.js'
import { createContentRoot } from '../src/content-root.js'
import type { ItemRef } from '../src/dep-sidecars.js'
import { memoryStorage } from './_helpers/memory-storage.js'

const liveManifest = { template: 'echo' }
const archiveAlias = (aliasOf: string) => ({ template: 'echo', archived: true, aliasOf })
const archiveGone = { template: 'echo', archived: true }

describe('ARCHIVE_ALIASES.extract', () => {
  it('returns empty set for live manifests', () => {
    expect(ARCHIVE_ALIASES.extract(liveManifest)).toEqual(new Set())
  })

  it('returns empty set for archived-without-alias (pure soft-delete)', () => {
    expect(ARCHIVE_ALIASES.extract(archiveGone)).toEqual(new Set())
  })

  it('returns the single target name for archived-with-alias', () => {
    expect(ARCHIVE_ALIASES.extract(archiveAlias('welcome'))).toEqual(new Set(['welcome']))
  })

  it('treats archived: false as live', () => {
    expect(ARCHIVE_ALIASES.extract({ template: 'echo', archived: false, aliasOf: 'ignored' })).toEqual(new Set())
  })

  it('treats empty-string aliasOf as no alias', () => {
    expect(ARCHIVE_ALIASES.extract({ template: 'echo', archived: true, aliasOf: '' })).toEqual(new Set())
  })

  it('ignores aliasOf when archived is missing', () => {
    expect(ARCHIVE_ALIASES.extract({ template: 'echo', aliasOf: 'X' })).toEqual(new Set())
  })
})

describe('rebuildArchiveAliases lifecycle', () => {
  function newRoot() {
    const storage = memoryStorage()
    const contentRoot = createContentRoot(storage, '')
    return { storage, contentRoot }
  }

  it('writes a sidecar when going from live → archive(aliasOf=X)', async () => {
    const { contentRoot, storage } = newRoot()
    const item: ItemRef = { source: 'page', name: 'landing' }
    await rebuildArchiveAliases(contentRoot, item, liveManifest, archiveAlias('welcome'))
    expect(await storage.exists('.gazetta/alias-targets/welcome/pages.landing')).toBe(true)
  })

  it('writes no sidecar when going from live → archive(no aliasOf)', async () => {
    const { contentRoot, storage } = newRoot()
    const item: ItemRef = { source: 'page', name: 'old' }
    await rebuildArchiveAliases(contentRoot, item, liveManifest, archiveGone)
    expect(await storage.exists('.gazetta/alias-targets/old/pages.old')).toBe(false)
  })

  it('moves the sidecar when alias target changes (archive(X) → archive(Y))', async () => {
    const { contentRoot, storage } = newRoot()
    const item: ItemRef = { source: 'page', name: 'landing' }
    await rebuildArchiveAliases(contentRoot, item, null, archiveAlias('welcome'))
    expect(await storage.exists('.gazetta/alias-targets/welcome/pages.landing')).toBe(true)

    await rebuildArchiveAliases(contentRoot, item, archiveAlias('welcome'), archiveAlias('home'))
    expect(await storage.exists('.gazetta/alias-targets/welcome/pages.landing')).toBe(false)
    expect(await storage.exists('.gazetta/alias-targets/home/pages.landing')).toBe(true)
  })

  it('removes the sidecar when archive drops aliasOf (archive(X) → archive(no alias))', async () => {
    const { contentRoot, storage } = newRoot()
    const item: ItemRef = { source: 'page', name: 'landing' }
    await rebuildArchiveAliases(contentRoot, item, null, archiveAlias('welcome'))
    expect(await storage.exists('.gazetta/alias-targets/welcome/pages.landing')).toBe(true)

    await rebuildArchiveAliases(contentRoot, item, archiveAlias('welcome'), archiveGone)
    expect(await storage.exists('.gazetta/alias-targets/welcome/pages.landing')).toBe(false)
  })

  it('removes the sidecar when archived item is unarchived (archive(X) → live)', async () => {
    const { contentRoot, storage } = newRoot()
    const item: ItemRef = { source: 'page', name: 'landing' }
    await rebuildArchiveAliases(contentRoot, item, null, archiveAlias('welcome'))
    await rebuildArchiveAliases(contentRoot, item, archiveAlias('welcome'), liveManifest)
    expect(await storage.exists('.gazetta/alias-targets/welcome/pages.landing')).toBe(false)
  })

  it('removes the sidecar when archive is purged (archive(X) → null)', async () => {
    const { contentRoot, storage } = newRoot()
    const item: ItemRef = { source: 'page', name: 'landing' }
    await rebuildArchiveAliases(contentRoot, item, null, archiveAlias('welcome'))
    await rebuildArchiveAliases(contentRoot, item, archiveAlias('welcome'), null)
    expect(await storage.exists('.gazetta/alias-targets/welcome/pages.landing')).toBe(false)
  })

  it('handles fragments with the right filename encoding', async () => {
    const { contentRoot, storage } = newRoot()
    const item: ItemRef = { source: 'fragment', name: 'header' }
    await rebuildArchiveAliases(contentRoot, item, null, archiveAlias('top-bar'))
    expect(await storage.exists('.gazetta/alias-targets/top-bar/fragments.header')).toBe(true)
  })

  it('encodes locale variants in the sidecar filename', async () => {
    const { contentRoot, storage } = newRoot()
    const item: ItemRef = { source: 'page', name: 'landing', locale: 'fr' }
    await rebuildArchiveAliases(contentRoot, item, null, archiveAlias('welcome'))
    expect(await storage.exists('.gazetta/alias-targets/welcome/pages.landing:fr')).toBe(true)
  })
})

describe('applyArchiveAliasesDiff (pre-computed sets)', () => {
  it('writes added + removes dropped target sidecars in one pass', async () => {
    const storage = memoryStorage()
    const contentRoot = createContentRoot(storage, '')
    const item: ItemRef = { source: 'page', name: 'multi' }

    await applyArchiveAliasesDiff(contentRoot, item, new Set([]), new Set(['welcome']))
    expect(await storage.exists('.gazetta/alias-targets/welcome/pages.multi')).toBe(true)

    // Logical: rename target from 'welcome' to 'home'
    await applyArchiveAliasesDiff(contentRoot, item, new Set(['welcome']), new Set(['home']))
    expect(await storage.exists('.gazetta/alias-targets/welcome/pages.multi')).toBe(false)
    expect(await storage.exists('.gazetta/alias-targets/home/pages.multi')).toBe(true)
  })
})
