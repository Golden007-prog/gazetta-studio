# Templates

A template is a TypeScript function that returns `{ html, css, js }`. Every template exports a Zod schema for its content — the CMS builds the editing form from it. Templates live at `templates/<name>/index.ts` (or `index.tsx` for JSX).

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

## The template contract

The renderer calls the default export with a single params object:

| Param | Type | Description |
|-------|------|-------------|
| `content` | `T`, optional | The component's content, validated against `schema` |
| `children` | `RenderOutput[]`, optional | The rendered output of child components, in order |
| `params` | `Record<string, string>`, optional | Route parameters, on [dynamic routes](./pages-and-fragments.md#dynamic-routes) |
| `locale` | string | Active locale code (e.g. `'fr'`, `'en'`) — always provided by the renderer, defaults to the site's locale or `'en'` |

The function returns a `RenderOutput` or a `Promise<RenderOutput>`.

A template module exports only `default` and `schema` — the CMS generates the editing form from `schema`. To replace the form with a custom editor, add a separate file under `admin/editors/`; see [Custom editors](./customize-editor.md#custom-editors).

## Template fields

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `html` | string | Yes | HTML markup |
| `css` | string | Yes | CSS (scoped per component automatically) |
| `js` | string | Yes | Client-side JavaScript (`''` for static components) |
| `head` | string | No | Content for `<head>` — favicons, fonts, meta tags |

The CSS scoping is automatic: the renderer prefixes every selector with a `[data-gz="<hash>"]` attribute selector and wraps the component's HTML in a matching container, so one component's rules don't leak into another.

`head` bubbles up the tree: the renderer joins every child's `head` into the component's own, all the way to the page. Return only the tags this template adds — the children's tags arrive on their own, and collecting them again duplicates them in the final page.

## Frameworks

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

## Composite templates

Layout templates receive `children` — the rendered output of child components. CSS and JS do not bubble: collect them from the children, or they never reach the page. `head` does bubble (see above), so a layout returns only its own additions:

```ts
// templates/page-layout/index.ts
import { z } from 'zod'
import type { TemplateFunction } from 'gazetta'

export const schema = z.object({
  title: z.string().optional().describe('Page title'),
})

type Content = z.infer<typeof schema>

const template: TemplateFunction<Content> = ({ content, children = [] }) => ({
  html: `<main>${children.map(c => c.html).join('\n')}</main>`,
  css: `main { max-width: 800px; margin: 0 auto; }
${children.map(c => c.css).join('\n')}`,
  js: children.map(c => c.js).filter(Boolean).join('\n'),
  head: `<title>${content?.title ?? ''}</title>`,
})

export default template
```
