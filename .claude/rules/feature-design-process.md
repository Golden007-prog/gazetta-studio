# Feature Design Process

How Gazetta approaches feature design and implementation. Written so a new contributor (human or LLM agent) can pick up cold and follow the same workflow.

This is the resumability contract: **every kind of work we do has a designated durable artifact**. If a session ends without producing the right artifact, the work is lost.

## The phases of feature work

Five phases: Discovery → UX-grilling → Implementation-grilling → Design → Implementation → Retrospective. The grilling phase splits into two passes (UX first, implementation second) per [team-preferences rule 23](team-preferences.md) (UX as a permanent lens) + [rule 24](team-preferences.md) (5K-envelope validation): UX surface and implementation surface have distinct concerns and benefit from being grilled separately. Implementation grilling sits behind a 5K-envelope gate.

### 1. Discovery

Understand the problem. Read existing design docs, audit competitor approaches, talk to users, read the relevant issues. Identify what's actually being asked and what's tangential.

When the design is motivated by a suspected bug, **reproduce the bug before locking the design.** A design locked on a read-only diagnosis is a hypothesis: #963 locked owner-tagged cache snapshots from reading code; a two-tab reproduction the same day showed snapshots overwrite each other, and #966 replaced the design with a draft store.

For features with significant UX surface, Discovery includes UX-specific research per [team-preferences rule 27](team-preferences.md) (assertion provenance):
- Inspect 3-5 competitor implementations of the same UX (with screenshots — fact-check claims per rule 20)
- Identify which actor types the feature affects (Content Author / Template Developer / Operator / CMS Developer per [`CONTEXT.md`](../../CONTEXT.md))
- Walk the relevant scenario(s) from `docs/actor-scenarios.md`

**Durable artifact**: usually none — discovery feeds into grilling. If the discovery is large enough to be reusable (e.g., a CMS feature audit, a competitor analysis), capture it as a research doc under [`docs/audits/`](../../docs/audits/).

### 2a. UX-grilling

Dedicated grilling pass for the user-facing surface — independent of implementation grilling. Walk the UX questions before walking the implementation questions, so UX choices aren't compromised by implementation convenience.

UX questions to grill:
- **Which actors does this feature affect?** (Per `docs/actor-scenarios.md`. Many features touch multiple actors with different needs — the publish dialog is Operator surface; the page tree is Content Author surface; the template manifest is Template Developer surface; the plugin contract is CMS Developer surface.)
- **What user flow does each actor walk through?** Sketch the screens / clicks / decisions in order. The flow IS the UX; absent a flow, every later UX Q is intuition-shipped.
- **What's the "absence-as-state" default?** Per Krug rule 23 — every indicator, modal, badge, banner is a candidate for "what if it weren't there?"
- **What's the failure mode UX?** What happens when validation fails, when the network drops, when permissions deny, when concurrent edits conflict? Failure UX is where most CMSes fall short.
- **What does the operator see vs. what does the author see?** Capability-gap surfaces (per locked principle in `feature-design-process.md` non-foundational disciplines) — boot validate / author modal / scanner / publish gate.
- **What can be removed?** Per Krug. Three iteration cycles of "what can I remove?" routinely cut UI surface 30-60%.

The grilling pattern is the same as Phase 2b (one Q at a time, alternatives + recommendation, await confirmation), but the Qs are UX-focused. UX research from Discovery feeds the Q list.

**Durable artifact**: UX decisions land in `design-{feature}.md`'s "UX check" section (already part of the design doc per Phase 3 below). Detailed layout/copy/icons can be deferred to a focused UX research pass produced before implementation cuts that need them — see `design-scheduling.md` Q6 lock for the pattern. The deferral is honest documentation that "we have structural locks but not detailed UX yet."

### 2b. 5K-envelope gate

Before Implementation-grilling, validate the proposed UX flows against [team-preferences rule 24](team-preferences.md): every primitive holds at the 5K-page envelope per `design-scale.md`.

Walk the design's primitives:
- **Identify each cross-cutting check** the UX flow requires (e.g., "find archives whose `aliasOf === X`" for purge-blocked).
- **For each, ask: does this scale to 5K pages?** O(N-pages) walks at request time or on hot paths fail the gate. The fix is per-edge sidecars (`asset-refs`, `fragment-deps`, `archive-aliases` pattern per [`sidecars.md`](sidecars.md)).
- **Gate criteria** (any failure means re-design before Implementation-grilling):
  - Synthetic-site benchmarks at 5K hold under 5-second admin SLA
  - No O(N-pages) walks at request time / on hot paths (sidecar required)
  - No publish-time aggregate manifests (per `feature-design-process.md` non-foundational disciplines — sidecars OR external-standard exception only)
  - Multi-instance discipline holds (per-edge state, not in-memory cross-instance cache)

