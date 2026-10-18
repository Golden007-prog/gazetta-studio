/**
 * The SEO form reads and writes the editor's pending metadata
 * (design-editor-ux.md, "Page metadata is a pending lane"). Before, it
 * kept the edit in its own state, so opening another component dropped
 * it, and it rebuilt `robots` from the checkbox alone.
 */
import { beforeEach, describe, expect, it } from 'vitest'
import { mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import PageMetadataEditor from '../src/client/components/PageMetadataEditor.vue'
import { useEditorMetadataStore } from '../src/client/stores/editorMetadata.js'
import { useSelectionStore } from '../src/client/stores/selection.js'

const home = { kind: 'page' as const, name: 'home' }

function select(metadata: Record<string, unknown>) {
  useSelectionStore().$patch({
    selection: {
      type: 'page',
      name: 'home',
      detail: {
        name: 'home',
        route: '/',
        template: 'page-default',
        content: {},
        components: [],
        dir: 'pages/home',
        metadata,
      },
    } as never,
  })
}

beforeEach(() => setActivePinia(createPinia()))

describe('PageMetadataEditor', () => {
  it('shows the pending metadata, not the loaded one, when it mounts again', () => {
    // Opening another component unmounts the form; coming back mounts it again.
    select({ title: 'Home' })
    useEditorMetadataStore().setField(home, { title: 'Home' }, 'title', 'Pending title')
    const wrapper = mount(PageMetadataEditor)
    expect((wrapper.find('[data-testid="meta-title"]').element as HTMLInputElement).value).toBe('Pending title')
    expect(wrapper.find('[data-testid="serp-preview"]').text()).toContain('Pending title')
  })

  it('unticking noindex keeps the other robots tokens', async () => {
    select({ robots: 'noindex, nofollow' })
    const wrapper = mount(PageMetadataEditor)
    const box = wrapper.find('[data-testid="meta-noindex"]')
    expect((box.element as HTMLInputElement).checked).toBe(true)
    await box.setValue(false)
    expect(useEditorMetadataStore().pendingFor(home)).toStrictEqual({ robots: 'nofollow' })
  })
})
