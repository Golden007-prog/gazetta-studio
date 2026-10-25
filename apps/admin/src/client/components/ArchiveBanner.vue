<!--
  ArchiveBanner — visible above the editor when the current item is
  archived. Per `design-soft-delete.md` Q7 J1 + Cut 10 grilling Q7:
  read-only banner with action buttons (Restore, Edit alias, Delete
  permanently). The editor below is read-only.

  The banner is the author's surface for managing an archived item:
    - Restore: one-click unarchive (no confirmation modal)
    - Edit alias: opens ArchiveModal pre-loaded with currentAliasOf
    - Delete permanently: opens purge-confirm modal

  Krug-aligned: absence-as-state — banner is hidden when the item is
  live (no "this is live" banner; the empty state IS the message).
-->
<script setup lang="ts">
import { computed } from 'vue'
import Button from 'primevue/button'
import { useArchiveStore } from '../stores/archive.js'
import { useSiteStore } from '../stores/site.js'

const props = defineProps<{
  kind: 'page' | 'fragment'
  name: string
}>()

const archive = useArchiveStore()
const site = useSiteStore()

/**
 * Read archived state directly from the site store summary. Cut 7
 * extended PageSummary + FragmentSummary with the field; the SPA's
 * site store carries it through.
 */
const summary = computed(() => {
  const list = props.kind === 'page' ? site.pages : site.fragments
  return list.find(it => it.name === props.name)
})

const isArchived = computed(() => summary.value?.archived === true)
const aliasOf = computed(() => summary.value?.aliasOf)
// A Manual Redirect archive (alias + no template) has no content to
// restore — restoring would strip its manifest to `{}` (#1343), so the
// backend refuses and the button is hidden.
const isRedirect = computed(() => isArchived.value && !!aliasOf.value && !summary.value?.template)

async function onRestore() {
  const ok = await archive.unarchive({
    kind: props.kind,
    name: props.name,
    archived: true,
    currentAliasOf: aliasOf.value,
  })
  if (ok) await site.load()
}

function onEditAlias() {
  archive.askArchive({
    kind: props.kind,
    name: props.name,
    archived: true,
    currentAliasOf: aliasOf.value,
  })
}

function onPurge() {
  archive.askPurge({
    kind: props.kind,
    name: props.name,
    archived: true,
    currentAliasOf: aliasOf.value,
  })
}
</script>

<template>
  <div v-if="isArchived" class="archive-banner" role="alert" :data-testid="`archive-banner-${kind}-${name}`">
    <div class="archive-banner-message">
      <i class="pi pi-archive archive-banner-icon" />
      <div class="archive-banner-text">
        <strong>Archived.</strong>
        <span v-if="aliasOf">
          Redirects to <code>{{ aliasOf }}</code> (301).
        </span>
        <span v-else>
          Pure soft-delete — old URL returns 410 Gone.
        </span>
      </div>
    </div>
    <div class="archive-banner-actions">
      <Button
        v-if="!isRedirect"
        label="Restore"
        icon="pi pi-undo"
        size="small"
        severity="secondary"
        :loading="archive.status === 'unarchiving'"
        :data-testid="`archive-restore-${kind}-${name}`"
        @click="onRestore"
      />
      <Button
        label="Edit alias"
        icon="pi pi-pencil"
        size="small"
        text
        :data-testid="`archive-edit-alias-${kind}-${name}`"
        @click="onEditAlias"
      />
      <Button
        label="Delete permanently"
        icon="pi pi-trash"
        size="small"
        text
        severity="danger"
        :data-testid="`archive-purge-${kind}-${name}`"
        @click="onPurge"
      />
    </div>
  </div>
</template>

<style scoped>
.archive-banner {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 1rem;
  background: var(--color-warning-bg);
  border: 1px solid var(--color-warning-fg);
  border-radius: 4px;
  padding: 0.625rem 0.875rem;
  margin: 0.5rem 0;
}
.archive-banner-message {
  display: flex;
  align-items: center;
  gap: 0.625rem;
  flex: 1;
  min-width: 0;
}
.archive-banner-icon {
  color: var(--color-warning-fg);
  font-size: 1.125rem;
  flex-shrink: 0;
}
.archive-banner-text {
  font-size: 0.875rem;
  color: var(--color-fg);
}
.archive-banner-text strong {
  color: var(--color-warning-fg);
}
.archive-banner-text code {
  font-family: var(--font-mono);
  background: var(--color-hover-bg);
  padding: 0 0.25rem;
  border-radius: 2px;
}
.archive-banner-actions {
  display: flex;
  gap: 0.375rem;
  flex-shrink: 0;
}
</style>
