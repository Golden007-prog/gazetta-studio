---
paths:
  - "packages/gazetta/src/**"
  - "examples/starter/**"
  - "sites/*/site.config.ts"
---

# Operations and Edge Cases

Runtime behavior, security, caching, content management, publishing details, platform considerations, and known gaps.

## Security

**Preview iframe:** The admin UI's preview iframe uses the `sandbox` attribute to restrict
scripts and navigation. Templates should sanitize user-controlled content — Gazetta does
not sanitize template output.

**`.env` files:** the CLI loads `.env` and `.env.local`, and the generated `.gitignore`
excludes both, so credentials in either file stay out of git.

**Rate limiting:** `gazetta serve` does not include rate limiting. For production, use a
reverse proxy (Caddy, nginx, Cloudflare) for rate limiting and DDoS protection. Future:
built-in rate limiting on auth endpoints.

**CORS:** Same-origin by default (single process serves SPA + API). For split deployments,
configure allowed origins in `site.config.ts`:

```ts
defineSite({
  admin: {
    cors: {
      origins: ['https://admin.mysite.com'],
    },
  },
})
```

**Content author permissions:** Basic auth is binary — authenticated users have full access.
No role-based permissions (e.g. "can edit but not publish"). Future: role-based access
control with editor/publisher/admin roles.

**Audit log:** No built-in audit log for publishes. Content changes tracked via git
(`sites/` is committed). Publish actions logged to stdout — pipe to a log aggregator
for audit trail.

## `.env` Loading

CLI loads `.env` and `.env.local` from the **project root** (where `package.json` with
workspaces lives), not from inside `sites/`. This is where credentials and environment
variables are configured. Skipped when `CI=true`.

## Caching

**`gazetta dev`:** No caching. Every request re-renders from source. Dev server sends
`Cache-Control: no-store` to prevent browser caching. Always fresh.

