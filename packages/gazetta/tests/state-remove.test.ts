import { mkdir, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { createFilesystemProvider } from '../src/providers/filesystem.js'
import { findSensitiveState, formatFolderList, removeSensitiveState } from '../src/state-remove.js'
import type { StateFolder } from '../src/state-folders.js'
import type { StorageProvider } from '../src/types.js'
import { memoryStorage } from './_helpers/memory-storage.js'
import { tempDir } from './_helpers/temp.js'

const tempRoots: string[] = []
afterEach(async () => {
  await Promise.all(tempRoots.splice(0).map(r => rm(r, { recursive: true, force: true })))
})

const safeAndContent = {
  '.gazetta/publish-generation': 'g1',
  '.gazetta/fragment-deps/header/pages.home': '',
  '.gazetta/asset-refs/hero/pages.home': '',
  'pages/home/page.json': '{}',
  'pages/home/index.html': '<html></html>',
}

describe('findSensitiveState', () => {
  it('returns nothing for empty storage', async () => {
    expect(await findSensitiveState(memoryStorage())).toEqual([])
  })

  it('ignores safe folders, dependency indices and content', async () => {
    const storage = memoryStorage()
    storage.seed(safeAndContent)
    expect(await findSensitiveState(storage)).toEqual([])
  })

  it.each<[Record<string, string>, StateFolder[]]>([
    [{ '.gazetta/review/page/home/state.json': '{}' }, ['review']],
    [{ '.gazetta/audit/2026/e.json': '{}', '.gazetta/history/revisions/r.json': '{}' }, ['history', 'audit']],
    [
      {
        '.gazetta/review/x.json': '{}',
        '.gazetta/audit/a.json': '{}',
        '.gazetta/history/index.json': '[]',
      },
      ['history', 'audit', 'review'],
    ],
  ])('reports the present sensitive folders in registry order (%#)', async (entries, expected) => {
    const storage = memoryStorage()
    storage.seed({ ...safeAndContent, ...entries })
    expect(await findSensitiveState(storage)).toEqual(expected)
  })

  it('treats a missing directory on the filesystem as absent', async () => {
    const root = tempDir(`state-remove-${Math.random().toString(36).slice(2)}`)
    tempRoots.push(root)
    await mkdir(join(root, '.gazetta/audit'), { recursive: true })
    await writeFile(join(root, '.gazetta/audit/a.json'), '{}')
    expect(await findSensitiveState(createFilesystemProvider(root))).toEqual(['audit'])
  })

  it('surfaces a listing error other than not-found', async () => {
    const storage = {
      ...memoryStorage(),
      async readDir() {
        throw new Error('EACCES: permission denied')
      },
      async exists() {
        return true
      },
    } as StorageProvider
    await expect(findSensitiveState(storage)).rejects.toThrow('EACCES')
  })
})

describe('removeSensitiveState', () => {
  it('deletes only the named sensitive folders', async () => {
    const storage = memoryStorage()
    storage.seed({
      ...safeAndContent,
      '.gazetta/history/revisions/r.json': '{}',
      '.gazetta/history/objects/ab/cd': 'x',
      '.gazetta/audit/a.json': '{}',
      '.gazetta/review/x.json': '{}',
    })
    await removeSensitiveState(storage, ['history', 'audit'])
    expect([...storage.dump().keys()].sort()).toEqual([...Object.keys(safeAndContent), '.gazetta/review/x.json'].sort())
  })

  it.each<StateFolder>(['publish-generation', 'fragment-deps'])('refuses to remove %s', async folder => {
    const storage = memoryStorage()
    storage.seed(safeAndContent)
    await expect(removeSensitiveState(storage, [folder])).rejects.toThrow("isn't sensitive state")
    expect(storage.dump().size).toBe(Object.keys(safeAndContent).length)
  })
})

describe('formatFolderList', () => {
  it.each([
    [['history'], 'history'],
    [['history', 'audit'], 'history and audit'],
    [['history', 'audit', 'review'], 'history, audit and review'],
  ])('%j → %s', (folders, expected) => {
    expect(formatFolderList(folders)).toBe(expected)
  })
})
