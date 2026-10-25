---
paths:
  - "packages/gazetta/src/renderer.ts"
  - "packages/gazetta/src/resolver.ts"
  - "packages/gazetta/src/serve.ts"
  - "packages/gazetta/src/publish-rendered.ts"
  - "packages/gazetta/src/admin-api/routes/preview.ts"
  - "packages/gazetta/src/types.ts"
---

# Rendering modes

Foundational dimension #8 of 13. The full taxonomy of when and where rendering happens: static (pre-rendered HTML), ESI (assembled at edge from pre-rendered fragments), dynamic (origin runs templates per request), island (SSR'd + hydrated in browser). Plus listings / render-time queries.

**Status**: design pass complete (2026-05). Implementation phases sit in Tier 3. Provisional locks (dynamic-side details) explicitly flagged for follow-up grilling.

**Companion docs**:
- [`feature-design-process.md`](feature-design-process.md) — defines the **Render check** every new feature design must answer
- [`design-publishing.md`](design-publishing.md) — current static + ESI render flows
- [`design-concepts.md`](design-concepts.md) — component rendering types (static / dynamic / island)
- [`design-i18n.md`](design-i18n.md) — locale enters render context
- [`design-themes.md`](design-themes.md) — theme enters render context

## Why this is foundational

The rendering taxonomy currently lives implicitly across `design-publishing.md` and `design-concepts.md`. Pulling it into one foundational doc means: future features that touch the render pipeline reason about all four modes (static / ESI / request-SSR / island) uniformly.

Issue #80 (dynamic route params at render) is a sub-task of this design pass — params plumbing is part of the request-time SSR contract, not a standalone fix.

## Locked invariants

### Inherited from prior design
- **Compose vs. resolve verb split** — composing a tree from references is `compose*`; picking a value from a fallback chain or merging layered config is `resolve*`. Per [docs/adr/0001-compose-vs-resolve-verb-split.md](../../docs/adr/0001-compose-vs-resolve-verb-split.md).
- **Hash-in-path URLs for assets** — content-addressed; URL changes when bytes change. Per [`design-media.md`](design-media.md).
- **Content-addressed dedupe at publish** — unchanged items skip re-render via hash sidecars. Per [`design-publishing.md`](design-publishing.md).
- **Logical comparison only** — compare operates on logical content, not materialized output. Per [`design-decisions.md`](design-decisions.md) #17.

### Locked in this design pass

**Three target types** (Q1):

| Target type | Infrastructure | Worker | Origin | Template change propagation |
|---|---|---|---|---|
| `static` | CDN only | none | none | Re-render every affected page; full publish |
| `esi` | CDN + Worker | route + cache + string-cat | none | Re-render affected fragments; partial publish |
| `dynamic` | CDN + Worker + Origin | route + cache | Template execution per request | No re-render needed; templates execute live |

`esi` is the current Gazetta default. `dynamic` is the v2 addition for sites needing per-request rendering. `static` is for sites without a runtime (plain CDN, no Worker).

**Pages compose fragments; fragments declare their rendering type** (provisional — needs more grilling):

| Primitive | Renders at | Notes |
|---|---|---|
| Page | (always composition) | Composes fragments; itself a composition root, not a rendering-type carrier |
| Static fragment | Publish time (Node/Bun) | Pre-rendered, immutable per content hash |
| Dynamic fragment | Request time on origin (Node/Bun) | Fresh per request; receives `RenderContext` (Q2) |
| Island fragment | Publish-time SSR + browser hydration | Pre-rendered shell + JS bundle |

The reframe from earlier "dynamic component" thinking: **dynamic is a kind of fragment, not a separate primitive.** Pages don't carry a rendering type — they inherit constraints from the fragments they compose.

**Why the reframe**:
1. Dynamic templates are reusable across pages — same identity model as static fragments (`@search-results` referenced from multiple pages)
2. `RenderContext` belongs only to dynamic fragments — static/island render at publish, no request context exists
3. The compatibility matrix flattens — "can this page reference any dynamic fragments?" is the only check; pages don't need their own dynamic flag

**Compatibility matrix (revised)**:

|  | `static` target | `esi` target | `dynamic` target |
|---|---|---|---|
| Page using only static + island fragments | ✓ | ✓ | ✓ |
| Page using any dynamic fragments | ✗ (publish error) | ✗ (publish error; v2 reserved) | ✓ |

