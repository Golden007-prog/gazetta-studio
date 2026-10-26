# Getting Started with Gazetta

## Prerequisites

- Gazetta is tested on Node.js 22.22.2 or later in the 22 line, and on Node.js 26. Node 24.15+ is also accepted, but not tested. Odd-numbered releases such as 23 and 25 aren't supported.
- macOS or Linux. On Windows, Gazetta's own tests run only an end-to-end check; use [WSL](https://learn.microsoft.com/windows/wsl/) if you hit problems.

## Create a site

```bash
npx gazetta init my-site
cd my-site
npm install
```

This scaffolds:
- A home page with a hero and text block
- A shared header fragment (nav bar)
- Templates: page-layout, hero, nav, text-block
- `local` and `staging` filesystem targets - publish to either works immediately

## Start the dev server

```bash
npx gazetta dev
```

- **http://localhost:3000** — your site
- **http://localhost:3000/admin** — CMS editor

The server watches for changes and reloads automatically. `site.config.ts` edits apply on save: content, locales and targets take effect without a restart, and the admin picks up edited targets too. Two cases still need a restart of `gazetta dev`: changes to `admin.hooks`, `admin.validators` or `admin.routes`, and a target's storage once the admin has published through it, because publish providers are created once and reused (#1446).

## Templates

A template is a TypeScript function that returns `{ html, css, js }`. Every template exports a Zod schema for its content.

```ts
// templates/hero/index.ts
import { z } from 'zod'
import type { TemplateFunction } from 'gazetta'

export const schema = z.object({
  title: z.string().describe('Page title'),
  subtitle: z.string().optional().describe('Subtitle text'),
})

type Content = z.infer<typeof schema>

const template: TemplateFunction<Content> = ({ content }) => ({
  html: `<section class="hero">
  <h1>${content?.title ?? ''}</h1>
  <p>${content?.subtitle ?? ''}</p>
</section>`,
  css: `.hero { text-align: center; padding: 4rem 0; }
.hero h1 { font-size: 2.5rem; margin-bottom: 0.5rem; }
.hero p { color: #666; font-size: 1.25rem; }`,
  js: '',
})

export default template
```

### Template fields

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `html` | string | Yes | HTML markup |
| `css` | string | Yes | CSS (scoped per component automatically) |
| `js` | string | Yes | Client-side JavaScript (`''` for static components) |
| `head` | string | No | Content for `<head>` — favicons, fonts, meta tags |

### Frameworks

Templates can use any framework that SSR's to HTML:

**React** — save the template as `templates/<name>/index.tsx` and import React: `.tsx` templates are compiled with a JSX transform that needs React in scope:
```tsx
// templates/card/index.tsx
import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'

const template: TemplateFunction<Content> = ({ content }) => ({
  html: renderToStaticMarkup(<Card {...content!} />),
  css: `.card { padding: 1.5rem; }`,
  js: '',
})
```

**Vue 3** — needs `npm install vue` first; `init` doesn't install Vue:
```ts
import { createSSRApp, h } from 'vue'
import { renderToString } from 'vue/server-renderer'

