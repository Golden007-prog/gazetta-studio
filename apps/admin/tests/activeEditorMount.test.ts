/**
 * Pins the editor-mount lifecycle for templates with a custom editor
 * (#909, #886). The editor's undo/redo stacks live inside the mounted
 * React form, so any remount after the author starts editing silently
 * empties them. A target with a custom editor must mount exactly once —
 * with the custom editor — not the default form first and the custom
 * editor later when its async import resolves.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { defineComponent, h, ref, computed } from 'vue'
import { mount, flushPromises } from '@vue/test-utils'
import { setActivePinia, createPinia } from 'pinia'
import type { EditorMount } from 'gazetta/types'

const defaultMounts: unknown[] = []
vi.mock('gazetta/editor', () => ({
  createEditorMount: (): EditorMount => ({
    mount: (_el, props) => {
      defaultMounts.push(props.content)
    },
    unmount: () => {},
  }),
}))

import { useEditorContentStore, type EditingTarget } from '../src/client/stores/editorContent.js'
import { useActiveEditorMount } from '../src/client/composables/useActiveEditorMount.js'
import { useEditorMount } from '../src/client/composables/useEditorMount.js'

const CUSTOM_EDITOR_URL =
  'data:text/javascript,' +
  encodeURIComponent(
    'export default { mount(el, p) { (globalThis.__customMounts ||= []).push(p.content) }, unmount() {} }',
  )

function makeTarget(overrides: Partial<EditingTarget> = {}): EditingTarget {
  return {
    template: 'hero',
    path: 'hero',
    content: { title: 'Hello' },
    schema: { properties: { title: { type: 'string' } } },
    save: async () => {},
    ...overrides,
  }
}

const Harness = defineComponent({
  setup() {
    const ec = useEditorContentStore()
    const containerRef = ref<HTMLElement | null>(null)
    const { editorMount } = useActiveEditorMount()
    useEditorMount(
      containerRef,
      editorMount,
      computed(() => ec.content),
      computed(() => ec.schema as Record<string, unknown> | null),
      ref<'dark' | 'light'>('light'),
      () => {},
      computed(() => ec.mountVersion),
    )
    return () => h('div', { ref: containerRef })
  },
})

function customMounts(): unknown[] {
  return ((globalThis as Record<string, unknown>).__customMounts as unknown[]) ?? []
}

describe('useActiveEditorMount', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    defaultMounts.length = 0
    ;(globalThis as Record<string, unknown>).__customMounts = []
  })

  it('mounts a custom-editor target once, with the custom editor only', async () => {
    const wrapper = mount(Harness)
    const ec = useEditorContentStore()
    await ec.open(makeTarget({ hasEditor: true, editorUrl: CUSTOM_EDITOR_URL }))
    await flushPromises()

    expect(defaultMounts).toEqual([])
    expect(customMounts()).toEqual([{ title: 'Hello' }])
    wrapper.unmount()
  })

  it('mounts the default form once for a target without a custom editor', async () => {
    const wrapper = mount(Harness)
    const ec = useEditorContentStore()
    await ec.open(makeTarget())
    await flushPromises()

    expect(defaultMounts).toEqual([{ title: 'Hello' }])
    expect(customMounts()).toEqual([])
    wrapper.unmount()
  })

  it('falls back to the default form when the custom editor fails to load', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const wrapper = mount(Harness)
    const ec = useEditorContentStore()
    await ec.open(makeTarget({ hasEditor: true, editorUrl: 'data:text/javascript,throw new Error("boom")' }))
    await flushPromises()

    expect(defaultMounts).toEqual([{ title: 'Hello' }])
    wrapper.unmount()
    warn.mockRestore()
  })
})
