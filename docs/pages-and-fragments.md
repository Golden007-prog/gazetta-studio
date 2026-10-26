# Pages and fragments

Pages define routes; fragments share components between pages. This guide covers their manifests, dynamic routes, translations, custom 404 pages and on-disk layout. For template code, see [Templates](./templates.md).

## Pages

A page is a folder with a `page.json` manifest under the editing target's `pages/` root, which `init` sets to `sites/main/targets/local/pages/`. The route is derived from the folder path - `pages/about/` becomes `/about`, and `pages/home/` is served at `/`:

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

Inline components live in the page manifest; shared components use fragment references such as `@header`. While `gazetta dev` runs, a new page folder is picked up without a restart.

Or create pages in the CMS - click **New page** in the admin UI.

### Dynamic routes

Use `[param]` in the folder name - it becomes `:param` in the route:

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

In `gazetta dev`, templates receive the captured route params. Published pages are pre-rendered: `serve` and the worker match the route pattern but do not re-run templates with each request's params. Do not rely on request-time `params` to generate published content.

A complete typed template for the dev-server example:

```ts
import type { TemplateFunction } from 'gazetta'
import { z } from 'zod'

export const schema = z.object({ title: z.string().optional() })
type Content = z.infer<typeof schema>

const escapeHtml = (value: string) =>
  value.replace(/[&<>"']/g, char => `&#${char.charCodeAt(0)};`)

const template: TemplateFunction<Content> = ({ content, params }) => ({
  html: `<h1>${escapeHtml(content?.title ?? params?.slug ?? '')}</h1>`,
  css: '',
  js: '',
})

export default template
```

## Fragments

Fragments are shared components reusable across pages. They live under the editing target's `fragments/` root and are referenced with `@`. For example, `fragments/header/fragment.json`:

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

Reference in any page with `"@header"`. Update the fragment once and pages using it share the change in `gazetta dev`. Published targets change only when you publish: static targets contain fully assembled pages, while dynamic targets assemble published fragments at request time. See [Targets](./targets.md#type).

## Custom 404 page

`gazetta init` already created a `pages/404/` page. It's served with a 404 status when a route doesn't match, and the URL stays as-is - no redirect.

The starter 404 uses the `page-layout` template with just a title and description. To add body content, add inline components in `pages/404/page.json` (a bare string must be a fragment reference starting with `@`, and `init` creates only a `@header` fragment):

```json
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
      "content": {
        "body": "<p>Nothing here. <a href=\"/\">Back to the homepage</a>.</p>"
      }
    }
  ]
}
```

Works with `gazetta dev`, `gazetta serve` and Cloudflare Workers. Fragments are assembled normally.

List the page in `systemPages: ['404']` in `site.config.ts` to exclude it from `sitemap.xml`; `init` sets that up. A page's `metadata.robots: "noindex"` also excludes it from the sitemap. The system-page setting does not itself add a robots meta tag.

On a static target, every publish also copies the published 404 page to `404.html` at the target root, which Cloudflare Pages, Netlify and GitHub Pages show for missing paths. Until `pages/404` is published to a target, its `404.html` is a minimal "Page not found" page.

## Translations

Store a complete manifest for each locale alongside the default manifest:

```text
pages/about/
  page.json          # default locale
  page.fr.json       # French
  page.en-gb.json    # British English
fragments/header/
  fragment.json      # default locale
  fragment.fr.json   # French
```

Locale filenames use lowercase codes. Each variant has its own `template`, `content` and `components`; it is not a field-level patch over `page.json`. Configure the site's supported locales in `site.config.ts`, for example `locales: { default: 'en', supported: ['en', 'fr'] }`.

With that configuration and the default URL-prefix settings, `pages/about/page.json` serves `/about` and `page.fr.json` serves `/fr/about`. The translated home page serves `/fr`. Dynamic routes keep the same folder pattern: `pages/blog/[slug]/page.fr.json` maps to `/fr/blog/:slug`. Targets can narrow their locale set or change the default and prefix settings.

For a French page, `@header` uses `fragment.fr.json` when available, then the configured fallback chain, then `fragment.json`. Both pages and fragments remain whole manifests. See [Targets](./targets.md) for target configuration.

## Indexing localized pages

Each locale file (for example `page.fr.json`) is a complete page manifest. Its own
`metadata.robots` controls indexing in both rendered HTML and the published sitemap:
`"noindex"` excludes that locale URL without excluding the default page, and an omitted
`robots` value permits indexing even if the default page is `noindex`. An ordinary
publish also corrects a previously published locale's stale indexing flag, even when its
content hash has not changed; `--force` is not required.

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
    main/
      site.config.ts         # site manifest + targets
      targets/
        local/               # the local filesystem target's content root
          fragments/         # shared components
            header/fragment.json
          pages/             # routable pages
            home/
              page.json      # all components inline
            about/
              page.json
            blog/
              [slug]/page.json   # dynamic route
```

Templates and admin customizations are at the project root, shared across all sites.
`site.config.ts` sits at `sites/{name}/`; the pages and fragments a site serves live in its
editing target's content root, which `init` sets to `sites/{name}/targets/local/`.
