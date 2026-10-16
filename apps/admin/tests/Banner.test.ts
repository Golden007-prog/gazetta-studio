/**
 * Banner — tests pinning the primitive's contract
 * (design-review-workflow.md "UX implementation foundation"):
 * severity drives class + default icon + default role; `role` / `icon`
 * override; default and `#actions` slots render; dismiss is opt-in and
 * emits rather than hiding.
 */
import { beforeAll, describe, expect, it } from 'vitest'
import { mount } from '@vue/test-utils'
import PrimeVue from 'primevue/config'
import Banner from '../src/client/components/Banner.vue'

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

type Props = InstanceType<typeof Banner>['$props']

function render(props: Props, slots: Record<string, string> = { default: 'Message' }) {
  return mount(Banner, { props, slots, global: { plugins: [PrimeVue] } })
}

describe('Banner — severity', () => {
  it.each([
    ['danger', 'alert', 'pi-times-circle'],
    ['warning', 'alert', 'pi-exclamation-triangle'],
    ['info', 'status', 'pi-info-circle'],
    ['success', 'status', 'pi-check-circle'],
  ] as const)('%s → role=%s, icon %s, severity class', (severity, role, icon) => {
    const wrapper = render({ severity })
    expect(wrapper.classes()).toContain(`banner-${severity}`)
    expect(wrapper.attributes('data-severity')).toBe(severity)
    expect(wrapper.attributes('role')).toBe(role)
    const iconEl = wrapper.find('.banner-icon')
    expect(iconEl.classes()).toContain(icon)
    expect(iconEl.attributes('aria-hidden')).toBe('true')
  })

  it('role prop overrides the severity default', () => {
    expect(render({ severity: 'warning', role: 'status' }).attributes('role')).toBe('status')
    expect(render({ severity: 'info', role: 'alert' }).attributes('role')).toBe('alert')
  })

  it('icon prop replaces the severity default', () => {
    const iconEl = render({ severity: 'warning', icon: 'pi pi-archive' }).find('.banner-icon')
    expect(iconEl.classes()).toContain('pi-archive')
    expect(iconEl.classes()).not.toContain('pi-exclamation-triangle')
  })
})

describe('Banner — slots', () => {
  it('renders default slot content as the message', () => {
    const wrapper = render({ severity: 'info' }, { default: '<strong>Draft</strong> — not submitted.' })
    expect(wrapper.find('.banner-text').html()).toContain('<strong>Draft</strong>')
  })

  it('renders the actions slot inside the actions region', () => {
    const wrapper = render(
      { severity: 'warning' },
      { default: 'Pending', actions: '<button data-testid="act">Approve</button>' },
    )
    expect(wrapper.find('.banner-actions [data-testid="act"]').exists()).toBe(true)
  })

  it('omits the actions region when the slot is empty', () => {
    expect(render({ severity: 'warning' }).find('.banner-actions').exists()).toBe(false)
  })
})

describe('Banner — dismiss', () => {
  it('has no dismiss button unless dismissible', () => {
    expect(render({ severity: 'info' }).find('[data-testid="banner-dismiss"]').exists()).toBe(false)
  })

  it('emits dismiss once per click and stays rendered (consumer owns visibility)', async () => {
    const wrapper = render({ severity: 'info', dismissible: true })
    const dismiss = wrapper.find('[data-testid="banner-dismiss"]')
    expect(dismiss.attributes('aria-label')).toBe('Dismiss')
    await dismiss.trigger('click')
    expect(wrapper.emitted('dismiss')).toHaveLength(1)
    expect(wrapper.find('.banner').exists()).toBe(true)
  })
})

describe('Banner — attribute passthrough', () => {
  it('forwards data-testid to the root', () => {
    const wrapper = mount(Banner, {
      props: { severity: 'info' },
      attrs: { 'data-testid': 'review-banner' },
      global: { plugins: [PrimeVue] },
    })
    expect(wrapper.attributes('data-testid')).toBe('review-banner')
  })
})
