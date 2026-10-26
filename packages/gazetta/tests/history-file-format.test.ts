/**
 * On-disk format tests for createHistoryProvider: the JSON files it
 * writes (revision manifests and the index cache) are meant to be
 * read and diffed by people, so each one ends with a trailing
 * newline. Uses an in-memory StorageProvider so we exercise the real
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

describe('createHistoryProvider file format', () => {
  let storage: MemoryStorage
  beforeEach(() => {
    storage = memoryStorage()
  })

  it('writes revision manifests with a trailing newline', async () => {
    // A manifest is inspected and diffed by people; the trailing
    // newline keeps every tool's view of the file clean.
    const h = createHistoryProvider({ storage })
    const rev = await h.recordRevision(input({ a: '1' }))

    const raw = storage.dump().get(`.gazetta/history/revisions/${rev.id}.json`)
    expect(raw).toBeDefined()
    expect(new TextDecoder().decode(raw).endsWith('\n')).toBe(true)
  })

  it('writes the index cache with a trailing newline', async () => {
    // Same rule for the derived cache: disposable, but still a file
    // people open when debugging history state.
    const h = createHistoryProvider({ storage })
    await h.recordRevision(input({ a: '1' }))

    const raw = storage.dump().get('.gazetta/history/index.json')
    expect(raw).toBeDefined()
    expect(new TextDecoder().decode(raw).endsWith('\n')).toBe(true)
  })
})
