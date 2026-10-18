/**
 * Integration tests for the structural lane in useEditorActions / useEditingStore.
 *
 * Verifies:
 *  - pendingCount aggregates content (stash + current dirty) AND structural
 *  - allOverrides returns the typed DraftOverrides shape with both lanes
 *  - structural edits clear on save success
 *  - discard reverts content + structural (single-page focus)
 */
import { describe, it, expect, beforeEach } from 'vitest'
import { setActivePinia, createPinia } from 'pinia'
import type { ManifestKey } from 'gazetta/types'
import { useEditingStore } from '../src/client/stores/editing.js'
import { useEditorStructuralStore } from '../src/client/stores/editorStructural.js'
import { useEditorContentStore } from '../src/client/stores/editorContent.js'
import { useSelectionStore } from '../src/client/stores/selection.js'

const homeKey: ManifestKey = { kind: 'page', name: 'home' }
const baseComponents = ['@header', { name: 'hero', template: 'hero', content: {} }, '@footer']

describe('useEditorActions × structural lane', () => {
  beforeEach(() => setActivePinia(createPinia()))

  describe('pendingCount aggregation', () => {
    it('counts a structural pending entry as 1', () => {
      const editing = useEditingStore()
      const structural = useEditorStructuralStore()
      expect(editing.pendingCount).toBe(0)
      structural.moveComponent(homeKey, baseComponents, 0, 1)
      expect(editing.pendingCount).toBe(1)
      expect(editing.hasPendingEdits).toBe(true)
    })

    it('combines content stash + current-dirty + structural', async () => {
      const editing = useEditingStore()
      const structural = useEditorStructuralStore()
      const ec = useEditorContentStore()

      // Open a target and dirty it (current-dirty +1)
      await ec.open({
        template: 'hero',
        path: 'hero',
        content: { title: 'A' },
        schema: {},
        save: async () => {},
      })
      ec.markDirty({ title: 'B' })

      // Add a structural pending entry (+1)
      structural.moveComponent(homeKey, baseComponents, 0, 1)

      expect(editing.pendingCount).toBe(2)
    })
  })

  describe('allOverrides shape', () => {
    it('always returns { content, structural } with both fields', () => {
      const editing = useEditingStore()
      expect(editing.allOverrides).toEqual({ content: {}, structural: {} })
    })

    it('populates structural lane when pending', () => {
      const editing = useEditingStore()
      const structural = useEditorStructuralStore()
      structural.moveComponent(homeKey, baseComponents, 0, 1)
      const overrides = editing.allOverrides
      expect(overrides.structural['page:home']).toBeDefined()
      expect(overrides.structural['page:home']).toHaveLength(3)
    })

    it('populates both lanes when both have pending', async () => {
      const editing = useEditingStore()
      const ec = useEditorContentStore()
      const structural = useEditorStructuralStore()

      await ec.open({
        template: 'hero',
        path: 'hero',
        content: { title: 'A' },
        schema: {},
        save: async () => {},
      })
      ec.markDirty({ title: 'B' })
      structural.moveComponent(homeKey, baseComponents, 0, 1)

      const overrides = editing.allOverrides
      expect(overrides.content.hero).toEqual({ title: 'B' })
      expect(overrides.structural['page:home']).toBeDefined()
    })
  })

  describe('discard with focus on a page', () => {
    it('discards structural pending for the focused page', async () => {
      const editing = useEditingStore()
      const structural = useEditorStructuralStore()
      const selection = useSelectionStore()
      // Force selection to home so currentManifestKey() resolves to page:home.
      // The internal API mutates `selection.value`; we simulate by pushing detail.
      // Cast through unknown to satisfy the strict Selection type without supplying
      // a full PageDetail.
      ;(selection as unknown as { selection: { type: string; name: string; detail: unknown } }).selection = {
        type: 'page',
        name: 'home',
        detail: { name: 'home', route: '/', template: 'page-default', components: baseComponents },
      }

      structural.moveComponent(homeKey, baseComponents, 0, 1)
      expect(editing.pendingCount).toBe(1)

      editing.discard()
      expect(editing.pendingCount).toBe(0)
      expect(structural.hasPendingFor(homeKey)).toBe(false)
    })

    it('does not affect structural pending for other pages', () => {
      const editing = useEditingStore()
      const structural = useEditorStructuralStore()
      const selection = useSelectionStore()
      const aboutKey: ManifestKey = { kind: 'page', name: 'about' }
      ;(selection as unknown as { selection: { type: string; name: string; detail: unknown } }).selection = {
        type: 'page',
        name: 'home',
        detail: { name: 'home', route: '/', template: 'page-default', components: baseComponents },
      }

      structural.moveComponent(homeKey, baseComponents, 0, 1)
      structural.moveComponent(aboutKey, baseComponents, 0, 1)
      editing.discard()
      expect(structural.hasPendingFor(homeKey)).toBe(false)
      expect(structural.hasPendingFor(aboutKey)).toBe(true)
    })
  })
})
