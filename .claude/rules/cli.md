---
paths:
  - "packages/gazetta/src/cli/**"
---

# CLI Reference

Gazetta CLI commands, principles, auto-detection, and related edge cases.

## Principles

- **Zero arguments for the common case.** Single-site, single-target = no flags needed.
- **Auto-detect everything.** Site, target, mode — inferred from project structure.
- **Arguments are escape hatches** for multi-site and multi-target.

## Lifecycle

```
init → dev → publish
         ↘ build → deploy  (setup / upgrade)
```

`publish` is the daily command. `build` + `deploy` are for infrastructure setup.

## Commands

| Command | What it does | When to use |
|---------|-------------|-------------|
| `gazetta init [dir]` | Scaffold project + install deps | Once — start a new project |
| `gazetta dev` | Dev server + CMS admin | Every day — develop, edit, customize |
| `gazetta publish [target]` | Render content + push to storage | Go live — frequent, on every content change |
| `gazetta build` | Build admin UI + worker code | Before deploy or serve — infrastructure prep |
| `gazetta deploy [target]` | Deploy built worker to edge | Rare — initial setup or Gazetta upgrade |
| `gazetta serve` | Production server | Self-hosting — serves site + built admin |
| `gazetta validate` | Check for errors | Before publish — catches broken references |

```
gazetta publish                    # render + push to default target
gazetta publish production         # render + push to production
gazetta publish staging            # render + push to staging
gazetta build                      # build admin UI + worker
gazetta deploy production          # deploy worker to production
```

## Auto-detection

| What | One | Multiple (local) | Multiple (CI) | Override |
|------|-----|-------------------|---------------|----------|
| **Site** | Auto-select | Prompt user to choose | Fail with error | `gazetta dev my-site` |
| **Target** | Auto-select | Prompt user to choose | Fail with error | `gazetta publish production` |

CI is detected via `CI=true` environment variable (set by GitHub Actions, GitLab CI, etc.).

```
# One site, one target — zero arguments:
gazetta dev                               # auto-detects
gazetta publish                           # auto-detects

# Multiple sites — local prompts, CI fails:
gazetta dev
> ? Select site: (use arrow keys)
>   my-site
>   another-site

# Multiple targets — same:
gazetta publish
> ? Select target: (use arrow keys)
>   staging
>   production

# CI — must be explicit:
CI=true gazetta publish
> Error: multiple targets found. Specify one: gazetta publish staging

# Explicit always works:
gazetta dev my-site
gazetta publish production
gazetta publish production my-site
```

## Command Details

### `gazetta init [dir]`

Scaffolds a new project and runs `npm install`. Ready to `gazetta dev` immediately.

```
$ npx gazetta init my-site
$ cd my-site
$ gazetta dev

Creates:
  my-site/
    package.json           # workspaces: ["admin", "templates"]
    admin/
      package.json         # gazetta, react, react-dom
      editors/             # (empty — ready for custom editors)
      fields/              # (empty — ready for custom fields)
    templates/
      package.json         # gazetta, react, zod
      hero/index.tsx       # starter template
      page-default/index.tsx
    sites/
      main/
        site.config.ts     # name + filesystem staging target
        fragments/
        pages/
          home/page.json
```

### `gazetta dev`

The developer's primary command. Starts everything needed for local development.

- Auto-detects site in `sites/`
- Loads templates from `templates/`
- Starts Hono server (site routes + admin API + preview)
- Starts Vite dev server (admin SPA + HMR)
- Injects Vite config: `resolve.alias: { '@site': projectRoot }`, `server.fs.allow`
- Custom editors/fields loaded via Vite from `admin/editors/`, `admin/fields/`
- Dev playground at `/admin/dev`
- File watcher for template/content hot reload via SSE
- Output: `http://localhost:3000` (site), `http://localhost:3000/admin` (CMS)

### `gazetta publish [target]`

