# Migrating from String URLs to Asset References

If your templates currently use `z.string()` for image URLs, this is
the path to migrate to `embeddedAsset()` and Gazetta's asset library.

## What changes

| Aspect | Before (string URL) | After (asset reference) |
|---|---|---|
| Schema | `z.string()` | `embeddedAsset({ accept: ['image'] })` |
| Author UI | Plain text input | Asset library picker |
| Stored content | `{ "hero": "/images/hero.jpg" }` | `{ "hero": { "_asset": "hero" } }` |
| Template receives | `string` | `ResolvedEmbeddedAsset` (`url`, `srcset`, `width`, `height`, `alt`, …) |
| Replace bytes | Re-upload, rename file, hunt references | Replace-and-delete: rewrites every reference |
| Variants | Manual (separate uploads) | Auto-generated (4 widths via sharp) |
| Alt | Hardcoded in template OR a separate string field | Three-state on the asset, per-ref override on the page |
| Locale-specific bytes | Separate URLs per locale | One asset name, optional per-locale byte overrides |

`z.string()` continues to work — the migration is per-template, on
your timeline.

## Step-by-step recipe

### 1. Pick a template to migrate first

Start small. A template that has one image field and is used on a
handful of pages is easier to validate than a template with five
image fields used across the whole site.

### 2. Update the schema

Change the field from `z.string()` to `embeddedAsset(...)`:

```diff
 // templates/hero/index.tsx
 import { z } from 'zod'
+import { embeddedAsset, type Content } from 'gazetta/schema'

 export const schema = z.object({
-  image: z.string(),
+  image: embeddedAsset({ accept: ['image'] }),
   title: z.string(),
 })
```

### 3. Update the type signature

Wrap the inferred type in `Content<>`:

```diff
-const render: TemplateFunction<z.infer<typeof schema>> = ({ content }) => ({
+const render: TemplateFunction<Content<typeof schema>> = ({ content }) => ({
```

This swaps `image: string` for `image: ResolvedEmbeddedAsset` so the
template body sees the resolved shape.

### 4. Update the render body

Templates that did `<img src="${content.image}">` now read structured
fields:

```diff
 const render: TemplateFunction<Content<typeof schema>> = ({ content }) => ({
   html: `
-    <img src="${content.image}">
+    <img
+      src="${content.image.url}"
+      srcset="${content.image.srcset ?? ''}"
+      alt="${content.image.alt}"
+      width="${content.image.width ?? ''}"
+      height="${content.image.height ?? ''}">
     <h1>${content.title}</h1>
   `,
   css: '',
   js: '',
 })
```

The minimum migration is just `${content.image}` → `${content.image.url}`.
Adding `srcset`, `width`, `height`, and `alt` improves performance and
accessibility but isn't strictly required to compile.

### 5. Upload the existing images to the library

For each page that uses this template, the existing `/images/foo.jpg`
URL needs to become an asset library entry:

1. Open the asset library (`Cmd+L`)
2. Drag the file from disk (or your existing `public/` folder) into
   the upload zone
3. Use the same name as the slug — if the URL was `/images/hero.jpg`,
   name the asset `hero`
4. Add alt text in the inline upload-list input (or skip and edit
   later via the detail pane)

### 6. Update each page's content

For every page that uses the template, change the field value from
the URL string to the asset reference:

```diff
 // pages/home/page.json
 {
   "template": "hero",
   "content": {
-    "image": "/images/hero.jpg",
+    "image": { "_asset": "hero" },
     "title": "Welcome"
   }
 }
```

If you have many pages, you can do this with a one-liner:

```sh
# Replace "image": "/images/hero.jpg" with "image": { "_asset": "hero" }
# in every page.json under sites/<name>/pages/
find sites/<name>/pages -name 'page.json' -exec sed -i '' \
  's|"image": "/images/hero.jpg"|"image": { "_asset": "hero" }|g' {} +
```