**Provisional declaration on fragment manifest**:

```yaml
# fragments/search-results/fragment.json
template: search-results
rendering: dynamic           # 'static' | 'dynamic' | 'island'; default 'static'
```

Validators check coherence: template signature (presence/absence of `ctx` parameter) matches fragment manifest's `rendering` declaration. **Open**: explicit declaration vs. inference from template signature; route-discovery vs. fragment-rendering-type orthogonality (dynamic routes ≠ dynamic fragments). Tracked in "More grilling needed" below.

**Worker boundary discipline** (locked):

> The worker (edge) NEVER runs template code. Worker responsibilities: HTTP routing, response caching, fragment assembly via string concatenation. Template execution happens at publish time (Node/Bun for static + island components) OR at origin (Node/Bun for dynamic components).

Consequence: template code changes never require worker deploy. Authors edit templates → content republishes (`esi`) or origin reads new code (`dynamic`) → workers stay still.

**Worker cache rule** (locked):

> The worker caches only content-addressed responses (immutable hash-in-path URLs). Origin output (dynamic component responses) is not cached by the worker. Composed pages containing dynamic components are not cached as a whole.

Origin owns its own cache semantics via Cache-Control headers; worker honors them. Per-dynamic-component cache details (component-level cache hints, validation gates for cache coherence) are deferred — captured in "Future directions."

**Why "dynamic" rather than "server"** (Q1 naming): `dynamic` accommodates future edge-runtime template execution (`runtime: edge`) under the same target type. Naming the v1 target `server` would force a rename when WinterTC-subset edge SSR lands. The fuzziness of "dynamic" is the price of forward-compatibility.

## Dynamic fragment timeout + failure handling (Q3 locked)

Dynamic fragments fetched from origin can be slow or fail. v1 ships three failure modes with per-fragment opt-in:

```yaml
# fragments/search-results/fragment.json
template: search-results
rendering: dynamic
timeout: 5000              # ms; default 5000
onFailure: empty           # 'empty' | 'placeholder' | 'fail-page'; default 'empty'
fallbackHtml: '<p>Search temporarily unavailable</p>'  # only when onFailure: 'placeholder'
```

**Defaults**:
- `timeout: 5000` (5 seconds) — tunable per fragment for legitimately slow operations (AI generation, expensive queries)
- `onFailure: 'empty'` — graceful degradation; renders an HTML comment marker (`<!-- fragment 'search-results' failed -->`) in the slot

**Failure modes**:

| Mode | Behavior | Use case |
|---|---|---|
| `empty` (default) | HTML comment in slot; page renders without the fragment | Sidebar widgets, optional content |
| `placeholder` | Author-supplied `fallbackHtml` rendered in slot | Explicit "something went wrong" UX |
| `fail-page` | Whole page response fails | Transactional flows, compliance-critical content |

**Page-level error handling** when `onFailure: 'fail-page'`:
- 5xx origin error → HTTP 502 Bad Gateway
- Timeout → HTTP 504 Gateway Timeout
- Operator overrides default error pages via target config:
  ```yaml
  targets:
    production:
      type: dynamic
      errorPages:
        502: /errors/server.html
        504: /errors/timeout.html
  ```

Default error pages: minimal Gazetta-rendered HTML with the error code.

**Audit integration**: every fragment failure emits an audit event extending `design-audit.md`'s `action` enum:

```ts
{
  action: 'render-fragment',
  outcome: 'failed-render',  // or 'timeout' (closed-enum extension to design-audit.md outcome)
  actor: { /* requesting principal */ },
  scope: { kind: 'fragment', name: 'search-results' },
  metadata: {
    targetName: 'production',
    requestId: 'abc-123',
    failureReason: 'timeout' | '5xx' | 'unreachable' | 'exception',
    durationMs: 5001,
  }
}
```

`action: 'render-fragment'` and `outcome: 'failed-render' | 'timeout'` are closed-enum extensions to the audit shape locked in `design-audit.md`.

**Reserved for v2**: `onFailure: 'last-cached'` — serves stale HTML from a previous successful render. Requires a fallback cache layer that contradicts Q1's "worker doesn't cache origin output." Reserved until concrete operator demand surfaces.