Renders content and pushes it to a target. The daily production command.

- Auto-detects site + target (first target if not specified)
- Renders pages and fragments using templates (SSR)
- Uploads to target storage (R2, S3, Azure Blob, filesystem)
- Handles ESI vs static mode based on target config
- Purges CDN cache if configured

```
gazetta publish                # render + push to default target
gazetta publish production     # explicit target
gazetta publish staging        # different target
```

### `gazetta build`

Builds the admin UI and worker code. Run before `deploy` or `serve`.

- Builds admin SPA via Vite `build()` API → `dist/admin/`
- Bundles custom editors/fields with esbuild → `dist/admin/editors/`, `dist/admin/fields/`
- Generates import map for shared deps → injected into `dist/admin/index.html`
- Generates worker code per target (each target has its own storage/cache config) → `dist/workers/{target}/`

### `gazetta deploy [target]`

Calls `target.deploy.execute(ctx)` on the configured `DeployAdapter`. Rare — only on initial setup or platform changes. Independent of `gazetta publish` per ADR-0010.

- Reads `target.deploy` (a Path X factory result; see [`docs/deploy.md`](../../docs/deploy.md))
- Errors with a clear message if `target.deploy` is unset
- Adapters bundle their own platform glue (worker code, push-to-branch, container image, etc.)
- Currently shipped: `cloudflareWorkersDeploy()`
- Downstream adapters in flight: Cloudflare Pages + Functions (#204), Vercel Edge (#206), Netlify static (#209), and others — see [`docs/deploy.md`](../../docs/deploy.md)
- Container hosts (Fly.io, Cloud Run, Railway, Render) use platform CLIs, NOT a Gazetta deploy adapter — see [`docs/container-deployment.md`](../../docs/container-deployment.md)

```
gazetta deploy production      # invoke target.production.deploy.execute()
gazetta deploy staging
```

### `gazetta serve`

Production server. For self-hosting on a VPS, container, or local machine.

- Auto-detects site + target
- Serves site: ESI assembly from target storage (published content via `gazetta publish`)
- Serves the site only. The admin (built SPA + API) runs separately with `gazetta admin` (`runAdmin` in `cli/index.ts`); `runServe` doesn't mount it.

### `gazetta validate`

Checks the project for errors before publishing.

- Validates template references, fragment references, page manifests
- Future: target connectivity, env var validation, custom editor/field checks

## Consistent Positional Arguments

All commands that take a target use positional args:

```
gazetta publish production        # positional target
gazetta deploy production         # positional target
gazetta serve production          # positional target (not --target)
```

## Running CLI Commands

Three ways to run CLI commands:

```
npm run dev                     # via root package.json scripts (recommended)
npx gazetta dev                 # via npx (always works)
./node_modules/.bin/gazetta dev # direct binary path
```

`npm run dev` is recommended — no PATH issues, works everywhere. `npx` is for
one-off commands before scripts are set up. Global install (`npm install -g gazetta`)
is not recommended — keeps the version tied to the project.

## CLI Availability

`admin/package.json` lists `gazetta` as a dependency. npm hoists it to the project root.
After `npm install`, the `gazetta` binary is available at `./node_modules/.bin/gazetta`.
Scripts in root `package.json` can use `gazetta` directly. For shell usage, developers
use `npx gazetta dev` or add to PATH. `gazetta init` uses `npx gazetta init` (before install).

## Project Root Detection

CLI commands find the project root by walking up from the current directory looking for
`package.json` with `workspaces` containing `"admin"` and `"templates"`. Templates are
at `{projectRoot}/templates/`, admin at `{projectRoot}/admin/`, sites at `{projectRoot}/sites/`.

## Console Output

```
$ gazetta dev

  Gazetta running at http://localhost:3000

  Site: My Site (sites/main)
  Pages:
    / → home
    /about → about
    /blog/:slug → blog/[slug]
  Fragments: header, footer
  CMS: http://localhost:3000/admin (dev mode + HMR)

  Template changed: hero
  site.config.ts changed — config reloaded
  ← GET /about 200 45ms
  ← GET /admin/api/pages 200 12ms
```

Request logging uses hono logger. Template/config changes are highlighted.
Colors in terminal (suppressed in CI).

## Port Configuration

`gazetta dev` and `gazetta serve` default to port 3000. Override with `--port` or `-p`:

```
gazetta dev --port 4000
gazetta serve -p 8080
```

`gazetta dev` listens on `127.0.0.1` only, and so does `gazetta admin` while `admin.auth` is `trust: 'none'`: they serve the admin API, and without auth anyone who reaches them is an admin. `gazetta admin` with real auth configured listens on every interface, because it runs behind a proxy or load balancer. `gazetta serve` (site only) listens on every interface, for containers. `--host <address>` overrides either, e.g. `gazetta dev --host 0.0.0.0` to preview from a phone on the same network (#1074). `--host` on any other command is an error.

## Exit Codes

All CLI commands use standard exit codes:
- `0` — success
- `1` — error (validation failures, publish errors, missing config)
- Non-zero exit is critical for CI pipelines.

## Error Messages

CLI shows helpful errors when arguments don't match:

```
gazetta publish productoin
> Error: target "productoin" not found in site.config.ts.
> Available targets: staging, production
```

## Files Created by `gazetta init`

```
my-site/
  package.json             # see below
  .gitignore               # node_modules/, dist/, .env.local
  .env                     # empty, with comments for common vars
  tsconfig.json            # paths: { "@templates/*": ["./templates/*"] }
  admin/
    package.json           # { name: "admin", ... }
    tsconfig.json          # jsx, strict, browser target
  templates/
    package.json           # { name: "templates", ... }
    tsconfig.json          # jsx, strict, node target
  sites/main/
    site.config.ts
    ...
```

Root `package.json`:
```json
{
  "name": "my-site",
  "private": true,
  "type": "module",
  "engines": { "node": ">=22" },
  "workspaces": ["admin", "templates"],
  "scripts": {
    "dev": "gazetta dev",
    "publish": "gazetta publish",
    "build": "gazetta build"
  }
}
```

Workspace names are `"admin"` and `"templates"` (short, no scope). `private: true`
on all three prevents accidental npm publish.

## TypeScript Configuration

`gazetta init` creates `tsconfig.json` at the project root covering `admin/` with `@templates`
paths alias. Templates have their own `tsconfig.json` inside `templates/` with appropriate
compiler options (jsx, strict, etc.). Two tsconfigs — one per compilation context (browser vs server).

## Running from Subdirectories

`gazetta dev` (and other commands) can run from any subdirectory within the project.
The CLI walks up from the current directory to find the project root (see project root
detection above). `gazetta dev` from `templates/hero/` works the same as from the root.

## Node.js Version

`gazetta init` adds `engines: { "node": ">=22" }` to root `package.json`. `gazetta dev`
checks the Node version on startup and errors if too old:

```
gazetta dev
> Error: Gazetta requires Node.js 22 or later. Current: 18.19.0
```

## Missing `npm install`

If `node_modules/` doesn't exist, `gazetta dev` errors immediately:

```
gazetta dev
> Error: node_modules not found. Run `npm install` first.
```

## Build Idempotency

`build` cleans `dist/` before building. Running it twice produces identical output.
Stale files from previous builds are removed. `dist/` is always a fresh, complete output.

`dist/` is never committed — it's in `.gitignore`. After `git clone`, the developer must
run `gazetta build` to regenerate it. CI/CD pipelines should also run `build` before `deploy`.

## Build Skips Targets Without Worker-Capable Deploy Adapters

`build` generates worker code only for targets whose `deploy` adapter implements
`WorkerCapableDeployAdapter` (e.g., `cloudflareWorkersDeploy()`). Static targets,
adapters without worker bundling (e.g., a future `githubPagesDeploy`), and targets
with no `deploy:` field are skipped — no worker to build.

## `gazetta init` in Existing Directory

`gazetta init .` in a non-empty directory errors if conflicting files exist (package.json,
templates/, etc.). Safe to run in a directory with only `.git` or unrelated files.
`gazetta init my-site` always creates a new directory — errors if it already exists.

## `gazetta init` Failure Recovery

If `npm install` fails after scaffolding (network error, wrong Node version), the
project directory is kept with all scaffolded files. The developer fixes the issue
and runs `npm install` manually. Init does NOT delete the directory on failure.

## Site Naming

`gazetta init` creates `sites/main/` by default. The name "main" has no special meaning —
the developer can rename it to anything. Auto-detection uses "only one directory in `sites/`"
regardless of name. For multi-site, names are chosen by the developer.

## System Pages (404, 500)

`gazetta init` scaffolds a 404 page:

```
sites/main/
  pages/
    404/page.json    # template: page-default, route: /404
    home/page.json
```

The runtime serves the 404 page for unmatched routes. If no 404 page exists, the runtime
returns a plain text "Not found" response. 500 errors show a generic error page (no
custom template — future).

`site.config.ts` `systemPages` field lists system pages: `systemPages: [404]`

## Publish Progress Output

`gazetta publish` shows progress:

```
gazetta publish production
  Rendering pages...
    ✓ home (120ms)
    ✓ about (85ms)
    ✗ blog/broken-post — Template error: Cannot read property 'title' of undefined
    ✓ blog/hello-world (95ms)
  Rendering fragments...
    ✓ header (45ms)
    ✓ footer (30ms)
  Uploading to production (r2://my-site)...
    ✓ 5 pages, 2 fragments uploaded (1.2s)
  Published 4/5 pages, 2/2 fragments. 1 failed.
```

Verbose mode (`--verbose`) shows individual file uploads. Quiet mode (`--quiet`) shows
only the summary line.

## Publish Storage Layout

`gazetta publish` uploads to target storage with this layout:

```
# ESI mode:
pages/{name}.json           # page manifest (route, components, metadata)
pages/{name}/*.html         # pre-rendered component HTML
fragments/{name}/*.html     # pre-rendered fragment HTML
site.json                   # site manifest
fragment-index.json         # fragment → pages dependency map

# Static mode:
pages/{route}/index.html    # fully assembled HTML per route
```

## Partial Publish from CLI

`gazetta publish` renders all pages by default. To publish a single page:

```
gazetta publish production --page home
gazetta publish production --fragment header
```

Useful for fixing one page without re-rendering the entire site. The admin UI already
supports per-page publish via the Publish button.

## Adding a New Storage Provider

Storage providers implement `StorageProvider` interface in `packages/gazetta/src/`:
1. Create `storage/{name}.ts` implementing `readFile`, `readDir`, `exists`, `writeFile`, `mkdir`, `rm`
2. Register in `targets.ts` factory (`createStorageProvider`)
3. Add `type` option to `StorageConfig` union in `types.ts`
4. Document in configurations.md under Storage Providers

## Adding a New Edge Platform

Edge platforms ship as Pattern 1 deploy adapters per ADR-0008 + ADR-0010:
1. Worker runtime in `packages/gazetta/src/workers/{platform}.ts` (if needed)
2. Adapter factory in `packages/gazetta/src/deploy/{platform}.ts` returning a
   `DeployAdapter` (or `WorkerCapableDeployAdapter` for worker-bundling platforms)
3. Public export from `packages/gazetta/src/index.ts`
4. Declare `supports: readonly TargetType[]` per the deployment matrix in
   [`design-rendering.md`](design-rendering.md) Q6
5. Document in [`docs/deploy.md`](../../docs/deploy.md)
