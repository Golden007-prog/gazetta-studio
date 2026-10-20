/**
 * Only a save sets and clears `saving`. Opening another component while
 * a save is still writing must not turn it off: the toolbar Save button
 * and Ctrl/Cmd+S both rely on it to stop a second save from starting.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { api } from '../src/client/api/client.js'
import { useEditorActions } from '../src/client/composables/useEditorActions.js'
import { useEditorPersistenceStore } from '../src/client/stores/editorPersistence.js'
import { useEditorStashStore } from '../src/client/stores/editorStash.js'
import { useSelectionStore } from '../src/client/stores/selection.js'

afterEach(() => vi.restoreAllMocks())
beforeEach(() => setActivePinia(createPinia()))

function seedPage(detail: Record<string, unknown>) {
  useSelectionStore().$patch({
    selection: {
      type: 'page',
      name: 'home',
      detail: { name: 'home', route: '/', components: [], dir: 'pages/home', ...detail },
    } as never,
  })
}

/** Starts a save whose write doesn't return until `finish` is called. */
function startPendingSave() {
  let finish!: () => void
  const written = new Promise<void>(resolve => {
    finish = resolve
  })
  const target = { template: 'hero', path: 'hero', content: {}, schema: {}, save: () => written }
  const done = useEditorPersistenceStore().save({ target, content: { title: 'B' } }, [])
  return { finish, done }
}

describe('opening a component while a save is running', () => {
  const editable = { template: 'page-default', content: {} }
  it.each([
    ['an editable page root', editable, false],
    ['a page with nothing to edit', { archived: true, aliasOf: 'about' }, false],
    ['a page root with stashed edits', editable, true],
  ])('%s: saving stays on until the save resolves', async (_label, detail, stashed) => {
    vi.spyOn(api, 'getTemplateSchema').mockResolvedValue({ properties: {} })
    seedPage(detail)
    if (stashed) {
      const root = { template: 'page-default', path: '_root', content: {}, schema: {}, save: async () => {} }
      useEditorStashStore().stash('_root', root, { title: 'stashed' })
    }
    const persistence = useEditorPersistenceStore()
    const { finish, done } = startPendingSave()
    expect(persistence.saving).toBe(true)

    await useEditorActions().openPageRoot()
    expect(persistence.saving).toBe(true)

    finish()
    await done
    expect(persistence.saving).toBe(false)
  })
})
