---
paths:
  - "packages/gazetta/src/admin-api/**"
  - "**/review*"
---

# Review workflow

Foundational dimension #6 of 13. Content review state machine + per-target publish approval. Operators with team workflows (content quality review, release management gates, compliance approvals) configure their flow per target; solo / small-team workflows bypass.

**Status**: design pass complete (2026-05). Selected as the next feature-bot candidate (2026-06-07), when it was the top committed **Phase-2** feature in [`ROADMAP.md`](../../ROADMAP.md), with all foundations (AuthIdentity + Audit + Hooks) shipped. The "Tier 3" status line in earlier passes was written before those foundations landed; ROADMAP is the live prioritization artifact, and it now lists this in Now ("Review workflow — finish"). Before migration to a tracking issue + cut sub-issues, the High-risk UX cuts (now cut 11, ReviewBanner + state badge, and cut 14, publish-approval gate UX) get a **UX-grilling pass** (Phase 2a of [`feature-design-process.md`](feature-design-process.md), which the original design pass skipped — that's *why* they're High-risk). The grilling output is **Storybook stories** (per [ADR-0016](../../docs/adr/0016-storybook-for-bot-executable-ux-specs.md)) that lock each component's states + layout + copy + `data-testid`s. The stories become the cut's executable spec; feature-bot implements components to green stories rather than inventing UX. With the UX locked in stories, every cut stays bot work.

**Companion docs**:
- [`feature-design-process.md`](feature-design-process.md) — defines the **Review check** every new feature design must answer
- [`design-auth-rbac.md`](design-auth-rbac.md) — capability vocabulary + Principal type
- [`design-audit.md`](design-audit.md) — audit log records every state transition
- [`design-collaboration.md`](design-collaboration.md) — comments / mentions / notifications layer; review-workflow v1 has narrow comment fields (reject reason); broader conversational surfaces belong in collaboration
- [`design-publishing.md`](design-publishing.md) — existing publish primitives + history-recorder
- [`design-editor-ux.md`](design-editor-ux.md) — Active target + Save semantics that review workflow gates on

## Why this is foundational

Different team workflows want different review shapes — some want content review only (editorial focus), some want publish approval only (release management focus), some want both (mid-sized teams), some want strict 4-eyes-principle (compliance). The state machine + capability composition + per-target opt-in have to support all archetypes uniformly.

Adding review later means retrofitting save/publish handlers, audit log shape, capability vocabulary, and admin UX. Joint design with auth/RBAC and audit because review uses both.

## Locked invariants

- **Per-content review** (NOT per-target). Content reviewed once; publishable to any target the actor has `publish:` capability for. Per-target deployment timing is a separate concern (per-target publish approval, optional).
- **Per-target publish approval** opt-in via `targets.{name}.requiresPublishApproval: true`. When set, publish events on that target need explicit approval beyond content review.
- **Three content review states**: `draft` → `pending-review` → `approved`. The fourth state I called "published" collapses INTO `approved` + per-target deployment timestamps from existing publish sidecars. Source-side review state vs. target-side deployment state are separate concerns.
- **Explicit-action invariant**: every state transition requires a deliberate human action recorded as an audit event. No threshold-met daemons; the click that meets the threshold writes the per-approver sidecar AND the new state in one transaction. No time-based auto-transitions.
- **Edit during pending-review is locked**: `pending-review` state denies edits with 409; author can withdraw submission (returns to `draft`) and edit. Prevents revision-DAG complexity.
- **Single reject action with mandatory comment.** No "request changes" state; comment captured in audit metadata. "Approve with caveats" is a collaboration concern (`design-collaboration.md`), not a review-state-machine concern.
- **`requiredApprovers` snapshotted at submit time.** Submission carries the policy-at-submit; subsequent config changes affect future submissions only. SOC 2-friendly (policy at decision time is documented).
- **`allowSelfApproval` defaults to `true`.** Solo / small-team archetypes (A, B) need it. Compliance archetype E opts out via `false`.
- **`invalidateOnSave` defaults to `'content-diff'`.** Only logical content changes invalidate approval. Compliance archetype E opts into `'always'`.
- **`'content-diff'` compares `computeSaveEtag(manifest)`, NOT the `.{8hex}.hash` publish-state hash.** The publish hash deliberately substitutes template + fragment hashes into the manifest, because it answers "did anything in the dep tree change" for publish + cache invalidation. Using it here would revoke a reviewer's approval whenever an unrelated template or fragment changed — even though the approved *content* is untouched. Approval is about the content a reviewer read, so the comparison must be content-only. `computeSaveEtag` ([save-etag.ts](../../packages/gazetta/src/save-etag.ts)) is exactly that, and the save path already computes it ([manifest-save.ts](../../packages/gazetta/src/manifest-save.ts)) — no new plumbing. This mirrors the reasoning `save-etag.ts` documents for its own existence: "a template change doesn't dirty individual pages from the author's perspective." *(Promoted from implementation open-Q #2 — the recommendation was already made there and in `save-etag.ts`'s header; leaving it open inside a cut body made Cut 5 an implementation task carrying an unresolved design decision, which is why it failed three times.)*
- **Combined "Submit & approve" button** when actor has both capabilities AND self-approval allowed AND `requiredApprovers: 1`. Audit records both events with same timestamp + same actor.
- **Pages and fragments are reviewable in v1; assets and asset-metadata defer to v2.** Asset uploads / metadata edits / site config changes / template changes bypass review at v1 (gated by their own capabilities).

## Design details

### State machine details
- Three content states (`draft` / `pending-review` / `approved`); per-content sidecar at source level
- Three publish states per publish event (when `requiresPublishApproval`): `publish-pending` / `publish-approved` / `published`
- Multi-approver counter: `requiredApprovers` per content (snapshotted at submit time); `requiredPublishApprovers` per publish event (snapshotted at request time)

### Audit event shape (extends `design-audit.md`'s `action` enum)

```ts
// Content review transitions
{ action: 'review-submit',   outcome: 'success', actor, scope }
{ action: 'review-approve',  outcome: 'success', actor, scope }                                  // metadata.comment optional
{ action: 'review-reject',   outcome: 'success', actor, scope, metadata: { comment: string } }   // comment required
{ action: 'review-withdraw', outcome: 'success', actor, scope }                                  // submitter's own action

// Per-target publish approval transitions (only when requiresPublishApproval: true)
{ action: 'publish-request',  outcome: 'success', actor, scope, metadata: { targetName: string } }
{ action: 'publish-approve',  outcome: 'success', actor, scope, metadata: { targetName: string } }
{ action: 'publish-reject',   outcome: 'success', actor, scope, metadata: { targetName: string, comment: string } }
{ action: 'publish-withdraw', outcome: 'success', actor, scope, metadata: { targetName: string } }
```

