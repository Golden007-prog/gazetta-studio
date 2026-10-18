import { defineStore } from 'pinia'
import { ref } from 'vue'
import type { EditingTarget } from './editorContent.js'
import type { StashedEdit } from './editorStash.js'
import { ValidationFailedError } from '../api/client.js'

export interface SaveResult {
  success: boolean
  error?: string
  /**
   * Set when the server returned 409 VALIDATION_FAILED. Carries structured
   * issues for the banner UI; the route handler in useEditorActions reads
   * this to populate the `validationIssues` store rather than firing a
   * generic error toast.
   */
  validationError?: ValidationFailedError
}

/**
 * One pending write of one manifest field — a page's or fragment's component
 * list, or a page's metadata. The caller (useEditorActions) closes over the
 * key and pending value and supplies the closure here so persistence stays
 * HTTP-agnostic.
 */
export interface ManifestWrite {
  /** Diagnostic label for error messages. */
  label: string
  write(): Promise<void>
}

/**
 * Save orchestration — persists the current edit, all stashed edits, and any
 * pending manifest writes by calling each one's save function in turn.
 *
 * Pure orchestration — no side effects (no toasts, no preview invalidation).
 * The caller decides what to do with the result.
 */
export const useEditorPersistenceStore = defineStore('editorPersistence', () => {
  const saving = ref(false)
  const lastSaveError = ref<string | null>(null)

  /**
   * Persist the current edit, all stashed edits, and all manifest writes.
   *
   * Calls writers sequentially in the order: current content edit, stashed
   * content edits, manifest writes in the order given. Returns success/error.
   * On success, the caller clears what was written and updates the saved
   * baseline.
   */
  async function save(
    current: { target: EditingTarget; content: Record<string, unknown> } | null,
    stashedEdits: StashedEdit[],
    manifestWrites: ManifestWrite[] = [],
  ): Promise<SaveResult> {
    if (!current && stashedEdits.length === 0 && manifestWrites.length === 0) {
      return { success: true }
    }
    saving.value = true
    lastSaveError.value = null
    try {
      if (current) await current.target.save(current.content)
      for (const entry of stashedEdits) await entry.target.save(entry.editedContent)
      for (const write of manifestWrites) await write.write()
      return { success: true }
    } catch (err) {
      const message = (err as Error).message
      lastSaveError.value = message
      if (err instanceof ValidationFailedError) {
        return { success: false, error: message, validationError: err }
      }
      return { success: false, error: message }
    } finally {
      saving.value = false
    }
  }

  return { saving, lastSaveError, save }
})
