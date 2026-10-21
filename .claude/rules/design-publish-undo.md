# Publish undo

Undo and rollback on a publish destination put the previous **content** back and publish it, so visitors see the previous version. Today they restore manifests only: the publish panel says "Undone on production" while the live site keeps serving the published version.

**Status**: design pass complete (2026-10-21). Implementation not started.

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
- Post-publish steps (`sitemap.xml`, `robots.txt`, `_redirects`, CDN purge) in one shared function used by the CLI, the admin and undo

**Out of v1:**
- Restoring old template output (templates are code, versioned in git)
- A Redo button (History → Restore covers it)
- A per-target publish lock (concurrent writes are detected, not prevented)
- Propagating source deletions through a normal publish (open question 1; the removal step built here is what it would use)

**Unchanged:** undo on the editing target (`local`) restores manifests only; nothing there is pre-rendered.

## Discovery

- `restoreRevision` (`history-restorer.ts`) writes the revision's snapshot back to the target: page and fragment manifests plus `site.config.ts` (`DEFAULT_SCAN_LOCATIONS`, `DEFAULT_SCAN_ROOT_FILES`). It doesn't render.
- Visitors of a publish destination get rendered output: static pages are pre-rendered HTML; ESI targets hold pre-rendered fragments the worker assembles.
- The publish panel offers Undo per destination and shows "Undone on `<target>`" (`PublishPanel.vue:257`) although nothing visitors see changed.
- The admin route copies source manifests to the target (`publishItems`) before recording history; the CLI path doesn't, so CLI-published targets hold no manifests (#1082).
- `sitemap.xml`, `robots.txt`, `_redirects` and the CDN purge are written separately by the CLI (`cli/index.ts`, around lines 870–990) and the admin route (`admin-api/routes/publish.ts`, around 514–597); `publishRun`'s purge step is reserved.
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
1. Compare the target's head snapshot with the restored one: items whose hash differs are **changed**; items in the head but not in the restored snapshot are **removed**.
2. Build an in-memory site from the target's current manifests overlaid with the restored revision's blobs. Reads run in parallel with a concurrency limit.
3. Check (Q3).
4. Publish through the shared target-publish function (Q4): render the changed items and their static-target dependents (computed from the in-memory site), copy the restored manifests, remove the removed items, then the post-publish steps.
5. Check the target's history head is still the revision the undo started from; if not, record nothing and report "`<target>` changed while undoing; check History". The publish that landed wins.
6. Record the forward revision (`operation: 'rollback'`, `restoredFrom`).

A crash midway leaves the target like a crashed publish: rerunning the undo, or publishing, fixes it. Undo and rollback create no publish request on targets that require approval: they restore content that was already approved, and they're gated by `restore:history`. The audit event is the existing `restore`.

Publish hooks receive `trigger: 'publish' | 'undo' | 'rollback'` and `restoredFrom`, so plugins can tell an undo from a new publish.

| Option | Why rejected |
|---|---|
| Restore the files, then render | A crash between the two leaves old manifests next to partly new HTML. |
| Undo waits for publish approval | Blocks an emergency rollback; the content was approved when first published. |
| A per-target publish lock | Needs cross-instance coordination; the head check catches the conflict without it. |

### Q3 — Check before anything is written

Before step 4, the restored manifests are validated against today's template schemas (the `schema-conformance` validator), and the revision must contain manifests at all. Either failure refuses the undo with nothing changed:
- "Can't undo: `pricing` doesn't match the current `hero` template any more. Nothing was changed."
- "This publish can't be undone: it was made before Gazetta kept its content on `<target>`." (CLI publishes before #1082)

A render that fails after the check passes (a template that throws) is reported per item ("11 of 12 pages restored. `pricing` couldn't be rendered: <reason>."); the rest stays restored.

| Option | Why rejected |
|---|---|
| Render first and report failures | Leaves a half-undone site for the common failure, a schema change. |

### Q4 — One shared target-publish function, with removals

The CLI, the admin route and undo are three callers of the same post-publish steps, so they move into one function (team rule 15): render loop (`publishRun`), manifest copy, removals, dependency indices, site manifest, `sitemap.xml`, `robots.txt`, `_redirects`, CDN purge.

**Removal** deletes an item's rendered output (static: its route's `index.html` and locale variants; ESI: `pages/<name>/…` and fragment output), its per-item sidecars and its manifest. Dependency indices are rebuilt by the publish. The item then answers 404, as it did before the publish that added it.

