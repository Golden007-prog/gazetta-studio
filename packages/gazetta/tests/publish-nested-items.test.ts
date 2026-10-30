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

describe('nested-item classification uses the copied directory listing', () => {
  it.each(['page', 'fragment'])('excludes a %s created just before the recursive listing', async manifest => {
    const source = memoryStorage()
    const target = memoryStorage()
    const parent = 'pages/about/page.json'
    const child = 'pages/about/media'
    source.seed({ [parent]: JSON.stringify({ template: 'parent' }), [`${child}/notes.txt`]: 'ordinary before save' })
    const readDir = source.readDir.bind(source)
    let saved = false
    source.readDir = async path => {
      if (path === child) {
        source.seed({ [`${child}/${manifest}.json`]: JSON.stringify({ template: 'new-item' }) })
        saved = true
      }
      return readDir(path)
    }

    expect(await publishItems(createContentRoot(source), createContentRoot(target), ['pages/about'])).toEqual({
      copiedFiles: 1,
    })
    expect(saved).toBe(true)
    expect([...target.dump().keys()]).toEqual([parent])
  })

  it.each(['page', 'fragment'])('does not copy a %s created after the recursive listing', async manifest => {
    const source = memoryStorage()
    const target = memoryStorage()
    const parent = 'pages/about/page.json'
    const child = 'pages/about/media'
    source.seed({ [parent]: JSON.stringify({ template: 'parent' }), [`${child}/notes.txt`]: 'already listed' })
    const readDir = source.readDir.bind(source)
    let saved = false
    source.readDir = async path => {
      const entries = await readDir(path)
      if (path === child) {
        source.seed({
          [`${child}/${manifest}.json`]: JSON.stringify({ template: 'new-item' }),
          [`${child}/new.txt`]: 'created with the new item',
        })
        saved = true
      }
      return entries
    }

    expect(await publishItems(createContentRoot(source), createContentRoot(target), ['pages/about'])).toEqual({
      copiedFiles: 2,
    })
    expect(saved).toBe(true)
    expect([...target.dump().keys()].sort()).toEqual([parent, `${child}/notes.txt`].sort())
  })

  it('lists each directory once without probing manifest paths on ordinary subdirectories', async () => {
    const source = memoryStorage()
    const target = memoryStorage()
    source.seed({
      'pages/about/page.json': JSON.stringify({ template: 'parent' }),
      'pages/about/media/notes.txt': 'ordinary subfolder',
      'pages/about/media/deep/notes.txt': 'ordinary deep subfolder',
    })
    const exists = source.exists.bind(source)
    const readDir = source.readDir.bind(source)
    const existsPaths: string[] = []
    const listedPaths: string[] = []
    source.exists = async path => {
      existsPaths.push(path)
      return exists(path)
    }
    source.readDir = async path => {
      listedPaths.push(path)
      return readDir(path)
    }

    expect(await publishItems(createContentRoot(source), createContentRoot(target), ['pages/about'])).toEqual({
      copiedFiles: 3,
    })
    const directories = ['pages/about', 'pages/about/media', 'pages/about/media/deep']
    expect(existsPaths.sort()).toEqual(directories)
    expect(listedPaths.sort()).toEqual(directories)
    expect(await target.readFile('pages/about/media/deep/notes.txt')).toBe('ordinary deep subfolder')
  })

  it.each(['page', 'fragment'])(
    'copies an ordinary directory named %s.json rather than treating it as a manifest',
    async manifest => {
      const source = memoryStorage()
      const target = memoryStorage()
      const parent = 'pages/about/page.json'
      const ownFile = `pages/about/media/${manifest}.json/notes.txt`
      source.seed({ [parent]: JSON.stringify({ template: 'parent' }), [ownFile]: 'directory content' })

      expect(await publishItems(createContentRoot(source), createContentRoot(target), ['pages/about'])).toEqual({
        copiedFiles: 2,
      })
      expect(await target.readFile(ownFile)).toBe('directory content')
    },
  )
})
