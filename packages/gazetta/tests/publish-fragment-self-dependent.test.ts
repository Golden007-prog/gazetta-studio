import { describe, expect, it } from 'vitest'
import { findFragmentDependents } from '../src/publish.js'
import { createContentRoot } from '../src/content-root.js'
import { memoryStorage } from './_helpers/memory-storage.js'

const manifest = (components: unknown[]) => JSON.stringify({ template: 'default', components })

describe('findFragmentDependents — cyclic fragment refs (#922)', () => {
  it('does not list the queried fragment as its own dependent', async () => {
    const storage = memoryStorage()
    storage.seed({
      'fragments/a/fragment.json': manifest(['@b']),
      'fragments/b/fragment.json': manifest(['@a']),
    })

    const result = await findFragmentDependents(createContentRoot(storage), 'a')

    expect(result).toEqual({ pages: [], fragments: ['b'] })
  })
})
