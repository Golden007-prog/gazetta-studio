<script setup lang="ts">
import { computed } from 'vue'
import { useSelectionStore } from '../stores/selection.js'
import { useSiteStore } from '../stores/site.js'
import { useEditingStore } from '../stores/editing.js'
import { hasNoindex, type MetadataTextField } from '../stores/editorMetadata.js'
import { useArchiveStore } from '../stores/archive.js'

const selection = useSelectionStore()
const site = useSiteStore()
const editing = useEditingStore()
const archive = useArchiveStore()

const TITLE_MAX = 60
const DESC_MAX = 160

// The fields read and write the editor's pending metadata, so the
// editor's one Save writes them and the unsaved-changes guard sees them.
function field(name: MetadataTextField) {
  return computed({
    get: () => {
      const value = editing.metadataValue[name]
      return typeof value === 'string' ? value : ''
    },
    set: (value: string) => editing.editMetadata(name, value),
  })
}
const title = field('title')
const description = field('description')
const ogImage = field('ogImage')
const canonical = field('canonical')
const noindex = computed({
  get: () => hasNoindex(editing.metadataValue.robots),
  set: (on: boolean) => editing.setMetadataNoindex(on),
})

function charClass(current: number, max: number): string {
  if (current === 0) return 'ok'
  const ratio = current / max
  if (ratio >= 1) return 'over'
  if (ratio >= 0.9) return 'warn'
  return 'ok'
}

const pageDetail = computed(() =>
  selection.type === 'page' ? (selection.detail as import('../api/client.js').PageDetail | null) : null,
)
const siteName = computed(() => site.manifest?.name)

// Fallback values — what the renderer will use when fields are empty.
// Shown as placeholders and in the SERP preview.
const fallbackTitle = computed(() => {
  const contentTitle = pageDetail.value?.content?.title as string | undefined
  if (contentTitle) return siteName.value ? `${contentTitle} — ${siteName.value}` : contentTitle
  return selection.name || ''
})
const fallbackDescription = computed(() => (pageDetail.value?.content?.description as string) || '')
const fallbackCanonical = computed(() => `${pageDetail.value?.route ?? '/'}`)

// SERP preview uses explicit value when set, fallback when empty —
// same chain as the renderer (seo.ts).
const serpTitle = computed(() => title.value || fallbackTitle.value)
const serpUrl = computed(() => canonical.value || `https://example.com${fallbackCanonical.value}`)
const serpDescription = computed(() => description.value || fallbackDescription.value)

// Archive surface — visible only when the page is currently live. The
// ArchiveBanner takes over for archived pages (Restore / Edit alias /
// Purge actions live there). One affordance per state, per Krug.
const isArchived = computed(() => {
  if (selection.type !== 'page' || !selection.name) return false
  return site.pages.find(p => p.name === selection.name)?.archived === true
})

function onArchive() {
  if (selection.type !== 'page' || !selection.name) return
  archive.askArchive({
    kind: 'page',
    name: selection.name,
    archived: false,
  })
}
</script>

<template>
  <div class="metadata-editor" data-testid="metadata-editor">
    <div class="meta-header">
      <h3>SEO</h3>
      <div class="meta-header-actions">
        <button
          v-if="!isArchived"
          class="meta-archive-btn"
          @click="onArchive"
          data-testid="page-archive-btn"
          title="Archive this page (soft-delete)">
          <i class="pi pi-archive" /> Archive
        </button>
      </div>
    </div>

    <div class="meta-fields">
        <div class="field">
          <label for="meta-title">Title</label>
          <input id="meta-title" v-model="title"
            :placeholder="fallbackTitle ? `${fallbackTitle} (auto)` : 'Page title for search engines'"
            data-testid="meta-title" />
          <span v-if="title" :class="['char-count', charClass(title.length, TITLE_MAX)]">{{ title.length }}/{{ TITLE_MAX }}</span>
        </div>

        <div class="field">
          <label for="meta-description">Description</label>
          <textarea id="meta-description" v-model="description"
            :placeholder="fallbackDescription ? `${fallbackDescription} (auto)` : 'Brief description for search results'"
            rows="2" data-testid="meta-description" />
          <span v-if="description" :class="['char-count', charClass(description.length, DESC_MAX)]">{{ description.length }}/{{ DESC_MAX }}</span>
        </div>

        <div class="field">
          <label for="meta-og-image">OG Image URL</label>
          <input id="meta-og-image" v-model="ogImage" placeholder="https://example.com/image.jpg"
            data-testid="meta-og-image" />
        </div>

        <div class="field">
          <label for="meta-canonical">Canonical URL</label>
          <input id="meta-canonical" v-model="canonical"
            :placeholder="`Leave empty — auto-generated from route (${fallbackCanonical})`"
            data-testid="meta-canonical" />
        </div>

        <div class="field field-checkbox">
          <label class="checkbox-label">
            <input type="checkbox" v-model="noindex" data-testid="meta-noindex" />
            <span>Hide from search engines</span>
          </label>
          <span class="checkbox-hint">Adds <code>noindex</code> robots directive. Page won't appear in sitemap.</span>
        </div>
      </div>

      <!-- SERP preview — always light-themed to match Google's appearance -->
      <div :class="['serp-preview', { 'serp-noindex': noindex }]" data-testid="serp-preview">
        <div v-if="noindex" class="serp-noindex-badge">
          <i class="pi pi-eye-slash" aria-hidden="true" /> noindex — hidden from search engines
        </div>
        <div class="serp-card">
          <div class="serp-url">{{ serpUrl }}</div>
          <div class="serp-title">{{ serpTitle.slice(0, 70) }}{{ serpTitle.length > 70 ? '…' : '' }}</div>
          <div class="serp-desc">{{ serpDescription.slice(0, 170) }}{{ serpDescription.length > 170 ? '…' : '' }}</div>
        </div>
    </div>
  </div>
