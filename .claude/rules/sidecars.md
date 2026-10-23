# Sidecar Files

Incremental publish and reverse-dependency queries rely on zero-byte files whose
**names** (and locations, for reverse-dep indices) encode metadata. No content
reads — directory listings return the state. Scales to 10k+ items.

## Kinds

Two roles, two storage shapes.

### Per-item sidecars (next to each page/fragment manifest)

| Name | Meaning | Example |
|---|---|---|
| `.{8hex}.hash` | Content hash of the manifest, optionally locale-suffixed | `.cf120e4b.hash`, `.cf120e4b.hash.fr` |
| `.pub-{ts}[-noindex][.{loc}]` | Last publish timestamp + noindex flag | `.pub-20260417T220000Z`, `.pub-20260417T220000Z-noindex.fr` |

Used by:
- `compareTargets` — listing target `.{hash}.hash` files to detect which items
  are out of sync without reading manifests, and the `.pub` sidecars' noindex
  flags, so a page whose published flag differs from the source is out of sync too.
- `gazetta publish` — published-state stamp + noindex propagation to sitemap
  generation.

### Reverse-dependency indices (`.gazetta/{relation}/{target}/{source}`)

One zero-byte file per dependency edge. The directory tree itself is the index:
`readDir` on `.gazetta/fragment-deps/header/` returns every page and fragment
that references `@header`.

| Path | Meaning | Example |
|---|---|---|
| `.gazetta/fragment-deps/{frag}/{source}` | `{source}` references `@{frag}` | `.gazetta/fragment-deps/header/pages.home` |
| `.gazetta/asset-refs/{asset}/{source}` | `{source}` references `{asset}` (media library entry) | `.gazetta/asset-refs/hero/pages.home` |

Source-item filenames encode `pages/<name>` as `pages.<name>` (slashes → dots
via `encodeRefName` in [hash.ts](../packages/gazetta/src/hash.ts) — dots are
reserved in ref names so the encoding is collision-free).

The generic primitives live in [dep-sidecars.ts](../packages/gazetta/src/dep-sidecars.ts);
[fragment-deps.ts](../packages/gazetta/src/fragment-deps.ts) and
[asset-refs.ts](../packages/gazetta/src/assets/asset-deps.ts) bind it to the two
relations.

Used by:
- `findDependentsFromSidecars` — "publishing `@header` affects pages.home,
  pages.about, fragments.layout" via BFS on `.gazetta/fragment-deps/`.

