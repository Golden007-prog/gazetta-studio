---
paths:
  - "packages/gazetta/src/pages/**"
  - "packages/gazetta/src/fragments/**"
  - "packages/gazetta/src/admin-api/routes/pages.ts"
  - "packages/gazetta/src/admin-api/routes/fragments.ts"
  - "packages/gazetta/src/admin-api/routes/archive.ts"
  - "packages/gazetta/src/admin-api/routes/rename.ts"
  - "packages/gazetta/src/site-loader.ts"
  - "packages/gazetta/src/resolver.ts"
  - "apps/admin/src/client/components/SiteTree.vue"
  - "apps/admin/src/client/components/PageMetadataEditor.vue"
  - "apps/admin/src/client/components/FragmentMetadataEditor.vue"
  - "apps/admin/src/client/components/ArchiveModal.vue"
  - "apps/admin/src/client/components/RenameModal.vue"
  - "apps/admin/src/client/components/ArchiveConflictModal.vue"
  - "**/page.json"
  - "**/fragment.json"
---

# Soft delete (archive + alias + rename)

A foundational primitive: pages and fragments transition to an **archived** state instead of being hard-deleted. Archived items optionally carry an **alias** (`aliasOf`) that resolves references at render time. **Rename** is a composed operation: archive the old name with `aliasOf: <new>`, create the new live item with the same content. Archived items can be **restored** (back to live) or **purged** (permanent delete).

This replaces the prior shape where `DELETE /api/pages/:name` hard-removed the directory and the rename operation didn't exist.

**Status**: design pass complete (2026-05). Implementation: see [`design-soft-delete-implementation.md`](design-soft-delete-implementation.md).

**Companion docs:**
- [`feature-design-process.md`](feature-design-process.md) — defines the foundational-checks process every new feature must respect; soft-delete is foundational
- [`design-publishing.md`](design-publishing.md) — history-recorder is the existing primitive; archive transitions are saves recorded normally
- [`design-validation.md`](design-validation.md) — validators surface archive-related issues (dangling alias, archived ref without alias, etc.)
- [`design-rendering.md`](design-rendering.md) — runtime archive-aware composition; HTML comment marker is the universal mechanism (worker reads first 200 bytes of page HTML)
- [`design-audit.md`](design-audit.md) — `archive`/`unarchive`/`purge`/`rename` are new closed-enum action values
- [`design-review-workflow.md`](design-review-workflow.md) — archive auto-withdraws pending-review state; restore returns to draft
- [`design-auth-rbac.md`](design-auth-rbac.md) — capability gates (`delete:pages`, `delete:fragments`); admin-only `?force=true` escape hatch
- [`design-cache.md`](design-cache.md) — archive operations invalidate `pages:` / `fragments:` prefixes
- [`design-offline.md`](design-offline.md) — archive/unarchive/purge/rename queue + replay on reconnect; same as save
- [`design-scale.md`](design-scale.md) — archive count is a sub-dimension of total page count; envelope unchanged
- [`design-media.md`](design-media.md) — assets retain hard-delete semantics in v1 (delete-blocked-when-refs-exist); soft-delete extends to assets in v1.5

## Why this is foundational

Pages, fragments, and (eventually) assets all need a non-destructive deletion model. Renames need redirects. References to deleted items need graceful resolution paths. Each is foundational: cross-cutting across ten existing dimensions (audit, validation, render, review-workflow, cache, offline, scale, RBAC, hooks, multi-instance).

Adding soft-delete later means retrofitting:
- Every `DELETE` handler — currently hard-deletes
- The renderer — currently has no concept of archived items
- The validator suite — currently has no archive-aware validators
- The site tree — currently has no notion of archived items
- The audit log — currently has no archive/unarchive/purge/rename actions
- The publish pipeline — currently has no per-page redirect/410 mechanism

Designing now keeps each surface uniform across all three primitives (pages, fragments, future assets).

## Scope

**In v1:**
- Pages and fragments soft-delete (archive instead of hard-delete)
- Optional `aliasOf` field on archived items — runtime alias resolution
- Rename operation (composed: archive + create-with-alias)
- Restore operation (unarchive)
- Permanent-delete (purge) operation, with refuse-on-references protection
- Admin-only `?force=true` escape hatch for purge
- Tree filter "Show archived" toggle
- `_redirects` host-glue for static targets on Cloudflare/Netlify
- HTML comment marker is the universal mechanism (worker reads first 200 bytes of page HTML)
- Validators (P1-P5 from grilling): `referenced-archived-without-alias`, `dangling-alias`, `circular-alias`, `archive-not-supported-on-target`, `aliasOf-points-to-archived`
- CLI surface: `gazetta archive list / purge / restore / rename` (composable; cron-friendly)
- Capability-gap UX surfaced at four points (boot validate, author-time modal, validator scanner, publish gate)
- Audit: `archive`, `unarchive`, `purge`, `rename` as new closed-enum action values

**Reserved (v1.5+):**
- Soft-delete extension to assets
- Per-locale archive (currently per-page)
- Admin UI for manual redirect creation (the mechanism supports it; surface deferred)
- UI for bulk archive operations (CLI works today)
- Auto-archive retention (TTL); CLI + cron handles it today

**Out of v1 (explicit):**
- Temporary redirects (302) — see "Future directions"
- Scheduled redirects (date-based activation)
- A/B test redirects (per-cohort temporary redirect)
- Page move (parent-route change) as a distinct concept; today's rename works through filesystem reparenting
- Find-and-replace across content
- Time-locked items (no edits before/after date)

**Non-goals:**
- Time-window archive lifecycle ("archive until date X, then auto-restore")
- Per-target archive state (archive lives on source manifests; targets get derived publish artifacts)
- Cascading archive (archiving a page that's referenced doesn't auto-archive its children)

