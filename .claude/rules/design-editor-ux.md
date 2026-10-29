# Editor UX

How the CMS admin organizes authoring, comparison, and publishing around a single spine:
the **active target**. This doc covers UX concepts and behavior rules; see design-concepts.md
for the underlying nouns and design-publishing.md for operations.

## The active target is the UX spine

At any moment, exactly one target is active. Everything in the workspace orients around it:

| Surface | Binds to active target as |
|---------|---------------------------|
| Tree | Structure of active target |
| Editor | Form for selected item on active target |
| Preview | Rendered output of active target |
| Save | Writes to active target (if editable) |
| Publish | Defaults source or destination to active |
| Sync indicators | Other targets shown "N behind/ahead of active" |
| Compare | Framed as "active vs X" |

## Editable vs read-only

A target's `editable` flag determines what the author can do when that target is active:

| `editable` | Author can | Author cannot |
|-----------|-----------|---------------|
| `yes` | Edit form, save, publish to and from this target | — |
| `no` | View tree, inspect editor (read-only), view preview, publish to and from this target | Save |

Editability doesn't limit Publish: production is read-only by default and receives publishes (`design-decisions.md` #16; the server doesn't check `editable` on publish).

The workspace chrome reflects the current state: read-only active targets lock the editor,
hide the save button, and show read-only indicators.

## Switching active target

Switching is cheap in browse mode; in edit mode with unsaved changes it triggers the
same unsaved-changes guard as any other navigation. One affordance, one place:

### Top-bar switcher (sole switcher)

**Intent:** navigate workspace focus to a different target — works equally for
"show me this page on staging" (A/B comparison) and "go edit staging next."

