import React from 'react'
import { createRoot, type Root } from 'react-dom/client'
import Form, { getDefaultRegistry } from '@rjsf/core'
import validator from '@rjsf/validator-ajv8'
import { AssetEmbeddedWidget } from './AssetEmbeddedWidget.js'
import { AssetEmbeddedField } from './AssetEmbeddedField.js'
import { DragDropContext, Droppable, Draggable, type DropResult } from '@hello-pangea/dnd'
import { reorderAtPath } from './reorder-at-path.js'
import { useEditor, EditorContent } from '@tiptap/react'
import { BubbleMenu } from '@tiptap/react/menus'
import StarterKit from '@tiptap/starter-kit'
import Placeholder from '@tiptap/extension-placeholder'
import type { EditorMount } from '../types.js'
import type { IChangeEvent } from '@rjsf/core'
import type {
  WidgetProps,
  ArrayFieldTemplateProps,
  ArrayFieldItemTemplateProps,
  ArrayFieldItemButtonsTemplateProps,
  ObjectFieldTemplateProps,
  IconButtonProps,
} from '@rjsf/utils'

/** Form context passed to all templates and widgets */
interface GzFormContext {
  /** Move an item of the array at `path` (rjsf's `fieldPathId.path`). */
  reorderArray: (path: readonly (string | number)[], fromIndex: number, toIndex: number) => void
  /** Base URL for loading custom field modules (e.g. /admin/@fs/path/to/fields) */
  fieldsBaseUrl?: string
  /** Base URL of the admin API (e.g. `/admin/api`) for asset summary fetches */
  assetsApiBase?: string
  /** Current theme — passed to custom field widgets */
  theme?: 'dark' | 'light'
  /**
   * Asset picker callback. When a schema declares an `embeddedAsset()`
   * field and the author clicks "Change", the widget calls this function
   * and awaits the result. The admin wires its own picker implementation
   * (Vue-rendered modal, backed by the Pinia store); this keeps the
   * editor package decoupled from admin internals.
   *
   * Returns `{ _asset: name }` on confirm, `null` on cancel.
   */
  onPickAsset?: (options: { accept?: string[]; currentAssetName?: string | null }) => Promise<{ _asset: string } | null>
}

const roots = new WeakMap<HTMLElement, Root>()

// ---------------------------------------------------------------------------
// Styles
// ---------------------------------------------------------------------------