**Durable artifact**: the design doc's "Foundational checks" section explicitly answers the **Scale check** with named primitives + their walk costs + sidecar requirements. Cuts that need new sidecars are flagged in the design doc's `## Cut sequence` section (and the corresponding cut sub-issue's `## Spec` when filed).

### 2c. Implementation-grilling

Walk the technical design tree — architecture, data model, lifecycle, multi-instance, cache, audit, hooks, validation, render, plugin, offline, collaboration. Resolve one Q at a time per the grilling pattern.

Implementation grilling is allowed to push back on UX choices that are technically expensive — but the pushback goes back to UX-grilling, not absorbed silently. "We can't do X because the architecture..." is the right warning sign that the UX needs revisiting.

**Durable artifact**: a design doc — see Phase 3.

### 3. Design

Capture what we're building, why, and the model.

**Durable artifacts** (this is the contract):

| File | Purpose | Required? |
|---|---|---|
| `.claude/rules/design-{feature}.md` | The design itself: scope, principles, model, distinctive choices, **cut sequence**, deferred items, lessons learned | **Required** |
| GitHub tracking issue + N cut sub-issues | Operational state for in-flight cuts (filed from the design doc's `## Cut sequence` section per [`docs/adr/0015-impl-doc-artifact-retires.md`](../../docs/adr/0015-impl-doc-artifact-retires.md)) | **Required for in-flight work** — filed when implementation starts |
| `.claude/rules/design-{feature}-reference.md` | Optional: fact-checked tooling specifics, library versions, citations | Optional — used when ≥ 5 external claims need version/licensing/citation; below that, inline citations in the design doc are clearer (see media-v1 for an example that warranted it) |
| `docs/adr/NNNN-slug.md` | Architecture Decision Record | Optional — only when the decision passes the three ADR criteria (hard to reverse, surprising without context, real trade-off) |

**Required sections in a `design-{feature}.md`:**

- **Scope** — what's in v1.X, what's out, what's a non-goal
- **Companion docs** — link to implementation + reference + ADRs
- **Design model / architecture** — the actual structure
- **Distinctive choices** — what we picked vs. what we rejected, with reasons. Future-you re-litigates without these.
- **Foundational checks** — answer each of the 13 dimension gates (Scale / Theme / Locale / Auth+RBAC / Audit / Review / Hook / Render / Validation / Plugin / Cache / Offline / Collaboration) AND the **Multi-instance check** (see "Foundational dimensions" + "Non-foundational disciplines" below)
- **UX check** (when feature has user-facing UI) — design must apply "Don't Make Me Think" principles per [team-preferences rule 23](team-preferences.md): absence-as-state, universal icons over jargon, same affordances regardless of system state, plain language, no help-tooltips-as-bandaid. Reference `design-offline.md`'s sync-state visibility section as the canonical example.
- **Cut sequence** — declarative table of cuts that Phase 4 fans out into GitHub sub-issues. Five columns: `#, What, Depends on, Test tier, Risk`. **No status column** — state lives in GitHub sub-issue close-state per [`docs/adr/0015-impl-doc-artifact-retires.md`](../../docs/adr/0015-impl-doc-artifact-retires.md). See `design-feature-bot.md` and `design-redirect-ui.md` for example tables.
- **Migration** — for existing sites if applicable
- **Open questions** — known unresolved items
- **Future directions** — placed at the end. Lists deferred capabilities, v1.5/v2 bets, and frontier ideas that aren't committed work. Above-the-section content is the current shipped/being-built model; below-the-section content is preserved thinking, not a promise. As versions ship, items rotate up into committed scope.

**Cross-referencing convention:**

- The "Companion docs" block (placed after "Scope") lists the impl doc, reference doc (if it exists), and any ADRs that sit under this feature. Format: `- [name](relative-path) — one-line description`. Tells a cold reader which docs travel together.
- Cross-feature references in body prose use relative paths (e.g., `[design-ai.md](design-ai.md)`, not the full project-relative path). Inline at point-of-use; no bottom-of-doc "Related" section — body links stay correct as long as the body is correct, without a parallel index to maintain.

**Keeping design docs aligned with reality:**

When an implementation cut diverges from its design, the design doc is updated in the same commit as the diverging code. Two paths, both made at PR review (never deferred):

- **Design was wrong** — fix the design doc to reflect the better approach. Call out the change in the commit message.
- **Cut deviated for tactical reasons** — the design stays correct; the deviation goes into a "Current code alignment" subsection of the design doc, which becomes a punch list to reconcile or accept later (`design-publishing.md` is the reference example).

This extends [team-preferences rule 8](team-preferences.md) ("update docs in the same commit as the feature") from user-facing docs to internal design docs. Drift is a bug, caught at PR review; not a long-term decay problem to audit later.

**CONTEXT.md update trigger:**

Per the `grill-with-docs` skill (`~/.claude/skills/grill-with-docs/SKILL.md`), terms land in `CONTEXT.md` inline as they're resolved during grilling — captured when they crystallise, not batched. The filter is "meaningful to a domain expert" (Page, Fragment, Active Target — yes; `ComponentManifest`, `ResolveContext` — no, those are implementation type names, not domain language). Follow the skill's rule rather than layering a project-specific convention on top.

Renaming or removing a glossary term is itself an ADR — rename is by definition hard-to-reverse + surprising-without-context.

**The `design-{feature}-implementation.md` artifact type is retired** per [`docs/adr/0015-impl-doc-artifact-retires.md`](../../docs/adr/0015-impl-doc-artifact-retires.md). Cut tracking lives in GitHub (tracking issue + cut sub-issues); the design doc carries the durable Cut sequence + Deferred items + Lessons learned. See "Migration of legacy implementation docs" below for handling existing impl docs.

**Naming convention**: `design-{feature}.md`. The prefix matters — it makes `grep .claude/rules/design-*.md` find every feature design.

Two predecessor docs use the `-plan.md` suffix (`seo-plan.md`, `testing-plan.md`) and fuse design + implementation into one file. They migrate to the `design-{feature}.md` shape (with a Cut sequence section + tracking-issue + sub-issues for any remaining work) when the feature is next touched — splitting them cold without active context risks a bad split. Until then they stay as-is and remain auto-loaded via their `paths:` frontmatter. (`i18n-plan.md` was migrated to `design-i18n.md` in 2026-05 as part of the foundational-dimensions inventory; the cut tracking moves to GitHub when per-field translation #192 lands.)

### 4. Implementation

Ship in cuts via a GitHub **tracking issue** + N **cut sub-issues** per [`docs/adr/0015-impl-doc-artifact-retires.md`](../../docs/adr/0015-impl-doc-artifact-retires.md). The design doc's `## Cut sequence` section (see Phase 3 below) is the intent; GitHub sub-issue close-state is the operational state.

**Pre-filing cut audit.**

Before filing cuts as sub-issues, walk the impl doc (or design doc's `## Cut sequence` table) and audit each cut for bot-readiness. The audit catches gaps that would otherwise surface as feature-bot's `NEEDS_INPUT` cycles or wasted attempts.

Per-cut audit checklist:
- **Scope size**: rough LOC estimate. <500 LOC = clean for one PR. >1000 LOC = consider splitting before filing.
- **Open Qs in impl doc**: any unresolved Qs that the bot would have to make judgment calls on? Each open Q is a NEEDS_INPUT cycle (24h cron + maintainer answer). Pre-grill: promote impl-doc `Recommendation:` lines to locks, OR resolve the Q inline in the sub-issue body's `## Spec`. Don't ship cuts with bot-facing open Qs.
- **Judgment-heavy specs**: cuts whose entire tests section is "Open questions" (e.g., the original Cut 5 of redirect-ui — "edge case: from-route is `home` — what's the UX?") are NOT implementation cuts; they're grilling cuts. Either re-grill them into concrete decisions OR fold them into adjacent cuts that have concrete server-side / UI rules to implement.
- **Test specificity**: does the cut spec name specific test files and behaviors, or is it vague? Per [team-preferences rule 31](team-preferences.md) + the design-doc Cut sequence Q9 lock, the sub-issue's `## Tests` section names actual test file paths and behaviors. Vague test sections create tautological-test risk.
- **SOLID applicability**: pure-data-shape or pure-docs cuts: `## SOLID` is N/A. New interfaces / module boundaries / abstractions: `## SOLID` is REQUIRED — name the load-bearing lens.

Output of the audit: pre-grilled list of Qs to promote-to-lock, pre-flagged cuts to fold, locked specs ready for filing. The redirect-ui migration (2026-06) was the first to apply this audit and surfaced its rules — it caught the original Cut 5 ("Conflict UX edge cases" — judgment-heavy) and folded its rejections into the actual Cut 3.

**When to fold cuts.**

Some impl-doc cuts are best folded into adjacent cuts during the migration rather than filed as standalone sub-issues. Signals that justify folding:
- The impl doc itself says "may fold into Cut N" or similar deferral language
- The cut's entire scope is judgment calls / edge cases / "verify the existing pattern" work
- The cut's tests are open questions, not concrete behaviors to pin
- The cut would mostly modify the same files as an adjacent cut (revertability per [team-preferences rule 17](team-preferences.md) isn't compromised by folding when the work is naturally co-located)

When folding, name the absorbed scope explicitly in the target cut's `## Spec` ("absorbs old Cut N's edge-case rejections"). Future readers see the consolidation in one place. The redirect-ui migration folded its impl-doc Cut 5 (edge-case rejections) into the actual Cut 3 routes work — `home` and `[param]` rejections became 400-INVALID branches in the route handler rather than a standalone "edge case UX" cut.

**Planner-issue flow** (default for new features — see [`design-cut-planner.md`](design-cut-planner.md)):
1. Maintainer asks (in Claude Code): "create the planner issue for `design-{feature}.md`."
2. Claude opens ONE planner issue, labelled `enhancement` + `area: X` and deliberately **without** `ready-for-agent`. The `enhancement` label is required: without it triage-bot would try to classify the issue. Body shape:
   ```markdown
   **Feature**: <slug>
   **Design**: .claude/rules/design-<slug>.md

   ## Suggested plan
   <the design doc's ## Cut sequence table — advisory; cut-planner may deviate, with a recorded reason>

   ## State
   <what has already landed; empty for a new feature>

   ## Locked decisions
   - <one bullet per decision cut-planner may transcribe into cut bodies — copied from the design doc's locks>
   ```
   Seeding is maintainer work: cut-planner reads ONLY this issue, never the design doc, so it works whether the design doc has a `## Cut sequence` section or the cuts still live in a retired implementation doc.
3. From then on, cut-planner files one cut at a time (cron 03:00 UTC), revises cuts feature-bot hands back in `needs-refinement`, and escalates to a human — `needs-info` on the planner issue for a feature-level block (e.g. a design decision the planner issue doesn't lock), `ready-for-human` on a cut for a cut-level one. When a decision is made mid-feature, add it to `## Locked decisions` yourself: cut-planner transcribes locks, it never discovers or invents them.
4. Close the planner issue when the feature is done (cut-planner says so with a `plan-exhausted` escalation).

**One cut filed directly** (a single cut of an already-designed feature, outside cut-planner — e.g. a follow-up found in PR review):
- File it with the cut-sub-issue template in the [`review-prs` skill](../skills/review-prs/SKILL.md) ("Issue body template", feature-bot variant): `enhancement` + `ready-for-agent` + `area: X`, `**Feature**:` + `**Depends on**:`, and `## Spec` / `## Acceptance` / `## Tests` (+ `## SOLID` for new interfaces/modules). A missing section gets a `body-error` comment + `needs-info` and the cut never runs.
- `**Feature**:` must name a real `.claude/rules/design-{slug}.md`: both agents read it first, and the validator only checks the line exists.
- The spec must leave no design decision open and must name the real target files — nothing checks for an open decision the way cut-planner does (#519 and #526 shipped with them and failed).
- If it fails, it goes straight to `ready-for-human`. Only cuts cut-planner filed are handed back for spec refinement.
- **If the feature has a planner issue, don't file a cut directly** — add the work to the planner issue's `## Suggested plan`. A directly filed cut can't be refined, and cut-planner treats it as in flight, so the feature's queue waits until it closes.
- One-off work with no design doc is not a cut: file it for fix-bot as `bug` + `ready-for-agent` (team-preferences rule 40).

**Up-front filing** (legacy — features whose cuts were all filed before cut-planner existed; migrate per `design-cut-planner.md` "Migration"):
1. Maintainer asks (in Claude Code): "open cuts for `design-{feature}.md`."
2. Claude reads the design doc's `## Cut sequence` table.
3. For each row, Claude renders a cut sub-issue body (just-markdown shape — see [`design-feature-bot.md`](design-feature-bot.md) Q2) with `**Feature**:` + `**Depends on**:` front-matter, then four sections: `## Spec`, `## Acceptance`, `## SOLID`, `## Tests`.
4. Claude opens N cut sub-issues (labeled `enhancement` + `ready-for-agent` + `area: X`) + one tracking issue (labeled `enhancement` + `area: X` — NO `ready-for-agent`, so feature-bot ignores it) whose body is a tasklist of the sub-issues.
5. **Claude links each cut sub-issue as a native sub-issue of the tracking issue via the GraphQL `addSubIssue` mutation.** The markdown tasklist alone does NOT establish parent/child relationship — it renders checkboxes but doesn't auto-check on issue close, and GitHub's "Sub-issues" panel stays empty. Required command per cut sub-issue:
   ```bash
   gh api graphql -f query='mutation { addSubIssue(input: { issueId: "<parent-node-id>", subIssueId: "<child-node-id>" }) { subIssue { number title } } }'
   ```
   Get node IDs via `gh api graphql -f query='{ repository(owner:..., name:...) { issue(number: N) { id } } }'`. The mutation is idempotent — re-running on already-linked sub-issues is safe. The redirect-ui migration (2026-06) was the first to surface this gap — the original tracking issue #451 carried a markdown tasklist but its Sub-issues panel was empty until the `addSubIssue` calls landed.
6. Tracking issue auto-closes when all sub-issues close.

**Cut sub-issue body sections** (the per-cut spec contract that feature-bot's Agent A consumes):

```markdown
**Feature**: <slug>
**Depends on**: #N, #M  (or empty/none)

## Spec
<narrative — what to build, linking design-{feature}.md>

## Acceptance
<bullet list of testable outcomes>

## SOLID
<which SOLID lenses this cut commits to (SRP / OCP / LSP / ISP / DIP),
with a sentence per applicable lens. Required for cuts touching new
interfaces, new module boundaries, or new abstractions. Optional for
pure-data-shape or pure-docs cuts where SOLID is N/A.>

## Tests
<bullet list of specific test files to add + behavior they pin.
Goes deeper than the Cut sequence table's Test tier column —
"api-first" is the tier; this section names the actual test files.>
```

`## SOLID` and `## Tests` close the gap from retiring `design-{feature}-implementation.md` — the old impl-doc required per-cut SOLID checks and tests in its status table. The new shape keeps those commitments at the sub-issue level (where Agent A reads them) rather than the table level (which stays at five columns for index-readability).

Required vs optional:
- `## Spec` and `## Acceptance` — always required (Agent A's "fail-loud-on-vague-spec" path closes the cut if missing or vague).
- `## SOLID` — required for cuts introducing new interfaces, modules, or abstractions; optional for pure-data-shape or pure-docs cuts where SOLID is N/A.
- `## Tests` — always required (rule 31 TDD-first ordering depends on naming the test files at design time, not implementation time).

**Per-cut work** (whether shipped by feature-bot or maintainer-driven via Claude Code):
- One PR per cut. The PR references the sub-issue via `Fixes #N`; merging the PR closes the sub-issue and ticks the tracking-issue tasklist.
- Each cut is independently rollback-able (per [team-preferences rule 17](team-preferences.md)).
- Each cut has explicit SOLID checks (per [team-preferences rule 18](team-preferences.md)).
- Tests + docs land in the same PR as the cut.

**Feature-bot's role**: feature-bot picks the next unblocked cut sub-issue (oldest-first among those whose `**Depends on**:` refs are all closed) and ships one PR per cut. See [`design-feature-bot.md`](design-feature-bot.md) for the full bot contract.

**The consolidation cut.**

Every feature migration ends with a consolidation cut — the implementation-doc-retirement work itself. This cut:
- Depends on all prior bot-driven cuts (so it ships LAST)
- Migrates `## Deferred items`, `## Validation gate`, and surviving open Qs from impl doc → design doc per [`docs/adr/0015-impl-doc-artifact-retires.md`](../../docs/adr/0015-impl-doc-artifact-retires.md)
- Adds the `## Cut sequence` table to the design doc per the Q9 lock in [`design-feature-bot.md`](design-feature-bot.md)
- Replaces impl doc contents with a one-line pointer to the design doc
- Optionally amends `feature-design-process.md` if the migration surfaced new process gaps (as Cut 7 of redirect-ui did with the `addSubIssue` and audit-checklist additions in this section)

The consolidation cut is filed as `enhancement` + `ready-for-agent` like any other cut. Feature-bot picks it up; maintainer reviews the docs PR.

**At ship time** (final cut merges):
- "Deferred items" + "Lessons learned" land in `design-{feature}.md` (the durable artifact) — these previously lived in the implementation doc.
- Cut-by-cut detail stays as git-log history (recoverable via `git log --grep="<feature-tag>"`).
- The tracking issue closes; the design doc's Cut sequence section becomes the documentary record of "how this feature was decomposed and why."

**Durable artifacts**: code + commit messages + closed sub-issues + closed tracking issue + design-doc updates (Deferred items, Lessons learned).

### 5. Retrospective

After the feature is done (or at significant milestones in a long-running feature), review the session for new learnings. Two failure modes the retrospective catches:

- **Patterns that worked but weren't named.** "We split UX-grilling from impl-grilling and it caught X" is a learning that dies if not captured.
- **Patterns that failed quietly.** "We shipped Q5's lock without grilling alternatives and Cut N hit the constraint" is a learning that recurs across features unless captured.

The retrospective surfaces these explicitly:
- What worked? Specific decisions or practices that produced good outcomes.
- What didn't? Specific patterns that produced rework or surprise.
- What should become a durable rule? New entry in `team-preferences.md`, update to this doc, or new ADR.
- What should change in the next feature's process? Concrete adjustment to apply going forward.

**Durable artifact**: the new rule(s) themselves, or the doc updates. The retrospective conversation itself is ephemeral — what matters is what the conversation produces. Per [team-preferences rule 22](team-preferences.md) ("every kind of work has a durable artifact home; if a session ends without producing it, the work dies").

The session that produced rules 24-27 was retrospective in shape — the four rules (5K envelope, design grilling, test isolation, assertion provenance) all came from "what did we learn from this feature?" Without locking them durably, they would have died with the conversation.

**When to run a retrospective:**
- After a feature ships fully
- At significant feature milestones (e.g., halfway through a 15-cut sequence, especially if the design surface is shifting)
- When a session ends with multiple "we should remember X" observations
- When the user asks "what did we learn?" — the rule is to take the question literally and produce durable output, not just verbal reflection

## Grilling pattern (the operational details)

When grilling someone (or being grilled by Claude), the pattern is:

```
Q1: [structural question with three options]
    Recommend: B because [reasoning]
[user agrees / pushes back / asks for alternatives]

Q2: [next question, dependent on Q1's answer]
    ...
```

Rules:
- **One question at a time** — bundling questions loses focus
- **Always present alternatives** — at least 2-3 options per question
- **Always recommend** — never ask "what do you think?" without a position
- **Reasoning is mandatory** — not just "I prefer B" but "B because..."
- **Capture as you go** — when a term is resolved, update CONTEXT.md inline; when a decision is made, capture in the design doc
- **End with a Q-final on Cut sequence** — every design pass concludes with the cut-sequence Q. For each cut, lock:
  - Position in sequence + dependencies
  - Test tier (per `testing-plan.md` "Shape per sub-system": `unit-first`, `api-first`, `integration-first`, `e2e-first`, `component`)
  - Risk gradient (low / medium / medium-high / high)
  - **SOLID lens** (per cut where applicable — which principle is load-bearing for this cut's structure; lands in the sub-issue body's `## SOLID` section)
  - **Specific tests to write** (file paths + behavior they pin; not just the tier; lands in the sub-issue body's `## Tests` section)

  Output is the design doc's `## Cut sequence` section per [`docs/adr/0015-impl-doc-artifact-retires.md`](../../docs/adr/0015-impl-doc-artifact-retires.md): five-column markdown table (`#, What, Depends on, Test tier, Risk`), **no status column** (state lives in GitHub sub-issue close-state) and **no SOLID/Tests columns** (per-cut SOLID + Tests detail lives in the sub-issue body, not the table; the table is the index, the sub-issue body is the implementable spec). Generating cuts ad-hoc at filing time skips the grilling rigor; locking them in the design doc makes the decomposition a design decision, not an implementation guess.

The skill that codifies this: `grill-me` and `grill-with-docs` in `~/.claude/skills/`.

## Where decisions live

Two tiers, per `~/.claude/skills/grill-with-docs/ADR-FORMAT.md`:

- **Feature-scoped decisions** → "Distinctive choices" section in `design-{feature}.md`. The bulk of design rationale.
- **Load-bearing decisions** → `docs/adr/NNNN-slug.md`. Reserved for the few that pass the ADR criteria.

ADRs are warranted only when ALL three are true:

1. **Hard to reverse** — meaningful cost to change later
2. **Surprising without context** — future reader will wonder "why on earth did they do it this way?"
3. **Result of a real trade-off** — there were genuine alternatives

The skill's `ADR-FORMAT.md` lists what qualifies in concrete terms (architectural shape, technology lock-in, boundary decisions, deliberate deviations from the obvious path, constraints not visible in code, rejected alternatives where the rejection is non-obvious). Refer to it when deciding.

Most decisions don't pass this bar. The design doc carries the rationale; ADRs are the durable backstop for the load-bearing few. Example: [`docs/adr/0015-impl-doc-artifact-retires.md`](../../docs/adr/0015-impl-doc-artifact-retires.md) — the artifact-shape decision retiring `design-{feature}-implementation.md` in favor of GitHub tracking-issue + cut-sub-issues. Passes all three criteria: hard to reverse (migrating sub-issues back to markdown tables has bounded but real cost), surprising without context (future readers wonder why the impl-doc artifact disappeared), real trade-off (alternatives walked: impl-doc walker, hybrid, any-open-issue).

**Legacy:** `design-decisions.md` (18 entries) predates this two-tier model. Treat it like the `-plan.md` predecessors — lazy migration when a relevant feature is next touched: entries either move to that feature's "Distinctive choices" section or get promoted to ADRs. No new entries land in `design-decisions.md`.

## Foundational dimensions

Thirteen cross-cutting concerns that every feature design must respect. Each has its own design pass (some shipped, some pending) and corresponds to a check in the "Foundational checks" section of every new `design-{feature}.md`.

The dimensions are foundational because designing a feature without respecting them is structurally expensive to retrofit later — same principle as locale, themes, validation. These are the "must be right from the beginning" concerns.

| Dimension | Design doc | Gate | What every feature answers |
|---|---|---|---|
| Scale | `design-scale.md` | **Scale check** | Does this feature work at the documented operating envelope (target N pages / M assets / K components-per-page)? If not, what's the limitation? |
| Themes | `design-themes.md` | **Theme check** | Does this respect the closed dimension set (locale + theme) and the locked locale-priority cross-dimension fallback? If pages/fragments aren't theme-variant yet but this feature will need them, what's today's contract vs. later? |
| Locale (i18n) | `design-i18n.md` | **Locale check** | Does this respect locale as a closed dimension peer to theme? Does it use file-suffix locale variants (existing whole-file model) or layered overlays (per-field, future)? RTL coverage? |
| Auth + RBAC | `design-auth-rbac.md` | **Auth/RBAC check** | How does this feature gate on roles? What capabilities does it require? How does it consume the `Principal`? |
| Audit | `design-audit.md` | **Audit check** | What audit events does this feature emit? How does it compose with `AuditProvider`? |
| Review workflow | `design-review-workflow.md` | **Review check** | Does this feature flow through the review state machine? What capabilities does it use (`review:submit`, `review:approve`, `publish:approve`)? |
| Hooks | `design-hooks.md` | **Hook check** | When does this primitive fire hooks? With what payload? Synchronous (can fail/cancel) or async? |
| Rendering modes | `design-rendering.md` | **Render check** | Which rendering modes does this support (static / ESI / request-SSR / island)? What's the limitation for unsupported modes? Does it expose render-time queries (listings)? |
| Validation | `design-validation.md` | **Validation check** | Does this feature need a Validator? When does it run (save-delta / background / pre-publish / cli)? What severity? |
| Extension surfaces | `design-plugins.md` | **Extension check** | If this surface is operator-extensible, does it follow either (a) factory-call-at-field for Provider surfaces (per [ADR-0008](../../docs/adr/0008-provider-factory-returns-instance.md)) or (b) contribution-array (`admin.{hooks,validators,routes}: Contribution[]`) for aggregate surfaces (per [ADR-0009](../../docs/adr/0009-no-plugin-runtime-factory-contributions.md))? If not an extension surface, N/A. **Note**: there is no plugin runtime / `PluginAPI` / `init(api)` lifecycle per ADR-0009; the locked plugin design was collapsed in favor of operator-imported factories. |
| Cache | `design-cache.md` | **Cache check** | Does this feature read or write cached data? Through `AdminCache` (the abstraction)? What invalidation triggers? Per-instance memory cache OK or shared provider needed? |
| Offline | `design-offline.md` | **Offline check** | Does this feature work when admin is offline? Read paths degrade to cache; write paths queue and replay; conflict resolution on reconnect. If feature is online-only, document the limitation. |
| Collaboration | `design-collaboration.md` | **Collaboration check** | Does this feature carry conversation (comments, mentions)? Does it generate notifications? Does it appear in the activity feed? If not collaborative, N/A. |

**Status of design passes (sequenced, per current ROADMAP Tier 2):**

1. Validation Cut 1 (in flight; locks Validator/Issue contract)
2. `design-scale.md` (complete 2026-05; closes #88 + #196)
3. `design-i18n.md` (complete 2026-05; 13 of 15 implementation steps shipped; design/implementation split lands with #192 per-field translation)
4. `design-themes.md` (complete 2026-05; presentation-theming-only scope; pages/fragments stay theme-agnostic at the data layer)
5. `design-auth-rbac.md` (complete 2026-05; unblocks audit + review + hooks)
   - `design-audit.md` (complete 2026-05; extends history-recorder; `AuditProvider` Extension Surface #11)
   - `design-review-workflow.md` (complete 2026-05; per-content state machine + per-target publish approval; depends on auth/RBAC + audit)
6. `design-rendering.md` (complete 2026-05; three target types + worker boundary + dynamic fragment contract; provisional locks on dynamic-side details for follow-up)
7. `design-hooks.md` (complete 2026-05; lifecycle phases + return-new-payload contract + priority-based composition + site-local-plus-plugin discovery)
8. `design-config.md` (complete 2026-05; reference doc — NOT a foundational dimension. TS config (`gazetta.config.ts` + `site.config.ts`) replaces YAML; identity functions; `process.env.X` for secrets; load-once-at-boot in production, hot-reload in dev. Decision in [`docs/adr/0005-typescript-config-format.md`](../../docs/adr/0005-typescript-config-format.md).)
9. `design-plugins.md` (complete 2026-05; TS-import discovery + factory exports + per-surface PluginAPI + service-account opt-in)
10. `design-cache.md` (complete 2026-05; L4 cache in layered model; deterministic-derived principle + explicit per-feature invalidation + sidecar cascades + PWA responsiveness; `MemoryCache` v1 with bounded eviction)
11. `design-offline.md` (complete 2026-05; always-on UX; pending-edits + save-queue distinction; save works offline as commit-intent; IndexedDB primary + MemoryCache fallback; service worker for app-shell; conflict surfaces diff with no force-overwrite; Krug-aligned sync-state visibility)
12. `design-collaboration.md` (complete 2026-05; comments-first v1; mentions; in-admin notifications; `NotificationProvider` Extension Surface #12; 5 capabilities + 6 hooks; per-thread sidecars + etag concurrency)

A feature design started before its required dimension's design pass has shipped MUST document the assumption it's making about the pending dimension's contract — flagged as a retrofit risk. The "Foundational checks" section captures these.

## Non-foundational disciplines

Six narrower invariants that compose with implementation work but don't rise to dimension level. They get one-line discipline notes in this doc, not full design passes:

- **MCP schema discipline** — new admin-API routes must use the existing Zod schema pattern under `packages/gazetta/src/admin-api/schemas/`. MCP tooling auto-generates from these — non-typed routes break MCP. Applies to every new route, not just MCP-aware features.
- **Real-time event-source discipline** — save and publish handlers record write events to audit log (covered by `design-audit.md`). Real-time push (presence, live publish status, validation push) is a separate observer layer on top of audit log — never bolted into save/publish handlers directly.
- **Multi-instance discipline** — every feature must work correctly when admin runs as horizontally-scaled instances (Cloud Run, Fly, Kubernetes, multi-replica deployments). State that affects other instances goes through shared storage with appropriate granularity (per-edge sidecars, content-addressed blobs, atomic writes); in-process caches must be scoped to one operation (per-build, per-request); cross-instance coordination uses storage-as-message-bus, not in-memory channels. Reference: the asset-refs sidecar grilling that locked per-edge files over aggregate JSON specifically because two instances writing to a shared aggregate would race; same logic generalizes. Every new design doc's "Foundational checks" section answers a **Multi-instance check**: where does this feature's state live (per-instance / per-storage / shared in-memory — last is forbidden)?
- **Logging discipline** — every module emits structured JSON logs (no `console.log` in production code), uses dot-separated module namespacing (e.g., `cache.memory`, `plugin.@gazetta/slack-notify`), tags entries with `requestId` for cross-instance correlation, and excludes PII from log payloads (auth tokens, manifest content, comment bodies, asset bytes — all forbidden). Logs are operational signal; audit log is forensic record (per `design-audit.md`); both run. See [`design-logging.md`](design-logging.md) for conventions.
- **No publish-time aggregate manifests** — workers + runtimes read source-of-truth (manifests + per-edge sidecars), never publish-time aggregate JSON files (no `redirects.json`, `archived.json`, `routes.json`, etc.). Aggregates serialize updates through one writer (multi-instance-hostile) and don't scale (every consumer parses N entries on every cold start). Per-edge granularity scales naturally + is multi-instance-correct. **Single exception:** files that exist because external standards demand the format (`_redirects` for Cloudflare/Netlify, `sitemap.xml`, `robots.txt`) — host-glue regenerated each publish from walked manifests, not authoritative state. Reference: `design-soft-delete.md` Q10's HTML-marker-static-plus-per-edge-sidecar-ESI lock made this explicit; the principle generalizes to all foundational features.
- **Capability-gap UX surfaced at four points** — when a feature needs a runtime capability that some configured targets can't provide (archive needing redirects on a worker; presence needing a persistent connection; RBAC content filtering needing per-request rendering), surface the gap at four surfaces uniformly: (1) boot config validation warning when the configured target shape can't support the feature; (2) author-time modal showing per-target capability badges before the action commits; (3) validator surfacing in the site-health drawer; (4) pre-publish gate listing per-target compatibility issues. Keeps operators informed; never silently breaks features. Reference: `design-soft-delete.md` Q10's archive-on-plain-static lock established the pattern; future features needing runtime capabilities (presence, RBAC content filtering, dynamic fragments) inherit it.

## Issue-classification discipline

Every GitHub issue (bug or enhancement) is classified into a ROADMAP bucket at file time:

- **Tier 1** (committed, 4-8 weeks)
- **Tier 2** (planned, next quarter — including foundational design passes)
- **Tier 3** (strategic bet — needs design pass before scoping)
- **Deferred** (real gap, no current trigger)
- **Non-goal** (per `docs/non-goals.md`)
- **Close** (already covered, won't ship, or duplicate)

Unclassified issues are a bug in the process. The retroactive sweep that established this discipline is documented in ROADMAP.md; going forward, every new issue's body should reference its bucket.

## Migration of legacy implementation docs

The `design-{feature}-implementation.md` artifact type is **retired** per [`docs/adr/0015-impl-doc-artifact-retires.md`](../../docs/adr/0015-impl-doc-artifact-retires.md). New features do not produce one; cut tracking lives in GitHub (tracking issue + cut sub-issues) and the design doc's `## Cut sequence` section is the durable intent.

**Existing impl docs** in `.claude/rules/design-*-implementation.md` migrate **maintainer-driven** via Claude Code chat — there is no flag day, and feature-bot does not auto-migrate them (per [`design-feature-bot.md`](design-feature-bot.md) Q8). Un-migrated impl docs are invisible to feature-bot's queue.

**Per-feature migration recipe** (run when the feature is next touched):
1. Maintainer asks (in Claude Code): "migrate `design-{feature}-implementation.md` to tracking + sub-issues."
2. Claude reads the impl doc; for each `☐ pending` cut row, generates a cut sub-issue body in just-markdown shape (per [`design-feature-bot.md`](design-feature-bot.md) Q2). Cuts already `✓ shipped` stay as git-log history and do NOT become sub-issues.
3. Claude opens the tracking issue (whose body is a tasklist of the new sub-issues) and the N cut sub-issues via `gh issue create`.
4. Maintainer absorbs the impl doc's "Deferred items" + "Lessons learned" sections into `design-{feature}.md`, then deletes the impl doc (or replaces its content with a header pointing at the tracking issue, depending on review preference).
5. Maintainer adds (or refines) the `## Cut sequence` section in `design-{feature}.md` so the durable intent matches the filed sub-issues.

**Lifecycle of cut state after migration**:
- Active feature → tracking issue open + some sub-issues open. Design doc carries the Cut sequence intent.
- Feature ships → all sub-issues close → tracking issue auto-closes. Design doc absorbs "Deferred items" + "Lessons learned." Git log carries per-cut history.
- No "implementation doc" exists at any phase — the artifact type is gone.

**Why not auto-migrate**: parsing markdown tables to decide which cuts are still relevant requires maintainer judgment (some rows may be stale; some need re-scoping; some are dead). Bot-generated migration would skip that review step. Maintainer-driven keeps migration honest and bounded.

## Versioning a design doc

`design-{feature}.md` describes the version that's currently shipped or being built. When a successor version is designed:

- **Extension (v1.5 adds capabilities to v1)**: edit `design-{feature}.md` in place. Items from "Future directions" rotate up into committed scope; the design doc absorbs the new capabilities. The v1.5 work gets its own tracking issue + cut sub-issues (no separate implementation doc).
- **Supersession (v2 diverges meaningfully from v1)**: fork the doc. Rename the v1 design to `design-{feature}-v1.md` with a header pointing at the new `design-{feature}.md`. The new file describes v2 from a clean slate. Rare — most version bumps are extensions.

The choice between extension and supersession is a judgment call made when v2 grilling starts, not predicated on a rule. If you're not sure, default to extension — superseded docs are noise unless v1 and v2 genuinely tell different stories.

## Categories of work and their durable artifacts

The full picture:

| Work kind | Durable artifact |
|---|---|
| Feature design | `.claude/rules/design-{feature}.md` (includes `## Cut sequence` section; absorbs Deferred items + Lessons learned at ship time) |
| Cut sub-issue (GitHub issue body) | One GitHub issue per cut (labeled `enhancement` + `ready-for-agent` + `area: X`), filed one at a time by cut-planner from a per-feature **planner issue** ([`design-cut-planner.md`](design-cut-planner.md) Q1; legacy features use a tracking issue). Closes when the implementing PR merges. See [`docs/adr/0015-impl-doc-artifact-retires.md`](../../docs/adr/0015-impl-doc-artifact-retires.md). |
| Per-feature cut state + planning history | The planner issue: body = current `## State`, comments = append-only `> Decision:` log ([`design-cut-planner.md`](design-cut-planner.md) Q7). |
| Reference doc (one-time decision with ongoing operator/author concerns) | `.claude/rules/design-{feature}.md` (companion to the ADR; `design-config.md` is the canonical example) |
| Architecture decision (load-bearing) | `docs/adr/NNNN-slug.md` |
| Domain language (terms, vocabulary) | `CONTEXT.md` + ADRs for load-bearing splits |
| External research / audit | `docs/audits/{topic}.md` |
| Strategic prioritization | `ROADMAP.md` |
| Strategic non-goal | `docs/non-goals.md` |
| Validated lesson / feedback | `team-preferences.md` (numbered rule) |
| Process convention | `feature-design-process.md` (this file) |
| Implementation work | code + commit messages + closed cut sub-issue |
| Refactor / TODO | GitHub issue with full body, not a doc |
| Hygiene / one-off ops | commit message |

When a piece of work doesn't fit one of these, ask which kind it actually is. Usually it's masquerading as a different kind.

## Example: how the validation feature was designed

> Historical example — produced under the pre-ADR-0015 model where cut sequencing lived in a separate `design-{feature}-implementation.md`. Under the current model, the 6-cut sequence below would live in a `## Cut sequence` section of `design-validation.md` itself, and cuts would be filed as GitHub tracking issue + sub-issues.

Reference flow that produced [`design-validation.md`](design-validation.md) + [`design-validation-implementation.md`](design-validation-implementation.md):

1. **Discovery**: realized validation was scattered (asset upload validates; render-time fail-soft; nothing else). User raised "we need altRequired enforcement."

2. **Grilling**:
   - Q1: should validation be one feature or many? → many, but with shared infrastructure
   - Q2: what types of validation do we need? → audit phase before answering
   - Q3: when does each type run? (timing) → four-phase model
   - Q4: how do we surface errors? → three surfaces, one per phase
   - Q5: cut sequence? → six cuts, low-risk-first
   - (etc.)

3. **Design**:
   - `design-validation.md` captures the four-phase model, the validator abstraction, severity model, distinctive choices
   - `design-validation-implementation.md` captures the 6-cut sequence with per-cut scope

4. **Implementation**: not yet started; will follow the cut sequence.

The whole thing was pickup-able cold by a new session because the durable artifacts captured both **what** and **why**.

## Example: how the AI alt-text feature was implemented

> Historical example — produced under the pre-ADR-0015 model. Under the current model, the 9-cut sequence below would live in `design-ai.md`'s `## Cut sequence` section, and per-cut work would be tracked as GitHub sub-issues rather than a status table.

Reference flow that produced [`design-ai.md`](design-ai.md) + [`design-ai-implementation.md`](design-ai-implementation.md) + 9 commits of code:

1. **Discovery + grilling**: 6 design questions resolved (provider integration shape; provider choice; CI testing; prompt composition; image preprocessing; locale handling; etc.)

2. **Design**: design-ai.md + design-ai-implementation.md, both written before any code.

3. **Implementation**: 9 cuts, each on a single PR branch:
   - Cut 1: `ai/` infrastructure
   - Cut 2: AltTextAdapter + suggester contract
   - Cut 3-5: three providers (Anthropic, OpenAI, Ollama)
   - Cut 6: config + factory
   - Cut 7: admin route
   - Cut 8: UI integration
   - Cut 9: docs + plan update

4. **Validation**: smoke-tested against real local Ollama.

Status table in `design-ai-implementation.md` was updated as each cut shipped.

## What to do when you don't know what kind of work it is

If you're producing something and you don't know which durable artifact it belongs in, ask:

- "If this session ended right now, what would a future session need to pick up where I left off?"
- "Is this knowledge that survives shipping, or context that becomes stale?"
- "Does it answer 'what are we doing?' (design), 'why?' (ADR or design rationale), 'how?' (implementation), 'what's prioritized?' (ROADMAP), 'what's deliberately not?' (non-goals)?"

Usually one of the categories above is the answer. If none fits, the work might not be doc-worthy — or might warrant a new category. New categories should be deliberate; don't multiply doc kinds casually.
