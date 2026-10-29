# Customize the editor

Replace a template's editing form, add individual field widgets or theme the admin. These customizations live under the project's `admin/` directory and are shared across its sites. Template rendering is covered in [Templates](./templates.md).

## Custom editors

The CMS auto-generates forms from template schemas using @rjsf. You can replace the
default form with a custom editor for any template.

### Create a custom editor

Create `admin/editors/{template-name}.tsx`, exporting an `EditorMount` as the default export. Editors are separate project-level files, not exports from the template module. Lookup also accepts `{template-name}.ts`. For the `hero` template:

```tsx
// admin/editors/hero.tsx
import React, { useState } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { DefaultEditorForm } from 'gazetta/editor'
import type { EditorMount } from 'gazetta/types'

type EditorProps = Parameters<EditorMount['mount']>[1]

function HeroEditor(props: EditorProps) {
  const [data, setData] = useState(props.content)
  const handleChange = (c: Record<string, unknown>) => { setData(c); props.onChange(c) }

  return (
    <div>
      {/* Your custom preview */}
      <div style={{ padding: '1.5rem', background: 'linear-gradient(135deg, #667eea, #764ba2)', borderRadius: 8, color: '#fff', textAlign: 'center', marginBottom: '1rem' }}>
        <h2>{(data.title as string) || 'Untitled'}</h2>
        {typeof data.subtitle === 'string' && data.subtitle && <p style={{ opacity: 0.85 }}>{data.subtitle}</p>}
      </div>

      {/* Default form for the fields. Forward every prop so custom
          fields (fieldsBaseUrl) and the asset picker (onPickAsset)
          keep working inside it. */}
      <DefaultEditorForm {...props} content={data} onChange={handleChange} />
    </div>
  )
}

const roots = new WeakMap<HTMLElement, Root>()
const editor: EditorMount = {
  mount(el, props) {
    // mount() runs once per mount cycle; content updates flow through
    // onChange and the editor's own state.
    const root = createRoot(el)
    roots.set(el, root)
    root.render(<HeroEditor {...props} />)
  },
  unmount(el) { roots.get(el)?.unmount(); roots.delete(el) },
}
export default editor
```

The custom editor loads automatically when you select a hero component in the CMS.
Templates without a custom editor use the default auto-generated form.

### What custom editors receive

| Prop | Type | Description |
|------|------|-------------|
| `content` | `Record<string, unknown>` | Current content values |
| `schema` | `Record<string, unknown>` | JSON Schema for the template |
| `theme` | `'dark' \| 'light'` | Admin theme at mount time |
| `fieldsBaseUrl` | `string` (optional) | Base URL for loading custom field modules |
| `onPickAsset` | `(options) => Promise<{ _asset: string } \| null>` (optional) | Opens the asset picker; resolves on confirm, `null` on cancel |
| `assetsApiBase` | `string` (optional) | Admin API base URL for asset-summary fetches |
| `onChange` | `(content) => void` | Call when content changes |

Forward all mount props to `DefaultEditorForm`, including `fieldsBaseUrl`, `onPickAsset` and `assetsApiBase`. Without the first two,
custom fields render "No fields base URL configured" and asset fields can't open
the picker; `assetsApiBase` lets asset fields fetch summaries from the correct API base. `theme` is the admin theme when the editor mounted; a theme switch
doesn't remount it, so follow switches with the CSS tokens, not the prop.

### Embedding the default form

Import `DefaultEditorForm` from `gazetta/editor` to embed the auto-generated form
inside your custom editor, with custom UI above the standard form fields.

## Custom fields

Custom fields are reusable widgets that replace individual form fields inside the
default @rjsf form. Unlike custom editors (which replace the entire form), custom
fields target a single property.

### Create a custom field

Create `admin/fields/{field-name}.tsx`:

```tsx
// admin/fields/brand-color.tsx
import React, { useEffect, useState } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import type { FieldMount } from 'gazetta/types'

const PRESETS = [
  { label: 'Indigo', value: '#667eea' },
  { label: 'Purple', value: '#764ba2' },
  { label: 'Coral', value: '#f97066' },
]

function BrandColorPicker({ value, onChange }: { value: string; theme: 'dark' | 'light'; onChange: (v: string) => void }) {
  const [color, setColor] = useState(value || '#667eea')
  // The form calls mount() again with the new value on each change, so
  // the prop updates under a reused root - sync on undo/redo, revert
  // and draft restores.
  useEffect(() => { setColor(value || '#667eea') }, [value])
  const handleChange = (v: string) => { setColor(v); onChange(v) }

  return (
    <div>
      <div style={{ height: 48, borderRadius: 8, background: color }} />
      <div style={{ display: 'flex', gap: '0.375rem' }}>
        {PRESETS.map(p => (
          <button key={p.value} type="button" aria-label={p.label} onClick={() => handleChange(p.value)}
            style={{ width: 28, height: 28, borderRadius: 6, background: p.value, border: 'none', cursor: 'pointer' }} />
        ))}
      </div>
      <input type="color" value={color} onChange={e => handleChange(e.target.value)} />
    </div>
  )
}

const roots = new WeakMap<HTMLElement, Root>()
const brandColor: FieldMount = {
  mount(el, { value, theme, onChange }) {
    // mount() runs again on value changes; reuse the root.
    let root = roots.get(el)
    if (!root) {
      root = createRoot(el)
      roots.set(el, root)
    }
    root.render(<BrandColorPicker value={String(value ?? '')} theme={theme} onChange={onChange} />)
  },
  unmount(el) { roots.get(el)?.unmount(); roots.delete(el) },
}
export default brandColor
```