| Option | Why rejected |
|---|---|
| Archive the item instead (410) | It never existed before; 410 tells search engines it was retired. |
| Leave added items in place | The new page stays live after "undo". |
| A separate removal path for undo only | A second way to change a target; the same step serves future source-deletion propagation. |

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

- **Multi-instance:** no in-memory shared state; the head check (Q2 step 5) detects a concurrent publish on another instance.
- **Scale:** snapshot comparison is in memory (about 10–20K entries at 5K pages with locales). Building the in-memory site reads every manifest from the target: about 5K reads, 30–60 s on cloud storage. That exceeds the 5-second admin SLA, but undo runs like a publish, with progress; reads are parallel with a concurrency limit. Rendering is limited to changed items and their dependents.
- **Locale:** locale variants are separate snapshot entries and render per locale like a publish.
- **Themes:** none.
- **Auth + RBAC:** `restore:history` (existing). No publish request on approval-required targets.
- **Audit:** the existing `restore` event, with `restoredFrom` and the undone operation.
- **Review:** undo restores already-approved content without a new request.
- **Hooks:** publish hooks fire with `trigger` and `restoredFrom`.
- **Render:** the normal publish render; templates are today's.
- **Validation:** `schema-conformance` runs as the pre-write check.
- **Plugin:** the hook field only.
- **Cache:** the CDN purge runs through the shared function.
- **Offline:** undo needs the target; offline admins can't undo (as with publish).
- **Collaboration:** none.

## Cut sequence

| # | What | Depends on | Test tier | Risk |
|---|---|---|---|---|
| 1 | Extract the post-publish steps (`sitemap.xml`, `robots.txt`, `_redirects`, CDN purge) into one shared target-publish function called by the CLI and the admin route; behaviour unchanged | — | unit + api | Medium |
| 2 | Removals in the shared function: delete an item's rendered output (static route `index.html` and locale variants; ESI `pages/<name>/…`), sidecars and manifest | 1 | unit + api | Medium |
| 3 | Destinations hold manifests: the CLI copies them before recording history ([#1082](https://github.com/gazetta-studio/gazetta-studio/pull/1082)) | — | api | Low |
| 4 | `undoPublish`: snapshot comparison, in-memory site with parallel reads, the Q3 check and the missing-manifests refusal, publish through the shared function with removals and dependents, head check, forward revision, hook `trigger` and `restoredFrom` | 2, 3 | api-first | High |
| 5 | Admin and CLI: the publish panel flow per the UX table, History Restore through the same flow, CLI output and `--yes`, Storybook stories from the table | 4 | component + e2e | Medium |
| 6 | Docs: "undo restores content, not templates" (History help and docs), `docs/hooks.md` trigger field, alignment note in `design-publishing.md` | 4 | docs | Low |

Cuts 1 and 3 run in parallel. If #1082 stalls, cut 3 is filed for fix-bot.

## Migration

No production users. Revisions recorded before cut 3 on CLI-published targets have no manifests and are refused with the Q3 message.

## Open questions

1. **Does deleting a page on the source and publishing leave it on the target today?** It looks so from the code (no removal step exists), but it isn't verified end to end. Check before filing; cut 2's removal step is what a fix would use.
2. **Where the CDN purge actually runs today:** `publishRun` lists it as step 12 but marks it reserved; the CLI and admin route purge themselves. Cut 1 settles it.

## Future directions

- **Propagate source deletions on publish,** using cut 2's removal step (if open question 1 confirms the gap).
- **A per-target publish lock** if concurrent publishes become common enough that the head-check conflict shows up.
