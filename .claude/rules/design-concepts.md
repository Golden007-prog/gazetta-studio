# Design Concepts

Gazetta is a stateless CMS where content is structured as composable components.
The CMS holds no state — all content lives in targets.

## Component Hierarchy

Component is the base. Fragment and Page are specialized kinds of component.

```
Component (base)
  ├── Fragment (component + shared, reusable, @-referenced)
  └── Page (component + route + metadata)
```

```ts
interface Component {
  template: string
  content?: Record<string, any>
  components?: (string | `@${string}`)[]
}

interface Fragment extends Component {
  // shared, lives in fragments/, referenced with @
}

interface Page extends Component {
  route: string
  metadata?: Record<string, any>
}
```

| | Component | Fragment | Page |
|---|---|---|---|
| Has template | Yes | Yes | Yes |
| Has content | Yes | Yes | Yes |
| Has children | Optional | Optional | Optional |
| Shared / reusable | No (local) | Yes (`fragments/`) | No |
| Has route | No | No | Yes |
| Has metadata | No | No | Yes |
| Referenced with `@` | No | Yes | No |

## Other Primitives

| Concept | Definition |
|---------|-----------|
| Template | An independent script: `(params) => { html, css, js }`. Created by developers. Can use any framework. |
| Target | Storage + WinterTC runtime. Where state lives and pages are served. Has properties: `type`, optional `environment`, `editable`. |
| CMS | A stateless editor UI. Reads from and writes to targets. Stores nothing locally. |

## Target Properties

Each configured target carries three properties. Together they encode the user's workflow —
the CMS adapts its UI progressively based on what's configured (see design-editor-ux.md).

| Property | Values | Purpose |
|----------|--------|---------|
| **Type** | `static` / `dynamic` | When rendering happens (publish time vs request time) |
| **Environment** | `local` / `staging` / `production` (or unset) | Drives UI treatment (colors, prod warnings) and suggestion hints. No custom values. |
| **Editable** | `yes` / `no` | Whether author can save form-edits to this target. Publish destinations don't need it: a read-only target still receives publishes (`design-decisions.md` #16). Default: `no` when the target's storage is public; otherwise `yes` for `environment: local` (also when `environment` is unset, which resolves to `local`) and `no` for `staging` and `production`. An explicit `editable: true` needs private storage: on public storage it's a validation error. |

Properties are independent. Examples: `{type: static, environment: local, editable: yes}` for
a local dev target; `{type: static, environment: production, editable: no}` for a publish-only
prod; `{type: static, environment: production, editable: yes}` for a hotfix-accepting prod.