Failure outcomes (`forbidden`, `validation-failed`, `unauthenticated`) follow the standard audit shape from `design-audit.md` Q1.

### Capability additions
- `review:submit` — submit content for review
- `review:approve` — approve OR reject pending reviews
- `publish:request` — request a publish to a target
- `publish:approve` — approve a pending publish request
- ~~Optional `publish:{target}-emergency` for hotfix bypass~~ Out of v1 (2026-10-25; Future directions)

### Self-approval
- Configurable via `reviewWorkflow.allowSelfApproval: boolean` (default `true`)
- When self-approval allowed AND actor has both `review:submit` + `review:approve`, UI offers combined "Submit & approve" button
- When `allowSelfApproval: false`, approver who is also the submitter gets 403 at click-time
- Publish requests have their own target setting, `allowSelfPublishApproval` (default `true`; 2026-10-25, below)

### Re-review on save granularity
- Configurable: `reviewWorkflow.invalidateOnSave: 'content-diff' | 'always'`
- Default `'content-diff'` — only content-hash changes invalidate approval
- Strict `'always'` — every save invalidates (compliance-friendly)

### Storage shape (per-edge sidecars)
- `.gazetta/review/{kind}/{name}/state.json` — current review state + timestamps (comments live in the audit log — see "Audit event shape")
- `.gazetta/review/{kind}/{name}/approvers/{actor}` — zero-byte per-approver sidecar
- `.gazetta/publish-requests/{target}/{kind}/{name}/{request-id}.json` — publish request state, on the source the author publishes from (amended 2026-10-25, below)
- `.gazetta/publish-requests/{target}/{kind}/{name}/{request-id}/approvers/{actor}` — zero-byte per-approver sidecar
- `.gazetta/review/pending/{kind}/{encoded name}` and `.gazetta/publish-requests/{target}/pending/{encoded item}@{request-id}` — zero-byte pending markers the queues list; review markers use `encodeRefName(name)` under `{kind}/`, and publish markers use the asset-refs item encoding (`itemRefToFilename`: `pages.home`, `pages.home:fr` for a translation; `sidecars.md`) (2026-10-25, below)
- Per-edge granularity → multi-instance correct via the same pattern as asset-refs

### Publish-approval execution (locked 2026-10-04)

Locked before re-filing Cut 12 (#526), whose first spec left these open and named the wrong file. Cut 12 implements 1, 5, 6; Cut 13 implements 2, 3, 4.

1. **The gate lives at the start of the shared target-publish function** ([`design-publish-undo.md`](design-publish-undo.md) Q4), which wraps `publishRun` and also runs removals and undo, not in `admin-api/routes/publish.ts`. Cuts 12–13 wait for publish undo's cut 1, which builds that function, so the gate is built once, in its final place. Both the admin API and the CLI publish through this path; a route-level gate would let `gazetta publish` bypass approval. *(Amended 2026-10-22 so removals can't skip the gate: [`design-target-removal.md`](design-target-removal.md) Q13.)*
2. **Routes:** `POST /api/publish-requests/:target/:kind/:name/:requestId/{approve,reject,withdraw}` (item in the route: amended 2026-10-25, below) and `GET /api/publish-requests?target=`. Request *creation* is not a route: it is what the publish routes (`POST /api/publish`, `POST /api/publish/stream`) do for a gated target. Zod schemas per MCP discipline.
3. **A request snapshots content.** Each request records the item's manifest hash (the same `hashManifest` value publish already computes) at request time. The approval that reaches the threshold re-hashes the source, from the one snapshot the publish then uses ([`design-publish-undo.md`](design-publish-undo.md) Q4, #1527); on mismatch it refuses with `409 STALE_REQUEST` and the request must be withdrawn and re-made. Approving one version and shipping another is not possible. A removal request snapshots the item as absent on the source and its hash on the target; the approval re-checks both. A rollback request snapshots the target's history head and the revision to restore; the approval re-checks the head and refuses with `409 STALE_REQUEST` if it moved ([`design-target-removal.md`](design-target-removal.md) Q13). *(Amended 2026-10-23.)*
4. **The final approver's request executes it.** The approval that reaches `requiredPublishApprovers` runs the shared target-publish function for exactly the snapshotted item, removal or rollback and that one target. `publish:approve` is the only capability needed; approval is the gate. Audit records requester (`publish-request`) and each approver (`publish-approve`) separately.
5. **Mixed fan-out.** In one publish run, ungated targets publish immediately; each gated target gets one request per item in the caller-expanded list (`publishRun` treats `items` verbatim, so dependents expanded by the caller get their own requests) and one per removal. The per-target result reports `outcome: 'requested'` with the `requestId`s. Creating a request requires `publish:request` (403 otherwise). A removal request that relies on items of the same run runs only after their requests have run, and a rollback is one request ([`design-target-removal.md`](design-target-removal.md) Q13). *(Amended 2026-10-23: [`design-target-removal.md`](design-target-removal.md) Q13.)*
6. **CLI refuses gated targets.** `gazetta publish <gated-target>` exits non-zero with "`<target>` requires publish approval — request it from the admin." A CLI run has no `Principal` to record as requester, so it cannot create a request.

