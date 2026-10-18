import { computed } from 'vue'
import { createEditorMount } from 'gazetta/editor'
import type { EditorMount } from 'gazetta/types'
import { useEditorContentStore } from '../stores/editorContent.js'

/** Picks the editor to mount for the open target: its custom editor if it has one, else the default form. */
export function useActiveEditorMount() {
  const ec = useEditorContentStore()

  const hasProperties = computed(() => {
    const s = ec.schema as Record<string, unknown> | null
    if (!s) return false
    const props = s.properties as Record<string, unknown> | undefined
    return !!props && Object.keys(props).length > 0
  })

  const editorMount = computed<EditorMount | null>(() => {
    if (!ec.schema || !hasProperties.value || ec.customEditorLoading) return null
    if (ec.customEditorMount) return ec.customEditorMount
    return createEditorMount(ec.schema)
  })

  /** True while the open target's custom editor is still loading and nothing is mounted yet. */
  const editorLoading = computed(() => hasProperties.value && ec.customEditorLoading)

  return { editorMount, hasProperties, editorLoading }
}
