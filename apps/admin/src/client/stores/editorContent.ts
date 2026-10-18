function deepClone<T>(obj: T): T {
  return JSON.parse(JSON.stringify(obj))
}

import { defineStore } from 'pinia'
import { ref, computed } from 'vue'
import type { EditorMount } from 'gazetta/types'

export interface EditingTarget {
  template: string
  path: string
  content: Record<string, unknown>
  schema: Record<string, unknown>
  hasEditor?: boolean
  editorUrl?: string
  fieldsBaseUrl?: string
  save: (content: Record<string, unknown>) => Promise<void>
}

/**
 * Current edit lifecycle — tracks what is being edited right now.
 *
 * Pure state. No store dependencies. Side-effect-free except for the
 * custom editor dynamic import in open() (unavoidable — the editor
 * module must be loaded before the form can mount).
 */
export const useEditorContentStore = defineStore('editorContent', () => {
  const target = ref<EditingTarget | null>(null)
  const content = ref<Record<string, unknown> | null>(null)
  const saved = ref<Record<string, unknown> | null>(null)
  const savedJson = ref('')
  const loadError = ref<string | null>(null)
  const mountVersion = ref(0)
  const customEditorMount = ref<EditorMount | null>(null)
  /** True while a custom editor import is pending — nothing may mount until it settles. */
  const customEditorLoading = ref(false)
  const fragmentLink = ref<string | null>(null)
  /**
   * Generation counter — incremented on every open() and on clear() / setLoadError() /
   * showFragmentLink(), so a custom-editor import whose target is gone is discarded.
   */
  let openGeneration = 0

  const template = computed(() => target.value?.template ?? null)
  const path = computed(() => target.value?.path ?? null)
  const schema = computed(() => target.value?.schema ?? null)
  const dirty = computed(() => {
    if (!content.value || !savedJson.value) return false
    return JSON.stringify(content.value) !== savedJson.value
  })

  /**
   * Initialize the editor with a target. Clones content and saved baseline,
   * loads custom editor if available, and bumps mountVersion to trigger
   * React remount.
   */
  async function open(t: EditingTarget, editedContent?: Record<string, unknown>) {
    const gen = ++openGeneration
    loadError.value = null
    fragmentLink.value = null

    target.value = t
    content.value = editedContent ? deepClone(editedContent) : deepClone(t.content)
    saved.value = deepClone(t.content)
    savedJson.value = JSON.stringify(t.content)
    customEditorMount.value = null
    customEditorLoading.value = !!(t.hasEditor && t.editorUrl)

    if (t.hasEditor && t.editorUrl) {
      try {
        const mod = await import(/* @vite-ignore */ t.editorUrl)
        // Discard if a newer open() started, or the target was cleared, while the import was pending
        if (gen !== openGeneration) return
        customEditorMount.value = (mod.default ?? mod) as EditorMount
      } catch (err) {
        if (gen !== openGeneration) return
        console.warn(`Custom editor for "${t.template}" failed to load:`, err)
      }
    }

    if (gen !== openGeneration) return
    customEditorLoading.value = false
    mountVersion.value++
  }

  function markDirty(newContent: Record<string, unknown>) {
    content.value = newContent
  }

  /**
   * After a successful save: what was written becomes the saved baseline.
   * Content typed while the save ran differs from it, so it stays dirty.
   */
  function markSaved(written: Record<string, unknown>) {
    saved.value = deepClone(written)
    savedJson.value = JSON.stringify(written)
  }

  function discard() {
    if (!target.value || !saved.value) return
    content.value = deepClone(saved.value)
    mountVersion.value++
  }

  /** Discards any pending custom-editor import and the custom-editor state of the target being left. */
  function abandonPendingOpen() {
    openGeneration++
    customEditorMount.value = null
    customEditorLoading.value = false
  }

  function setLoadError(message: string) {
    abandonPendingOpen()
    target.value = null
    loadError.value = message
  }

  function showFragmentLink(nameOrPath: string) {
    abandonPendingOpen()
    loadError.value = null
    target.value = null
    content.value = null
    saved.value = null
    savedJson.value = ''
    fragmentLink.value = nameOrPath.startsWith('@') ? nameOrPath.split('/')[0].slice(1) : nameOrPath
  }

  function clear() {
    abandonPendingOpen()
    loadError.value = null
    fragmentLink.value = null

    target.value = null
    content.value = null
    saved.value = null
    savedJson.value = ''
  }

  return {
    target,
    content,
    saved,
    dirty,
    loadError,
    mountVersion,
    customEditorMount,
    customEditorLoading,
    fragmentLink,
    template,
    path,
    schema,
    open,
    markDirty,
    markSaved,
    discard,
    setLoadError,
    showFragmentLink,
    clear,
  }
})
