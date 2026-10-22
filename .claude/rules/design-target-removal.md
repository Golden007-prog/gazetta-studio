# Target removal

How a page or fragment deleted on the source stops being served by a target. Today nothing removes a published item: a page deleted by hand or with `git rm` stays live on every target, and the admin counts it as a difference that no action can resolve.

**Status**: design pass complete (2026-10-22), grilled Q1–Q11. An independent review the same day added Q12–Q16 and corrected Discovery, Q2–Q7 and Q9. Implementation not started. The planner issue opens once publish undo cut 2 ([#1092](https://github.com/gazetta-studio/gazetta-studio/issues/1092)) and target indices cut 2 ([#1093](https://github.com/gazetta-studio/gazetta-studio/issues/1093), the plan for #1077) have landed (Q11).

**Companion docs:**
- [#1094](https://github.com/gazetta-studio/gazetta-studio/issues/1094): the issue this design resolves
- [#1060](https://github.com/gazetta-studio/gazetta-studio/issues/1060): served sites don't read archive markers yet; a prerequisite for the archive rows' copy on worker and ESI targets
- [`design-publishing.md`](design-publishing.md) and [`design-decisions.md`](design-decisions.md) #16: Publish is one verb with an author-chosen direction
- [`design-publish-undo.md`](design-publish-undo.md): Q4's removal step and the shared target-publish function, which removals reuse
- [`sidecars.md`](sidecars.md): per-item sidecars, and target indices that describe the target (#1077), which the Q4 check reads
- [`design-public-storage.md`](design-public-storage.md): public targets keep no history and receive no manifests; indices on public targets (Q12)
- [`design-review-workflow.md`](design-review-workflow.md): publish-approval locks, amended by Q13
- [`design-soft-delete.md`](design-soft-delete.md): archive, purge, and the HTML marker (Q10)
- [`design-redirects.md`](design-redirects.md): `_redirects` host glue for plain-static targets
- [`design-live-check.md`](design-live-check.md): what a removed page is expected to answer
- [`design-hooks.md`](design-hooks.md): the `afterPublish` result
- [`design-editor-ux.md`](design-editor-ux.md): sync indicators

## Scope

**In v1:**
- Removing pages, fragments and locale variants that exist only on a destination, chosen per item in the publish panel or all at once with `gazetta publish --remove`
- A check before any write that nothing staying on the target still uses what is removed
- Removals in their own request field, through the publish-approval gate, with a confirmation when they can't be undone
- `_redirects` built from what the target holds, using per-page archive sidecars
- Removals visible to `afterPublish` hooks, the CDN purge and the publish audit event

**Out of v1:**
- Removing assets (Future directions)
- A hook phase that can block removals (Future directions)
- Choosing individual removals on the CLI
- Splitting the sync count into behind and ahead (`design-editor-ux.md` gap)

**Non-goals:**
- Removing items automatically. Absence on the source can't be told apart from newer work on the destination (Q1).
- Tombstones on the source recording what was deleted (Q1, option D).

## Discovery

Read from code on 2026-10-22, not reproduced end to end:

1. `compareTargets` reports items present on the destination but absent from the source as `deleted` (`compare.ts`). The publish list **pre-selects** them, because they count as changes (`hasChanges` in `usePublishItems.ts`), although their checkbox is hidden (`PublishItemList.vue:128`), and the panel sends them in `items` (`PublishPanel.vue:306`); `publishItems` copies nothing for them. The CLI never mentions them, and the sync chip counts them ("N behind"), so the target stays behind with no action available.
2. No code removes a published item from a target. Publish undo's cut 2 builds that step.
3. **Archived pages aren't served as archived on worker and ESI targets yet.** Nothing reads the marker (`parseArchiveMarker` has no caller), so they return a blank 200 ([#1060](https://github.com/gazetta-studio/gazetta-studio/issues/1060)). Plain-static targets get their 301 and 410 rows from `_redirects`, which is rebuilt from the **source's** archived manifests (`admin-api/routes/publish.ts`, `cli/index.ts`), so a purged archive's row drops at the next publish of anything.
4. **Unpublished archives leak into `_redirects`.** Archiving a page on the source and then publishing any other item to a plain-static target with `redirects.format` adds the archive's row, although its archive was never published there.
5. `sitemap.xml` is built from the target's own sidecars, and archived pages carry `noindex` (`publish-item.ts:408`), so they're excluded. R2 listings can miss files just written, so the CLI merges source entries into that listing (`cli/index.ts`).
6. A missing fragment doesn't fail loudly: `assembleEsi` (`assemble.ts`) replaces it with `<!-- fragment not found: … -->`, so pages that still use it are served without it, with status 200.
7. Publish hooks receive `PublishItem { kind, name, path }`, described as "what's being published" (`hooks/types.ts`). A hook may read each item's source manifest.
8. The admin route's CDN purge lists the URLs of the published pages from the **source** site, so a page no longer on the source is never purged; pages are edge-cached for 24 h by default (`publish-renderers.ts:218`).
9. **Translations fall back.** When `index.fr.html` is missing, the worker and ESI `gazetta serve` serve the default-language page and fragment (`workers/cloudflare-r2.ts`, `serve.ts`). Static targets keep a translation at `fr/<route>/index.html`, with no fallback.
10. Item folders nest: `pages/about/team/` lives inside `pages/about/` (`itemDir`, `publish-item.ts`).
11. `gazetta publish --force` skips compare (`cli/index.ts`).

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

Rows keep their place in the list, with the "−" marker and a checkbox that is unchecked by default and labelled "Only on production — remove". "Select all" selects changes only; an "Also select the N removals" link appears only when removals exist. With several destinations, the row says where the item exists ("Only on staging and production — remove"), and checking it removes it from each of them; removing from one destination only means publishing to that destination alone. Which removals need a confirmation: Q14.

Follows from Q14.

| Rejected | Why |
|---|---|
| A separate "Only on production" section | One more heading for the same rows; the label and the unchecked default already set them apart. |
| One switch for all removals | All or nothing, while absence is ambiguous item by item. |
| "Select all" includes removals | One click away from taking pages down. |

### Q3 — Pages, fragments and locale variants; not assets

Everything compare reports today can be removed. Assets are out: compare doesn't list them, and removing asset bytes safely needs the target's asset index to describe the target (#1077). An image deleted for legal reasons stays downloadable on targets until the asset follow-up ships (Future directions).

Removing an item deletes only its own files: its manifest, its `index*.html`, its sidecars and its rendered files. A nested page's folder stays: `pages/about/team/` survives the removal of `about` (finding 10). Removing a translation (`pages/about:fr`) deletes that variant's files only; on worker and ESI targets visitors then get the default-language page (finding 9), on static targets a 404.

Decided: maintainer, 2026-10-22 (#1120).

| Rejected | Why |
|---|---|
| Include assets now | Needs compare to list assets on both sides and #1077's target indices first. |
| Pages only | Fragments and translations only on the target would keep the target behind forever: the same bug. |

### Q4 — A removal can't break what stays on the target

Before any write, publish refuses when something staying on the destination still uses what is being removed:
- a page or fragment that uses a removed fragment, unless it is published in the same run with a version that no longer uses it, or removed with it;
- an archive that redirects to a removed page, unless it is also removed or republished pointing elsewhere.

Removing a fragment's translation while its default-language version stays breaks nothing, because the runtimes fall back (finding 9); only removing a fragment's default version is checked against its users.

The check reads the destination's `fragment-deps` and `alias-targets` indices, which must describe the target (#1077). Where an item staying on the target has no forward record, its users can't be known and the check refuses, naming it (Q12).

The panel shows the problem on the row and keeps Publish disabled: "Still used on production by pages/home — select it too", with a link that selects it. When the item that still uses it is unchanged and uses the removed fragment on the source too (after a `git rm` of the fragment), there is nothing to select: the row says "pages/home still uses @promo on local too — fix it there first", and the source fails validation as well. The server repeats the check as a backstop and writes nothing when it fails. Removals run after everything else in the publish (Q15). Static targets bake fragments into pages, so only the redirect check applies there.

Decided: maintainer, 2026-10-22 (#1120). Refusing unknown users follows from Q12, and removals running last from Q15.

| Rejected | Why |
|---|---|
| Add the items that use it to the publish automatically | They may carry the author's other unpublished edits, which would ship without anyone choosing to. |
| Warn and allow | Pages lose their header without an error (finding 6), and nothing tells the author afterwards. |
| Read the target's manifests to find users | About 5K reads per publish on cloud storage; fails the 5K-page envelope. Public targets have no manifests at all. |

### Q5 — A purge changes nothing on a target until its removal is published

After a purge on the source, a target keeps serving the archive until the author publishes the removal; then the page answers 404 (or, for a translation on worker and ESI targets, the default-language page). On plain-static targets the archive's `_redirects` row stays until then (Q6). On worker and ESI targets, "serving the archive" means 410 or 301 only once #1060 ships; until then they return a blank 200 (finding 3).

The removal row says what changes, from what the target serves: "Only on production: redirects to /welcome, will return 404 after removal", or "returns 410, will return 404 after removal". Docs advise: to tell search engines a page is gone, archive it and publish that before purging.

Decided: maintainer, 2026-10-22 (#1120).

| Rejected | Why |
|---|---|
| Removing a purged archive keeps its 410 marker | The row never clears, so the sync count stays behind (or needs a special case), and markers pile up forever. To keep a 410, keep the archive. |
| Purges reach targets automatically | The automatic removal Q1 rejects; an archive only on production may have been made there. |

A 404 after a 410 costs nothing for search when the archive answered 410 for a while before its purge (the CLI's example purges after 180 days): crawlers have already dropped the URL. An archive purged before it was ever published goes straight from 200 to 404, which is why the docs advise publishing the archive first.

### Q6 — `_redirects` describes the target, from per-page archive sidecars

Publishing an archived page also writes a zero-byte sidecar next to it on the target: `.gone`, or `.alias-<name>` with the name encoded as other sidecars encode names (slashes → dots, `encodeRefName`). Writing one deletes the page's other archive sidecar first, so re-pointing an alias (rename flattening, soft-delete Q3) leaves one row. Publishing a live version over it, or removing the page, deletes it.

`_redirects` is built from the listing the sitemap already reads (`listSidecars(target, 'pages')`). It keeps purged archives until their removal (Q5) and never contains an archive the target doesn't hold (finding 4). Archive sidecars written or deleted in the same publish are merged into that listing in memory, because R2 listings can miss files just written (finding 5). Building it costs no extra read when `siteUrl` is set, because the sitemap lists anyway, and one listing otherwise. As in v1, the default-locale page decides a page's archive state, and the file has one row per language the target publishes (`/fr/landing  /fr/welcome  301`; `design-redirects.md`, #1124, #1130). Only plain-static targets use `_redirects`; worker targets will read the marker instead (#1060).

Decided: maintainer, 2026-10-22 (#1120).

| Rejected | Why |
|---|---|
| Read the first 200 bytes of every `noindex` page on each publish | Reads grow with archives, which pile up until purged; seconds per publish on cloud storage. |
| Build from the source, including an archive only if the target holds that version | Fixes the leak, but a purged archive still drops off at the next publish (contradicts Q5). |
| A redirects list file on the target, updated each publish | One shared file rewritten by every publish: concurrent publishes lose rows, and aggregate files are ruled out (`feature-design-process.md`). |

### Q7 — CLI: list by default, `--remove` to remove all

Without the flag, `gazetta publish` lists items only on the target after its summary and exits 0. With `--remove`, it prints what it will remove and removes all of them, after the Q4 check, which refuses before writing anything and names what still uses them. `--remove` runs compare even with `--force`, which otherwise skips it (finding 11). No individual removals on the CLI in v1, and no prompt, as for any CLI publish to production. A pipeline that passes `--remove` makes removal automatic for that target by the operator's choice (cut 6 does this for gazetta.studio); Gazetta never removes without the flag.

Decided: maintainer, 2026-10-22 (#1120).

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

Removing needs the same capability as publishing to that target (`publish:production` or `publish:non-production`). Publishing can already overwrite any page on the target, so removal adds no power; the decision to delete was made on the source, under `delete:*`. On a target that requires publish approval, removals go through the gate like any item (Q13).

Follows from Q13.

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

See "Cut sequence". The planner issue opens once #1092 cut 2 and #1093 cut 2 have landed; both planner issues have a comment pointing here.

| Rejected | Why |
|---|---|
| Open the planner issue now, with prerequisites in its Locked decisions | cut-planner orders cuts within one planner issue only; it could file cut 2 before the removal step exists. |
| Add these cuts to #1092's plan | One planner issue carrying two design docs' decisions. |

### Q12 — The check works on every target: indices on public targets, unknown means refuse

Once #1077 lands, public targets keep dependency indices too. `design-public-storage.md` Q5 keeps them off public targets only because, today, they're rebuilt from the source and would reveal unpublished page names; indices that describe the target reveal only which published pages use which fragments. An item staying on the target with no forward record (for example a target-only item kept through #1077's one-time `--force` rebuild) has unknown users: the check refuses, naming it ("pages/old-landing is only on production and can't be checked — remove it too, or keep @promo").

Decided: maintainer, 2026-10-22 (#1120).

| Rejected | Why |
|---|---|
| Check from the source: in-sync items through their source manifest, refuse for anything else | Refuses whenever an unpublished page differs, even one that never used the fragment, and adds a second code path beside the indices. |
| Skip the check on public targets and warn | Public is the default for cloud storage; the common case would get no protection. |
| Read the target's manifests | Public targets receive none; on private ones about 5K reads. |

### Q13 — The publish-approval gate sits at the shared target-publish function

The gate moves from `publishRun` step 7 to the start of publish undo's shared target-publish function, which wraps `publishRun`, so it sees items and removals alike. A removal request snapshots "absent on the source, held on the target with hash H"; the approval re-checks both and answers `409 STALE_REQUEST` if either changed; the threshold approval runs the shared function for exactly that removal. Undo keeps publish undo's rule: undoing the latest publish needs no request, rolling back further does. The CLI still refuses gated targets, `--remove` included. `design-review-workflow.md` locks 1, 3, 4 and 5 are amended to match.

Decided: maintainer, 2026-10-22 (#1120).

| Rejected | Why |
|---|---|
| Keep the gate in `publishRun` and run removals through it | Moves publish undo's removal step out of the shared function and splits the post-publish work. |
| Removals skip the gate | An approval-gated production would lose pages with no one approving. |
| No removals on gated targets | No supported way to remove anything there. |

### Q14 — Confirm when a removal can't be undone

A confirmation appears whenever a removal is final: the destination is production, keeps no history (public storage, `history.enabled: false`), or holds no recorded version of the item in its history (for example one the CLI published before #1082). It names those items: "These can't be undone on staging: pages/old-landing". Compare reports this per row from the destination's latest revision, one read per destination.

Decided: maintainer, 2026-10-22 (#1120).

| Rejected | Why |
|---|---|
| Confirm every removal on every target | A dialog for the common case undo already covers (team rule 23). |
| Confirm on production only | Public storage is the default for cloud targets; the commonest setup would lose pages without a warning. |

### Q15 — Removals run last, and wait for what they rely on

Removals run after everything else in the publish. A removal is skipped when an item its check relied on failed to publish, and the result says why: "@promo was not removed: pages/home failed to publish". Everything else goes ahead; the skipped item stays "Only on production" for the next publish. The up-front check (Q4) still refuses before any write when something can't be accounted for at all.

Decided: maintainer, 2026-10-22 (#1120).

| Rejected | Why |
|---|---|
| Removals first | A failed render leaves pages using a fragment that's already gone. |
| Skip all removals if anything fails | One bad page blocks unrelated removals. |
| Abort the whole publish | Fights `publishRun`'s per-item model, and other items are already written by then. |

### Q16 — Removals travel in their own request field

`POST /api/publish` takes removals in `remove: string[]`, with a Zod schema (MCP discipline). The server checks each entry is absent on the source and present on the destination, and rejects an item missing on the source in `items`. The panel stops sending target-only rows in `items` (finding 1).

Decided: maintainer, 2026-10-22 (#1120).

| Rejected | Why |
|---|---|
| Treat items in `items` that are missing on the source as removals | Today's panel already sends them pre-selected, so every publish would remove them silently; and a page deleted on the source between compare and publish would turn a modified selection into a removal. |
| A separate removal endpoint | Two operations for one publish (Q1: one verb). |

## UX check

Rule 23: removals look like any other row, stay unselected until chosen, and say what will happen.

### Publish list rows (cut 3)

| Story | Row copy | Control / `data-testid` |
|---|---|---|
| `RemovalUnselected` | "Only on production — remove" | checkbox `publish-item-remove`, unchecked |
| `RemovalSelected` | same | `publish-item-remove`, checked |
| `RemovalMultiDest` | "Only on staging and production — remove" | `publish-item-remove` |
| `RemovalTranslation` | "Only on production (fr) — remove: visitors will see the default language" (worker and ESI targets) / "…, will return 404" (static targets) | `publish-item-remove`; `publish-item-removal-note` |
| `RemovalArchiveAlias` | "Only on production: redirects to /welcome, will return 404 after removal" | `publish-item-remove`; `publish-item-removal-note` |
| `RemovalArchiveGone` | "Only on production: returns 410, will return 404 after removal" | `publish-item-remove`; `publish-item-removal-note` |
| `RemovalStillUsed` | "Still used on production by pages/home — select it too" | link `publish-item-select-users`; Publish disabled; `publish-item-still-used` |
| `RemovalSourceStillUses` | "pages/home still uses @promo on local too — fix it there first" | Publish disabled; `publish-item-still-used` |
| `RemovalUnknownUsers` | "pages/old-landing is only on production and can't be checked — remove it too, or keep @promo" | Publish disabled; `publish-item-still-used` |

The archive rows describe what the target serves; on worker and ESI targets their 301 and 410 copy needs #1060.

Header: summary "3 modified · 1 added · 2 only on production" (`publish-items-summary`); "Also select the 2 removals" (`publish-select-removals`) only when removals exist; "Select all" selects changes only.

Confirmation (`publish-confirm-banner`, per Q14): "Will remove from production: old-landing, @promo" or "These can't be undone on staging: pages/old-landing" (`publish-confirm-removals`). Result: "Removed 2 from production"; a skipped removal: "@promo was not removed: pages/home failed to publish" (`publish-removal-skipped`).

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
- **Scale:** compare already lists both sides; Q14 adds one revision read per destination. The Q4 check is one directory listing per removed fragment or page in the target's indices. `_redirects` reuses the sitemap's listing when `siteUrl` is set.
- **Locale:** translations are removed like any item; visitors then get the default language on worker and ESI targets (Q3). Removing a fragment's translation isn't checked against users (Q4). The archive sidecar is written for the default-locale page only (v1 archive state).
- **Themes:** none.
- **Auth + RBAC:** the destination's publish capability (Q9).
- **Audit:** `metadata.removed` on the publish event; no new action.
- **Review:** removals pass the publish-approval gate at the shared function (Q13); no content review applies (nothing to review).
- **Hooks:** `itemsRemoved` on the `afterPublish` result (Q8); `beforeRemove` reserved.
- **Render:** removal deletes the item's own rendered output through publish undo's removal step (Q3).
- **Validation:** the Q4 check is a publish-time integrity check, like asset reference integrity, not a validator; validators run on published items only.
- **Plugin:** through the hook result.
- **Cache:** the CDN purge includes removed routes, derived from the item's name, since the source no longer has it (finding 8); compare and sync status refresh after publish as today.
- **Offline:** publish is online-only.
- **Collaboration:** none.

Composition with designs in flight:
- **Publish undo:** where the destination keeps history, removals are recorded in the publish revision (removed items are absent from its snapshot), so undoing the publish brings them back; elsewhere Q14 confirms first.
- **Target indices (#1077):** removing an item deletes its edges and forward record; public targets keep indices too (Q12).
- **Live check:** a removed page is expected to answer 404, a removed translation on worker and ESI targets the default-language page (`design-live-check.md` Q3).
- **Public storage:** archive sidecars and indices are dot-prefixed like other per-item sidecars and reveal only published state (`design-public-storage.md` Q4, Q5 as amended by Q12).

## Cut sequence

| # | What | Depends on | Test tier | Risk |
|---|---|---|---|---|
| 1 | Archive sidecars on targets (`.gone`, `.alias-<name>`, one per page): written with the marker, deleted when a live version replaces it; `listSidecars` reports them; `_redirects` built from the target's listing, with this publish's own sidecar writes merged in, in the shared post-publish function | publish undo cut 1 | unit + api | Medium |
| 2 | Removal in publish: the `remove` request field (Q16); removal through publish undo's removal step, own files only (Q3); removals last, skipping those whose relied-on items failed (Q15); the Q4 check against the target's indices, refusing unknown users (Q12); the approval gate at the shared function (Q13, with review workflow cuts 12–13); compare reporting per target-only row its archive state, users and whether undo can restore it (Q14); removed routes in the CDN purge; `metadata.removed`; `itemsRemoved` | 1, publish undo cut 2, #1077 cuts 1–2 (#1093) | api-first | Medium-high |
| 3 | Publish panel: rows per the UX table; target-only rows no longer sent in `items`; "Also select the N removals"; the still-used rows; confirmation per Q14; stories transcribed from the UX table. The archive rows' 301/410 copy on worker and ESI targets waits for #1060 | 2 | component + e2e | Medium |
| 4 | CLI: list items only on the target; `--remove`, running compare even with `--force` | 2 | integration | Low |
| 5 | Docs: removals in the publishing docs; purge and 410 guidance in `docs/soft-delete.md`; `--remove` in the CLI docs; `itemsRemoved` in `docs/hooks.md`; archive sidecars in `sidecars.md` | 1–4 | docs | Low |
| 6 | Add `--remove` to gazetta.studio's `deploy-site.yml` (maintainer PR; bots can't push workflow files) | 4 | manual | Low |

## Migration

No production users. Archived pages published before cut 1 have no archive sidecar, so `_redirects` on a plain-static target would drop their rows until they are republished: run `gazetta publish <target> --force` once after cut 1 (the same one-time step #1077 needs; it republishes archived pages too). Worker targets, including gazetta.studio's production, don't use `_redirects`.

## Open questions

1. **Fan-out across target types.** One publish to a static and an ESI target applies the Q4 check per destination; whether the panel should show a row's still-used note per destination or merged is for cut 3.
2. **Concurrent publishes.** One instance removing an item while another publishes it ends with the last writer; a per-target publish lock is a publish undo future direction.

## Future directions

- **Removing assets** from targets, once #1077 makes target indices describe the target. Trigger: a takedown request (an image deleted for legal reasons stays downloadable) or storage growth on targets.
- **`beforeRemove` hook phase** for vetoing removals. Trigger: operator demand.
- **`--remove <item>` on the CLI.** Trigger: demand.
- **Sync chip split into behind and ahead**, as `design-editor-ux.md` describes.
- **Per-destination removal** within one fan-out publish.
