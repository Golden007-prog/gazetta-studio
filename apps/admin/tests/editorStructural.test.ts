import { describe, it, expect, beforeEach } from 'vitest'
import { setActivePinia, createPinia } from 'pinia'
import type { ComponentEntry, InlineComponent, ManifestKey } from 'gazetta/types'
import { structuralKeyToString, useEditorStructuralStore } from '../src/client/stores/editorStructural.js'

const homeKey: ManifestKey = { kind: 'page', name: 'home' }
const headerKey: ManifestKey = { kind: 'fragment', name: 'header' }

function inline(name: string, template = 'card'): InlineComponent {
  return { name, template, content: {} }
}

const baseComponents: ComponentEntry[] = ['@header', inline('hero'), inline('features'), '@footer']

describe('editorStructural', () => {
  beforeEach(() => setActivePinia(createPinia()))

  describe('moveComponent', () => {
    it('seeds an entry on first move and reorders pending', () => {
      const store = useEditorStructuralStore()
      store.moveComponent(homeKey, baseComponents, 1, 2)
      const pending = store.pendingFor(homeKey)
      expect(pending).not.toBeNull()
      expect((pending![1] as InlineComponent).name).toBe('features')
      expect((pending![2] as InlineComponent).name).toBe('hero')
    })

    it('subsequent moves compose when the caller passes current pending', () => {
      const store = useEditorStructuralStore()
      // Real callers (ComponentTree) pass `effectiveComponents` which returns
      // pending when present — so subsequent mutations naturally operate on
      // the up-to-date order.
      store.moveComponent(homeKey, baseComponents, 1, 2)
      const afterFirst = store.pendingFor(homeKey)!
      store.moveComponent(homeKey, afterFirst, 0, 1)
      const afterSecond = store.pendingFor(homeKey)!
      // First move: ['@header', 'features', 'hero', '@footer']
      // Second move (0→1): ['features', '@header', 'hero', '@footer']
      expect((afterSecond[0] as InlineComponent).name).toBe('features')
      expect(afterSecond[1]).toBe('@header')
    })

    it('does not mutate the input array', () => {
      const store = useEditorStructuralStore()
      const snapshot = JSON.stringify(baseComponents)
      store.moveComponent(homeKey, baseComponents, 1, 3)
      expect(JSON.stringify(baseComponents)).toBe(snapshot)
    })

    it('no-ops when fromIndex === toIndex', () => {
      const store = useEditorStructuralStore()
      store.moveComponent(homeKey, baseComponents, 1, 1)
      expect(store.hasPendingFor(homeKey)).toBe(false)
    })

    it('no-ops on out-of-range indices', () => {
      const store = useEditorStructuralStore()
      store.moveComponent(homeKey, baseComponents, -1, 1)
      store.moveComponent(homeKey, baseComponents, 1, 99)
      expect(store.hasPendingFor(homeKey)).toBe(false)
    })
  })

  describe('addComponent', () => {
    it('appends by default and seeds entry', () => {
      const store = useEditorStructuralStore()
      store.addComponent(homeKey, baseComponents, inline('cta'))
      const pending = store.pendingFor(homeKey)!
      expect(pending).toHaveLength(5)
      expect((pending[4] as InlineComponent).name).toBe('cta')
    })

    it('inserts at given index', () => {
      const store = useEditorStructuralStore()
      store.addComponent(homeKey, baseComponents, inline('banner'), 1)
      const pending = store.pendingFor(homeKey)!
      expect((pending[1] as InlineComponent).name).toBe('banner')
      expect((pending[2] as InlineComponent).name).toBe('hero')
    })

    it('accepts fragment reference strings', () => {
      const store = useEditorStructuralStore()
      store.addComponent(homeKey, baseComponents, '@sidebar', 0)
      const pending = store.pendingFor(homeKey)!
      expect(pending[0]).toBe('@sidebar')
    })
  })

  describe('removeComponent', () => {
    it('removes the entry at index and seeds entry', () => {
      const store = useEditorStructuralStore()
      store.removeComponent(homeKey, baseComponents, 1)
      const pending = store.pendingFor(homeKey)!
      expect(pending).toHaveLength(3)
      expect((pending[1] as InlineComponent).name).toBe('features')
    })

    it('no-ops on out-of-range indices', () => {
      const store = useEditorStructuralStore()
      store.removeComponent(homeKey, baseComponents, -1)
      store.removeComponent(homeKey, baseComponents, 99)
      expect(store.hasPendingFor(homeKey)).toBe(false)
    })
  })

  describe('discard', () => {
    it('removes the pending entry for a key', () => {
      const store = useEditorStructuralStore()
      store.moveComponent(homeKey, baseComponents, 1, 2)
      expect(store.hasPendingFor(homeKey)).toBe(true)
      store.discard(homeKey)
      expect(store.hasPendingFor(homeKey)).toBe(false)
    })

    it('does not affect entries for other keys', () => {
      const store = useEditorStructuralStore()
      store.moveComponent(homeKey, baseComponents, 1, 2)
      store.moveComponent(headerKey, baseComponents, 1, 2)
      store.discard(homeKey)
      expect(store.hasPendingFor(homeKey)).toBe(false)
      expect(store.hasPendingFor(headerKey)).toBe(true)
    })
  })

  describe('clearAll', () => {
    it('removes all entries', () => {
      const store = useEditorStructuralStore()
      store.moveComponent(homeKey, baseComponents, 1, 2)
      store.moveComponent(headerKey, baseComponents, 1, 2)
      store.clearAll()
      expect(store.pendingCount).toBe(0)
      expect(store.hasPendingEdits).toBe(false)
    })
  })

  describe('pendingCount + hasPendingEdits', () => {
    it('reflect the size of the pending map', () => {
      const store = useEditorStructuralStore()
      expect(store.pendingCount).toBe(0)
      expect(store.hasPendingEdits).toBe(false)
      store.moveComponent(homeKey, baseComponents, 1, 2)
      expect(store.pendingCount).toBe(1)
      expect(store.hasPendingEdits).toBe(true)
      store.moveComponent(headerKey, baseComponents, 0, 1)
      expect(store.pendingCount).toBe(2)
    })
  })

  describe('original snapshot', () => {
    it('preserves the original array for discard semantics', () => {
      const store = useEditorStructuralStore()
      // First mutation seeds original from baseComponents
      store.moveComponent(homeKey, baseComponents, 1, 2)
      // Second mutation should not change the original
      store.moveComponent(homeKey, baseComponents, 0, 3)
      const entry = [...store.entries.values()][0]
      expect(entry.original).toEqual(baseComponents)
    })
  })

  describe('allEntries', () => {
    it('returns all pending entries with their string keys', () => {
      const store = useEditorStructuralStore()
      store.moveComponent(homeKey, baseComponents, 1, 2)
      store.moveComponent(headerKey, baseComponents, 0, 1)
      const all = store.allEntries()
      expect(all).toHaveLength(2)
      const keys = all.map(([k]) => k).sort()
      expect(keys).toEqual(
        [
          structuralKeyToString({ kind: 'fragment', name: 'header' }),
          structuralKeyToString({ kind: 'page', name: 'home' }),
        ].sort(),
      )
    })
  })
})