const STYLES = `
/* Theme — consumes --color-* tokens from the admin's tokens.css. */
/* Base */
.gz-editor {
  font-family: system-ui, -apple-system, sans-serif; font-size: 0.875rem;
  color: var(--color-fg);
  transition: color 0.2s, background-color 0.2s;
}
.gz-editor * { box-sizing: border-box; }
.gz-editor .form-group { margin-bottom: 1rem; }
.gz-editor label {
  display: block; font-weight: 600; font-size: 0.6875rem; text-transform: uppercase;
  letter-spacing: 0.05em; color: var(--color-muted); margin-bottom: 0.375rem;
}
.gz-editor .field-description { font-size: 0.75rem; color: var(--color-muted); margin-bottom: 0.375rem; line-height: 1.4; }

/* Inputs */
.gz-editor input[type="text"], .gz-editor input[type="number"], .gz-editor input[type="url"],
.gz-editor input[type="email"], .gz-editor input[type="password"],
.gz-editor textarea, .gz-editor select {
  width: 100%; padding: 0.5rem 0.75rem; font-size: 0.875rem; font-family: inherit;
  background: var(--color-input-bg); color: var(--color-fg); border: 1px solid var(--color-border); border-radius: 6px;
  outline: none; transition: border-color 0.15s, box-shadow 0.15s, background-color 0.2s, color 0.2s;
}
.gz-editor input:focus, .gz-editor textarea:focus, .gz-editor select:focus {
  border-color: var(--color-primary); box-shadow: 0 0 0 2px color-mix(in srgb, var(--color-primary) 15%, transparent);
}
.gz-editor textarea { min-height: 5rem; resize: vertical; line-height: 1.5; }
.gz-editor select {
  appearance: none; cursor: pointer;
  background-image: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='12' height='12' viewBox='0 0 12 12'%3E%3Cpath fill='%23666' d='M6 8L1 3h10z'/%3E%3C/svg%3E");
  background-repeat: no-repeat; background-position: right 0.75rem center; padding-right: 2rem;
}

/* Hide rjsf chrome */
.gz-editor .btn { display: none; }
.gz-editor fieldset { border: none; padding: 0; margin: 0; }
.gz-editor legend { display: none; }

/* Errors */
.gz-editor .error-detail, .gz-editor .text-danger { color: var(--color-danger-fg); font-size: 0.75rem; margin-top: 0.25rem; }
.gz-editor .has-error input, .gz-editor .has-error textarea, .gz-editor .has-error select { border-color: color-mix(in srgb, var(--color-danger-fg) 50%, transparent); }

/* Required marker */
.gz-editor label .required { color: var(--color-danger-fg); margin-left: 0.125rem; }

/* ---- Toggle ---- */
.gz-editor .gz-toggle { display: flex; align-items: center; gap: 0.625rem; cursor: pointer; user-select: none; padding: 0.25rem 0; }
.gz-editor .gz-toggle-track {
  position: relative; width: 36px; height: 20px; border-radius: 10px;
  background: var(--color-border); transition: background 0.2s; flex-shrink: 0;
}
.gz-editor .gz-toggle-track.on { background: var(--color-primary); }
.gz-editor .gz-toggle-thumb {
  position: absolute; top: 2px; left: 2px; width: 16px; height: 16px; border-radius: 50%;
  background: #fff; transition: transform 0.2s ease;
}
.gz-editor .gz-toggle-track.on .gz-toggle-thumb { transform: translateX(16px); }
.gz-editor .gz-toggle-label { font-size: 0.8125rem; color: var(--color-fg); font-weight: 400; text-transform: none; letter-spacing: 0; }

/* ---- Color ---- */
.gz-editor .gz-color-widget { display: flex; align-items: center; gap: 0.5rem; }
.gz-editor .gz-color-widget input[type="color"] {
  width: 36px; height: 36px; border: 1px solid var(--color-border); border-radius: 6px;
  padding: 2px; cursor: pointer; background: transparent;
}
.gz-editor .gz-color-widget input[type="color"]::-webkit-color-swatch-wrapper { padding: 2px; }
.gz-editor .gz-color-widget input[type="color"]::-webkit-color-swatch { border-radius: 3px; border: none; }
.gz-editor .gz-color-widget input[type="text"] { flex: 1; }

/* ---- Tags ---- */
.gz-editor .gz-tags {
  display: flex; flex-wrap: wrap; gap: 0.375rem; padding: 0.375rem 0.5rem;
  background: var(--color-input-bg); border: 1px solid var(--color-border); border-radius: 6px;
  min-height: 2.5rem; align-items: center; cursor: text; transition: border-color 0.15s, box-shadow 0.15s;
}
.gz-editor .gz-tags:focus-within { border-color: var(--color-primary); box-shadow: 0 0 0 2px color-mix(in srgb, var(--color-primary) 15%, transparent); }
.gz-editor .gz-tag {
  display: inline-flex; align-items: center; gap: 0.25rem;
  padding: 0.1875rem 0.5rem 0.1875rem 0.625rem;
  background: var(--color-bg-chip); border: 1px solid var(--color-border); border-radius: 4px;
  font-size: 0.8125rem; color: var(--color-fg); transition: background 0.1s;
}
.gz-editor .gz-tag:hover { background: var(--color-bg-chip); filter: brightness(1.1); }
.gz-editor .gz-tag-remove {
  background: none; border: none; color: var(--color-muted); cursor: pointer; font-size: 1rem;
  padding: 0; line-height: 1; display: flex; align-items: center;
}
.gz-editor .gz-tag-remove:hover { color: var(--color-danger-fg); }
.gz-editor .gz-tags-input {
  border: none !important; background: transparent !important; color: var(--color-fg); font-size: 0.8125rem;
  outline: none !important; min-width: 80px; flex: 1; padding: 0.125rem 0;
  box-shadow: none !important;
}
.gz-editor .gz-tags-empty { color: var(--color-muted); font-size: 0.75rem; padding: 0.25rem 0; }

/* ---- Image ---- */
.gz-editor .gz-image-preview {
  margin-top: 0.5rem; border-radius: 6px; overflow: hidden;
  background: var(--color-input-bg); border: 1px dashed var(--color-border); transition: border-color 0.15s;
}
.gz-editor .gz-image-preview.has-image { border-style: solid; }
.gz-editor .gz-image-preview img { display: block; max-width: 100%; max-height: 200px; object-fit: contain; margin: 0 auto; }
.gz-editor .gz-image-preview-empty {
  padding: 2rem; text-align: center; color: var(--color-muted); font-size: 0.75rem;
}

/* ---- Asset widget (embeddedAsset schema fields) ---- */
.gz-editor .gz-asset-widget {
  display: grid; grid-template-columns: 120px 1fr; gap: 0.75rem; align-items: start;
  padding: 0.5rem; border: 1px solid var(--color-border); border-radius: 6px; background: var(--color-input-bg);
}
.gz-editor .gz-asset-widget-preview {
  aspect-ratio: 1 / 1; border-radius: 4px; overflow: hidden;
  background: color-mix(in srgb, var(--color-muted) 10%, transparent);
  display: flex; align-items: center; justify-content: center;
}
.gz-editor .gz-asset-widget-preview img { width: 100%; height: 100%; object-fit: cover; }
.gz-editor .gz-asset-widget-empty { color: var(--color-muted); font-size: 0.6875rem; text-align: center; padding: 0.5rem; }
.gz-editor .gz-asset-widget-error { color: var(--color-danger-fg, #c04040); font-size: 0.6875rem; text-align: center; padding: 0.5rem; }
.gz-editor .gz-asset-widget-body { display: flex; flex-direction: column; justify-content: space-between; gap: 0.5rem; min-height: 100%; }
.gz-editor .gz-asset-widget-name { font-family: ui-monospace, monospace; font-size: 0.8125rem; word-break: break-word; }
.gz-editor .gz-asset-widget-pick {
  align-self: flex-start; padding: 0.375rem 0.75rem; font-size: 0.8125rem;
  background: var(--color-primary); color: white; border: none; border-radius: 4px; cursor: pointer;
}
.gz-editor .gz-asset-widget-pick:hover { opacity: 0.9; }

/* ---- Slug ---- */
.gz-editor .gz-slug-widget input {
  font-family: 'JetBrains Mono', 'Fira Code', monospace; font-size: 0.8125rem; letter-spacing: 0.02em;
}
.gz-editor .gz-slug-hint { font-size: 0.6875rem; color: var(--color-muted); margin-top: 0.25rem; }

/* ---- Code ---- */
.gz-editor .gz-code-widget textarea {
  font-family: 'JetBrains Mono', 'Fira Code', monospace; font-size: 0.8125rem;
  line-height: 1.6; min-height: 10rem; tab-size: 2;
}
.gz-editor .gz-code-hint { font-size: 0.6875rem; color: var(--color-muted); margin-top: 0.25rem; }

/* ---- JSON ---- */
.gz-editor .gz-json-widget textarea {
  font-family: 'JetBrains Mono', 'Fira Code', monospace; font-size: 0.8125rem;
  line-height: 1.6; min-height: 8rem; tab-size: 2;
}
.gz-editor .gz-json-error { font-size: 0.6875rem; color: var(--color-danger-fg); margin-top: 0.25rem; }
.gz-editor .gz-json-valid { font-size: 0.6875rem; color: var(--color-success-fg); margin-top: 0.25rem; }

/* ---- Markdown ---- */
.gz-editor .gz-markdown textarea {
  min-height: 12rem; font-family: 'JetBrains Mono', 'Fira Code', monospace;
  font-size: 0.8125rem; line-height: 1.6;
}
.gz-editor .gz-markdown-hint { font-size: 0.6875rem; color: var(--color-muted); margin-top: 0.25rem; }

/* ---- Rich text (Tiptap) ---- */
.gz-editor .gz-richtext {
  border: 1px solid var(--color-border); border-radius: 6px; overflow: hidden;
  background: var(--color-input-bg); transition: border-color 0.15s, box-shadow 0.15s;
}
.gz-editor .gz-richtext:focus-within { border-color: var(--color-primary); box-shadow: 0 0 0 2px color-mix(in srgb, var(--color-primary) 15%, transparent); }
.gz-editor .gz-richtext-toolbar {
  display: flex; flex-wrap: wrap; gap: 1px; padding: 0.25rem;
  border-bottom: 1px solid var(--color-border); background: var(--color-bg);
}
.gz-editor .gz-rt-btn {
  background: none; border: 1px solid transparent; border-radius: 4px;
  color: var(--color-muted); cursor: pointer; padding: 0.3125rem 0.5rem; font-size: 0.6875rem;
  font-family: inherit; line-height: 1; font-weight: 600; transition: all 0.1s;
  display: flex; align-items: center; justify-content: center; min-width: 28px;
}
.gz-editor .gz-rt-btn:hover { color: var(--color-fg); background: var(--color-bg-chip); }
.gz-editor .gz-rt-btn.active { color: var(--color-primary); background: var(--color-bg-chip); border-color: color-mix(in srgb, var(--color-primary) 20%, transparent); }
.gz-editor .gz-rt-sep { width: 1px; background: var(--color-bg-chip); margin: 0.125rem 0.25rem; align-self: stretch; }

/* Tiptap content area */
.gz-editor .gz-richtext .tiptap { outline: none; padding: 0.75rem; min-height: 10rem; color: var(--color-fg); font-size: 0.875rem; line-height: 1.7; }
.gz-editor .gz-richtext .tiptap p { margin: 0.25rem 0; }
.gz-editor .gz-richtext .tiptap h2 { font-size: 1.25rem; font-weight: 700; margin: 1rem 0 0.25rem; color: var(--color-fg); }
.gz-editor .gz-richtext .tiptap h3 { font-size: 1.1rem; font-weight: 600; margin: 0.75rem 0 0.25rem; color: var(--color-fg); }
.gz-editor .gz-richtext .tiptap ul, .gz-editor .gz-richtext .tiptap ol { padding-left: 1.25rem; margin: 0.25rem 0; }
.gz-editor .gz-richtext .tiptap li { margin: 0.125rem 0; }
.gz-editor .gz-richtext .tiptap blockquote {
  border-left: 3px solid color-mix(in srgb, var(--color-primary) 25%, transparent); padding-left: 0.875rem; margin: 0.5rem 0;
  color: var(--color-muted); font-style: italic;
}
.gz-editor .gz-richtext .tiptap code {
  background: var(--color-bg-chip); padding: 0.125rem 0.375rem; border-radius: 3px;
  font-family: 'JetBrains Mono', 'Fira Code', monospace; font-size: 0.8125rem;
}
.gz-editor .gz-richtext .tiptap pre {
  background: var(--color-bg-code); padding: 0.875rem; border-radius: 6px; overflow-x: auto; margin: 0.5rem 0;
}
.gz-editor .gz-richtext .tiptap pre code { background: none; padding: 0; }
.gz-editor .gz-richtext .tiptap a { color: var(--color-primary); text-decoration: underline; cursor: pointer; }
.gz-editor .gz-richtext .tiptap hr { border: none; border-top: 1px solid var(--color-border); margin: 1rem 0; }
.gz-editor .gz-richtext .tiptap p.is-editor-empty:first-child::before {
  content: attr(data-placeholder); float: left; color: var(--color-muted); pointer-events: none; height: 0;
}

/* Bubble menu */
.gz-editor .gz-bubble {
  display: flex; gap: 1px; background: var(--color-bg); border: 1px solid var(--color-border);
  border-radius: 6px; padding: 0.1875rem; box-shadow: 0 4px 16px #0008;
}
.gz-editor .gz-bubble .gz-rt-btn { padding: 0.25rem 0.4375rem; font-size: 0.625rem; }

/* ---- Array ---- */
.gz-editor .gz-array { margin-bottom: 0.25rem; }
.gz-editor .gz-array-header {
  display: flex; align-items: center; gap: 0.5rem; margin-bottom: 0.5rem; padding-bottom: 0.375rem;
  border-bottom: 1px solid var(--color-border);
}
.gz-editor .gz-array-title {
  font-size: 0.6875rem; font-weight: 600; text-transform: uppercase;
  letter-spacing: 0.05em; color: var(--color-muted);
}
.gz-editor .gz-array-count {
  font-size: 0.625rem; color: var(--color-muted); background: var(--color-border);
  padding: 0.0625rem 0.4375rem; border-radius: 8px; font-weight: 600;
}
.gz-editor .gz-array-add {
  margin-left: auto; background: none; border: 1px solid color-mix(in srgb, var(--color-primary) 20%, transparent);
  color: var(--color-primary); cursor: pointer; font-size: 0.6875rem; font-weight: 600;
  padding: 0.25rem 0.625rem; border-radius: 4px; transition: all 0.15s;
}
.gz-editor .gz-array-add:hover { background: color-mix(in srgb, var(--color-primary) 8%, transparent); border-color: color-mix(in srgb, var(--color-primary) 30%, transparent); }
.gz-editor .gz-array-items { display: flex; flex-direction: column; gap: 0.25rem; }

/* Array items — collapsible */
.gz-editor .gz-array-item {
  background: var(--color-bg); border-radius: 6px; border: 1px solid var(--color-border);
  transition: border-color 0.15s;
}
.gz-editor .gz-array-item:hover { border-color: var(--color-border); }
.gz-editor .gz-array-item.dragging { opacity: 0.9; box-shadow: 0 4px 20px #0006; border-color: color-mix(in srgb, var(--color-primary) 25%, transparent); }
.gz-editor .gz-array-item-header {
  display: flex; align-items: center; gap: 0.375rem; padding: 0.5rem 0.625rem;
  cursor: pointer; user-select: none; min-height: 36px;
}
.gz-editor .gz-array-item-handle {
  color: var(--color-muted); font-size: 0.625rem; cursor: grab; flex-shrink: 0; padding: 0.25rem 0.125rem;
  opacity: 0; transition: opacity 0.1s; display: flex; align-items: center; letter-spacing: 1px;
}
.gz-editor .gz-array-item:hover .gz-array-item-handle { opacity: 1; }
.gz-editor .gz-array-item-handle:active { cursor: grabbing; color: var(--color-primary); }
.gz-editor .gz-array-item-chevron {
  color: var(--color-muted); font-size: 0.5rem; transition: transform 0.15s ease; flex-shrink: 0; width: 12px; text-align: center;
}
.gz-editor .gz-array-item-chevron.open { transform: rotate(90deg); }
.gz-editor .gz-array-item-summary {
  flex: 1; font-size: 0.8125rem; color: var(--color-muted); white-space: nowrap;
  overflow: hidden; text-overflow: ellipsis; min-width: 0;
}
.gz-editor .gz-array-item-summary.empty { color: var(--color-muted); font-style: italic; }
.gz-editor .gz-array-item-idx {
  font-size: 0.625rem; color: var(--color-muted); font-weight: 600; flex-shrink: 0;
  min-width: 1rem; text-align: center;
}
.gz-editor .gz-array-item-actions { display: flex; gap: 1px; flex-shrink: 0; opacity: 0; transition: opacity 0.1s; }
.gz-editor .gz-array-item:hover .gz-array-item-actions { opacity: 1; }
.gz-editor .gz-array-item-body {
  padding: 0 0.75rem 0.75rem; overflow: hidden;
  transition: max-height 0.2s ease, opacity 0.15s ease, padding 0.2s ease;
}
.gz-editor .gz-array-item-body.collapsed { max-height: 0; opacity: 0; padding-top: 0; padding-bottom: 0; }
.gz-editor .gz-array-item-body.expanded { max-height: 2000px; opacity: 1; }
.gz-editor .gz-array-item-body .form-group:last-child { margin-bottom: 0; }
.gz-editor .gz-array-item-body fieldset > .form-group:last-child { margin-bottom: 0; }

/* Icon buttons */
.gz-editor .gz-btn-icon {
  width: 24px; height: 24px; display: flex; align-items: center; justify-content: center;
  background: transparent; border: none; border-radius: 3px; color: var(--color-muted); cursor: pointer;
  font-size: 0.6875rem; padding: 0; transition: all 0.1s;
}
.gz-editor .gz-btn-icon:hover { background: var(--color-bg-chip); color: var(--color-fg); }
.gz-editor .gz-btn-icon:disabled { opacity: 0.25; cursor: default; }
.gz-editor .gz-btn-icon:disabled:hover { background: transparent; color: var(--color-muted); }
.gz-editor .gz-btn-icon.gz-btn-remove:hover { background: color-mix(in srgb, var(--color-danger-fg) 15%, transparent); color: var(--color-danger-fg); }

/* Array empty state */
.gz-editor .gz-array-empty {
  padding: 1.5rem; text-align: center; border: 1px dashed var(--color-border); border-radius: 6px;
  color: var(--color-muted); font-size: 0.8125rem;
}

/* Nested objects in arrays */
.gz-editor .gz-object-inline { }
.gz-editor .gz-object-inline > .form-group { margin-bottom: 0.625rem; }
`

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const LONG_TEXT_NAMES = new Set([
  'body',
  'description',
  'text',
  'content',
  'bio',
  'summary',
  'message',
  'notes',
  'output',
])
const URL_NAMES = new Set(['href', 'url', 'link', 'src'])
const COLOR_NAMES = new Set(['background', 'color'])

