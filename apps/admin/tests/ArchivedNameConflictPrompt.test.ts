/**
 * Cut 11 — ArchivedNameConflictPrompt tests.
 *
 * Pins the locked behavior:
 *   - Default selection = restore per design-soft-delete.md Q5 I3
 *   - All three options render with explanations
 *   - Continue emits the selected mode
 *   - Cancel emits the cancel event
 *   - busy disables Cancel
 */
import { beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import PrimeVue from 'primevue/config'
import ArchivedNameConflictPrompt from '../src/client/components/ArchivedNameConflictPrompt.vue'
import type { ArchivedNameConflictDetails } from '../src/client/api/client.js'

beforeAll(() => {
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
})

const archive: ArchivedNameConflictDetails = {
  kind: 'page',
  name: 'home',
  archivedAt: '2026-04-15T10:30:00Z',
  archivedBy: 'alice',
  aliasOf: 'about',
}

function render(props: { archive: ArchivedNameConflictDetails; busy?: boolean }) {
  return mount(ArchivedNameConflictPrompt, {
    props,
    global: { plugins: [PrimeVue] },
  })
}

describe('ArchivedNameConflictPrompt', () => {
  it('renders all three resolution options', () => {
    const wrapper = render({ archive })
    expect(wrapper.find('[data-testid="conflict-option-restore"]').exists()).toBe(true)
    expect(wrapper.find('[data-testid="conflict-option-replace"]').exists()).toBe(true)
    expect(wrapper.find('[data-testid="conflict-option-moveAside"]').exists()).toBe(true)
  })

  it('shows the archive details (name, archivedAt, archivedBy, aliasOf)', () => {
    const wrapper = render({ archive })
    const text = wrapper.text()
    expect(text).toContain('home')
    expect(text).toContain('alice')
    expect(text).toContain('about')
  })

  it('handles archives without optional fields', () => {
    const wrapper = render({ archive: { kind: 'fragment', name: 'header' } })
    const text = wrapper.text()
    expect(text).toContain('header')
    // No "by alice" archivedBy detail or "redirects to" aliasOf detail.
    expect(text).not.toMatch(/\bby alice\b/)
    expect(text).not.toContain('redirects to')
  })

  it('Continue button data-testid reflects the default Restore choice', () => {
    const wrapper = render({ archive })
    expect(wrapper.find('[data-testid="conflict-continue-restore"]').exists()).toBe(true)
  })

  it('hides the Restore option for a Manual Redirect archive (#1343)', () => {
    const wrapper = render({ archive: { ...archive, redirect: true } })
    expect(wrapper.find('[data-testid="conflict-option-restore"]').exists()).toBe(false)
    expect(wrapper.find('[data-testid="conflict-option-replace"]').exists()).toBe(true)
    expect(wrapper.find('[data-testid="conflict-option-moveAside"]').exists()).toBe(true)
  })

  it('defaults to Replace for a Manual Redirect archive', () => {
    const wrapper = render({ archive: { ...archive, redirect: true } })
    expect(wrapper.find('[data-testid="conflict-continue-replace"]').exists()).toBe(true)
  })

  it('emits resolve with the default mode (restore) when Continue clicked', async () => {
    const wrapper = render({ archive })
    await wrapper.find('[data-testid="conflict-continue-restore"]').trigger('click')
    await flushPromises()
    expect(wrapper.emitted('resolve')).toBeTruthy()
    expect(wrapper.emitted('resolve')![0]).toEqual(['restore'])
  })

  it('emits cancel on Cancel click', async () => {
    const wrapper = render({ archive })
    await wrapper.find('[data-testid="conflict-cancel"]').trigger('click')
    await flushPromises()
    expect(wrapper.emitted('cancel')).toBeTruthy()
  })

  it('disables Cancel when busy=true', () => {
    const wrapper = render({ archive, busy: true })
    const cancelButton = wrapper.find('[data-testid="conflict-cancel"]')
    expect((cancelButton.element as HTMLButtonElement).disabled).toBe(true)
  })
})
