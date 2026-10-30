# Gazetta

A stateless CMS that structures websites as composable components.

**Status:** early development, not ready for production sites. The release on npm (0.8.0) is behind `main` and its docs.

**Contribute:** [CONTRIBUTING.md](https://github.com/gazetta-studio/gazetta-studio/blob/main/CONTRIBUTING.md) explains how to pick an issue, run the tests and open a PR.

## Try it

Run Gazetta from `main` with its starter site:

```bash
# Node.js 22.22.2+ in the 22 line, or Node.js 26 (24.15+ is accepted, not tested)
git clone https://github.com/gazetta-studio/gazetta-studio.git
cd gazetta-studio
npm install
npm run dev
```

Open http://localhost:3000/admin to edit the site; http://localhost:3000 shows it.

## Key Ideas

No database. No build step. Pages are composed from reusable components at serve time.
The CMS stores nothing — all content lives in targets (filesystem, S3, Azure Blob).

- **Components** are the building block — each has a template, content, and optional children
- **Fragments** are shared components reusable across pages (header, footer, nav)
- **Pages** are components with a route and metadata
- **Templates** are pure functions `(params) => { html, css, js }` — use any framework (React, Svelte, Vue, plain TS)
- **The CMS is stateless** — it reads from and writes to targets. Lose the CMS, lose nothing.

## Project Structure

```
packages/
  gazetta/          Core package — renderer, CLI, admin API, editor, storage providers
apps/
  admin/            CMS admin frontend (Vue 3 + PrimeVue)
tools/
  mcp-dev/          MCP dev server (screenshot tool for Claude Code)
examples/
  starter/          Sample site with templates, fragments, and pages
sites/
  gazetta.studio/   The gazetta.studio website (dogfooding)
docs/
  getting-started.md  Create a site and edit it in the admin
```

## How It Works

### Site Structure

```
my-project/
  templates/             # developer-created, each with own deps
    hero/index.ts
    header-layout/index.ts
  sites/
    main/
      site.config.ts     # site config (TS)
      targets/
        local/           # the local filesystem target's content root
          fragments/     # shared components
            header/
              fragment.json  # template + inline components
            footer/
              fragment.json
          pages/         # routable components
            home/
              page.json  # route + template + inline components
            about/
              page.json
            blog/
              [slug]/    # dynamic routes
                page.json
```

### Templates

A template is a pure function that returns HTML, CSS, and JS:

```ts
import { z } from 'zod'
import type { TemplateFunction } from 'gazetta'

export const schema = z.object({
  title: z.string().describe('Title'),
  subtitle: z.string().optional().describe('Subtitle'),
})

const template: TemplateFunction = ({ content = {} }) => ({
  html: `<section><h1>${content.title}</h1><p>${content.subtitle}</p></section>`,
  css: `section { padding: 2rem; }`,
  js: '',
})

export default template
```

Templates can use any framework — React, Svelte, Vue, plain TS. The starter example
includes both plain TS templates and a React template (feature-card using `renderToStaticMarkup`).

### Manifests

Pages and fragments use JSON manifests with inline components:

```json
// pages/home/page.json
{
  "template": "page-default",
  "metadata": { "title": "Home" },
  "components": [
    "@header",
    { "name": "hero", "template": "hero", "content": { "title": "Welcome" } },
    "@footer"
  ]
}
```

### Rendering

The renderer walks the component tree bottom-up:

1. Resolve children (recursively)
2. Call the template with content + rendered children
3. Scope CSS per component (PostCSS)
4. Assemble into a complete HTML document

### Editor

Each template exports a Zod schema. The CMS converts it to JSON Schema and auto-generates
an editor form using react-jsonschema-form. Templates can also export a custom editor via
the mount function contract `{ mount(el, props), unmount(el) }`.

## Development

```bash
npm run dev              # site + CMS on http://localhost:3000
npm run dev:admin        # admin UI with standalone Vite (HMR)
npm test                 # run all tests
npm run build            # build all packages
```

## Documentation

- **[Getting Started](https://github.com/gazetta-studio/gazetta-studio/blob/main/docs/getting-started.md)** — create a site, write templates, add pages and fragments
- **[CONTEXT.md](https://github.com/gazetta-studio/gazetta-studio/blob/main/CONTEXT.md)** — the project's vocabulary: pages, fragments, targets and the rest
- **Design docs** — `.claude/rules/design-*.md`, one per feature, with the decisions behind it

## Contributing

Contributions are welcome. [CONTRIBUTING.md](https://github.com/gazetta-studio/gazetta-studio/blob/main/CONTRIBUTING.md) explains how to pick an issue, run the tests and open a PR.

How did you find Gazetta, and are you using it for anything? Tell us in [this discussion](https://github.com/gazetta-studio/gazetta-studio/discussions/1277).

## License

MIT