### Reference a custom field in a template schema

Use `format.field('field-name')` in the Zod schema:

```ts
// templates/banner/index.ts
import { z } from 'zod'
import { format, type TemplateFunction } from 'gazetta'

export const schema = z.object({
  heading: z.string().describe('Banner heading'),
  background: z.string().meta(format.field('brand-color')).describe('Background color'),
})
type Content = z.infer<typeof schema>

const template: TemplateFunction<Content> = ({ content }) => ({
  html: `<h2>${(content?.heading ?? '').replace(/[&<>"']/g, char => `&#${char.charCodeAt(0)};`)}</h2>`,
  css: '',
  js: '',
})

export default template
```

This minimal render example leaves `background` unused; the custom widget still edits that value in the form.

The `brand-color` field widget loads automatically when editing a component that uses
the `banner` template. Other fields in the schema use the default form inputs.

Custom fields apply to top-level schema properties only today - a property inside a
nested `z.object(...)` or a `z.array(...)` item keeps the default input.

### What custom fields receive

| Prop | Type | Description |
|------|------|-------------|
| `value` | `unknown` | Current field value |
| `schema` | `Record<string, unknown>` | JSON Schema for this property |
| `theme` | `'dark' \| 'light'` | Theme on initial mount and later value updates (see below) |
| `onChange` | `(value) => void` | Call when the value changes |

The field receives `theme` at its initial mount and on later value updates. A theme
switch alone does not call `mount` again; the default is `'dark'` when the form
has no theme. To follow switches immediately, style with CSS tokens
(`var(--color-*)` or your own) instead of branching on the prop.

### Custom fields + custom editors

- **No custom editor** - custom fields work inside the default @rjsf form
- **Custom editor with `DefaultEditorForm`** - custom fields work inside the embedded form
- **Custom editor without `DefaultEditorForm`** - custom fields are NOT used (the custom editor controls everything)

## Customize admin appearance

If your project has a file at `admin/theme.css`, Gazetta loads it after the
admin's own styles. At equal specificity, later declarations win; component-token injection has the ordering limit described below.

Use it to:

**Override Gazetta's tokens** - change brand color, status colors, etc.

```css
/* admin/theme.css */
:root {
  --p-primary-color: #7c3aed;
  --color-danger-bg: #fef2f2;
  --color-env-prod-bg: #fff5e6;
}
.dark {
  --p-primary-color: #a78bfa;
  --color-danger-bg: #2a0a0a;
  --color-env-prod-bg: #3a2a10;
}
```

A `:root`-only override applies in both themes - the light `--color-env-prod-bg`
above would sit behind dark-mode text without its `.dark` counterpart.

**Define custom tokens for custom editors and fields** - pick a prefix you own:

```css
/* admin/theme.css */
:root {
  --myapp-json-key: #6366f1;
  --myapp-json-string: #10b981;
}
.dark {
  --myapp-json-key: #a5b4fc;
  --myapp-json-string: #4ade80;
}
```

Your custom editor consumes via `var(--myapp-json-key)`. `theme.css` is appended
after the app mounts; at equal specificity its later declarations win, subject to
the component-token limit below. The admin doesn't wait
for it to load, so first paint can precede it.

`theme.css` reliably overrides the global tokens above. PrimeVue component tokens
(`--p-button-*`, `--p-dialog-*`) are order-dependent: PrimeVue injects each
component's tokens when the component first appears. Components on the first
screen usually get theirs before `theme.css`, and your override wins; ones that
first mount later (a badge, say) get theirs after it and
win instead. To override a component token reliably, use a more specific selector
than PrimeVue's, e.g. `html .p-button { ... }`.

### Reserved prefixes

| Prefix | Owner | What you can do |
|---|---|---|
| `--p-*` | PrimeVue | Override existing - don't add new |
| `--color-*` | Gazetta semantic layer | Override existing - don't add new |
| Anything else | You | Pick a prefix you own (`--myapp-*`, `--mycorp-*`) |

The most useful Gazetta tokens to override:

| Token | Purpose |
|---|---|
| `--p-primary-color` | Brand accent - buttons, focus rings, active states |
| `--color-danger-bg` / `--color-danger-fg` | Error banners |
| `--color-success-bg` / `--color-success-fg` | Success banners |
| `--color-warning-bg` / `--color-warning-fg` | Warning banners |
| `--color-info-bg` / `--color-info-fg` | Info banners |
| `--color-env-prod-bg` / `--color-env-prod-fg` | Production target badge |
| `--color-env-staging-bg` / `--color-env-staging-fg` | Staging target badge |

### Known limitation: brand color cascade

Overriding `--p-primary-color` cascades to some downstream tokens
(button background, focus rings) but not to derived shades
(`--p-primary-hover-color`, `--p-primary-active-color`,
`--p-primary-contrast-color`). For a full brand palette swap, declare
each shade. A JS preset API is not available; set these values with CSS overrides.
