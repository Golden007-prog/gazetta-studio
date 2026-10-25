<script setup lang="ts">
import { ref, computed } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import Toolbar from 'primevue/toolbar'
import Button from 'primevue/button'
import { useSiteStore } from '../stores/site.js'
import { useSelectionStore } from '../stores/selection.js'
import { useEditingStore } from '../stores/editing.js'
import { useThemeStore } from '../stores/theme.js'
import { useUiModeStore } from '../stores/uiMode.js'
import { useActiveTargetStore } from '../stores/activeTarget.js'
import { useValidationScannerStore } from '../stores/validationScanner.js'
import { saveButtonLabel, saveButtonSeverity } from '../composables/saveButtonBinding.js'
import PublishPanel from './PublishPanel.vue'
import ActiveTargetIndicator from './ActiveTargetIndicator.vue'
import SyncIndicators from './SyncIndicators.vue'
import LocalePicker from './LocalePicker.vue'
import SiteHealthDrawer from './SiteHealthDrawer.vue'

const route = useRoute()
const router = useRouter()
const isDevPage = computed(() => route.name === 'dev')

const site = useSiteStore()
const selection = useSelectionStore()
const editing = useEditingStore()
const theme = useThemeStore()
const uiMode = useUiModeStore()
const activeTarget = useActiveTargetStore()
const validationScanner = useValidationScannerStore()

const showPublish = ref(false)
const showSiteHealth = ref(false)
const healthBadgeSeverity = computed(() => {
  if (validationScanner.itemsWithErrors.size > 0) return 'danger'
  if (validationScanner.itemsWithWarnings.size > 0) return 'warn'
  return 'info'
})
const healthIconClass = computed(() => {
  if (validationScanner.itemsWithErrors.size > 0) return 'pi pi-exclamation-circle'
  if (validationScanner.itemsWithWarnings.size > 0) return 'pi pi-exclamation-triangle'
  return 'pi pi-shield'
})
const healthTitle = computed(() => {
  const total = validationScanner.total
  if (total === 0) return 'Site health — no issues'
  return `Site health — ${total} issue${total === 1 ? '' : 's'}`
})
/** Destination to preselect in the panel (set by sync chip clicks). */
const publishInitialDestination = ref<string | undefined>(undefined)

function openPublishFor(name: string) {
  publishInitialDestination.value = name
  showPublish.value = true
}

function openPublish() {
  publishInitialDestination.value = undefined
  showPublish.value = true
}

// Publish is a cross-target operation — gated only on unsaved edits so we
// never publish stale data.
const canPublish = computed(() => !editing.hasPendingEdits)

// design-editor-ux.md "Progressive disclosure": 1 target configured means no
// publish UI, Save is all — a one-target site has nowhere to publish to
// (#1285). Sync chips and the target switcher already derive from non-active
// targets, so they disappear on their own; this button needs the same gate.
const hasPublishDestination = computed(() => activeTarget.targets.length > 1)

// Disabled buttons need to explain themselves — silent click-with-nothing-happens
// confuses users and is the most common UX gripe with the toolbar.
const saveTitle = computed(() => {
  if (editing.saving) return 'Saving…'
  if (!editing.hasPendingEdits) return 'No unsaved changes'
  return 'Save changes (⌘S)'
})
const publishTitle = computed(() => {
  if (editing.hasPendingEdits) return 'Save changes before publishing'
  return 'Publish'
})

// Save button label + severity reflect the active target when it's an
// editable production target — every save click lands on live content.
// Delegated to saveButtonBinding.ts so the logic is unit-testable
// without mounting the component.
const saveLabel = computed(() => saveButtonLabel(activeTarget.activeTarget))
const saveSeverity = computed(() => saveButtonSeverity(activeTarget.activeTarget))

function handleBack() {
  const prefix = selection.type === 'page' ? '/pages' : '/fragments'
  router.push(`${prefix}/${selection.name}`)
}
</script>

<template>
  <Toolbar class="cms-toolbar">
    <template #start>
      <Button v-if="uiMode.mode === 'edit' && !isDevPage" icon="pi pi-arrow-left" text rounded
        title="Back to browse" aria-label="Back to browse"
        data-testid="back-to-browse" @click="handleBack" size="small" class="cms-btn" />
      <Button v-if="isDevPage" icon="pi pi-arrow-left" text rounded
        title="Back to editor" aria-label="Back to editor"
        data-testid="back-to-editor" @click="router.back()" size="small" class="cms-btn" />
      <span class="cms-logo">
        <i class="pi pi-objects-column" />
        Gazetta
      </span>
      <span v-if="site.manifest" class="cms-site-name">{{ site.manifest.name }}</span>
      <ActiveTargetIndicator />
      <LocalePicker />
      <SyncIndicators @select="openPublishFor" />
    </template>
    <template #center>
      <Transition name="fade">
        <span v-if="editing.lastSaveError" class="cms-toast cms-toast-error">
          <i class="pi pi-exclamation-circle" /> {{ editing.lastSaveError }}
        </span>
      </Transition>
    </template>
    <template #end>
      <Button v-if="!isDevPage" icon="pi pi-code" text rounded title="Dev Playground"
        data-testid="dev-playground-link" @click="router.push('/dev')" size="small" class="cms-btn" />
      <Button :icon="theme.dark ? 'pi pi-sun' : 'pi pi-moon'" text rounded
        :title="theme.dark ? 'Switch to light mode' : 'Switch to dark mode'"
        :aria-label="theme.dark ? 'Switch to light mode' : 'Switch to dark mode'"
        data-testid="theme-toggle" @click="theme.toggle()" size="small" class="cms-btn" />
      <Button v-if="validationScanner.total > 0"
        :icon="healthIconClass" text rounded
        :title="healthTitle" :aria-label="healthTitle"
        :severity="healthBadgeSeverity"
        data-testid="site-health-btn" @click="showSiteHealth = true" size="small"
        :badge="String(validationScanner.total)"
        class="cms-btn" />
      <Button v-if="uiMode.mode === 'edit'" :label="saveLabel" icon="pi pi-save" :severity="saveSeverity" :loading="editing.saving"
        data-testid="save-btn" :title="saveTitle" :disabled="!editing.hasPendingEdits" @click="editing.save()" size="small" class="cms-btn" />
      <Button v-if="hasPublishDestination" label="Publish" icon="pi pi-cloud-upload" severity="success"
        data-testid="publish-btn" :title="publishTitle" :disabled="!canPublish" @click="openPublish" size="small" class="cms-btn" />
    </template>
  </Toolbar>

  <PublishPanel v-model:visible="showPublish" :initialDestination="publishInitialDestination" />
  <SiteHealthDrawer v-model:visible="showSiteHealth" />
</template>

<style scoped>
.cms-toolbar { border-radius: 0; border-left: 0; border-right: 0; border-top: 0; }
.cms-logo { font-weight: 700; font-size: 1.125rem; display: flex; align-items: center; gap: 0.5rem; }
.cms-site-name { margin-left: 1rem; margin-right: 1rem; color: var(--color-muted); font-size: 0.875rem; }
.cms-btn { margin-left: 0.5rem; }
.cms-toast { font-size: 0.8125rem; display: flex; align-items: center; gap: 0.375rem; }
.cms-toast-error { color: var(--color-danger-fg); }
.fade-enter-active, .fade-leave-active { transition: opacity 0.2s; }
.fade-enter-from, .fade-leave-to { opacity: 0; }
</style>
