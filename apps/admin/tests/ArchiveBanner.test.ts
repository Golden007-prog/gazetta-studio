/**
 * Cut 10 MVP — ArchiveBanner tests.
 *
 * Pins the locked behavior:
 *   - hidden when item is live (Krug "absence-as-state")
 *   - shown when archived; alias suffix when aliasOf set
 *   - "pure soft-delete" message when no aliasOf
 *   - Restore button dispatches unarchive
 *   - Edit alias button dispatches askArchive (modal)
 *   - Delete permanently button dispatches askPurge
 */
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import PrimeVue from 'primevue/config'
import ArchiveBanner from '../src/client/components/ArchiveBanner.vue'
import { useSiteStore } from '../src/client/stores/site.js'
import { useArchiveStore } from '../src/client/stores/archive.js'
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
  // Pinia's setup-store unwraps refs at the proxy level — direct
  // assignment works.
  site.pages = opts.pages ?? []
  site.fragments = opts.fragments ?? []
  return site
}

function render(props: { kind: 'page' | 'fragment'; name: string }) {
  return mount(ArchiveBanner, {
    props,
    global: { plugins: [PrimeVue] },
  })
}

describe('ArchiveBanner', () => {
  it('is hidden when the item is live (no archive flag)', () => {
    seedSite({
      pages: [{ name: 'home', route: '/', template: 'page-default' }],
    })
    const wrapper = render({ kind: 'page', name: 'home' })
    expect(wrapper.find('[data-testid="archive-banner-page-home"]').exists()).toBe(false)
  })

  it('is hidden when the item does not exist in the site store', () => {
    seedSite()
    const wrapper = render({ kind: 'page', name: 'missing' })
    expect(wrapper.find('[data-testid="archive-banner-page-missing"]').exists()).toBe(false)
  })

  it('shows alias-redirect message when archived with aliasOf', () => {
    seedSite({
      pages: [{ name: 'old', route: '/old', template: 'page-default', archived: true, aliasOf: 'home' }],
    })
    const wrapper = render({ kind: 'page', name: 'old' })
    const banner = wrapper.find('[data-testid="archive-banner-page-old"]')
    expect(banner.exists()).toBe(true)
    expect(banner.text()).toContain('Redirects to')
    expect(banner.text()).toContain('home')
    expect(banner.text()).toContain('301')
  })

  it('shows pure-soft-delete message when archived without aliasOf', () => {
    seedSite({
      pages: [{ name: 'gone', route: '/gone', template: 'page-default', archived: true }],
    })
    const wrapper = render({ kind: 'page', name: 'gone' })
    const banner = wrapper.find('[data-testid="archive-banner-page-gone"]')
    expect(banner.exists()).toBe(true)
    expect(banner.text()).toContain('410 Gone')
  })

  it('hides Restore for a Manual Redirect archive (alias + no template) (#1343)', () => {
    // Redirect manifests carry no template — restoring one is refused
    // by the backend, so the button must not be offered.
    seedSite({
      pages: [{ name: 'old', route: '/old', archived: true, aliasOf: 'home' }],
    })
    const wrapper = render({ kind: 'page', name: 'old' })
    expect(wrapper.find('[data-testid="archive-banner-page-old"]').exists()).toBe(true)
    expect(wrapper.find('[data-testid="archive-restore-page-old"]').exists()).toBe(false)
  })

  it('keeps Restore for an archived content item that aliases elsewhere', () => {
    seedSite({
      pages: [{ name: 'old', route: '/old', template: 'page-default', archived: true, aliasOf: 'home' }],
    })
    const wrapper = render({ kind: 'page', name: 'old' })
    expect(wrapper.find('[data-testid="archive-restore-page-old"]').exists()).toBe(true)
  })

  it('Edit alias button dispatches askArchive on the store', async () => {
    seedSite({
      pages: [{ name: 'old', route: '/old', template: 'page-default', archived: true, aliasOf: 'home' }],
    })
    const archive = useArchiveStore()
    const wrapper = render({ kind: 'page', name: 'old' })
    await wrapper.find('[data-testid="archive-edit-alias-page-old"]').trigger('click')
    await flushPromises()
    expect(archive.status).toBe('archive-confirming')
    expect(archive.item).toMatchObject({ kind: 'page', name: 'old', currentAliasOf: 'home' })
  })

  it('Delete permanently button dispatches askPurge on the store', async () => {
    seedSite({
      pages: [{ name: 'old', route: '/old', template: 'page-default', archived: true }],
    })
    const archive = useArchiveStore()
    const wrapper = render({ kind: 'page', name: 'old' })
    await wrapper.find('[data-testid="archive-purge-page-old"]').trigger('click')
    await flushPromises()
    expect(archive.status).toBe('purge-confirming')
    expect(archive.item).toMatchObject({ kind: 'page', name: 'old' })
  })
})
