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
  are out of sync without reading manifests.
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
- Asset library delete-block check — refuses to delete an asset while any
  `.gazetta/asset-refs/{asset}/*` entry exists.

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
| **Target** — `pages/{page}/` in target storage | `publishPageRendered` / `publishPageStatic` / `publishFragmentRendered` | `publishDepIndices` after each publish (full rebuild from in-memory site) |

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
3. Items with matching hashes go in `unchanged`.
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
