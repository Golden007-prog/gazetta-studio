<script setup lang="ts">
/**
 * Active target indicator + switcher.
 *
 * Shows the active target's name with environment-based chrome. When 2+
 * targets exist, clicking the pill opens a menu to switch. With only one
 * target or none, the pill hides entirely (progressive disclosure).
 *
 * Environment chrome:
 *   env-local:      neutral
 *   env-staging:    amber
 *   env-production: red
 *
 * Editable vs read-only shows as a sub-badge on the pill.
 */
import { computed, ref } from 'vue'
import { useRouter } from 'vue-router'
import Menu from 'primevue/menu'
import { useActiveTargetStore } from '../stores/activeTarget.js'
import { useEditingStore } from '../stores/editing.js'
import { useUnsavedGuardStore } from '../stores/unsavedGuard.js'
import { useSelectionStore } from '../stores/selection.js'
import { useToastStore } from '../stores/toast.js'
import { groupedEntries } from '../composables/targetGrouping.js'
import { usePagesApi, useFragmentsApi } from '../composables/api.js'
import type { TargetInfo } from '../api/client.js'
import HistoryPanel from './HistoryPanel.vue'
import AuditDrawer from './AuditDrawer.vue'

const pagesApi = usePagesApi()
const fragmentsApi = useFragmentsApi()

const activeTarget = useActiveTargetStore()
const editing = useEditingStore()
const unsavedGuard = useUnsavedGuardStore()
const selection = useSelectionStore()
const toast = useToastStore()
const router = useRouter()
const menu = ref<InstanceType<typeof Menu> | null>(null)

const visible = computed(() => activeTarget.targets.length > 0 && activeTarget.activeTarget !== null)
// The pill is always interactive when there's a target — the menu
// carries both switchTo entries (when 2+ targets) and "View history"
// (always available for the active target).
const interactive = computed(() => activeTarget.targets.length >= 1)

const environmentClass = computed(() => {
  const env = activeTarget.activeTarget?.environment
  if (env === 'production') return 'env-production'
  if (env === 'staging') return 'env-staging'
  return 'env-local'
})

const editableLabel = computed(() => (activeTarget.isActiveEditable ? 'editable' : 'read-only'))

/**
 * Switcher menu items. Flat at ≤3 targets; grouped by environment at
 * 4+ (with single-member groups staying flat) — design-editor-ux.md
 * "Scaling to 4+ targets". PrimeVue Menu renders nested `items` as
 * a section header with child entries, which is close to the design's
 * "sub-menus" rendering.
 */
const menuItems = computed(() => {
  const entries = groupedEntries(activeTarget.targets, activeTarget.targets.length)
  const targetItems = entries.map(entry => {
    if (entry.kind === 'single') return targetItem(entry.target)
    return {
      // PrimeVue Menu renders a label + nested items as a section.
      // Keep the environment name as the header so grouping reads at a glance.
      label: entry.group.environment,
      items: entry.group.members.map(targetItem),
    }
  })
  // History affordance at the bottom — separator + action for the
  // current active target. Users wanting history on another target
  // switch first (keeps this menu focused on "my focus", not per-item).
  return [
    ...targetItems,
    { separator: true },
    {
      label: 'View history',
      icon: 'pi pi-history',
      command: () => {
        showHistory.value = true
      },
    },
    {
      label: 'View audit log',
      icon: 'pi pi-shield',
      command: () => {
        showAudit.value = true
      },
    },
  ]
})

const showHistory = ref(false)
const showAudit = ref(false)

function targetItem(t: TargetInfo) {
  return {
    label: t.name,
    icon: iconFor(t),
    class: t.name === activeTarget.activeTargetName ? 'active' : '',
    command: () => switchTo(t.name),
  }
}

/**
 * Switch active target with two guards:
 *
 * 1. Unsaved edits → show the unsaved-changes dialog (Save / Don't Save
 *    / Cancel), same pattern as the router's route-leave hook. Silent
 *    drops and cross-target saves are both worse than friction here.
 * 2. Focused item missing on destination → drop focus to site root and
 *    surface an info toast with a one-click "back to X on <previous>"
 *    action. Design-editor-ux.md "Switching active target". Keeps
 *    rapid A/B from stranding the author on an empty workspace.
 */
