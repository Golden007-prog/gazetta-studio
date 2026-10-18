<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue'
import { useRouter } from 'vue-router'
import Button from 'primevue/button'
import { useSiteStore } from '../stores/site.js'
import { useSelectionStore } from '../stores/selection.js'
import { useEditingStore } from '../stores/editing.js'
import { useToastStore } from '../stores/toast.js'
import { usePublishStatusStore } from '../stores/publishStatus.js'
import { useValidationScannerStore } from '../stores/validationScanner.js'
import { usePagesApi, useFragmentsApi } from '../composables/api.js'
import CreatePageDialog from './CreatePageDialog.vue'
import CreateFragmentDialog from './CreateFragmentDialog.vue'
import CreateRedirectDialog from './CreateRedirectDialog.vue'
import FragmentBlastRadius from './FragmentBlastRadius.vue'

interface SiteNode {
  key: string
  label: string
  type: 'page' | 'fragment'
  name: string
  icon: string
  locales?: string[]
  /**
   * Archived per design-soft-delete.md Q7 J1. When true the row
   * renders greyed; when also `aliasOf` is set the alias suffix
   * appears in italic. Hidden by default; shown when the
   * "Show archived" toggle is enabled.
   */
  archived?: boolean
  aliasOf?: string
}

const router = useRouter()
const site = useSiteStore()
const selection = useSelectionStore()
const editing = useEditingStore()
const toast = useToastStore()
const publishStatus = usePublishStatusStore()
const validationScanner = useValidationScannerStore()
const pagesApi = usePagesApi()
const fragmentsApi = useFragmentsApi()
const selectedKey = ref<string | null>(null)
const showCreatePage = ref(false)
const showCreateFragment = ref(false)
const showCreateRedirect = ref(false)
/**
 * Per `design-soft-delete.md` Q7 J1: tree filter toggle, count badge,
 * hidden when zero. Filter is local UI state (not site state) per
 * Cut 10 grilling Q3 — different authors may want different views.
 */
const showArchived = ref(false)

// Compare against the most-important target so each node can show whether
// it has unpublished changes. Refreshes on mount and on site reload.
onMounted(() => publishStatus.refresh())
watch(
  () => site.pages.length + site.fragments.length,
  () => publishStatus.refresh(),
)

function isDirty(node: SiteNode): boolean {
  if (publishStatus.isFirstPublish) return true
  return node.type === 'page' ? publishStatus.isPageDirty(node.name) : publishStatus.isFragmentDirty(node.name)
}
function dirtyTitle(): string {
  if (!publishStatus.target) return ''
  if (publishStatus.isFirstPublish) return `Not yet published to ${publishStatus.target}`
  return `Has unpublished changes (${publishStatus.target})`
}

/**
 * Map a tree node to the scanner's `itemPath` to look up issue severity.
 * Cut 2 keys off the default-locale manifest path; locale-variant issues
 * surface separately when the editor opens a specific locale.
 */
function nodeItemPath(node: SiteNode): string {
  return node.type === 'page' ? `pages/${node.name}/page.json` : `fragments/${node.name}/fragment.json`
}
function issueSeverity(node: SiteNode): 'error' | 'warn' | 'info' | null {
  return validationScanner.severityFor(nodeItemPath(node))
}
function issueTitle(node: SiteNode): string {
  const path = nodeItemPath(node)
  const issues = validationScanner.issuesFor(path)
  if (issues.length === 0) return ''
  return `${issues.length} validation issue${issues.length === 1 ? '' : 's'} — open Site health for details`
}

// Sync selection when changed externally (e.g. preview link click)
watch(
  () => selection.selection,
  sel => {
    if (sel) selectedKey.value = `${sel.type}:${sel.name}`
    else selectedKey.value = null
  },
  { immediate: true },
)

const systemPageNames = computed(() => new Set(site.manifest?.systemPages ?? []))

/**
 * Pages filtered by the archive toggle. When `showArchived` is false
 * (default), archived items are hidden from the tree entirely. When
 * true, they appear with greyed styling + alias suffix.
 */
const contentPages = computed<SiteNode[]>(() =>
  [...site.pages]
    .filter(p => !systemPageNames.value.has(p.name))
    .filter(p => showArchived.value || p.archived !== true)
    .sort((a, b) => a.route.localeCompare(b.route))
    .map(p => ({
      key: `page:${p.name}`,
      label: p.name,
      type: 'page' as const,
      name: p.name,
      icon: 'pi pi-file',
      locales: p.locales,
      archived: p.archived,
      aliasOf: p.aliasOf,
    })),
)

/** Total archived item count — drives the toggle's "(N)" badge. */
const archivedCount = computed(
  () =>
    site.pages.filter(p => p.archived === true && !systemPageNames.value.has(p.name)).length +
    site.fragments.filter(f => f.archived === true).length,
)

const systemPages = computed<SiteNode[]>(() =>
  [...site.pages]
    .filter(p => systemPageNames.value.has(p.name))
    .sort((a, b) => a.route.localeCompare(b.route))
    .map(p => ({ key: `page:${p.name}`, label: p.name, type: 'page' as const, name: p.name, icon: 'pi pi-file' })),
)

