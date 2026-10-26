/**
 * An archived item's editor is read-only until restored
 * (design-soft-delete.md: the archive banner is the management
 * surface and "the editor below is read-only"). EditorPanel used to
 * mount a fully editable editor and SEO form for an archived item; a
 * save then silently rewrote the manifest without its archive flags
 * (#1340). The panel now marks the whole editing surface inert while
 * the site-store summary says archived: the content fields and the
 * SEO fields stay visible, but pointer, focus and keyboard
 * interaction are blocked, and the banner above keeps the actions.
 */
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import PrimeVue from 'primevue/config'
import { createRouter, createMemoryHistory } from 'vue-router'
import EditorPanel from '../src/client/components/EditorPanel.vue'
import { useSiteStore } from '../src/client/stores/site.js'
import { useSelectionStore } from '../src/client/stores/selection.js'
import { useEditorContentStore } from '../src/client/stores/editorContent.js'
import type { PageSummary, FragmentSummary } from '../src/client/api/client.js'

beforeAll(() => {
  // PrimeVue's Button uses matchMedia in jsdom contexts.
  if (typeof window.matchMedia !== 'function') {
    window.matchMedia = (query: string) =>
      ({
        matches: false,
        media: query,
        addListener: () => {},
        removeListener: () => {},
        addEventListener: () => {},
        removeEventListener: () => {},
        dispatchEvent: () => false,
        onchange: null,
      }) as unknown as MediaQueryList
  }
})

beforeEach(() => {
  setActivePinia(createPinia())
  document.body.innerHTML = ''
  vi.stubGlobal('fetch', vi.fn())
})

function seedSite(opts: { pages?: PageSummary[]; fragments?: FragmentSummary[] } = {}) {
  const site = useSiteStore()
  site.pages = opts.pages ?? []
  site.fragments = opts.fragments ?? []
  return site
}

/** The root edit surface of the selected item is open, without a schema-driven form. */
function openRoot() {
  const ec = useEditorContentStore()
  ec.target = {
    template: 'page-default',
    path: '_root',
    content: {},
    schema: {},
    save: async () => {},
  }
}

function selectPage(metadata: Record<string, unknown> = {}) {
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

function selectFragment() {
  useSelectionStore().$patch({
    selection: {
      type: 'fragment',
      name: 'header',
      detail: {
        name: 'header',
        template: 'fragment-default',
        content: {},
        components: [],
        dir: 'fragments/header',
      },
    } as never,
  })
}

function renderPanel() {
  const router = createRouter({
    history: createMemoryHistory(),
    routes: [{ path: '/:pathMatch(.*)*', component: { template: '<div />' } }],
  })
  return mount(EditorPanel, { global: { plugins: [PrimeVue, router] } })
}

describe('EditorPanel archived read-only', () => {
  it("blocks an archived page's fields and SEO fields while keeping them visible", () => {
    seedSite({ pages: [{ name: 'home', route: '/', template: 'page-default', archived: true }] })
    selectPage({ title: 'Home' })
    openRoot()
    const wrapper = renderPanel()
    const active = wrapper.find('.editor-active')
    expect(active.exists()).toBe(true)
    expect(active.attributes('inert')).toBeDefined()
    // The SEO form stays rendered (the author can read the values) but
    // sits inside the inert region, so it cannot be edited.
    const metaTitle = wrapper.find('[data-testid="meta-title"]')
    expect(metaTitle.exists()).toBe(true)
    expect(metaTitle.element.closest('[inert]')).not.toBeNull()
  })

  it('keeps the editing surface live while the page is not archived', () => {
    seedSite({ pages: [{ name: 'home', route: '/', template: 'page-default' }] })
    selectPage({ title: 'Home' })
    openRoot()
    const wrapper = renderPanel()
    const active = wrapper.find('.editor-active')
    expect(active.exists()).toBe(true)
    expect(active.attributes('inert')).toBeUndefined()
    const metaTitle = wrapper.find('[data-testid="meta-title"]')
    expect(metaTitle.exists()).toBe(true)
    expect(metaTitle.element.closest('[inert]')).toBeNull()
  })

  it("blocks an archived fragment's editing surface too", () => {
    seedSite({ fragments: [{ name: 'header', template: 'fragment-default', archived: true }] })
    selectFragment()
    openRoot()
    const wrapper = renderPanel()
    const active = wrapper.find('.editor-active')
    expect(active.exists()).toBe(true)
    expect(active.attributes('inert')).toBeDefined()
  })
})