const template: TemplateFunction<Content> = async ({ content }) => {
  const app = createSSRApp(Quote, content ?? {})
  return { html: await renderToString(app), css: '...', js: '' }
}
```

**Interactive components** return JS that runs in the browser:
```ts
const template: TemplateFunction<Content> = ({ content }) => ({
  html: `<button id="btn">Click me</button>`,
  css: `button { padding: 0.5rem 1rem; }`,
  js: `document.getElementById('btn').addEventListener('click', () => alert('Hi'))`,
})
```

### Composite templates

Layout templates receive `children` — the rendered output of child components:

```ts
const template: TemplateFunction = ({ children = [] }) => ({
  html: `<main>${children.map(c => c.html).join('\n')}</main>`,
  css: `main { max-width: 800px; margin: 0 auto; }
${children.map(c => c.css).join('\n')}`,
  js: children.map(c => c.js).filter(Boolean).join('\n'),
  head: children.map(c => c.head).filter(Boolean).join('\n'),
})
```

## Pages

A page is a folder with a `page.json` manifest. The route is derived from the folder path — `pages/about/` becomes `/about`, and `pages/home/` is served at `/`:

```json
{
  "template": "page-layout",
  "content": {
    "title": "About",
    "description": "About our company"
  },
  "components": [
    "@header",
    {
      "name": "about-text",
      "template": "text-block",
      "content": {
        "body": "<p>We build composable websites.</p>"
      }
    }
  ]
}
```

All components are inline in the page manifest — no separate files.

Or create pages in the CMS — click **New page** in the admin UI.

### Dynamic routes

Use `[param]` in the folder name — it becomes `:param` in the route:

A page at `pages/blog/[slug]/page.json` serves `/blog/:slug`:

```json
{
  "template": "page-layout",
  "components": [
    {
      "name": "post-body",
      "template": "text-block",
      "content": {
        "body": "<p>First post.</p>"
      }
    }
  ]
}
```

String entries in `components` must be fragment references starting with `@`; an inline component is an object with `name`, `template` and `content`.

Templates receive route params:

```ts
const template: TemplateFunction<Content> = ({ content, params }) => ({
  html: `<h1>${content?.title ?? params?.slug}</h1>`,
  ...
})
```

## Fragments

Fragments are shared components reusable across pages. They live in `fragments/` and are referenced with `@`:

```json
{
  "template": "nav",
  "content": {
    "brand": "My Site",
    "links": [
      { "label": "Home", "href": "/" },
      { "label": "About", "href": "/about" }
    ]
  }
}
```

Reference in any page with `"@header"`. Update the fragment once — every page reflects it.

## CMS editor

1. Open **http://localhost:3000/admin**
2. Click a page to preview it
3. Click a component in the preview to open it for editing
4. Edit content → preview updates live as you type
5. Click **Save** → writes to disk
6. Click **Publish** → pre-renders and uploads to target

The preview toolbar's eye button only shows or hides hover highlights; editing happens on the page's edit route, not behind a toolbar toggle.

The preview shows each page in a sandboxed frame with an origin of its own. Template scripts run there, but can't use cookies, `localStorage`, form submits, pop-ups or dialogs such as `alert()`; on the published site they can.

## Publish and view your site

In the admin, click **Publish** → pre-renders and uploads to the target. Publish to `local` while you work, then to `staging` to see the site exactly as a server serves it.

`gazetta dev` keeps running on port 3000, so open a second terminal:

```bash
npx gazetta serve staging --port 3001
```

Open **http://localhost:3001** - your published home page, served from `sites/main/dist/staging/`. A filesystem target's `path` is relative to the folder that holds `site.config.ts`, so `./dist/staging` resolves under `sites/main/`, not at the project root.

## Put it online

The staging target serves from your own disk. To put the site in front of a real audience, follow the [Cloudflare deployment guide](./cloudflare.md) or the [self-hosted deployment guide](./self-hosted.md) for VPS, Docker, and Fly.io.

## Custom editors

The CMS auto-generates forms from template schemas using @rjsf. You can replace the
default form with a custom editor for any template.

### Create a custom editor

Create `admin/editors/{template-name}.tsx`:

```tsx
// admin/editors/hero.tsx
import React, { useState } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { DefaultEditorForm } from 'gazetta/editor'
import type { EditorMount } from 'gazetta/types'