type JsonSchema = Record<string, unknown>

function buildUiSchema(jsonSchema: JsonSchema): Record<string, unknown> {
  const ui: Record<string, unknown> = { 'ui:submitButtonOptions': { norender: true } }
  const properties = jsonSchema.properties as Record<string, JsonSchema> | undefined
  if (!properties) return ui

  for (const [name, prop] of Object.entries(properties)) {
    const format = prop.format as string | undefined
    const type = prop.type as string | undefined
    const customField = prop.field as string | undefined
    const assetOptions = prop.assetOptions as Record<string, unknown> | undefined

    // Asset fields — detected by the `assetOptions` metadata that
    // `embeddedAsset()` attaches via Zod `.meta()`. Rendered with the
    // asset widget (invokes the picker via formContext.onPickAsset).
    if (assetOptions) {
      ui[name] = { 'ui:field': 'embedded-asset' }
      continue
    }

    // Custom field — highest priority after asset fields
    if (customField) {
      ui[name] = { 'ui:widget': `custom-field:${customField}` }
      continue
    }

    if (
      format === 'markdown' ||
      format === 'richtext' ||
      format === 'image' ||
      format === 'link' ||
      format === 'slug' ||
      format === 'code' ||
      format === 'json'
    ) {
      ui[name] = { 'ui:widget': format }
      continue
    }
    if (format === 'color') {
      ui[name] = { 'ui:widget': 'color' }
      continue
    }

    if (type === 'string' && !format) {
      if (LONG_TEXT_NAMES.has(name)) {
        ui[name] = { 'ui:widget': 'textarea', 'ui:options': { rows: 5 } }
      } else if (URL_NAMES.has(name)) {
        ui[name] = { 'ui:options': { inputType: 'url' } }
      } else if (COLOR_NAMES.has(name)) {
        ui[name] = { 'ui:widget': 'color' }
      }
    }

    if (type === 'boolean') {
      ui[name] = { 'ui:widget': 'toggle' }
    }

    if (type === 'array') {
      const items = prop.items as JsonSchema | undefined
      if (items?.type === 'string') {
        ui[name] = { 'ui:widget': 'tags' }
      }
    }
  }

  // Asset fields nested inside objects and arrays need a ui:field entry
  // at their own depth (#1345); merge those into the flat results above.
  for (const [name, prop] of Object.entries(properties)) {
    if (prop.assetOptions) continue // top-level asset handled in the main loop
    const nested = buildNestedAssetUi(prop)
    if (Object.keys(nested).length > 0) {
      ui[name] = { ...((ui[name] as Record<string, unknown> | undefined) ?? {}), ...nested }
    }
  }

  return ui
}

