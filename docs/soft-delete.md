# Soft delete (archive, alias, rename, restore, purge)

Pages and fragments transition to an **archived** state instead of being hard-deleted. Archived items optionally carry an **alias** (`aliasOf`) that resolves references at render time and emits a `301` redirect from the old URL. **Rename** composes archive + create-with-alias atomically. Archived items can be **restored** (back to live) or **purged** (permanent delete).

Soft delete is **on by default**. Zero config: deleting from the admin UI archives instead of permanently removing; the existing `DELETE /api/pages/:name` route now archives unless called with `?permanent=true`.

## At-a-glance

| Operation        | What happens                                                               | Recoverable?         |
| ---------------- | -------------------------------------------------------------------------- | -------------------- |
| **Archive**      | Manifest gets `archived: true`; old URL redirects (301) when `aliasOf` set | Yes, via Restore     |
| **Archive (no alias)** | Same, but old URL emits `410 Gone` where Gazetta answers the request | Yes, via Restore     |
| **Rename**       | Old name archived with `aliasOf: <new>`; new name created live              | Yes, restore the old |
| **Restore**      | Strips archive fields; item is live again at its old name                  | n/a                  |
| **Purge**        | Permanently deletes the manifest. Blocked when refs exist.                 | No (use with care)   |
| **Force purge**  | Admin-only `?force=true`; bypasses ref-existence check                      | No; aliases dangle   |

## Why archive, not hard-delete?

Hard-delete creates broken links: every page that referenced `@old-fragment` 500s on next render; every external link to `/old-page` 404s. Archive solves both:

1. **Renderer follows aliases** — `@oldname` transparently resolves as `@newname` when `oldname` is archived with `aliasOf: newname`.
2. **Worker emits 301** — visitors hitting `/oldname` are redirected to `deriveRoute('newname')`. Search engines update their index automatically.
3. **Pure soft-delete (no alias) emits 410** — wherever Gazetta answers the request (a worker, `gazetta serve`). Google treats 404 and 410 alike and drops the URL from its index either way.

The mechanism is **content-addressed** at the manifest level: the `archived` field on the manifest IS the source of truth. Workers read the first 200 bytes of `pages/{name}/index.html` at request time; an HTML comment marker (`<!-- gazetta:archived alias=X -->` or `<!-- gazetta:archived gone -->`) drives the response. No publish-time aggregate manifests; per-edge granularity scales to 5,000+ pages.

## Manifest fields

Archive state lives on the manifest as additive optional fields:

```jsonc
{
  "template": "page-default",
  "content": { "title": "Old landing page" },

  // Archive fields (all optional; absent = live)
  "archived": true,
  "archivedAt": "2026-05-09T14:30:00Z",
  "archivedBy": "alice@example.com",
  "aliasOf": "welcome"
}
```

`archivedBy` is a snapshot at archive time — it doesn't auto-update if the user's role changes. `archived: false` is treated identically to `archived` absent.

## Operations

### Archive