function HeroEditor(props: {
  content: Record<string, unknown>
  schema: Record<string, unknown>
  theme: 'dark' | 'light'
  fieldsBaseUrl?: string
  onPickAsset?: (options: { accept?: string[]; currentAssetName?: string | null }) => Promise<{ _asset: string } | null>
  onChange: (content: Record<string, unknown>) => void
}) {
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
| `onChange` | `(content) => void` | Call when content changes |

Forward `fieldsBaseUrl` and `onPickAsset` to `DefaultEditorForm` — without them,
custom fields render "No fields base URL configured" and asset fields can't open
the picker. `theme` is the admin theme when the editor mounted; a theme switch
doesn't remount it, so follow switches with the CSS tokens, not the prop.

### Embedding the default form

Import `DefaultEditorForm` from `gazetta/editor` to embed the auto-generated form
inside your custom editor. This gives you the best of both: custom UI on top, standard
form fields below.

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

function BrandColorPicker({ value, theme, onChange }: { value: string; theme: 'dark' | 'light'; onChange: (v: string) => void }) {
  const [color, setColor] = useState(value || '#667eea')
  // The form calls mount() again with the new value on each change, so
  // the prop updates under a reused root — sync on undo/redo, revert
  // and draft restores.
  useEffect(() => { setColor(value || '#667eea') }, [value])
  const handleChange = (v: string) => { setColor(v); onChange(v) }

  return (
    <div>
      <div style={{ height: 48, borderRadius: 8, background: color }} />
      <div style={{ display: 'flex', gap: '0.375rem' }}>
        {PRESETS.map(p => (
          <button key={p.value} type="button" onClick={() => handleChange(p.value)}
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
    // mount() runs again on each value change — reuse the root.
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
import { format } from 'gazetta'

export const schema = z.object({
  heading: z.string().describe('Banner heading'),
  background: z.string().meta(format.field('brand-color')).describe('Background color'),
})
```

The `brand-color` field widget loads automatically when editing a component that uses
the `banner` template. Other fields in the schema use the default form inputs.

Custom fields apply to top-level schema properties only today — a property inside a
nested `z.object(...)` or a `z.array(...)` item keeps the default input.

### What custom fields receive

| Prop | Type | Description |
|------|------|-------------|
| `value` | `unknown` | Current field value |
| `schema` | `Record<string, unknown>` | JSON Schema for this property |
| `theme` | `'dark' \| 'light'` | Admin theme at mount time (see note below) |
| `onChange` | `(value) => void` | Call when the value changes |

`theme` is the admin theme when the field mounted — a theme switch doesn't remount
it, and the default is `'dark'`. To follow switches, style with the CSS tokens
(`var(--color-*)` or your own) instead of branching on the prop.

### Custom fields + custom editors

- **No custom editor** — custom fields work inside the default @rjsf form
- **Custom editor with `DefaultEditorForm`** — custom fields work inside the embedded form
- **Custom editor without `DefaultEditorForm`** — custom fields are NOT used (the custom editor controls everything)

## Publishing

> **Deploying to Cloudflare?** See the [Cloudflare deployment guide](./cloudflare.md).
> **Self-hosting?** See the [self-hosted deployment guide](./self-hosted.md) for VPS, Docker, and Fly.io.

### Target types

Each target has a **storage** config (where files go) and an optional **deploy** adapter (how the platform serves them — see [`deploy.md`](./deploy.md) for the full reference):

| Storage factory | Use case | Config |
|------|----------|--------|
| `r2Storage()` | Cloudflare R2 | `accountId`, `bucket`, `accessKeyId`, `secretAccessKey` |
| `s3Storage()` | AWS S3, MinIO | `endpoint`, `bucket`, `accessKeyId`, `secretAccessKey` |
| `filesystemStorage()` | Local dev, staging, backups | `path: ./dist/staging` |
| `azureBlobStorage()` | Azure Blob Storage | `connectionString`, `container` |

A filesystem `path` is relative to the folder that holds `site.config.ts`: `./dist/staging` resolves to `sites/main/dist/staging/`, not the project root.

R2 and S3 need `npm install @aws-sdk/client-s3 @aws-sdk/lib-storage`; Azure needs `npm install @azure/storage-blob`. These are optional peer dependencies, so you install only what your storage needs.

| Deploy adapter | Use case |
|-------------|----------|
| `cloudflareWorkersDeploy` | Cloudflare Workers — ESI assembly at the edge |
| (none) | No platform deploy — just publish content to storage (container hosts use platform CLIs; see [#213](https://github.com/gazetta-studio/gazetta-studio/issues/213)) |

### Credentials

The storage and deploy keys the examples below use. (Admin sign-in is separate; see [`auth.md`](./auth.md).)

R2 uses S3-compatible API tokens. Create one at [dash.cloudflare.com](https://dash.cloudflare.com)
→ R2 → Manage R2 API Tokens → Create API Token. Pick "Object Read & Write" scoped to
your bucket. The dashboard shows the access key ID and secret access key once — copy
both.

**Workers deploy:** Also create a Cloudflare API token at
[dash.cloudflare.com/profile/api-tokens](https://dash.cloudflare.com/profile/api-tokens)
with these permissions:

| Permission | Access |
|-----------|--------|
| Account / Workers Scripts | Edit |
| Account / R2 | Edit |
| User / User Details | Read |
| User / Memberships | Read |
| Zone / Workers Routes | Edit |
| Zone / Cache Purge | Purge |
| Zone / Zone | Read |

**Environment variables:** Create a `.env` file in your site directory (gitignored) for secrets:

```
R2_ACCESS_KEY_ID=your-r2-access-key
R2_SECRET_ACCESS_KEY=your-r2-secret-key
CLOUDFLARE_API_TOKEN=your-api-token
```

The CLI loads `.env` automatically. In CI, env vars are set directly — `.env` is skipped whenever `CI` is set to any non-empty value.

Values in site.config.ts reference env vars directly via `process.env.VAR_NAME!` — they're resolved at evaluation time.

### Configure targets

```ts
// site.config.ts
import { cloudflareWorkersDeploy, defineSite, filesystemStorage, r2Storage } from 'gazetta'

export default defineSite({
  name: 'My Site',
  targets: {
    local: {
      storage: filesystemStorage(),
      editable: true,                      // the target you edit; its storage stays private
    },
    staging: {
      storage: filesystemStorage({ path: './dist/staging' }),
      // Served by `gazetta serve`, which never serves `.gazetta/`, so history stays private.
      publicStorage: false,
      environment: 'staging',
    },
    production: {
      type: 'dynamic',
      environment: 'production',           // admin UI requires confirmation before publishing
      storage: r2Storage({
        accountId: 'your-cloudflare-account-id',
        bucket: 'my-site',
        accessKeyId: process.env.R2_ACCESS_KEY_ID!,
        secretAccessKey: process.env.R2_SECRET_ACCESS_KEY!,
      }),
      // Bucket is private; only the worker serves it. Without this, R2 storage counts as public.
      publicStorage: false,
      deploy: cloudflareWorkersDeploy({
        apiToken: process.env.CLOUDFLARE_API_TOKEN!,
        accountId: 'your-cloudflare-account-id',
        name: 'my-site',
        bucket: 'my-site',
      }),
      siteUrl: 'https://mysite.com',
      cache: {
        browser: 0,
        edge: 86400,
        purge: {
          type: 'cloudflare',
          apiToken: process.env.CLOUDFLARE_API_TOKEN!,
        },
      },
    },
  },
})
```

### Target environment

The optional `environment` field declares a target's intent — `local`, `staging`, or `production`. The admin UI uses it to:

- Give each destination in the publish dialog a red (`production`) or amber (`staging`) left border
- Require an explicit confirmation step before publishing to a `production` target

A target without `environment` counts as `local`, so set it on your staging and production targets.

### Unpublished change indicators

The site tree shows a small amber dot next to any page or fragment that has unpublished changes against the most relevant target.

The admin picks the target automatically: it prefers `production` if available, then `staging`, then `local`, but skips any target that has never been published to (so a brand-new production target doesn't make every item look dirty). Until the first publish to any target, every item shows the dot ("Not yet published to …"). Hover the dot to see which target the comparison is against.

The dot disappears when the item matches the target. It refreshes after every save and publish.

### Publish and deploy

```bash
npx gazetta build                     # build admin UI + custom editors/fields
npx gazetta publish                   # publish (which target: see below)
npx gazetta publish production        # publish to a specific target
npx gazetta deploy production         # deploy a target's worker
```

`build` creates the production admin UI in `dist/admin/`; only `gazetta admin` needs it. `publish` pre-renders pages and uploads to storage. `deploy` bundles the installed Gazetta into the worker and embeds the locales, `siteUrl` and bucket, so deploy again after a Gazetta upgrade or a change to any of those.

There is no default target for `publish`: with several targets it asks which one, and in CI it stops until you name one. A site with a single target can't publish at all — that target is the editing source, so publishing would render the site into its own storage. Add a second target in `site.config.ts` first.

The publish mode comes from the target's `type`: an explicit value wins, and the default is `dynamic` only when the deploy adapter bundles a worker.

**`dynamic`:**
- Pages have ESI placeholders for fragments
- Fragments are stored separately — a fragment edit shows on every page at request time, and a publish re-renders only the pages that use the changed fragment
- Hashed CSS/JS files with immutable caching
- A worker assembles pages at request time (`gazetta serve` assembles the same ESI for a `dynamic` target without a worker)

**`static`:**
- Pages are fully assembled — fragments baked in
- One self-contained HTML file per page
- CSS/JS inline — no external files
- A publish re-renders only the pages that use a changed fragment

### Custom 404 page

`gazetta init` already created a `pages/404/` page. It's served with a 404 status when a route doesn't match, and the URL stays as-is — no redirect.

The starter 404 uses the `page-layout` template with just a title and description. To add body content, add inline components in `pages/404/page.json` (a bare string must be a fragment reference starting with `@`, and `init` creates only a `@header` fragment):

```json
// pages/404/page.json
{
  "template": "page-layout",
  "content": {
    "title": "Page Not Found",
    "description": "The page you're looking for doesn't exist."
  },
  "components": [
    {
      "name": "message",
      "template": "text-block",
      "content": { "body": "<p>Nothing here. <a href=\"/\">Back to the homepage</a>.</p>" }
    }
  ]
}
```

Works with both `gazetta serve` and Cloudflare Workers. Fragments are assembled normally.

The 404 page stays out of `sitemap.xml` only while `systemPages: ['404']` lists it in `site.config.ts` — `init` sets that up.

On a static target, every publish also copies the published 404 page to `404.html` at the target root, which Cloudflare Pages, Netlify and GitHub Pages show for missing paths. Until `pages/404` is published to a target, its `404.html` is a minimal "Page not found" page.

### Cache configuration

Per target:
```ts
cache: {
  browser: 0,       // max-age — seconds before browser revalidates
  edge: 86400,      // s-maxage — seconds before edge refetches from storage
  purge: {          // optional — purge CDN cache after publish
    type: 'cloudflare',
    apiToken: process.env.CLOUDFLARE_API_TOKEN!,
  },
}
```

Per page (overrides target):
```json
// pages/dashboard/page.json
{
  "cache": {
    "browser": 0
  }
}
```

`browser` and `edge` apply to `dynamic` targets only: the worker reads them from a comment in the published HTML. Static output carries no cache comment, and `gazetta serve` on a static target sends `max-age=0, must-revalidate` for pages, so static caching is up to the host.

Defaults: `browser: 0`, `edge: 86400`. Set `edge: 0` to skip CDN caching entirely (no purge needed).

ETags are automatic — browsers get `304 Not Modified` for unchanged pages.

When `cache.purge` is configured, `gazetta publish` automatically purges the CDN cache after uploading. The zone ID is auto-detected from `siteUrl`.

## Customize admin appearance

If your project has a file at `admin/theme.css`, Gazetta loads it after the
admin's own styles so your declarations win the cascade.

Use it to:

**Override Gazetta's tokens** — change brand color, status colors, etc.

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

A `:root`-only override applies in both themes — the light `--color-env-prod-bg`
above would sit behind dark-mode text without its `.dark` counterpart.

**Define custom tokens for custom editors and fields** — pick a prefix you own:

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
after the app mounts so its declarations win the cascade; the admin doesn't wait
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
| `--p-*` | PrimeVue | Override existing — don't add new |
| `--color-*` | Gazetta semantic layer | Override existing — don't add new |
| Anything else | You | Pick a prefix you own (`--myapp-*`, `--mycorp-*`) |

The most useful Gazetta tokens to override:

| Token | Purpose |
|---|---|
| `--p-primary-color` | Brand accent — buttons, focus rings, active states |
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
each shade. A future JS preset API will solve this — until then, CSS
overrides handle the common cases.

## Site structure

```
my-project/
  package.json
  admin/                     # custom editors + fields (shared across sites)
    editors/
      hero.tsx
    fields/
      brand-color.tsx
  templates/                 # developer-created templates (shared across sites)
    hero/index.ts
    nav/index.ts
    page-layout/index.ts
  sites/
    main/                    # site content
      site.config.ts         # site manifest + targets
      fragments/             # shared components
        header/fragment.json
      pages/                 # routable pages
        home/
          page.json          # all components inline
        about/
          page.json
        blog/
          [slug]/page.json   # dynamic route
```

Templates and admin customizations are at the project root, shared across all sites.
Content (pages, fragments, site.config.ts) lives inside `sites/{name}/`.

## Indexing localized pages

Each locale file (for example `page.fr.json`) is a complete page manifest. Its own
`metadata.robots` controls indexing in both rendered HTML and the published sitemap:
`"noindex"` excludes that locale URL without excluding the default page, and an omitted
`robots` value permits indexing even if the default page is `noindex`. An ordinary
publish also corrects a previously published locale's stale indexing flag, even when its
content hash has not changed; `--force` is not required.

## Next steps

- Browse the [starter example](../examples/starter/) for more templates
- Read the [architecture document](../.claude/rules/architecture.md) for architecture details
- Check out the [contributing guide](../CONTRIBUTING.md) to get involved