/**
 * Collect `ui:field` entries for asset fields nested inside object
 * properties and array items (#1345). The field's own level is handled
 * by the caller.
 */
function buildNestedAssetUi(prop: JsonSchema): Record<string, unknown> {
  const ui: Record<string, unknown> = {}
  if (prop.type === 'object') {
    const properties = prop.properties as Record<string, JsonSchema> | undefined
    if (!properties) return ui
    for (const [subName, subProp] of Object.entries(properties)) {
      if (subProp.assetOptions) {
        ui[subName] = { 'ui:field': 'embedded-asset' }
        continue
      }
      const sub = buildNestedAssetUi(subProp)
      if (Object.keys(sub).length > 0) ui[subName] = sub
    }
  }
  if (prop.type === 'array') {
    const items = prop.items as JsonSchema | undefined
    if (!items) return ui
    if (items.assetOptions) {
      ui.items = { 'ui:field': 'embedded-asset' }
    } else {
      const sub = buildNestedAssetUi(items)
      if (Object.keys(sub).length > 0) ui.items = sub
    }
  }
  return ui
}

/** Extract a one-line summary from an array item's formData for the collapsed header */
function summarizeItem(data: unknown): string {
  if (!data || typeof data !== 'object') return String(data ?? '')
  const obj = data as Record<string, unknown>
  // Try common field names that make good summaries
  for (const key of ['title', 'name', 'label', 'heading', 'text', 'quote', 'command']) {
    if (typeof obj[key] === 'string' && obj[key]) return obj[key] as string
  }
  // Fall back to first non-empty string value
  for (const val of Object.values(obj)) {
    if (typeof val === 'string' && val.trim()) return val.trim()
  }
  return ''
}

// ---------------------------------------------------------------------------
// Widgets
// ---------------------------------------------------------------------------

