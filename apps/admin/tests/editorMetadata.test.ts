/**
 * The page-metadata lane (design-editor-ux.md, "Page metadata is a pending
 * lane"). Before it, the metadata form rebuilt metadata from its own fields
 * on save, dropping keys it didn't show and every robots token but noindex.
 */
import { beforeEach, describe, expect, it } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { reactive } from 'vue'
import { type MetadataKey, useEditorMetadataStore } from '../src/client/stores/editorMetadata.js'

const home: MetadataKey = { kind: 'page', name: 'home' }
const homeFr: MetadataKey = { kind: 'page', name: 'home', locale: 'fr' }

beforeEach(() => setActivePinia(createPinia()))

describe('metadata edits', () => {
  it('keep the loaded metadata and change only their own field', () => {
    const store = useEditorMetadataStore()
    // Reactive, as selection.detail is.
    const loaded = reactive({ title: 'Home', robots: 'nofollow', twitterCard: 'summary', extra: { a: 1 } })
    store.setField(home, loaded, 'description', 'Welcome')
    expect(store.pendingFor(home)).toStrictEqual({
      title: 'Home',
      robots: 'nofollow',
      twitterCard: 'summary',
      extra: { a: 1 },
      description: 'Welcome',
    })
    expect(store.hasPendingEdits).toBe(true)
  })

  it('an emptied field removes its key', () => {
    const store = useEditorMetadataStore()
    store.setField(home, { title: 'Home', description: 'Welcome' }, 'title', '')
    expect(store.pendingFor(home)).toStrictEqual({ description: 'Welcome' })
  })

  it('a field edited back to what was loaded clears the entry, whatever the key order', () => {
    const store = useEditorMetadataStore()
    const loaded = { title: 'Home', description: 'Welcome' }
    store.setField(home, loaded, 'title', '')
    expect(store.hasPendingFor(home)).toBe(true)
    // Typed back in, `title` is now the last key.
    store.setField(home, loaded, 'title', 'Home')
    expect(store.hasPendingFor(home)).toBe(false)
    expect(store.pendingCount).toBe(0)
  })

  it('a page with no metadata starts from an empty object', () => {
    const store = useEditorMetadataStore()
    store.setField(home, undefined, 'title', 'Home')
    expect(store.pendingFor(home)).toStrictEqual({ title: 'Home' })
    store.setField(home, undefined, 'title', '')
    expect(store.hasPendingFor(home)).toBe(false)
  })

  it('keep the first loaded metadata as the baseline', () => {
    const store = useEditorMetadataStore()
    store.setField(home, { title: 'A' }, 'title', 'B')
    store.setField(home, { title: 'Z' }, 'description', 'D')
    expect(store.allEntries()[0][1].original).toStrictEqual({ title: 'A' })
    expect(store.pendingFor(home)).toStrictEqual({ title: 'B', description: 'D' })
  })

  it('belong to one locale', () => {
    const store = useEditorMetadataStore()
    store.setField(home, {}, 'title', 'Home')
    store.setField(homeFr, {}, 'title', 'Accueil')
    expect(store.pendingCount).toBe(2)
    store.discard(homeFr)
    expect(store.pendingFor(homeFr)).toBeNull()
    expect(store.pendingFor(home)).toStrictEqual({ title: 'Home' })
  })
})

describe('the noindex checkbox', () => {
  it.each([
    [undefined, true, 'noindex'],
    ['nofollow', true, 'noindex, nofollow'],
    ['noindex', false, undefined],
    ['noindex, nofollow', false, 'nofollow'],
    ['nofollow,noindex', false, 'nofollow'],
  ] as const)('robots %j, ticked %s: robots becomes %j', (robots, on, expected) => {
    const store = useEditorMetadataStore()
    const loaded = robots === undefined ? { title: 'Home' } : { title: 'Home', robots }
    store.setNoindex(home, loaded, on)
    expect(store.pendingFor(home)).toStrictEqual(
      expected === undefined ? { title: 'Home' } : { title: 'Home', robots: expected },
    )
  })

  it('ticked twice adds the token once', () => {
    const store = useEditorMetadataStore()
    store.setNoindex(home, { robots: 'nofollow' }, true)
    store.setNoindex(home, { robots: 'nofollow' }, true)
    expect(store.pendingFor(home)).toStrictEqual({ robots: 'noindex, nofollow' })
  })

  it.each([
    'nofollow,noindex',
    'nofollow',
    undefined,
  ])('ticked and unticked again on robots %j clears the entry', robots => {
    const store = useEditorMetadataStore()
    const loaded = robots === undefined ? {} : { robots }
    const startsOn = robots?.includes('noindex') ?? false
    store.setNoindex(home, loaded, !startsOn)
    expect(store.hasPendingFor(home)).toBe(true)
    store.setNoindex(home, loaded, startsOn)
    expect(store.hasPendingFor(home)).toBe(false)
  })
})
