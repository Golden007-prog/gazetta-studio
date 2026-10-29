# Publish undo

Undo and rollback on a publish destination put the previous **content** back and publish it, so visitors see the previous version. Today they restore manifests only: the publish panel says "Undone on production" while the live site keeps serving the published version.

**Status**: design pass complete (2026-10-21). Cut 3 landed in #1082 (2026-10-21), cut 1 in #1430 (2026-10-25); cut 2 is next.

**Companion docs:**
- [#1084](https://github.com/gazetta-studio/gazetta-studio/issues/1084): the issue this design resolves
- [`design-publishing.md`](design-publishing.md) "History": "Undo and rollback restore a prior revision; they reuse the same write-and-render pipeline as publish." This design implements that sentence for publish destinations
- [`design-decisions.md`](design-decisions.md) #18: history lives on the destination (kept)
- [`design-live-check.md`](design-live-check.md): runs after an undo, since undo goes through the publish path
- [`design-public-storage.md`](design-public-storage.md): public targets keep no history, so they have no undo; a locked target blocks undo like any publish
- [`design-hooks.md`](design-hooks.md): publish hooks gain a `trigger` field
- Related: [#1082](https://github.com/gazetta-studio/gazetta-studio/pull/1082) (CLI publishes copy manifests to the target and record history; cut 3)

## Scope

**In v1:**
- Undo and rollback on a publish destination restore the previous content and re-render it through the publish pipeline, removing items the undone publish added
- A check against current templates before anything is written
- The same flow for the publish panel's Undo, the History panel's Restore, and `gazetta undo` / `gazetta rollback`
- Post-publish steps (`sitemap.xml`, `robots.txt`, `_redirects`, the publish generation, CDN purge) in one shared function used by the CLI, the admin and undo (follows from Q4)

**Out of v1:**
- Restoring old template output (templates are code, versioned in git)
- A Redo button (History → Restore covers it)
- A per-target publish lock (concurrent writes are detected, not prevented)
- Propagating source deletions through a normal publish ([#1094](https://github.com/gazetta-studio/gazetta-studio/issues/1094)): designed in [`design-target-removal.md`](design-target-removal.md), which reuses the removal step built here

**Unchanged:** undo on the editing target (`local`) restores manifests only; nothing there is pre-rendered.

## Discovery

- `restoreRevision` (`history-restorer.ts`) writes the revision's snapshot back to the target: page and fragment manifests plus `site.config.ts` (`DEFAULT_SCAN_LOCATIONS`, `DEFAULT_SCAN_ROOT_FILES`). It doesn't render.
- Visitors of a publish destination get rendered output: static pages are pre-rendered HTML; ESI targets hold pre-rendered fragments the worker assembles.
- The publish panel offers Undo per destination and shows "Undone on `<target>`" (`PublishPanel.vue:257`) although nothing visitors see changed.
- The admin route records history, then copies the source manifests to the target (`publishItems`), so the revision's baseline stays pre-publish. The CLI copied no manifests until #1082 (merged 2026-10-21), which records and then copies too, so targets the CLI published to before then hold no manifests.
- `sitemap.xml`, `robots.txt`, `_redirects` and the CDN purge are written separately by the CLI (`cli/index.ts`, around lines 866–1071 on 2026-10-23) and the admin route (`admin-api/routes/publish.ts`, around 599–724); `publishRun`'s purge step is reserved.
- Since #1201 (2026-10-23), both also write `.gazetta/publish-generation` after the content and before the purge; the Cloudflare worker's cache key reads it (#1125).
- No code removes a published item from a target.
- Undo runs only in Node (admin, CLI), never in the worker, so templates are available.

## Locked decisions

### Q1 — Undo gives back the previous content, rendered now

Restore the previous revision's manifests and publish them through the normal pipeline, with today's templates. If restored content no longer fits its template's schema, the undo is refused (Q3).

| Option | Why rejected |
|---|---|
| Exact previous bytes (store rendered output in history) | Storage grows with rendered output: a header change on a static 5K-page target adds up to 5,000 HTML blobs per revision. It would also bring back old template output, silently reverting template fixes deployed on purpose (security, accessibility). |
| Republish the source's previous revision | Breaks once the source has moved on, the case `design-decisions.md` #18 put history on the destination for. |
| No undo for publish destinations | Removes a promised safety net, most needed on production. |

### Q2 — Undo is a publish of the snapshot

`undoPublish(target, revisionId)`:
1. Note the target's history head.
2. Read the target's **actual** manifests (parallel reads with a concurrency limit) and compare them with the restored snapshot: items whose content differs are **changed**; items on the target but not in the restored snapshot are **removed**; an item whose route differs counts as a removal of the old route's output plus a render at the new one. Comparing with the target, not the history head, keeps undo correct when history and the target have drifted (a publish that failed after recording, or a CLI publish before #1082).
3. Build the in-memory site: the target's manifests overlaid with the restored revision's blobs.
4. Check (Q3).
5. Check the history head again. If it moved, stop with nothing written: "`<target>` changed while undoing; check History." Without a lock a small window remains between this check and the first write; accepted (Future directions).
6. Publish through the shared target-publish function (Q4): render the changed items and their static-target dependents (computed from the in-memory site), copy the restored manifests, remove the removed items, then the post-publish steps. An item whose render fails keeps its current manifest on the target and its current entry in the forward revision, so a retry still sees it as changed.
7. Record the forward revision (`operation: 'rollback'`, `restoredFrom`).

A crash midway leaves the target like a crashed publish: rerunning the undo, or publishing, fixes it. The audit event is the existing `restore`.

**Authorization:** undo and rollback need `restore:history` **and** the target's publish capability (`publish:production` or `publish:non-production`), so a role that can't publish to production can't change it through history.

**Approval:** undoing the latest publish creates no publish request on an approval-required target: it's an emergency rollback of content that was approved minutes before. Rolling back to any older revision on such a target creates one publish request for the whole rollback, run as one call of the shared function; the request records the target's history head and the revision to restore, and the approval that reaches the threshold answers `409 STALE_REQUEST` if the head has moved ([`design-target-removal.md`](design-target-removal.md) Q13). Cut 4 adds rollback requests and the undo-latest rule to the gate. The approval gate itself sits at the start of the shared target-publish function (Q4; [`design-target-removal.md`](design-target-removal.md) Q13).

Decided: maintainer, 2026-10-23 (#1120).

**Undo of an undo:** when the target's latest revision is itself a rollback, `gazetta undo` refuses ("The last change was an undo; use `gazetta rollback <rev>`."), and the admin shows no Undo button. Repeated undo never toggles back and forth.

Publish hooks receive `trigger: 'publish' | 'undo' | 'rollback'` and `restoredFrom`, so plugins can tell an undo from a new publish.

| Option | Why rejected |
|---|---|
| Restore the files, then render | A crash between the two leaves old manifests next to partly new HTML. |
| Every undo and rollback waits for approval | Blocks an emergency rollback of the publish just made. |
| No undo or rollback ever needs approval | An arbitrary old revision on an approval-gated target would deploy without anyone approving it now. |
| `restore:history` alone authorizes it | A role without `publish:production` could change production. |
| Compare with the history head | History and the target can drift; added files would be left behind or the wrong ones removed. |
| Check the head only after writing | A concurrent publish is overwritten before the conflict is noticed. |
| A per-target publish lock | Needs cross-instance coordination; the head checks narrow the window enough for now. |

### Q3 — Check before anything is written

Before any write, the restored manifests are validated against today's template schemas with the `schema-conformance` validator, called with a scope it supports (it returns nothing for the `pre-publish` stage today). The revision must contain manifests, and every asset the restored manifests reference must exist on the target or the source. Any failure refuses the undo with nothing changed:
- "Can't undo: `pricing` doesn't match the current `hero` template any more. Nothing was changed."
- "This publish can't be undone: it was made before Gazetta kept its content on `<target>`." (CLI publishes before #1082)
- "Can't undo: the image `hero` that this version uses is no longer available."

A render that fails after the check passes (a template that throws) is reported per item ("11 of 12 pages restored. `pricing` couldn't be rendered: <reason>."); the rest stays restored.

| Option | Why rejected |
|---|---|
| Render first and report failures | Leaves a half-undone site for the common failure, a schema change. |

### Q4 — One shared target-publish function, with removals

The CLI, the admin route and undo are three callers of the same post-publish steps, so they move into one function (team rule 15): render loop (`publishRun`), manifest copy, removals, dependency indices, site manifest, `sitemap.xml`, `robots.txt`, `_redirects`, the publish generation, CDN purge.

**The publish generation** (`.gazetta/publish-generation`, #1125, #1201) is written before the CDN purge, as the CLI and the admin route write it today. The Cloudflare worker's cache key reads it, and undo publishes only through this function, so an undo gets a new generation like any publish; without one, the worker could serve pre-undo pages from its cache until their edge lifetime runs out (a day by default).

Decided: maintainer, 2026-10-23 (#1220)

| Option | Why rejected |
|---|---|
| Leave cut 1 as specified; add the write before cut 4 (undo) is filed | Cut 1 may move the write out of the CLI and the admin route without moving it into the shared function. |
| Record it on #1092 and decide later | cut-planner files cut 1 from #1092's lock at 03:00 UTC. |

**Removal** deletes the item's own files only: its rendered output (static: its route's `index.html` and locale variants; ESI: its `index*.html` under `pages/<name>/` and fragment output), its per-item sidecars and its manifest. A nested item's folder stays: removing `about` leaves `pages/about/team/` (follows from `design-target-removal.md` Q3). Dependency indices are rebuilt by the publish. The item then answers 404, as it did before the publish that added it.

**Generated files are always written or deleted, never skipped:** when no URL or redirect remains, the shared function deletes `sitemap.xml` or `_redirects` instead of leaving the previous file live.

| Option | Why rejected |
|---|---|
| Archive the item instead (410) | It never existed before; 410 tells search engines it was retired. |
| Leave added items in place | The new page stays live after "undo". |
| A separate removal path for undo only | A second way to change a target; the same step serves future source-deletion propagation. |

**A failed run stops there.** When a target's render run fails (its setup failed, or every item failed), nothing after it runs for that target, from either caller: no sitemap, no publish generation, no purge. A failed run wrote no pages, so a purge would only drop cache that is still valid.

Decided: maintainer, 2026-10-25 (#1432)

| Option | Why rejected |
|---|---|
| Keep the CLI's purge of failed targets after the loop | The CLI and the admin would follow different rules in one function, and the purge only drops cache that is still valid. |

**Sitemap hreflang for both callers.** The shared function builds hreflang alternates into `sitemap.xml` as the CLI did, so admin publishes now get them too. For one-domain-per-language targets that's where `design-i18n.md` puts them, and admin publishes were missing them. Two gaps against `design-i18n.md` remain, in [#1431](https://github.com/gazetta-studio/gazetta-studio/issues/1431): path-based targets get a sitemap copy of the hreflang already in each page's `<head>` (Google: allowed, no benefit), and per-domain sitemaps are written as each target publishes instead of after all targets have.

Decided: maintainer, 2026-10-25 (#1432)

| Option | Why rejected |
|---|---|
| Match the design exactly in cut 1: sitemap hreflang only for per-domain targets | Changes the CLI's output inside a cut whose spec keeps today's behaviour. |
| Leave admin sitemaps without hreflang | Per-domain sites keep missing what the design requires, and the CLI and the admin write different sitemaps. |
| Keep the CLI's behaviour with no follow-up | Leaves the duplicate and the publish-order gap untracked. |

**One snapshot per publish.** A publish reads the source once. The audit (the server's publish gate), the history record, the render loop and the manifest copy all use that one loaded copy of the source, and the manifests copied to the target are written from it, not read from storage again. A save that lands after the publish has loaded the source isn't published: the target gets exactly what was audited, its HTML, its manifests and the revision undo restores come from the same version, and the newer save shows as an unpublished change for the next publish. Today the gate, the history record, the render and the copy each read the source separately ([#1527](https://github.com/gazetta-studio/gazetta-studio/issues/1527)). The approval gate checks a request's hashes against this snapshot and publishes the snapshot (`design-review-workflow.md` lock 3); that comparison is built in review workflow cut 13.

Decided: maintainer, 2026-10-29 (#1535)

The history record comes from the snapshot too.

Decided: maintainer, 2026-10-29 (#1535)

So do the asset manifests the publish copies (alt, focal point, overrides); the bytes they point at are content-addressed, so an asset replaced during the publish goes out with the next one.

Decided: maintainer, 2026-10-29 (#1535)

Replacing an asset deletes the old asset's files. If that happens during a publish whose snapshot still uses the old asset, the publish goes ahead for everything else and reports the pages using that asset as not published, with the reason; the next publish takes the replacement.

Decided: maintainer, 2026-10-29 (#1535)

The same applies when a rename, removing a locale override, or deleting an unused asset removes an asset's files mid-publish. The publish checks that every asset its snapshot uses still exists before it records history or copies manifests, and the asset copy skips the assets the check found gone, so the pages it reports as not published keep their previous manifest, HTML and revision entry. This covers assets whose manifest the snapshot loaded. A reference to an asset that had no manifest when the snapshot loaded still blocks the publish (`design-media.md`, "Publish ref integrity"). An asset whose files go after the check fails that target's asset copy, as today.

Decided: maintainer, 2026-10-29 (#1535)

| Option | Why rejected |
|---|---|
| Re-check each item's hash before writing and refuse on a mismatch | The author has to publish again, and the HTML and the manifests can still come from different reads. |
| One snapshot plus a re-check that warns a newer save wasn't included | More code for what the unpublished-change dot already shows. |
| The history record keeps its own read | A save during a publish can land in the revision without having been published, so undo could restore unpublished content. |
| Assets keep their own read | An alt edit or asset replace during a publish can be published without being audited. |
| The snapshot loads asset bytes too, so a replace can't affect the publish | Memory grows with asset size (videos, 20,000-asset sites). |
| Replace keeps the old files until a later cleanup | Changes the media design's delete rule and needs a cleanup command. |
| Keep today's step order: history and manifests first, assets after | Those pages would have the new manifest and revision but the old HTML until the next publish. |
| Only replace gets this handling | A rename, an override removal or a delete during a publish would still fail the whole target. |

## UX check

Rule 23: undo looks like publish because it is one; nothing new appears unless something needs attention.

### Publish panel (cut 5)

| Step | Copy | `data-testid` |
|---|---|---|
| After a publish | "Published ✓" with **Undo** | `publish-undo` |
| Click Undo (production only) | Confirmation: "Production will go back to the version before this publish." Lists removals: "`new-landing` will be removed from production." **Undo** / **Cancel** | `publish-undo-confirm` |
| Refused at the check | "Can't undo: `pricing` doesn't match the current `hero` template any more. Nothing was changed." | `publish-undo-refused` |
| Running | "Undoing… 3 of 12 pages" | `publish-undo-progress` |
| Done | "Back to the previous version." then the live-check line (#1069) | `publish-undo-done` |
| Source still differs | "`local` still has these changes; edit or undo them there before publishing again." Shown only when the source still has the undone content | `publish-undo-diverged` |
| Partial render failure | "11 of 12 pages restored. `pricing` couldn't be rendered: <reason>." with Details | `publish-undo-partial` |
| Conflict | "`production` changed while undoing; check History." | `publish-undo-conflict` |

Staging and other non-production targets get no confirmation: undo can be undone from History. After an undo the Undo button is gone; redo is History → Restore.

### History panel

Restore on any revision follows the same flow. A restore appears as "Restored rev-0041 (undo of rev-0042, by alice)". Help text: "Undo restores content; templates stay as deployed." Viewers without `restore:history` see history, not the buttons.

### CLI

```
$ gazetta undo production
Undo publish rev-0042 on production (12 min ago, alice: pricing, @header)
Production goes back to rev-0041. Continue? (y/N) y
Checking content against current templates… ok
Rendering… 12/12
Live check: 12 live
local still has these changes; edit or undo them there before publishing again.
```

Non-zero exit when refused, conflicted or a render fails. `--yes` skips the question.

## Foundational checks

- **Multi-instance:** no in-memory shared state; the head checks (Q2 steps 1 and 5) detect a concurrent publish on another instance before anything is written. Concurrent history writes can still lose a revision until [#1089](https://github.com/gazetta-studio/gazetta-studio/issues/1089) is fixed.
- **Scale:** snapshot comparison is in memory (about 10–20K entries at 5K pages with locales). Building the in-memory site reads every manifest from the target: about 5K reads, 30–60 s on cloud storage. That exceeds the 5-second admin SLA, but undo runs like a publish, with progress; reads are parallel with a concurrency limit. Rendering is limited to changed items and their dependents.
- **Locale:** locale variants are separate snapshot entries and render per locale like a publish. The first snapshot of a target misses them today, so undo can delete a translation: [#1088](https://github.com/gazetta-studio/gazetta-studio/issues/1088), which cut 4 depends on.
- **Themes:** none.
- **Auth + RBAC:** `restore:history` plus the target's publish capability.
- **Audit:** the existing `restore` event, with `restoredFrom` and the undone operation.
- **Review:** undoing the latest publish needs no new request; rolling back further on an approval-required target creates one.
- **Hooks:** publish hooks fire with `trigger` and `restoredFrom`.
- **Render:** the normal publish render; templates are today's.
- **Validation:** `schema-conformance` runs as the pre-write check.
- **Plugin:** the hook field only.
- **Cache:** the shared function writes the publish generation and runs the CDN purge (follows from Q4), so an undo, like any publish, changes the worker's cache key (#1201).
- **Offline:** undo needs the target; offline admins can't undo (as with publish).
- **Collaboration:** none.

## Cut sequence

| # | What | Depends on | Test tier | Risk |
|---|---|---|---|---|
| 1 | The shared target-publish function (Q4), called by the CLI and the admin route: it wraps `publishRun`, takes over the admin route's history record and manifest copy, has the approval gate's place at its start (`design-review-workflow.md` lock 1), and runs the post-publish steps (`sitemap.xml`, `robots.txt`, `_redirects`, the publish generation, CDN purge); generated files are written or deleted, never skipped | — | unit + api | Medium |
| 2 | Removals in the shared function: delete an item's own files (static route `index.html` and locale variants; ESI `index*.html` under `pages/<name>/`; a nested item's folder stays), sidecars and manifest; removal by route for route changes | 1 | unit + api | Medium |
| 3 | Destinations hold manifests: the CLI copies them after recording history, as the admin route does ([#1082](https://github.com/gazetta-studio/gazetta-studio/pull/1082)) | — | api | Low |
| 4 | `undoPublish`: comparison with the target's manifests, in-memory site with parallel reads, the Q3 check (schemas, manifests present, assets present), head checks before writing, publish through the shared function with removals and dependents, failed renders kept as changed, forward revision, the undo-of-undo refusal, authorization and approval rules, rollback requests and the undo-latest rule at the approval gate (`design-review-workflow.md` locks 3–5), hook `trigger` and `restoredFrom` | 2, 3, [#1088](https://github.com/gazetta-studio/gazetta-studio/issues/1088), review workflow cuts 12–13 (planner [#1433](https://github.com/gazetta-studio/gazetta-studio/issues/1433)) | api-first | High |
| 5 | Admin and CLI: the publish panel flow per the UX table, History Restore through the same flow, CLI output and `--yes`, Storybook stories from the table | 4 | component + e2e | Medium |
| 6 | Docs: "undo restores content, not templates" (History help and docs), `docs/hooks.md` trigger field, alignment note in `design-publishing.md` | 4 | docs | Low |
| 7 | One snapshot per publish (Q4): the server's publish gate, the history record, the render loop, the manifest copy and the asset manifest copy use one loaded copy of the source; manifests, asset manifests and the revision are written from it instead of read from storage; before the history record and manifest copy, a check that the snapshot's assets still exist, pages whose asset the check found gone are reported as not published and the asset copy skips those assets, while the rest goes ahead | 1 | api-first | Medium |

Cuts 1 and 3 run in parallel. Cut 7 can run alongside cut 2; review workflow cut 13 checks request snapshots against it, so it waits for cut 7 (follows from Q4's one snapshot). Cut 3 landed in #1082 (2026-10-21).

Cut 1 builds the function itself: everything Q4 lists except removals, which cut 2 adds, and the one snapshot, which cut 7 adds. Review workflow cuts 12–13, which wait for it, then build the approval gate in its final place.

Decided: maintainer, 2026-10-23 (#1120).

| Rejected | Why |
|---|---|
| A new cut after cut 1 wraps `publishRun` | One more cut for publish undo cut 2 and review workflow cuts 12–13 to wait for, where Q4 describes one function. |
| Keep cut 1 as scoped | The admin route records history and copies manifests before `publishRun`, so a gate at the start of cut 1's function would come after both: a gated target would receive manifests and a revision before the request is created. |

Cut 4 adds rollback requests and the undo-latest rule to the approval gate, so it waits for review workflow cuts 12–13, as target removal cut 2 does for removals.

Decided: maintainer, 2026-10-23 (#1120).

| Rejected | Why |
|---|---|
| Ship undo first and refuse rollbacks on targets that need approval | Undo there would be refused until a later cut adds rollback requests and the undo-latest rule. |
| Whichever of cut 4 and review workflow cut 12 lands second | Each spec would depend on what has landed when it's built. |

## Migration

No production users. Revisions recorded before cut 3 on CLI-published targets have no manifests and are refused with the Q3 message.

## Open questions

1. ~~**Does deleting a page on the source and publishing leave it on the target today?**~~ **Yes** (read from code, 2026-10-21): compare reports it as `deleted`, but the admin can't select it and the CLI never removes it, so a hand-deleted page stays live and the sync count stays "behind". Filed as [#1094](https://github.com/gazetta-studio/gazetta-studio/issues/1094); cut 2's removal step is what a fix would use.
2. ~~**Where the CDN purge actually runs today.**~~ Settled by cut 1 (#1430): in the shared function (`publishToTarget`, step 6), after the publish generation, and not at all for a failed run (Q4).

## Future directions

- **Propagate source deletions on publish** ([#1094](https://github.com/gazetta-studio/gazetta-studio/issues/1094)): designed in [`design-target-removal.md`](design-target-removal.md), using cut 2's removal step.
- **A per-target publish lock** to close the window between the last head check and the first write, if concurrent publishes become common.