/** Test id of a widget's input: `field-root_title-input`. */
const inputTestId = (props: WidgetProps, suffix = 'input') => `field-${props.id}-${suffix}`

function MarkdownWidget(props: WidgetProps) {
  return (
    <div className="gz-markdown">
      <textarea
        value={props.value ?? ''}
        onChange={e => props.onChange(e.target.value)}
        placeholder="Write markdown here..."
        rows={12}
      />
      <div className="gz-markdown-hint">Markdown supported</div>
    </div>
  )
}

function ToggleWidget(props: WidgetProps) {
  const on = !!props.value
  return (
    <div
      className="gz-toggle"
      onClick={() => !props.disabled && !props.readonly && props.onChange(!on)}
      role="switch"
      aria-checked={on}
    >
      <div className={`gz-toggle-track${on ? ' on' : ''}`}>
        <div className="gz-toggle-thumb" />
      </div>
      {props.label && <span className="gz-toggle-label">{props.label}</span>}
    </div>
  )
}

function ColorWidget(props: WidgetProps) {
  const val = props.value ?? ''
  return (
    <div className="gz-color-widget">
      <input
        type="color"
        value={val || '#667eea'}
        onChange={e => props.onChange(e.target.value)}
        data-testid={inputTestId(props)}
      />
      <input
        type="text"
        value={val}
        onChange={e => props.onChange(e.target.value)}
        placeholder="#667eea"
        data-testid={inputTestId(props, 'text-input')}
      />
    </div>
  )
}

function TagsWidget(props: WidgetProps) {
  const tags: string[] = Array.isArray(props.value) ? props.value : []
  const [input, setInput] = React.useState('')
  const inputRef = React.useRef<HTMLInputElement>(null)

  const addTag = (tag: string) => {
    const trimmed = tag.trim()
    if (trimmed && !tags.includes(trimmed)) props.onChange([...tags, trimmed])
    setInput('')
  }

  const removeTag = (index: number) => props.onChange(tags.filter((_, i) => i !== index))

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' || e.key === ',') {
      e.preventDefault()
      addTag(input)
    } else if (e.key === 'Backspace' && !input && tags.length > 0) {
      removeTag(tags.length - 1)
    }
  }

  return (
    <div className="gz-tags" onClick={() => inputRef.current?.focus()}>
      {tags.map((tag, i) => (
        <span key={`${tag}-${i}`} className="gz-tag">
          {tag}
          <button
            type="button"
            className="gz-tag-remove"
            onClick={e => {
              e.stopPropagation()
              removeTag(i)
            }}
            aria-label={`Remove ${tag}`}
          >
            &times;
          </button>
        </span>
      ))}
      <input
        ref={inputRef}
        className="gz-tags-input"
        value={input}
        onChange={e => setInput(e.target.value)}
        onKeyDown={handleKeyDown}
        onBlur={() => {
          if (input) addTag(input)
        }}
        placeholder={tags.length === 0 ? 'Type and press Enter...' : ''}
      />
    </div>
  )
}

function ImageWidget(props: WidgetProps) {
  const url = props.value ?? ''
  const [broken, setBroken] = React.useState(false)

  React.useEffect(() => {
    setBroken(false)
  }, [url])

  return (
    <div>
      <input
        type="text"
        value={url}
        onChange={e => props.onChange(e.target.value)}
        placeholder="https://example.com/image.png"
        data-testid={inputTestId(props)}
      />
      <div className={`gz-image-preview${url && !broken ? ' has-image' : ''}`}>
        {url && !broken ? (
          <img src={url} alt="Preview" onError={() => setBroken(true)} />
        ) : (
          <div className="gz-image-preview-empty">{url ? 'Image failed to load' : 'Paste an image URL above'}</div>
        )}
      </div>
    </div>
  )
}

function LinkWidget(props: WidgetProps) {
  return (
    <input
      type="url"
      value={props.value ?? ''}
      onChange={e => props.onChange(e.target.value)}
      placeholder="https://..."
      data-testid={inputTestId(props)}
    />
  )
}

function SlugWidget(props: WidgetProps) {
  const toSlug = (s: string) =>
    s
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-|-$/g, '')
  return (
    <div className="gz-slug-widget">
      <input
        type="text"
        value={props.value ?? ''}
        onChange={e => props.onChange(toSlug(e.target.value))}
        placeholder="my-page-slug"
        data-testid={inputTestId(props)}
      />
      <div className="gz-slug-hint">URL-safe identifier — lowercase, hyphens only</div>
    </div>
  )
}

function CodeWidget(props: WidgetProps) {
  const language = (props.schema as JsonSchema).language as string | undefined
  return (
    <div className="gz-code-widget">
      <textarea
        value={props.value ?? ''}
        onChange={e => props.onChange(e.target.value)}
        placeholder={props.placeholder}
        rows={15}
        spellCheck={false}
        data-testid={inputTestId(props)}
      />
      {language && <div className="gz-code-hint">{language}</div>}
    </div>
  )
}

function JsonWidget(props: WidgetProps) {
  const [error, setError] = React.useState<string | null>(null)
  const [text, setText] = React.useState(() => {
    if (props.value == null) return ''
    if (typeof props.value === 'string') return props.value
    return JSON.stringify(props.value, null, 2)
  })

  const handleBlur = () => {
    if (!text.trim()) {
      setError(null)
      return
    }
    try {
      JSON.parse(text)
      setError(null)
    } catch {
      setError('Invalid JSON')
    }
  }

  // A string field stores the JSON text as typed; other fields store the parsed value.
  const storesText = (props.schema as JsonSchema).type === 'string'

  const handleChange = (value: string) => {
    setText(value)
    try {
      const parsed = JSON.parse(value)
      setError(null)
      props.onChange(storesText ? value : parsed)
    } catch {
      // Don't set error while typing — only on blur
    }
  }

  return (
    <div className="gz-json-widget">
      <textarea
        value={text}
        onChange={e => handleChange(e.target.value)}
        onBlur={handleBlur}
        placeholder='{ "key": "value" }'
        rows={10}
        spellCheck={false}
        data-testid={inputTestId(props)}
      />
      {error && <div className="gz-json-error">{error}</div>}
    </div>
  )
}

// ---------------------------------------------------------------------------
// Rich Text Widget (Tiptap)
// ---------------------------------------------------------------------------

