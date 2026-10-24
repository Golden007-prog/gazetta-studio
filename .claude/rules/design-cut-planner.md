# Cut-planner

Autonomous bot that owns the per-feature cut pipeline: it files the next cut sub-issue for feature-bot one at a time, and revises a cut's spec when feature-bot's generator-critic loop can't land it.

Peer to feature-bot, not above it. feature-bot implements cuts; cut-planner decides *which* cut is next and *how it is specified*. They communicate through GitHub labels and comments only — neither imports the other.

**Status**: design pass complete (2026-10-04). Cuts 1–9, 11–13 implemented (#846–#849, #851–#855, plus the process-docs PR); armed. Cut 10 (first real migration) pending. Where the implementation departed from this doc, see "Implementation notes" below.

**Companion docs**:
- [`design-feature-bot.md`](design-feature-bot.md) — the consumer. Its Q1 (cuts live in tracking issues + sub-issues), Q2 (just-markdown bodies), Q3 (`**Depends on**` parsing), Q6 (three-tier escalation) and Q9 (cut sequence lives in the design doc) are all load-bearing here.
- [`feature-design-process.md`](feature-design-process.md) — Phase 4 changes materially; see "Process changes" below.
- [`bots/README.md`](../../bots/README.md) — producer/consumer rule, durable-memory pattern, decision-log + outcome-tag conventions.
- [`docs/adr/0015-impl-doc-artifact-retires.md`](../../docs/adr/0015-impl-doc-artifact-retires.md) — the artifact split this design extends (intent in the design doc, state in GitHub).
- [`team-preferences.md`](team-preferences.md) — rules 22 (durable artifacts), 24 (5K envelope), 25 (enumerate rejected alternatives), 33 (every change via PR), 37 (don't stack fixes), 38 (audit symmetric bots), 40 (route by task shape), 45 (read before asserting).

## Motivation, stated honestly

Two problems, one measured once and one measured zero times.

**Spec staleness (n=1).** Cut #519 was filed in June with the body line *"Resolve open-Q #2 here"* — a functional requirement with an unresolved design decision embedded in it. Agent A had to *decide* the `invalidateOnSave` hash basis before it could *build* anything. The cut failed three times. The fix (2026-10-03) was not a smaller cut: it was locking the decision in [`design-review-workflow.md`](design-review-workflow.md) (#837) and rewriting the body to **state** the contract and point at the centralized save path. Deciding is the expensive mode; building against a locked contract is the cheap one.

**All-up-front filing.** Cut specs are written against *predicted* code. #519's spec was authored before #518 landed and before the hash-basis question was settled four months later. A spec written just-in-time would have cited the lock.

**What is NOT the motivation — and this matters.** Cut *size* has been this project's most attractive wrong answer. Three times during the 2026-10-03/04 sessions a failure presented as "the cut is too big":

| Symptom | Actual cause |
|---|---|
| #526 skip entry: *"the cut is likely too large or the loop is thrashing"* | 45-min per-cut budget ÷ 5 attempts = 9-min slices vs a **measured 10.6-min** Agent A (#836) |
| #519 `exited 143` | `spawn E2BIG` — the prompt was passed via argv (#835) |
| "thin specs cause the failures" | Control group refuted it: #520 landed on a 367-char body, a failed one had 1210 |

cut-planner therefore **refines before it re-decomposes**, and is explicitly forbidden from treating a rate-limit or an infrastructure failure as evidence about cut size (see "Failure routing").

**Recorded reservation.** At design time feature-bot had delivered **zero** cuts — verified by counting PRs carrying the `<!-- feature-bot: issue= -->` marker. Fifteen cuts attempted, five mechanical blockers fixed in the preceding 12 hours, and the delivery path (`pushBranch` → `openCutPR`) still unexercised. Building a bot to improve spec quality before observing one successful delivery calibrates against a sample of zero, and adds a 7th consumer to the shared 5-hour token bucket that was the binding constraint on both 2026-10-03/04 runs. The maintainer weighed this and chose to build; the reservation is recorded here rather than re-litigated later.

## Scope

**In v1:**
- One long-lived **planner issue** per feature, replacing today's tracking issue
- cut-planner files **one** cut sub-issue at a time (`enhancement` + `ready-for-agent` + `area: X`)
- **Input contract: the planner issue, and nothing else.** cut-planner never reads a design doc or an impl doc; seeding is maintainer work (open-Q 4)
- **Runs in the night shift** — up to four runs every night, right before feature-bot, with a 03:00 UTC cron as a morning backup (open-Q 1, amended 2026-10-24)
- Cut bodies carry functional requirements **and** technical suggestions — locked decisions transcribed from the design doc, named target files, the test files to add
- feature-bot gains a non-terminal **`needs-refinement`** outcome: comment + label swap, no skip-list entry
- cut-planner consumes the `needs-refinement` queue, revises the spec, swaps the label back
- Bounded budgets: 2 refinements, then 1 re-decomposition, then terminal
- Planner issue carries current state (body) + append-only history (comments)
- Deviations from the suggested plan are recorded as `> Decision:` comments
- **Memory (Q7a)**: per-feature state in the planner issue; cross-feature learning via the standard two-tier pair —
  `decision-log.jsonl` (cached, append-only) + `lessons-learned.md` (committed, monthly compactor rewrite). No own `skip-list.json`.

**Out of v1:**
- Autonomous *design* decisions — cut-planner transcribes locks, never invents them (see Q2)
- Cross-feature planning (one planner issue per feature; no global queue)
- Re-ordering the suggested plan's dependency graph wholesale
- Writing or editing the design doc's `## Cut sequence` table (that stays maintainer-owned)
- Any usage awareness of its own — `night-shift.yml` checks the account's usage before each run (open-Q 1)
- A pre-flight cut-size gate — dropped; re-decomposition is reactive only (open-Q 6)
- Reading design docs or impl docs (open-Q 4)

**Non-goals:**
- Replacing the design pass. Decomposition is grilled by a human per [`design-feature-bot.md`](design-feature-bot.md) Q9; cut-planner starts from that output.
- Becoming a splitter. Re-decomposition is a bounded fallback, not the primary path.
- Implementing cuts. That is feature-bot's job (rule 40: route by task shape).

## Locked decisions

### Q1 — The planner issue replaces the tracking issue

One issue per feature, labeled `enhancement` + `area: X` and deliberately **without** `ready-for-agent`, so feature-bot's query ignores it (same mechanism that makes today's tracking issues invisible per [`design-feature-bot.md`](design-feature-bot.md) Q1).

Seeded by the maintainer after the design pass:

```markdown
**Feature**: review-workflow
**Design**: .claude/rules/design-review-workflow.md

## Suggested plan
<!-- advisory seed, copied from the design doc's ## Cut sequence.
     cut-planner need not follow it precisely; see Q3. -->
| # | What | Depends on | Test tier | Risk |
|---|---|---|---|---|
| 5 | save-handler gates pending-review | 4 | api-first | Medium |
| 6 | audit integration | 4 | api-first | Low |

## State
<!-- cut-planner maintains this section -->
Landed: cuts 1-4 (#515-#518)
In flight: —
Next: cut 5

## Locked decisions
<!-- what cut-planner may transcribe into cut bodies; see Q2 -->
- `invalidateOnSave: 'content-diff'` compares `computeSaveEtag(manifest)`,
  NOT the publish-state `.{8hex}.hash` (#837, design-review-workflow.md)
```

**Rejected alternatives:**

| | Why rejected |
|---|---|
| **Planner issue *alongside* the tracking issue** | Two issues per feature answering the same question at different fidelity; they can disagree. The planner issue is a strict superset (it adds state, history, reasoning, and the advisory plan). |
| **Keep tracking issues, add a committed `.md` planner file** | Two sources of truth; the file needs a PR per update (async) while labels and comments are sync — the same async/sync race that makes skip-list contention hazardous. |
| **No planner artifact; cut-planner recomputes state each run** | Re-derives the decomposition every run (token cost on a contended bucket), and loses the deviation history that makes "plan said X, I did Y because Z" auditable. |

**Supporting observation:** today's tracking issues are not delivering their one structural job. Tracking issue #515 reports **0 linked sub-issues** despite `feature-design-process.md` requiring the `addSubIssue` GraphQL mutation. Collapsing onto a single, actively-maintained issue avoids propping up a mechanism that is already silently broken. (The `addSubIssue` gap is worth fixing independently of this design.)

### Q2 — cut-planner transcribes locked decisions; it never invents them

A cut body may carry technical suggestions — target files, the mechanism to use, the test files to add — **provided every such suggestion traces to a decision already locked in the design doc or an ADR**.

When cut-planner finds the design doc leaves a decision open, it does **not** decide. It posts a `NEEDS_INPUT`-shaped question on the planner issue, applies `needs-info`, and stops filing for that feature until the maintainer answers.

This is the line that keeps [`design-feature-bot.md`](design-feature-bot.md) Q9 intact: decomposition and design decisions are human-grilled; cut-planner localizes them.

**Why this is the load-bearing Q:** #519 is the worked example in both directions. Its original body *deferred* a decision ("Resolve open-Q #2 here") — the failure mode. Its rewritten body *states* the locked contract plus the concrete target (`manifest-save.ts`, not the `pages.ts`/`fragments.ts` protocol shims) — the fix. The difference is entirely whether the decision existed before the cut was specified.

**Rejected alternatives:**

| | Why rejected |
|---|---|
| **cut-planner decides open questions and records its reasoning** | Autonomous design decisions. The design pass exists because these choices have blast radius; a bot resolving them at filing time is exactly what ADR-0015 and Q9 were written to prevent. |
| **cut-planner files the cut anyway and lets feature-bot discover the gap** | This is today's behavior and it is the measured failure (#519, three runs). |
| **Functional requirements only; no technical suggestions** | Discards the fix that actually worked. Naming `manifest-save.ts` over the route shims is what made #519 buildable. |

### Q3 — The suggested plan is advisory, not a contract

cut-planner starts from the planner issue's `## Suggested plan` (seeded from the design doc's `## Cut sequence`) but may deviate. Deviation is legitimate **only** when recorded as a `> Decision:` comment on the planner issue stating what changed and why.

