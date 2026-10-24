---
paths:
  - "packages/gazetta/src/review/**"
  - "packages/gazetta/src/admin-api/routes/review.ts"
  - "packages/gazetta/src/admin-api/routes/pages.ts"
  - "packages/gazetta/src/admin-api/routes/fragments.ts"
  - "packages/gazetta/src/admin-api/routes/publish.ts"
  - "apps/admin/src/client/components/ReviewBanner.vue"
  - "apps/admin/src/client/stores/review.ts"
---

# Review Workflow — Implementation

Companion to [design-review-workflow.md](design-review-workflow.md). Cut sequence with risk ordering.

See [design-review-workflow.md](design-review-workflow.md) for the design itself.

## Status

The design pass is complete. Implementation depends on three Phase 1 foundations:

1. **AuthIdentity layer** (per `design-auth-rbac-implementation.md`) — `Principal` extraction; capability checks
2. **Audit primitive** (per `design-audit-implementation.md`) — `recordEvent()` for review transitions
3. **Hooks lifecycle** (per `design-hooks-implementation.md`) — review-state-transition hooks reserve their phases

This implementation pass runs in Phase 2 of ROADMAP per the dependency chain. The cuts below assume those foundations have shipped.

## Cut sequence

**Status legend**: ✓ shipped · ◐ in progress · ☐ pending

Branch: `review-workflow-v1` off `main`. **No backwards compatibility** — existing sites without `reviewWorkflow` config continue to work unchanged (the dimension is opt-in per the locked invariant).

Sequenced data-shape-first (state machine + storage + capabilities), then admin-API contracts, then UX surfaces. Per-target publish approval lands as a separate cluster after content-review is end-to-end.

| # | Cut | Status | Risk | Validates |
|---|---|---|---|---|
| 1 | `reviewWorkflow` config schema (Zod) on target + site config; archetype A-E examples | ☐ | Low | Config contract |
| 2 | Capability vocabulary additions (`review:submit`, `review:approve`, `publish:request`, `publish:approve`) wired into RBAC | ☐ | Low | Capability layer |
| 3 | Per-edge sidecar storage shape: `.gazetta/review/{kind}/{name}/state.json` + per-approver sidecars | ☐ | Medium | Storage primitive |
| 4 | Review state machine: `draft → pending-review → approved` with explicit-action invariant | ☐ | High | The core engine |
| 5 | Save handler integration: `pending-review` rejects edits with 409; `invalidateOnSave` policies | ☐ | Medium | Edit-during-pending lock |
| 6 | Audit event integration: 4 content-review action types + outcomes | ☐ | Low | Audit contract |
| 7 | Admin API routes: `POST /api/review/{kind}/{name}/submit\|approve\|reject\|withdraw` | ☐ | Medium | Server contract |
| 8 | Admin UX: ReviewBanner.vue + ReviewActions.vue + state badges in site tree | ☐ | High | The visible surface |
| 9 | Publish-approval state machine + per-target opt-in (`requiresPublishApproval`) | ☐ | High | Per-target gate |
| 10 | Per-target publish approval admin API + UX (publish dialog gates on approval) | ☐ | High | Per-target visible surface |
| 11 | Combined "Submit & approve" + "Publish-request & approve" buttons | ☐ | Low | Self-approval UX |
| 12 | Constructive errors (`409 NO_APPROVER_AVAILABLE`, 403 with suggested action, config validation at boot) | ☐ | Low | Operator UX |
| 13 | Pending review queue at scale (admin UX surface for reviewers — list of pending submissions) | ☐ | Medium | Reviewer workflow |
| 14 | Hook integration (10 review-lifecycle hook phases per `design-hooks.md`) | ☐ | Medium | Plugin extension surface |
| 15 | Docs (`docs/review-workflow.md` operator guide with 5 archetype recipes) + ROADMAP + CLAUDE.md | ☐ | Low | User-facing |

## Per-cut scope

### Cut 1: Config schema

**Files modified:**
- `packages/gazetta/src/config/schemas.ts` — add `reviewWorkflowSchema`:
  ```ts
  z.object({
    enabled: z.boolean().default(false),
    requiredApprovers: z.number().int().positive().default(1),
    allowSelfApproval: z.boolean().default(true),
    invalidateOnSave: z.enum(['content-diff', 'always']).default('content-diff'),
  })
  ```