</template>

<style scoped>
.metadata-editor {
  border-top: 1px solid var(--color-border);
  padding-top: 0.75rem;
  margin-top: 1rem;
}
.meta-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 0.75rem;
}
.meta-header h3 {
  font-size: 0.75rem;
  text-transform: uppercase;
  color: var(--color-muted);
  letter-spacing: 0.05em;
  margin: 0;
}
.meta-header-actions {
  display: flex;
  gap: 0.375rem;
}
.meta-archive-btn {
  font-size: 0.6875rem;
  padding: 0.1875rem 0.5rem;
  border: 1px solid var(--color-border);
  border-radius: var(--p-border-radius-sm);
  background: transparent;
  color: var(--color-muted);
  cursor: pointer;
  display: inline-flex;
  align-items: center;
  gap: 0.25rem;
}
.meta-archive-btn:hover {
  color: var(--color-warning-fg);
  border-color: var(--color-warning-fg);
}
.meta-fields { display: flex; flex-direction: column; gap: 0.625rem; }
.field { display: flex; flex-direction: column; gap: 0.25rem; position: relative; }
.field label {
  font-size: 0.6875rem;
  text-transform: uppercase;
  letter-spacing: 0.04em;
  color: var(--color-muted);
  font-weight: 500;
}
.field input, .field textarea {
  font-size: 0.8125rem;
  padding: 0.375rem 0.5rem;
  border: 1px solid var(--color-input-border);
  border-radius: var(--p-border-radius-sm);
  background: var(--color-input-bg);
  color: var(--color-fg);
  font-family: inherit;
  resize: vertical;
}
.field input::placeholder, .field textarea::placeholder {
  color: var(--color-muted);
  opacity: 0.6;
  font-style: italic;
}
.field input:focus, .field textarea:focus {
  outline: 2px solid var(--p-primary-color);
  outline-offset: -1px;
}
.char-count {
  font-size: 0.625rem;
  align-self: flex-end;
  font-variant-numeric: tabular-nums;
}
.char-count.ok { color: var(--color-muted); }
.char-count.warn { color: var(--color-warning-fg); }
.char-count.over { color: var(--color-danger-fg); font-weight: 600; }
.field-checkbox { flex-direction: row; align-items: flex-start; gap: 0.375rem; }
.checkbox-label {
  display: flex;
  align-items: center;
  gap: 0.375rem;
  font-size: 0.8125rem;
  color: var(--color-fg);
  cursor: pointer;
}
.checkbox-label input[type="checkbox"] { cursor: pointer; }
.checkbox-hint {
  font-size: 0.6875rem;
  color: var(--color-muted);
  margin-left: 1.25rem;
}
.checkbox-hint code {
  font-size: 0.625rem;
  padding: 0.0625rem 0.25rem;
  background: var(--color-hover-bg);
  border-radius: 2px;
}

/* SERP preview — always light-themed regardless of admin dark/light mode */
.serp-preview {
  margin-top: 1rem;
  padding: 0.75rem;
  background: #fff;
  border: 1px solid #dadce0;
  border-radius: 8px;
}
.serp-card { font-family: Arial, sans-serif; }
.serp-url {
  font-size: 0.75rem;
  color: #202124;
  margin-bottom: 0.125rem;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.serp-title {
  font-size: 1.125rem;
  color: #1a0dab;
  line-height: 1.3;
  margin-bottom: 0.25rem;
  cursor: pointer;
}
.serp-title:hover { text-decoration: underline; }
.serp-desc {
  font-size: 0.8125rem;
  color: #4d5156;
  line-height: 1.4;
}
.serp-noindex .serp-card { opacity: 0.4; }
.serp-noindex-badge {
  display: flex;
  align-items: center;
  gap: 0.375rem;
  font-size: 0.6875rem;
  color: #b91c1c;
  font-weight: 500;
  margin-bottom: 0.5rem;
}
</style>