**Why advisory rather than binding:** the plan for cut 12 was written before cuts 1–11 existed. `feature-design-process.md` already expects drift — it carries a "When to fold cuts" section describing manual consolidation, and the redirect-ui migration folded its Cut 5 into Cut 3. Today that folding is maintainer labor. As an advisory seed it is cut-planner doing what the process already expects someone to do.

Matching prior art: [Task-Decoupled Planning](https://arxiv.org/pdf/2606.20487) pairs up-front decomposition with a *Self-Revision module that updates the graph after execution*. Here the human is the Supervisor and cut-planner is the self-revision step.

**Why a seed at all, rather than deriving each cut fresh:** the grilling already happened; re-deriving it per run burns tokens on a contended bucket and is non-deterministic across runs.

**Rejected alternatives:**

| | Why rejected |
|---|---|
| **Binding plan — cut-planner transcribes rows verbatim** | Pure mechanization; cannot fold, reorder, or adapt to what actually landed. Loses the main benefit of just-in-time filing. |
| **Free deviation, no record** | Indistinguishable from the bot quietly abandoning the design. Nobody can tell whether cut 7 was skipped deliberately or forgotten. |
| **Deviation requires maintainer pre-approval** | Every deviation becomes a blocking round-trip; destroys the autonomy that motivates the bot. |
| **Deviation updates the design doc's table via PR** | Heavy (a PR per deviation) and async-vs-sync racy. The design doc's table is *intent* per ADR-0015; divergence from outcome is an accepted property, not drift. Revisit if the table drifts far enough to mislead a cold reader. |

### Q4 — Feedback travels by comment + label swap, on the cut issue

When feature-bot's loop cannot land a cut and the cause is plausibly the spec, it:

1. posts a comment on the **cut issue** carrying the typed outcome and the reviewer's note, with an outcome tag
2. removes `ready-for-agent` and applies **`needs-refinement`**

cut-planner polls `gh issue list --label needs-refinement`, reads that cut's comments for detail, revises the body, and swaps the label back to `ready-for-agent`.

**Why this shape:**
- **Zero coupling.** feature-bot never learns the planner issue's number, never resolves it, and cannot fail because of it. (An earlier draft had feature-bot cross-post a summary to the planner issue; that introduced a new way for feature-bot to break, and "fail soft" is not reassuring in a codebase where `pushBranch` already swallows its errors.)
- **Label-as-queue is the house idiom.** Every bot here gets work from a label query.
- **The dequeue is free.** The candidate query prefilters server-side on label *presence* (`labels: requireAll.join(',')` — [`bots/_lib/github.ts`](../../bots/_lib/github.ts)), so removing `ready-for-agent` removes the cut from feature-bot's queue with no parser change and no new exclusion.
- **feature-bot already writes six tagged comment types** (`needs-input`, `body-error`, `dep-invalid`, `dep-waiting`, `skip-entry`, plus the PR marker). This is a seventh, not a new mechanism.

**`needs-refinement` is the design's first new label.** [`design-feature-bot.md`](design-feature-bot.md) Q1 deliberately introduced zero. The departure is justified because the label encodes a genuinely new state — *awaiting bot refinement*, distinct from `needs-info`'s *awaiting human decision* — and because it is the mechanism that keeps the two bots decoupled. Recorded as deliberate, not an oversight.

**Rejected alternatives:**

| | Why rejected |
|---|---|
| **feature-bot cross-posts to the planner issue** | Couples feature-bot to an upstream artifact it otherwise ignores; creates a new failure mode on a path that must not break. |
| **cut-planner reads `reviewer-log.jsonl`** | `actions/cache` is single-instance, lossy across bots, not queryable. It is already what `lessons-learned.md` was supposed to distill and never did (the file is still an empty placeholder). |
| **cut-planner parses transcripts** | Richest signal, heaviest cost — downloading and parsing JSONL per run on a contended bucket. Reserved for a future diagnostic path. |
| **cut-planner polls closed/skip-listed cuts** | Would require un-skipping entries that feature-bot added via an in-flight PR: two bots contending on `skip-list.json`, async PR vs sync label. |

### Q5 — Only spec-plausible failures route to refinement

The routing layer already separates substance from infrastructure. [`route-attempt.ts`](../../bots/feature-bot/route-attempt.ts) is a pure function returning five decisions, and the infrastructure causes never reach it:

- **Rate limit** — caught by the orchestrator's guard *before* routing; leaves the cut `ready-for-agent` and stops the queue (#831). Not a cut defect.
- **Transient auth / entitlement** — same guard (#831).
- **Agent A non-zero exit** (e.g. `spawn E2BIG`) — surfaces as `escalate-failure`, a decision distinct from `escalate-needs-human`.

So `needs-refinement` has one precise insertion point: the **reject-with-loop-exhausted** branch, where Agent B has rejected on substance up to `maxAttempts`:

```ts
// route-attempt.ts, verdict.kind === 'reject'
if (ctx.attempt >= ctx.maxAttempts) {
  // today: escalate-needs-human with reason 'needs-human'
  // becomes: escalate-needs-refinement when refinements remain
}
```

Plus `spec-too-vague`, which already exists in the `SkipReason` union and is raised by the pre-Claude `validateCutSubIssue` gate.

Everything else stays terminal.

**Why this line is load-bearing:** if infrastructure failures routed to refinement, cut-planner would rewrite perfectly good specs in response to transport bugs. That is precisely the misattribution that made #526's skip entry say *"the cut is likely too large"* about a budget bug. Refining a spec cannot fix `spawn E2BIG`.

**Rejected alternatives:**

| | Why rejected |
|---|---|
| **Route every non-APPROVE outcome to refinement** | Would hand cut-planner rate limits, `spawn E2BIG`, and Agent A crashes as if they were spec defects. Refining a spec cannot fix a transport bug, and the misattribution is this project's recurring error — #526's skip entry reads *"the cut is likely too large"* about a 45-minute budget bug. |
| **Route the first reject to refinement (don't wait for loop exhaustion)** | Discards the retry that the generator-critic loop exists to provide. Agent B's first rejection is frequently actionable by Agent A directly — on #519 attempt 1 the tautology check *passed* and the rejection was a specific architecture gap, exactly the input `retry-with-note` is designed to consume. Refining after one reject would spend a cut-planner call to replace a cheaper in-loop retry. |
| **Let cut-planner decide which failures are spec-related by reading transcripts** | Richest signal, but moves the classification from a pure function into an LLM judgement, on a contended bucket, for a decision the routing layer already makes deterministically. Producer/consumer violation per `bots/README.md`. |
| **Add a `needs-refinement` branch for `spec-too-vague` only** | Too narrow: it would catch the pre-Claude gate's rejections but miss the substantive case (repeated Agent B rejects) that is the main motivation. |

**Note on a corrected assumption:** an earlier draft of this design contrasted a "terminal tier that closes the sub-issue" with a "non-terminal refinement tier". `escalateToHuman` does **not** close the issue — it removes `ready-for-agent`, applies `ready-for-human`, and the comment *advises the maintainer* to close or implement manually. The real difference between terminal escalation and refinement is therefore narrow: the label value, and whether a skip-list entry + PR are created. That makes the implementation smaller than first described — a parameterization of the existing escalation path, not a parallel one.

### Q5a — Drain feature-bot's feedback before filing anything new

Every cut-planner run checks for pending feature-bot input **first**, and files a new cut only when there is none:

```
per run:
  1. refinement queue non-empty?  → refine the oldest, then STOP.
  2. a cut still open and in flight (ready-for-agent, or a PR awaiting review)?
                                   → STOP. Nothing to file.
  3. otherwise                     → file the next cut.
```

Feedback-first, and **one action per run**.

**Why feedback outranks filing:**

- **A cut in `needs-refinement` is evidence about the plan.** If cut 5 failed because its spec deferred a decision, cut 6 — drafted from the same design doc, by the same process — plausibly shares the defect. Filing it before absorbing cut 5's lesson propagates the error. This is the #519 failure mode at feature scale: that cut's spec sat four months with *"Resolve open-Q #2 here"* precisely because nothing forced a re-read before moving on.
- **Dependencies are implicit in this design.** Cuts carry no `**Depends on**` field (Q1 removed the need for it by filing one at a time), so ordering is enforced *only* by cut-planner not getting ahead of itself. Filing cut 6 while cut 5 is unresolved silently breaks the one mechanism that sequences the feature.
- **Two live cuts can conflict.** Cut 5 and cut 6 of the same feature typically touch the same files. feature-bot builds each branch fresh from `origin/main`, so two in-flight cuts produce branches that don't see each other's work — and the second PR's review burden lands on the maintainer as a merge conflict.
- **Quota.** On a shared 5-hour bucket, a refinement that rescues work already paid for beats a fresh cut that starts from zero.

**One action per run** keeps each cron's blast radius to a single issue write, which matters because cut-planner's writes are not transactional: it edits the planner issue body, creates or relabels a cut issue, and appends a comment as three separate API calls. A run interrupted midway leaves at most one cut in a knowable state.

**Rejected alternatives:**

| | Why rejected |
|---|---|
| **File-first, refine-later** | Propagates a spec defect into the next cut before its lesson is absorbed; gets ahead of the implicit dependency chain. |
| **Both in the same run (refine *and* file)** | Two issue writes per run with no transaction; and the new cut is drafted before the refinement's outcome is known, so the lesson still isn't applied. |
| **Allow N cuts in flight concurrently** | Reintroduces the dependency-tracking problem Q1 eliminated, and creates same-file conflicts between sibling cuts. Revisit only if feature-bot's throughput ever exceeds one cut per cron, which (at zero deliveries to date) is not a current constraint. |
| **Refine only when the maintainer asks** | Defeats the autonomy that motivates the bot. |

### Q6 — Budgets: 2 refinements, then 1 re-decomposition, then terminal

| Stage | Budget | On exhaustion |
|---|---|---|
| Refine the spec in place | 2 | → re-decompose |
| Re-decompose into smaller cuts | 1 | → terminal |
| Terminal | — | `ready-for-human` (no skip-list entry — see Implementation notes) |

Counted from outcome-tagged comments on the cut issue, the same way `priorInputCycles` is counted today.

**Quota exhaustion is NOT budget exhaustion, and only one of them is evidence about size.** The two look identical from outside — a run ends without a verdict — but they mean different things:

| Signal | Means | Response |
|---|---|---|
| **Budget** exhausted (per-cut wall-clock consumed, no verdict) | the work didn't fit in the time allotted | counts toward Q6's budgets; can lead to re-decomposition |
| **Quota** exhausted (Anthropic session rate limit) | the account ran dry | stop the queue, change nothing, retry next cron. Counts toward nothing. |

Measured evidence that quota says nothing about cut size — both runs on cut #519, identical scope:

| Run | Work completed before the limit |
|---|---|
| 2026-10-03 21:14 | **18 min** — Agent A only |
| 2026-10-04 08:52 | **51 min** — Agent A 15 + Agent B 10 + Agent A 26 |

Run 2 did ~3× the work of run 1 on the same cut. The variable was available quota, whose dominant consumer was an interactive session sharing the same 5-hour bucket.

Treating repeated quota failures as "make a smaller cut" would therefore (a) shrink cuts that were never too big, (b) *increase* total consumption — 3 cuts means 3× Agent A context-establishment plus 3× Agent B review, against a token-metered bucket — and (c) corrupt the record, since a cut split for quota reasons is indistinguishable afterwards from a cut that was genuinely too large. There is also a sequencing problem: deciding *how* to split needs a Claude call, which hits the same exhausted bucket.

If a cut is repeatedly quota-killed, the honest response is Q6a's rule — surface it to a human — not a split on a signal that does not mean what it appears to mean. This is the fourth instance this session of "the cut is too big" being the attractive wrong answer; #526's skip entry says exactly that about a 45-minute budget bug.

**Why refine-before-decompose:** [CORAL](https://arxiv.org/pdf/2601.09883) — *"the orchestrator does not always escalate the issue to the planner for re-decomposition. Instead, it may refine or adjust the previous task instruction and allow the same agent to continue... avoiding redundant token consumption caused by reprocessing subtasks that have already been completed."* The decision rule it gives: refine when the failure is execution-level; re-decompose only when the breakdown itself is flawed. Our own evidence agrees — every diagnosed failure was mechanical or spec-*mode*, never spec-*size*.

**Why 2 then 1:** [industry retry guidance](https://semnexus.com/ai-agent-retry-logic-handling-failures-without-human-escalation) — *"limit re-prompting to 2 attempts per step; if the model fails the same constraint twice with explicit correction, either the prompt is broken or the model can't satisfy this constraint"*, with a 3-nudge ceiling per error sequence. Matches feature-bot's existing `MAX_INPUT_CYCLES` default of 2 ([`index.ts`](../../bots/feature-bot/index.ts)).

**Why the correction must carry the error:** the same source — *"don't just resend the original instruction, but tell the model exactly what was wrong about the previous output."* A refinement that doesn't quote Agent B's note is just a retry.

New `SkipReason` members: `refinement-exhausted`, `redecomposition-failed`.

**Rejected alternatives:**

| | Why rejected |
|---|---|
| **Unbounded refinement** | Unbounded spend on a shared token bucket, with no terminal state. fix-bot and dead-code-watcher both cap; rule 38 symmetry. |
| **Re-decompose first** | Contradicts CORAL and our own evidence; splitting *increases* total tokens (one worked example: 390 vs 300) against the resource that is already the binding constraint. |
| **Decompose only, never refine** | Would have fired on #519 and produced three cuts each still containing the unresolved design question. |
| **Count quota failures toward the budgets / split after N quota kills** | Considered and rejected on measured evidence — see the quota-vs-budget table above. Both 2026-10-03/04 runs hit the limit on the same cut at 18 min and 51 min respectively; the variable was available quota, not scope. Splitting would increase consumption against a token-metered bucket, and would record a quota failure as a size failure. |

### Q6a — When the bot can't do the job, it files for a human

**The rule:** if cut-planner cannot complete the job, it hands the job to a human. No silent skip, no retry-forever, no undefined state.

That is the whole contract. Everything below is consequence, not a separate rule — and crucially the rule is a **default, not a list**: a failure mode nobody anticipated still resolves to "file for a human", because the rule is stated in terms of *cannot complete* rather than in terms of enumerated causes.

**Two targets, because "the job" has two scopes:**

| Scope | Target | Effect |
|---|---|---|
| The **feature** can't proceed | planner issue + `needs-info` | cut-planner stops filing for that feature |
| One **cut** can't proceed | cut issue + `ready-for-human` | the rest of the feature continues |

Pick the narrower scope that is actually blocked. Collapsing to one target would stall a whole feature on one bad cut, which is effectively what today's terminal-only path does.

**Examples, not an exhaustive list:**

| Situation | Scope | Note |
|---|---|---|
| Design doc leaves a decision open (Q2) | feature | Deciding is a design act; cut-planner transcribes, never invents |
| Plan exhausted but the feature isn't done | feature | Plan incomplete or design needs extending — a maintainer call either way |
| Planner issue malformed / `## State` unparseable / design doc missing | feature | Its own input is broken; guessing would corrupt state |
| Refinement + re-decomposition budgets exhausted (Q6) | cut | The spec isn't the problem, or isn't one cut-planner can fix |
| Agent B raises a **design** objection, not an implementation one | cut | Refining a spec cannot answer "this architecture is wrong" |
| Edit surface includes `.github/workflows/**` | cut | **Recorded but never queued** — opened with `ready-for-human`, not `ready-for-agent`, plus a comment that it needs a manual PR. `GITHUB_TOKEN` cannot push workflow files and no permission grants it (#840); run 37152238559 spent a full loop reaching `APPROVED on attempt 1/5` before the push failed. Resolved by #336. |
| Same cut escalated terminally twice | cut | Repetition without progress |
| *Anything else cut-planner can't complete* | narrower of the two | The rule is the default; the list above is illustrative |

**The one carve-out — a quota failure is not an inability.** Rate limits, transient auth, and Agent A's non-zero exits (`spawn E2BIG`) mean *"come back later"*, not *"this job can't be done."* cut-planner stops the queue, changes nothing, and retries next cron — feature-bot's existing behavior (#831), inherited. A cut legitimately in flight is likewise not an escalation; it is "nothing to do this run" (Q5a step 2).

This carve-out is the part worth stating explicitly, because misattributing infrastructure failure to content defect is this project's recurring error: #526's skip entry reads *"the cut is likely too large"* about a 45-minute budget bug.

**Absence-as-state (rule 23):** cut-planner posts nothing when it has nothing to say. No "nothing to file" comment, no heartbeat. The planner issue's `## State` is the status surface; a silent run means state is unchanged.

**Why `needs-info` rather than a second new label for the feature case:** it already means *"bot must exclude from queue; requires information to proceed"* and was explicitly widened to cover maintainer-decision cases ([`design-feature-bot.md`](design-feature-bot.md) Q6). `needs-refinement` (Q4) remains the design's one new label.

**Rejected alternatives:**

| | Why rejected |
|---|---|
| **Enumerate the escalation triggers as a closed list** (this Q's first draft) | Nine rows reading as exhaustive, so the tenth unanticipated failure falls through to undefined behavior. Stating the rule as a default makes the list illustrative and the fallback well-defined. |
| **One escalation target for everything** | Conflates feature-blocked with cut-blocked; one bad cut stalls the whole feature. |
| **Silent skip on anything cut-planner can't handle** | The failure mode we already have in `pushBranch`, which swallows push errors and reports success (#840). Silence is indistinguishable from success at every surface a human checks. |
| **Retry indefinitely instead of escalating** | Unbounded spend on a shared bucket with no terminal state. fix-bot and dead-code-watcher both cap (rule 38 symmetry). |
| **Escalate on rate limit too** | A quota failure says nothing about the cut or the plan; escalating misattributes infrastructure to content. |
| **Heartbeat comment each run** | Violates absence-as-state; turns the planner issue into a log to skim for signal. |

### Q7 — Planner issue: body is current state, comments are the append-only log

Body answers *"where are we?"* in one cheap read (~2K tokens; cut bodies today run 0.9–2.9K against GitHub's 65,536-char limit, so there is ~20× headroom). Comments answer *"how did we get here?"* and are never edited.

Body edits are safe **because** the comment log is immutable: a bad run can garble the state section without destroying history.

**Rejected alternatives:**

| | Why rejected |
|---|---|
| **Body only, rewritten each run** | Lossy and unauditable — a bad run erases prior history with no recovery, and there is no record of when the planner changed its mind. |
| **Comments only** | Safe but unreadable: after 15 cuts the current state is scattered across 15 comments and cut-planner must re-read all of them every run. |
| **Body + committed `.md` file** | Two sources of truth; PR-per-update is async while the issue is sync. |

This also matches the house convention: bots post append-only comments with outcome tags, and `bots/README.md` requires it for forensic queries. Body-as-state is the only new part.

### Q7a — Memory: planner issue for per-feature state, two-tier files for cross-feature learning

Two different memory needs, two different homes. Conflating them was the first draft's error.

**Per-feature state → the planner issue.** What landed, what's in flight, what's next, why the plan was deviated from, which decisions may be transcribed. This is Q7's body/comments split, and it needs no file: the maintainer reads it, it's co-located with the work, and a repo file would need a PR per update (async) while labels are sync.

**Cross-feature learning → the standard two-tier pattern.** *"Specs that defer a decision fail; specs that state it land"* is a lesson no single planner issue can hold, because it only emerges across features. It therefore needs the same structure every other learning bot uses:

| Tier | File | Written by | Shape |
|---|---|---|---|
| Raw | `bots/cut-planner/decision-log.jsonl` (**not** committed; `actions/cache`) | daily cut-planner, append-only | one entry per action — cut filed / refined / re-decomposed / deviated, with the outcome |
| Distilled | `bots/cut-planner/lessons-learned.md` (committed) | monthly compactor, **full rewrite** | cross-feature patterns, loaded into the prompt every run |

**Why two tiers rather than the bot writing lessons directly.** Reading what the existing files actually contain settles this. fix-bot's `lessons-learned.md` is 100 lines of pattern-level guidance (*"Mutation-coverage cuts: declare `Mode: structural`, prove anti-tautology by mutant injection"*); dead-code-watcher's is 58. Three properties make them work, and all three are lost if the bot writes them itself:

1. **The compactor rewrites holistically.** The daily bot appends raw signal; a monthly pass distills and *replaces* the file. That is what keeps it at 100 lines instead of 3,000.
2. **It is loaded into every prompt**, so its size is a recurring token cost on a contended bucket. Unbounded growth is not untidy — it is expensive, every run.
3. **It is pattern-level, not instance-level** — a rule for future runs, not a diary of past ones.

**Why NOT a generic "save anything the bot thinks important" store.** In-the-moment salience is a poor filter: the agent that just failed believes its specific failure is the most important fact in the world. A free-form store yields instance-level notes, monotonic growth, a prompt that costs more and teaches less each run, and no eviction path — nothing ever decides a lesson stopped being true. The two-tier split *is* the mechanism that converts "things the bot noticed" into "things worth telling the next run," and it works precisely because distillation is a separate, periodic, holistic pass rather than an in-the-moment judgement.

**No own `skip-list.json`.** feature-bot's is already keyed by issue number and already records terminal escalations (Q6a writes there). A second file keyed identically means two bots writing entries about the same cut via two async PRs — the contention that got the Q4 cross-post rejected. Rule 37: one mechanism per failure mode.

**Honest cost of shipping this now.** cut-planner's compactor has nothing to compact until several features have run, so `lessons-learned.md` ships as a placeholder and the compactor job is wired but idle — exactly feature-bot's state today. That is a real cost of building ahead of the signal, and it is the one argument that survives for deferring. It is accepted here because the alternative (retrofitting a raw log later) loses the early decisions that are the most interesting ones to learn from.

**Consequence for Q7:** the planner issue is still the *only* home for per-feature state, so a run that garbles `## State` corrupts it. Mitigations: the comment log is immutable (state is reconstructible by replay), and Q5a bounds a bad run to one action.

**Rejected alternatives:**

| | Why rejected |
|---|---|
| **No lessons file at all (first draft of this Q)** | Argued from volume, comparing cut-planner's *action* count against dead-code-watcher's *finding* count — different units. The evidence refutes it: fix-bot 100 lines, dead-code-watcher 58, both substantive. Only feature-bot's is empty, and feature-bot has never completed a cut, so it has nothing to distill. |
| **Generic free-form memory the bot writes at will** | No eviction, no distillation, instance-level noise, monotonic prompt cost. See above. |
| **Bot writes `lessons-learned.md` directly, no raw log** | Skips the holistic rewrite that keeps the file small, and forces in-the-moment judgement about what generalizes — the judgement the monthly pass exists to defer. |
| **Own `skip-list.json`** | Duplicates feature-bot's; two-writer contention over entries about the same cut. |
| **Commit `decision-log.jsonl`** | A PR per run. `actions/cache` with the `restore`/`save` split is the established pattern ([ADR-0011](../../docs/adr/0011-bot-memory-cache-persistence.md)); losing the log on a cache miss costs one compaction window, not correctness. |

### Q8 — Naming

**`cut-planner`.** "Cut" is established project vocabulary ([`dev-glossary.md`](dev-glossary.md)); "planner" names the producer role without implying hierarchy over feature-bot.

Rejected: `manager-bot` (implies authority over a peer), `cut-author` (sounds like it writes code), `feature-planner` (collides with the design-pass phase), `scope-bot` (vague), `dispatcher` (implies routing, not authoring).

## Pipeline

```
design doc ## Cut sequence          ← human-grilled (Q9 lock intact)
        │  seeded once by maintainer
        ▼
   planner issue  (one per feature; no ready-for-agent)
     ├─ ## Suggested plan   advisory
     ├─ ## State            cut-planner maintains
     ├─ ## Locked decisions transcribable into cut bodies
     └─ comments            append-only history + deviations
        │
        │ per run (Q5a): drain feedback FIRST, then file at most one cut
        │   1. needs-refinement queue non-empty? → refine oldest, stop
        │   2. a cut still in flight?            → stop
        │   3. else                              → file the next cut
        ▼
   cut sub-issue  (enhancement + ready-for-agent + area: X)
        │
        ▼
   feature-bot ──APPROVE──▶ PR ──merge──▶ cut closes
        │
        └──reject × maxAttempts──▶ comment + label swap to needs-refinement
                 │
                 ▼
          cut-planner: revise spec (×2) → re-decompose (×1) → terminal
```

## Foundational checks

cut-planner operates on issues and labels; it never touches the data layer. Most dimensions are N/A.

- **Multi-instance** — workflow `concurrency: group: cut-planner`, `cancel-in-progress: false` per [ADR-0011](../../docs/adr/0011-bot-memory-cache-persistence.md). State lives in GitHub (issue body + comments), not in a cache, so there is no cross-instance cache to race on. One genuine hazard: cut-planner and feature-bot both edit labels on the same cut issue. The handoff is single-writer-per-state by construction — feature-bot only ever swaps `ready-for-agent` → `needs-refinement`, cut-planner only the reverse — so a lost update re-queues or re-refines once rather than corrupting state.
- **Scale (#1)** — per-run work is O(open cuts for one feature) ≈ low tens. One planner-issue read plus one `gh issue list`. Comfortable; no 5K-envelope interaction (bot infrastructure, not a content primitive).
- **Locale / Themes** — N/A (no user-facing surface).
- **Auth + RBAC** — `GH_TOKEN` (Actions default) + `CLAUDE_CODE_OAUTH_TOKEN`. Same posture as the other producer bots. Note the token constraint from #840: `GITHUB_TOKEN` cannot modify `.github/workflows/**`, so cut-planner must not file a cut it then cannot let feature-bot deliver — see Open questions.
- **Audit (#5)** — GitHub's own trail (issue events, comments, workflow runs) plus outcome tags. No gazetta `AuditProvider` event; cut-planner never writes content.
- **Review (#6)** — distinct from gazetta's content review workflow. Cut PRs go through normal human review; cut-planner never merges (rule 33).
- **Hooks / Render / Validation / Plugin / Cache / Offline / Collaboration** — N/A.

## UX check

Per rule 23, applied to maintainer-facing UX:

- **Absence is a state.** cut-planner exits silently when there is nothing to file and nothing to refine. No "nothing to do" comment.
- **One place to look.** The planner issue answers "where is this feature?" in a single `gh issue view`. Today that requires the tracking issue plus N sub-issues plus git log.
- **Plain language in the handoff comment.** The `needs-refinement` comment names the cut, quotes Agent B's note verbatim, and states which refinement attempt this is (`1 of 2`).
- **Deviations are visible, not inferred.** A `> Decision:` comment per deviation means the maintainer never has to diff the suggested plan against reality to discover the bot changed its mind.
- **No new vocabulary for the maintainer.** `needs-refinement` reads the same way as the existing `needs-info` / `ready-for-agent` / `ready-for-human` family.

## Process changes

`feature-design-process.md` Phase 4 changes:

- **Before:** maintainer asks "open cuts for `design-{feature}.md`"; Claude files the tracking issue plus **all** cut sub-issues up front.
- **After:** maintainer asks "open the planner issue for `design-{feature}.md`"; Claude files **one** planner issue seeded with the advisory plan. cut-planner files cut sub-issues one at a time thereafter.

The artifact table row *"Cut sub-issue → one GitHub issue per cut, referenced by a per-feature tracking issue"* becomes *"→ referenced by a per-feature **planner issue** (Q1)"*. Not a new artifact kind — a rename and expansion of one that exists.

## Cut sequence

| # | What | Depends on | Test tier | Risk |
|---|---|---|---|---|
| 1 | `needs-refinement` routing: new `RouteDecision` variant + `escalate-needs-refinement` branch in `route-attempt.ts`; parameterize `escalateToHuman` to skip the skip-entry when refining | — | unit-first | Low |
| 2 | feature-bot emits the handoff: tagged comment + label swap (`ready-for-agent` → `needs-refinement`); refinement-attempt counting from outcome tags | 1 | api-first | Low |
| 3 | `bots/cut-planner/` skeleton + workflow (**cron 03:00 UTC** per open-Q 1, concurrency group, transcripts artifact); planner-issue parser (`**Feature**`, `## Suggested plan`, `## State`, `## Locked decisions`) — parses the planner issue ONLY, never a design doc | — | unit-first | Medium |
| 4 | **Run dispatcher (Q5a)**: feedback-first precedence — drain `needs-refinement`, else stop if a cut is in flight, else file. One action per run. Pure decision function (peer to `route-attempt.ts`), tested without I/O | 3 | unit-first | Low |
| 5 | File-next-cut path: read planner issue → render cut body (functional reqs + transcribed locks + target files + test files) → `gh issue create` → update `## State` → append decision comment | 3, 4 | api-first | Medium-high |
| 6 | Refine path: consume `needs-refinement` queue → read cut comments for Agent B's note → revise body → swap label back → append decision comment; budgets 2/1 | 2, 3, 4 | api-first | Medium-high |
| 7 | Re-decompose path: split one cut into smaller cuts, close the original with a pointer, file the first replacement | 6 | api-first | High |
| 8 | Open-question path: `NEEDS_INPUT`-shaped question on the planner issue + `needs-info`; stop filing for that feature | 3, 4 | unit-first | Low |
| 8a | Escalation (Q6a): the "can't do the job → file for a human" default, including a catch-all so an unanticipated failure still escalates rather than falling through; feature vs cut scope selection; `.github/workflows/**` recorded-not-queued; repeat-escalation detection | 4, 6, 7 | unit-first | Low |
| 9 | `feature-design-process.md` Phase 4 rewrite + artifact-table row + `dev-glossary.md` entries (`cut-planner`, `planner issue`, `needs-refinement`) | — | (docs) | Low |
| 10 | First production migration (see "Migration"): seed a planner issue for a LOW-ACTIVITY feature — not review-workflow, whose 16 open issues make a failed migration expensive; close its pending cuts with pointers; validate end-to-end | 5, 6, 9 | (manual smoke) | Medium |
| 11 | Memory wiring (Q7a): append to `decision-log.jsonl` per action; `actions/cache` restore/save split per ADR-0011; load `lessons-learned.md` into the prompt | 3, 4 | unit-first | Low |
| 12 | `cut-planner:compact` job in `bots-compact.yml` (the compactor has explicit per-bot jobs, not auto-discovery) + `lessons-learned.md` placeholder | 11 | (deployment) | Low |
| 13 | `bots/README.md`: cut-planner row in the active-bots table + its memory surfaces in the durable-memory section; document the label handoff contract | 3, 11 | (docs) | Low |

Cuts 1–2 are feature-bot changes and ship independently — they are useful on their own (a non-terminal reject outcome stops burning skip-list entries on recoverable cuts) even if cut-planner never lands.

State (which cuts shipped) lives in GitHub sub-issue close-state, not in this table (per ADR-0015).

## Arming order

The hand-off mechanism and its consumer ship in different cuts, and **both orders of enabling them are broken**:

- Arm before the consumer exists → cuts get labelled `needs-refinement` and sit in a queue no bot reads. Silently parked, which is the shape Q6a forbids.
- Ship the consumer without arming → cut-planner dispatches, queries an empty `needs-refinement` label, and exits silently forever. The refine path never runs.

So the sequence is fixed:

| Step | State |
|---|---|
| Cut 2 ships | `MAX_REFINEMENTS=0`. Mechanism built and tested; produces no labels. |
| Cuts 3–5 ship | cut-planner exists and can file cuts. Still no refinement traffic. |
| **Cut 6 ships** | the refine path exists — it can now consume the queue. |
| **Then** arm | cut-planner `MAX_REFINEMENTS=2` + `MAX_REDECOMPOSITIONS=1`; feature-bot `MAX_HANDOFFS=3`. **Part of Cut 6's definition of done** — not a follow-up. |

**The two bots' knobs are different units, and must agree.** feature-bot counts *hand-offs*; cut-planner decides what each hand-off becomes. One cut's full budget is 2 refinements + 1 re-decomposition = **3 hand-offs**, so feature-bot's `MAX_HANDOFFS` must equal cut-planner's two budgets summed. An earlier draft of this table said "set `MAX_REFINEMENTS=2`" in both bots — the knob then carried the same name in each. That would have made feature-bot escalate terminally on the third hand-off, the one cut-planner meant to re-decompose: the re-decomposition path would have existed, passed its own unit tests, and never run. Caught while arming; feature-bot's knob was renamed to `MAX_HANDOFFS` so the units can't be confused again, and `bots/cut-planner/tests/budget-coherence.test.ts` drives a failing cut through both bots' real decision functions to pin the lifecycle.

**Cut 6 cannot be validated from organic traffic.** Reaching the refinement branch requires a cut that exhausted its attempts on *substantive* reviewer rejections — and feature-bot has delivered zero cuts to date, so that may not occur for a long time. Cut 6's acceptance therefore uses a **deliberately labelled test issue**: apply `needs-refinement` by hand to a throwaway cut sub-issue carrying a plausible reviewer note, and confirm cut-planner picks it up, revises the body, and swaps the label back. Waiting for the organic case would leave the path unexercised indefinitely.

**The label is a prerequisite, not a side effect.** `needs-refinement` was created 2026-10-04 (`#5319e7`, *"Spec needs revision by cut-planner; excluded from feature-bot's queue"*). It had to be created explicitly because GitHub's `addLabels` API **auto-creates** a missing label with a random colour and no description — so arming without this step would have produced an undocumented grey label on first use, which is worse than a failure because it looks intentional.

## Validation gate

- Cuts 1–2 shipped; a reject-exhausted cut lands in `needs-refinement` with Agent B's note quoted, and **no** skip-list entry is created
- cut-planner files a cut from a seeded planner issue; the body carries at least one transcribed locked decision and names its target files
- **Input contract holds (open-Q 4):** cut-planner completes a full run with no design doc present on disk — proving it reads only the planner issue
- A deliberately under-specified cut gets refined once and then succeeds, with both the refinement and its reasoning visible on the planner issue
- **Feedback-first holds (Q5a):** with a cut sitting in `needs-refinement`, a cut-planner run refines it and files **no** new cut. With a cut still `ready-for-agent` or awaiting PR review, the run files nothing at all.
- An infrastructure failure (rate limit) does **not** route to refinement — the cut stays `ready-for-agent`, and cut-planner escalates nothing
- **Quota never counts toward the budgets (Q6):** a cut quota-killed twice has consumed zero of its 2 refinements and 1 re-decomposition; only budget exhaustion and substantive rejects advance the counters
- **The escalation default holds (Q6a):** an injected unanticipated failure (one matching no example row) still files for a human rather than exiting silently or looping
- **Escalation scopes are distinct (Q6a):** an open design question labels the **planner** issue `needs-info` and halts filing for the feature; an unsalvageable cut labels the **cut** issue `ready-for-human` and leaves the feature able to proceed
- A cut whose edit surface includes `.github/workflows/**` is refused **before** filing, not after a full loop (#840)
- A design question absent from the design doc produces a `needs-info` question, not an invented answer
- Budgets terminate: 2 refinements + 1 re-decomposition → `ready-for-human`
- **Memory is reconstructible (Q7a):** deleting the planner issue's `## State` section and replaying its comment log yields the same state — proving the comments, not the body, are the durable record
- **Two-tier memory works (Q7a):** every run that examines a planner issue appends exactly one `decision-log.jsonl` entry (dry runs append none); the log survives a cache miss without affecting correctness; `lessons-learned.md` is loaded into the prompt and is rewritten (not appended) by `cut-planner:compact`

## Implementation notes

Decisions made while building, recorded here so the doc matches the code (team-preferences rule 8, extended to design docs).

| Topic | Design said | Implemented | Why |
|---|---|---|---|
| Terminal cut escalation | `ready-for-human` + feature-bot skip-list entry | `ready-for-human` + tagged comment, **no** skip-list entry | Writing feature-bot's committed skip-list needs `contents: write`, which cut-planner deliberately lacks (it writes only issues and labels). `ready-for-human` already removes the cut from feature-bot's queue; the tagged comment is the record. |
| One action per run | per run (Q5a) | one action **in total** per run, oldest planner first | Keeps each cron's blast radius to one feature's non-transactional writes, and keeps cut-planner's draw on the shared token bucket to one Claude call. |
| Budget knobs | `MAX_REFINEMENTS=2` in both bots | feature-bot `MAX_HANDOFFS=3`; cut-planner `MAX_REFINEMENTS=2` + `MAX_REDECOMPOSITIONS=1` | feature-bot counts hand-offs, not refinements. See "Arming order". |
| Which cuts are handed off | any reject-exhausted cut | only cuts cut-planner filed (feature-bot checks the cut body for cut-planner's filed tag) | An old-model cut handed off would sit in `needs-refinement`, which cut-planner reads only for features with a planner issue — silent parking (Q6a). |
| Lock transcription (Q2) | "transcribe, never invent" | Claude selects locks **by index**; TS copies the text verbatim | Makes Q2 hold by construction rather than by instruction. |
| Discovery | label query | label query + structural classification (`## Spec` = cut, checked first) | A cut in `needs-refinement` otherwise looks exactly like a planner issue. |
| Other bots | not addressed | discovery-prep-bot skips any issue with `**Feature**:` front-matter | Its queue (`enhancement` minus four labels) matched planner issues and handed-back cuts; researching one applies `ready-for-human` and stalls the feature. Fleet audit found no other collision. |
| Workflow-touching cuts | recorded, not queued | `files` declared by Claude; any path under `.github/workflows/` → filed `ready-for-human` | Claude names expected edits in its structured answer; the check is a path test in TS, not intent inference over prose. |
| "Landed" | not addressed — a closed cut was implicitly done | a cut closed since the planner issue was created counts as landed only if the merged PR that closed it names it (`#N` in the title, `feat/cut-N` branch, or feature-bot's marker); otherwise the feature escalates (`unverified-close`, `needs-info`) instead of filing the next cut. Same check in feature-bot's dependency gate (`dep-unverified`). Shared helper: `bots/_lib/cut-landing.ts` | #517 was closed as completed by #557, an unrelated PR that only mentioned it; its storage never existed and the next cut (#519) kept failing on it. Verified against every completed cut on record before shipping. |
| Malformed planning answer | (Q6a default) | escalate at the narrower scope; a thrown error mid-action is caught and escalated; if even that write fails, the run exits non-zero | Q6a's rule as a default, all the way down. |

## Migration

Existing features have a tracking issue plus **all** their cut sub-issues already filed. cut-planner's model is one planner issue plus cuts filed one at a time. The gap is real: review-workflow alone has 16 open issues under the old shape.

**Migration is per-feature and maintainer-triggered** — no flag day, mirroring how [`design-feature-bot.md`](design-feature-bot.md) Q8 handled the impl-doc retirement. An un-migrated feature keeps working exactly as today: its cuts carry `ready-for-agent`, feature-bot picks them up, cut-planner never sees them (it only acts on features that have a planner issue).

**Per-feature recipe:**

1. Maintainer asks (in Claude Code): *"create the planner issue for `design-{feature}.md`."*
2. Claude opens one planner issue: `**Feature**` + `**Design**` front-matter, `## Suggested plan` copied from the design doc's `## Cut sequence`, `## State` reflecting what has already landed, `## Locked decisions` seeded from the design doc's locks.
3. **Already-filed future cuts are closed**, each with a comment pointing at the planner issue. They will be re-filed one at a time with just-in-time specs — which is the whole point; their current specs were written against predicted code.
4. **A cut currently in flight is left alone.** It finishes under the old model; cut-planner picks up from the next one.
5. The old tracking issue is closed with a pointer to the planner issue.

**Why close rather than relabel the pending cuts:** their bodies are the stale artifact. #519 is the worked example — filed in June with *"Resolve open-Q #2 here"*, a spec that could not be built from until the decision was locked four months later. Relabelling would preserve exactly what this design exists to replace.

**What is NOT migrated:** closed/landed cuts stay as they are (git history + closed issues are the record per [ADR-0015](../../docs/adr/0015-impl-doc-artifact-retires.md)). The design doc's `## Cut sequence` table is untouched — it remains maintainer-owned intent, and is the source the planner issue's advisory plan is copied *from*.

**Ordering:** migrate one low-activity feature first and let it complete end-to-end before migrating others. review-workflow is the obvious *second* candidate (it has the most cuts, so the most to gain) but a poor first one for the same reason — a failed migration there strands 16 issues.

**Rollback:** re-open the closed cut sub-issues and the tracking issue, close the planner issue. Nothing is destroyed; the cuts' original bodies survive in issue history.

## Open questions

1. ~~**Quota.**~~ **Resolved 2026-10-04: off-peak cron, no code.** cut-planner runs at **03:00 UTC** — before feature-bot's 04:17, and at an hour the maintainer is not consuming the shared 5-hour bucket. No pre-call budget check, no quota awareness in v1.

   Rationale: the contention is *temporal*, not architectural. Both 2026-10-03/04 runs were starved because an interactive session was burning the same bucket; a cron that runs while nobody is working has no one to contend with. A pre-call budget check was considered and rejected for v1 — it converts a mid-flight cutoff into a clean skip but *creates no capacity*, and it needs a remaining-quota signal the CLI does not currently expose.

   **Dependency:** this only works if cron actually fires. The 04:17 feature-bot cron silently did not fire on 2026-10-03 (verified — no `schedule` event in the run list, only `workflow_dispatch` and `push`). Diagnosing that is a prerequisite, not a nice-to-have, and is tracked separately from this design.

   **Amended 2026-10-24: cut-planner runs in the night shift.** Feature-bot now runs every night (`design-feature-bot.md`), and bot PRs are reviewed daily, so `night-shift.yml` runs cut-planner up to four times (one per planner, each with Q5a's single action) right before feature-bot, stopping at the first run that takes no action. A cut merged during the day gets its successor implemented that night. The 03:00 UTC cron stays as a morning backup. The night shift reads the account's 5-hour and weekly usage before each run (`rate_limit_event` in stream-json), the signal this resolution said the CLI lacked.

   Decided: maintainer, 2026-10-24 (#NNNN)

   | Rejected | Why |
   |---|---|
   | Evening crons | GitHub starts scheduled runs two to five hours late, so the timing is unreliable |
   | Unchanged (03:00 UTC) | One filing a day, in the morning: a cut merged during the day waits until the next morning for its successor |


2. **Single point of failure.** Under this design the queue stalls if cut-planner stalls, whereas today feature-bot can run for weeks with no upstream. Acceptable? Or should the maintainer retain a manual "file the next cut" path?
3. ~~**Workflow-touching cuts (#840).**~~ **Resolved 2026-10-04:** cut-planner assigns them to a human immediately. It does not file the cut for feature-bot at all — it opens the cut issue with `ready-for-human` and a comment explaining that `GITHUB_TOKEN` cannot push `.github/workflows/**` (no permission grants it) and that the work needs a manual PR until #336 lands. Rationale in Q6a: run 37152238559 reached `APPROVED on attempt 1/5` before the push failed, so a full generator-critic loop was spent on work that provably could not be delivered. The cut is still *recorded* (so the feature's plan stays complete and the maintainer sees what is outstanding) — it is just never queued for the bot. Detection depends on the cut's declared edit surface; see "Future directions" on the `## Files` section.


4. ~~**Most design docs have no `## Cut sequence` to seed from.**~~ **Resolved 2026-10-04: the maintainer seeds; the bot never parses design docs.**

   Measured first (2026-10-04): of 32 design docs excluding `-implementation`/`-reference` companions, **4** have a `## Cut sequence` section, **20** still keep their cuts in a `design-{feature}-implementation.md` (the artifact [ADR-0015](../../docs/adr/0015-impl-doc-artifact-retires.md) retired but never migrated wholesale), and **8** have neither. `design-scheduling.md` is a concrete case: 12 cuts, all in its impl doc.

   Lock: **cut-planner's only input is the planner issue.** It never reads a design doc or an impl doc. Seeding is maintainer work via Claude Code, which reads whichever artifact exists and writes the planner issue by hand.

   Why: cut-planner's input contract stays exactly one shape, so no parser for a retired artifact enters bot code, and all 32 features are migratable today rather than being gated behind 20 doc migrations. It also means the `## Suggested plan` in a planner issue is *already* normalized by the time the bot sees it — the variability lives in a human-assisted step, where it belongs (producer/consumer rule).

   Consequence: the `## Locked decisions` section is likewise maintainer-seeded. cut-planner may transcribe from it (Q2) but cannot discover new locks on its own — if the design doc gains a lock mid-feature, the maintainer adds it to the planner issue.


5. **Does refinement actually rescue cuts?** CORAL argues the ordering conceptually and gives no success-rate numbers. n=1 locally (#519, hand-fixed). Cut 5's acceptance is the first real measurement.
6. ~~**Interaction with the pre-flight size gate.**~~ **Resolved 2026-10-04: no size gate. Re-decomposition only.**

   The proposal was to refuse cuts above a declared edit-surface threshold (≤2 files / <50 lines, from [SWE-Bench Mobile](https://arxiv.org/html/2602.09540v1): 18% success at 1–2 files vs 2% at 7+; 20% under 50 lines vs 3% over 200). Dropped.

   Why: the thresholds come from 50 tasks on a production **iOS** codebase across four other agents — not from this repo, this bot, or these cuts. Calibrating a hard gate on borrowed numbers would block cuts that would have landed (#519 names 7 files in its body but edits **2**, so even measuring the input is unreliable without a `## Files` section), and it would spend design effort on the dimension that has been the attractive wrong answer four times this session. cut-planner already shrinks cuts *reactively* when the loop actually fails (Q6), which acts on evidence from this codebase instead of a benchmark.

   Retained from the proposal: the `## Files` section stays in "Future directions" because the #840 workflow check needs a reliable edit surface regardless. If it ships, the success-rate data becomes something to calibrate against — at which point an **advisory** warning (not a gate) is the cheap next step.

