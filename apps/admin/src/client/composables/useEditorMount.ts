import { watch, onBeforeUnmount, type Ref } from 'vue'
import type { EditorMount } from 'gazetta/types'
import { openAssetPicker } from '../api/openAssetPicker.js'
import { API_BASE } from '../api/_request.js'
import { plainCopy } from '../drafts/types.js'

export function useEditorMount(
  containerRef: Ref<HTMLElement | null>,
  editorMount: Ref<EditorMount | null>,
  content: Ref<Record<string, unknown> | null>,
  schema: Ref<Record<string, unknown> | null>,
  theme: Ref<'dark' | 'light'>,
  onChange: (content: Record<string, unknown>) => void,
  mountVersion?: Ref<number>,
  fieldsBaseUrl?: Ref<string | undefined>,
) {
  // Track the mount instance AND container that's currently live. Critical:
  // when `editorMount` changes (default form → custom editor) the OLD instance
  // still owns the React root on the container. We must call ITS unmount, not
  // the new one's. Otherwise createRoot gets called twice on the same container
  // and React 18 errors → Vite may trigger a page reload → editing state resets.
  let current: { mount: EditorMount; el: HTMLElement } | null = null

  function mountNew() {
    if (!containerRef.value || !editorMount.value || !content.value || !schema.value) return
    if (current) unmountCurrent()
    const m = editorMount.value
    const el = containerRef.value
    m.mount(el, {
      // Plain copies: the store's deep refs give Vue proxies, and the default
      // form (@rjsf/core) structuredClones its data, which a proxy can't survive.
      content: plainCopy(content.value),
      schema: plainCopy(schema.value),
      theme: theme.value,
      onChange,
      fieldsBaseUrl: fieldsBaseUrl?.value,
      onPickAsset: openAssetPicker,
      assetsApiBase: API_BASE,
    })
    current = { mount: m, el }
  }

  function unmountCurrent() {
    if (!current) return
    try {
      current.mount.unmount(current.el)
    } catch {
      /* already unmounted */
    }
    current = null
  }

  // Re-mount when container, editor instance, or mountVersion changes.
  // mountVersion bumps on open/discard — not on every keystroke.
  // Content updates from editing flow through React's internal state via onChange.
  const deps = mountVersion
    ? ([containerRef, editorMount, mountVersion] as const)
    : ([containerRef, editorMount] as const)

  watch(
    deps,
    () => {
      if (containerRef.value && editorMount.value && content.value) mountNew()
      else unmountCurrent()
    },
    { immediate: true },
  )

  onBeforeUnmount(unmountCurrent)
}
