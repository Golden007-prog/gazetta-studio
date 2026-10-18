<script setup lang="ts">
import { ref, computed } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { onKeyStroke } from '@vueuse/core'
import { useEditingStore } from '../stores/editing.js'
import { useSelectionStore } from '../stores/selection.js'
import { useThemeStore } from '../stores/theme.js'
import { useUnsavedGuardStore } from '../stores/unsavedGuard.js'
import { hashToSelection, fragmentLinkDestinationHash } from '../composables/editorSelection.js'
import { useEditorMount } from '../composables/useEditorMount.js'
import { useActiveEditorMount } from '../composables/useActiveEditorMount.js'
import FragmentBlastRadius from './FragmentBlastRadius.vue'
import PageMetadataEditor from './PageMetadataEditor.vue'
import ValidationBanner from './ValidationBanner.vue'
import ConflictBanner from './ConflictBanner.vue'
import EditorBreadcrumb from './EditorBreadcrumb.vue'
import ArchiveBanner from './ArchiveBanner.vue'
import ArchiveModal from './ArchiveModal.vue'
import PurgeBlockedModal from './PurgeBlockedModal.vue'
import { useLocaleStore } from '../stores/locale.js'
import { manifestPath } from '../stores/editorEtags.js'
import { useConflictDiscard } from '../composables/useConflictDiscard.js'

const editing = useEditingStore()
const selection = useSelectionStore()
// A redirect or pure archive has no template: the archive banner is all there is.
const nothingToEdit = computed(() => !!selection.detail && !selection.detail.template)
const theme = useThemeStore()
const unsavedGuard = useUnsavedGuardStore()
const localeStore = useLocaleStore()
const conflictDiscard = useConflictDiscard()
const route = useRoute()
const router = useRouter()
const containerRef = ref<HTMLElement | null>(null)

async function goToFragment() {
  const fragName = editing.fragmentLink
  if (!fragName) return
  // Derive child path from route hash — the hash already encodes the selection
  // (e.g. #@header/logo → childPath = logo)
  const sel = hashToSelection(route.hash, false)
  const hash = sel?.kind === 'fragmentLink' && sel.childPath ? fragmentLinkDestinationHash(sel) : ''
  if (editing.hasPendingEdits) {
    const result = await unsavedGuard.guard()
    if (result === 'cancel') return
    if (result === 'save') await editing.save()
  }
  editing.clear()
  await router.push({ path: `/fragments/${fragName}/edit`, hash })
}

// Show blast radius when the selected root item is a fragment, regardless
// of which sub-component is currently in the editor. The badge is about
// the fragment's reach, not the current sub-edit.
const fragmentName = computed(() => (selection.type === 'fragment' ? selection.name : null))

const { editorMount: editorMountRef, hasProperties, editorLoading } = useActiveEditorMount()

const contentRef = computed(() => editing.content)
const schemaRef = computed(() => editing.schema as Record<string, unknown> | null)
const themeRef = computed<'dark' | 'light'>(() => (theme.dark ? 'dark' : 'light'))
const mountVersionRef = computed(() => editing.mountVersion)
const fieldsBaseUrlRef = computed(() => editing.target?.fieldsBaseUrl)

function handleChange(content: Record<string, unknown>) {
  editing.markDirty(content)
}

useEditorMount(
  containerRef,
  editorMountRef,
  contentRef,
  schemaRef,
  themeRef,
  handleChange,
  mountVersionRef,
  fieldsBaseUrlRef,
)

// Ctrl+S / Cmd+S to save
onKeyStroke('s', e => {
  if (e.metaKey || e.ctrlKey) {
    e.preventDefault()
    if (editing.dirty) editing.save()
  }
})

// Active manifest path — used by the ConflictBanner. The banner only
// renders when a conflict exists for THIS path, so a conflict on
// `pages/home/page.json` doesn't show while the author is editing
// `pages/about/page.json`. Conflicts persist across navigation per
// design-offline.md Q4.
const activeManifestPath = computed<string | null>(() => {
  if (!selection.selection) return null
  const kind = selection.type === 'page' ? 'page' : 'fragment'
  const locale = localeStore.effectiveLocale ?? undefined
  return manifestPath(kind, selection.selection.name, locale)
})

const showConflictBanner = computed(() => activeManifestPath.value !== null)

/**
 * Author chose "Discard my changes" — delegate to the dedicated
 * conflict-discard composable. The orchestration (clear conflict
 * → drop local pending → reload selection) lives there so the
 * flow is independently testable without mounting the editor's
 * real-DOM machinery.
 */
async function handleConflictDiscard() {
  if (!activeManifestPath.value) return
  await conflictDiscard.run(activeManifestPath.value)
}
</script>

