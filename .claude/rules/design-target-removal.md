# Target removal

How a page or fragment deleted on the source stops being served by a target. Today nothing removes a published item: a page deleted by hand or with `git rm` stays live on every target, and the admin counts it as a difference that no action can resolve.

**Status**: design pass complete (2026-10-22), grilled Q1–Q11. Implementation not started. The planner issue opens once publish undo cut 2 ([#1092](https://github.com/gazetta-studio/gazetta-studio/issues/1092)) and target indices cut 2 ([#1093](https://github.com/gazetta-studio/gazetta-studio/issues/1093)) have landed (Q11).

**Companion docs:**
- [#1094](https://github.com/gazetta-studio/gazetta-studio/issues/1094): the issue this design resolves
- [`design-publishing.md`](design-publishing.md) and [`design-decisions.md`](design-decisions.md) #16: Publish is one verb with an author-chosen direction
- [`design-publish-undo.md`](design-publish-undo.md): Q4's removal step and the shared target-publish function, which removals reuse
- [`sidecars.md`](sidecars.md): per-item sidecars, and target indices that describe the target (#1077), which the Q4 check reads
- [`design-soft-delete.md`](design-soft-delete.md): archive, purge, and the HTML marker (Q10)
- [`design-redirects.md`](design-redirects.md): `_redirects` host glue for plain-static targets
- [`design-live-check.md`](design-live-check.md): removed pages are expected to answer 404
- [`design-hooks.md`](design-hooks.md): the `afterPublish` result
- [`design-review-workflow.md`](design-review-workflow.md): publish requests on approval-gated targets
- [`design-editor-ux.md`](design-editor-ux.md): sync indicators

## Scope

**In v1:**
- Removing pages, fragments and locale variants that exist only on a destination, chosen per item in the publish panel or all at once with `gazetta publish --remove`
- A check before any write that nothing staying on the target still uses what is removed
- `_redirects` built from what the target holds, using per-page archive sidecars
- Removals visible to `afterPublish` hooks and recorded in the publish audit event

**Out of v1:**
- Removing assets (Future directions)
- A hook phase that can block removals (Future directions)
- Choosing individual removals on the CLI
- Splitting the sync count into behind and ahead (`design-editor-ux.md` gap)

**Non-goals:**
- Removing items automatically. Absence on the source can't be told apart from newer work on the destination (Q1).
- Tombstones on the source recording what was deleted (Q1, option D).

## Discovery

Read from code on 2026-10-22, not reproduced:

1. `compareTargets` reports items present on the destination but absent from the source as `deleted` (`compare.ts`). The publish list shows them with "−" and no checkbox (`PublishItemList.vue:128`), the CLI never mentions them, and the sync chip counts them (`syncStatus.ts`, "N behind"), so the target stays behind with no action available.
2. No code removes a published item from a target. Publish undo's cut 2 builds that step.
3. **Purge behaves differently by target type.** Worker and ESI targets keep the archive marker page after a purge, so they answer 410 or 301 forever. Plain-static targets lose the row at the next publish of anything, because `_redirects` is rebuilt from the **source's** archived manifests (`admin-api/routes/publish.ts:551`, `cli/index.ts:983`).
4. **Unpublished archives leak into `_redirects`.** Archiving a page on the source and then publishing any other item to a plain-static target with `redirects.format` adds the archive's 301 or 410 row, although its archive was never published there.
5. `sitemap.xml` is built from the target's own sidecars, and archived pages carry `noindex` (`publish-item.ts:408`), so they're excluded. Correct.
6. A missing fragment doesn't fail loudly: `assembleEsi` (`assemble.ts`) replaces it with `<!-- fragment not found -->`, so pages that still use it are served without it, with status 200.
7. Publish hooks receive `PublishItem { kind, name, path }`, described as "what's being published" (`hooks/types.ts`). A hook may read each item's source manifest.

## Locked decisions

### Q1 — Removal is explicit, per item, through Publish

Items that exist only on the destination appear in the publish list with a checkbox to remove them, unchecked by default. The CLI lists them and removes them only with `--remove` (Q7).

| Rejected | Why |
|---|---|
| Automatic: publish removes everything only on the destination, after a confirmation (`rsync --delete`) | Publish works in both directions, and "only on the destination" means *deleted on the source* or *added on the destination*. Fetching a hotfix from production into local would delete local pages not yet published; publishing an outdated staging to production would remove a page added on production. |
| Pre-checked when the destination isn't editable | A page only on production may have been published there from staging or by a teammate; a pre-checked box would quietly take it down. |
| A separate "Remove from target" action outside Publish | A second verb for moving content between targets (`design-decisions.md` #16), and the publish list would still show the item with no action. |
| Tombstones: the source records deletions, publish removes only those | Pages deleted by hand or with `git rm`, the main case, leave no record; new state to keep. |

### Q2 — Removals in the publish list

Rows keep their place in the list, with the "−" marker and a checkbox that is unchecked by default and labelled "Only on production — remove". "Select all" selects changes only; an "Also select the N removals" link appears only when removals exist. The production confirmation names what will be removed. With several destinations, the row says where the item exists ("Only on staging and production — remove"), and checking it removes it from each of them; removing from one destination only means publishing to that destination alone. Non-production targets get no extra confirmation: undo covers them.

| Rejected | Why |
|---|---|
| A separate "Only on production" section | One more heading for the same rows; the label and the unchecked default already set them apart. |
| One switch for all removals | All or nothing, while absence is ambiguous item by item. |
| "Select all" includes removals | One click away from taking pages down. |

### Q3 — Pages, fragments and locale variants; not assets

Everything compare reports today can be removed. Assets are out: compare doesn't list them, and removing asset bytes safely needs the target's asset index to describe the target (#1077). An image deleted for legal reasons stays downloadable on targets until the asset follow-up ships (Future directions).

| Rejected | Why |
|---|---|
| Include assets now | Needs compare to list assets on both sides and #1077's target indices first. |
| Pages only | Fragments and translations only on the target would keep the target behind forever: the same bug. |

### Q4 — A removal can't break what stays on the target

Before any write, publish refuses when something staying on the destination still uses what is being removed:
- a page or fragment that uses a removed fragment, unless it is also published or removed in the same publish;
- an archive that redirects to a removed page, unless it is also removed or republished.

The panel shows this on the row ("Still used on production by pages/home — select it too", with a link that selects it) and keeps Publish disabled; the server repeats the check as a backstop and writes nothing when it fails. The check reads the destination's `fragment-deps` and `alias-targets` indices. They must describe the target, which #1077 provides; today's indices are rebuilt from the source, where the page no longer uses the fragment, so they miss exactly this case. Static targets bake fragments into pages, so only the redirect check applies there.

| Rejected | Why |
|---|---|
| Add the items that use it to the publish automatically | They may carry the author's other unpublished edits, which would ship without anyone choosing to. |
| Warn and allow | Pages lose their header without an error (finding 6), and nothing tells the author afterwards. |
| Read the target's manifests to find users | About 5K reads per publish on cloud storage; fails the 5K-page envelope. |

### Q5 — A purge changes nothing on a target until its removal is published

After a purge on the source, every target type keeps answering 410 or 301 until the author publishes the removal; then the page answers 404. The removal row says what changes: "Only on production: redirects to /welcome, will return 404 after removal" or "returns 410, will return 404 after removal". Docs advise: to tell search engines a page is gone, archive it and publish that before purging.

| Rejected | Why |
|---|---|
| Removing a purged archive keeps its 410 marker | The row never clears, so the sync count stays behind (or needs a special case), and markers pile up forever. To keep a 410, keep the archive. |
| Purges reach targets automatically | The automatic removal Q1 rejects; an archive only on production may have been made there. |

A 404 after a 410 costs nothing for search when the archive answered 410 for a while before its purge (the CLI's example purges after 180 days): crawlers have already dropped the URL. An archive purged before it was ever published goes straight from 200 to 404, which is why the docs advise publishing the archive first.

### Q6 — `_redirects` describes the target, from per-page archive sidecars

Publishing an archived page also writes a zero-byte sidecar next to it on the target: `.gone`, or `.alias-<name>` with the name encoded as other sidecars encode names (slashes → dots, `encodeRefName`). Publishing a live version over it, or removing the page, deletes the sidecar. `_redirects` is built from the listing the sitemap already reads (`listSidecars(target, 'pages')`), so it costs no extra reads, keeps purged archives until their removal (Q5), and never contains an archive the target doesn't hold (finding 4). As in v1, the default-locale page decides a page's archive state. Only plain-static targets use `_redirects`; worker targets read the marker and don't change.

| Rejected | Why |
|---|---|
| Read the first 200 bytes of every `noindex` page on each publish | Reads grow with archives, which pile up until purged; seconds per publish on cloud storage. |
| Build from the source, including an archive only if the target holds that version | Fixes the leak, but a purged archive still drops off at the next publish (contradicts Q5). |
| A redirects list file on the target, updated each publish | One shared file rewritten by every publish: concurrent publishes lose rows, and aggregate files are ruled out (`feature-design-process.md`). |

### Q7 — CLI: list by default, `--remove` to remove all

Without the flag, `gazetta publish` lists items only on the target after its summary and exits 0. With `--remove`, it prints what it will remove and removes all of them, after the Q4 check, which refuses before writing anything and names what still uses them. No individual removals on the CLI in v1, and no prompt, as for any CLI publish to production.

| Rejected | Why |
|---|---|
| `--prune` or `--delete` | The panel says "remove"; one word per concept (team rule 7). `--delete` also sounds like deleting from the source. |
| Exit non-zero when such items exist and no flag is given | The first CI run after upgrading would fail on every site that has target-only items. |
| `--remove <item>` | The CLI makes a target match the source, typically in CI; picking items is the admin's job. |

### Q8 — Hooks and audit see removals; they can't block them

`beforePublish` keeps receiving only what is published. `afterPublish`'s result gains an optional `itemsRemoved`, so CDN purge or notification hooks see removals. The publish audit event records `metadata.removed`. A `beforeRemove` phase is reserved.

| Rejected | Why |
|---|---|
| `beforeRemove` / `afterRemove` phases now | Two more phases for blocking removals, which nobody has asked for. |
| An `action: 'publish' \| 'remove'` field on `PublishItem` | Existing hooks would treat removals as published items; one that reads the manifest throws, and that cancels the whole publish (finding 7). |
| Removals in `items` with no marker | Same failure, with nothing to tell them apart. |

### Q9 — The destination's publish capability

Removing needs the same capability as publishing to that target (`publish:production` or `publish:non-production`). Publishing can already overwrite any page on the target, so removal adds no power; the decision to delete was made on the source, under `delete:*`. On a target that requires publish approval (review workflow cuts 12–13), a removal goes through a publish request like any item: the request records the item as absent, and the approval's snapshot check confirms the source still lacks it.

| Rejected | Why |
|---|---|
| Publish capability plus `delete:pages` / `delete:fragments` | Editors could not publish a deletion an admin made, yet could publish an empty page with the same effect. |
| A new `remove:<target>` capability | Another capability to assign, with no difference from publish. |

### Q10 — The sync count doesn't change

Items only on the target keep counting toward "N behind". Each now has an action: remove it, or, if it is newer work on the target, publish it back into the source. The chip's single "behind" count, where `design-editor-ux.md` describes behind and ahead, is an existing gap and stays out of this design.

| Rejected | Why |
|---|---|
| Leave out items the target already handles correctly (a purged archive answering 410) | That 410 still differs from the source; to keep it, keep the archive. |
| Split the chip into behind and ahead now | A wider change to another surface. |

### Q11 — Cut sequence, queued after its prerequisites

See "Cut sequence". The planner issue opens once #1092 cut 2 and #1093 cut 2 have landed; both planner issues get a comment pointing here.

| Rejected | Why |
|---|---|
| Open the planner issue now, with prerequisites in its Locked decisions | cut-planner orders cuts within one planner issue only; it could file cut 2 before the removal step exists. |
| Add these cuts to #1092's plan | One planner issue carrying two design docs' decisions. |

## UX check

Rule 23: removals look like any other row, stay unselected until chosen, and say what will happen.

### Publish list rows (cut 3)

| Story | Row copy | Control / `data-testid` |
|---|---|---|
| `RemovalUnselected` | "Only on production — remove" | checkbox, unchecked |
| `RemovalSelected` | same | checkbox, checked |
| `RemovalMultiDest` | "Only on staging and production — remove" | checkbox |
| `RemovalArchiveAlias` | "Only on production: redirects to /welcome, will return 404 after removal" | checkbox; `publish-item-removal-note` |
| `RemovalArchiveGone` | "Only on production: returns 410, will return 404 after removal" | checkbox; `publish-item-removal-note` |
| `RemovalStillUsed` | "Still used on production by pages/home — select it too" | link `publish-item-select-users`; Publish disabled; `publish-item-still-used` |

Header: summary "3 modified · 1 added · 2 only on production" (`publish-items-summary`); "Also select the 2 removals" (`publish-select-removals`) only when removals exist; "Select all" selects changes only.

Production confirmation (`publish-confirm-banner`): adds "Will remove from production: old-landing, @promo" (`publish-confirm-removals`) when removals are selected. Result: "Removed 2 from production".

### CLI (cut 4)

```
$ gazetta publish production
Published 3 items to production.
2 only on production: pages/old-landing, @promo. Pass --remove to remove them.

$ gazetta publish production --remove
Removing from production: pages/old-landing, @promo
Published 3 items, removed 2 from production.

$ gazetta publish production --remove
Can't remove @promo from production: pages/home still uses it there.
Nothing was written.
```

The last case exits 1.

## Foundational checks

- **Multi-instance:** removals are per-item deletes; archive sidecars are per item; `_redirects` is regenerated from a listing (host-glue exception). Two publishes, one removing an item and one publishing it, end with the last writer, as two publishes do today.
- **Scale:** compare already lists both sides. The Q4 check is one directory listing per removed fragment or page in the target's indices. `_redirects` reuses the sitemap's listing.
- **Locale:** locale variants are removed like any item. The archive sidecar is written for the default-locale page only (v1 archive state).
- **Themes:** none.
- **Auth + RBAC:** the destination's publish capability (Q9).
- **Audit:** `metadata.removed` on the publish event; no new action.
- **Review:** removals go through publish requests on approval-gated targets (Q9); no content review applies (nothing to review).
- **Hooks:** `itemsRemoved` on the `afterPublish` result (Q8); `beforeRemove` reserved.
- **Render:** removal deletes rendered output through publish undo's removal step.
- **Validation:** the Q4 check is a publish-time integrity check, like asset reference integrity, not a validator; validators run on published items only.
- **Plugin:** through the hook result.
- **Cache:** compare and sync status refresh after publish as today.
- **Offline:** publish is online-only.
- **Collaboration:** none.

Composition with designs in flight:
- **Publish undo:** removals are recorded in the publish revision (removed items are absent from its snapshot), so undoing the publish brings them back.
- **Target indices (#1077):** removing an item deletes its edges and forward record.
- **Live check:** removed pages are expected to answer 404 (`design-live-check.md` Q3).
- **Public storage:** archive sidecars are dot-prefixed like other per-item sidecars and reveal only what the 410 or 301 response already shows (`design-public-storage.md` Q4).

## Cut sequence

| # | What | Depends on | Test tier | Risk |
|---|---|---|---|---|
| 1 | Archive sidecars on targets (`.gone`, `.alias-<name>`): written with the marker, deleted when a live version replaces it; `listSidecars` reports them; `_redirects` built from the target's listing in the shared post-publish function | publish undo cut 1 | unit + api | Medium |
| 2 | Removal in publish: items only on the destination removed via publish undo's removal step; the Q4 check against the target's `fragment-deps` and `alias-targets` before any write; `metadata.removed`; `itemsRemoved` on the `afterPublish` result; the destination's publish capability | 1, publish undo cut 2, #1077 cuts 1–2 | api-first | Medium-high |
| 3 | Publish panel: rows per the UX table, "Also select the N removals", the still-used row with its select link and disabled Publish, archive rows saying what changes, removals in the production confirmation; stories transcribed from the UX table | 2 | component + e2e | Medium |
| 4 | CLI: list items only on the target; `--remove` | 2 | integration | Low |
| 5 | Docs: removals in the publishing docs; purge and 410 guidance in `docs/soft-delete.md`; `--remove` in the CLI docs; `itemsRemoved` in `docs/hooks.md`; archive sidecars in `sidecars.md` | 1–4 | docs | Low |
| 6 | Add `--remove` to gazetta.studio's `deploy-site.yml` (maintainer PR; bots can't push workflow files) | 4 | manual | Low |

## Migration

No production users. Archived pages published before cut 1 have no archive sidecar, so `_redirects` on a plain-static target would drop their rows until they are republished: run `gazetta publish <target> --force` once after cut 1 (the same one-time step #1077 needs). Worker targets, including gazetta.studio's production, read the marker and are unaffected.

## Open questions

1. **Fan-out across target types.** One publish to a static and an ESI target applies the Q4 check per destination; whether the panel should show a row's still-used note per destination or merged is for cut 3.
2. **Concurrent publishes.** One instance removing an item while another publishes it ends with the last writer; a per-target publish lock is a publish undo future direction.

## Future directions

- **Removing assets** from targets, once #1077 makes target indices describe the target. Trigger: a takedown request (an image deleted for legal reasons stays downloadable) or storage growth on targets.
- **`beforeRemove` hook phase** for vetoing removals. Trigger: operator demand.
- **`--remove <item>` on the CLI.** Trigger: demand.
- **Sync chip split into behind and ahead**, as `design-editor-ux.md` describes.
- **Per-destination removal** within one fan-out publish.