function RichTextWidget(props: WidgetProps) {
  const onChangeRef = React.useRef(props.onChange)
  onChangeRef.current = props.onChange

  const editor = useEditor({
    extensions: [
      StarterKit.configure({
        heading: { levels: [2, 3] },
        codeBlock: { HTMLAttributes: { spellcheck: 'false' } },
        // StarterKit 3 bundles Link; configure it here rather than adding
        // Link again, which registers a duplicate extension.
        link: { openOnClick: false, HTMLAttributes: { rel: 'noopener noreferrer' } },
      }),
      Placeholder.configure({ placeholder: 'Start writing...' }),
    ],
    content: props.value || '',
    onUpdate: ({ editor: e }) => onChangeRef.current(e.getHTML()),
    immediatelyRender: true,
  })

  if (!editor) return null

  const Btn = ({
    active,
    onClick,
    testId,
    children,
  }: {
    active?: boolean
    onClick: () => void
    testId?: string
    children: React.ReactNode
  }) => (
    <button
      type="button"
      className={`gz-rt-btn${active ? ' active' : ''}`}
      data-testid={testId ? `richtext-${testId}` : undefined}
      onMouseDown={e => {
        e.preventDefault()
        onClick()
      }}
    >
      {children}
    </button>
  )

  const addLink = () => {
    const prev = editor.getAttributes('link').href as string | undefined
    const url = prompt('URL:', prev ?? 'https://')
    if (url === null) return
    if (url === '') {
      editor.chain().focus().extendMarkRange('link').unsetLink().run()
      return
    }
    editor.chain().focus().extendMarkRange('link').setLink({ href: url }).run()
  }

  return (
    <div className="gz-richtext" data-testid="richtext-editor">
      {/* Fixed toolbar */}
      <div className="gz-richtext-toolbar">
        <Btn testId="bold" active={editor.isActive('bold')} onClick={() => editor.chain().focus().toggleBold().run()}>
          B
        </Btn>
        <Btn
          testId="italic"
          active={editor.isActive('italic')}
          onClick={() => editor.chain().focus().toggleItalic().run()}
        >
          I
        </Btn>
        <Btn
          testId="strike"
          active={editor.isActive('strike')}
          onClick={() => editor.chain().focus().toggleStrike().run()}
        >
          S
        </Btn>
        <Btn testId="code" active={editor.isActive('code')} onClick={() => editor.chain().focus().toggleCode().run()}>
          &lt;/&gt;
        </Btn>
        <div className="gz-rt-sep" />
        <Btn
          testId="h2"
          active={editor.isActive('heading', { level: 2 })}
          onClick={() => editor.chain().focus().toggleHeading({ level: 2 }).run()}
        >
          H2
        </Btn>
        <Btn
          testId="h3"
          active={editor.isActive('heading', { level: 3 })}
          onClick={() => editor.chain().focus().toggleHeading({ level: 3 }).run()}
        >
          H3
        </Btn>
        <div className="gz-rt-sep" />
        <Btn
          testId="bullet-list"
          active={editor.isActive('bulletList')}
          onClick={() => editor.chain().focus().toggleBulletList().run()}
        >
          &bull;
        </Btn>
        <Btn
          testId="ordered-list"
          active={editor.isActive('orderedList')}
          onClick={() => editor.chain().focus().toggleOrderedList().run()}
        >
          1.
        </Btn>
        <Btn
          testId="blockquote"
          active={editor.isActive('blockquote')}
          onClick={() => editor.chain().focus().toggleBlockquote().run()}
        >
          &ldquo;
        </Btn>
        <div className="gz-rt-sep" />
        <Btn testId="link" active={editor.isActive('link')} onClick={addLink}>
          Link
        </Btn>
        <Btn testId="hr" onClick={() => editor.chain().focus().setHorizontalRule().run()}>
          &#x2014;
        </Btn>
        <Btn
          testId="code-block"
          active={editor.isActive('codeBlock')}
          onClick={() => editor.chain().focus().toggleCodeBlock().run()}
        >
          Code
        </Btn>
      </div>

      {/* Floating toolbar on selection */}
      <BubbleMenu editor={editor}>
        <div className="gz-bubble">
          <Btn active={editor.isActive('bold')} onClick={() => editor.chain().focus().toggleBold().run()}>
            B
          </Btn>
          <Btn active={editor.isActive('italic')} onClick={() => editor.chain().focus().toggleItalic().run()}>
            I
          </Btn>
          <Btn active={editor.isActive('strike')} onClick={() => editor.chain().focus().toggleStrike().run()}>
            S
          </Btn>
          <Btn active={editor.isActive('code')} onClick={() => editor.chain().focus().toggleCode().run()}>
            &lt;/&gt;
          </Btn>
          <Btn active={editor.isActive('link')} onClick={addLink}>
            Link
          </Btn>
        </div>
      </BubbleMenu>

      <EditorContent editor={editor} />
    </div>
  )
}

// ---------------------------------------------------------------------------
// Custom Templates
// ---------------------------------------------------------------------------

function GzArrayFieldTemplate(props: ArrayFieldTemplateProps) {
  const ctx = props.registry.formContext as GzFormContext | undefined
  const fieldPath = props.fieldPathId?.$id ?? ''

  const handleDragEnd = (result: DropResult) => {
    if (!result.destination || result.source.index === result.destination.index) return
    ctx?.reorderArray(props.fieldPathId?.path ?? [], result.source.index, result.destination.index)
  }

  if (props.items.length === 0) {
    return (
      <div className="gz-array">
        <div className="gz-array-header">
          {props.title && <span className="gz-array-title">{props.title}</span>}
          <span className="gz-array-count">0</span>
        </div>
        <div className="gz-array-empty">
          No items yet
          {props.canAdd && (
            <div style={{ marginTop: '0.5rem' }}>
              <button type="button" className="gz-array-add" onClick={props.onAddClick}>
                + Add first item
              </button>
            </div>
          )}
        </div>
      </div>
    )
  }

  return (
    <div className="gz-array" data-testid={`array-${fieldPath}`}>
      <div className="gz-array-header">
        {props.title && <span className="gz-array-title">{props.title}</span>}
        <span className="gz-array-count">{props.items.length}</span>
        {props.canAdd && (
          <button type="button" className="gz-array-add" onClick={props.onAddClick}>
            + Add
          </button>
        )}
      </div>
      <DragDropContext onDragEnd={handleDragEnd}>
        <Droppable droppableId={fieldPath || 'array'}>
          {provided => (
            <div className="gz-array-items" ref={provided.innerRef} {...provided.droppableProps}>
              {props.items}
              {provided.placeholder}
            </div>
          )}
        </Droppable>
      </DragDropContext>
    </div>
  )
}