- `targetSchema` extends with `reviewWorkflow?: ReviewWorkflowConfig` and `requiresPublishApproval?: boolean`, `requiredPublishApprovers?: number`
- `siteSchema` extends with site-level `reviewWorkflow?` (target inherits from site if not set)
- `packages/gazetta/src/types.ts` — `ReviewWorkflowConfig` interface; `TargetConfig` extensions

**Tests:**
- Schema accepts archetype A-E configurations from the design doc
- Invalid combinations rejected: `requiredApprovers: 0`, `invalidateOnSave: 'unknown'`, `enabled: true` without `requiredApprovers`
- Site → target inheritance: target without `reviewWorkflow` inherits from site

**Risk:** low. Pure schema work; no runtime behavior yet.

### Cut 2: Capability vocabulary

**Files modified:**
- Auth-rbac capability registry — add four new reserved capabilities under `review:` and `publish:` prefixes
- Default role definitions — `editor` gets `review:submit`; `reviewer` gets `review:approve`; `publisher` gets `publish:request` + `publish:approve`
- `packages/gazetta/src/auth/capabilities.ts` (or wherever the registry lives) — add to `KNOWN_CAPABILITIES`

**Tests:**
- Default roles have expected capabilities
- Unknown capability `review:foo` rejected at config load
- Capability check `principal.has('review:submit')` works against role mappings

**Risk:** low. Purely additive to the RBAC vocabulary; doesn't change existing checks.

### Cut 3: Per-edge sidecar storage

**Files added:**
- `packages/gazetta/src/review/sidecars.ts` — read/write helpers for `.gazetta/review/{kind}/{name}/state.json` + `approvers/{actor-id}` zero-byte sidecars
- Per-edge granularity matches the existing `dep-sidecars.ts` pattern (asset-refs, fragment-deps); reuse the abstraction where possible

**Files modified:**
- `packages/gazetta/src/types.ts` — `ReviewState = 'draft' | 'pending-review' | 'approved'` + `ReviewSidecar` interface (state, timestamps, requiredApprovers snapshot, comments per approver)

**Tests:**
- Write state, read it back; idempotent
- Per-approver sidecar — write `approvers/alice`, `approvers/bob` independently → no race
- Multi-instance correctness: two instances writing to different `approvers/` paths don't conflict (verified via two-process test)

**Risk:** medium. Sidecar pattern is well-understood; per-edge granularity is the locked invariant. Tests guard the multi-instance path.

### Cut 4: State machine

