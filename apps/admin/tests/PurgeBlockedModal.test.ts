/**
 * Cut 12 — PurgeBlockedModal tests.
 *
 * Pins the locked behavior:
 *   - hidden when not in purge-blocked state
 *   - renders alias-pointers + live-refs when populated
 *   - alias rows show Drop alias + Restore actions
 *   - liveRef rows show Open (jump-to-ref) action
 *   - Drop alias dispatches setAlias on the store
 *   - Restore dispatches restoreBlocker on the store
 */
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import PrimeVue from 'primevue/config'
import PurgeBlockedModal from '../src/client/components/PurgeBlockedModal.vue'
import { useArchiveStore, type ArchiveTarget, type PurgeBlocker } from '../src/client/stores/archive.js'

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
  vi.stubGlobal('fetch', vi.fn())
})

const archived: ArchiveTarget = { kind: 'page', name: 'home', archived: true }

function render() {
  return mount(PurgeBlockedModal, {
    attachTo: document.body,
    global: {
      plugins: [
        PrimeVue,
        {
          install(app) {
            app.config.globalProperties.$router = { push: vi.fn() }
          },
        },
      ],
      mocks: {
        $router: { push: vi.fn() },
      },
      stubs: {
        // The router is provided via vue-router's `useRouter` — stub
        // to avoid pulling in the real router for component tests.
        RouterLink: { template: '<a><slot /></a>' },
      },
    },
  })
}

function dialog(): HTMLElement | null {
  return document.querySelector('[data-testid="purge-blocked-modal"]')
}

function seedBlocked(opts: { aliases?: PurgeBlocker[]; liveRefs?: PurgeBlocker[] }) {
  const archive = useArchiveStore()
  archive.item = archived
  archive.blockedAliases = opts.aliases ?? []
  archive.blockedLiveRefs = opts.liveRefs ?? []
  archive.status = 'purge-blocked'
}

// Stub vue-router's useRouter in the component's import context.
vi.mock('vue-router', () => ({
  useRouter: () => ({ push: vi.fn() }),
}))

describe('PurgeBlockedModal', () => {
  it('is hidden when status is not purge-blocked', () => {
    render()
    expect(dialog()).toBeNull()
  })

  it('renders alias-pointer rows with Drop alias + Restore actions', async () => {
    seedBlocked({
      aliases: [
        { kind: 'page', name: 'old-landing' },
        { kind: 'page', name: 'home-old' },
      ],
    })
    render()
    await flushPromises()

    const aliasRow1 = document.querySelector('[data-testid="purge-blocked-alias-old-landing"]')
    const aliasRow2 = document.querySelector('[data-testid="purge-blocked-alias-home-old"]')
    expect(aliasRow1).not.toBeNull()
    expect(aliasRow2).not.toBeNull()
    expect(document.querySelector('[data-testid="purge-blocked-drop-old-landing"]')).not.toBeNull()
    expect(document.querySelector('[data-testid="purge-blocked-restore-old-landing"]')).not.toBeNull()
  })

  it('renders live-ref rows with Open action', async () => {
    seedBlocked({
      liveRefs: [{ kind: 'page', name: 'blog/post-1' }],
    })
    render()
    await flushPromises()
    expect(document.querySelector('[data-testid="purge-blocked-liveref-blog/post-1"]')).not.toBeNull()
    expect(document.querySelector('[data-testid="purge-blocked-jump-blog/post-1"]')).not.toBeNull()
  })

  it('renders both sections when both are present', async () => {
    seedBlocked({
      aliases: [{ kind: 'page', name: 'a' }],
      liveRefs: [{ kind: 'page', name: 'b' }],
    })
    render()
    await flushPromises()
    expect(dialog()?.textContent).toContain('1 archive redirects here')
    expect(dialog()?.textContent).toContain('1 live')
  })

  it('Drop alias button dispatches setAlias(target, null) on the store', async () => {
    const archive = useArchiveStore()
    const setAliasSpy = vi.spyOn(archive, 'setAlias').mockResolvedValue(true)
    seedBlocked({ aliases: [{ kind: 'page', name: 'old' }] })
    render()
    await flushPromises()

    const dropButton = document.querySelector('[data-testid="purge-blocked-drop-old"]') as HTMLButtonElement
    dropButton.click()
    await flushPromises()
    expect(setAliasSpy).toHaveBeenCalledWith({ kind: 'page', name: 'old' }, null)
  })

  it('hides Restore on alias rows that are Manual Redirects (#1343)', async () => {
    // Restoring a redirect archive is refused by the backend; the row
    // keeps Drop alias but must not offer Restore.
    seedBlocked({
      aliases: [
        { kind: 'page', name: 'old-redirect', redirect: true },
        { kind: 'page', name: 'old-content' },
      ],
    })
    render()
    await flushPromises()
    expect(document.querySelector('[data-testid="purge-blocked-restore-old-redirect"]')).toBeNull()
    expect(document.querySelector('[data-testid="purge-blocked-restore-old-content"]')).not.toBeNull()
  })

  it('Restore button dispatches restoreBlocker on the store', async () => {
    const archive = useArchiveStore()
    const restoreSpy = vi.spyOn(archive, 'restoreBlocker').mockResolvedValue(true)
    seedBlocked({ aliases: [{ kind: 'page', name: 'old' }] })
    render()
    await flushPromises()

    const restoreButton = document.querySelector('[data-testid="purge-blocked-restore-old"]') as HTMLButtonElement
    restoreButton.click()
    await flushPromises()
    expect(restoreSpy).toHaveBeenCalledWith({ kind: 'page', name: 'old' })
  })

  it('Cancel button calls store close', async () => {
    const archive = useArchiveStore()
    const closeSpy = vi.spyOn(archive, 'close')
    seedBlocked({ aliases: [{ kind: 'page', name: 'old' }] })
    render()
    await flushPromises()

    const cancelButton = document.querySelector('[data-testid="purge-blocked-cancel"]') as HTMLButtonElement
    cancelButton.click()
    await flushPromises()
    expect(closeSpy).toHaveBeenCalled()
  })
})
