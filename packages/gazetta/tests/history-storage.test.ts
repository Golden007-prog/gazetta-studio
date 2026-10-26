/**
 * Storage invariants for createHistoryProvider: how the provider treats
 * the entries it finds in storage - a directory inside revisions/
 * and a blob that is already stored. Uses an in-memory StorageProvider so we exercise the real
 * layout logic without touching disk.
 */
import { describe, it, expect, beforeEach } from 'vitest'
import { createHistoryProvider } from '../src/history-provider.js'
import type { RevisionInput } from '../src/history.js'
import { type MemoryStorage, memoryStorage } from './_helpers/memory-storage.js'

function input(items: Record<string, string>, overrides: Partial<RevisionInput> = {}): RevisionInput {
  return {
    operation: 'save',
    items: new Map(Object.entries(items)),
    ...overrides,
  }
}

const HISTORY_ROOT = '.gazetta/history'

function manifestJson(id: string): string {
  return JSON.stringify({
    id,
    timestamp: '2023-11-14T22:13:20.000Z',
    operation: 'save',
    items: [],
    snapshot: {},
  })
}

describe('createHistoryProvider storage invariants', () => {
  let storage: ReturnType<typeof memoryStorage>
  beforeEach(() => {
    storage = memoryStorage()
  })

  it('ignores a directory inside revisions/ even when its name ends in .json', async () => {
    // Only plain files are revisions; a directory that happens to carry
    // a .json name is not a manifest and must not be read as one.
    storage.seed({
      [`${HISTORY_ROOT}/revisions/archived.json/inner.txt`]: 'kept',
    })
    const h = createHistoryProvider({ storage })

    expect(await h.listRevisions()).toEqual([])
    expect((await h.recordRevision(input({ a: '1' }))).id).toMatch(/^rev-/)
    expect(await h.listRevisions()).toHaveLength(1)
  })

  it('does not rewrite a blob whose content is already stored', async () => {
    // Content addressing makes a stored blob immutable for its hash:
    // recording the same content again reuses the existing object
    // instead of writing it a second time.
    const inner = memoryStorage()
    let blobWrites = 0
    const counting: MemoryStorage = {
      ...inner,
      writeBytes: async (path: string, content: Uint8Array) => {
        if (path.includes('/objects/')) blobWrites += 1
        return inner.writeBytes(path, content)
      },
      dump: () => inner.dump(),
      seed: entries => inner.seed(entries),
    }
    const h = createHistoryProvider({ storage: counting })

    await h.recordRevision(input({ a: 'same content' }))
    await h.recordRevision(input({ a: 'same content' }))

    expect(blobWrites).toBe(1)
    expect(await h.listRevisions()).toHaveLength(2)
  })
})
