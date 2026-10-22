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
| Archived, `aliasOf: 'newname'` | Renderer transparently follows the alias. `@oldname` resolves as `@newname`. Page route `/oldname` emits 301. On ESI targets, serving also follows a fragment's alias marker, for pages published before the fragment was archived. |
| Archived, no `aliasOf` (pure soft-delete) | Validator warning at save + scanner; render-time emits 410 (page) or render-time error (fragment). An ESI page that still uses such a fragment is served without it (200, with a comment in its place, as for a missing fragment), not 410: the page isn't gone, only one part of it (decided 2026-10-22, #1118). |

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

| Target type | Archive with `aliasOf` | Archive without `aliasOf` |
|---|---|---|
| **`static`** with worker | HTML carries `<!-- gazetta:archived alias=X -->` marker. Worker reads first 200 bytes; emits 301 to X's route in the request's language (`/fr/about` with alias `home` → `/fr`). | HTML carries `<!-- gazetta:archived gone -->` marker. Worker emits 410. |
| **`static`** without worker | `_redirects` regenerated at publish from walked archived manifests (host-glue). Plain static can't emit 410; falls to host's natural 404. Operator-config opt-in: emit a 200 "Gone" placeholder page. |
| **`esi`** | Same HTML marker as static — worker reads first 200 bytes of `pages/{name}/index.html` BEFORE composing. Marker present → emit 301 without composing. | Same — marker present → emit 410 without composing. |
| **`dynamic`** | Origin emits HTML marker OR returns 301 directly. Same marker grammar as static / ESI. | Same — 410. |

**Archived page HTML body content:**

When a page is archived, the publish flow writes ONLY the marker line to
`pages/{name}/index.html` — no doctype, no body, no CSS/JS/sidecars
beyond the page content hash sidecar (used by compare-targets).

Justification: the worker short-circuits on the marker; no consumer ever
parses the file beyond byte 200. Skipping body emission saves a few
KB per archived page across N targets. Body content for an archived
page is dead weight regardless.

**HTML marker grammar:**

```
<!-- gazetta:archived alias=<bare-name> -->
<!-- gazetta:archived gone -->
```

- Must be the first line of the file (worker reads first 200 bytes; absence falls through to normal serve)
- `<bare-name>` is the target name. The worker resolves it with `deriveRoute()` plus the request's locale prefix, the way the site loader builds locale routes, so visitors stay in their language (decided 2026-10-22, #1118)
- Single-line; no nested HTML; no whitespace games

Storage providers' `readBytes` supports range reads (per `design-media.md`); first-200-bytes is one cheap read, an order of magnitude smaller than a typical HTML file.

**Cache headers on archive responses:**

Strip strong caching: 301/410 responses get `Cache-Control: max-age=300` (5 minutes); operator override available. Lets unarchive propagate quickly without burning origin load.

**No publish-time aggregate manifests** for archive state. Workers read the page HTML's marker line; that's source-of-truth. Per-edge granularity — multi-instance correct, scales naturally.

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
2. Archive without `aliasOf` produces 410, not 404 (search-engine semantics)
3. Manifests are the data, sidecars are derived (future scheduling fields go on the manifest)
4. HTML marker grammar is extensible (new markers land additively)
5. Capability gap surfaced at four points (future redirect-lifecycle features inherit the pattern)

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
- All worker-served target types: HTML comment marker as the first line of `pages/{name}/index.html` drives 301/410. Worker reads first 200 bytes; marker present → short-circuit before composing.
- Plain-static (no worker): `_redirects` host-glue regenerated from walked archived manifests; capability-gap warning surfaces non-supported features.
- Alias-aware composition: renderer follows `aliasOf` for fragment refs at compose time.
- No publish-time aggregates (per Q10 lock); manifests + page HTML markers are source-of-truth.

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