The amendments to locks 1, 3, 4 and 5 follow from [`design-target-removal.md`](design-target-removal.md) Q13 (#1120). Cuts 12–13 wait for publish undo's cut 1, which builds the shared function. Removal requests come with target removal cut 2 and rollback requests with publish undo cut 4; both wait for cuts 12–13 ([`design-target-removal.md`](design-target-removal.md) and [`design-publish-undo.md`](design-publish-undo.md), Cut sequence).

Decided: maintainer, 2026-10-22 (#1120)

| Rejected | Why |
|---|---|
| Build the gate in `publishRun` step 7 until publish undo's cut 1, then move it | The gate gets built twice, and cut 13's approval path would change in between |

**Rejected alternatives:** gating in the route (CLI bypass); re-reading content at approval time without a snapshot (approve-A-ship-B); executing under the requester's identity (the requester may since have lost the capability, and the approver is the accountable actor); a CLI `--request` flag (no principal to record).

### How the gate meets the shared publish function (locked 2026-10-25)

Settled when review-workflow moved to a planner issue (#1433), against the shared target-publish function publish undo cut 1 built (`publishToTarget`, `packages/gazetta/src/publish-target.ts`, #1430).

1. **The approval publishes.** Lock 4 stands: the approval that meets the threshold publishes. The publish panel's row for that request then reads "Published by {approver}" and has no **Publish** button (Surface 3, `DestApproved`).
2. **An approved publish passes the gate by its request.** The approval passes its request id to the shared function; the gate lets the publish through only if that request exists, has met its threshold and its snapshot still matches (lock 3). Nothing else skips the gate, except undoing the latest publish (below).
3. **The caller passes the user; the gate refuses none.** The shared function takes the signed-in user. The admin passes it; the CLI passes none, and the gate refuses a gated target without a user with lock 6's message. The gate is the one place that enforces this, so a later caller can't bypass it.
4. **One request per item string.** Lock 5's caller-expanded list is the function's `items` (dependents included): a page with its translations is one request, and a translation published alone (`pages/about:fr`) is its own request.
5. **The publish-pending queue is its own cut, after cut 13** (cut 21). Cut 17 covers pending reviews only, as locked in #1407.
6. **Out of v1:** the `publish:{target}-emergency` bypass capability, and queuing review actions offline for replay (Future directions). Review actions need the server, like publish.

Decided: maintainer, 2026-10-25 (#1434)

| Rejected | Why |
|---|---|
| Approval only approves; someone clicks **Publish** later | Two steps, and the content could change between them unless re-checked |
| A skip-gate flag for the approval path | Any caller could set it |
| The CLI checks for gated targets before calling the shared function | Two places to keep in step |
| One request per translation | Approvers would approve each language of a page separately |
| Fold the publish-pending queue into cut 17 | Cut 17 would wait for cuts 12–13 too |
| Leave the publish-pending queue out of v1 | Approvers would find publish requests only per content, in the publish panel |
| Build the emergency capability in v1 | A bypass weakens the gate; publish undo and self-approval cover the urgent cases |
| Build offline queue-and-replay for review actions in v1 | They check capabilities and snapshots on the server |

### Settled by the plan review (locked 2026-10-25)

A read-only review of the remaining cuts against the current code and the newer designs (public storage, publish undo, target removal, scale) found these open before cut-planner files cuts 12 onwards.

1. **Undoing the latest publish skips the gate.** On a target that requires publish approval, Undo after a publish runs at once, as [`design-publish-undo.md`](design-publish-undo.md) Q2 locks; it needs `restore:history` and the target's publish capability. `gazetta undo` on such a target is refused with lock 6's message. Rolling back further is a request (lock 3).
2. **Publish requests live on the source.** `.gazetta/publish-requests/{target}/{kind}/{name}/{request-id}.json` and its approvers, on the source the author publishes from, as [`design-public-storage.md`](design-public-storage.md) Q5 records them, so a public production target can require approval. The request records its source, so the approval re-hashes the right content. `publish-requests` joins the state folder registry (`state-folders.ts`) as not safe on public targets (cut 12).
3. **Requesting doesn't need the production capability.** On a target that requires publish approval, `POST /api/publish` (and `POST /api/publish/stream`, which the admin panel uses) doesn't refuse for a missing `publish:production`; the gate creates the request, which needs `publish:request` (lock 5). An author with only `publish:request` clicks **Publish** and sees "Approval requested". Creating a request is not a publish: it records `publish-request` (not `publish`) and fires the `beforePublishRequest`/`afterPublishRequest` hooks, not the publish ones ("Audit event shape", "Hook firings", lock 4); the publish events come when the approval publishes.
4. **The approval runs Publish's own steps.** The approval that meets the threshold runs the steps the publish routes (`POST /api/publish`, `POST /api/publish/stream`) run before the shared function, for exactly the requested item: `beforePublish` hooks, the validation gate and the publish audit event. It doesn't expand dependents again: they were expanded when the request was made and each has its own request (lock 5). They move into one helper both call, so a template changed since the request is still checked.
5. **A failed approved publish can be retried.** If the publish fails, the request stays `publish-approved` with the failure reason. Its row reads "Approved, publish failed: {reason}" with **Retry** (`publish:approve`), which re-checks the snapshot first. Two final approvals at the same moment on two instances can both publish the same content; that's accepted and documented.
6. **The snapshot covers every file the request publishes.** A request records one `hashManifest` per manifest it will copy (the page and each translation); any difference at approval answers `409 STALE_REQUEST`.
7. **Review doesn't block publishing.** With review on and publish approval off (archetype B), content that isn't approved still publishes; the publish panel marks those rows "Not approved" (cut 22). Only publish approval blocks.
8. **One review state per page.** A page and its translations are reviewed together, as `review/sidecars.ts` keys them today; a translation can't be submitted on its own in v1.
9. **Pending markers for the queues.** Submitting writes a zero-byte `.gazetta/review/pending/{kind}/{encoded name}` (`encodeRefName`), removed on approve, reject or withdraw (cut 7); creating a publish request writes `.gazetta/publish-requests/{target}/pending/{encoded item}@{request-id}`, removed when it publishes, is rejected or withdrawn (cut 12). Publish markers encode the item as the asset-refs sidecars do (`itemRefToFilename`: `pages.home`, `pages.home:fr` for a translation published alone; `sidecars.md`), so a nested page is one file and a translation's request keeps its language. Each queue is one directory listing, within the 5,000-page envelope.

Decided: maintainer, 2026-10-25 (#1434)

| Rejected | Why |
|---|---|
| Undo waits for approval like any publish | Reverses publish undo Q2: an emergency undo would wait for an approver |
| Requests on the target | Public targets, the default for cloud storage, could never require approval |
| Requesters need `publish:production` as well | Editors couldn't request a production publish; approval would only add a check for people who can already publish |
| Hooks and validation only when the request is made | A template or hook changed since the request would go unchecked |
| A failed publish closes the request | The author requests again and approvers approve again after an infrastructure failure |
| Snapshot the default manifest only | A translation edited after the request would publish without approval |
| Refuse to publish unapproved content when review is on | Archetype B would become a publish gate |
| Leave unapproved rows unmarked | Authors can't see that what they publish wasn't reviewed |
| One review state per translation | Changes the review storage, the save lock and cut 7's routes before cut 7 lands |
| Read every item's state for the queues, cached | Up to 5,000 reads on cloud storage, past the 5-second admin limit |

Two more, from Seer's review of the above:

10. **Self-approval of publish requests is set on the target.** `allowSelfPublishApproval` (default `true`) sits next to `requiresPublishApproval`. With `false`, a requester who also has `publish:approve` gets 403 on their own request ("You can't approve your own publish request"), and the "Publish-request & approve" button isn't offered. `reviewWorkflow.allowSelfApproval` governs content review only.
11. **The item is in the approval routes.** `POST /api/publish-requests/:target/:kind/:name/:requestId/{approve,reject,withdraw}` (lock 2, amended). Storage stays per item, so the publish panel finds an item's requests with one listing; the publish-pending queue (cut 21) lists the pending markers, which name the item.

Decided: maintainer, 2026-10-25 (#1434)

| Rejected | Why |
|---|---|
| Reuse `reviewWorkflow.allowSelfApproval` for publish requests | A site couldn't allow self-review while forbidding self-approved production publishes |
| Never allow self-approval of publish requests | A solo operator who turns the gate on can't publish |
| Store requests flat by id (`{target}/{request-id}.json`) | Finding an item's requests for the publish panel would need a second per-item marker |

Two more, from Seer's second review:

12. **A page's request waits for the fragments it relies on.** When one publish run requests a page and a fragment the page uses that isn't on the target yet, the page's request records the fragment's request. Approving the page's request first is refused: "@promo isn't on production yet: approve its request first." If the fragment's request is rejected or withdrawn, the page's request is withdrawn too, with the reason. This is the pattern [`design-target-removal.md`](design-target-removal.md) Q13 uses for removals. On a static target, where fragments are baked into pages, the page's request also waits for the requests of changed fragments it uses from the same run: "@header's change isn't approved yet." On ESI targets a changed fragment publishes separately, so only new ones matter.
13. **Editors can request.** The built-in editor role gains `publish:request`, so an editor clicking **Publish** to a gated target sees "Approval requested". Both publish routes (`POST /api/publish`, `POST /api/publish/stream`) check `publish:non-production` only for destinations that don't require approval and `publish:request` for those that do (cut 12, with `docs/auth.md`).

Decided: maintainer, 2026-10-25 (#1434)

| Rejected | Why |
|---|---|
| Publish in any order and document it | Production can serve a page without its new fragment until the fragment's request runs |
| On static targets, approving a page also approves the changed fragments baked into it | A fragment change whose own request is pending would reach production inside the page |
| One request per publish run on a gated target | Reverses lock 5: approvers could no longer approve items separately |
| Grant `publish:request` only through custom roles | Out of the box, nobody but an admin could request a publish to a gated target |

### Configuration
```ts
export default defineSite({
  // Content review: per content, on the source (or per editable target)
  reviewWorkflow: {
    enabled: true,
    requiredApprovers: 1,
    allowSelfApproval: true,
    invalidateOnSave: 'content-diff',
  },
  targets: {
    local: {
      storage: filesystemStorage({ path: './dist/local' }),
      editable: true,
    },
    production: {
      storage: r2Storage({ /* ... */ }),
      // Publish approval: per destination
      requiresPublishApproval: true,
      requiredPublishApprovers: 1,
      allowSelfPublishApproval: false,
    },
  },
})
```

Content review is per content, not per target (Locked decisions), so the policy that applies is the one for the editable target the author saves to, or the site-level block (`resolveSaveReviewPolicy`, `review/save-gate.ts`). Publish approval (`requiresPublishApproval`, `requiredPublishApprovers`, `allowSelfPublishApproval`) is set on the destination.

### Workflow archetypes (5 documented recipes)
- **A. Solo** — review off, publish gate off; one actor does everything
- **B. Small team — content focus** — review on, publish gate off; reviewer-as-approver
- **C. Small team — release focus** — review off, publish gate on (prod only)
- **D. Mid team — both** — review on + publish gate on (prod only); 3 distinct roles
- **E. Compliance** — review on with `requiredApprovers: 2`, `allowSelfApproval: false`, publish gate on with `requiredPublishApprovers: 2` and `allowSelfPublishApproval: false`

Each archetype gets a copy-paste-ready `site.config.ts` snippet + role mapping + capability mapping in the design doc.

### Capability scoping for advanced archetypes (deferred)
- **Level 2 (per-target capability scoping)** — `review:approve@{target}`, `publish:approve@{target}`. Future when multi-stage release demand (archetype H) surfaces.
- **Level 3 (per-dimension capability scoping)** — `review:approve@{template}`, `review:approve@{locale}`. Future for editorial (archetype F) + translation (archetype G) demand.
- v1 capability format is `name:action` (no scope); forward-compatible with future scoping syntax.

### Combined-action UX
- "Submit & approve" button when actor has both capabilities AND self-approval allowed AND `requiredApprovers: 1`
- "Publish-request & approve" button when actor has both AND the target's `allowSelfPublishApproval` AND `requiredPublishApprovers: 1`
- Audit records both events (submit + approve) with same timestamp + same actor

### Constructive errors
- `409 NO_APPROVER_AVAILABLE` at submit/publish-request time when no actor in configured roles has the required capability (deadlock prevention)
- 403 messages include suggested action ("Your role 'editor' doesn't have review:approve. Ask an admin to upgrade your role or contact a reviewer.")
- Site config validation at boot warns/errors on review-workflow-enabled-but-no-approvers misconfig

### Withdraw flow
- Author with active submission can withdraw → returns content to `draft`
- Audit records `action: 'review-withdraw'`
- Different from rejection (no comment required; submitter's own action)

### Concurrent approval race tolerance
- Per-approver sidecars (different paths) — no race on writes
- State-write check ("am I the Nth approver?") computes via `readDir` after writing per-approver sidecar; idempotent state writes (last-write-wins on `state: approved` is fine)
- No atomic-counter required

### Visibility filtering
- Review queue (`/api/reviews`) returns all pending items the user can READ (per coarse-grained discovery filter from `design-auth-rbac.md`)
- UI client-side filters to "actionable for you" by default; toggle for "all pending I can read"
- Approver visibility of OWN submissions: yes (need to see them to approve when self-approval allowed)
- The route is `GET /api/reviews?action=pending-review` (the one below; cut 17). Each item carries `canApprove`: the user has `review:approve`, hasn't already approved the item (the state machine refuses a second vote as `already-voted`), and the item isn't their own submission when `allowSelfApproval` is `false`. An item you've approved stays in "all pending I can read", where the banner says "You approved. Waiting for N more." The admin's "actionable for you" default filters on it. Read access stays the boundary, so the route returns nothing the user couldn't already read.

  Decided: maintainer, 2026-10-24 (#1407)

  | Rejected | Why |
  |---|---|
  | `GET /api/review/pending` | A second route for the same queue; `/api/reviews?action=` already covers pending reviews and pending publishes |
  | The server returns only items the user can approve | Drops the "all pending I can read" toggle, and filters nothing read access doesn't already |

### Pending review queue at scale
- `/api/reviews?target={target}&action={pending-review|publish-pending}&cursor={cursor}` lists the pending markers (one directory listing; 2026-10-25, above) with cursor pagination from `design-scale.md`
- AdminCache key includes filter params; per-instance cache via `MemoryCache`

### Configuration changes mid-flight
- `requiredApprovers` change 1→2 mid-flight: existing pending-review entries carry their original requiredApprovers value (snapshotted at submit time); new submissions use new value
- Disabling `reviewWorkflow.enabled` mid-flight: in-flight reviews resolved by direct publish OR admin manually closes them; audit records the config change

### Hook firings (touchpoints reserved for `design-hooks.md`)
- `beforeSubmitForReview`, `afterSubmitForReview`
- `beforeApprove`, `afterApprove`
- `beforeReject`, `afterReject`
- `beforePublishRequest`, `afterPublishRequest`
- `beforePublishApprove`, `afterPublishApprove`
- `beforePublish`, `afterPublish` (existing)
- Each hook receives `Principal` + content/publish-request scope

### Source-vs-target lifecycle
- Review state is on the source manifest; per-target deployment state is independent (existing publish sidecars per `design-publishing.md`)
- UI shows both: "Approved" + "Last published to: prod (3 hrs ago), staging (5 min ago)"
- No automatic reconciliation between source-state and target-state

### `gazetta dev` impersonation for testing
- New `trust: 'dev'` mode in `design-auth-rbac.md` (locked there)
- Dev-only URL parameters: `?as=alice@test.com&roles=editor,reviewer`
- Disabled in production (`NODE_ENV !== 'production'` enforced)

### Non-content writes
- Site config changes, template changes, asset uploads bypass review at v1
- Asset metadata edits (alt text, title) bypass review at v1
- Future asset review: when concrete editorial demand surfaces

### Re-publish of approved content
- Approved content can be re-published to a target without re-review (review is on content, not on each publish)
- If `requiresPublishApproval` is on: each publish event still requires its own publish approval

### Approval expiry (future)
- Per-target `requireFreshApproval: true` rejects publishes of approvals older than N hours; forces re-submit + re-approve specifically for that target
- v2 / Tier 3; not in v1

### Right-to-be-forgotten
- Review comments live in the audit log (locked invariant "Single reject action with mandatory comment"), not in review sidecars, which carry only approver IDs. When `gazetta audit scrub --actor=alice@example.com` ships (not implemented yet), it must cover both: rewrite `actor.id` and `metadata.comment` on every `review-*` event the actor authored, and remove each `.gazetta/review/{kind}/{name}/approvers/{alice}` zero-byte file so the actor's prior votes don't surface.
- Free-text comments mentioning OTHER actors are NOT auto-scrubbed (documented limitation)

## Foundational checks

How review workflow composes with each of the other 12 foundational dimensions plus the multi-instance discipline.

### Multi-instance discipline
- Per-edge sidecars (per-approver files at distinct paths) — concurrent approvals don't race; same pattern as asset-refs.
- State transitions write the per-approver sidecar AND the state file in one logical transaction; readers compute "is threshold met?" from `readDir` of the approvers directory. Last-write-wins on `state: approved` is idempotent (same target state regardless of which instance wrote it last).
- Snapshot of `requiredApprovers` lives in the state file at submit time; no runtime config-coordination across instances.
- Pending review queue (`/api/reviews`) reads from storage on demand per request — no shared in-memory queue.

### Scale (#1)
- Review queues list the pending markers (one directory listing) with cursor pagination per `design-scale.md`.
- Per-content review state lookup is O(1) (`.gazetta/review/{kind}/{name}/state.json` is one file).
- Approver count check is O(N-approvers) via `readDir` (typically 1-3 approvers, never large).
- AdminCache key includes filter params; per-instance cache via `MemoryCache`.

### Locale (#2)
- One review state per page or fragment, covering all its translations (2026-10-25, above): a translation can't be submitted on its own in v1.
- Per-translation review is reserved for the per-field translation work.
- RTL admin: review drawer / publish-request modal inherit document `dir` from the active locale; CSS logical properties handle the flip.

### Themes (#3)
- Theme variants don't yet exist for pages/fragments (per `design-themes.md` v1 — presentation-only). When pages gain theme variants, theme-variant manifests are reviewed independently per the locale pattern above.

### Auth + RBAC (#4)
- Capability extensions: `review:submit`, `review:approve`, `publish:request`, `publish:approve`.
- `Principal` from auth/RBAC is the actor on every review/publish-approval audit event.
- Self-approval enforced at click-time via principal-vs-submission-actor comparison. `allowSelfApproval: false` with same actor = 403.
- Capabilities snapshot at submit time captured in audit metadata; live-evaluated at approval time.

### Audit (#5)
- Every state transition emits an audit event per the shape above.
- `action` enum extends with 8 new values (4 content-review + 4 publish-approval).
- Forensic queries answer "who approved what when, with which role at the time" via the existing `actor` snapshot from `design-audit.md` Q2.

### Hooks (#7)
- State-transition hooks (10 touchpoints listed in original stub: `beforeSubmitForReview`, `afterSubmitForReview`, `beforeApprove`, `afterApprove`, `beforeReject`, `afterReject`, `beforePublishRequest`, `afterPublishRequest`, `beforePublishApprove`, `afterPublishApprove`).
- Hook payloads carry `Principal` + content/publish-request scope.
- `before*` hooks can fail/cancel transitions; `after*` are observational.

### Render (#8)
- Review state doesn't affect render output directly. Content publishes whatever its review state; the publish panel marks rows that aren't approved, and only publish approval blocks (2026-10-25, above).
- Render-time SSR with `Principal`: a future "show this only to approvers" template hint isn't in v1 review-workflow scope (would belong to RBAC capability checks at render time).

### Validation (#9)
- Save-delta validation runs on every save that reaches it; pre-publish validation runs on publish (gated by publish approval when enabled). The review-state check runs first in the save pipeline (step 2 of `manifest-save.ts`, before validators at step 3), so a save of a `pending-review` item stops with `409 EDIT_LOCKED` and never reaches the validators.
- A "ready for review" transition can require zero open errors on the item — composition with validation, not v1.
- A locked save never reaches `validation-failed`: `EDIT_LOCKED` is returned before validators run, and review state is unchanged because the save was rejected. In `draft` and `approved` states, validator failures return 409 + `validation-failed` as usual, and an `approved` item stays approved because nothing was written.

### Plugin (#10)
- Future plugin-supplied review providers (e.g., GitHub PR-as-review) reserved per stub. v1 uses hooks for external integration; provider surface deferred until concrete demand.
- Plugin-contributed admin routes that mutate review state declare their required capabilities via the same Hono middleware contract.

### Cache (#11)
- Review queue results cached per-request by filter params; per-instance `MemoryCache`.
- Cache invalidated on every review-state-changing audit event (existing SSE invalidation infrastructure).
- Capability-scoped: cache entries scoped to role principal at cache time; role change invalidates.

### Offline (#12)
- Review actions need the server in v1; queuing them offline for replay is out of v1 (2026-10-25; Future directions).

### Collaboration (#13)
- Reject comment lives in audit metadata as a narrow capture; broader review discussion (inline comments, mentions to reviewers, "request changes" semantics) belongs to collaboration.
- When collaboration ships, approver behavior expands: "leave non-blocking comments on content + approve" or "reject with reason" (current path).
- Combined-action ("Submit & approve") UX stays as-is; collaboration adds the conversation layer alongside, not replacing the state machine.

## UX implementation foundation (Storybook + primitives)

Decided 2026-06-07 during the UX-grilling pass (Phase 2a, which the original design pass skipped — that's why cuts 8–10 were High-risk). Per [ADR-0016](../../docs/adr/0016-storybook-for-bot-executable-ux-specs.md), the review-workflow UI components are designed as **Storybook stories** that become feature-bot's executable spec. Two additive UI primitives are extracted first so the review components compose named, typed building blocks rather than re-deriving banner/badge markup from prose (verified extraction-cheap + additive against the shipped admin in a recon pass):

- **`<StateBadge variant color label? tooltip?>`** — extracts the dot/pill pattern duplicated verbatim across `SiteTree.vue` + `ComponentTree.vue` (dirty dot, validation dot, locale pill). **Cheap, pure-CSS DRY.** The review-state SiteTree badge (Cut 8) consumes it.
- **`<Banner severity role icon? :dismissible>` + content/actions slots** — extracts the icon+message+actions+dismiss skeleton shared by `ValidationBanner` / `ArchiveBanner` / `OfflineBanner` / `StorageQuotaBanner`. **Moderate, ~30–40 LOC, strictly additive** — the four shipped banners are **not** refactored onto it (recon confirmed migration is non-mandatory; ValidationBanner's nested issue-list resists generic slots, so leaving it inline is correct). ReviewBanner (Cut 8) is the first consumer.

**No `<ActionButton>` primitive.** PrimeVue `<Button>` is already the de-facto action-button primitive — conventions (label/icon/`size="small"`/severity/`:loading`/`data-testid`) are uniform across the admin. The review components use `<Button>` directly; stories cite its conventions.

This is *not* the design-system work deferred by [`css-theming.md`](css-theming.md): no token taxonomy, no primitive library, no refactor of shipped components. Two additive primitives, scoped to what review-workflow needs, justified by *bot-codegen reliability* (a different rationale than the visual-regression rationale that deferral addressed).

**Consequence for the cut sequence:** three foundational UI cuts prepend the feature UX cuts —

1. **Extract `<StateBadge>` + its `.stories.ts`** (cheap; additive; SiteTree/ComponentTree may opt in via Boy-Scout later, not required)
2. **Extract `<Banner>` + its `.stories.ts`** (moderate; additive; shipped banners untouched; follow `ArchiveBanner.stories.ts`)
3. **Wire the story runner (`@storybook/addon-vitest`) into CI** so `.stories.ts` execute green rather than being view-only — the gate that makes "build component to green stories" machine-enforceable.

Each UX cut then **transcribes its slice of the locked design-doc state table** (see "UX surface decisions" below) into `.stories.ts` *and* implements the component, with the story running green. There is no separate human story-authoring cut: per [ADR-0016](../../docs/adr/0016-storybook-for-bot-executable-ux-specs.md) (second revision), the human spec is the design-doc state table (UX-grill output); the bot transcribes it. Storybook itself already ships (`@storybook/vue3-vite` + `ArchiveBanner.stories.ts` precedent) — the only added infra is the story runner.

### UX surface decisions (UX-grill 2026-06-07)

Three surfaces were grilled into locked story specs. Each named story = one Storybook story = one bot spec variant.

**Surface 1 — `ReviewBanner.vue`** (= `<Banner>` + inline `<Button>` actions; mounts above the editor à la `ArchiveBanner`; renders only when content review is on for the active target (its `reviewWorkflow` block, or the site's: `resolveSaveReviewPolicy`) — absence-as-state otherwise). **`ReviewActions` is folded in** — no separate component. The design doc's earlier two-component naming was unjustified enumeration (rule 25); every POV (discoverability, SRP, bot-risk, Krug) favored fusion, matching the `ArchiveBanner` precedent where the banner hosts its own actions. The 10 stories below *are* the action spec (each names its buttons); a separate `ReviewActions.vue` would only add a coordination bug class (banner/actions out of sync) that fusion eliminates by construction.

Root testid `review-banner` with `data-state` (the `OfflineBanner` pattern). The 10 stories enumerate content-state × actor-capability × config; **draft has two visible variants** — clean (fresh/withdrawn, no message) vs. with-note (rejected or auto-invalidated, shows the reason). The rejected variant is load-bearing: without it the author never sees *why* content bounced (the hole the first-draft matrix missed).

| Story | Content state | Viewer | Severity / copy | Buttons (testid) |
|---|---|---|---|---|
| `DraftClean` | draft (fresh/withdrawn) | has `review:submit` | info — "Draft — not yet submitted for review." | **Submit for review** (`review-submit`); + **Submit & approve** (`review-submit-approve`) when also `review:approve` + `allowSelfApproval` + `requiredApprovers:1` |
| `DraftRejected` | draft (post-reject) | has `review:submit` | warning — "Changes requested by {actor}: '{comment}'." | **Submit for review** (`review-submit`) |
| `DraftInvalidated` | draft (was approved, edited) | has `review:submit` | info — "Approval cleared by your edit. Re-submit when ready." | **Submit for review** (`review-submit`) |
| `DraftNoCap` | draft | lacks `review:submit` | info — "Draft. You don't have permission to submit for review." | none |
| `PendingAsSubmitter` | pending-review | submitter | warning — "Pending review — submitted {time}. Editing is locked until reviewed." | **Withdraw** (`review-withdraw`) |
| `PendingAsApprover` | pending-review | has `review:approve`, not voted | warning — "Pending review — {N} of {required} approvals." | **Approve** (`review-approve`), **Reject** (`review-reject` → `ReviewRejectDialog`) |
| `PendingApproverVoted` | pending-review | has `review:approve`, voted, threshold unmet | warning — "You approved. Waiting for {remaining} more." | none (no retraction — see below) |
| `PendingSelfNoSelfApproval` | pending-review | submitter w/ `review:approve`, `allowSelfApproval:false` | warning — "Your submission — you can't approve your own content." | **Withdraw** (`review-withdraw`) |
| `PendingReadOnly` | pending-review | no review caps | warning — "Pending review — {N} of {required} approvals." | none |
| `Approved` | approved | any | success — "Approved {time} by {actor}." | none (publish is a separate surface) |

Each action button has an in-flight `:loading` variant (the `archive.status === 'unarchiving'` pattern) — stories include the loading state for `PendingAsApprover` (approving / rejecting) and `DraftClean` (submitting).

**`ReviewRejectDialog.vue`** (small companion) — a PrimeVue `Dialog` with a required textarea + **Reject** (`review-reject-confirm`) / **Cancel** (`review-reject-cancel`). Reject comment is mandatory (locked invariant); a dialog (not inline-expand) matches how the codebase does confirmable actions and keeps the banner clean.

**Q-A — no approval retraction in v1.** Once cast, an approval is final while `pending-review`. The audit enum has no `review-unapprove`; adding one is scope creep. An approver who changes their mind rejects instead (reject-after-own-approve is the escape hatch). `PendingApproverVoted` therefore shows no action.

**Q-B — no "reopen to draft" button on `Approved`.** Editing approved content auto-invalidates it back to draft via `invalidateOnSave` (default `content-diff`). An explicit reopen button is redundant — the author just edits, and the save knocks it to `DraftInvalidated`. The banner stays purely informational when approved.

**Surface 2 — folded into Surface 1** (see above).

**Surface 3 — publish-approval gate = extend `PublishPanel` destination rows** (only when a target has `requiresPublishApproval: true`). Per-content gate, composed into the shipped `PublishPanel` (not a new top-level surface). The walk revealed this is distinct from the cross-content "what's waiting for me" approver queue — that queue is its own concern (the existing `### Pending review queue at scale` + `/api/reviews?action=publish-pending`), serving *both* content-review and publish-approval pending lists, and lands as its own cut. Stories = `PublishPanel` destination row in each publish-approval state:

| Story | Destination-row state | Shows |
|---|---|---|
| `DestNoGate` | target without `requiresPublishApproval` | normal **Publish** |
| `DestRequestable` | gated, viewer has `publish:request`, no open request | normal **Publish** (`publish-request` on the row); its result reads "Approval requested" and the row becomes `DestPending` (2026-10-25 items 3, 13) |
| `DestPending` | gated, request open, threshold unmet | `<StateBadge>` "Pending {N}/{required}"; **Approve**/**Reject** (`publish-approve`/`publish-reject`) inline when viewer has `publish:approve`; approving a page that waits for a fragment's request shows "@promo isn't on production yet: approve its request first" (2026-10-25 item 12) |
| `DestFailed` | gated, threshold met, the publish failed | `<StateBadge>` "Approved, publish failed: {reason}"; **Retry** (`publish-retry`) when viewer has `publish:approve` (2026-10-25 item 5) |
| `DestApproved` | gated, threshold met (the approval published) | `<StateBadge>` "Published by {approver}"; no **Publish** button (2026-10-25) |
| `DestNoCap` | gated, viewer lacks `publish:request` | `<StateBadge>` "Requires publish approval" (informational) |

The cross-content approver queues (cuts 17 and 21) are **not** part of the gate cut — approvers acting on *this* content's publish do so inline in `PublishPanel`; finding pending requests *across all content* is the queue's job.

## Cut sequence

Reshaped from the retired impl doc's 15-cut sequence during the migration to the tracking-issue + cut-sub-issue model (2026-06-07), integrating the UX-grilling decisions. Three changes from the original 15: (1) two additive UI-primitive cuts (`<StateBadge>`, `<Banner>`, each with its `.stories.ts`) prepend the UX work; (2) one cut wires the story runner (`@storybook/addon-vitest`) into CI so stories execute green — the gate every UX cut relies on; per [ADR-0016](../../docs/adr/0016-storybook-for-bot-executable-ux-specs.md) (second revision) there is **no** separate human story-authoring cut — the human spec is the locked state table in this doc, which the bot transcribes into `.stories.ts` within each UX cut; (3) UX cuts reshaped per the locked story specs (ReviewActions folded into ReviewBanner; publish-gate as PublishPanel destination rows). 22 cuts total, all bot work.

State lives in GitHub sub-issue close-state; this table is intent only (no status column). `agent` = feature-bot; `human` = maintainer-authored (story authoring is design, not bot work).

| # | Cut | Depends on | By | Test tier | Risk |
|---|---|---|---|---|---|
| 1 | `reviewWorkflow` config schema (Zod) on target + site; archetype A–E examples | — | agent | unit-first | Low |
| 2 | Capability vocab (`review:submit`/`approve`, `publish:request`/`approve`) wired into RBAC | — | agent | unit-first | Low |
| 3 | Per-edge sidecar storage (`.gazetta/review/{kind}/{name}/state.json` + per-approver) | 1 | agent | unit-first | Medium |
| 4 | Review state machine (`draft → pending-review → approved`, explicit-action invariant) | 2, 3 | agent | unit-first | High |
| 5 | Save-handler integration (`pending-review` 409s edits; `invalidateOnSave` policies) | 4 | agent | api-first | Medium |
| 6 | Audit integration (4 content-review actions + outcomes) | 4 | agent | api-first | Low |
| 7 | Admin API routes (`submit`/`approve`/`reject`/`withdraw` + `GET`); pending markers (2026-10-25 item 9) | 4, 5, 6 | agent | api-first | Medium |
| 8 | **Extract `<StateBadge>` primitive + its `.stories.ts`** (additive; SiteTree/ComponentTree may opt in via Boy-Scout later) | 10 | agent | component | Low |
| 9 | **Extract `<Banner>` primitive + its `.stories.ts`** (additive; 4 shipped banners untouched; follow `ArchiveBanner.stories.ts`) | 10 | agent | component | Medium |
| 10 | **Wire the story runner (`@storybook/addon-vitest`) into CI** so `.stories.ts` execute green (not view-only) — the gate every UX cut relies on | — | agent | api-first | Low |
| 11 | ReviewBanner.vue (= `<Banner>` + `<Button>`s; ReviewActions folded in) + ReviewRejectDialog + SiteTree state badge + **their `.stories.ts` (transcribed from the design-doc state table) running green** | 7, 8, 9, 10, 20 | agent | component | High |
| 12 | Publish-request state machine + per-edge request/approver sidecars + the gate at the start of the shared target-publish function (creates requests for `requiresPublishApproval` targets; CLI refuses; removal requests come with target removal cut 2, rollback requests with publish undo cut 4) — locks 1, 5, 6; requests on the source, the production check giving way to the gate, per-file snapshot, pending markers, requests that wait for their fragments, `publish:request` on the editor role, the `publish-request` audit action (2026-10-25 items 2, 3, 6, 9, 12, 13) | 4, publish undo cut 1 | agent | api-first | High |
| 13 | Publish-approval admin API (`approve`/`reject`/`withdraw` + `GET`), snapshot check (`409 STALE_REQUEST`), execution on the threshold approval with Publish's own steps, Retry after a failed publish, the `publish-approve`/`publish-reject`/`publish-withdraw` audit actions — locks 2, 3, 4; 2026-10-25 items 4, 5 | 12, publish undo cut 7 | agent | api-first | High |
| 14 | Publish-approval gate UX — PublishPanel destination rows + **their `.stories.ts` (6 states from the design-doc table) running green** | 8, 10, 13, 20 | agent | component | High |
| 15 | Combined "Submit & approve" + "Publish-request & approve" buttons | 11, 14 | agent | component | Low |
| 16 | Constructive errors (`409 NO_APPROVER_AVAILABLE`; boot config validation; helpful 403s) | 7, 13 | agent | api-first | Low |
| 17 | Pending review queue (cross-content "what's waiting for me"; `GET /api/reviews?action=pending-review`; paginated) | 7 | agent | api+component | Medium |
| 18 | Hook integration (10 review-lifecycle phases per `design-hooks.md`) | 7, 13 | agent | api-first | Medium |
| 19 | Docs (`docs/review-workflow.md` 5 archetypes) + consolidation (retire impl doc → this design doc; ROADMAP; CLAUDE.md) | all | agent | (docs) | Low |
| 20 | **Agent B visual self-check + PR screenshot embed** — `bots/_lib` screenshot helper (Playwright, reuse `tools/mcp-dev` logic) + Storybook built and served from bot code (`bots/_lib/storybook-server.ts`; no workflow edit, since bots can't push `.github/workflows/**`, #840) + reviewer-prompt contract (screenshot each new/changed story → visual verdict vs design-doc state table → factor into APPROVE/REJECT) + **upload screenshots as Release assets (`gh release upload`, tag `bot-screenshots`), embed inline via the public `…/releases/download/…` URLs, and prune merged/closed PRs' assets at the start of each feature-bot run (best-effort; PR opens without images on failure)** | 10 | agent | (bot infra) | Medium |
| 21 | Publish-pending queue (`GET /api/reviews?action=publish-pending`; paginated, same shape as cut 17) | 13, 17 | agent | api+component | Medium |
| 22 | Publish panel marks rows that aren't approved ("Not approved") when review is on (2026-10-25 item 7) | 7 | agent | component | Low |

**Notes on the reshape:**
- **No separate human story-authoring cut.** Per [ADR-0016](../../docs/adr/0016-storybook-for-bot-executable-ux-specs.md) (second revision), the human spec is the locked state table in this design doc (UX-grill output); the bot **transcribes** it into `.stories.ts` *within* each component cut and implements the component to it. The story runs green under `@storybook/addon-vitest`. The independent spec is the design-doc table + each cut's `## Acceptance`, not a hand-authored story file — bounded tautology risk, accepted because the tables are locked first.
- **Cut 10 is the story-runner CI wiring** (`@storybook/addon-vitest`) — repurposed from the now-removed human story-authoring cut. No-dep; the gate that makes "stories run green" real. Every UX cut (8, 9, 11, 14) depends on it.
- Cuts 8, 9 (primitives + their stories) depend only on the story-runner (10); they otherwise run in parallel with the data-shape cuts 1–7.
- Cut 11 folds `ReviewActions.vue` into `ReviewBanner.vue` (the 10 stories encode all button logic) and adds the SiteTree badge via `<StateBadge>`; it authors `ReviewBanner.stories.ts` + `ReviewRejectDialog.stories.ts` from the design-doc state table.
- Cut 14 is PublishPanel destination-row states (6 stories), not a new surface.
- Cut 18 depends on 7 and 13 because the review hooks fire in cut 7's review routes and cut 13's approval routes. Cut 21 depends on 17 as well as 13 because it extends cut 17's `/api/reviews?action=` route with `publish-pending`.
- Cut 17 is the cross-content queue — distinct from cut 14's per-content gate (the UX-grill walk surfaced this split).
- Cut 20 adds **Agent B visual self-check + PR screenshot embed** (per [ADR-0016](../../docs/adr/0016-storybook-for-bot-executable-ux-specs.md) "validation stack" + "Screenshots embedded in the PR"): the reviewer screenshots each new/changed story, judges it against the design-doc state table (factoring into APPROVE/REJECT), **and embeds those screenshots in the PR body so the human reviewer sees rendered states inline.** The self-check catches *gross* visual failures (invisible element, overflow, collapsed layout) — advisory bot-loop, **not** a CI gate and **not** pixel-regression (LLM-judges-prose, no baseline; the real visual gate stays human PR review). The PR embed **uploads the screenshots as GitHub Release assets** (`gh release upload`, rolling `bot-screenshots` tag) and embeds them inline via the public `…/releases/download/…` URLs (per [ADR-0016](../../docs/adr/0016-storybook-for-bot-executable-ux-specs.md): token-only, official API, public-served raw bytes that render inline). **The bytes never touch `main`** — which is *why* this beats the feature-branch-commit option (whose commits would merge into `main`'s history under squash/rebase/merge even though the branch is deleted). **Cleanup by reconciliation:** each feature-bot run starts by deleting the assets of cuts whose PR is merged or closed (`gh release delete-asset`); a PR-close trigger would need a workflow file bots can't push (#840), so closed PRs' screenshots linger up to a week. Best-effort with a mandatory fallback: on upload failure the PR opens without images + a note, never blocked; a cleanup failure never blocks the merge. UX cuts 11 + 14 depend on it. Depends only on Cut 10 (needs `build-storybook` working). Revised 2026-10-18: everything runs from bot code, no workflow edit (#535).
- Cut 19 absorbs the old Cut 15 docs + the consolidation work (retiring the impl doc per [ADR-0015](../../docs/adr/0015-impl-doc-artifact-retires.md)).

## Migration

Targets without `reviewWorkflow.enabled` continue today's behavior (no review). Adding the flag opts in. Existing items become `draft` by default; items already published stay `published`.

## Future directions

- **Level 2 capability scoping** (per-target) — multi-stage release approval
- **Level 3 capability scoping** (per-dimension) — per-locale, per-template, per-content-type reviewers
- **Plugin-supplied review providers** — external review systems (GitHub PR-as-review). v1 uses hooks for external integration; provider surface deferred until concrete demand.
- **Approval expiry** (`requireFreshApproval` per target)
- **Notification preferences** — subscribe to review activity; lands when hooks ship
- **Multi-stage release pipelines** — QA → prod with distinct approvers per stage
- **Emergency publish capability** (`publish:{target}-emergency`) to bypass approval for a hotfix. Out of v1 (2026-10-25)
- **Offline review actions**: queue submit / approve / reject offline and replay on reconnect, re-checking capabilities and snapshots at replay. Out of v1 (2026-10-25)
