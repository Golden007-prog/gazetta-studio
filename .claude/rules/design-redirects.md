---
paths:
  - "packages/gazetta/src/runtime/archive-marker.ts"
  - "packages/gazetta/src/runtime/redirects-emit.ts"
  - "packages/gazetta/src/cli/index.ts"
  - "packages/gazetta/src/admin-api/routes/publish.ts"
---

# Redirects (reference)

How Gazetta serves URL redirects. **Reference doc, NOT a foundational
dimension** — redirects are not their own design pass; they emerge as
a consumer surface from `design-soft-delete.md` (rename → 301) and a
deferred future surface from `design-scheduling.md` (302 / scheduled).
This doc consolidates the redirect-related concerns that operators
need to navigate without re-reading three docs.

**Status**: design pass not needed. The shipped surface is described
here. Future redirect features (302, scheduled, manual via admin UI)
are catalogued in "Future surfaces" below with pointers to the docs
that own them.

**Companion docs:**
- [`design-soft-delete.md`](design-soft-delete.md) — owner of the 301
  rename redirect, the HTML comment marker mechanism, and the
  `_redirects` host-glue exception.
- [`design-scheduling.md`](design-scheduling.md) — future owner of 302
  / time-bounded / scheduled redirect lifecycle (deferred per
  `design-soft-delete.md` Q14).
- [`docs/seo-plan.md`](../../docs/seo-plan.md) — Tier 2 punch-list
  entry: manual redirect creation in admin UI; the mechanism (HTML
  marker / archive-only manifest) supports it today, the UI surface is
  deferred.
- [`feature-design-process.md`](feature-design-process.md) — defines
  reference docs vs design docs vs ADRs. This file is in the
  reference-doc category alongside `design-config.md`,
  `design-logging.md`, etc.

## What ships in v1

### 301 redirects from rename

When an operator renames a page (`pages/landing` → `pages/welcome`),
the soft-delete primitive ([`design-soft-delete.md`](design-soft-delete.md))
composes the rename as:

1. Archive the old name (`landing`) with `aliasOf: 'welcome'`
2. Create the new name (`welcome`) as a live page
3. Flatten any earlier aliases pointing at the old name (Q3 lock)

The archived `landing` page is published as a single-line HTML file
carrying a comment marker:

```
<!-- gazetta:archived alias=welcome -->
```