## Listings / render-time queries (Q4 locked, dynamic side provisional)

Templates need to enumerate pages and fragments — for index pages, archive pages, related-content widgets, RSS feeds. Replaces what Algolia would otherwise provide for filtered listings; full-text search stays delegated per non-goals.

**API shape**: programmatic TS chain (not GROQ string, not GraphQL).

```ts
interface PageQuery {
  /** Fluent filter API */
  where(filter: PageFilter): PageQuery
  /** Sort by manifest field path (e.g., 'metadata.publishedAt') */
  orderBy(field: string, direction?: 'asc' | 'desc'): PageQuery
  /** Limit results */
  limit(n: number): PageQuery
  /** Skip N results (offset-based pagination; cursor pagination reserved for v1.5) */
  offset(n: number): PageQuery
  /** Resolve to page summaries */
  list(): Promise<PageSummary[]>
}

interface PageFilter {
  tag?: string
  template?: string
  locale?: string
  theme?: string
  [key: string]: unknown        // exact-match on any manifest field path
}

interface PageSummary {
  name: string
  route: string
  template: string
  metadata: Record<string, unknown>
  locale: string
  // Summaries only; templates that need full content fetch by name
}
```

`FragmentQuery` mirrors `PageQuery` for fragments.

**Template signatures** (revised from Q1 to surface helpers):

```ts
// Static + island fragment template signature
export default ({ content, children, helpers }: {
  content: TContent
  children?: ChildRender[]
  helpers: { pages: PageQuery, fragments: FragmentQuery }   // publish-time-only helpers
}) => ({ html, css, js, head? })

// Dynamic fragment template signature
export default ({ content, children, ctx }: {
  content: TContent
  children?: ChildRender[]
  ctx: RenderContext   // includes pages + fragments + request data
}) => ({ html, css, js, head? })
```

**Usage example**:

```tsx
// Static template for /blog/index page
export default async ({ content, helpers }) => {
  const posts = await helpers.pages
    .where({ template: 'blog-post' })
    .orderBy('metadata.publishedAt', 'desc')
    .limit(10)
    .list()
  return { html: `<ul>${posts.map(p => `<li><a href="${p.route}">${p.metadata.title}</a></li>`).join('')}</ul>`, css: '', js: '' }
}
```

**Composition rules**:
- **Locale** — automatic filter by active locale; opt out via `where({ locale: 'all' })`
- **Theme** — automatic filter by active theme; opt out via `where({ theme: 'all' })`
- **RBAC** — at request time (dynamic fragments), automatic filter by `ctx.principal`'s read capabilities; pages the principal can't read are excluded. At publish time, no principal exists; queries see all pages.
- **No free-text search** — equality + sort only. Search delegated per non-goals.

**Performance contract**:
- Publish-time: O(N pages) in-memory scan; ~10ms at envelope (5000 pages per `design-scale.md`). Cached per build.
- Request-time: paginated summaries via `MemoryCache` per-target. Initial fetch loads all summaries; subsequent queries in-memory. Cache invalidated on save.
- Cursor pagination per `design-scale.md` reserved for v1.5 when offset+limit becomes the bottleneck.

**Why programmatic chain (not GROQ string, not GraphQL)**:
- Template authors already write TypeScript; chained TS API is natural
- Type inference from page schemas — `pages.where({ tag })` knows `tag` is valid because typed off the schema
- No new query language to learn; no parser
- Gazetta's positioning is "templates own rendering"; query API serves templates, not external clients (which would warrant GraphQL/GROQ)

**Provisional — dynamic side needs more grilling** (tracked in More grilling needed below):
- Whether `ctx.pages` and `helpers.pages` should literally share the same interface or differ subtly (request-context-aware filters?)
- Cache invalidation rules for dynamic-fragment queries (per-request stale-while-revalidate? worker fetches origin, origin queries from storage?)
- Plugin extension surface — can plugins contribute custom filter operators? Compose with hooks?

## Route discovery (Q5 locked, dynamic side provisional)