const fragments = computed<SiteNode[]>(() =>
  site.fragments
    .filter(f => showArchived.value || f.archived !== true)
    .map(f => ({
      key: `fragment:${f.name}`,
      label: f.name,
      type: 'fragment' as const,
      name: f.name,
      icon: 'pi pi-share-alt',
      locales: f.locales,
      archived: f.archived,
      aliasOf: f.aliasOf,
    }))
    .sort((a, b) => a.label.localeCompare(b.label)),
)

function onSelect(node: SiteNode) {
  const prefix = node.type === 'page' ? '/pages' : '/fragments'
  router.push(`${prefix}/${node.name}`)
}

async function handleDelete(node: SiteNode, e: Event) {
  e.stopPropagation()
  if (!confirm(`Delete ${node.type} "${node.name}"? This cannot be undone.`)) return
  try {
    if (node.type === 'page') await pagesApi.deletePage(node.name)
    else await fragmentsApi.deleteFragment(node.name)
    const isSelected = selection.type === node.type && selection.name === node.name
    if (isSelected) editing.clear()
    await site.load()
  } catch (err) {
    toast.showError(err, `Failed to delete "${node.name}"`)
  }
}
</script>

<template>
  <div class="site-tree">
    <!--
      Show-archived toggle per design-soft-delete.md Q7 J1.
      Hidden when archivedCount === 0 (Krug "absence-as-state":
      empty filter is no filter; don't show a control with "(0)"
      that has nothing to do).
    -->
    <label v-if="archivedCount > 0" class="archive-toggle" data-testid="archive-toggle">
      <input type="checkbox" v-model="showArchived" data-testid="archive-toggle-input" />
      <span>Show archived ({{ archivedCount }})</span>
    </label>

    <!-- Pages -->
    <div class="section-label">Pages</div>
    <div v-for="node in contentPages" :key="node.key"
      :class="['node-item', { selected: selectedKey === node.key, archived: node.archived }]"
      :data-testid="`site-${node.type}-${node.name}`"
      @click="onSelect(node)">
      <i :class="node.icon" class="node-icon" />
      <span class="node-label">
        {{ node.label }}
        <span v-if="node.archived && node.aliasOf" class="node-alias-suffix">
          → {{ node.aliasOf }}
        </span>
        <span v-else-if="node.archived" class="node-alias-suffix">
          (archived)
        </span>
      </span>
      <span v-if="node.locales?.length" class="node-locales">
        <template v-if="node.locales.length <= 3">
          <span v-for="loc in node.locales" :key="loc" class="locale-badge">{{ loc.toUpperCase() }}</span>
        </template>
        <template v-else>
          <span class="locale-badge">{{ node.locales[0].toUpperCase() }}</span>
          <span class="locale-badge locale-count" :title="node.locales.map(l => l.toUpperCase()).join(', ')">+{{ node.locales.length - 1 }}</span>
        </template>
      </span>
      <span v-if="isDirty(node)" class="node-dirty-dot" :title="dirtyTitle()"
        :data-testid="`dirty-${node.type}-${node.name}`" />
      <span v-if="issueSeverity(node)"
        :class="['node-issue-dot', `node-issue-${issueSeverity(node)}`]"
        :title="issueTitle(node)"
        :data-testid="`issue-${node.type}-${node.name}`" />
      <Button icon="pi pi-trash" text rounded size="small" severity="danger"
        class="node-delete" :data-testid="`delete-${node.type}-${node.name}`"
        :aria-label="`Delete ${node.type} ${node.name}`"
        @click="handleDelete(node, $event)" />
    </div>

    <!-- System pages -->
    <template v-if="systemPages.length">
      <div class="section-divider" />
      <div v-for="node in systemPages" :key="node.key"
        :class="['node-item', { selected: selectedKey === node.key }]"
        :data-testid="`site-${node.type}-${node.name}`"
        @click="onSelect(node)">
        <i :class="node.icon" class="node-icon" />
        <span class="node-label">{{ node.label }}</span>
        <span v-if="isDirty(node)" class="node-dirty-dot" :title="dirtyTitle()"
          :data-testid="`dirty-${node.type}-${node.name}`" />
        <Button icon="pi pi-trash" text rounded size="small" severity="danger"
          class="node-delete" :data-testid="`delete-${node.type}-${node.name}`"
          :aria-label="`Delete ${node.type} ${node.name}`"
          @click="handleDelete(node, $event)" />
      </div>
    </template>

    <!-- Fragments -->
    <div class="section-label" style="margin-top: 12px;">Fragments</div>
    <div v-for="node in fragments" :key="node.key"
      :class="['node-item', { selected: selectedKey === node.key, archived: node.archived }]"
      :data-testid="`site-${node.type}-${node.name}`"
      @click="onSelect(node)">
      <i :class="node.icon" class="node-icon" />
      <span class="node-label">
        {{ node.label }}
        <span v-if="node.archived && node.aliasOf" class="node-alias-suffix">
          → @{{ node.aliasOf }}
        </span>
        <span v-else-if="node.archived" class="node-alias-suffix">
          (archived)
        </span>
      </span>
      <FragmentBlastRadius :fragmentName="node.name" compact />
      <span v-if="isDirty(node)" class="node-dirty-dot" :title="dirtyTitle()"
        :data-testid="`dirty-${node.type}-${node.name}`" />
      <span v-if="issueSeverity(node)"
        :class="['node-issue-dot', `node-issue-${issueSeverity(node)}`]"
        :title="issueTitle(node)"
        :data-testid="`issue-${node.type}-${node.name}`" />
      <Button icon="pi pi-trash" text rounded size="small" severity="danger"
        class="node-delete" :data-testid="`delete-${node.type}-${node.name}`"
        :aria-label="`Delete ${node.type} ${node.name}`"
        @click="handleDelete(node, $event)" />
    </div>

    <div class="new-btns">
      <Button icon="pi pi-plus" label="New page" text size="small"
        data-testid="new-page" @click="showCreatePage = true" />
      <Button icon="pi pi-plus" label="New fragment" text size="small"
        data-testid="new-fragment" @click="showCreateFragment = true" />
      <Button icon="pi pi-plus" label="New redirect" text size="small"
        data-testid="sitetree-new-redirect-button" @click="showCreateRedirect = true" />
    </div>
    <CreatePageDialog v-if="showCreatePage" :visible="showCreatePage"
      @close="showCreatePage = false" />
    <CreateFragmentDialog v-if="showCreateFragment" :visible="showCreateFragment"
      @close="showCreateFragment = false" />
    <CreateRedirectDialog v-if="showCreateRedirect" :visible="showCreateRedirect"
      @close="showCreateRedirect = false" />
  </div>