These indices are derived state and are **not committed** — a fresh clone or a
`git pull` can leave them missing or stale. Checks that refuse or rewrite data
(purge blocked-by-aliases/live-refs, rename + name-conflict flatten cascades,
asset delete's in-use check) therefore never read them; they scan the loaded
site in memory via [site-users.ts](../packages/gazetta/src/site-users.ts) with
the same extraction as the index builders (#1139).

Why per-edge rather than aggregated `index/fragments.json`: per-edge files give
multi-instance write correctness (concurrent admins on different items don't
serialize through one shared file) and turn each query into an O(N) `readDir`
rather than a parse-and-walk pass over a JSON map.

## Where sidecars live

Same filename format on both sides — [sidecars.ts](../packages/gazetta/src/sidecars.ts)
(per-item) and [dep-sidecars.ts](../packages/gazetta/src/dep-sidecars.ts) (reverse)
work for either source or target storage:

| Location | Per-item sidecars written by | Reverse indices written by |
|---|---|---|
| **Source** — `sites/{name}/pages/{page}/` | _(not written today; `gazetta validate` may add this in a future pass)_ | Admin API save handlers (per-edge incremental); `gazetta reindex` CLI; admin's first-time `/api/dependents` rebuild (memoized) |
| **Target** — `pages/{page}/` in target storage | `publishPageRendered` / `publishPageStatic` / `publishFragmentRendered` | `publishDepIndices` after each publish (full rebuild from in-memory site) — **changing to per-item updates, see below** |

## Target indices describe the target (decided 2026-10-21, #1077)

**Problem.** `publishDepIndices` wipes a target's indices and rebuilds them from the whole **source** site (`rebuildDepIndex`, `publish-rendered.ts`). The target's index then names pages the target never received, and edges from source manifests the target doesn't serve. Readers that rely on it: `/api/dependents?target=…` (the publish panel's "affects N pages", `admin-api/routes/publish.ts:262`), the live-check route planner (`design-live-check.md` Q3), and any later use of the target as a source. Restoring history on a target rebuilds from the target's own manifests, which is correct until the next publish overwrites it.

**Decision: replace each published item's edges, using the index's own record.** Every item on a target gets a forward record, `.gazetta/deps-of/{relation}/{item}`, listing the edges the index holds for it. For each item a publish writes, per relation (`fragment-deps`, `asset-refs`, `alias-targets`) and per locale:
1. read the item's record;
2. delete those edges;
3. write the new edges, computed from the manifest being published (in memory);
4. write the new record last.

These steps run only once the item's render and write have succeeded; an item that fails keeps its old edges and record, which describe what the target still serves (`design-target-removal.md` Q15). A save on an editable target, such as a production that accepts hotfixes, writes the item's forward record along with its edges, so items saved there directly are checked like published ones (`design-target-removal.md` Q12).

Decided: maintainer, 2026-10-23 (#1120).

No target manifest is read, so the order of the manifest copy and missing manifests on static targets don't matter. A crashed run is safe to retry: it deletes and rewrites the same edges. Two concurrent publishes of the same item can leave a stray edge, which the next publish of that item clears. An item removed from the target (publish undo, `design-publish-undo.md` Q4) has its edges and record deleted. Cost is a few small operations per published item, proportional to the publish, not the site.

**Static targets get flattened edges.** On a static target only pages are rendered and fragments are baked in, and fragment manifests are on the target only if the fragment itself was published there. So a page published to a static target gets an edge to **every** fragment it bakes, direct or nested, and an `asset-refs` edge to every asset those fragments use, from a walk of the in-memory site's fragment references. That is the graph a static page really has, and `/api/dependents` needs one directory listing per fragment, no transitive walk. ESI targets keep direct edges; fragments are published separately there and `findDependentsFromSidecars` walks them transitively.

**Existing targets** hold source-built indices and no forward records. A full `gazetta publish <target> --force` wipes the target's indices and rebuilds them through the per-item path; with no production users, that runs once per existing target (gazetta.studio's production included). A separate target reindex was rejected: static targets don't hold every fragment manifest, so a rebuild from the target couldn't recover nested edges, and it would race concurrent publishes.

**Restoring history on a target** (`history-restorer.ts`) rebuilds all three relations; today it skips `alias-targets`.

**Public targets** keep no indices today (`design-public-storage.md` Q5). Once these indices describe the target, public targets keep them too (`design-target-removal.md` Q12).

| Rejected | Why |
|---|---|
| Rebuild from the target's own manifests after each publish | About 5K reads per publish on cloud storage (30–60 s); fails the 5K envelope. |
| Don't keep indices on targets | The publish panel and live check would describe the source, not what's live; a target couldn't be used as a source with its indices. |
| Keep source-built indices, filter on read | Every reader has to remember to filter, and wrong edges stay wrong. (The live check's filter stays as a cheap safety check.) |
| Copy fragment manifests to static targets too | More files nobody renders, still needing a transitive walk at read time. |
| Direct edges on static targets | Misses pages that use a fragment through another fragment. |
| Diff the target's previous manifest against the new one | Breaks when the manifest copy runs first, when static targets lack the manifest, on retries after a crash, and with concurrent publishes. |
| `gazetta reindex <target>` from the target's manifests | Can't recover nested edges on static targets; races publishes. A forced full publish does the job. |

**Found alongside:** static pages don't update when a nested fragment changes, because fragment hashes leave out their own nested fragments ([#1090](https://github.com/gazetta-studio/gazetta-studio/issues/1090)).

| # | What | Depends on | Test tier | Risk |
|---|---|---|---|---|
| 1 | Per-item edge replacement with forward records on publish (all three relations, per locale, removals; only for items whose render and write succeeded) and on saves to an editable target, replacing the whole-source rebuild in `publishDepIndices`; a full `--force` publish wipes and rebuilds; history restore rebuilds all three relations | — | api-first | Medium |
| 2 | Static targets: flattened page → fragment and page → asset edges from the in-memory site's fragment references | 1 | unit + api | Medium |
| 3 | Run `gazetta publish production --force` for gazetta.studio once cuts 1–2 ship (maintainer step) | 1, 2 | (manual) | Low |
| 4 | Update this section and the "Where sidecars live" table to the shipped state | 1–3 | docs | Low |

## Hash input

`hashManifest` serializes the manifest with stable key ordering, substituting
references with hashed forms so the hash catches upstream changes:

- `template: "hero"` → `template: "hero#ab12cd34"` using the template's source hash
- For **static-mode page hashes only**: `"@header"` → `"@header#ef567890"` using
  the fragment's content hash. Fragments are baked into pages in static mode,
  so a fragment change must invalidate every page that uses it.
- A page's `metadata`, when it has at least one field. It renders into the
  page's `<head>`, so a metadata-only edit is a change. A page without
  metadata, or with `{}`, hashes as it did before metadata counted.

ESI-mode pages don't include fragment hashes — fragments are published
separately, and the edge runtime composes per request.

## Incremental publish flow

1. `gazetta publish` runs `compareTargets` first.
2. Compare always re-hashes from in-memory manifests (no source-side hash
   cache) and lists target `.{hash}.hash` files.
3. Items with matching hashes go in `unchanged`, except a page whose published
   `noindex` flag differs from what the source would publish
   (`publishedPageNoindex` in `seo.ts`): it counts as modified, so the next
   publish rewrites it (#1153).
4. Unless `--force`, the render loop skips items in `unchanged` and logs
   `N unchanged (skipped)`.

Trust-the-sidecar model: we don't verify the rendered output file exists.
If someone manually deletes `pages/home/index.html` on the target, the
sidecar is lying and `--force` is the escape hatch.

## Reverse-dependency queries

`findDependentsFromSidecars(contentRoot, { fragment: "header" })` reads
`.gazetta/fragment-deps/header/` and BFS-walks transitive fragment → fragment
references. Used by the admin UI to warn "publishing @header affects: home,
about, blog."

For static targets the admin extends the publish set with these dependents —
republishing `@header` means republishing every page that bakes it in.

## Staleness windows

- **Save through admin** keeps both kinds incrementally consistent: the save
  handlers write the per-item `.{hash}.hash` and update the affected
  `.gazetta/{relation}/.../*` edges as part of the save.
- **External manifest edits** (git pull, direct file edit) bypass the save
  handlers. Per-item `.{hash}.hash` becomes stale until the next compare
  rebuilds it; the reverse-dep index for the touched item also drifts until
  the next publish runs `publishDepIndices`. The dev server's first
  `/api/dependents` query against a fresh source rebuilds the fragment-deps
  index from scratch (memoized per process).
- **Publishing without running `gazetta dev`** is fine — compare always
  rehashes; publish always rebuilds the dep indices on the destination.

Target sidecars become stale only if someone mutates target storage outside
of Gazetta (manual upload, bucket sync). `--force` handles that case.
