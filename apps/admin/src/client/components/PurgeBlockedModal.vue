<!--
  PurgeBlockedModal — surfaces the 409 DELETE_BLOCKED resolution UI
  per design-soft-delete.md Q4 H1 lock.

  When the author tries to permanently delete an archive that has
  alias-pointers (other archives whose aliasOf points here) or live
  refs (live pages/fragments referencing this name), the modal lists
  each blocker with action menus.

  Cut 12 MVP scope (per implementation grilling Q2 B1 + Q3 C1):
    - Alias-pointers: "Drop alias" (PATCH alias to null) + "Restore"
      (unarchive entirely)
    - Live refs: "Jump to ref" (navigate to the page/fragment)
    - Re-target picker + cascade purge: deferred to a follow-up
      (need a picker for target name; cascade needs nested confirm)

  After each blocker resolution, the store auto-retries the purge —
  if all blockers cleared, the modal closes and the item is purged;
  otherwise the modal updates with the remaining blockers.
-->
<script setup lang="ts">
import { computed } from 'vue'
import { useRouter } from 'vue-router'
import Dialog from 'primevue/dialog'
import Button from 'primevue/button'
import { useArchiveStore } from '../stores/archive.js'

const archive = useArchiveStore()
const router = useRouter()

const isOpen = computed(() => archive.dialogVariant === 'purge-blocked')
const item = computed(() => archive.item)
const aliases = computed(() => archive.blockedAliases)
const liveRefs = computed(() => archive.blockedLiveRefs)

async function onDropAlias(target: { kind: 'page' | 'fragment'; name: string }) {
  await archive.setAlias(target, null)
}

async function onRestore(target: { kind: 'page' | 'fragment'; name: string }) {
  await archive.restoreBlocker(target)
}

function onJumpToRef(target: { kind: 'page' | 'fragment'; name: string }) {
  // Navigate to the editor for the live ref-holder so the author can
  // edit the ref out of its manifest. Closing the modal here is
  // deliberate — the author needs the editor surface to resolve.
  archive.close()
  const prefix = target.kind === 'page' ? '/pages' : '/fragments'
  router.push(`${prefix}/${target.name}`)
}

function onCancel() {
  archive.close()
}

async function onForcePurge() {
  if (!confirm('Force-purge bypasses the alias and ref checks. Aliases will dangle and refs will break. Continue?')) {
    return
  }
  await archive.confirmPurge({ force: true })
}
</script>

<template>
  <Dialog
    :visible="isOpen"
    @update:visible="onCancel"
    modal
    :header="`Can't delete ${item?.kind ?? ''} ${item?.name ? `&quot;${item.name}&quot;` : ''}`"
    :style="{ width: '36rem' }"
  >
    <div class="purge-blocked-content" data-testid="purge-blocked-modal">
      <p class="purge-blocked-explainer">
        Some other items still point at this {{ item?.kind }}. Resolve each one and try again,
        or force-delete to bypass the checks (aliases will dangle, refs will break).
      </p>

      <!-- Alias-pointers — archives whose aliasOf points at this item. -->
      <section v-if="aliases.length > 0" class="purge-blocked-section">
        <h4>
          <i class="pi pi-link" />
          {{ aliases.length }} archive{{ aliases.length === 1 ? '' : 's' }} redirect{{ aliases.length === 1 ? 's' : '' }} here
        </h4>
        <ul class="purge-blocked-list">
          <li v-for="ref in aliases" :key="`alias-${ref.kind}-${ref.name}`" class="purge-blocked-row" :data-testid="`purge-blocked-alias-${ref.name}`">
            <span class="purge-blocked-name">
              <i :class="ref.kind === 'page' ? 'pi pi-file' : 'pi pi-share-alt'" />
              {{ ref.kind }} <code>{{ ref.name }}</code>
            </span>
            <div class="purge-blocked-actions">
              <Button
                label="Drop alias"
                size="small"
                severity="secondary"
                text
                :data-testid="`purge-blocked-drop-${ref.name}`"
                title="Strip the aliasOf field; archive remains as pure soft-delete"
                @click="onDropAlias(ref)"
              />
              <Button
                v-if="!ref.redirect"
                label="Restore"
                size="small"
                severity="secondary"
                text
                :data-testid="`purge-blocked-restore-${ref.name}`"
                title="Unarchive the archive — bring it back to live state"
                @click="onRestore(ref)"
              />
            </div>
          </li>
        </ul>
      </section>

      <!-- Live refs — live pages/fragments that reference this name. -->
      <section v-if="liveRefs.length > 0" class="purge-blocked-section">
        <h4>
          <i class="pi pi-bookmark" />
          {{ liveRefs.length }} live {{ liveRefs.length === 1 ? 'item references' : 'items reference' }} this
        </h4>
        <ul class="purge-blocked-list">
          <li v-for="ref in liveRefs" :key="`liveref-${ref.kind}-${ref.name}`" class="purge-blocked-row" :data-testid="`purge-blocked-liveref-${ref.name}`">
            <span class="purge-blocked-name">
              <i :class="ref.kind === 'page' ? 'pi pi-file' : 'pi pi-share-alt'" />
              {{ ref.kind }} <code>{{ ref.name }}</code>
            </span>
            <div class="purge-blocked-actions">
              <Button
                label="Open"
                size="small"
                severity="secondary"
                text
                icon="pi pi-arrow-right"
                :data-testid="`purge-blocked-jump-${ref.name}`"
                title="Navigate to this item to edit its references"
                @click="onJumpToRef(ref)"
              />
            </div>
          </li>
        </ul>
      </section>

      <p v-if="archive.errorMessage" class="purge-blocked-error">{{ archive.errorMessage }}</p>
    </div>

    <template #footer>
      <Button label="Cancel" severity="secondary" text data-testid="purge-blocked-cancel" @click="onCancel" />
      <Button
        label="Force delete"
        icon="pi pi-exclamation-triangle"
        severity="danger"
        outlined
        data-testid="purge-blocked-force"
        @click="onForcePurge"
      />
    </template>
  </Dialog>
</template>

<style scoped>
.purge-blocked-content { display: flex; flex-direction: column; gap: 1rem; }
.purge-blocked-explainer { font-size: 0.875rem; color: var(--color-muted); margin: 0; }

.purge-blocked-section {
  border: 1px solid var(--color-border);
  border-radius: 4px;
  padding: 0.75rem;
}
.purge-blocked-section h4 {
  margin: 0 0 0.5rem;
  font-size: 0.8125rem;
  color: var(--color-fg);
  display: flex;
  align-items: center;
  gap: 0.375rem;
  font-weight: 600;
}
.purge-blocked-section h4 i { color: var(--color-muted); }

.purge-blocked-list { margin: 0; padding: 0; list-style: none; }
.purge-blocked-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 0.5rem;
  padding: 0.375rem 0;
  border-top: 1px solid var(--color-border);
}
.purge-blocked-row:first-child { border-top: none; }

.purge-blocked-name { display: flex; align-items: center; gap: 0.375rem; font-size: 0.8125rem; color: var(--color-fg); flex: 1; min-width: 0; }
.purge-blocked-name i { color: var(--color-muted); flex-shrink: 0; }
.purge-blocked-name code {
  font-family: var(--font-mono);
  background: var(--color-hover-bg);
  padding: 0 0.25rem;
  border-radius: 2px;
}

.purge-blocked-actions { display: flex; gap: 0.25rem; flex-shrink: 0; }

.purge-blocked-error { color: var(--color-danger-fg); font-size: 0.875rem; margin: 0; }
</style>