Worker-served ESI and dynamic targets read the first 200 bytes of
`pages/landing/index.html`, see the marker, and emit
`301 Moved Permanently` to `/welcome` in the request's language
(`/fr/landing` → `/fr/welcome`) — no composition, no body served. On a
static target, `gazetta serve` or a worker reads the marker in the file
at the page's route, and the 301 goes to `/welcome` when `welcome` has
no French version (follows from `design-soft-delete.md` Q10); once
#1152's cuts ship there is no marker file there, and they read the
page's archive sidecar instead, or the first line of a redirect page
(`design-soft-delete.md` Q10). `gazetta serve` and the generated worker
need the site's languages, which they get since #1155
([#1138](https://github.com/gazetta-studio/gazetta-studio/issues/1138)).
Cache headers on the 301 response strip strong caching
(`Cache-Control: max-age=300`) so unarchive propagates quickly.

For plain-static targets (no worker — Cloudflare Pages plain assets,
GitHub Pages, S3 static-website), the marker mechanism doesn't fire.
Those targets opt into the `_redirects` host-glue file
(`targets.X.redirects: { format: 'cloudflare' | 'netlify' | 'json' }`)
which the publish flow emits at the target root by walking archived
manifests (decided: from the target's archive sidecars instead,
[`design-target-removal.md`](design-target-removal.md) Q6). Cloudflare
Pages and Netlify both honor the file at the site root; the `json`
format is for custom integrations. Once #1152's cuts ship, a target
without `redirects.format` gets a redirect page at an alias's old route
instead (instant meta refresh, canonical link, a visible link), whose
first line is the marker for `gazetta serve` (`design-soft-delete.md`
Q10).

The file has one row per language the target publishes, with the
prefixes its routes use (`/landing  /welcome  301` and
`/fr/landing  /fr/welcome  301`), so plain-static sites redirect the
same way worker sites do (follows from `design-soft-delete.md` Q10).
When the destination has no version in a language, that row points at
its default-language page (`/fr/landing  /welcome  301`), since static
publish writes no `/fr/welcome` then (same Q10). On Netlify, a file
at the route would block these rows unless forced, which is one reason
publish writes none there
([#1152](https://github.com/gazetta-studio/gazetta-studio/issues/1152)).

**Cloudflare Pages limits.** Pages takes at most 2,000 static rows
(plus 100 dynamic ones), and its documented status codes are 301, 302,
303, 307 and 308, plus 200 for proxying, so not 410
([Cloudflare docs](https://developers.cloudflare.com/pages/configuration/redirects/)).
With a row per language, a four-language target reaches 2,000 rows at
500 archived pages. Publish is to warn past the limit, and
`format: 'cloudflare'` to write no 410 rows
([#1149](https://github.com/gazetta-studio/gazetta-studio/issues/1149));
until then it writes them and doesn't warn. Without a 410 row, Pages
shows the target's `404.html` for an archive without an alias, once
static publish writes no file at the route and writes that page
([#1152](https://github.com/gazetta-studio/gazetta-studio/issues/1152)).

Decided: maintainer, 2026-10-22 (#1124)

| Rejected | Why |
|---|---|
| Keep writing 410 rows, and don't warn past 2,000 rows | Pages lists no 410 and takes at most 2,000 rows, so rows it can't use would go unnoticed until visitors hit them |

### 410 Gone for archived items without aliasOf

A page archived without `aliasOf` is a pure soft-delete — the URL
should return `410 Gone` wherever Gazetta answers the request (a
worker, `gazetta serve`, a dynamic origin), the more precise answer
(`design-soft-delete.md` Q14, scoped by #1152). Google treats 404 and
410 alike and drops the URL from its index either way
([HTTP status codes](https://developers.google.com/crawling/docs/troubleshooting/http-status-codes)).

Same mechanism: HTML marker `<!-- gazetta:archived gone -->` on
worker-served targets. Once #1149 lands, `_redirects` writes no 410
rows: Cloudflare Pages can't return 410 from `_redirects` (Cloudflare
Pages limits, above) and Netlify doesn't document it, so a removed page
on a plain host answers 404 (#1149, #1152). `gone-status` is a worker
capability.

Plain-static hosts answer 404 there once static publish leaves no file
at the route
([#1152](https://github.com/gazetta-studio/gazetta-studio/issues/1152)):
Cloudflare Pages, Netlify and GitHub Pages show the target's
`404.html`, and an S3 website (which answers 403 when its bucket
doesn't allow listing) the error page its website settings name. The
status codes are expected, not documented by the hosts
(`design-soft-delete.md` Q10, #1152 decision 5). Until then they serve
the archived page's marker file, a blank page with status 200. The
capability gap is surfaced at four points (per `design-soft-delete.md`
Q10): boot validate, author-time modal, validator scanner, publish
gate.

### What about manual redirects?

The mechanism supports redirect-without-archive: an operator can
manually create `pages/promo/page.json` with `archived: true,
aliasOf: 'products/featured'`. The page becomes "live as an archived
redirect" — same publish flow, same marker emit. No active content,
just a redirect.

This works today via direct manifest editing. **Admin UI for manual
redirect creation is deferred** (per `seo-plan.md` Tier 2 punch-list
+ `design-soft-delete.md` future directions). The mechanism is the
mechanism; what's missing is a "Create redirect →" form in the admin.

### Status code: only 301 in v1

Renames produce **permanent (301)** redirects exclusively. This is a
locked invariant per `design-soft-delete.md` Q14:

> Renames produce 301; never 302. "I renamed this; the rename is
> permanent." Don't break this expectation later.

Temporary (302), scheduled, and time-bounded redirects are deferred —
see "Future surfaces" below.

## What does NOT ship in v1

| Feature | Owner doc | Status | Trigger |
|---|---|---|---|
| Temporary (302) redirects | `design-soft-delete.md` Q14 (deferred) + future `design-scheduling.md` extension | Reserved | Concrete operator demand for time-bounded redirects |
| Scheduled redirects (activate at date) | `design-scheduling.md` (single-shot action; not yet implemented) | Reserved | Cuts 1-12 of `design-scheduling-implementation.md` ship; redirect lifecycle then composes |
| A/B test redirects (per-cohort) | None — strategic non-fit | Out | No documented demand; experimentation is its own domain |
| Manual redirect creation in admin UI | `seo-plan.md` Tier 2 + `design-soft-delete.md` future directions | Deferred | Concrete operator demand; mechanism exists |
| Redirect chains (multi-hop) | `design-soft-delete.md` Q3 (flatten lock) | Out | Locked invariant — flatten on rename eliminates chains; would require revising Q3 |
| Versioned aliases (`@header-v1` + `@header-v2` simultaneously) | `design-soft-delete.md` future directions | Out | Strategic-bet level; would require revising Q3 flatten |
| `redirects` field in `site.config.ts` (operator-managed list) | None | Reserved | Concrete operator demand; manifest-per-redirect via archive-only manifests is the v1 escape hatch |

## Forward-compat invariants

These invariants are locked in `design-soft-delete.md` Q14 and any
future redirect lifecycle design must respect them:

1. **Renames produce 301, never 302.** Author intent is "this is the
   permanent new home"; later changes to make it temporary would
   violate that contract.
2. **Archive without `aliasOf` produces 410, not 404, wherever Gazetta
   answers the request** (a worker, `gazetta serve`, a dynamic origin);
   plain static hosts answer 404, which Google treats the same
   (scoped by #1152). A future "soft 404" mode would have to be
   explicit operator opt-in.
3. **Manifests are the data, sidecars are derived.** Future
   scheduling fields go on the manifest (per the
   no-publish-time-aggregates principle in
   `feature-design-process.md`).
4. **HTML marker grammar is extensible.** New marker variants
   (e.g., `<!-- gazetta:archived alias=X status=302 expires=... -->`)
   land additively without breaking existing parsers.
5. **Capability-gap UX surfaced at four points.** Future
   redirect-lifecycle features inherit the four-point pattern (boot
   validate / author modal / scanner / publish gate) for plain-static
   targets that can't support time-based behavior.

## Operator config

Per-target `redirects` config — only relevant for plain-static
targets without a worker:

```ts
import { cloudflareWorkersDeploy, defineSite, filesystemStorage, r2Storage } from 'gazetta'

defineSite({
  targets: {
    // Worker-served — uses the HTML marker mechanism; redirects field
    // is unnecessary here (the worker reads the marker directly).
    production: {
      type: 'dynamic',
      storage: r2Storage({ /* ... */ }),
      deploy: cloudflareWorkersDeploy({
        apiToken: process.env.CLOUDFLARE_API_TOKEN!,
        accountId: '...',
        name: 'my-site',
        bucket: 'my-site',
      }),
      siteUrl: 'https://mysite.com',
    },

    // Plain-static deploy on Cloudflare Pages — no worker; redirects
    // field tells the publish flow to emit a `_redirects` file.
    'pages-static': {
      storage: r2Storage({ /* ... */ }),
      type: 'static',
      siteUrl: 'https://static.mysite.com',
      redirects: { format: 'cloudflare' },
    },

    // Custom integration — emit `redirects.json` for a CDN script
    // to consume.
    'custom-static': {
      storage: filesystemStorage({ path: './dist/static' }),
      type: 'static',
      redirects: { format: 'json' },
    },
  },
})
```

When `redirects.format` is unset (or set to `'none'`), no file is
emitted. ESI and dynamic targets ignore the field — their workers read
markers directly. On a static target, once #1152's cuts ship, the field
also decides what publish writes at an alias's old route: nothing with
a format, a redirect page without one (`design-soft-delete.md` Q10).

## Wire format

Cloudflare Pages / Netlify (`format: 'cloudflare'` or `'netlify'`):

```
/old-page    /new-page    301
/retired     /            410
```

Once #1149 lands, neither format writes `410` rows (Cloudflare Pages
limits and 410 Gone, above); `json` keeps its `gone` list.

Sorted alphabetically by source for determinism (same input → same
file → host CDN cache hits when republishing).

JSON (`format: 'json'`):

```json
{
  "redirects": [
    { "from": "/old-page", "to": "/new-page", "status": 301 }
  ],
  "gone": [
    { "path": "/retired", "status": 410 }
  ]
}
```

## Cross-target divergence

A target's `redirects` field is per-target — operators publishing to
multiple targets configure each independently. Worker-served targets
don't need it (they have HTML markers); plain-static targets opt in.
The publish pipeline emits per-target during the per-target publish
phase.

A page can be archived on the source but not yet on a destination
target (e.g., `local` was archived; `production` hasn't been
republished yet). **Current code:** `_redirects` is rebuilt from the
source's archived manifests at every publish, so it picks up archives
that were never published to that target and drops purged ones at the
next publish of anything. **Decided** ([`design-target-removal.md`](design-target-removal.md)
Q6): `_redirects` is built from per-page archive sidecars on the
target, so it lists exactly the archives the target holds, and a purged
archive keeps its row until its removal is published (Q5).

## Foundational checks

This is a reference doc, not a foundational dimension. The redirect
mechanism's foundational checks are answered by its owners:

- **Archive flow** — `design-soft-delete.md` Q10 (HTML marker), Q11
  (validation: `dangling-alias`, `referenced-archived-without-alias`)
- **Multi-instance** — same as soft-delete: per-edge HTML markers on
  page files (per-page archive sidecars on static targets once #1152's
  cuts ship); `_redirects` is a publish-time artifact regenerated
  deterministically from the source's manifests today, and from the
  target's archive sidecars once `design-target-removal.md` Q6 ships
- **Cache** — 301/410 responses get `Cache-Control: max-age=300` to
  let unarchive propagate quickly; `_redirects` itself is host-cached
  per the host's CDN rules (Cloudflare Pages serves it with the
  default CDN cache headers)
- **Audit** — redirect emission is mechanical bookkeeping; not its
  own audit event. The triggering `archive` / `unarchive` / `rename`
  audit events (per `design-audit.md` + `design-soft-delete.md` Q8)
  carry the user intent
- **Capability-gap UX** — four-point pattern (boot validate / author
  modal / scanner / publish gate) per `design-soft-delete.md` Q10

## Future surfaces

The redirect surface grows in two known directions:

1. **Manual redirect UI** — admin form for "create a redirect from /A
   to /B" without renaming an existing page. The mechanism exists
   (archive-only manifest); the UI form would land as part of the
   editor papercut cluster (Tier 1, demand-driven).

2. **302 / scheduled redirects** — when `design-scheduling.md`'s
   single-shot actions ship (`redirect-activate`, `redirect-expire`),
   redirect lifecycle composes. Manifest extends with optional
   `schedule: { ... }`; HTML marker grammar extends with
   `status=302 expires=...` form. Per-action capability check at fire
   time (per `design-scheduling.md` Q5 lock).

Both are additive to the v1 mechanism. No revision needed.
