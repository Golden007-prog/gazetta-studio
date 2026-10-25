<!--
  ArchivedNameConflictPrompt — three-option resolution form for the
  archived-name-conflict UX (design-soft-delete.md Q5 I3).

  Designed to morph in place inside the existing CreatePageDialog /
  CreateFragmentDialog body — the parent dialog's <Dialog> chrome
  stays, the body content swaps to this component when the create
  POST returns 409 ArchivedNameConflictError.

  Per Q5 I3 lock:
    - Default = Restore (most common author intent)
    - Three options: Restore / Replace / Move-aside
    - Cancel returns to the previous form

  Per Cut 11 grilling Q6 (F1): radio + explanation per option, default
  Restore. Krug-aligned: each option has a one-line explanation so
  authors don't need to read docs.
-->
<script setup lang="ts">
import { ref, computed } from 'vue'
import Button from 'primevue/button'
import RadioButton from 'primevue/radiobutton'
import type { ArchivedNameConflictDetails } from '../api/client.js'

const props = defineProps<{
  archive: ArchivedNameConflictDetails
  busy?: boolean
}>()

const emit = defineEmits<{
  (e: 'resolve', mode: 'restore' | 'replace' | 'moveAside'): void
  (e: 'cancel'): void
}>()

// Default Restore per Q5 I3 lock — the most common intent (author
// forgot the content was already there).
// A Manual Redirect archive has no content to restore (#1343) — the
// backend refuses restore, so the option is hidden and Replace is the
// default.
const choice = ref<'restore' | 'replace' | 'moveAside'>(props.archive.redirect ? 'replace' : 'restore')

const archivedAtFormatted = computed(() => {
  if (!props.archive.archivedAt) return null
  return new Date(props.archive.archivedAt).toLocaleString()
})
</script>

<template>
  <div class="conflict-prompt" data-testid="archived-name-conflict-prompt">
    <div class="conflict-header">
      <i class="pi pi-archive conflict-icon" />
      <div class="conflict-title">
        <strong>Name in use by an archive</strong>
        <p class="conflict-detail">
          A {{ archive.kind }} named <code>{{ archive.name }}</code> was archived
          <span v-if="archivedAtFormatted">on {{ archivedAtFormatted }}</span>
          <span v-if="archive.archivedBy"> by {{ archive.archivedBy }}</span>.
          <span v-if="archive.aliasOf">
            It currently redirects to <code>{{ archive.aliasOf }}</code>.
          </span>
        </p>
      </div>
    </div>

    <div class="conflict-options">
      <label v-if="!archive.redirect" class="conflict-option" :data-testid="`conflict-option-restore`">
        <RadioButton v-model="choice" inputId="conflict-restore" value="restore" />
        <div class="conflict-option-content">
          <strong>Restore the archive</strong>
          <span>Bring the existing {{ archive.kind }} back to live state. Skip creation.</span>
        </div>
      </label>
      <label class="conflict-option" :data-testid="`conflict-option-replace`">
        <RadioButton v-model="choice" inputId="conflict-replace" value="replace" />
        <div class="conflict-option-content">
          <strong>Replace</strong>
          <span>
            Permanently delete the archive and create new {{ archive.kind }} content.
            Aliases pointing at the archive will be retargeted to the new {{ archive.kind }}.
          </span>
        </div>
      </label>
      <label class="conflict-option" :data-testid="`conflict-option-moveAside`">
        <RadioButton v-model="choice" inputId="conflict-moveAside" value="moveAside" />
        <div class="conflict-option-content">
          <strong>Move aside</strong>
          <span>
            Rename the archive to <code>{{ archive.name }}-archived-&lt;date&gt;</code>
            and create new {{ archive.kind }} content under the original name.
          </span>
        </div>
      </label>
    </div>

    <div class="conflict-actions">
      <Button label="Cancel" severity="secondary" text :disabled="busy" data-testid="conflict-cancel" @click="emit('cancel')" />
      <Button
        label="Continue"
        :loading="busy"
        :data-testid="`conflict-continue-${choice}`"
        @click="emit('resolve', choice)"
      />
    </div>
  </div>
</template>

<style scoped>
.conflict-prompt { display: flex; flex-direction: column; gap: 1rem; }

.conflict-header { display: flex; gap: 0.625rem; align-items: flex-start; }
.conflict-icon { color: var(--color-warning-fg); font-size: 1.25rem; flex-shrink: 0; margin-top: 0.125rem; }
.conflict-title { flex: 1; min-width: 0; }
.conflict-title strong { font-size: 0.9375rem; color: var(--color-fg); }
.conflict-detail { margin: 0.25rem 0 0; font-size: 0.8125rem; color: var(--color-muted); line-height: 1.4; }
.conflict-detail code {
  font-family: var(--font-mono);
  background: var(--color-hover-bg);
  padding: 0 0.25rem;
  border-radius: 2px;
  color: var(--color-fg);
}

.conflict-options { display: flex; flex-direction: column; gap: 0.5rem; }
.conflict-option {
  display: flex;
  gap: 0.625rem;
  padding: 0.625rem;
  border: 1px solid var(--color-border);
  border-radius: 4px;
  cursor: pointer;
  align-items: flex-start;
}
.conflict-option:hover { border-color: var(--color-fg); background: var(--color-hover-bg); }
.conflict-option-content { display: flex; flex-direction: column; gap: 0.125rem; flex: 1; }
.conflict-option-content strong { font-size: 0.8125rem; color: var(--color-fg); }
.conflict-option-content span { font-size: 0.75rem; color: var(--color-muted); line-height: 1.4; }
.conflict-option-content code {
  font-family: var(--font-mono);
  background: var(--color-hover-bg);
  padding: 0 0.25rem;
  border-radius: 2px;
  font-size: 0.6875rem;
}

.conflict-actions { display: flex; justify-content: flex-end; gap: 0.5rem; }
</style>