async function switchTo(name: string) {
  if (name === activeTarget.activeTargetName) return
  if (editing.hasPendingEdits) {
    const result = await unsavedGuard.guard()
    if (result === 'cancel') return
    // A failed save keeps the edits and stays on this target.
    if (result === 'save' && !(await editing.save())) return
    editing.clear()
  }
  const prevName = activeTarget.activeTargetName
  const focused = selection.selection
  // Pre-check item availability only when we have something selected —
  // no selection means no focus to preserve, so skip the extra round-trip.
  const missingCheck = focused ? await checkItemOnTarget(name, focused.type, focused.name) : ('ok' as const)
  if (missingCheck === 'missing' && focused && prevName) {
    // Item doesn't exist on the destination — navigate to site root
    // with the new target in the query. The router guard applies it.
    const current = router.currentRoute.value
    router.push({ path: '/', query: { ...current.query, target: name } })
    const itemLabel = focused.type === 'page' ? `pages/${focused.name}` : `@${focused.name}`
    toast.show(`${itemLabel} isn't on ${name} — showing site root`, {
      type: 'info',
      action: {
        label: `back to ${itemLabel} on ${prevName}`,
        handler: async () => {
          const prefix = focused.type === 'page' ? '/pages' : '/fragments'
          const cur = router.currentRoute.value
          router.push({ path: `${prefix}/${focused.name}`, query: { ...cur.query, target: prevName } })
        },
      },
    })
  } else {
    // Item exists — stay on the same page, just switch target via query
    const current = router.currentRoute.value
    router.push({ path: current.path, query: { ...current.query, target: name }, hash: current.hash })
  }
}

/**
 * Check if an item exists on the destination target before switching to it.
 * Returns 'ok' on success, 'missing' if the item isn't there, and 'ok' on
 * any unexpected error (fail open — a false negative would block
 * legitimate switches; the missing-item banner is purely a quality-of-
 * -life nudge, not a correctness gate).
 */
async function checkItemOnTarget(
  target: string,
  type: 'page' | 'fragment',
  itemName: string,
): Promise<'ok' | 'missing'> {
  try {
    if (type === 'page') {
      const list = await pagesApi.getPages({ target })
      return list.some(p => p.name === itemName) ? 'ok' : 'missing'
    } else {
      const list = await fragmentsApi.getFragments({ target })
      return list.some(f => f.name === itemName) ? 'ok' : 'missing'
    }
  } catch {
    return 'ok'
  }
}

function iconFor(t: TargetInfo): string {
  if (t.name === activeTarget.activeTargetName) return 'pi pi-check'
  if (!t.editable) return 'pi pi-lock'
  return 'pi pi-circle'
}

function onClick(event: Event) {
  if (interactive.value) menu.value?.toggle(event)
}
</script>

<template>
  <template v-if="visible">
    <button type="button"
      class="active-target"
      :class="[environmentClass, { interactive }]"
      data-testid="active-target-indicator"
      :title="`Active target: ${activeTarget.activeTargetName} (${editableLabel})${interactive ? ' — click to switch' : ''}`"
      :aria-haspopup="interactive ? 'menu' : undefined"
      :disabled="!interactive"
      @click="onClick">
      <span class="dot" aria-hidden="true" />
      <span class="name">{{ activeTarget.activeTargetName }}</span>
      <span v-if="!activeTarget.isActiveEditable" class="readonly-badge">read-only</span>
      <i v-if="interactive" class="pi pi-chevron-down chevron" aria-hidden="true" />
    </button>
    <Menu v-if="interactive" ref="menu" :model="menuItems" :popup="true"
      data-testid="active-target-menu" />
    <HistoryPanel v-model:visible="showHistory" />
    <AuditDrawer v-model:visible="showAudit" />
  </template>
</template>

<style scoped>
.active-target {
  display: inline-flex;
  align-items: center;
  gap: 0.375rem;
  padding: 0.25rem 0.625rem;
  border-radius: var(--p-border-radius-sm);
  font-size: 0.8125rem;
  font-weight: 500;
  background: var(--color-hover-bg);
  color: var(--color-fg);
  border: 1px solid var(--color-border);
  cursor: default;
  font-family: inherit;
}
.active-target.interactive {
  cursor: pointer;
}
.active-target.interactive:hover {
  filter: brightness(0.96);
}
.active-target.interactive:focus-visible {
  outline: 2px solid var(--p-primary-color);
  outline-offset: 2px;
}
.dot {
  width: 0.5rem;
  height: 0.5rem;
  border-radius: 50%;
  background: currentColor;
  opacity: 0.6;
}
.name {
  letter-spacing: -0.01em;
}
.readonly-badge {
  font-size: 0.6875rem;
  text-transform: uppercase;
  letter-spacing: 0.05em;
  opacity: 0.65;
  padding-left: 0.375rem;
  border-left: 1px solid currentColor;
  margin-left: 0.125rem;
}
.chevron {
  font-size: 0.625rem;
  opacity: 0.6;
  margin-left: 0.125rem;
}

.env-production {
  background: var(--color-env-prod-bg);
  color: var(--color-env-prod-fg);
  border-color: var(--color-env-prod-fg);
}
.env-staging {
  background: var(--color-env-staging-bg);
  color: var(--color-env-staging-fg);
  border-color: var(--color-env-staging-fg);
}
</style>

<style>
/* Highlight the active target in the switcher menu. Non-scoped so PrimeVue's
   generated class hash doesn't block the selector. */
.p-menu .p-menuitem.active > .p-menuitem-content {
  font-weight: 600;
}
.p-menu .p-menuitem.active .p-menuitem-icon {
  color: var(--p-primary-color);
}
</style>
