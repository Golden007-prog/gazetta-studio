import { defineStore } from 'pinia'
import { computed } from 'vue'
import { useEditorContentStore } from './editorContent.js'
import { useEditorPersistenceStore } from './editorPersistence.js'
import { useEditorActions } from '../composables/useEditorActions.js'

export type { EditingTarget } from './editorContent.js'

/**
 * Facade store — re-exports state from editorContent, editorPersistence,
 * and editorStash, and delegates actions to useEditorActions.
 *
 * Consumers import this store for backwards compatibility. New code can
 * import the individual stores and composable directly.
 */
export const useEditingStore = defineStore('editing', () => {
  const ec = useEditorContentStore()
  const persistence = useEditorPersistenceStore()
  const actions = useEditorActions()

  return {
    // State from editorContent
    target: computed(() => ec.target),
    content: computed(() => ec.content),
    saved: computed(() => ec.saved),
    template: computed(() => ec.template),
    path: computed(() => ec.path),
    schema: computed(() => ec.schema),
    dirty: computed(() => ec.dirty),
    loadError: computed(() => ec.loadError),
    mountVersion: computed(() => ec.mountVersion),
    customEditorMount: computed(() => ec.customEditorMount),
    fragmentLink: computed(() => ec.fragmentLink),
    // State from editorPersistence
    saving: computed(() => persistence.saving),
    lastSaveError: computed(() => persistence.lastSaveError),
    // Derived state from useEditorActions
    pendingCount: actions.pendingCount,
    hasPendingEdits: actions.hasPendingEdits,
    hasPendingMetadata: actions.hasPendingMetadata,
    metadataValue: actions.metadataValue,
    allOverrides: actions.allOverrides,
    hasPendingEdit: actions.hasPendingEdit,
    // Actions from useEditorActions
    navigate: actions.navigate,
    openComponent: actions.openComponent,
    openPageRoot: actions.openPageRoot,
    openFragment: actions.openFragment,
    showFragmentLink: actions.showFragmentLink,
    clear: actions.clear,
    markDirty: actions.markDirty,
    discard: actions.discard,
    revertStashed: actions.revertStashed,
    revertComponent: actions.revertComponent,
    editMetadata: actions.editMetadata,
    setMetadataNoindex: actions.setMetadataNoindex,
    moveComponentStructural: actions.moveComponentStructural,
    addComponentStructural: actions.addComponentStructural,
    removeComponentStructural: actions.removeComponentStructural,
    clearEditorForRemovedPath: actions.clearEditorForRemovedPath,
    save: actions.save,
    refreshAfterRestore: actions.refreshAfterRestore,
  }
})