<template>
  <div class="editor-panel" data-testid="editor-panel">
    <ValidationBanner />
    <ConflictBanner
      v-if="showConflictBanner && activeManifestPath"
      :itemPath="activeManifestPath"
      @discard="handleConflictDiscard" />
    <!--
      Archive banner — visible when the selected item is archived.
      Hidden otherwise (Krug "absence-as-state"). Lives at the top of
      the editor panel so it's the first thing the author sees on an
      archived item; the read-only editor below is the second.
    -->
    <ArchiveBanner
      v-if="selection.selection && (selection.type === 'page' || selection.type === 'fragment')"
      :kind="selection.type"
      :name="selection.selection.name" />
    <div v-if="editing.loadError" class="editor-error" data-testid="editor-error">
      <i class="pi pi-exclamation-triangle" />
      <p>{{ editing.loadError }}</p>
    </div>
    <div v-else-if="editing.fragmentLink" class="editor-fragment-link" data-testid="editor-fragment-link">
      <i class="pi pi-share-alt" />
      <p>This is part of a shared fragment.</p>
      <a class="fragment-go-link" data-testid="fragment-go-link" @click.stop.prevent="goToFragment">Edit @{{ editing.fragmentLink }}</a>
    </div>
    <template v-else-if="!editing.path">
      <div v-if="!nothingToEdit" class="editor-empty" data-testid="editor-empty">
        <i class="pi pi-pencil" style="font-size: 2rem; opacity: 0.3; margin-bottom: 0.5rem;" />
        <p>Select a component to edit</p>
      </div>
    </template>
    <div v-else class="editor-active">
      <!-- #82 — breadcrumb shows the user-set component name path
           ("home > features > fast") instead of the template-name
           jargon ("feature-card") that authors don't understand.
           Each non-current segment is clickable to navigate up. -->
      <div class="editor-header">
        <EditorBreadcrumb />
        <FragmentBlastRadius v-if="fragmentName" :fragmentName="fragmentName" />
      </div>
      <!-- The custom editor mounts only once its code has loaded (#912), so
           say so instead of showing an empty pane. -->
      <p v-if="editorLoading" class="editor-loading" role="status" data-testid="editor-loading">
        <i class="pi pi-spin pi-spinner" aria-hidden="true" />
        <span>Loading editor…</span>
      </p>
      <div v-if="hasProperties" ref="containerRef" class="editor-container" data-testid="editor-container" :key="editing.path" />
      <PageMetadataEditor v-if="selection.type === 'page' && editing.path === '_root'" />
      <p v-else-if="!hasProperties" class="editor-no-schema">No editable content. Edit its children instead.</p>
    </div>
    <!--
      ArchiveModal lives at panel scope so it's available from any
      surface that dispatches archive ops (PageMetadataEditor's
      Archive button, ArchiveBanner's "Edit alias" action). The store
      drives visibility — the modal renders its own content based on
      `dialogVariant`.
    -->
    <ArchiveModal />
    <!--
      Cut 12 — surfaces 409 DELETE_BLOCKED with per-blocker resolution
      actions (Drop alias, Restore, Jump to ref). Same store; the
      `dialogVariant` enum extends with `purge-blocked`.
    -->
    <PurgeBlockedModal />
  </div>
</template>

<style scoped>
.editor-header { display: flex; align-items: center; justify-content: space-between; gap: 0.5rem; margin-bottom: 1rem; flex-wrap: wrap; }
.editor-error { color: var(--color-danger-fg); font-size: 0.875rem; display: flex; flex-direction: column; align-items: center; padding-top: 3rem; gap: 0.5rem; text-align: center; }
.editor-error .pi { font-size: 2rem; }
.editor-error p { max-width: 300px; line-height: 1.5; }
.editor-empty { color: var(--color-muted); font-size: 0.875rem; display: flex; flex-direction: column; align-items: center; padding-top: 3rem; }
.editor-fragment-link { color: var(--color-muted); font-size: 0.875rem; display: flex; flex-direction: column; align-items: center; padding-top: 3rem; gap: 0.5rem; }
.editor-fragment-link .pi { font-size: 2rem; opacity: 0.3; }
.fragment-go-link { color: var(--color-primary); cursor: pointer; font-weight: 500; }
.fragment-go-link:hover { text-decoration: underline; }
.editor-container { font-size: 0.875rem; }
.editor-no-schema { color: var(--color-muted); font-size: 0.875rem; }
.editor-loading { display: flex; align-items: center; gap: 0.5rem; color: var(--color-muted); font-size: 0.875rem; }
</style>