</template>

<style scoped>
.site-tree { font-size: 13px; line-height: 22px; }
/* Color via tokens — `--color-muted` resolves to PrimeVue's
   text-muted-color which auto-flips between light (#64748b) and dark
   (#a1a1aa). Both pass WCAG AA against their respective content
   backgrounds, fixing the color-contrast violations the previous
   hardcoded #9ca3af / #6b7280 produced in dark mode (where the
   `:global(.dark)` overrides lost specificity to the scoped selectors —
   see team-preferences.md rule 12). */
.section-label { font-size: 11px; text-transform: uppercase; letter-spacing: 0.05em; color: var(--color-muted); padding: 4px 8px; font-weight: 600; }
.section-divider { border-top: 1px solid var(--color-border); margin: 4px 8px; }
.node-item { display: flex; align-items: center; gap: 4px; height: 22px; padding: 0 6px; margin: 0 2px; cursor: pointer; border-radius: 3px; }
.node-item:hover { background: var(--color-hover-bg); }
.node-item.selected { background: rgba(167, 139, 250, 0.15); box-shadow: inset 2px 0 0 #a78bfa; }
.node-icon { width: 16px; text-align: center; font-size: 10px; color: var(--color-muted); flex-shrink: 0; opacity: 0.85; }
.node-label { flex: 1; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; color: var(--color-muted); }
.node-item.selected .node-label,
.node-item:hover .node-label { color: var(--color-fg); }
.node-dirty-dot { width: 6px; height: 6px; border-radius: 50%; background: var(--color-warning-fg); flex-shrink: 0; margin-right: 2px; }
.node-issue-dot { width: 6px; height: 6px; border-radius: 50%; flex-shrink: 0; margin-right: 2px; }
.node-issue-error { background: var(--p-red-500); }
.node-issue-warn { background: var(--p-amber-500); }
.node-issue-info { background: var(--p-blue-500); }
.node-delete { opacity: 0; transition: opacity 0.1s; flex-shrink: 0; }
.node-item:hover .node-delete { opacity: 1; }
.new-btns { display: flex; flex-wrap: wrap; gap: 0.25rem 0.5rem; margin-top: 8px; padding: 0 6px; }
/* Wrap whole buttons onto the next row instead of shrinking them, which
   broke labels mid-word and squashed the icons in a narrow sidebar. */
.new-btns .p-button { flex-shrink: 0; white-space: nowrap; }
.node-locales { display: flex; gap: 2px; margin-left: auto; flex-shrink: 0; }
.locale-badge { font-size: 0.5rem; font-weight: 700; letter-spacing: 0.05em; color: var(--color-muted); border: 1px solid var(--color-border); border-radius: 2px; padding: 0 3px; line-height: 1.4; }

/* Archived row — greyed; alias suffix italic */
.node-item.archived .node-label { opacity: 0.6; }
.node-alias-suffix { font-style: italic; font-size: 0.6875rem; color: var(--color-muted); margin-left: 0.25rem; }

/* Show-archived toggle */
.archive-toggle { display: flex; align-items: center; gap: 0.375rem; padding: 0.25rem 0.5rem; margin: 0.25rem 0.125rem; font-size: 0.75rem; color: var(--color-muted); cursor: pointer; user-select: none; }
.archive-toggle:hover { color: var(--color-fg); }
.archive-toggle input { cursor: pointer; }
</style>