From the admin UI: select the page → **Archive** in `PageMetadataEditor` (or the editor's secondary menu for fragments). The modal asks for an optional `aliasOf` target — pick a live page/fragment to redirect to, or leave it empty for pure soft-delete.

From the API:

```
POST /api/pages/:name/archive
Content-Type: application/json

{ "aliasOf": "welcome" }   // optional
```

Returns `200 { ok: true, name, archivedAt, aliasOf? }`.

`aliasOf` is a page or fragment name: no spaces, no leading `/`, no `\`, `?`, `#`, `<` or `>`, and no empty, `.` or `..` parts. Anything else returns `400`, here and when editing an alias.

Capability: `delete:pages` (or `delete:fragments`). Same authority as the hard-delete operation it replaces — archive removes from the live tree.

**Refuse-with-live-refs (P8 save-handler check):** when archiving without `aliasOf` AND live items reference the target, the route returns `409 ARCHIVE_HAS_LIVE_REFS` with the blocking refs in the body. Author resolves by setting `aliasOf` (which keeps refs working via the alias chain) OR removing the live refs first. Admin operators can bypass with `?force=true`.

### Rename

Renaming `landing` → `welcome` is a composite operation:

1. Create `welcome` as a live page with `landing`'s content
2. Archive `landing` with `aliasOf: welcome`
3. Flatten cascade — walk archives where `aliasOf === 'landing'` and rewrite to `aliasOf: welcome` (the **flatten invariant**: aliases never form chains)

```
POST /api/pages/landing/rename
Content-Type: application/json

{ "to": "welcome", "keepAlias": true }   // keepAlias defaults to true
```

`keepAlias: false` skips step 2 — the old name is hard-deleted instead. Use only when no external links to the old URL exist; usually you want the redirect.

Capability: `edit:pages` (or `edit:fragments`). With `keepAlias: false` the old name is taken off the site, so the rename also needs `delete:pages` (or `delete:fragments`), and, like archiving without an alias, it returns `409 ARCHIVE_HAS_LIVE_REFS` while other items still use the old name, unless `?force=true`.

The flatten cascade is what keeps long chains from accumulating. Rename A → B, then B → C, then C → D: every prior archive's `aliasOf` resolves directly to D. One redirect hop, never recursive.

### Restore

Strips the archive fields and saves. Item reappears under its old name with content unchanged from archive time.

```
POST /api/pages/:name/unarchive
```

Restore **always returns to draft** — even if the item was approved when archived. Auto-restoring to `approved` would let stale content ship without re-validation.

### Purge

Permanently delete an archived item. Purging an item that is not archived returns `409 NOT_ARCHIVED` and writes nothing, even with `?force=true`; archive it first (the explicit `DELETE /api/{kind}/:name?permanent=true` route remains the way to hard-delete a live item). Blocked when:

- Other archives have `aliasOf: <target>` (alias-pointers)
- Live pages/fragments reference `<target>` directly

Returns `409 DELETE_BLOCKED` with structured body listing both blockers:

```jsonc
{
  "code": "DELETE_BLOCKED",
  "aliases": ["old-name-1", "old-name-2"],
  "liveRefs": [
    { "kind": "page", "name": "blog/post-1", "componentPath": "components.0" }
  ]
}
```

The admin's purge-blocked modal walks each blocker. Per row:

- **Drop alias** — strip `aliasOf` from the alias-pointer (it remains as a 410 archive)
- **Restore** — unarchive the alias-pointer (it goes back to live, redirect intact)
- **Open ref** — navigate to the page that references this name; remove the reference; save

After resolving, retry purge.

```
DELETE /api/pages/:name/purge
DELETE /api/pages/:name/purge?force=true   # admin only; bypasses block
```

Force-purge audit metadata records `bypassedAliases` and `bypassedRefs` so forensics finds what broke.

## Admin UI

| Surface | Location | What it does |
|---|---|---|
| **Tree filter** | Site tree top bar | "Show archived (N)" toggle; appears only when N > 0 |
| **Archived rows** | Site tree | Greyed; alias suffix in italic; click opens read-only editor |
| **Archive banner** | Editor pane | Shown above the editor when an archived item is selected; offers Restore / Edit alias / Delete permanently |
| **Archive modal** | Triggered from PageMetadataEditor | Confirms archive; optional aliasOf picker; per-target capability badges (see [runtime capabilities](runtime-capabilities.md)) |
| **Purge-blocked modal** | Triggered when purge returns 409 | Lists alias-pointers + live refs with per-row actions |
| **Archived-name-conflict prompt** | Triggered when creating a page whose name has an archive | Three options: Restore (default) / Replace / Move aside |

## Conflict on reusing an archived name

Creating new content under a name that has an archive (e.g., the user creates `pages/landing` after an old `landing` was archived) returns `409 ARCHIVED_NAME_CONFLICT`. The admin's prompt offers:

| Action | Behavior |
|---|---|
| **Restore** (default) | Unarchive the existing archive; skip creation |
| **Replace** | Permanently delete the archive (atomically); create new; alias-pointers re-targeted to the new item |
| **Move aside** | Old archive renames to `<name>-archived-<date>`; new content takes the name |
| **Cancel** | Backs out |

Programmatic clients pass `?onConflict=restore | replace | moveAside` on the create request:

```
POST /api/pages?onConflict=restore
{ "name": "landing", "template": "page-default" }
```

## Manual redirect creation

Most redirects appear as a side effect of rename — the old name is archived with `aliasOf: <new>`, the new name is created live, and visitors to the old URL get a 301 to the new one. Manual Redirects let an operator skip that path and create the archived-with-alias manifest directly, without an existing page that's being renamed away from.

Use cases:

- A marketing campaign URL (`/promo`) that should redirect to the current featured product (`/products/featured`)
- A redirect for a URL that was published outside Gazetta (printed material, partner site, analytics-discovered 404) — point it at the closest live page
- A short-lived alias during a campaign before the canonical page is renamed

The mechanism is the same archived-with-`aliasOf` manifest you get from rename — same HTML marker, same `_redirects` host-glue entry, same Show-archived row in the site tree.

### From the admin UI

The SiteTree's create-affordance row gains a "+ New redirect" button alongside "+ New page" and "+ New fragment". Click it to open the **Create Redirect** dialog:

1. **Kind** — toggle between Page and Fragment. Defaults to Page.
2. **Redirect from** — accepts either a URL (`/old-products`) or a name (`old-products`). Both produce a manifest at `pages/old-products/page.json`. The dialog previews the resolved route below the input so you can confirm before submitting.
3. **Redirect to** — the live page or fragment to redirect to. The input has a native autocomplete that suggests matching live items.
4. **Create redirect** — submits; the dialog closes on success and the new archive appears in the site tree under the "Show archived" toggle.

Capability gates: `edit:pages` for page redirects, `edit:fragments` for fragments. The same capability that creates and edits live content creates redirects — redirect creation adds state without destroying any (see `design-redirect-ui.md` Q8).

### From the API

```
POST /api/page-redirects
Content-Type: application/json

{ "from": "old-products", "to": "products/featured" }
```

Returns `201 { ok: true, from, to, kind: "page", route, targetRoute }` on success.

Same shape for fragments:

```
POST /api/fragment-redirects
Content-Type: application/json

{ "from": "old-header", "to": "header" }
```

Per Q4 of `design-redirect-ui.md`, the `from` field is normalized:

- Leading slashes are stripped (`/old-products` → `old-products`)
- `:param` is converted to `[param]` (Hono syntax → Gazetta dir naming)
- Then the result is checked against the wildcard reject (route patterns are out of v1)

### Conflict handling

| Situation | Server response | Resolution |
|---|---|---|
| `from` is a live page | `409 LIVE_NAME_CONFLICT` | Archive or rename the live page first, then create the redirect. **No destructive shortcut** from the create dialog. |
| `from` is already an archive | `409 ARCHIVED_NAME_CONFLICT` | Same three-option prompt as page creation: Restore (default) / Replace / Move aside. Pass `?onConflict=restore \| replace \| moveAside` from a programmatic client. |
| `to` doesn't exist as a live page/fragment | `409 ALIAS_TARGET_NOT_FOUND` | Pick a different alias target. |
| `from` is `"home"` | `400 INVALID` | The site root is reserved — use a worker-side route for root rewrites. |
| `from` contains `[param]` (after normalize) | `400 INVALID` | Wildcard from-routes are out of v1; configure the worker route directly. |

### Target capability gap

The runtime mechanism (HTML marker → 301) requires a worker-served target. The Create Redirect dialog surfaces per-target badges when the active site has targets that can't emit redirects:

> ⚠ Some targets won't emit this redirect
> · **github-pages** (production): plain-static target has no worker and no `_redirects` configured
> · **s3-static** (production): plain-static target has no worker and no `_redirects` configured

The operator can still submit — the manifest is identical regardless of target capability — but visitors on those targets get the host's natural 404 instead of a 301. Configure `redirects: { format: 'cloudflare' | 'netlify' | 'json' }` on the target (see [runtime capabilities](runtime-capabilities.md)) OR switch to a worker-served deployment.

### Audit

Each Manual Redirect creation emits `action: 'create-redirect'` with `metadata.aliasOf` set — distinct from the `rename` event that emits during a rename composition. Forensic queries can answer "which redirects were manually created vs. composed from rename" by filtering on the action enum (see `design-redirect-ui.md` Q7).

For background and rejected alternatives (why a single endpoint vs. two, why `edit:pages` vs. `delete:pages`, why no destructive shortcut), see [`design-redirect-ui.md`](../.claude/rules/design-redirect-ui.md).

## CLI

The `gazetta archive` subcommand lets you script archive operations against any target. Useful for cron-based retention, bulk migrations, or CI automation.

```
gazetta archive list [--kind=page|fragment]                              List archived items
gazetta archive purge <name> [--kind=...] [--force]                      Permanently delete an archive
gazetta archive restore <name> [--kind=...]                              Unarchive
gazetta archive rename <oldname> <newname> [--kind=...] [--no-keep-alias] [--force] Rename a live item
```

Exit code is non-zero on failure (validation, capability, blocked purge). Output is one line per archive in `list`; one line per result in the rest. Cron-friendly.

Examples:

```
$ gazetta archive list
page      old-landing                                2026-05-09T14:30:00Z  →welcome
page      retired-promo                              2026-04-01T10:00:00Z  gone
fragment  old-header                                 2026-03-15T09:00:00Z  →header

$ gazetta archive rename pages/landing welcome
✓ Renamed page landing →welcome (alias)

$ gazetta archive purge old-landing
✗ Purge blocked: page old-landing (DELETE_BLOCKED)
  1 archive(s) alias here. Resolve via admin UI or pass --force.
```

## Capability gaps and target types

The 301-redirect mechanism requires a **worker-served** target (`type: 'esi'` or `type: 'dynamic'`, or `type: 'static'` with a Cloudflare Worker / `gazetta serve`). Plain-static targets (Cloudflare Pages without a worker, GitHub Pages, S3 static-website) can't emit 301/410 by themselves.

For Cloudflare Pages and Netlify static deployments, opt into the `_redirects` host-glue file:

```ts
import { defineSite, r2Storage } from 'gazetta'

export default defineSite({
  targets: {
    'production-pages': {
      storage: r2Storage({ /* ... */ }),
      type: 'static',
      siteUrl: 'https://example.com',
      redirects: { format: 'cloudflare' },   // or 'netlify' | 'json' | 'none'
    },
  },
})
```

The `_redirects` file is regenerated each publish from walked archived manifests.

For deployments that don't support `_redirects` (e.g., raw S3 static-website), archive operations still work — the manifest is updated and the item disappears from the live tree — but visitors hitting the old URL get the host's natural 404 instead of a 301 redirect or 410 Gone. This **capability gap** is surfaced at four points so operators see it before it bites:

1. **Boot config validate** — once the site has archived pages, a warning when a target's runtime can't serve redirects (at boot in `gazetta dev`, on the first site-loading request in `gazetta admin`; a site with nothing archived gets none)
2. **Author-time modal** — the archive modal shows per-target capability badges
3. **Background scanner** — `archive-not-supported-on-target` validator surfaces in the site-health drawer
4. **Pre-publish gate** — listed alongside other publish-time issues

See [runtime capabilities](runtime-capabilities.md) for the per-target matrix.

## Validators

| Validator | When it runs | Severity |
|---|---|---|
| `referenced-archived-without-alias` | save-delta + background | warn |
| `dangling-alias` (aliasOf points at a name that doesn't exist) | save-delta + background + pre-publish | error |
| `circular-alias` (defensive — flatten guarantees this can't happen) | background + pre-publish | error |
| `archive-not-supported-on-target` | background | warn |
| `aliasof-points-to-archived` | background + pre-publish | warn |

These compose with the existing validation framework — the site-health drawer shows them alongside other issues.

## Audit

Every archive operation emits structured audit events. New action values:

| Action | When |
|---|---|
| `archive` | Soft-delete; metadata records `aliasOf`, optional `priorReviewState` |
| `unarchive` | Restore from archive |
| `purge` | Permanent delete; metadata records `forced: true` + `bypassedAliases` / `bypassedRefs` when force-purged |
| `rename` | Atomic composite (archive old + create new + flatten); metadata records `fromName` + `flattenedAliases` |
| `review-withdraw` | Synthetic event emitted before `archive` when archiving an item in `pending-review` state (forward-compat with the review-workflow foundation) |

Forensic queries reconstruct full history: filter by `scope.name = 'landing'` OR `metadata.fromName = 'landing'` to see everything that ever happened to that name.

## Migration

### From hard-delete to soft-delete

Existing `DELETE /api/pages/:name` calls now archive instead of hard-deleting. **Sites running automated cleanup** that calls `DELETE` will see soft-delete behavior; the items accumulate as archives instead of disappearing.

Two paths to restore the old behavior:

1. **Switch to `gazetta archive purge --filter=...`** for the explicit hard-delete intent (recommended)
2. **Append `?permanent=true`** to the `DELETE` call: `DELETE /api/pages/:name?permanent=true`

The `?permanent=true` route still goes through the purge gate (refuses on refs); add `&force=true` to bypass for admin-managed cleanups.

### From the existing publish flow

Archive is invisible to publish — the publish flow walks all manifests including archived ones, emits the HTML marker for archived pages, and republishes the rest normally. No publish-config change required.

### Sites without `redirects.format`

Plain-static targets without `redirects` configured continue to work unchanged; archive operations succeed but the host's natural 404 fires for old URLs (not 301/410). Add `redirects: { format: 'cloudflare' }` (or `'netlify'`) when you want host-glue support.

## Reference

- **Design doc**: `.claude/rules/design-soft-delete.md` — full rationale, locked Q&A, foundational checks
- **Implementation plan**: `.claude/rules/design-soft-delete-implementation.md` — 15-cut sequence
- **Audit shape**: [audit.md](audit.md) for the broader audit log; new actions documented above
- **Runtime capabilities**: [runtime-capabilities.md](runtime-capabilities.md) for the per-target matrix