## Locked decisions

### Q1 — Storage shape

**Locked: A1 — manifest field.**

Archive state lives on the manifest itself, as additive optional fields:

```jsonc
// pages/landing/page.json
{
  "template": "page-default",
  "content": { ... },
  "components": [...],
  "metadata": { ... },

  // Archive fields (all optional; absent = not archived)
  "archived": true,
  "archivedAt": "2026-05-09T14:30:00Z",
  "archivedBy": "alice@example.com",
  "aliasOf": "welcome"
}
```

`archivedBy` is a snapshot at archive time (per `design-audit.md`'s actor-snapshot pattern). Doesn't auto-update if user role changes. `archived: false` is treated identically to `archived` absent — both = "live."

`aliasOf` value is the **target name** (not URL). Pages: `name → route` via `deriveRoute`. Fragments: `name` is referenced as `@name`.

**Why A1 over sidecars / namespace move / JSON registry / filename prefix:**

- Archive is content state — changes how renderer treats the item
- One place to look (manifest tells the truth)
- Composes with history (saves include archive transitions)
- Multi-instance correct (last-write-wins on manifest is standard)
- Per-edge granularity not needed; archive is per-page boolean

### Q2 — Reference resolution after archive

**Locked: F1 — alias-aware renderer; split on `aliasOf` presence.**

| State | Behavior at render time |
|---|---|
| Archived, `aliasOf: 'newname'` | Renderer transparently follows the alias. `@oldname` resolves as `@newname`. Page route `/oldname` emits 301. On ESI targets, a page's placeholder names the fragment it references, so serving follows the archived fragment's alias marker. |
| Archived, no `aliasOf` (pure soft-delete) | Validator warning at save + scanner; render-time emits 410 (page) or render-time error (fragment). An ESI page that still uses such a fragment is served without it (200, with a comment in its place, as for a missing fragment), not 410: the page isn't gone, only one part of it. |

Decided: maintainer, 2026-10-22 (#1124): an ESI page that uses a fragment archived without an alias is served without it. Serving that follows a fragment's alias marker follows from F1.

| Rejected | Why |
|---|---|
| 410 for the whole page | Every page that uses the fragment would answer "Gone", and search engines would drop pages that still exist |
| An error page (500) | Visitors see an error on a page that still exists, and search engines retry it later |

**Auxiliary validators** (Q11):
- `referenced-archived-without-alias` (warn) — manifest references `@oldname`, `@oldname` archived without alias
- `dangling-alias` (error) — `aliasOf: 'X'` where `X` doesn't exist
- `circular-alias` (error) — A → B → A; defensive (Q3 flatten makes this impossible by construction)

### Q3 — Alias chain handling

**Locked: G1 — flatten on rename; refuse rename to archived target.**

Renaming `B → C` does:

1. Archive `B` (with `aliasOf: C`)
2. Walk archived items where `aliasOf === 'B'`
3. For each, rewrite `aliasOf` to `'C'` (one save per item; recorded in history)
4. Each rewrite invalidates relevant caches

After flatten: every archived item's `aliasOf` points at a live item, never at another archive. Runtime resolution is one hop, never recursive.

**Audit:** flatten cascade emits `action: 'archive'` events with `metadata.flattened: true` per rewritten item. Allows forensic reconstruction.

**Refuse rename to archived target.** If user tries to rename `B → C` and `C` is itself archived, refuse with `409 ARCHIVED_NAME_CONFLICT` and the prompt UX from Q5.

### Q4 — Permanent-delete blocking

**Locked: H1 refined — refuse on aliases + live refs; admin-gated `?force=true`.**

Permanent-delete refuses if any of:
- Other archived items have `aliasOf: <target>`
- Live pages/fragments reference `<target>` directly

Refusal returns `409 DELETE_BLOCKED` with structured body:

```jsonc
{
  "code": "DELETE_BLOCKED",
  "aliases": ["landing", "home-old"],
  "liveRefs": [
    { "kind": "page", "name": "blog/post-1", "componentPath": "components.0" }
  ]
}
```

**Resolution UX in admin:**

For each alias-pointer, user can:
- Re-target → pick a different live target
- Drop alias → strip `aliasOf`, archive remains as 410-only
- Purge too → cascade purge that pointer
- Restore → unarchive the alias-pointer

For each live ref, user can:
- Jump to ref → navigate to editor at the location
- Re-target ref → inline picker
- Remove ref → strip from manifest

One-click bulk: "Purge all aliases" (cascade), "Drop all aliases."

**`?force=true` escape hatch (admin only):**

Bypasses the block. Live refs become render-time errors (or 410); aliases get stranded. Audit records `metadata.forced: true, metadata.bypassedAliases: [...], metadata.bypassedLiveRefs: [...]` so the destructive shortcut leaves a trail.

UI: only `admin` role sees the "Advanced — force delete anyway" disclosure in the resolve modal.

### Q5 — Conflict on reusing an archived name

**Locked: I3 — prompt with three options, default Restore.**

When user creates new content under a name that has an archive:

| Action | Behavior |
|---|---|
| **Restore** (default) | Unarchive the existing archive. Skip creation. Most common intent. |
| **Replace** | Permanently delete the archive (atomically), then create new. Aliases pointing at the archive are re-targeted to the new item. Live refs to the archive block until resolved. |
| **Move aside** | Old archive renames to `<name>-archived-<date>`. New content takes the name. |
| **Cancel** | Backs out. |

**API shape:**

`POST /api/pages` returns 409 with:

```jsonc
{
  "code": "ARCHIVED_NAME_CONFLICT",
  "archive": {
    "kind": "page",
    "name": "landing",
    "archivedAt": "2026-02-15T10:00:00Z",
    "archivedBy": "alice@example.com",
    "aliasOf": "welcome",
    "aliases": ["other-old-name"],
    "liveRefs": []
  }
}
```

Client retries with `?onConflict=restore | replace | moveAside`.

### Q6 — Restore mechanism

**Locked: D1 — flip the bit.**

Restore = strip the archive fields (`archived`, `archivedAt`, `archivedBy`, `aliasOf`) from the manifest and save. Item is back at its old name with content unchanged from archive time.

**Edge cases:**

- Other archives' aliases pointing at this name (after Q3 flatten, they point at the rename target, not at this archive) — unchanged. Restore doesn't undo the alias flattening.
- Live refs to this name — already broken or alias-resolved; restore doesn't auto-fix.
- Was archived as part of `B → C` rename — restore drops `aliasOf` field. The `/oldname → /newname` redirect is gone.

**Audit:** `action: 'unarchive'` with metadata: `archivedAt`, `archivedBy`, `archiveDurationMs`, `priorReviewState` (when review-workflow ships).

### Q7 — Admin UI surface

**Locked: J1 — tree filter toggle, count badge, hidden when zero.**

```
SiteTree
┌─────────────────────────────────┐
│ 🔍 Search                       │
│ ☐ Show archived (3)             │  ← toggle; "(3)" when count > 0; toggle hidden when count = 0
├─────────────────────────────────┤
│ ▼ pages                          │
│   📄 home                        │
│   📄 about                       │
│   📄 landing  (archived → welcome) │  ← greyed; italic alias when set
│   ▼ blog                         │
│     📄 hello-world               │
│     📄 very-old-post (archived)  │  ← greyed; pure soft-delete
└─────────────────────────────────┘
```

Selecting an archived item:
- Editor pane is read-only (banner: "Archived. Restore to edit.")
- Banner has actions: `[Restore]` `[Edit alias]` `[Delete permanently]`
- Metadata pane shows: archived-when, archived-by, alias target, incoming aliases, incoming live refs (warnings)
- Preview iframe shows what visitors would see (301 redirect target's preview, or "Gone" placeholder)

**No dirty dot** on archived items — they don't accumulate pending edits.

### Q8 — Audit treatment

**Locked: M4 — new actions for archive/unarchive/purge; rename as atomic composite.**

New `action` enum values (closed-enum extensions to `design-audit.md`):

```ts
action: 'archive'    // soft-delete or explicit archive button
action: 'unarchive'  // restore from archive
action: 'purge'      // permanent delete from archive
action: 'rename'     // composite: archive old + create new + alias
```

**Per-action audit shape:**

```jsonc
// Rename — single event, atomic intent
{
  "action": "rename",
  "outcome": "success",
  "actor": { "id", "email", "role", "trustMode" },
  "scope": { "kind": "page", "name": "welcome" },     // NEW name (live one)
  "metadata": {
    "fromName": "landing",                              // archived name
    "keepAlias": true,
    "flattenedAliases": ["old-name-1"]                  // names whose aliases were flattened
  }
}

// Purge with force
{
  "action": "purge",
  "outcome": "success",
  "scope": { "kind": "page", "name": "landing" },
  "metadata": {
    "archivedAt": "2026-02-15T10:00:00Z",
    "archivedBy": "alice@example.com",
    "forced": true,
    "bypassedAliases": ["other-old-name"],
    "bypassedLiveRefs": [{ "kind": "page", "name": "blog/post-1" }]
  }
}
```

**Forensic reconstructability:** "history of `landing`" filters by `scope.name = 'landing'` OR `metadata.fromName = 'landing'`. Rename is one event (atomic intent); flatten cascades emit per-flatten events with `metadata.flattened: true` for trace.

### Q9 — Review-workflow interaction

**Locked: N-A.2 (auto-withdraw on archive) + N-B.1 (restore always to draft).**

When archive happens to a non-draft item:

| Prior state | Archive behavior |
|---|---|
| `draft` | Archive proceeds normally |
| `pending-review` | Auto-withdraw fires first; archive proceeds. Two audit events emitted (`review-withdraw` with `metadata.autoWithdrawn: true`, then `archive`). Reviewer queue updates. |
| `approved` | Approved state discarded as part of archive. `metadata.priorReviewState: 'approved'` recorded on the archive event (no synthetic withdraw event). |

When restore happens:

| Prior state | Restored state |
|---|---|
| Was `draft` | `draft` |
| Was `pending-review` (auto-withdrawn at archive) | `draft` |
| Was `approved` | `draft` |

Author has to re-submit if review needed. Auto-restoring to `approved` would let stale content ship without re-validation. Auto-restoring to `pending-review` would re-fire reviewer notifications for stale content.

**When `reviewWorkflow.enabled: false`** for the target: all of this is moot. Archive/restore don't touch a state that doesn't exist.

### Q10 — Publish behavior

**Locked: O2 revised — HTML markers everywhere (one mechanism), `_redirects` only as host-glue exception for plain-static.**

The earlier draft of this lock split mechanisms by target type — HTML
markers for static, per-edge sidecars (`pages/{name}/.archived-alias-X`)
for ESI. That split was speculative — both mechanisms could work for both
target types, and ESI's reasoning (worker needs to know whether to compose
at all) didn't hold up under inspection: ESI workers already read
`pages/{name}/index.html` as their composition starting point. Reading the
first 200 bytes of that file is cheaper than `readDir` to find a sidecar.

**Re-locked: HTML comment marker for all worker-served target types.**
One mechanism, one code path, one round-trip primitive. Sidecar mechanism
dropped — it would have doubled the surface for no real gain.

Static targets are the exception since #1152 (below): there the marker would sit at the page's public route, where plain hosts serve it, so publish writes no marker file at an archived route, and `gazetta serve` or a worker reads the page's archive sidecar where the route has no file, or the marker on the first line of a redirect page (follows from decisions 1, 2 and 8 below).

| Target type | Archive with `aliasOf` | Archive without `aliasOf` |
|---|---|---|
| **`static`** with worker | No marker file at the archived route (#1152 below); the worker reads the page's `.alias-X` archive sidecar, or the marker on the first line of the redirect page a target without `redirects.format` has there, and emits 301 to X's route in the request's language (`/fr/about` with alias `home` → `/fr`), or to X's default-language route when X has no version in that language. | No file at the route; the worker reads the `.gone` archive sidecar and emits 410. |
| **`static`** without worker | No marker file at the archived route (#1152 below). With `redirects.format`, `_redirects` regenerated at publish from walked archived manifests (host-glue), one row per language the target publishes (`/fr/landing  /fr/welcome  301`). Without it, a redirect page at the old route that starts with the marker (#1152 decisions 6 and 8). Plain static can't emit 410: no file and no row, so the host answers 404 (an S3 website may answer 403), showing the target's `404.html` on Pages, Netlify and GitHub Pages (#1152 decisions 3 and 4). Operator-config opt-in (not built): a 200 "Gone" placeholder page. |
| **`esi`** | Same HTML marker as static — worker reads first 200 bytes of `pages/{name}/index.html` BEFORE composing. Marker present → emit 301 without composing. | Same — marker present → emit 410 without composing. |
| **`dynamic`** | Origin emits HTML marker OR returns 301 directly. Same marker grammar as static / ESI. | Same — 410. |

Decided: maintainer, 2026-10-22 (#1124): an alias redirect keeps the request's language, and `_redirects` has one row per language the target publishes.

| Rejected | Why |
|---|---|
| Redirect in the default language (`/fr/about` → `/`) | The French visitor lands on the English page, and nothing sends them back: the worker has no Accept-Language redirect |
| `_redirects` rows for the default language only | `/fr/landing` on a plain-static site serves its blank archive marker, or a 404 |

On a plain-static target, when the alias's destination has no version in a language, that language's row points at the destination's default-language page (`/fr/landing  /welcome  301`). Static publish writes a language only where the page has it, so `/fr/welcome` doesn't exist there. (An ESI target serves the default-language page at `/fr/welcome`, so its redirects keep the language.)

Decided: maintainer, 2026-10-22 (#1124)

| Rejected | Why |
|---|---|
| Keep the row at the destination in that language (`/fr/landing  /fr/welcome  301`) | Static publish writes no `/fr/welcome`, so the redirect lands on a 404 |
| No row for that language | `/fr/landing` then serves its blank archive marker, or a 404 |

On a static target served by `gazetta serve` or a worker, the archive's 301 does the same: when the destination has no version in the request's language, it goes to the destination's default-language page. `gazetta serve` has the site's languages since #1155 ([#1138](https://github.com/gazetta-studio/gazetta-studio/issues/1138)), and this rule keeps it from sending `/fr/landing` to a 404 at `/fr/welcome`.

Decided: maintainer, 2026-10-22 (#1124)

| Rejected | Why |
|---|---|
| Keep the request's language when serving | With the site's languages (#1155), that would send `/fr/landing` to `/fr/welcome`, a 404 on a static target served by `gazetta serve`, while on Cloudflare Pages the same target redirects to `/welcome` |

#### Static targets: no file at an archived route (#1152)

What the hosts do, from their docs on 2026-10-23, not tested on the hosts (decision 5):
- **Netlify** doesn't apply a `_redirects` row at a path where a file exists unless the row is forced with `!`, shows a site's `404.html` for missing paths (its docs don't state the status code), and doesn't list 410 among its status codes ([redirect options](https://docs.netlify.com/routing/redirects/redirect-options/)).
- **Cloudflare Pages** always follows `_redirects` rows, "regardless of whether or not an asset matches the incoming request"; supports 301, 302, 303, 307, 308 and 200, not 410 ([redirects](https://developers.cloudflare.com/pages/configuration/redirects/)); shows the closest `404.html` for missing files, looking up the folder tree to `/404.html`, and without a top-level one serves the homepage for any unknown path ([serving Pages](https://developers.cloudflare.com/pages/configuration/serving-pages/)). Pages' docs state no status code for either; the same mode on Workers serves `404.html` with 404 ([static assets](https://developers.cloudflare.com/workers/static-assets/routing/static-site-generation/)).
- **GitHub Pages** shows a `404.html` at the root of the publishing source for pages that don't exist; its docs don't state the status code either ([custom 404](https://docs.github.com/en/pages/getting-started-with-github-pages/creating-a-custom-404-page-for-your-github-pages-site)).
- **S3 websites** answer a missing key with 404, or 403 when the bucket's policy doesn't allow listing (`design-live-check.md` Q3), and show a custom error page for either only when the bucket's website settings name it (for example `404.html`) ([custom error document](https://docs.aws.amazon.com/AmazonS3/latest/userguide/CustomErrorDocSupport.html)).
- **Google** reads an instant meta refresh as a permanent redirect, while preferring server-side redirects ([redirects](https://developers.google.com/search/docs/crawling-indexing/301-redirects)), and treats 404 and 410 alike ([HTTP status codes](https://developers.google.com/crawling/docs/troubleshooting/http-status-codes)).

Until these cuts ship, static publish writes the marker at the archived route (`publish-item.ts:369–387`): Netlify doesn't apply the rows there; Pages follows its alias rows but serves the marker, a blank page with status 200, for an archive without an alias (and for every archive on a target without `redirects.format`); GitHub Pages and S3 websites serve it for every archive.

**1. No marker file at the route; `gazetta serve` reads the archive sidecar.** On static targets with `redirects.format` (decision 2: every static target), publish writes no marker file at an archived route. When a route has no file, `gazetta serve` takes the page's name from the route (routes are `deriveRoute(name)`, `site-loader.ts:125`), reads its archive sidecar (`.gone` or `.alias-<name>`, `design-target-removal.md` Q6) and answers 301 or 410 as before (where the route has a redirect page, it reads the marker on the page's first line: decision 8); hosts with `_redirects` apply their rows and their own 404. This waits for target removal cut 1, which adds the sidecars.

Decided: maintainer, 2026-10-23 (#1163).

| Rejected | Why |
|---|---|
| Keep the marker file at the route | Plain hosts keep serving it: Netlify needs forced rows (`301!`), and where a host can't redirect, the best it can show is a "page removed" page with status 200 (per its docs, Pages can't turn a path that has a file into a 404 or 410). |
| Targets with `redirects.format` are for plain hosts only | `gazetta serve` would answer 404 at archived routes there, so a local preview of such a target no longer shows the redirects. |

**2. Every static target; a redirect page where the host has no rules.** No static target gets the marker file. With `redirects.format`, the host's rows do the work and nothing is written at the route. Without it (GitHub Pages, an S3 website, a plain web server), an archived page with an alias gets a redirect page at its old route (decision 6); a removed page gets no file, so the host's own 404 (decision 3).

Decided: maintainer, 2026-10-23 (#1163).

| Rejected | Why |
|---|---|
| Nothing at the route on any target | Renamed pages on hosts without rules would answer 404 instead of redirecting. |
| Only targets with `redirects.format` | The others keep today's blank page with status 200. |

**3. A `404.html` at every static target's root.** Static publish also writes the site's `/404` page (`pages/404/`, which `gazetta init` creates), in the default language, as `404.html` at the target root, so Pages, Netlify and GitHub Pages show it for unknown and removed pages, with status 404 expected (decision 5). A site without a 404 page gets a minimal noindex "Page not found" page. Static `gazetta serve` shows it too (decision 9).

Decided: maintainer, 2026-10-23 (#1163).

| Rejected | Why |
|---|---|
| Only when the site has a 404 page | Sites without one keep each host's default: on Pages, the homepage for every unknown path. |
| Only on Pages targets | Netlify and GitHub Pages use a top-level `404.html` too, so the site's own 404 page would go unused there. |
| Each language's 404 page too (`fr/404.html`) | Pages would show it, since it uses the closest `404.html`, and so would Netlify with a `/fr/*  /fr/404.html  404` row per language, but GitHub Pages and S3 websites would keep showing the default one, so visitors would get a different 404 page per host; cut 1 stays small (Future directions). |

**4. Removed pages answer 404 on every plain host.** `_redirects` writes no 410 rows for `netlify` either (#1149 drops them for `cloudflare`), so a removed page on a plain host answers 404 (an S3 website may answer 403), with the site's 404 page on Pages, Netlify and GitHub Pages. Q14's invariant 2 is scoped to match: 410 wherever Gazetta answers the request (Q14). `gone-status` stays a worker capability, as `inspectTarget` already says, and `docs/runtime-capabilities.md`, which marks it ✓ for these formats, is corrected. `json` keeps its gone list for custom integrations.

Decided: maintainer, 2026-10-23 (#1163).

| Rejected | Why |
|---|---|
| Keep 410 rows on Netlify and test them first | Netlify's docs don't list 410, and Google treats 404 and 410 alike, so a working 410 would gain nothing in search. |
| Keep 410 rows on Netlify untested | Rows that may not work, resting on old forum posts. |

**5. Locked from the hosts' docs.** The host behaviour above is from the hosts' docs, not tested on the hosts. None of the hosts' docs states the status code of `404.html`, nor Pages' docs that of its homepage fallback, so the 404 status in these decisions is expected, not documented. The Netlify and Pages deploy adapters (#209, #210) test it on real deploys, and the live check (designed, not built) will flag any difference after a publish: on every target with a `siteUrl`, GitHub Pages included, it requests an unknown URL and expects 404, and on a target without `redirects.format` it expects the redirect page at an alias's old route (`design-live-check.md` Q3).

Decided: maintainer, 2026-10-23 (#1163).

| Rejected | Why |
|---|---|
| Test on throwaway Netlify, Pages and GitHub Pages sites before locking | Needs a Netlify account and a Cloudflare token that can deploy Pages, while no one deploys to these hosts through Gazetta before those adapters exist. |
| Also test GitHub Pages on a real deploy in its adapter cut (#208) | Once built, the live check's request for an unknown URL will flag a GitHub Pages target that answers 200, after every publish. |

**6. The redirect page.** At an alias's old route on a target without `redirects.format`: the archive marker as its first line (decision 8), an instant meta refresh to the new address, a canonical link to it, and a short line with a link ("This page has moved to /welcome") for visitors whose browser doesn't follow the refresh. No noindex, so search engines take it as a redirect. Publish writes a redirect page in each language the archived page has, at the routes it really had; a language the page never had gets none, since static publish never wrote that route. A redirect page in a language points at the destination in that language when it has a version there, else at its default-language page (the rule above). This is the shape of WCAG's technique H76: a zero-second refresh, a line with a link to the new address, and nothing on the page that isn't about the redirect ([H76](https://www.w3.org/WAI/WCAG22/Techniques/html/H76)).

Decided: maintainer, 2026-10-23 (#1163).

| Rejected | Why |
|---|---|
| Refresh and canonical only | A browser that doesn't follow the refresh shows a blank page. |
| Also noindex | It may stop search engines from passing the old URL's standing to the new one. |
| A redirect page in every language the target publishes, like the `_redirects` rows | Publishing the default-language page would own files at other languages' routes, to delete when the page goes live again in fewer languages or is removed, for URLs a static target never had. |

**7. Cuts.**

| # | What | Depends on | Test tier | Risk |
|---|---|---|---|---|
| 1 | `404.html` at every static target's root: the site's `/404` page in the default language, or a minimal noindex "Page not found" page; static `gazetta serve` answers a missing path with it and status 404 (decision 9). Docs: `docs/runtime-capabilities.md` says plain hosts show it, and drops the claim that search engines keep a 404 URL in their crawl queue; `docs/soft-delete.md` drops its claims that 410 is better for search (Q14) | — | api-first | Low |
| 2 | No file at archived routes on static targets: publishing an archive deletes the page's file at its route in each language (its live HTML, or a marker written before this cut), as a step of the page's publish: if the delete fails, the item fails (`STORAGE_WRITE_FAILED`, no hash sidecar), so the next publish retries it; the redirect page, starting with the marker, at an alias's old route in each language the page has, on targets without `redirects.format`; when a route has no file, static `gazetta serve` takes the page's name from the route (the reverse of `deriveRoute`, after the language prefix) and lists `pages/{name}/` for its archive sidecar; `inspectTarget`'s gap messages say what plain hosts now serve. Docs: `docs/soft-delete.md` and `docs/runtime-capabilities.md` say what plain hosts serve at archived routes | target removal cut 1 | api-first | Medium |

Each cut updates the user docs its change affects (team rule 8). The 410 rows for `netlify` go with #1149, which drops them for `cloudflare` in the same builder, together with `docs/runtime-capabilities.md`'s `gone-status` column (decision 4). Static targets published before cut 2 keep their marker files until each archive is published again; a one-time `gazetta publish <target> --force` clears them, the same step target removal cut 1 needs. `--force` republishes only items on the source, so an archive already purged there keeps its marker file until its removal is published (target removal cut 2).

Decided: maintainer, 2026-10-23 (#1163).

| Rejected | Why |
|---|---|
| A separate docs cut after cuts 1 and 2 | Team rule 8: docs land in the same commit as the change they describe. |
| The Netlify 410 rows as a third cut | One more cut for a change to the builder #1149 already changes. |
| One cut after target removal cut 1 | Pages sites would wait for the sidecars to get a real 404 page. |

**8. The redirect page starts with the marker.** Its first line is the archive marker comment, which browsers don't show. `gazetta serve` and a worker read the first 200 bytes, as they do today, and answer 301 there; a plain host serves the page. No extra read.

Decided: maintainer, 2026-10-23 (#1163).

| Rejected | Why |
|---|---|
| Serve checks the archive sidecar before serving any file | One extra storage read per request, for every page on the target. |
| Serve sends the redirect page with status 200 | A server-side 301 is what the first decision kept for `gazetta serve`; the meta refresh is the fallback for hosts that can't redirect. |

**9. Static `gazetta serve` shows the target's `404.html`.** On a missing path, `gazetta serve` on a static target answers with the target's `404.html` and status 404 (one read), so previewing a target locally looks like its host; a target published before cut 1 has no `404.html`, and serve keeps its one-line page there. ESI targets already get the site's `/404` page from serve (`serve.ts:343`). Part of cut 1.

Decided: maintainer, 2026-10-23 (#1163).

| Rejected | Why |
|---|---|
| Leave serve as is | A local preview shows serve's one-line "Page not found" while the host shows the site's 404 page. |

**Archived page HTML body content:**

When a page is archived, the publish flow writes ONLY the marker line to
`pages/{name}/index.html` — no doctype, no body, no CSS/JS/sidecars
beyond the page content hash sidecar (used by compare-targets). On static
targets it writes no marker file at the route; a target without
`redirects.format` gets a redirect page there instead, with the marker
as its first line (#1152 above).

Justification, for the marker-only files on ESI and dynamic targets: the
worker short-circuits on the marker; no consumer ever parses the file
beyond byte 200. Skipping body emission saves a few KB per archived
page across N targets. Body content for an archived page is dead
weight there. (A static target's redirect page has a body, which plain
hosts serve and browsers use: decision 6.)

**HTML marker grammar:**

```
<!-- gazetta:archived alias=<bare-name> -->
<!-- gazetta:archived gone -->
```

- Must be the first line of the file (worker reads first 200 bytes; absence falls through to normal serve)
- `<bare-name>` is the target name. The worker resolves it with `deriveRoute()` plus the request's locale prefix, the way the site loader builds locale routes, so visitors stay in their language. On a static target it adds the prefix only when the destination has a version in that language (follows from the Q10 table's static-with-worker row)
- Single-line; no nested HTML; no whitespace games

Storage providers' `readBytes` supports range reads (per `design-media.md`); first-200-bytes is one cheap read, an order of magnitude smaller than a typical HTML file.

**Cache headers on archive responses:**

Strip strong caching: 301/410 responses get `Cache-Control: max-age=300` (5 minutes); operator override available. Lets unarchive propagate quickly without burning origin load.

**No publish-time aggregate manifests** for archive state. Workers read the page HTML's marker line; that's source-of-truth (on static targets, the page's archive sidecar: #1152 above). Per-edge granularity — multi-instance correct, scales naturally.

**Aggregate exception:** `_redirects` for Cloudflare/Netlify (external standard, host-glue), regenerated each publish from walked archived manifests (decided: from the target's archive sidecars instead, [`design-target-removal.md`](design-target-removal.md) Q6). A purge changes nothing on a target until its removal is published (same doc, Q5). Optional per-target `redirects.format: 'cloudflare' | 'netlify' | 'json' | 'none'` config; default depends on target's runtime hint.

**Capability-gap UX (locked; foundational principle for all features needing runtime capabilities):**

| Surface | Behavior |
|---|---|
| 1. Boot config validate | `runtime: 'plain-static'` + archive operations attempted → boot warning ("redirects won't fire on plain-static; use a worker-capable runtime") |
| 2. Author-time modal | Archive modal shows per-target capability badges: "On `staging`: 301 ✓ • On `production-static`: 404 (no worker) ⚠"; author chooses to proceed or switch active target |
| 3. Validator scanner | `archive-not-supported-on-target` warn fires for archived items on plain-static targets; surfaces in site-health drawer |
| 4. Publish gate | Pre-publish modal lists per-target compatibility issues; operator promotes to error or accepts |

Same four-point pattern applies to all future features needing runtime capabilities (presence, RBAC content filtering, dynamic fragments).

### Q11 — Validation integration

**Locked: P1-P5 + P7/P8 as save-handler checks; P6 deferred.**

Validators (per `design-validation.md`):

| Validator | save-delta | background | pre-publish | cli |
|---|---|---|---|---|
| `referenced-archived-without-alias` (P1) | warn (when newly introduced) | warn | warn (operator promotes to error per archetype) | warn |
| `dangling-alias` (P2) | error | error | error | error |
| `circular-alias` (P3) | — | error | error | error |
| `archive-not-supported-on-target` (P4) | — | warn | warn | warn |
| `aliasOf-points-to-archived` (P5) | — | warn | warn | warn |

**Save-handler checks (not validators per se):**
- **P7** — refuse rename to archived target. 409 `ARCHIVED_NAME_CONFLICT` triggers Q5's prompt UX.
- **P8** — refuse archive without `aliasOf` when live refs exist. 409 `ARCHIVE_HAS_LIVE_REFS`. Resolution UX from Q4. Admin-only `?force=true` bypass.

**P6 (`archived-with-pending-review`)** — deferred until review-workflow Cut 6 ships.

### Q12 — TTL / retention

**Locked: K6 — defer; CLI + cron handles bulk purge.**

Archive retention is not enforced in v1. Items stay until manual purge. Operators run cron jobs:

```bash
gazetta archive purge --older-than=180d --kind=page
```

Forward-compatible: future `admin.archive.retention` config block is additive.

### Q13 — Bulk operations

**Locked: L4 — CLI-only; UI multi-select deferred.**

CLI ships:
```bash
gazetta archive list                              # all archived items
gazetta archive list --kind=page --since=2024-01-01
gazetta archive list --filter=template:blog-post

gazetta archive purge <name>                       # one item; honors live-ref check
gazetta archive purge --filter=...                 # bulk
gazetta archive purge --older-than=180d
gazetta archive purge --force                      # admin-equivalent bypass

gazetta archive restore <name>                     # one item
gazetta archive restore --filter=...               # bulk

gazetta archive rename <oldname> <newname>         # composes archive + create
```

CLI exit code is non-zero on any item failure. Each operation emits standard audit events. Multi-instance correct.

### Q14 — Redirect lifecycle

**Locked: L4 — defer entirely; v1 ships permanent (301) only.**

Renames produce permanent (301) redirects. Temporary (302), scheduled (date-based), and time-bounded redirects are reserved for a future design pass.

**Locked invariants the future design must respect:**

1. Renames produce 301; never 302 ("I renamed this; the rename is permanent" — don't break this expectation later)
2. Archive without `aliasOf` produces 410, not 404, wherever Gazetta answers the request (a worker, `gazetta serve`, a dynamic origin); plain static hosts answer 404 (below)
3. Manifests are the data, sidecars are derived (future scheduling fields go on the manifest)
4. HTML marker grammar is extensible (new markers land additively)
5. Capability gap surfaced at four points (future redirect-lifecycle features inherit the pattern)

Invariant 2 was scoped by #1152: plain hosts don't send 410 from `_redirects` (Cloudflare Pages doesn't support it, and Netlify doesn't document it, so Gazetta writes no such rows), so they answer 404 (Q10, #1152 decision 4). Google treats 404 and 410 alike ([HTTP status codes](https://developers.google.com/crawling/docs/troubleshooting/http-status-codes)), so 410 is the more precise answer, not a search-engine requirement.

Decided: maintainer, 2026-10-23 (#1163).

| Rejected | Why |
|---|---|
| Keep invariant 2 as written, with 410 rows on Netlify | No Netlify doc confirms that 410 rows work; they rest on old forum posts. |
| Drop the invariant | Workers answer 410 today at no cost; any target could then answer 404. |

Operators with temporary-redirect needs use their host's mechanism (Cloudflare Page Rules, etc.) until Gazetta supports natively.

## Foundational checks

How soft-delete composes with each of the other 12 foundational dimensions plus the multi-instance discipline.

### Multi-instance discipline
- Archive transitions are saves to the manifest. Standard last-write-wins on conflicting writes.
- Per-edge sidecars (ESI archive markers) follow the same pattern as `.uses-{frag}` and asset-refs sidecars — multi-instance correct via per-edge granularity.
- Flatten cascade (Q3) is per-manifest writes; concurrent renames don't race on the same manifest path.
- Cache invalidation propagates via existing SSE infrastructure.

### Scale (#1)
- Archive count is bounded by total page count; no new envelope dimension.
- Tree filter "Show archived" reuses existing virtualization (`@tanstack/vue-virtual` per `design-scale.md`).
- Archive operations are O(1) per item save + O(N) flatten where N = aliases pointing here (small).
- Permanent-delete with `?force` is O(1); without is O(N) live-ref scan via existing dependents primitive.

### Locale (#2) + Themes (#3)
- Archive is per-page in v1. Locale variants (`page.fr.json`) inherit the parent's archive state.
- Per-locale archive deferred; future-additive.

### Auth + RBAC (#4)
- `delete:pages` / `delete:fragments` capability gates archive AND purge AND rename.
- Admin-only `?force=true` bypass on purge.
- Archive's `archivedBy` is a `Principal` snapshot.

### Audit (#5)
- New closed-enum action values: `archive`, `unarchive`, `purge`, `rename`.
- Outcome enum unchanged: `success`, `forbidden`, `validation-failed`, `unauthenticated`.
- Forensic reconstruction via `scope.name` + `metadata.fromName` for renames.
- Flatten cascade emits per-flatten events with `metadata.flattened: true`.

### Review (#6)
- Auto-withdraw on archive (Q9 N-A.2) — emits `review-withdraw` with `metadata.autoWithdrawn: true` then `archive`.
- Restore always to draft (Q9 N-B.1) — author re-submits if review needed.
- `priorReviewState` recorded on archive event for forensic reconstruction.

### Hooks (#7)
- Archive/unarchive/purge/rename are saves; standard `beforeSave` / `afterSave` hooks fire.
- Future archive-specific hooks (`beforeArchive`, `afterRename`) reserved if concrete demand surfaces.

### Render (#8)
- ESI and dynamic targets: HTML comment marker as the first line of `pages/{name}/index.html` drives 301/410. Worker reads first 200 bytes; marker present → short-circuit before composing. Static targets have no marker file at an archived route: `gazetta serve` or a worker reads the page's archive sidecar, or the first line of a redirect page (Q10, #1152).
- Plain-static (no worker): `_redirects` host-glue regenerated from walked archived manifests; without `redirects.format`, a redirect page at an alias's old route (Q10, #1152); capability-gap warning surfaces non-supported features.
- Alias-aware composition: renderer follows `aliasOf` for fragment refs at compose time.
- No publish-time aggregates (per Q10 lock); manifests + page HTML markers (archive sidecars on static targets) are source-of-truth.

### Validation (#9)
- 5 new validators (P1-P5 from Q11).
- 2 save-handler checks (P7/P8 from Q11).
- Composes with existing site-health drawer + pre-publish modal.

### Plugin (#10)
- No plugin-supplied surfaces specific to soft-delete in v1.
- Future: `referenced-archived-without-alias` extensibility (custom severity per archetype) lands when validation Cut 4 publish-gate config ships.

### Cache (#11)
- Archive operations invalidate `pages:` / `fragments:` prefixes (existing pattern).
- Cached values include archived items; `archived: true` is a manifest field consumed by readers.
- L4 + L6 (browser admin) cascade invalidation via existing SSE.

### Offline (#12)
- Archive/unarchive/purge/rename queue + replay on reconnect (same as save).
- Pending operations show cloud-with-slash icon (per `design-offline.md` UX).
- Conflict on replay: standard etag-based 409 STALE flow.

### Collaboration (#13)
- Comments on archived items: visible read-only (matches the editor pane being read-only).
- Mentions in archived item content: still resolve normally (mention is on the actor, not the page).
- Restoring an archived item with comments: comments come back as-is.

### Site config (`design-config.md`)
- Per-target `redirects.format` config for static-host glue (default chosen per `runtime` field).
- No site-level archive config in v1.
- Future `admin.archive.retention` (K6) is additive.

## Migration

Existing sites without archive operations: continue to work. The `archived` field is optional; absent = live. No data migration.

Existing `DELETE` handlers: upgrade to soft-delete in v1 (existing items become archived rather than disappear). Hard-delete becomes the explicit "Delete permanently" action; preserves user intent. **Note:** sites running an automated cleanup CLI that calls `DELETE` will see soft-delete behavior; the CLI gets a `gazetta archive purge` command for the explicit hard-delete intent.

Per-instance config:
```ts
admin: {
  // Future fields (forward-compat):
  // archive: {
  //   retention: { maxAgeDays: 90 },         // K6 deferred
  //   bulkUI: 'enabled',                      // L4 deferred
  // },
}
```

## Future directions

**Soft-delete extension to assets** (v1.5): asset rename + archive uses the same primitive. Replaces the existing "delete blocked when refs > 0" hard-fail with the alias mechanism.

**Per-locale archive**: archive only the French variant of a page; default + other locales stay live. Composes with `design-i18n.md`'s locale-variant manifests.

**Manual redirect creation in admin UI**: the HTML-marker mechanism supports redirects-without-archive (operator creates an archive-only manifest with `aliasOf` set, which emits the marker). UI surface lands when concrete demand surfaces (`design-seo.md`'s deferred Tier 2 punch-list).

**Bulk operations in admin UI** (L4 deferred): multi-select in tree, bulk archive/restore/purge with the standard resolution UX.

**Auto-archive retention** (K6 deferred): per-site or per-target TTL config. Composes with audit retention + history retention.

**Temporary redirects (302), scheduled redirects, A/B test redirects** (Q14 deferred): see locked invariants in Q14. A future design pass picks between L1/L2/L3 based on demand patterns.

**Time-locked archives**: "archive until date X, then auto-restore." Different from auto-archive (TTL-driven purge); same mechanism (cron/scheduled state transitions). Composes with future scheduling primitive.

**Find-and-replace across content**: not directly archive-related; orthogonal feature.

**Archive an entire path subtree**: archiving `pages/blog/` and all descendants. Composes with archive's per-edge mechanism but adds bulk semantics; defer until concrete demand.

**Per-language 404 pages on Pages and Netlify**: Pages shows the closest `404.html` up the folder tree, and Netlify can show `fr/404.html` through a `/fr/*  /fr/404.html  404` row in `_redirects`, so static publish could write each language's 404 page for that language's visitors. GitHub Pages and S3 websites show one error page per site, which is why #1152 decision 3 writes the default language only.