- Location: top bar, always visible
- Shows: active target name + environment chrome + sync indicators for other targets
- Behavior:
  - If focused item (page/fragment) exists on destination → preserve focus, swap target
  - If focused item doesn't exist on destination → focus drops to site root; transient banner:
    *"pages/pricing isn't on staging — showing site root"* with one-click "back to pages/pricing on local"
  - If the editor has unsaved edits → unsaved-changes dialog (Save / Don't Save / Cancel)
    runs before the switch, same flow as router-driven navigation. Keeps the author in
    control and prevents silent drops or writes to the wrong target.

**Why one switcher, not two:** an earlier design had a second "preview tabs" affordance
at the top of the preview pane for rapid A/B flipping. Since page selection survives
target switches, the top-bar switcher already gives rapid A/B — the second affordance
was redundant and invited accidental switches during editing. Same rationale as unified
Publish: one verb per concern.

## What's preserved across switches

Switching must not disorient the author. Preserve across active-target switches in
browse mode:

- **Preview**: scroll position, viewport size, zoom, device mode
- **Tree**: expansion state
- **Selection**: focused item + any sub-selection

In edit mode, the unsaved-changes guard runs first. On *Save* or *Don't Save* the
editor clears (as with any page-to-page navigation); on *Cancel* nothing changes.
Per-target dirty form state is not preserved — the guard makes the author's intent
explicit, and preserving parallel drafts across targets invites drift that's hard to
reason about ("which draft was I on again?").

## Making the active target unmistakable

Rapid target switching (comparison mode) requires the author to always know which target is
active without conscious thought. Design commitments:

- **Workspace chrome tinted by environment**: prod gets red accents on top bar, edges, borders.
  Local is neutral. Staging is amber. Applied to the whole workspace, not just a corner —
  peripheral vision catches it.
- **Persistent target name** in a fixed top-bar position, large enough to read without focus
- **Save button label** reflects the target: "Save to prod" when prod is active (when editable)

If the author is editing production directly (allowed by `editable: yes` on prod), the prod
chrome is permanent — no confirmation dialog, but constant visual warning.

## Item availability across targets

An item is "available" on a target if its path exists there. Availability determines:

- **Top-bar switcher menu**: targets missing the focused item still switch, but focus
  falls back to the site root with a transient banner (see "Switching active target").
- **Empty-state messaging**: when an item doesn't exist on the destination, show a publish
  affordance ("Publish pages/pricing from local to staging") rather than a raw error

The tree reflects only the active target's structure — it does not show items present on
other targets. Cross-target visibility lives in sync indicators and publish flows.

## Save and publish share a pipeline

Save and publish are architecturally the same operation — "write logical content to
destination + render if destination is static." They differ only in destination:

- **Save**: form-state → active target
- **Publish**: target → target (either direction)

From the author's POV, save is instant on dynamic targets; on static edit targets, save
incurs render cost and shows a visible "Saving…" state. Preview reflects saved state
(or dirty form state if unsaved).

**Three pending lanes, one save.** Form-state covers three kinds of edits: **content** edits
(per-component field changes), **structural** edits (move/add/remove of components on
a page or fragment manifest) and **page metadata** edits (SEO title, description, OG image,
canonical, robots). All are pending until explicit save; all contribute to the dirty-dot
indicator and the unsaved-changes guard; all are reverted by Discard for the focused page;
one Save writes them all. The writes are sequential, not one transaction: a failure part-way
leaves the earlier writes on disk and keeps everything pending, including what already landed;
the next Save rewrites it (the guard stays put on a failed save, #977). Structural and metadata drafts
restored after a reload wait for their page: they become pending when it is opened in that
locale (#979). Edits made while a save
runs stay pending: what the save wrote becomes each lane's baseline, so text typed or a component
moved meanwhile is neither marked saved nor dropped. Authors see the tree reflect a pending reorder immediately, but the disk file is
unchanged until save lands. This avoids the asymmetry where a discard would revert content
edits while structural changes silently persisted.

### Page metadata is a pending lane (locked 2026-10-18)

**Why.** Page metadata was edited in `PageMetadataEditor` with its own local `dirty` flag and
its own Save button, outside the pending-edit model. Reproduced 2026-10-18 against an unsaved
content edit as the control: the guard didn't fire on a target switch or on leaving edit mode;
reload gave no leave-page prompt; the main Save didn't save it. Also reproduced: no guard on a
locale switch (the content control for that path is #977's e2e test). From code: the form's
state is local, so nothing keeps it across a reload, and clicking another component unmounts
the form and drops the edit. Research across CMSes with an explicit Save (Payload, Strapi, Directus, Storyblok,
WordPress + Yoast) found metadata always rides the document's one Save, and the dirty-guard
covers it only when it is ordinary form state — Yoast in the block editor, whose fields sit
outside the editor state, has exactly this gap ([`docs/audits/cms-seo-metadata-save.md`](../../docs/audits/cms-seo-metadata-save.md)).

**Model.**
- **Key:** `{ kind: 'page', name, locale }` — the same shape as structural edits (locale variants
  are whole files with their own metadata). Value: `{ original, pending }`; `original` is the
  metadata as loaded (the Discard baseline and the conflict view's starting point).
- **Dirty** = `pending` differs from `original` (compared, not a sticky flag), so typing a value
  back to the original clears the dot.
- **Editing keeps what the form doesn't show.** `pending` starts as a copy of the loaded metadata
  and the form changes only its own fields. Unknown keys survive, and the noindex checkbox adds or
  removes only the `noindex` token of `robots` (`nofollow` survives). Before this lock the save
  rebuilt metadata from the form and dropped both.
- **An emptied field removes its key**, as today, so files stay clean. (Rendering doesn't depend
  on it: the renderer treats `""` like a missing field — `||` fallbacks, `robots` only when set.)
- **Save:** the one Save (toolbar, Ctrl/Cmd+S, the dialog's Save) writes each entry as its own
  `PUT { metadata }` to **the entry's locale**, with `If-Match` from the save-version store, after
  the other lanes. Each write stores the version it gets back (`updateManifest`), so writes in
  sequence chain. Verified against the server: a content write, then a metadata write carrying
  the new version, both succeed; the metadata write with the old version is rejected as `STALE`.
- **Ctrl/Cmd+S saves when any edit is pending** (`hasPendingEdits`), not only when the open editor
  is dirty. This also changes the shortcut for reorders and stashed edits, which it ignored; on a
  clean form it stays a no-op.
- **Discard** for the focused page (the conflict banner's "Discard my changes") reverts its entry;
  the dialog's Don't Save drops it; `clear()` drops the entries it discards, like the other lanes.
- **Guard and leave-page prompt:** `hasPendingEdits` counts entries.
- **Dirty dot:** the same dot as content edits, on the page root. The root row's revert button
  shares the dot's condition, so it reverts pending metadata too.
- **A row's revert undoes only what that row's dot marks** (decided 2026-10-18, while building).
  The page row reverts its own editor's edits and the page's metadata; a component row reverts its
  content, open or stashed. Pending moves and other rows' edits stay. Before, reverting the open
  component ran the page-level Discard, which also dropped pending moves, and would now have
  dropped an SEO edit that isn't on screen. Page-wide discards stay where they say so: the
  conflict banner's "Discard my changes" and the dialog's Don't Save.
- **Kept across reload:** a `metadata` lane in the draft store (`design-offline.md`). A restored
  entry **becomes active only when its page is opened in that locale**, like content drafts:
  until then it is stored but doesn't count for the guard, and no Save writes it. Opening the
  page activates it, so the root dot shows straight away. Restored structural drafts follow the
  same rule (#979), and Don't Save on another page keeps them stored. Why not active at once:
  reproduced 2026-10-18 — a reorder on `home`, reloaded onto an untouched `about`, enabled Save
  there, and leaving showed "You have unsaved changes on about".
- **One Save:** `PageMetadataEditor` loses its own Save button and reads/writes the lane. It keeps
  the Archive button, the SERP preview (showing pending values, as today), the counters and its
  test ids, and still renders only on the page root.
- **Preview `<head>`:** not updated from pending metadata. The SERP preview already shows it, and
  this keeps the preview's two-lane `DraftOverrides` wire contract unchanged.

**Rejected.**

| Option | Why rejected |
|---|---|
| Guard only: count the form's `dirty` flag; the dialog's Save also saves metadata | The edit still lives inside a component that unmounts on component navigation, and nothing keeps it across reload |
| Merge metadata into the root content target (`PUT { content, metadata }`) | The root form is a React form mounted inside Vue; mixing the Vue panel's state into it is fragile. One write per file is a possible later optimisation |
| Auto-save metadata on blur (Ghost's model) | Team rule 1: no auto-save |
| Metadata in a modal with its own Save/Cancel (Webflow's page settings) | A second save model; Webflow documents no guard for it |
| Keep the separate metadata Save button as well | Two affordances for one action ("replace, not augment" — component-ordering Q3) |
| Show pending metadata in the preview `<head>` | Invisible to authors in the iframe; would add a third lane to the preview wire format |
| Keep the open row's revert page-wide | Drops work the author can't see: the SEO form shows only on the page row, and pending moves have no dot in either tree |

**Known limits.** Toast Undo restores only the last write; a Save that wrote content and metadata
undoes only the metadata (an existing multi-write limit, not new). Publishing sees metadata-only
changes: the publish hash counts metadata ([`sidecars.md`](sidecars.md), "Hash input").

**Foundational checks.** Client-only change on the existing save route, so multi-instance, scale
(O(pending entries)), cache, render, plugin and collaboration are unaffected. Locale: keyed and
written per locale. Auth: the same `edit:pages` route. Audit, review (`invalidateOnSave` already
counts metadata) and hooks (`beforeSave` already sees `payload.metadata`): one event per write, as
today. Validation: save-delta validators don't read metadata. Offline: the draft-store lane.

**Tests that pin the decisions** (each checked by breaking the code it covers):
- Save order: content and metadata pending on one page → one Save writes both, metadata last with the new version; no conflict. With a stale version stored → `STALE` and the conflict banner.
- Locale: metadata pending on `fr` → written to `page.fr.json`, even when saved from another locale.
- Restore: a metadata draft for page A doesn't enable Save or the dialog on page B; opening A activates it and shows the root dot.
- Guard and prompt: with only metadata pending, the dialog appears on target / locale switch and on leaving edit mode, and reload prompts.
- Ctrl/Cmd+S with only metadata pending saves it; on a clean form it does nothing.
- Root revert with only metadata pending clears the dot and the entry.
- A component row's revert, with that component open, keeps the page's pending metadata and moves.
- Component click and back: the metadata edit survives.
- Editing keeps unknown keys and `nofollow`; an emptied field removes its key.

**Cut sequence.**

| # | What | Depends on | Test tier | Risk |
|---|---|---|---|---|
| 1 | Metadata lane store: key with locale, `{ original, pending }`, dirty by comparison, edits that keep unknown keys and other robots tokens | — | unit-first | Low |
| 2 | Editor wiring: pending count, Save writes to the entry's locale with `If-Match` after the other lanes, Discard / Don't Save / `clear()`, dirty dot and root revert, Ctrl/Cmd+S on any pending edit | 1 | unit + integration | Medium |
| 3 | `PageMetadataEditor` reads/writes the lane; its Save button goes | 2 | component + e2e | Medium |
| 4 | Draft-store `metadata` lane: kept across reload per site, owner and target; active only once its page is opened in that locale | 1, 2 | unit + e2e | Medium |
| 5 | Docs: `docs/offline.md`, SEO docs, the `CONTEXT.md` pending-edits entry | 3, 4 | docs | Low |

## Undo and rollback

Every write records a revision on the target (see design-publishing.md for storage shape).
Two UX entry points surface the same underlying mechanism:

**Transient Undo after an action.** After a save or publish completes, the top bar briefly
shows the action + an Undo button:

> *Published 3 items to prod. [Undo]*

One click restores the target's immediately prior state (as a new revision). The Undo
affordance disappears once a newer write lands on that target — use the history panel for
arbitrary rollback after that point.

**Target history panel.** Click a target in the top bar to open its history — a list of
revisions with timestamp, author, operation, and affected items. Each row has a **Restore**
action that creates a new revision matching that past state. Rollback is just restore to
an older revision.

Undo and rollback are the same operation; they differ only in entry point. Both produce
forward-only revisions — history never shrinks except via retention eviction.

## Scaling to 4+ targets

When the total target count is ≥ 4, targets sharing an `environment` collapse into a group
across all target-referencing surfaces. Groups of 1 stay flat; targets with no environment
set display ungrouped alongside groups.

| Surface | ≤ 3 targets (flat) | 4+ targets (grouped) |
|---------|--------------------|-----------------------|
| Top-bar sync indicators | `staging · 3b   prod · 7b` | `staging · 3b   production (2) · 7b` (click → expand) |
| Top-bar switcher menu | Flat list of targets | Grouped by environment with sub-menus |
| Publish picker (From / To) | Flat dropdown | Dropdown grouped by environment with headers |

**Cycling within a group:** hovering a group in the switcher menu reveals its members;
when a group member is active, the indicator shows which: `production: prod-us`.

**Grouping is presentation only.** Environments remain non-hierarchical in the model;
grouping is a UX compression for density, not a configured concept.

## Multi-destination publish (fan-out)

The Publish picker's "To" selector supports multi-select. Selecting an environment group
selects all its members; individual members can be toggled. A single Publish action then
fans out to all selected destinations.

Progress is reported per-destination; a failure on one destination does not abort the
others. Author sees the full matrix of results.

No new operation — Publish already moves content between any two targets. Fan-out is a
picker mode on top of the same verb.

## Progressive disclosure

The UI adapts to configured targets. Features appear based on config, not user profile:

| Configuration | UI changes |
|---------------|------------|
| 1 target configured | No publish UI. Save is all. No target switcher. |
| 2+ targets | Publish affordance appears. Sync indicators in top bar. |
| 4+ targets | Environment-based grouping in sync indicators, switcher menu, and publish picker. |
| 2+ peers share an environment | Fan-out publish available (multi-select in picker). |
| 2+ targets, one tagged `production` | Prod chrome (red accents) everywhere prod is referenced. |
| 2+ targets | Active-target switcher in top bar becomes interactive. |
| Editable target tagged `production` | Prod chrome on workspace when active; "Save to prod" labeling. |
| Any target marked non-editable | That target appears read-only when active; save is absent. |

No profile selection, no settings toggles. Target configuration *is* the workflow.

## Out of sync

When two targets differ in logical content, they're "out of sync." No hierarchy is implied
— neither target is presumed correct. The author knows which is authoritative because the
author configured the workflow. UI framing:

- "staging: 3 behind local" = three items on local that staging doesn't have or differs on
- "prod: 2 ahead of local" = two items on prod that local doesn't have or differs on
  (typical of direct-to-prod hotfixes)

All sync state is expressed relative to the active target. The author picks the reference
point by choosing what's active.

## Author's mental model (one sentence)

> I have one or more targets. One is active — that's where I'm focused: its tree, its editor,
> its preview. If it's editable, I can save to it. I can switch focus to any other target at
> any time, instantly, without losing my place. Publish moves content from one target to
> another, in any direction.

## Current code alignment

The design above is forward-looking. Current code state:

- **Active target** — implemented as `useActiveTargetStore`
  ([apps/admin/src/client/stores/activeTarget.ts](../../apps/admin/src/client/stores/activeTarget.ts)).
  Drives tree, editor, preview, and publish defaults. Persists to localStorage.
- **Top-bar switcher** — `ActiveTargetIndicator.vue` shows the active target pill with
  environment chrome; clicking reveals the switcher menu when 2+ targets exist. Guards
  on unsaved edits via `useUnsavedGuardStore`.
- **Sync indicators** — `SyncIndicators.vue` + `useSyncStatusStore` show "staging · 3 behind"
  chips in the top bar, relative to active. Click opens PublishPanel pre-pointed at that
  destination. The chip shows one count (added + modified + only on that target), not the
  separate "behind" and "ahead" that "Out of sync" describes; items only on the other
  target are removable from the publish panel ([`design-target-removal.md`](design-target-removal.md) Q10).
- **Target properties** — `environment`, `type`, and `editable` are all on `TargetConfig`
  ([packages/gazetta/src/types.ts](../../packages/gazetta/src/types.ts)). Defaults:
  environment=local, editable=true for local else false.
- **Unified Publish** — `PublishPanel.vue` is the sole surface. Source picker +
  destinations fan-out + item list with diffs + streaming progress + prod confirmation.
  Replaced the old PublishDialog / FetchDialog / ChangesDrawer trio.
- **Preview target switching** — driven by the top-bar switcher. Iframe morphs content
  in place (scroll/zoom preserved) when the active target changes on the same page.
  There is no page-context preview-tabs affordance — see "Why one switcher" above.
- **Fragment preview** — via `/@{name}` routing in
  [apps/admin/src/client/utils/selection.ts](../../apps/admin/src/client/utils/selection.ts).
- **Fragment blast radius** — implemented in PublishPanel item rows, editor header, and
  site tree (compact count badge). Fetches via `/api/dependents`; the admin-api's source
  sidecar writer memoizes backfill so concurrent tree badges share one pass.
- **Undo / rollback / revision history** — not implemented. Designed: per-target history in
  `.gazetta/history/` inside the target, content-addressed blobs, soft undo (forward-only
  revisions). See design-publishing.md "History" section.

## Open spots (not yet designed)

- **Multi-author** — concurrent editing, locks, handoffs
- **Batches / named releases** — grouping changes into a publishable unit
- **Scheduled publishes** — delayed or time-triggered publish
- **Permissions / roles / authentication** — per-user capabilities
- **Split-preview comparison** — side-by-side view of two targets for the same page
- **Target configuration surface** — where targets are declared (YAML file vs in-CMS settings)
- **A publish-protected target** — a setting that refuses publishes into a target (today any target receives them)
- **Overwrite warning** — when publishing would replace newer content on the destination