function GzArrayFieldItemTemplate(props: ArrayFieldItemTemplateProps) {
  const [open, setOpen] = React.useState(true)
  const summary = summarizeItem((props as unknown as { formData: unknown }).formData)
  const draggableId = `${props.buttonsProps.fieldPathId?.$id ?? 'item'}-${props.index}`

  return (
    <Draggable draggableId={draggableId} index={props.index}>
      {(provided, snapshot) => (
        <div
          className={`gz-array-item${snapshot.isDragging ? ' dragging' : ''}`}
          data-testid="array-item"
          ref={provided.innerRef}
          {...provided.draggableProps}
        >
          <div className="gz-array-item-header" onClick={() => setOpen(!open)}>
            <span
              className="gz-array-item-handle"
              data-testid="array-item-handle"
              {...provided.dragHandleProps}
              onClick={e => e.stopPropagation()}
            >
              &#x2801;&#x2801;
            </span>
            <span className={`gz-array-item-chevron${open ? ' open' : ''}`}>&#x25B6;</span>
            <span className="gz-array-item-idx">{props.index + 1}</span>
            {!open && (
              <span className={`gz-array-item-summary${summary ? '' : ' empty'}`}>{summary || 'Empty item'}</span>
            )}
            <div className="gz-array-item-actions" onClick={e => e.stopPropagation()}>
              <GzArrayFieldItemButtonsTemplate {...props.buttonsProps} />
            </div>
          </div>
          <div className={`gz-array-item-body ${open ? 'expanded' : 'collapsed'}`}>{props.children}</div>
        </div>
      )}
    </Draggable>
  )
}

function GzArrayFieldItemButtonsTemplate(props: ArrayFieldItemButtonsTemplateProps) {
  return (
    <>
      {props.hasMoveUp && (
        <button
          type="button"
          className="gz-btn-icon"
          onClick={props.onMoveUpItem}
          title="Move up"
          data-testid="array-item-move-up"
        >
          &#x2191;
        </button>
      )}
      {props.hasMoveDown && (
        <button
          type="button"
          className="gz-btn-icon"
          onClick={props.onMoveDownItem}
          title="Move down"
          data-testid="array-item-move-down"
        >
          &#x2193;
        </button>
      )}
      {props.hasRemove && (
        <button
          type="button"
          className="gz-btn-icon gz-btn-remove"
          onClick={props.onRemoveItem}
          title="Remove"
          data-testid="array-item-remove"
        >
          &times;
        </button>
      )}
    </>
  )
}

function GzObjectFieldTemplate(props: ObjectFieldTemplateProps) {
  const isRoot = props.fieldPathId?.$id === 'root'
  if (isRoot) return <>{props.properties.map(p => p.content)}</>
  return <div className="gz-object-inline">{props.properties.map(p => p.content)}</div>
}

function GzAddButton(props: IconButtonProps) {
  return (
    <button type="button" className="gz-array-add" onClick={props.onClick} disabled={props.disabled}>
      + Add
    </button>
  )
}

// ---------------------------------------------------------------------------
// Custom Field Widget (async loader)
// ---------------------------------------------------------------------------

import type { FieldMount } from '../types.js'

const fieldWidgetCache = new Map<string, React.FC<WidgetProps>>()

/** Create an async widget that loads a FieldMount module and mounts it */
function getCustomFieldWidget(fieldName: string): React.FC<WidgetProps> {
  const cached = fieldWidgetCache.get(fieldName)
  if (cached) return cached

  const CustomFieldWidget: React.FC<WidgetProps> = props => {
    const containerRef = React.useRef<HTMLDivElement>(null)
    const mountRef = React.useRef<FieldMount | null>(null)
    const mountedRef = React.useRef(false)
    const [loading, setLoading] = React.useState(true)
    const [error, setError] = React.useState<string | null>(null)
    const ctx = (props as unknown as { registry?: { formContext?: GzFormContext } }).registry?.formContext

    // Load the field module once
    React.useEffect(() => {
      if (!ctx?.fieldsBaseUrl) {
        setError('No fields base URL configured')
        setLoading(false)
        return
      }

      const base = `${ctx.fieldsBaseUrl}/${fieldName}`
      ;(async () => {
        // Try extensions in order: .tsx/.ts (dev), .js (production)
        for (const ext of ['.tsx', '.ts', '.js']) {
          try {
            const mod = await import(/* @vite-ignore */ `${base}${ext}`)
            mountRef.current = (mod.default ?? mod) as FieldMount
            setLoading(false)
            return
          } catch {
            /* try next */
          }
        }
        setError(`Failed to load field "${fieldName}"`)
        setLoading(false)
      })()
    }, [ctx?.fieldsBaseUrl])

    // Mount the FieldMount once loaded — unmount on cleanup
    React.useEffect(() => {
      if (loading || !containerRef.current || !mountRef.current) return
      const el = containerRef.current
      const fm = mountRef.current
      fm.mount(el, {
        value: props.value,
        schema: props.schema as Record<string, unknown>,
        theme: (ctx?.theme as 'dark' | 'light') ?? 'dark',
        onChange: v => props.onChange(v),
      })
      mountedRef.current = true
      return () => {
        fm.unmount(el)
        mountedRef.current = false
      }
    }, [loading])

    // Update value without re-mounting — call mount again with new value
    // FieldMount implementations should handle being called multiple times
    React.useEffect(() => {
      if (!mountedRef.current || !containerRef.current || !mountRef.current) return
      mountRef.current.mount(containerRef.current, {
        value: props.value,
        schema: props.schema as Record<string, unknown>,
        theme: (ctx?.theme as 'dark' | 'light') ?? 'dark',
        onChange: v => props.onChange(v),
      })
    }, [props.value])

    if (loading)
      return (
        <div style={{ color: 'var(--color-muted)', fontSize: '0.75rem', padding: '0.5rem 0' }}>
          Loading {fieldName}...
        </div>
      )
    if (error) return <div style={{ color: 'var(--color-danger-fg)', fontSize: '0.75rem' }}>{error}</div>
    return <div ref={containerRef} />
  }

  fieldWidgetCache.set(fieldName, CustomFieldWidget)
  return CustomFieldWidget
}

// ---------------------------------------------------------------------------
// Registries
// ---------------------------------------------------------------------------

const CoreSelectWidget = getDefaultRegistry().widgets.SelectWidget

function SelectWidget(props: WidgetProps) {
  return (
    <div data-testid={inputTestId(props)}>
      <CoreSelectWidget {...props} />
    </div>
  )
}

const builtinWidgets: Record<string, React.FC<WidgetProps>> = {
  markdown: MarkdownWidget,
  toggle: ToggleWidget,
  color: ColorWidget,
  tags: TagsWidget,
  richtext: RichTextWidget,
  image: ImageWidget,
  link: LinkWidget,
  slug: SlugWidget,
  code: CodeWidget,
  json: JsonWidget,
  SelectWidget,
  'embedded-asset': AssetEmbeddedWidget,
}