(Real migrations will rarely fit in one sed replacement; the spirit
is "edit the JSON, don't write a CMS migration tool.")

### 7. Verify

Run `gazetta dev`, open each migrated page, confirm the image
renders. Then run `gazetta validate` (or `tsc --noEmit` against the
template package) to catch any pages that reference assets that don't
exist in the library yet.

### 8. Repeat per template

`embeddedAsset` and `z.string()` coexist fine in the same site —
authors will see the picker for migrated fields and a text input for
unmigrated ones. Migrate at your pace.

## Variations

### Field used for downloads, not images

Use `downloadable()` instead:

```ts
const schema = z.object({
  whitepaper: downloadable({ accept: ['document'] }),
})
```

Resolved shape: `{ url, title, description, size, mime }` — the
template renders `<a href="${content.whitepaper.url}" download>${content.whitepaper.title}</a>`.

### Optional asset

```diff
-image: embeddedAsset({ accept: ['image'] })
+image: embeddedAsset({ accept: ['image'] }).optional()
```

The render body becomes conditional:

```ts
import { z } from 'zod'
import type { TemplateFunction } from 'gazetta'
import { embeddedAsset, type Content } from 'gazetta/schema'

export const schema = z.object({
  image: embeddedAsset({ accept: ['image'] }).optional(),
  title: z.string(),
})

const render: TemplateFunction<Content<typeof schema>> = ({ content }) => ({
  html: content?.image
    ? `<img src="${content.image.url}" alt="${content.image.alt}">`
    : '',
  css: '',
  js: '',
})

export default render
```

### Required-alt enforcement

Mark the field `altRequired: true`:

```ts
embeddedAsset({ accept: ['image'], altRequired: true })
```

Today this is informational (the admin shows a stronger nag for
fields with required alt that resolve to null); save-time enforcement
is a v1.5 follow-up.

### Locale-specific images

The migration doesn't change anything in your template. Authors who
need a French version of a hero with text baked in upload French
bytes via the **library detail pane → Locale bytes section → +Add fr
version**. The resolver swaps in the French bytes when French content
is being rendered. Templates don't need locale awareness.

## What you lose by NOT migrating

Sites that stay on `z.string()` URLs miss:

- **No replace-and-delete.** When you swap the bytes for a new image,
  you have to rename the file and update every page that linked to
  the old URL. With assets, the admin does this for you in one click.
- **No automatic variants.** Browsers download the full-resolution
  bytes regardless of viewport. With assets, sharp generates 400/800/
  1200/1600 px variants at upload time and the browser picks via
  `srcset`.
- **No locale-aware bytes.** A French hero with French text baked in
  needs a separate URL today. With assets, it's an override on the
  same asset.
- **No history.** Replacing bytes is permanent — no undo. With assets,
  every change is a history revision.
- **No focal point.** Cropping the same image to 16:9 vs. 1:1 puts
  the subject in the wrong place. With assets, the focal point
  travels with the asset and templates use `object-position`.
- **No asset-refs sidecar index.** Delete a `/public/images/hero.jpg`
  manually and the references silently 404. With assets, delete is
  blocked when references exist (or replace-and-delete rewrites them).

## What stays the same

- **`gazetta publish`.** Asset bytes ship to the target alongside
  rendered HTML, no separate step.
- **The runtime.** Static targets pre-render; dynamic targets SSR
  per request — both work with asset-resolved templates.
- **Template package boundaries.** Assets don't change how templates
  are packaged or distributed.
- **`site.config.ts`.** The migration is content + schema only; no site
  config changes.

## Reverting

Roll back via git — every change in this migration is a content edit
or a template edit, both versioned. There's no schema migration in
the database to reverse.

## See also

- [template-assets.md](template-assets.md) — schema helpers and resolved shapes
- [content-assets.md](content-assets.md) — author flows in the library
- [`.claude/rules/design-media.md`](../.claude/rules/design-media.md) — design model
