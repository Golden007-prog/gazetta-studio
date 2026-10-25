/**
 * Component tests for CmsToolbar.vue.
 *
 * Scope: the Publish affordance follows the one-target rule from
 * design-editor-ux.md "Progressive disclosure" — a site with exactly one
 * target has nowhere to publish to, so Save is all (#1285). Sync chips and
 * the target switcher already follow the same rule (they derive from
 * non-active targets); the toolbar button did not.
 *
 * Uses real Pinia + a real vue-router memory instance. PrimeVue is
 * registered globally so Toolbar/Button resolve. Panel and drawer children
 * are stubbed — their internals aren't the subject here.
 */
import { describe, it, expect, beforeEach } from 'vitest'
import { mount, type ComponentMountingOptions } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import PrimeVue from 'primevue/config'
import { createRouter, createMemoryHistory } from 'vue-router'
import CmsToolbar from '../src/client/components/CmsToolbar.vue'
import { useActiveTargetStore } from '../src/client/stores/activeTarget.js'
import type { TargetInfo } from '../src/client/api/client.js'

function makeTarget(name: string): TargetInfo {
  return {
    name,
    environment: 'local',
    type: 'static',
    editable: true,
    altText: { available: false, auto: false },
  }
}

function setup(targets: TargetInfo[]) {
  const active$ = useActiveTargetStore()
  active$.configure({
    loadTargets: async () => targets,
  })
  active$.targets = targets
  active$.activeTargetName = targets[0]?.name ?? null
  return { active$ }
}

function mountWithGlobals(options?: ComponentMountingOptions<typeof CmsToolbar>) {
  const router = createRouter({
    history: createMemoryHistory(),
    routes: [{ path: '/:pathMatch(.*)*', component: { template: '<div />' } }],
  })
  return mount(CmsToolbar, {
    global: {
      plugins: [PrimeVue, router],
      stubs: {
        PublishPanel: true,
        SiteHealthDrawer: true,
        ActiveTargetIndicator: true,
        SyncIndicators: true,
        LocalePicker: true,
      },
      ...options?.global,
    },
    ...options,
  })
}

describe('CmsToolbar', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
  })

  it('renders no Publish button on a one-target site', () => {
    setup([makeTarget('local')])
    const w = mountWithGlobals()
    expect(w.find('[data-testid="publish-btn"]').exists()).toBe(false)
  })

  it('renders the Publish button with two targets', () => {
    setup([makeTarget('local'), makeTarget('staging')])
    const w = mountWithGlobals()
    expect(w.find('[data-testid="publish-btn"]').exists()).toBe(true)
  })
})
