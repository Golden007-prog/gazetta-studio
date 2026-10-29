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

A template is a TypeScript function that returns `{ html, css, js }`, with a Zod schema the CMS uses to build the editing form. See [`templates.md`](./templates.md) for the contract, fields, frameworks and composite templates.

## Pages and fragments

Pages define routes and fragments share components between pages. See [Pages and fragments](./pages-and-fragments.md) for manifests, dynamic routes and fragment references.

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

## Customize the editor

To replace a template's form or add a custom field widget, see [Customize the editor](./customize-editor.md).

## Publishing guide

For publishing from the admin or CLI, sync chips, unpublished-change dots, history and today's destination-undo limitation, see [Publishing](./publishing.md).

For missing-route handling and the starter 404 page, see [Custom 404 page](./pages-and-fragments.md#custom-404-page).

For `admin/theme.css`, token prefixes and light/dark overrides, see [Customize admin appearance](./customize-editor.md#customize-admin-appearance).

For the project layout and locale variants, see [Site structure](./pages-and-fragments.md#site-structure) and [Indexing localized pages](./pages-and-fragments.md#indexing-localized-pages).

## Next steps

- Browse the [starter example](../examples/starter/) for more templates
- Read the [architecture document](../.claude/rules/architecture.md) for architecture details
- Check out the [contributing guide](../CONTRIBUTING.md) to get involved