**`gazetta serve`:** No in-memory cache yet (#76). On ESI targets (`type: 'dynamic'`), live pages at their routes get `Cache-Control: public, max-age=<browser>, s-maxage=<edge>` plus an ETag for 304, from the target's `cache` config (and per-page overrides), which publish writes into each page:
- `browser: 0` → `max-age=0` (browser revalidates every request)
- `browser: 86400` → `max-age=86400` (browser caches 24h)
- `edge: 86400` → `s-maxage=86400` (CDN caches 24h)

Live pages on static targets (the default type), at their routes, always get `Cache-Control: public, max-age=0, must-revalidate` with an ETag, whatever `cache` says: browsers and CDNs revalidate every request, so a publish shows at once with no purge step. This is intended. On both target types, archived pages answer 301 or 410 with `max-age=300` (`design-soft-delete.md` Q10).

Decided: maintainer, 2026-10-24 (#1243)

ETag enables conditional requests — browser sends `If-None-Match`, server returns 304 if unchanged.

**Cloudflare Worker:** Uses Cache API. `edge` TTL controls how long the CDN caches pages.
`cache.purge` runs on publish — purges updated URLs from CDN. Browser cache (`browser` TTL)
is NOT purgeable — users see stale content until it expires.

**Recommended strategy:** `browser: 0` (always revalidate) + `edge: 86400` (CDN caches, purged on publish).
This gives instant updates after publish while minimizing origin requests.

The admin SPA uses content-hashed filenames (`app.3fa2b1.js`) — cached forever by browsers,
cache-busted on each build.

## Content Validation

Content is validated against the template's Zod schema at multiple points:

| When | What happens |
|------|-------------|
| `gazetta dev` (preview) | Schema validation on render. Invalid content → error overlay in preview. Extra fields passed through (not stripped). |
| `gazetta publish` | Schema validation before render. Invalid content → page skipped, error logged. |
| `gazetta validate` | Checks all content against all schemas. Reports all mismatches. |
| Admin UI (editor) | Live validation in the form (via @rjsf). Extra fields stripped (`omitExtraData`). |

## CSS and JS Assembly

Templates return `{ html, css, js, head? }`. The renderer assembles these per-page:
- **CSS:** collected from all components, deduplicated, injected as `<style>` in `<head>`
- **JS:** collected from all components, injected before `</body>`
- **head:** collected from all components (fonts, meta tags), injected in `<head>`

Static and SSR components ship zero JS. Only islands ship JS to the browser. See
design-concepts.md for the islands architecture and import map deduplication.

## Route Parameters in Templates

Templates receive route parameters via the `params` argument:

```tsx
const template: TemplateFunction = ({ content, params }) => {
  // params.slug is available for dynamic routes (/blog/:slug)
  return { html: `<h1>${content.title} - ${params?.slug}</h1>`, css: '', js: '' }
}
```

## Multi-site Operations

**Target resolution order:** site first, then target.
1. Auto-detect or specify site → determines which `site.config.ts` to read
2. Auto-detect or specify target → looked up in that site's `site.config.ts`

Two sites can have targets with the same name (e.g. both have "production") — they're
independent. `gazetta publish production my-site` resolves unambiguously.

**Republishing after template changes:** Templates are shared across sites. If a template
changes, all sites using it may need republishing. `gazetta publish` publishes one site
at a time:

```
gazetta publish production my-site
gazetta publish production another-site
```

Future: `gazetta publish --all` to publish all sites in one command.

**Switching sites in admin UI:** When running `gazetta dev` with multiple sites, the
auto-detected (or specified) site is shown in the admin UI. To switch sites, restart
the server: `gazetta dev other-site`. Future: site picker in the admin UI toolbar.

**Sharing targets between sites:** Not recommended. Two sites publishing to the same
storage bucket may overwrite each other's content (both have `pages/home/`). Each site
should have its own target with separate storage. If sharing is needed, use different
route prefixes or different storage paths per site.

## Template Behavior

**Hot reload:** During `gazetta dev`, file watcher detects changes:
- **Template `.ts`/`.tsx` change** → invalidates template cache, triggers SSE reload. Preview
  refreshes automatically. No server restart needed (jiti hot-reloads the module).
- **Content YAML change** → triggers SSE reload. Preview refreshes.
- **Custom editor/field change** → Vite HMR updates the editor in-place (no page refresh).

**Hot reload vs editor state:** Template file change → SSE triggers preview iframe reload.
The editor panel is NOT reloaded — form state (undo stack, unsaved changes, scroll position)
is preserved. If the template's **schema** changes (field added/removed), the editor detects
the schema mismatch on next save attempt and offers to remount with the new schema.

**Hot reload for site.config.ts:** `gazetta dev` watches `site.config.ts` for changes. Target config
changes (new target, updated credentials) are picked up without restart. The dev server
logs: "site.config.ts changed — config reloaded."

**Authoring errors — clear messages for common mistakes:**

| Error | Message |
|-------|---------|
| No default export | "Template 'hero' has no default export. Add: export default (params) => ({ html, css, js })" |
| No schema export | "Template 'hero' has no schema. Add: export const schema = z.object({ ... })" |
| Render returns non-string | "Template 'hero' returned non-string html (got null). Return { html: string, css: string, js: string }" |
| Schema is not Zod | "Template 'hero' schema is not a Zod type. Use z.object({ ... })" |

All errors show the template name and file path. During `dev`, shown in the error overlay.
During `publish`, the page is skipped with the error logged.

**Template errors during publish:** `gazetta publish` renders all pages. If a template
throws during SSR, the error is logged with the page name and template, the page is
skipped (not uploaded), publishing continues with remaining pages, exit code is non-zero
if any page failed, and the summary shows: "Published 48/50 pages. 2 failed."

**Side effects:** Templates should be **pure functions** — no side effects during render.
Avoid writing to disk, making mutating network requests, or modifying global variables.
Side effects run on every render (dev preview, publish, serve). `gazetta validate` does
not detect side effects — this is a developer responsibility.

**Import limitations:** Templates run in Node.js via jiti. Supported imports:

| Import type | First load (native) | Hot reload (jiti) | Notes |
|-------------|--------------------|--------------------|-------|
| TypeScript/TSX | Yes | Yes | Full support |
| ESM JavaScript | Yes | Yes | Full support |
| JSON | Yes | Yes | `import data from './data.json'` works |
| WASM | Yes (Node 22+) | May fail | Use native import only — avoid hot reload for WASM templates |
| CSS modules | No | No | Not supported — templates return CSS as strings |
| Binary files | No | No | Use `fs.readFileSync` instead |

Templates must return CSS as strings in the `css` field — CSS imports are not supported
because templates run in Node, not a bundler.

**Naming convention:** Template names cannot start with `@` — the `@` prefix is reserved
for fragment references in component lists. Use lowercase-kebab-case: `hero`, `page-default`,
`buttons/primary`.

**Shared code within templates:**

```
templates/
  _shared/               # shared code — NOT a template (no index.tsx)
    css-reset.ts
    format-date.ts
  hero/index.tsx         # imports from ../_shared/format-date
  blog-post/index.tsx    # imports from ../_shared/format-date
```

Convention: directories starting with `_` are ignored by template discovery. They're
internal code, not templates. Same applies to `admin/fields/_shared/`.

**Native dependencies:** Templates using native modules (sharp, canvas, better-sqlite3)
require matching architecture between dev and CI/deploy environments, system libraries in
Docker (e.g. `apt-get install libvips-dev` for sharp), and platform-specific npm install.
This is a Node.js concern, not Gazetta-specific.

**Empty template schema:** `export const schema = z.object({})` — no content fields. Valid.
Used for pure layout templates (header-layout, footer-layout) that only arrange children.
The editor shows "No editable content. Edit its children instead."

**Render timeouts (not implemented):** Templates that fetch external data during SSR can
be slow. There is **no per-page render timeout today** — a hung template hangs the dev
server or publish run until the process is killed. Future: configurable timeouts (e.g.
10s dev / 30s publish) with error-overlay / skip-with-error behavior. For now, pre-fetch
data and pass it as content, or use dynamic components (SSR at request time, not publish time).

## Content Operations

**Dynamic routes and content:** Pages with dynamic routes (`route: /blog/:slug`) represent
parameterized content. During `gazetta dev`, the slug is extracted from the URL. Multiple
"instances" of a dynamic route are separate directories (e.g. `blog/hello-world/`,
`blog/another-post/`). During `gazetta publish`, each instance directory is rendered
separately — producing one HTML file per slug in storage.

**Component list in page.json:** The `components` list is the source of truth for component
ordering. The admin UI's component tree shows this list. Content authors can reorder via
drag-and-drop, add components via dialog, and remove components. Each operation joins the
editor's pending-changes model (peer to content edits) and is persisted to `page.json` on
explicit save — same dirty-dot, same Save button, same Discard semantics. The tree reflects
pending state immediately so authors see what they're about to commit.

**Fragment nesting:** Fragments can reference other fragments: `@header` can include `@logo`
as a child component. The renderer resolves `@` references recursively. Circular references
are detected and reported: "Circular fragment reference: A → B → A". The page is not rendered.
`gazetta validate` checks for cycles.

**Unused fragments:** Fragments referenced by no page are not an error. `gazetta publish`
renders all fragments regardless of usage — they may be used by other sites or added to
pages later. `gazetta validate` warns about unused fragments.

**Fragment dependency tracking:** For ESI mode, fragments are stored independently — no
dependency tracking needed. For static mode, pages bake fragments inline. `gazetta publish`
re-renders ALL pages by default. Future: dependency graph for incremental static publish.

**Internationalization (i18n):** Multi-language sites use separate pages per locale:

```
sites/my-site/
  pages/
    home/page.json           # English (default)
    fr/home/page.json        # French
    de/home/page.json        # German
```

Each locale is a separate page with its own content and route. Templates are shared.
No built-in translation framework — content is managed per-page. `site.config.ts` `locale`
field sets the default locale for metadata (lang attribute, etc.).

**Static assets (images, fonts, CSS):** Static assets live in `sites/my-site/public/`.
During `gazetta dev`, they're served at the root URL. During `gazetta publish`, they're
uploaded alongside rendered pages. Templates reference them with absolute paths
(`/images/hero.jpg`). Content authors add images via URL in the CMS editor.

**Content recovery from storage:** ESI targets store page/fragment manifests (JSON) —
content is recoverable via `gazetta fetch`. Static targets store rendered HTML — source
content is lost, recovery not possible. Content is also in git (YAML files in `sites/`).
Git is the primary backup mechanism.

**Large content files:** YAML parsing is synchronous. Very large content files (10,000+
lines) may block the event loop during `gazetta dev`. Keep content fields concise — large
content should use markdown or rich text fields, not inline YAML blocks.

**Component nesting depth:** No hard limit on nesting. The renderer is recursive. Extremely
deep nesting (100+ levels) may overflow Node's call stack. In practice, sites rarely exceed
5-10 levels. **No nesting-depth warning is implemented today** — future: `gazetta validate`
warns if nesting exceeds 20 levels.

## Publishing Details

**Admin UI publish button vs CLI publish:** Both use the same render pipeline. The admin UI
`POST /api/publish` renders the specific page/fragment being edited. CLI `gazetta publish`
renders all pages and fragments. Same SSR, same storage upload, different scope.

**Incremental publish:** `gazetta publish` currently renders ALL pages and fragments on
every run. For large sites (100+ pages), this is slow. Future: incremental publish that
tracks which templates/content changed and only re-renders affected pages.

**Publish idempotency and diffing:** `gazetta publish` currently uploads ALL rendered
files on every run. No content hashing or skip-if-unchanged logic. For cloud storage,
this means paying for PUT operations on every publish even if content hasn't changed.
Future: content-hash diffing. `gazetta publish --force` to bypass diffing.

**Publish freshness:** `gazetta publish` always loads templates fresh (new Node process,
empty cache). It never uses stale templates — even if `gazetta dev` is running
simultaneously with a different cached version. Both processes are independent.

**Accidental publish to production from dev:** Targets declare semantic intent via the
`environment` field — `local`, `staging`, or `production`. Default: `local` for any
target that doesn't set it. Production targets must be marked explicitly — the default
is safe, not alarming, so a forgotten `environment` on a cloud target never produces
surprise prod chrome. The admin UI publish dialog requires an explicit confirmation
step ("Yes, publish to production") for any selected target with `environment:
production`. The Publish button is also disabled while compare is loading to prevent
accidental fallback to a single-item publish.

CLI publish does not currently prompt. CI (`CI=true`) is unaffected.

**Storage upload behavior:**

| Provider | Upload mode | Concurrency | Retry | Rate limits |
|----------|-----------|-------------|-------|-------------|
| Filesystem | Sequential | 1 | No | N/A |
| R2 (REST) | Sequential | 1 | No | N/A |
| R2 (S3 API) | Parallel | 10 | Yes (3 retries) | 1000 req/s |
| S3 | Parallel | 10 | Yes (3 retries) | 3500 PUT/s |
| Azure Blob | Parallel | 10 | Yes (3 retries) | 20000 req/s |

**Storage connectivity check before publish (not implemented):** Future: `gazetta publish`
should check storage connectivity before rendering (lightweight read on target storage) so
authors don't waste time rendering pages only to fail on upload. Today, connectivity is
validated implicitly — the first write or list fails with the underlying SDK's error.
`TARGET_INIT_TIMEOUT_MS` (see `targets.ts`) guards against hangs during provider init,
which is the closest existing behavior.

**Storage quota errors:** When target storage quota is exceeded, `gazetta publish` shows
the error and stops — remaining pages are not uploaded.

**Storage consistency:** S3/R2 provide strong read-after-write consistency for new objects
but eventual consistency for overwrite PUTs (~1-2 seconds). CDN cache purge propagation
adds additional delay (Cloudflare: ~2-5 seconds globally). For immediate consistency:
use filesystem storage + `gazetta serve`.

**Credential validation:** `gazetta validate --target production` checks storage credentials
by attempting a small read operation. Reports clear error if credentials are expired,
invalid, or missing.

## Admin UI Behavior

**Keyboard shortcuts:**

| Shortcut | Action | Where |
|----------|--------|-------|
| `Ctrl/Cmd + S` | Save current component | EditorPanel.vue |
| `Ctrl/Cmd + Z` | Undo last field edit (form-scoped, 50-entry stack) | packages/gazetta/src/editor/mount.tsx |
| `Ctrl/Cmd + Shift + Z` | Redo field edit | packages/gazetta/src/editor/mount.tsx |
| `Escape` | Close dialog / exit edit mode | UnsavedDialog, EditorView, DevPlayground |

Undo/redo is scoped to the active form's field edits (the default `@rjsf` editor). It
does not undo target-level writes — that's the save-toast Undo affordance or the history
panel. Stack is reset when the editor remounts (e.g. switching to a different component).

**Server disconnect:** If `gazetta dev` crashes while the admin UI is open, API calls fail
and admin shows "Server disconnected. Waiting for reconnect..." SSE auto-reconnect attempts
every 2 seconds. When dev server restarts, SSE reconnects, preview refreshes. Unsaved
changes in the editor are preserved (React state survives server disconnect).

**Browser extensions:** Browser extensions (Grammarly, ad blockers, React DevTools) may
interfere with the admin UI. If the admin behaves unexpectedly, try disabling browser
extensions or using incognito mode.

**Fragment preview URLs:** During `gazetta dev`, fragments can be previewed in isolation
at `/preview/@header`, `/preview/@footer`. Used by the admin UI's preview panel when a
fragment is selected. Not intended for end users.

**Admin API template discovery:** The admin API needs access to the project root (for
`templates/`) and the site dir (for `sites/my-site/`). `gazetta dev` passes both paths.
The API's `GET /api/templates` reads from `{projectRoot}/templates/`, not from the site dir.

## Platform Considerations

**Platform support:** Gazetta is tested on macOS and Linux; Windows runs an end-to-end smoke test on pushes to `main` (`ci.yml`). Contributors on Windows run the tests in WSL (`CONTRIBUTING.md`). Windows: Node.js handles path
separators via `path.join`, YAML is line-ending agnostic. Template names are **case-sensitive**
— `Hero` and `hero` are different templates, even on case-insensitive filesystems.
Recommendation: use lowercase-kebab-case.

**Symlinks:** Symlinks are followed for template and content resolution. File watcher follows
symlinks on macOS (FSEvents) and Linux (inotify). Caveats: symlink targets outside the
project root may not be covered by `server.fs.allow`, file watcher may not detect changes
on all platforms. Recommend copying or npm packages instead.

**Special characters in names:** Template and site names should use **lowercase-kebab-case**.

| Character | In template names | In site names | In field names |
|-----------|------------------|---------------|----------------|
| Letters, numbers, hyphens | Yes `hero`, `blog-post` | Yes `my-site` | Yes `brand-color` |
| Subfolders (slash) | Yes `buttons/primary` | No | Yes `colors/brand` |
| Dots | Avoid — confuses URL routing | Avoid | Avoid |
| Unicode | Works but not recommended | Works but not recommended | Works but not recommended |
| Spaces, uppercase | No | No | No |

**macOS open file limit:** Large projects may hit the default limit (256). Symptoms:
`EMFILE: too many open files`. Fix: `ulimit -n 10240` (temporary), add to `~/.zshrc`
for permanent.

**File watcher debouncing:** The file watcher debounces rapid saves (IDE auto-save, batch
file operations). Multiple saves within 100ms are coalesced into one reload. Prevents
unnecessary re-renders and avoids loading partially-written files.

## Performance

**Startup:** `gazetta dev` loads templates lazily — only when a page is first requested.
File watcher registers all template files but doesn't import them. Startup is fast
regardless of template count. First request has a cold-start delay (~50-200ms for jiti import).

**Rendering:**

| Site size | Render time | Upload time (parallel) |
|-----------|-------------|----------------------|
| 10 pages | ~2 seconds | ~1 second |
| 100 pages | ~20 seconds | ~5 seconds |
| 500 pages | ~100 seconds | ~15 seconds |

Templates share a process — heavy SSR (image processing, API calls during render) slows
all pages. Keep templates lightweight. Future: parallel rendering with worker threads.

**Known scaling limits:**

| Dimension | Tested | Expected limit |
|-----------|--------|----------------|
| Templates | 50+ | No hard limit — lazy loading |
| Pages per site | 500+ | Limited by publish time (sequential render) |
| Sites | 10+ | No hard limit — independent |
| Components per page | 50+ | Deep nesting (100+) may stack overflow |
| Custom editors | 20+ | No hard limit — loaded on demand |
| Fragment nesting depth | 10+ | Circular detection (implemented); depth warning at 20 is future |

## Dev Server

**Error recovery:** When a template has a syntax error: jiti import fails, error logged
with file path and line number, preview shows error overlay, developer fixes the file,
file watcher detects change, jiti reloads, preview auto-refreshes. No restart needed.
Errors are debounced — rapid saves don't flood the console.

**Error pages in dev mode:** Template error → styled error overlay with stack trace, file
path, and line number (similar to Vite's error overlay, auto-refreshes on fix). 404 →
plain "Page not found" with available routes. Admin preview uses the same error overlay.

**Broken references during dev:** `gazetta dev` renders pages with errors inline — not a crash.
Missing template → error overlay, missing fragment → error overlay, template SSR error → error
overlay with stack trace. The admin tree still works — fix the reference and preview auto-refreshes.

**`gazetta dev` without targets:** Works. Dev mode renders on-the-fly from source and doesn't
need targets. The admin UI's Publish button is disabled if no targets are configured.

**No pages in site:** If all pages are deleted, `/` → 404, `/admin` → admin UI works (empty
site tree, "New page" button available). Pages can be created from admin UI or by adding
`page.json` files.

**Browser auto-open:** `gazetta dev` does NOT auto-open the browser. Future: `--open` flag.
Root `package.json` scripts can add `--open`: `"dev": "gazetta dev --open"`.

## Project Lifecycle

**Renaming templates:** Renaming a template (e.g. `hero` → `banner-hero`) requires updating
the template directory, all YAML references, custom editor, and type imports. `gazetta validate`
catches broken references. No automated rename command (future).

**Deleting a site:** Delete the `sites/{name}/` directory. Published content in target storage
is NOT automatically removed — it remains as orphaned files. Future: `gazetta clean [target]`.

**Schema changes and content compatibility:** If a template's schema changes (new required
field, type change), existing content may not satisfy the new schema. `gazetta validate`
checks content against schemas. During `dev`, error overlay; during `publish`, invalid
pages skipped.

**Version upgrades:** No migration tooling exists. Update version in both `admin/package.json`
and `templates/package.json`, run `npm install`, check for breaking changes. Template contract
changes reported by `gazetta validate`. Storage format re-rendered on publish. Editor API
changes caught by TypeScript at compile time. New site.config.ts fields are backward compatible.

**Multiple developers:** Each developer runs their own `gazetta dev` on a different port.
Content changes (YAML) may conflict in git — standard merge conflict resolution. No
collaborative real-time editing.

**Git and content authoring:** Content (YAML in `sites/`) is committed to git. The admin UI
writes to the local filesystem. Content authors must commit their changes manually (or via
git hook). No auto-commit.

**Concurrent publish safety:** `gazetta publish` and admin UI publish can run concurrently
without corruption — each renders independently, uploads to the same storage. Last write
wins. For teams, publish from CI (on merge to main) is recommended.

**Sites without `site.config.ts`:** A directory in `sites/` without `site.config.ts` is ignored by
auto-detection. Not an error.

**Disaster recovery:** Source of truth is **git** (templates, content YAML, site config).
Published content in storage can always be regenerated:

```
git clone <repo> && cd my-project
npm install
gazetta publish production     # regenerates all published content
```

**Migration from flat to new structure:** Existing sites (flat structure) continue to work.
CLI detects structure by checking for `admin/` and `templates/` directories. If not found,
falls back to flat behavior. Migration is manual. Future: `gazetta migrate` command.

**Gazetta version across workspaces:** Both `admin/package.json` and `templates/package.json`
should use the same version range. `gazetta validate` checks for mismatches:

```
⚠ gazetta version mismatch:
  admin: 1.2.0
  templates: 2.0.0
  Use the same version range in both workspaces.
```

**React peer dependency:** `gazetta` has `peerDependencies: { react, react-dom }`. Templates
that don't use React will see a peer dep warning on install. This is acceptable — the peer
dep is required for the editor (@rjsf), even if templates don't use React.

## Testing, Preview, and Accessibility

**Template and editor testing:** Templates have their own `package.json` — add test scripts.
Template tests: import the render function, call it with mock content, assert HTML output.
Editor tests: mount the EditorMount into a DOM element (jsdom), simulate onChange.
`gazetta init` scaffolds a basic test setup.

**Preview accuracy:** `gazetta dev` renders on-the-fly using the same renderer as `gazetta publish`.
Output should be identical. Exception: non-deterministic values (`Date.now()`, `Math.random()`)
produce different output. Templates should avoid non-deterministic rendering.

**Accessibility:** The admin UI uses PrimeVue components with ARIA attributes and keyboard
navigation. Template developers are responsible for accessible HTML output: semantic HTML,
alt attributes, ARIA labels. Future: `gazetta validate --a11y` checks.

## API-only Mode (Headless)

The admin API (`/admin/api/*`) is a standard Hono API. It works without the admin SPA.
Use cases: custom admin frontend, CI scripts that read/write content via API, mobile app.

API endpoints: `GET/PUT /api/pages/:name`, `GET/PUT /api/fragments/:name`,
`GET /api/templates`, `GET /api/templates/:name/schema`, `POST /api/publish`.

## Post-publish Hooks

No built-in webhook or notification system. After `gazetta publish`, add notifications
in CI scripts:

```yaml
# GitHub Actions
- gazetta publish production
- run: curl -X POST $SLACK_WEBHOOK -d '{"text":"Site published"}'
```

Future: `site.config.ts` `hooks` field for post-publish actions.

## Template Development Without a Site

Template developers creating a reusable template library can run `gazetta dev` with a
minimal site. `gazetta init` scaffolds a starter site for this purpose. There is no
template-only preview mode — templates need at least one page to render.

For template libraries distributed as npm packages: the library exports templates from
its package. The consuming project installs the package and references templates by
package path:

```
# In consuming project's page.json:
template: "@company/templates/hero"
```

Future: template package resolution from node_modules.

## `gazetta validate` and Template Code Execution

`validate` imports templates via jiti to access their Zod schemas. This executes
template module code (top-level side effects). Templates should avoid side effects
on import — keep initialization inside the render function, not at module scope.

## Minimum Viable Site

The smallest Gazetta site is 5 files:

```
my-site/
  package.json                    # workspaces, scripts
  admin/package.json              # gazetta, react
  templates/package.json          # gazetta, zod
  templates/page/index.ts         # one template
  sites/main/site.config.ts       # name + one target
  sites/main/pages/home/page.json # one page
```

No fragments, no custom editors, no custom fields. One template, one page.
