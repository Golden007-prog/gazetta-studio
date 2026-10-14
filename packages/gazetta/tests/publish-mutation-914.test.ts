/**
 * Mutation-coverage backfill for src/publish.ts (issue #914).
 *
 * Prior cycles (#638, #712) covered copyRecursive and the top-level
 * manifest guards of resolveDependencies. This file targets the two
 * surfaces no unit test reached:
 *   1. findFragmentDependents — the legacy manifest-walk reverse lookup
 *      used by the publish route's static-target expansion.
 *   2. collectComponentDeps' inline-component branch: template guard and
 *      recursion into nested `components`.
 *
 * Equivalent mutants not targeted here (no observable difference):
 *   - copyRecursive `entry.isDirectory` → true: a file entry recurses into
 *     copyRecursive, whose file branch copies it and returns 1.
 *   - dirname split/join separators: memoryStorage.mkdir is a no-op.
 *   - `continue` in the manifest-name loop → `{}`: it is the last statement.
 *   - collectComponentDeps string/object guard → true: a non-@ string
 *     falls into the object branch, where `.template` and `.components`
 *     are both undefined on a string primitive.
 */
import { describe, expect, it } from 'vitest'
import { findFragmentDependents, resolveDependencies } from '../src/publish.js'
import { createContentRoot } from '../src/content-root.js'
import { memoryStorage } from './_helpers/memory-storage.js'

const manifest = (components: unknown[]) => JSON.stringify({ template: 'default', components })

describe('findFragmentDependents', () => {
  it('splits direct referrers into pages and fragments, sorted, excluding non-referrers', async () => {
    const storage = memoryStorage()
    storage.seed({
      'pages/zeta/page.json': manifest(['@header']),
      'pages/alpha/page.json': manifest(['@header', '@footer']),
      'pages/unrelated/page.json': manifest(['@footer']),
      'fragments/header/fragment.json': manifest([]),
      'fragments/layout/fragment.json': manifest(['@header']),
    })

    const result = await findFragmentDependents(createContentRoot(storage), 'header')

    expect(result).toEqual({ pages: ['alpha', 'zeta'], fragments: ['layout'] })
  })

  it('follows fragment → fragment references transitively', async () => {
    const storage = memoryStorage()
    storage.seed({
      'fragments/inner/fragment.json': manifest([]),
      'fragments/outer/fragment.json': manifest(['@inner']),
      'pages/home/page.json': manifest(['@outer']),
      'pages/about/page.json': manifest(['@inner']),
      'pages/blog/page.json': manifest([]),
    })

    const result = await findFragmentDependents(createContentRoot(storage), 'inner')

    expect(result).toEqual({ pages: ['about', 'home'], fragments: ['outer'] })
  })

  it('finds references nested inside inline composite components', async () => {
    const storage = memoryStorage()
    storage.seed({
      'pages/home/page.json': manifest([
        { template: 'section', components: [{ template: 'col', components: ['@cta'] }] },
      ]),
      'fragments/cta/fragment.json': manifest([]),
    })

    const result = await findFragmentDependents(createContentRoot(storage), 'cta')

    expect(result).toEqual({ pages: ['home'], fragments: [] })
  })

  it('ignores plain-string and null components that are not @-references', async () => {
    const storage = memoryStorage()
    storage.seed({
      // 'xcta'.slice(1) === 'cta': a check that drops the '@' requirement
      // would turn this plain string into a reference to the queried fragment.
      'pages/plain/page.json': manifest(['xcta', null]),
      'fragments/cta/fragment.json': manifest([]),
    })

    const result = await findFragmentDependents(createContentRoot(storage), 'cta')

    expect(result).toEqual({ pages: [], fragments: [] })
  })

  it('reads page.json for pages and fragment.json for fragments only', async () => {
    const storage = memoryStorage()
    storage.seed({
      // Swapped manifest names: neither should be read as a referrer.
      'pages/wrong/fragment.json': manifest(['@header']),
      'fragments/wrong/page.json': manifest(['@header']),
      'pages/right/page.json': manifest(['@header']),
      'fragments/right/fragment.json': manifest(['@header']),
    })

    const result = await findFragmentDependents(createContentRoot(storage), 'header')

    expect(result).toEqual({ pages: ['right'], fragments: ['right'] })
  })

  it('skips an unparseable manifest without failing the whole lookup', async () => {
    const storage = memoryStorage()
    storage.seed({
      'pages/broken/page.json': '{ not json',
      'pages/ok/page.json': manifest(['@header']),
    })

    const result = await findFragmentDependents(createContentRoot(storage), 'header')

    expect(result).toEqual({ pages: ['ok'], fragments: [] })
  })

  it('returns empty sets when the site has no pages or fragments', async () => {
    const result = await findFragmentDependents(createContentRoot(memoryStorage()), 'header')

    expect(result).toEqual({ pages: [], fragments: [] })
  })
})

describe('resolveDependencies — inline composite components', () => {
  it('collects templates and fragments from nested inline components', async () => {
    const storage = memoryStorage()
    storage.seed({
      'pages/home/page.json': manifest([
        { template: 'section', components: [{ template: 'col', components: ['@cta'] }] },
      ]),
      'fragments/cta/fragment.json': JSON.stringify({ template: 'button' }),
    })

    const deps = await resolveDependencies(createContentRoot(storage), ['pages/home'])

    expect(deps.sort()).toEqual([
      'fragments/cta',
      'pages/home',
      'templates/button',
      'templates/col',
      'templates/default',
      'templates/section',
    ])
  })

  it('does not fabricate templates/undefined for an inline component without a template', async () => {
    const storage = memoryStorage()
    storage.seed({
      'pages/home/page.json': manifest([{ components: [{ template: 'hero' }] }]),
    })

    const deps = await resolveDependencies(createContentRoot(storage), ['pages/home'])

    expect(deps.sort()).toEqual(['pages/home', 'templates/default', 'templates/hero'])
  })
})