/** Build widgets object including any custom field widgets referenced in the schema */
function buildWidgets(jsonSchema: JsonSchema): Record<string, React.FC<WidgetProps>> {
  const widgets = { ...builtinWidgets }
  const properties = jsonSchema.properties as Record<string, JsonSchema> | undefined
  if (!properties) return widgets

  for (const prop of Object.values(properties)) {
    const fieldName = prop.field as string | undefined
    if (fieldName) {
      widgets[`custom-field:${fieldName}`] = getCustomFieldWidget(fieldName)
    }
  }
  return widgets
}

const customTemplates = {
  ArrayFieldTemplate: GzArrayFieldTemplate,
  ArrayFieldItemTemplate: GzArrayFieldItemTemplate,
  ArrayFieldItemButtonsTemplate: GzArrayFieldItemButtonsTemplate,
  ObjectFieldTemplate: GzObjectFieldTemplate,
  ButtonTemplates: { AddButton: GzAddButton },
}

// ---------------------------------------------------------------------------
// DefaultEditorForm — standalone React component
// ---------------------------------------------------------------------------

/** Props for the DefaultEditorForm component */
export interface DefaultEditorFormProps {
  schema: Record<string, unknown>
  content: Record<string, unknown>
  /** Base URL for loading custom field modules (optional — only needed if schema has custom fields) */
  fieldsBaseUrl?: string
  /** Current theme — forwarded to custom field widgets */
  theme?: 'dark' | 'light'
  onChange: (content: Record<string, unknown>) => void
  /**
   * Asset picker callback — invoked by embedded-asset field widgets.
   * Supplied by the admin; the editor package only depends on the
   * abstract Promise-returning shape.
   */
  onPickAsset?: (options: { accept?: string[]; currentAssetName?: string | null }) => Promise<{ _asset: string } | null>
  /**
   * Base URL of the admin API (e.g. `/admin/api`) — used by the asset
   * field widget to fetch asset summaries. Supplied by the admin; the
   * editor package can't derive it reliably from the page URL.
   */
  assetsApiBase?: string
}

/**
 * The default @rjsf form editor as a React component.
 * Custom editors can embed this: `<DefaultEditorForm schema={schema} content={content} onChange={onChange} />`
 */
export function DefaultEditorForm({
  schema: jsonSchema,
  content,
  onChange,
  fieldsBaseUrl,
  theme,
  onPickAsset,
  assetsApiBase,
}: DefaultEditorFormProps) {
  const uiSchema = React.useMemo(() => buildUiSchema(jsonSchema as JsonSchema), [jsonSchema])
  const widgets = React.useMemo(() => buildWidgets(jsonSchema as JsonSchema), [jsonSchema])

  const [formData, setFormData] = React.useState(content)
  const formDataRef = React.useRef(formData)
  formDataRef.current = formData

  const undoStack = React.useRef<Record<string, unknown>[]>([])
  const redoStack = React.useRef<Record<string, unknown>[]>([])
  const isUndoRedo = React.useRef(false)

  const pushHistory = (prev: Record<string, unknown>) => {
    if (isUndoRedo.current) return
    undoStack.current.push(prev)
    if (undoStack.current.length > 50) undoStack.current.shift()
    redoStack.current = []
  }

  const applyFormData = (data: Record<string, unknown>) => {
    setFormData(data)
    onChange(data)
  }

  const handleChange = (e: IChangeEvent) => {
    pushHistory(formDataRef.current)
    setFormData(e.formData)
    onChange(e.formData as Record<string, unknown>)
  }

  React.useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === 'z') {
        e.preventDefault()
        if (e.shiftKey) {
          if (redoStack.current.length === 0) return
          const next = redoStack.current.pop()!
          undoStack.current.push(formDataRef.current)
          isUndoRedo.current = true
          applyFormData(next)
          isUndoRedo.current = false
        } else {
          if (undoStack.current.length === 0) return
          const prev = undoStack.current.pop()!
          redoStack.current.push(formDataRef.current)
          isUndoRedo.current = true
          applyFormData(prev)
          isUndoRedo.current = false
        }
      }
    }
    document.addEventListener('keydown', handler)
    return () => document.removeEventListener('keydown', handler)
  }, [])

  const reorderArray = React.useCallback(
    (path: readonly (string | number)[], fromIndex: number, toIndex: number) => {
      setFormData((prev: Record<string, unknown>) => {
        // By path, not by parsing the field id: `root_nav_links` and
        // `root_groups_0_tags` don't split back into their keys.
        const updated = reorderAtPath(prev, path, fromIndex, toIndex)
        if (!updated) return prev
        pushHistory(prev)
        onChange(updated)
        return updated
      })
    },
    [onChange],
  )

  const formContext: GzFormContext = React.useMemo(
    () => ({ reorderArray, fieldsBaseUrl, theme, onPickAsset, assetsApiBase }),
    [reorderArray, fieldsBaseUrl, theme, onPickAsset, assetsApiBase],
  )

  return (
    <>
      <style>{STYLES}</style>
      <div className="gz-editor">
        <Form
          schema={jsonSchema as JsonSchema}
          uiSchema={uiSchema}
          formData={formData}
          onChange={handleChange}
          validator={validator}
          widgets={widgets}
          fields={{ 'embedded-asset': AssetEmbeddedField }}
          templates={customTemplates}
          formContext={formContext}
          liveValidate={false}
          omitExtraData
          noHtml5Validate
          autoComplete="off"
        />
      </div>
    </>
  )
}

// ---------------------------------------------------------------------------
// Mount — wraps DefaultEditorForm for the mount/unmount lifecycle
// ---------------------------------------------------------------------------

export function createEditorMount(jsonSchema: object): EditorMount {
  return {
    mount(el, { content, schema, theme, onChange, fieldsBaseUrl, onPickAsset, assetsApiBase }) {
      const existing = roots.get(el)
      if (existing) existing.unmount()

      const root = createRoot(el)
      roots.set(el, root)
      root.render(
        <DefaultEditorForm
          schema={schema ?? (jsonSchema as Record<string, unknown>)}
          content={content}
          theme={theme}
          fieldsBaseUrl={fieldsBaseUrl}
          onPickAsset={onPickAsset}
          assetsApiBase={assetsApiBase}
          onChange={onChange}
        />,
      )
    },

    unmount(el) {
      const root = roots.get(el)
      if (root) {
        root.unmount()
        roots.delete(el)
      }
    },
  }
}
