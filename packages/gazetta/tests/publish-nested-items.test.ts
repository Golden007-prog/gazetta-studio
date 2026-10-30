import { describe, expect, it } from 'vitest'
import { createContentRoot } from '../src/content-root.js'
import { publishItems } from '../src/publish.js'
import { memoryStorage } from './_helpers/memory-storage.js'

describe.each([
  { dir: 'pages', manifest: 'page' },
  { dir: 'fragments', manifest: 'fragment' },
])('publishing a selected $dir item (#1538)', ({ dir, manifest }) => {
  it.each(['page', 'fragment'])('does not copy descendants with their own %s manifest', async nestedManifest => {
    const source = memoryStorage()
    const target = memoryStorage()
    const item = `${dir}/about`
    const ownFiles = {
      [`${item}/${manifest}.json`]: JSON.stringify({ template: 'parent' }),
      [`${item}/${manifest}.fr.json`]: JSON.stringify({ template: 'parent-fr' }),
      [`${item}/readme.txt`]: 'selected item notes',
      [`${item}/media/license.txt`]: 'ordinary subfolder content',
      [`${item}/media/deep/ordinary.txt`]: 'ordinary nested content',
    }
    const nestedFiles = {
      [`${item}/team/${nestedManifest}.json`]: JSON.stringify({ template: 'nested' }),
      [`${item}/team/private.txt`]: 'not selected',
      [`${item}/media/deep/child/${nestedManifest}.json`]: JSON.stringify({ template: 'deep-child' }),
    }
    source.seed(
      Object.fromEntries(
        Object.entries({ ...ownFiles, ...nestedFiles }).map(([key, value]) => [`source/${key}`, value]),
      ),
    )

    const { copiedFiles } = await publishItems(
      createContentRoot(source, 'source'),
      createContentRoot(target, 'destination'),
      [item],
    )

    expect(copiedFiles).toBe(Object.keys(ownFiles).length)
    expect([...target.dump().keys()].sort()).toEqual(
      Object.keys(ownFiles)
        .map(key => `destination/${key}`)
        .sort(),
    )
    for (const [key, value] of Object.entries(ownFiles)) expect(await target.readFile(`destination/${key}`)).toBe(value)
    for (const key of Object.keys(nestedFiles)) expect(await target.exists(`destination/${key}`)).toBe(false)
  })

  it('still copies a nested item when that item itself is selected', async () => {
    const source = memoryStorage()
    const target = memoryStorage()
    const nested = `${dir}/about/team`
    const content = JSON.stringify({ template: 'selected-child' })
    source.seed({ [`${nested}/${manifest}.json`]: content })

    expect(await publishItems(createContentRoot(source), createContentRoot(target), [nested])).toEqual({
      copiedFiles: 1,
    })
    expect(await target.readFile(`${nested}/${manifest}.json`)).toBe(content)
  })

  it('copies a separately selected child once when its parent is selected too', async () => {
    const source = memoryStorage()
    const target = memoryStorage()
    const parent = `${dir}/about`
    const child = `${parent}/team`
    source.seed({
      [`${parent}/${manifest}.json`]: JSON.stringify({ template: 'parent' }),
      [`${child}/${manifest}.json`]: JSON.stringify({ template: 'child' }),
    })

    expect(await publishItems(createContentRoot(source), createContentRoot(target), [parent, child])).toEqual({
      copiedFiles: 2,
    })
    expect([...target.dump().keys()].sort()).toEqual([`${parent}/${manifest}.json`, `${child}/${manifest}.json`].sort())
  })
})

it('preserves recursive copying for a template directory with a page.json example', async () => {
  const source = memoryStorage()
  const target = memoryStorage()
  source.seed({
    'templates/example/index.ts': 'export const template = {}',
    'templates/example/examples/page.json': JSON.stringify({ template: 'example' }),
  })

  expect(await publishItems(createContentRoot(source), createContentRoot(target), ['templates/example'])).toEqual({
    copiedFiles: 2,
  })
  expect(await target.readFile('templates/example/examples/page.json')).toBe(JSON.stringify({ template: 'example' }))
})

it('can explicitly include nested items for fetching an entire content subtree', async () => {
  const source = memoryStorage()
  const target = memoryStorage()
  const files = {
    'pages/about/page.json': JSON.stringify({ template: 'parent' }),
    'pages/about/team/page.json': JSON.stringify({ template: 'child' }),
    'pages/about/team/page.fr.json': JSON.stringify({ template: 'child-fr' }),
  }
  source.seed(files)

  expect(
    await publishItems(createContentRoot(source), createContentRoot(target), ['pages/about'], {
      includeNestedItems: true,
    }),
  ).toEqual({ copiedFiles: 3 })
  for (const [key, value] of Object.entries(files)) expect(await target.readFile(key)).toBe(value)
})
