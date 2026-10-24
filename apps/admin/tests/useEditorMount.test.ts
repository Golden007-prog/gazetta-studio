/**
 * The editor gets plain data, not Vue proxies. The editor store keeps content
 * and schema in deep refs, so reading them gives proxies, and @rjsf/core
 * (6.11+) structuredClones its form data on every change below the root,
 * which a proxy can't survive (DataCloneError).
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { defineComponent, h, ref, computed, isProxy, type Ref } from 'vue'
import { mount, flushPromises } from '@vue/test-utils'
import { setActivePinia, createPinia } from 'pinia'
import type { EditorMount } from 'gazetta/types'
import { useEditorContentStore, type EditingTarget } from '../src/client/stores/editorContent.js'
import { useActiveEditorMount } from '../src/client/composables/useActiveEditorMount.js'
import { useEditorMount } from '../src/client/composables/useEditorMount.js'

const onChange = vi.fn()

function harness(editorMount: () => Ref<EditorMount | null>) {
  return defineComponent({
    setup() {
      const ec = useEditorContentStore()
      const containerRef = ref<HTMLElement | null>(null)
      useEditorMount(
        containerRef,
        editorMount(),
        computed(() => ec.content),
        computed(() => ec.schema as Record<string, unknown> | null),
        ref<'dark' | 'light'>('light'),
        onChange,
        computed(() => ec.mountVersion),
      )
      return () => h('div', { ref: containerRef })
    },
  })
}

// An array of objects: the shape where a form is most likely to keep data it was handed.
const schema = {
  type: 'object',
  properties: {
    title: { type: 'string' },
    items: { type: 'array', items: { type: 'object', properties: { label: { type: 'string' } } } },
  },
}
const content = { title: 'Hello', items: [{ label: 'One' }] }

function target(): EditingTarget {
  return { template: 'list', path: 'list', content, schema, save: async () => {} }
}

function typeInto(input: HTMLInputElement, value: string) {
  // React tracks the value through the prototype setter; set it there so the input event counts as a change.
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, value)
  input.dispatchEvent(new Event('input', { bubbles: true }))
}

describe('useEditorMount', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    onChange.mockReset()
  })

  it('mounts the editor with plain copies of the content and schema, on open and on discard', async () => {
    const mounted: Array<{ content: unknown; schema: unknown }> = []
    const recording: EditorMount = { mount: (_el, props) => mounted.push(props), unmount: () => {} }
    const wrapper = mount(harness(() => ref(recording)))
    const ec = useEditorContentStore()
    await ec.open(target())
    await flushPromises()
    ec.markDirty({ title: 'Edited', items: [{ label: 'Two' }] })
    ec.discard()
    await flushPromises()

    expect(mounted).toHaveLength(2)
    for (const props of mounted) {
      expect(isProxy(props.content)).toBe(false)
      expect(isProxy(props.schema)).toBe(false)
      expect(props).toMatchObject({ content, schema })
    }
    wrapper.unmount()
  })

  // Uses the real `gazetta/editor` form (from packages/gazetta's build), not a mock.
  it('passes an edit in the default form through to onChange', async () => {
    const wrapper = mount(
      harness(() => useActiveEditorMount().editorMount),
      { attachTo: document.body },
    )
    const ec = useEditorContentStore()
    await ec.open(target())
    await flushPromises()
    const title = await vi.waitFor(() => {
      const el = wrapper.element.querySelector<HTMLInputElement>('input[id$="title"]')
      if (!el) throw new Error('title input not rendered yet')
      return el
    })

    typeInto(title, 'Hello there')

    await vi.waitFor(() => expect(onChange).toHaveBeenCalled())
    expect(onChange).toHaveBeenLastCalledWith({ title: 'Hello there', items: [{ label: 'One' }] })
    wrapper.unmount()
  })
})