Filesystem-based discovery (today's model) extends with three route modes declared in `page.json`:

| Mode | `params` field | `dynamic` field | When pages exist |
|---|---|---|---|
| Static (no params) | absent | absent | Pre-rendered at publish time |
| Static-with-params | present | absent | Pre-rendered per param value at publish time (Astro `getStaticPaths` pattern) |
| Dynamic | absent | `true` | Resolved at request time only |

**Page manifest extensions**:

```yaml
# pages/about/page.json — static route (today's behavior)
route: /about
template: page-default
metadata: { title: 'About' }

# pages/blog/[slug]/page.json — static-with-params (explicit list)
route: /blog/:slug
template: blog-post
params:
  source: list
  values: ['hello-world', 'second-post']

# pages/blog/[slug]/page.json — static-with-params (query-derived)
route: /blog/:slug
template: blog-post
params:
  source: query
  query: { template: 'blog-post-data' }   # uses Q4 page query at publish time

# pages/blog/[slug]/page.json — dynamic route (request-time resolution)
route: /blog/:slug
template: blog-post
dynamic: true
```

**Compatibility with target types**:

|  | `static` target | `esi` target | `dynamic` target |
|---|---|---|---|
| Static route | ✓ | ✓ | ✓ |
| Static-with-params | ✓ (one file per param) | ✓ | ✓ |
| Dynamic route | ✗ (publish error) | ✗ (publish error) | ✓ |

**Worker route registration** (`esi` and `dynamic` targets): a `routes.json` manifest generated at publish time listing all known routes. Worker reads on cold start, caches in memory. Edge runtimes (Cloudflare Workers, Deno Deploy) support boot-time KV reads or static asset reads.

**Route conflict detection** (at publish + boot):
- Two pages claiming the same route → publish error
- Static-with-params slug list overlapping with another static page → publish error
- Dynamic route shadowing static route → warning (dynamic wins, but probably an author mistake)

**Issue #80 alignment**: dynamic routes plumb route params through `c.req.param()` at the worker → origin call. Origin receives `ctx.params = { slug }` per the `RenderContext` from Q2.

**Plugin-supplied routes** (e.g., a search plugin adds `/api/search`): deferred to `design-plugins.md`'s upcoming pass. v1 doesn't support plugin-registered routes; filesystem discovery is the only mechanism.

**Provisional — dynamic side needs more grilling**:
- Worker → origin protocol shape (HTTP-based vs. RPC; per-fragment vs. per-page)
- Origin's route registration (does origin re-discover from filesystem? share `routes.json` with worker?)
- Cache key shape for dynamic responses with route params
- Hot-reload of routes (deploy adds new dynamic route — does worker pick it up at next request, or require redeploy?)

## Edge runtime constraints + deployment matrix (Q6 locked)

v1 ships three target types with these deployment constraints:

| Target type | Worker location | Origin location |
|---|---|---|
| `static` | Any CDN; no worker required | n/a |
| `esi` | WinterTC edge (Cloudflare Workers, Deno Deploy, Vercel Edge) OR Node/Bun via `gazetta serve` | n/a |
| `dynamic` | WinterTC edge OR same-process Node/Bun | Node/Bun (required) |

**Single-server vs split deployment** for `dynamic` targets:

- **Split**: worker on edge (e.g., Cloudflare Worker), origin on separate Node/Bun host (Fly, Railway, AWS App Runner). Worker calls origin via HTTP.
- **Single-server**: worker and origin in one Node/Bun process (`gazetta serve` running both roles). Common for self-hosted deployments.

Both are valid. Worker boundary discipline (worker never runs templates) holds in both — single-server worker calls origin function in-process, but the boundary is logical, not network.

**Per-platform compatibility**:

| Platform | Worker | Origin | Notes |
|---|---|---|---|
| Cloudflare Workers | ✓ | ✗ (v1) | WinterTC subset; no `fs`, `child_process` |
| Cloudflare Pages with Functions | ✓ | ✗ (v1) | Same WinterTC constraints |
| Deno Deploy | ✓ | Limited | Best for static + esi |
| Vercel Edge Functions | ✓ | ✗ (v1) | WinterTC |
| Node/Bun via `gazetta serve` | ✓ | ✓ | Full Node API |
| Fly.io / Railway / Render | ✓ | ✓ | Standard Node hosting |
| AWS App Runner / Azure App Service | ✓ | ✓ | Standard Node hosting |

**Operator documentation responsibility**:
- `docs/cloudflare.md` adds per-target-type sections (static / esi / dynamic with worker on Cloudflare + origin on Fly/Railway recommended)
- `docs/self-hosted.md` adds per-target-type sections (single-process `gazetta serve`)

**v2 reserved**: WinterTC edge as origin. Templates would need to stay in WinterTC subset (no Node-only APIs); requires either WASM-compiled templates or framework support for edge SSR. Future `validate:deploy-compatibility` validator checks template API surface against target runtime.

For v1, this validator isn't needed — `dynamic` origin is Node/Bun only with full Node API.

## More grilling needed (provisional locks)

The "dynamic is a kind of fragment" reframe is provisional. Open threads to grill before this design pass closes:

1. **Dynamic routes vs. dynamic fragments** are orthogonal concerns:
   - Dynamic route = URL pattern with param (`/blog/:slug`). Route resolution problem.
   - Dynamic fragment = template runs at origin per request. Render timing problem.
   - A page can have dynamic routes WITHOUT dynamic fragments (slug values enumerable at publish; one HTML per known slug; Astro's `getStaticPaths` pattern).
   - A page can have dynamic fragments WITHOUT dynamic routes (homepage `/` with a "live trending posts" fragment).
   - A page can have both. Route-resolution and fragment-rendering-type need separate decision points.

2. **Explicit `rendering` field vs. inferred from template signature**: explicit beats inferred for foundational config, but adds redundancy when the template's TS type already encodes the answer. Validator coherence-check is straightforward either way.

3. **Page-level params propagate to all dynamic fragments**: when route `/blog/:slug` matches, every dynamic fragment composed by that page receives `ctx.params = { slug }`. Static + island fragments on the same page don't see params (they pre-rendered at publish). Confirm propagation rules and edge cases (e.g., a fragment used on multiple pages with different param shapes).

4. **Page composition model with mixed-rendering fragments**: when a page composes static fragments + a dynamic fragment, what's the assembly contract? Worker fetches static-fragment HTML from cache, calls origin for the dynamic fragment, string-concatenates the result. Confirm placeholder/slot semantics, error handling for failed dynamic fragment fetches.

5. **`RenderContext` shape lock** (started in Q2 grilling): closed shape with `{ params, query, headers, cookies, principal, locale, theme, target, requestId, now }` was provisionally recommended. Confirm fields, defer or expand based on real dynamic-fragment use cases.

**Future runtime sub-field** (reserved):

```ts
export default defineSite({
  targets: {
    production: {
      type: 'dynamic',
      runtime: 'node',   // v1: 'node' | 'bun'
      // type: 'dynamic',
      // runtime: 'edge', // v2: WinterTC edge SSR (templates stay in WinterTC subset)
    },
  },
})
```

v1 ships `dynamic` target with implicit `runtime: node`. Edge SSR reserved.

## Foundational checks

How rendering composes with each of the other 12 foundational dimensions plus the multi-instance discipline.

### Multi-instance discipline
- Static and ESI: published HTML/fragments live in storage; any instance reads. Multi-instance-safe by construction.
- Dynamic origin: render context (params, cookies, principal, requestId, now) is per-request; no cross-instance state. Multiple origin instances render the same page identically given the same context.
- Worker route registration: `routes.json` lives in storage; every worker instance reads at boot.
- Render-for-analysis cache (validation Cut 3): per-request OR per-build, never shared in-memory across instances. Cache key includes content + dependency hashes so different instances converge to the same entry without coordination.
- Listings cache: per-instance via `MemoryCache`; read from storage on demand. No shared query cache.
- Import maps for islands: derived from published assets directory; computed per-render, never cached cross-instance.

### Scale (#1)
- Static + ESI publish: O(N pages) per build; sidecar dedupe skips unchanged items per `design-publishing.md`.
- ESI request: O(F fragments) per page composition; fragment cache hit rate determines latency.
- Dynamic request: O(C dynamic components) origin calls per request; each is its own latency budget. Page response is bottlenecked by slowest fragment.
- Listings: O(N pages) at envelope (5000 pages, ~10ms scan). Cursor pagination per `design-scale.md` reserved for v1.5.
- Route discovery: filesystem walk at boot or publish; one `routes.json` manifest read per worker cold start.

### Locale (#2)
- Render context carries `locale` resolved per `design-i18n.md` (locale-priority cross-dimension fallback).
- Static + island templates receive locale via `helpers` or component params (existing).
- Dynamic templates receive `ctx.locale` from `RenderContext`.
- Page query API auto-filters by active locale; opt out via `where({ locale: 'all' })`.
- Locale-variant manifests (`page.fr.json`) already shipped; render pipeline picks the right variant per request.

### Themes (#3)
- Render context carries `theme` resolved per `design-themes.md`.
- Theme-variant assets resolve per `design-media.md`'s cross-dimension fallback.
- Dynamic templates receive `ctx.theme`.
- Page query API auto-filters by active theme; opt out via `where({ theme: 'all' })`.
- Pages/fragments are theme-agnostic at the data layer in v1 (per `design-themes.md`); themes affect render via PrimeVue tokens / class-based cascade in templates.

### Auth + RBAC (#4)
- Dynamic templates receive `ctx.principal` from auth/RBAC's `Principal`.
- Permission-filtered output: dynamic templates check `ctx.principal` and filter content per capabilities.
- Page query API auto-filters by `ctx.principal`'s read capabilities at request time; static publish-time queries see all pages (no principal exists).
- Worker enforces capability checks before calling origin (no point calling origin if request is unauthorized).

### Audit (#5)
- Render events are NOT audited at v1 — would explode event volume.
- Fragment failures emit audit events (per Q3 lock): `action: 'render-fragment'` with `outcome: 'failed-render' | 'timeout'`.
- Capability denials at the render layer audit per `design-audit.md`'s `forbidden` outcome.
- `ctx.requestId` correlates with audit events for the request.

### Review (#6)
- Review state doesn't block publishing: only publish approval does, on targets that require it; the publish panel marks rows that aren't approved (`design-review-workflow.md`, 2026-10-25 item 7).
- Dynamic targets: pending-review pages can render at request time on the source target only; other targets can't fetch them.
- Render-for-analysis runs against any state (validates draft + pending-review + approved).

### Hooks (#7) — design pass pending
- Render-lifecycle hooks reserved for `design-hooks.md`: `beforeRender`, `afterRender`, `beforeFragment`, `afterFragment`.
- Hook payload includes `RenderContext`; hooks can transform output.
- Plugin-supplied hooks at the render layer follow the same `Principal`-aware contract.

### Validation (#9)
- Render-for-analysis (validation Cut 3): same renderer used for preview/publish, captured in-memory rather than written to storage. Composes via `RenderedOutputAccess`.
- Static + island fragments validate against pre-rendered output; dynamic fragments validate against a representative request context (or static fallback when one isn't available).
- Route conflict detection at publish + boot per Q5.
- Future `validate:deploy-compatibility` checks template API surface against target runtime (relevant when v2 edge-origin lands).

### Plugin (#10) — design pass pending
- Plugin-supplied templates: storage providers, custom editors/fields already plug in. Render layer plugin extension surface details deferred.
- Plugin-supplied routes: deferred to `design-plugins.md` (see Q5).
- Plugin-contributed query operators in the listings API: deferred (see Q4).

### Cache (#11) — design pass pending
- Worker cache: only content-addressed responses (per Q1 lock). Hash-in-path URLs immutable.
- Origin cache: dynamic responses NOT cached by worker by default; origin owns cache via Cache-Control headers.
- Page query cache: per-instance `MemoryCache`; invalidated on save.
- Render-for-analysis cache: keyed on content + dependency hashes; per-build.

### Offline (#12) — design pass pending
- Static + island components render at publish time; offline admin previews from last-cached render.
- Dynamic fragments: offline admin can't preview (origin unreachable). Stale fallback reserved for v2 (per Q3 deferred `last-cached`).
- Render-for-analysis runs locally during offline (validators are pure functions over manifests + pre-rendered fragments).

### Collaboration (#13) — design pass pending
- Render layer doesn't carry comments; comments live in their own collaboration surface.
- Comment counts could surface via render-time queries on a future `helpers.comments` API; reserved for collaboration design pass.

## Migration

Existing sites use static + ESI today. Request-SSR is opt-in via target config. Existing static pages stay static unless explicitly promoted.

## Future directions

- Streaming SSR (HTTP streaming response) — out of scope for v1; depends on per-render perf measurement
- Edge SSR with WASM-compiled templates — out of scope; edge-runtime constraints are real today
- Server components (RSC-style) — strategic bet; not on roadmap