Environments have no system-defined hierarchy — the CMS suggests flows (e.g. "promote staging
→ prod" when both environments exist) but never enforces ordering. Multi-region or multi-site
setups use the same `environment` value across peer targets (e.g. `prod-us` and `prod-eu`
both have `environment: production`); they're distinguished by target name, not by environment.

**Current code:** `type`, `environment` and `editable` are all on `TargetConfig`
([packages/gazetta/src/types.ts](../../packages/gazetta/src/types.ts); `publishMode` is gone).
`isEditable` resolves public storage first ([`design-public-storage.md`](design-public-storage.md) Q6).
`isPublicStorage` takes an explicit `publicStorage` value when set; otherwise storage is
private for a filesystem target with `editable: true` or a target deployed by a copy adapter,
and public for everything else. So an editing target sets `editable: true` on filesystem
storage, or `publicStorage: false` and lets `editable` follow the environment, as `gazetta init`
does for its `local` and `staging` targets.

## Active Target

The **active target** is the target the author is currently focused on. It is the single
spine around which the UX orients:

- Tree, editor, and preview bind to the active target
- Save writes to the active target (only if editable)
- Publish defaults to/from the active target
- Sync indicators on other targets are expressed relative to active ("staging: 3 behind", "prod: 2 ahead")
- Compare is framed as "active vs X"

The active target can be editable (author can write to it via the editor) or read-only
(author can inspect tree/preview but not modify). Switching active target is cheap and
reversible — never a commitment. See design-editor-ux.md for switching behavior.

## Templates

A template is an independent script with its own dependencies. Developers choose the framework.
Every template must conform to the same contract:

```ts
export default (params: { content, children?, params? }) => {
  html: string,
  css: string,
  js: string,
  head?: string
}
```

The `head` field allows any component to contribute to the HTML `<head>` — favicons,
fonts, meta tags, external scripts. The renderer collects `head` from all components.

Each template is a self-contained package:

```
templates/
  hero/
    package.json      # deps: react
    index.tsx         # React component
  newsletter/
    package.json      # deps: svelte
    index.svelte      # Svelte component
  footer/
    package.json      # no framework
    index.ts          # plain tagged templates
```

| Role | Creates | Concern |
|------|---------|---------|
| Developer | Templates | Structure, style, behavior (any framework) |
| Content author | Components (pages + fragments) | Data, content, ordering |

## Template Exports

A template module exports two things (`TemplateModule` in `packages/gazetta/src/types.ts`):

```ts
// Required: renderer
export default (params: { content, children?, params? }) => { html, css, js, head? }

// Required: content schema (Zod → converted to JSON Schema for CMS form generation)
export const schema = z.object({ title: z.string(), ... })
```

A custom editor is not a template export. It's a separate file in the project's `admin/editors/`, matched to the template by name (`admin/editors/hero.tsx` or `hero.ts` for `templates/hero/`). Only a flat file loads: `hasEditorFile` in `template-loader.ts` also detects `admin/editors/hero/index.tsx`, but the dev schema route and the production editor build don't load it ([#1532](https://github.com/gazetta-studio/gazetta-studio/issues/1532)). Editors run in the admin's browser bundle, with the admin's dependencies, while templates run on the server; see `configurations.md` "Modularity". The editor file's default export is an `EditorMount`:

```ts
// admin/editors/hero.tsx
export default {
  mount(el: HTMLElement, props: { content, schema, theme, onChange, ... }): void
  unmount(el: HTMLElement): void
}
```

## CMS Editor Model

The CMS auto-generates editor UIs from component schemas using JSON Schema form generation
(@rjsf). Templates can override with a custom editor via the mount function pattern.

Editor priority:
1. **Custom editor** — if `admin/editors/` has a file named after the template, mount its default export (framework-agnostic)
2. **Schema-driven form** — auto-generate form from the Zod schema via @rjsf

The mount function contract follows the single-spa micro-frontend pattern:
- `mount(el, { content, schema, theme, onChange, ... })` — render editor into the provided DOM element (`EditorMount` in `types.ts`)
- `unmount(el)` — clean up (remove listeners, destroy framework instance)
- Works with React (`createRoot`), Svelte 5 (`mount`), Vue 3 (`createApp`), or vanilla JS

Every template must export a Zod schema. The CMS converts it to JSON Schema
(via zod-to-json-schema) for form generation and validation.

## Component Rendering Types

Every component has a rendering type that determines where and when it renders:

| Type | Rendered where | JS shipped | When to use |
|------|---------------|------------|-------------|
| **Static** | At publish time (Node/Bun). Pre-rendered HTML stored in target. | Zero | Content that rarely changes |
| **Dynamic** | At request time on server (Node/Bun). Fresh HTML per request. | Zero | Fresh data from DB/API per request |
| **Island** | SSR'd on server + hydrated in browser. | Framework + component | Client-side interactivity (maps, editors, real-time) |

Static and dynamic components ship **zero JavaScript**. Only islands ship JS to the browser.

A single page can mix all three:

```
Page: /products
├── @header          → static (pre-rendered at publish)     → 0 JS
├── product-list     → dynamic (fresh from DB per request)  → 0 JS
├── search           → island (needs client interactivity)  → JS
└── @footer          → static (pre-rendered at publish)     → 0 JS
```

Components can also be **composite** — having children listed in their manifest.
Any rendering type can be composite.

Every component — leaf or composite — has a template.

## Rendering

The renderer walks the component tree bottom-up. One rule:

```
render(component):
  children = component.children.map(render)
  return component.template({ ...component.content, children })
```

1. Render children first (if any)
2. Call the component's template with content params + rendered children

```tsx
// Leaf template — hero
export default ({ content }) => ({
  html: `<section><h1>${content.title}</h1></section>`,
  css: `section { background: navy; }`,
  js: ``,
})

// Composite template — header layout
export default ({ children }) => ({
  html: `<header>${children.map(c => c.html).join('')}</header>`,
  css: `header { display: flex; }
    ${children.map(c => c.css).join('\n')}`,
  js: children.map(c => c.js).join('\n'),
})
```

Both CMS and targets use the same Hono-based runtime for rendering.
CMS wraps output with editing UI. Targets serve clean HTML.

## Rendering Architecture

SSR (running templates with React, Vue, Svelte) cannot run on edge runtimes (Cloudflare
Workers, Deno Deploy) — they block dynamic code execution. So rendering is split:

| Where | What it does |
|-------|-------------|
| **Publish time** (Node/Bun) | SSR static components → pre-rendered HTML stored in target |
| **Request time** (Node/Bun server) | SSR dynamic components → fresh HTML per request |
| **Edge** (Hono on Workers/Deno) | Composition only — assembles pre-rendered HTML into pages |
| **Browser** | Island hydration — only for interactive components |

For **static targets** (edge composition): all components are pre-rendered at publish time.
Publishing a fragment = SSR that fragment, push HTML to storage. Edge assembles on request.

For **dynamic targets** (Node/Bun server): static components served from cache, dynamic
components SSR'd per request, islands hydrated in browser.

Import maps deduplicate island dependencies — React, Svelte, Chart.js, etc. loaded once
regardless of how many islands use them. (Current implementation: a single shared import
map across loaded pages; design originally called for per-page maps — alignment pending.)

## Fragments (Shared Components)

Fragments live in `fragments/` and are referenced with `@` in page manifests.
They are reusable across any page. The `@` tells the runtime to resolve from `fragments/`.

```yaml
# fragments/header/fragment.json
template: header-layout
components:
  - logo
  - nav
  - search
```

## Page = Component + Route + Metadata

A page is a component with route and metadata. `page.json` extends the component manifest.
More page fields will be added as the design evolves.

```yaml
# pages/home/page.json
route: /home
metadata:
  title: "Home"
  description: "Welcome to our site"
  og:image: /images/home.png
template: page-default
components:
  - @header         # fragment — from fragments/
  - hero            # local component
  - featured        # local component
  - @footer         # fragment — from fragments/
```

```yaml
# pages/blog/[slug]/page.json — dynamic route
route: /blog/:slug
metadata:
  title: "Blog Post"
template: page-blog
components:
  - @header
  - article
  - @footer
```

## Site Structure

```
my-project/
  package.json
  admin/              # custom editors + fields (shared across sites)
    editors/
    fields/
  templates/          # developer-created (shared across sites)
    hero/
    card/
    article/
    header-layout/
    page-default/
  sites/
    main/             # site content
      site.config.ts
      fragments/      # shared components (reusable across pages)
        header/
          fragment.json
          logo/
          nav/
        footer/
      pages/          # routable components
        home/
          page.json
          hero/
          featured/
        about/
          page.json
          bio/
        blog/
          [slug]/
            page.json
            article/
```

Templates and admin live at the project root, shared across all sites.
Content (pages, fragments, site.config.ts) lives inside `sites/{name}/`.
Flat structure (everything at one level) still works for simple projects.