**Files added:**
- `packages/gazetta/src/review/state-machine.ts` — `transition(currentState, action, principal, config) → newState | error`
- Transition rules (per design):
  - `draft → pending-review`: `submit` action; principal needs `review:submit`
  - `pending-review → approved`: `approve` action; per-approver sidecar; once N approvers reach `requiredApprovers`, state flips
  - `pending-review → draft`: `reject` (with mandatory comment) OR `withdraw` (submitter's own action)
  - `approved → pending-review`: re-submit after `invalidateOnSave` triggered
  - `approved → draft`: only when content invalidates AND `invalidateOnSave: 'always'`

**Tests:**
- Each transition with valid principal succeeds
- Invalid transition rejected (e.g., `approved → pending-review` directly without an invalidating save)
- `requiredApprovers: 2`: first approve doesn't flip state; second approve flips
- `allowSelfApproval: false`: submitter trying to approve their own → 403
- `invalidateOnSave` policies tested with real content-diff cases

**Risk:** high. Wrong transition = state corruption (approved content slips through review; or pending content can't be approved). Heavy on property tests + concrete scenario tests.

**SOLID:** SRP — `transition` is a pure function over state; doesn't read sidecars or write audit (callers do that). FSM logic separated from I/O.

### Cut 5: Save handler integration

**Files modified:**
- `packages/gazetta/src/admin-api/routes/pages.ts` (PUT handler) — when current state is `pending-review`, return `409 EDIT_LOCKED`; suggest "Withdraw submission to edit"
- Save success path — if `invalidateOnSave` policy triggers, transition state via state-machine
- `fragments.ts` — same shape

**Tests:**
- Save during `pending-review` → 409 with helpful message
- Save during `approved` with `invalidateOnSave: 'content-diff'` and changed content → state goes to `draft`
- Save during `approved` with `invalidateOnSave: 'always'` and any save → `draft`
- Save with no review-workflow enabled → unchanged behavior

**Risk:** medium. Wrong gating = either author locked out unexpectedly (UX bug) or pending-review edits silently apply (correctness bug).

### Cut 6: Audit integration

**Files modified:**
- `packages/gazetta/src/audit/types.ts` — extend `action` enum with the 4 content-review actions per design
- Review state-machine call sites — emit audit events on every transition

**Tests:**
- Submit emits `review-submit` event
- Approve emits `review-approve` event with optional comment
- Reject emits `review-reject` event with mandatory comment
- Failed transition (forbidden) → `outcome: 'forbidden'` audit
- Audit query for `actor: alice, action: review-*` returns alice's review activity

**Risk:** low. Audit shape is locked; this cut wires the call sites.

### Cut 7: Admin API routes

**Files added:**
- `packages/gazetta/src/admin-api/routes/review.ts`:
  - `POST /api/review/:kind/:name/submit` (body: optional comment)
  - `POST /api/review/:kind/:name/approve` (body: optional comment)
  - `POST /api/review/:kind/:name/reject` (body: required comment)
  - `POST /api/review/:kind/:name/withdraw`
  - `GET /api/review/:kind/:name` — current state + per-approver list + history
- `packages/gazetta/src/admin-api/schemas/review.ts` — Zod schemas (per MCP discipline)

**Tests:**
- Each endpoint round-trips: submit → approve → state changes
- Capability gates (403 without `review:submit` etc.)
- Validation errors: reject without comment → 400; submit on already-pending → 409

**Risk:** medium. Wire contract is the load-bearing seam for UX cuts.

### Cut 8: Admin UX — review surfaces

**Files added:**
- `apps/admin/src/client/components/ReviewBanner.vue` — top of editor; shows current state + actions per principal's capabilities
- `apps/admin/src/client/components/ReviewActions.vue` — buttons (Submit, Approve, Reject, Withdraw) gated on capability
- `apps/admin/src/client/stores/review.ts` — Pinia store for review state per item; subscribes to SSE for state-change events
- Site tree state badges (per `design-scale.md`'s per-item indicator pattern) — small dot + tooltip per state

**Tests:**
- Banner renders correct state per item
- Actions hidden when capability missing
- Reject opens comment dialog; empty comment blocks submit
- State changes via API → SSE → UI updates without reload

**Risk:** high. Visible UX; wrong gating breaks workflow trust. Vue Test Utils + Playwright e2e against archetype B + D fixture sites.

**SOLID:** SRP — `ReviewBanner.vue` renders state; `ReviewActions.vue` owns button gating; the store owns transitions. Composition over inheritance.

### Cut 9: Publish-approval state machine

**Files added:**
- `packages/gazetta/src/review/publish-state-machine.ts` — `publish-pending → publish-approved → published` with same explicit-action invariant
- Per-target publish-request sidecars under `{target-root}/.gazetta/publish-requests/{kind}/{name}/{request-id}.json`

**Files modified:**
- `packages/gazetta/src/admin-api/routes/publish.ts` — when target has `requiresPublishApproval: true`, publish action creates a request instead of executing; once approved, the request executes

**Tests:**
- Target with `requiresPublishApproval: true`: publish creates request, doesn't deploy
- Approver clicks approve → request executes
- Reject cancels request
- Multiple `requiredPublishApprovers` — first approve doesn't deploy; second does

**Risk:** high. Per-target gate is compliance-critical; wrong implementation = unapproved content reaches prod.

### Cut 10: Publish-approval admin UX

**Files modified:**
- `apps/admin/src/client/components/PublishPanel.vue` — when target requires approval:
  - Publish button text becomes "Request publish"
  - Existing requests visible in the panel; approver sees Approve/Reject
  - Status indicators per request (pending / approved / executed)

**Tests:**
- Publish button text changes per target config
- Approver sees pending requests; non-approver doesn't
- Approve flow executes the publish

**Risk:** high. Visible UX; mistakes here = compliance gap or UX confusion.

### Cut 11: Combined-action buttons

**Files modified:**
- `apps/admin/src/client/components/ReviewActions.vue` — when actor has both `review:submit` AND `review:approve`, AND `allowSelfApproval: true`, AND `requiredApprovers: 1` → show "Submit & approve" button (single click → both events)
- Same for "Publish-request & approve" in `PublishPanel.vue`

**Tests:**
- Combined button visible only when all four conditions met
- Click emits both audit events with same timestamp + actor
- `allowSelfApproval: false` → only "Submit" visible (approve happens later by another actor)

**Risk:** low. UX optimization; falls back to two-click flow when conditions not met.

### Cut 12: Constructive errors

**Files modified:**
- `packages/gazetta/src/admin-api/routes/review.ts` — return `409 NO_APPROVER_AVAILABLE` when submit happens but no role-mapped actor has `review:approve` (deadlock prevention)
- `packages/gazetta/src/config/validate.ts` (or boot path) — at boot, validate that review-workflow-enabled targets have at least one role with `review:approve` (or `publish:approve` for publish-approval targets); warn or error per severity
- 403 error responses include suggested action: "Your role 'editor' doesn't have review:approve. Ask an admin to upgrade your role or contact a reviewer."

**Tests:**
- Submit on a config with no approver-capable roles → 409 with deadlock-prevention message
- Boot config validation fires on misconfiguration
- 403 messages helpful (smoke test on the wording)

**Risk:** low. UX polish; tests guard the wording stays helpful.

### Cut 13: Pending review queue

**Files added:**
- `apps/admin/src/client/components/PendingReviewQueue.vue` — list view; filter by kind/age; reviewer's "what's waiting for me" surface
- New admin API: `GET /api/reviews?action=pending-review` — paginated list of items in `pending-review` state the principal can read, each with `canApprove` (`design-review-workflow.md`, "Visibility filtering")

**Tests:**
- Reviewer with `review:approve` sees the queue
- A reader without `review:approve` gets the pending items they can read, with `canApprove: false` (no 403; `design-review-workflow.md`, "Visibility filtering")
- Pagination works at the operating envelope (e.g., 100 items)

**Risk:** medium. New surface; pagination must hold per `design-scale.md`.

### Cut 14: Hook integration

Per `design-hooks-implementation.md` Phase 4 (when hooks foundation ships): wire 10 review-lifecycle hook phases:

- `beforeReviewSubmit`, `afterReviewSubmit`
- `beforeReviewApprove`, `afterReviewApprove`
- `beforeReviewReject`, `afterReviewReject`
- `beforeReviewWithdraw`, `afterReviewWithdraw`
- `beforePublishApprove`, `afterPublishApprove`

`before*` hooks can fail-cancel; `after*` hooks parallel + fail-open.

**Tests:**
- Hook fires on transition with correct payload
- `before*` returning failure cancels transition + records audit `outcome: 'hook-cancelled'`
- `after*` failure logged but doesn't undo transition

**Risk:** medium. Hook contract is locked in `design-hooks.md`; bugs in payload shape = plugin authors break.

### Cut 15: Docs

**Files added/modified:**
- `docs/review-workflow.md` (NEW) — operator guide with 5 archetype recipes (A solo through E compliance); copy-paste config snippets
- `examples/starter` — add a commented-out `reviewWorkflow` block in `site.config.ts`
- `ROADMAP.md` — mark Phase 2 review workflow shipped
- `CLAUDE.md` — link `docs/review-workflow.md`

## Validation gate (definition of done)

- [ ] All 15 cuts merged
- [ ] Manual test against each of 5 archetypes (A-E): config + role mapping + flow
- [ ] Compliance archetype E: `requiredApprovers: 2` enforced; self-approval blocked; `invalidateOnSave: 'always'` re-triggers review
- [ ] Per-target publish approval gates production deployment
- [ ] Audit log captures every transition with actor + outcome
- [ ] Hook integration: plugin can `beforeReviewApprove` to add custom validation
- [ ] Pending queue at envelope (100+ pending items)
- [ ] Constructive errors: deadlock prevention + helpful 403 messages

## Deferred items

| Item | Trigger to revisit |
|---|---|
| Asset and asset-metadata review | v2 — current scope is pages + fragments only |
| Site config + template review | v2 — same scope reasoning |
| Per-target capability scoping (`review:approve@{target}`) | Multi-stage release archetype demand |
| Per-dimension capability scoping (`review:approve@{template}`, `@{locale}`) | Editorial archetype F + translation archetype G demand |
| "Approve with caveats" (collaboration concern) | `design-collaboration.md`'s scope |
| Approval expiry (auto-revert after time) | Compliance demand |
| Multi-stage workflows (draft → editorial → legal → approved) | Concrete archetype demand |
| Bulk operations on pending queue (approve N items at once) | Reviewer asks; v2 ergonomic |
| Email/Slack notifications on transitions | NotificationProvider plugins (per `design-collaboration.md`) |

## Open implementation questions

1. **State-machine atomicity.** Per-approver sidecar write + state-write is two operations. Per design's "concurrent approval race tolerance": writes are idempotent; last-write-wins on `state: approved`. Verify in cut 4 with concurrent test.
2. ~~**`invalidateOnSave: 'content-diff'` hash basis.**~~ **RESOLVED 2026-10-03** — locked to `computeSaveEtag` (content-only) in [`design-review-workflow.md`](design-review-workflow.md) "Locked invariants". The publish-state `.{8hex}.hash` substitutes template + fragment hashes, so it would revoke approval on unrelated dep-tree changes. Cut 5 (#519) consumes the lock; it no longer carries the decision.
3. **Self-approval edge case.** When `allowSelfApproval: false` AND submitter is the only role-mapped approver: deadlock. Cut 12's `409 NO_APPROVER_AVAILABLE` covers this; verify the error fires at submit time, not approve time (UX: don't let them submit then fail mid-flow).
4. ~~**Pending queue visibility filter.**~~ **Resolved 2026-10-24:** the queue returns pending items the reviewer can read, each with `canApprove`; read access is the RBAC filter, applied at query time (`design-review-workflow.md`, "Visibility filtering").

## Estimates

Wall-clock for solo dev. Assumes Phase 1 foundations (auth-rbac, audit, hooks) have shipped.

| Cut | Estimate |
|---|---|
| 1 (Config schema) | 0.5 day |
| 2 (Capability vocabulary) | 0.5 day |
| 3 (Sidecar storage) | 1 day |
| 4 (State machine) | 2 days |
| 5 (Save handler integration) | 1.5 days |
| 6 (Audit integration) | 0.5 day |
| 7 (Admin API routes) | 1.5 days |
| 8 (Admin UX) | 3 days |
| 9 (Publish-approval state machine) | 2 days |
| 10 (Publish-approval UX) | 2 days |
| 11 (Combined-action buttons) | 0.5 day |
| 12 (Constructive errors) | 1 day |
| 13 (Pending queue) | 1.5 days |
| 14 (Hook integration) | 1 day |
| 15 (Docs) | 1.5 days |

**Total: ~20 days.** Budget ~4-5 weeks with iteration on cuts 8 and 10 (the visible UX surfaces) where Vue + RBAC composition tends to absorb time.

## SOLID checks per cut

- **Cut 1**: ISP — config has narrow per-target shape; no god object. SRP — schema validation in one place.
- **Cut 2**: SRP — capability registry adds 4 entries; doesn't change existing checks.
- **Cut 3**: SRP — sidecar I/O in one module; reuses existing per-edge pattern.
- **Cut 4**: SRP — pure FSM function over state; I/O is the caller's concern. DIP — caller depends on `transition` interface, not implementation.
- **Cut 5**: SRP — save handlers don't own review semantics; delegate to state machine. ISP — `invalidateOnSave` is a config field, not a separate interface every save consumer must understand.
- **Cut 7**: SRP — each route handler owns one transition.
- **Cut 8**: SRP per component (banner / actions / store). Composition — `ReviewActions` consumed by `ReviewBanner`, not inheritance.
- **Cut 9**: SRP — publish-state-machine peers content-state-machine; same shape, different domain.
- **Cut 14**: OCP — hook phases are additions to the existing hook lifecycle; review code calls `runHookPhase('beforeReviewSubmit', ctx)` without knowing what plugins are wired in.
