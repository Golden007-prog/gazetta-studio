# Feature-bot

Autonomous bot that implements feature cuts following the project's design pass. Reads cut sub-issues from GitHub; ships one PR per cut.

**Status**: design pass complete (2026-05-30). All 9 Qs locked. Implementation pending.

**Companion docs**:
- [`.claude/rules/feature-design-process.md`](feature-design-process.md) — the design+implementation phases this bot operates within. **This bot's existence changes Phase 4 ("Implementation") materially — see "Process changes" below.**
- [`bots/README.md`](../../bots/README.md) — bot ecosystem context (producer/consumer rule, durable memory pattern, generator-critic loop, escalation discipline)
- [`.claude/rules/team-preferences.md`](team-preferences.md) — rules 17 (build-and-validate), 18 (build structurally right), 22 (durable artifacts), 27 (label assertion provenance), 31 (TDD-first when delegating to AI), 33 (every change goes through PR), 38 (audit symmetric bots)
- [`.claude/rules/dev-glossary.md`](dev-glossary.md) — vocabulary additions (`feature-bot`, `tracking issue`, `cut sub-issue`) land here when Q1's lock ships

## Scope

**In v1:**
- Bot reads GitHub "cut sub-issues" labeled `enhancement` + `ready-for-agent` + `area: X` (no new labels — reuses existing vocabulary)
- Picks the next cut whose dependencies have all landed (see Q3 "Closed is not landed")
- Generator-critic loop (Agent A implements, Agent B reviews) — same pattern as fix-bot + dead-code-watcher
- Agent A flow: tests → impl → SOLID research+fix loop → runtime validation → improve/fix tests → verify comments (rot-proof bar) → ONE commit at the end (no TDD-first; single atomic commit; Agent B is the sole anti-tautology gate, separating impl from tests by path — see the loop in "Design" below)
- One PR per cut
- Durable memory: skip-list + reviewer-log (same shape as fix-bot)

**Out of v1 (deferred):**
- Cross-cut refactors (one PR touching multiple cuts)
- Cut subdivision (one cut → multiple PRs)
- Time-bound work budgets per cut (a 500-LOC cut takes as long as it takes)
- Cuts spanning multiple features

**Non-goals:**
- Implementing features without a preceding design pass (that's not feature-bot's job; design grilling happens first per `feature-design-process.md`)
- Replacing fix-bot (fix-bot handles `bug + ready-for-agent`; feature-bot handles `enhancement + ready-for-agent` — disjoint label queues via existing vocabulary)
- Composing cut specs from prose backlog issues (the cut sub-issue's existence IS the gate that says "this work is design-passed and bot-ready")

## Locked decisions

### Q1 — Cuts live in GitHub tracking issues + sub-issues; impl docs retire

**Decision**: Cut sequencing moves from `.claude/rules/design-{feature}-implementation.md` tables to GitHub issues:

1. **Design doc** (`design-{feature}.md`) — stays in `.claude/rules/`. Durable artifact per resumability contract (rule 22). Absorbs "Deferred items" + "Lessons learned" sections that previously lived in the impl doc.
2. **Tracking issue** — labeled `enhancement` + `area: X` (no `ready-for-agent` — the tracking issue itself isn't implementable; its children are). Body is a tasklist of cut sub-issues. Auto-closes when all sub-issues close.
3. **Cut sub-issue** — labeled `enhancement` + `ready-for-agent` + `area: X`. Body contains the per-cut spec (per Q2: just-markdown with `**Feature**:` and `**Depends on**:` front-matter).
4. **Feature-bot input** — `gh issue list --label enhancement --label ready-for-agent --state open` (with standard exclusions: `ready-for-human`, `wontfix`, `needs-info`); pick the first whose dependency sub-issues are all closed.

**Zero new labels.** Cut sub-issues use the existing `enhancement` + `ready-for-agent` + `area: X` vocabulary. Disambiguation is structural:
- Fix-bot's queue (`bug + ready-for-agent`) doesn't overlap because cuts are `enhancement` not `bug`.
- Discovery-prep-bot's queue (`enhancement` lacking `ready-for-agent`) doesn't overlap because cuts already have `ready-for-agent`.
- Tracking issues (no `ready-for-agent`) are invisible to feature-bot's query — only cut sub-issues match.
- Body's `**Feature**:` field is the feature slug; queries by feature use this content marker, not a per-feature label.

The `design-{feature}-implementation.md` artifact type is **retired**. Existing impl docs migrate via one-time script (see "Migration" below).

**Why** (the load-bearing reasons that survived POV-walks across maintainer, bot, reviewer, cold-pickup, industry-precedent, producer/consumer, schema-validation, multi-feature-in-flight, GitHub-platform, and process-document POVs):

1. **Impl docs are temporary by their own design** — `feature-design-process.md` already specifies "Lifecycle of an implementation doc: pruned at ship time" — but in practice 20+ docs with pending cuts have accumulated. The artifact type doesn't fit `.claude/rules/` (current-state design + conventions).
2. **GitHub-native state machine** — sub-issue close → tracking issue tasklist auto-checks → feature progress is queryable via `gh` without parsing markdown tables.
3. **Multi-feature-in-flight clarity** — opening/closing a tracking issue is the natural "is this feature active?" flag. Solves "which of 20 docs is the bot currently working from?"
4. **PR review ergonomics** — sub-issue is the PR's spec (one-click from `Fixes #N`); reviewer doesn't need to open a separate `.md` file.
5. **Reject-without-skip-list-shape** — closing a cut sub-issue with reason is the natural "don't do this" gate; past-PR feedback loop catches it. Same mechanism fix-bot uses; no new code path.
6. **Industry precedent** — Linear, GitHub Projects v2, Rust RFCs, Kubernetes KEPs all separate the durable design (RFC / KEP / Project description) from cut tracking (sub-issues / tracking-issue tasklist). Gazetta's impl-doc was the outlier.
7. **Bot ecosystem consistency** — 5 of 7 bots already operate on GitHub issues. Feature-bot conforming reduces cognitive load and benefits from rule-38 symmetric audits with fix-bot.

**Rejected alternatives** (preserved for future-me to avoid re-litigating):

| Alternative | Why rejected |
|---|---|
| **A. Impl-doc walker** (bot reads `.claude/rules/design-{feature}-implementation.md` tables) | Status table hand-edit drift; markdown-table-as-state anti-pattern; impl docs are temporary by design but sit indefinitely in `.claude/rules/`; PR review requires opening separate file; reject-cut has no GitHub-native mechanism |
| **B. Impl-doc + GitHub issues** (hybrid; bot accepts both `☐` cut rows AND `ready-for-feature` labeled issues) | Two parsers, two validation paths; label-overlap risk with `bug + ready-for-agent`; doubles maintenance surface |
| **C. Any open issue** (bot synthesizes its own cut plan from issue body) | Violates design-first discipline (rules 22, 28, feature-design-process.md); ships features without foundational-dimension checks; blast-radius asymmetric to fix-bot |
| **D. Tracking issue + sub-issues, design doc retains impl details** | Mostly G but keeps two-place truth (cut detail in both design doc and sub-issue); chose G for single-source clarity |
| **E. GitHub Discussions per feature** | Discussions don't have label state machines; don't compose with `gh issue list` filters; sideways from bot ecosystem |
| **F. Issues for active cuts, design doc absorbs impl-doc content** | Same as G — actually this IS what G locks. (Numbering carryover from grilling session; F and G converged.) |

### Q2 — Cut sub-issue body format: just markdown

**Decision**: Cut sub-issue body is plain markdown with conventional sections. No GitHub Forms template, no YAML, no fenced data block.

Shape:

```markdown
**Feature**: redirect-ui
**Depends on**: #501, #502

## Spec

[narrative spec — links design-{feature}.md, copies the cut's intent from
the design pass; describes what to build]

## Acceptance

- [testable outcome 1]
- [testable outcome 2]
- ...
```

Bot's TS orchestrator parses two one-line key-value fields via regex:
- `**Feature**: <slug>` → picks the right design doc reference
- `**Depends on**: #N, #M` (optional) → cron-time gate; skip until all referenced sub-issues close

Everything else (`## Spec`, `## Acceptance`) is passed to Agent A as prose context. Agent A is responsible for reading the linked design doc, deciding files + tests, and making one atomic commit (tests + impl) once all its checks pass.

**Schema enforcement** lives in Agent A's prompt discipline, not at filing time:
- If `## Spec` or `## Acceptance` is missing or vague → Agent A fails loud, posts "spec incomplete" comment on the sub-issue + closes with reason. Reviewer-loop's existing escalation mechanism handles it.
- Same loud-failure semantic as fix-bot handles malformed bug reports today; existing pattern reused.

**Why** (load-bearing reasons, verified against actual practice):

1. **Match real Anthropic practice** — verified live (2026-05-30) that `anthropics/claude-code` uses markdown-with-headings for all issue bodies (`## Problem`, `## Request`, `## Precedent`); zero sub-issues; zero fenced YAML; PR bodies use the same shape (`## What`, `## How it activates`). Their issue Forms are for external user reports, not internal feature tracking. The "GitHub Forms is industry precedent" argument applies to bug/feature-request templates filled by users, NOT to internal cut tracking.
2. **Producer/consumer rule satisfied trivially** — bot's TS parses one regex (`**Depends on**: ...`); everything else is Claude's domain. Nothing brittle to maintain.
3. **Minimal moving parts** — no `.github/ISSUE_TEMPLATE/feature-cut.yml`, no Zod cut schema, no YAML emitter, no Forms-to-YAML workflow. One regex in TS.
4. **Bot ecosystem consistency** — 5 of 7 existing bots read issue bodies as prose for Claude interpretation (fix-bot, triage-bot, discovery-prep-bot, flake-watcher, mutation-watcher). Feature-bot conforms.
5. **Maintainer ergonomics across all paths** — Claude generates from design doc (90%+ of cases); maintainer hand-edits via github.com or `gh issue edit`; future contributor reads existing sub-issues and learns the pattern from examples. No filing-time forms; no YAML hand-authoring.
6. **Migration from existing impl docs is simplest** — script reads `☐ pending` cut rows; generates prose markdown bodies; posts via `gh issue create`. No template scaffolding, no YAML emission.
7. **Schema evolution costs zero** — convention evolves via example sub-issues, not via versioned schema bumps.

**Rejected alternatives** (preserved):

| Alternative | Why rejected |
|---|---|
| **A. Free-form prose, no conventions** | No `depends-on` parseable → bot can't gate on dependency completion |
| **B. Loose markdown sections (no key-value lines)** | Same as the chosen shape but without the load-bearing one-line front-matter fields; harder dep parsing |
| **C. Fenced YAML block in body** | No industry precedent for YAML in GitHub issue bodies (verified live — searched real repos); awkward synchronization between rendered prose + YAML if maintainer edits one side |
| **D. GitHub Forms template** | Industry precedent is for user-filed bug/feature-request templates, NOT internal cut tracking; adds a `.yml` schema file + a parser anchored on stable headings; over-engineered for the two fields the bot actually needs |
| **E. Forms + workflow-appended YAML hybrid** | Three moving parts (form + workflow + YAML emitter) for marginal bot-side correctness gain; documented sync-risk between rendered prose and YAML |
| **F. Front-matter YAML + prose** | YAML hand-authoring friction (mitigable via Claude Code) + no precedent for front-matter YAML in actual GitHub issue bodies (verified live — empty search) |

**Schema enforcement loss vs D/E/F**: filing-time validation of "all required fields present" is gone. Mitigated by Agent A's "fail-loud-on-vague-spec" prompt path — equivalent guarantee, simpler implementation.

**Mechanical cross-check loss vs F**: reviewer can't compare "files Agent A touched" to "files listed in YAML" because no YAML lists them. Mitigation: the cross-check was theater — the real test is rule 31's "revert the fix and the failing test still fails," which Agent B's reviewer loop runs regardless.

**Refinement (Cut 5)**: cut sub-issue bodies include four standard sections — `## Spec`, `## Acceptance`, `## SOLID` (conditionally), `## Tests`. `## SOLID` and `## Tests` close the gap from retiring the impl-doc artifact (which previously required SOLID checks and tests per cut in its status table). See `feature-design-process.md` Phase 4 for the convention.

### Q3 — Dependency mechanism: regex-parse `**Depends on**:` with cron-tick validation

**Decision**: Cut sub-issue body declares its dependencies via a one-line front-matter field:

```markdown
**Feature**: redirect-ui
**Depends on**: #501, #502
```

Bot's TS orchestrator parses one regex per cut:

```ts
const dependsOnLine = body.match(/^\*\*Depends on\*\*:\s*(.+)$/m)?.[1] ?? ''
const depNumbers = [...dependsOnLine.matchAll(/#(\d+)/g)].map(m => Number(m[1]))
```

Tolerates `#501, #502` / `#501 #502` / `none` / empty / missing line. No deps → cut is immediately eligible.

**Validation at cron-tick (loud-fail on bad refs)**: each referenced number must be an open or closed `feature-cut` issue. On mismatch (mistyped number, non-cut issue, self-reference) the bot posts a "your sub-issue references an invalid dependency #N — check the depends-on line" comment + skips the cut. Same loud-failure pattern as fix-bot's existing input validation.

**Why** (over alternatives walked):
1. **Single source of truth.** Sub-issue body declares everything about the cut, including its position in the dependency graph. No second axis (labels, Projects, sub-issue parent/child) to keep in sync.
2. **Matches Q2's "just markdown" lock.** Dependency syntax IS markdown text; no schema, no special field.
3. **Edits natural.** Remove a dep = edit the body. Same path the maintainer already uses.
4. **Parallelizable.** Cuts with empty `Depends on` compete for bot attention; cuts with deps wait. Solves the serial-order limitation tasklist-ordering would impose.
5. **Loud-fail at cron-tick** beats silent-wait-forever on a mistyped number. Catches errors before Claude burns context.

**Closed is not landed (added 2026-10-04, #867).** A dependency is satisfied only when it was closed by a merged PR that names it — `#N` in the PR title, a `feat/cut-N` head branch, or feature-bot's `feature-bot: issue=N` marker (`bots/_lib/cut-landing.ts`). When a commit closed it, as a rebase merge records it, that's the merged PR that brought the commit in (#1241). Closed as *not planned* → `dep-rejected` (as before). Closed as *completed* with no such PR → `dep-unverified`: a comment explaining how to clear it, plus `needs-info`. The original rule read `state_reason: completed` as "merged via PR"; #517 (review-workflow Cut 3) was closed as completed by #557, an unrelated reviewer-prompt fix that only mentioned it, so feature-bot treated storage that never existed as a satisfied dependency and #519 kept failing on top of it.

**Rejected alternatives** (preserved):

| Alternative | Why rejected |
|---|---|
| **B. GitHub sub-issue parent/child API** | Sub-issue API has one parent-child axis only; doesn't model sibling cut→cut deps. Platform doesn't support it. |
| **C. Tracking-issue tasklist order = serial dependency** | Loses parallelizability; real impl docs have parallel cut paths (e.g., design-hooks Cuts 4/5/6 against unrelated handlers); forced serial wastes bot time. |
| **D. GitHub `Fixes`/`Closes` cross-reference syntax** | Effectively the same as A but with GitHub's bidirectional informational link decoration; doesn't gate anything; no functional difference. |
| **E. Label-per-dependency (`blocked-by:#501`)** | Label-namespace pollution (300+ labels at scale); no native "remove label X when issue Y closes" automation; would need a webhook or daily reconciliation pass. |
| **F. GitHub Projects v2 custom field** | Introduces Projects v2 dependency (`has_projects: false` in this repo); Projects v2 cards aren't tied to issue close-state the way the bot needs; over-engineered. |
| **A2 (tolerate bad refs)** | Silent-wait-forever on mistyped number; bot's job is structural correctness, malformed input should fail loud before Claude is invoked. |

### Q4 — Cut ordering: oldest-first, no priority label in v1

**Decision**: Among unblocked cuts (those whose `**Depends on**` refs have all landed), the bot picks one per cron tick using oldest-first sort:

```ts
const sorted = candidates.sort((a, b) => {
  if (a.createdAt !== b.createdAt) return a.createdAt.localeCompare(b.createdAt)
  return a.number - b.number  // deterministic tiebreaker for same-second creation
})
```

**No `priority:high` label in v1.** Default ordering is pure oldest-first; matches fix-bot's existing pattern exactly. YAGNI discipline — the override mechanism is deferred until concrete ordering pain surfaces.

**If priority override pain surfaces later**: adding `priority:high` is an additive change (one label, one sort comparator update) that doesn't require re-architecting feature-bot.

**Why** (revised against rule 22 "every kind of work has a durable artifact" + label-namespace discipline):

1. **Zero new labels.** Reuses pure oldest-first which is fix-bot's existing default.
2. **YAGNI** — the override case is hypothetical; if a real "I need this cut shipped first" pressure arises, the maintainer can either (a) close older sibling cuts temporarily, or (b) just wait for the next cron (cuts ship at ~1/day cadence; "shipped tomorrow vs. shipped today" rarely justifies new infrastructure).
3. **Starvation-free** — oldest-first means everything eventually ships.
4. **Bot ecosystem consistency** — when Q4 was locked, it matched fix-bot's oldest-first sort. Since #1337, fix-bot takes issues labelled `priority` first; feature-bot stays oldest first, and a `priority` label on a cut has no effect. Q4 stands until feature-bot's own ordering causes a problem.

   Decided: maintainer, 2026-10-24 (#1352)

**Edge cases handled**:
- Same-second creation → deterministic tiebreaker by issue number ascending.
- All cuts blocked → bot exits silently with "Inbox zero" (already fix-bot's pattern).

**Rejected alternatives** (preserved):

| Alternative | Why rejected |
|---|---|
| **B. Risk-first (low → high via `risk:` label)** | Human risk classification famously unreliable; delays high-value high-risk cuts; adds label-curation burden; new label costs |
| **C. Maintainer-orderable via tracking-issue tasklist** | Creates second source of truth competing with body-declared deps; extra GraphQL query per cron to fetch tasklists; sync-risk between body order and tasklist |
| **D. `priority:high` label override** | YAGNI — premature unless concrete ordering pain surfaces. Can be added additively when it does. Earlier grilling pass had locked this; revised to drop the new label after label-namespace audit. |
| **F. Random selection** | Non-deterministic; hostile to maintainer prediction; trust-eroding |

### Q5 — Agent A's prompt access to design doc: read-on-instruction, no inlining

**Decision**: The orchestrator does NOT inline the design doc in Agent A's prompt. Agent A's prompt has an explicit "READ these files first" directive that names the design doc path (derived from the cut sub-issue's `**Feature**:` field → `.claude/rules/design-{slug}.md`).

Prompt directive shape (lives in `bots/feature-bot/prompts/per-cut.md`):

```
Before implementing, READ these in this order:
1. The cut sub-issue body (provided below).
2. The design doc at `.claude/rules/design-{feature}.md` — pay special
   attention to Scope, Locked decisions, Foundational checks,
   Distinctive choices.
3. Any companion docs the design doc references (typically other
   `.claude/rules/design-*.md` or `docs/adr/*.md`).
4. The implementation files listed or implied by the cut spec.

Only AFTER reading 1-3 do you begin writing code. The design doc's
Locked decisions are NOT negotiable — implement to match them.
```

**Why** (over alternatives walked):

1. **Matches fix-bot's Agent A pattern.** Existing fix-bot prompts use the same shape: "Read these files. Then implement." Reuse what works.
2. **No prompt-bloat.** Design docs vary 300-1500 lines; inlining the full doc would burn context for cuts that don't need most of it.
3. **No extraction brittleness.** Targeted-excerpt approaches (C/D variants) require knowing design-doc structure; if a future design doc has locked decisions at line 600 instead of line 100, those approaches break. Whole-file read is robust.
4. **Forcing function for foundational checks.** "Pay attention to Foundational checks" in the prompt is a directive Claude responds to; implicit reliance on Claude's curiosity is weaker.
5. **Composes with Q6 (next).** If Agent A discovers the cut spec is vague during the Read pass, it's already loaded the design doc and can decide intelligently whether to escalate or proceed.

**Calibration path**: if real bot runs show Agent A skipping the design doc and implementing against partial intent, tighten the prompt (e.g., "If you haven't read the design doc, REJECT to your own session"). Same calibration the other bots' prompts iterate on.

**Rejected alternatives** (preserved):

| Alternative | Why rejected |
|---|---|
| **A. Just sub-issue body, Agent A reads on its own initiative** | Agent A may not read the design doc if spec narrative seems self-sufficient; misses foundational checks |
| **B. Sub-issue body + full design doc inlined verbatim** | Context burn; design docs are 300-1500 lines, most irrelevant per cut; pre-loading is premature optimization vs. one Read tool call |
| **C. Sub-issue body + targeted excerpt of design doc** | Extraction logic is bot infrastructure that drifts with design-doc convention changes; brittle |
| **D. Sub-issue body + first N lines of design doc** | N is arbitrary; some design docs have key locks beyond any fixed truncation; same drift risk as C |

### Q6 — Escalation taxonomy: three-tier (APPROVE / NEEDS_INPUT / NEEDS_HUMAN), reuse existing labels

**Decision**: Agent A has three terminal states. Two existing labels carry the bot ecosystem's semantics; no new labels needed.

| Tier | Trigger | Action | Label applied | Cron-time effect |
|---|---|---|---|---|
| **APPROVE** | implementation done; Agent B approved | open PR | (none on sub-issue; PR opens) | sub-issue closes when PR merges |
| **NEEDS_INPUT** | design decision required to proceed | post structured Q + recommendation; reset working tree | `needs-info` (reused) | bot excludes via existing `--no-label needs-info` filter |
| **NEEDS_HUMAN** | stuck — cannot proceed even with input; or MAX_INPUT_REQUESTS exceeded | close sub-issue; skip-list entry (via PR); `escalateToHuman` comment | `ready-for-human` (existing fix-bot pattern) | sub-issue closed; bot excludes via existing filters |

**`needs-info` semantic widening**: the label currently means "need information to proceed; bot must exclude from queue." Existing usage is reporter-info (triage-bot's "could not reproduce" cases). Widening: include maintainer-decision cases (feature-bot's NEEDS_INPUT). The comment thread carries specifics; the label gates the queue uniformly.

`bots/README.md` clarification (one-line edit, lands with feature-bot Cut 1):

```
needs-info  →  bot must exclude from queue; requires additional information
              to proceed. May be: info from the issue reporter (triage-bot's
              "could not reproduce") OR a design decision from the maintainer
              (feature-bot's NEEDS_INPUT escalation). Comment thread carries
              specifics; remove the label to re-trigger bot processing.
```

**NEEDS_INPUT structured-question format** (Agent A's final block):

```
NEEDS_INPUT: <one-line question>
Options:
  - <option 1 with reasoning>
  - <option 2 with reasoning>
  - <option 3 if applicable>
Recommendation: <option N because ...>
```

Orchestrator posts this verbatim as a sub-issue comment with outcome tag `<!-- feature-bot: needs-input issue=N run=R -->`, applies `needs-info` label, resets working tree, moves on to next candidate.

Maintainer recovery:
- Read the comment, decide.
- Reply with the answer (or just remove the `needs-info` label).
- Next cron picks up the sub-issue; Agent A re-runs with the comment thread in context.

**MAX_INPUT_REQUESTS=2 per cut**: after two NEEDS_INPUT cycles on the same cut (counted via outcome-tag query on prior bot comments), the orchestrator escalates to NEEDS_HUMAN instead. Prevents bot-loop of repeated questions.

**Why reuse `needs-info` over inventing `awaiting-input`** (10 POVs walked):

1. **Bot ecosystem consistency** — `needs-info` is already in fix-bot's exclusion filter at `bots/_lib/github.ts:98`. Free queue-filtering; no cross-bot coordination.
2. **Existing semantics already maintainer-side** — `needs-info`'s docstring says "applied by maintainer" without specifying who supplies info. Widening is a 5-word edit.
3. **Zero current usage** — verified no issues currently carry `needs-info` (`gh issue list --label needs-info` returned empty). Widening doesn't conflict with prior data.
4. **Rule 38 symmetric audit** — when fix-bot wants NEEDS_INPUT later, it inherits the same label and pattern. Cargo-cult discipline.
5. **Cold-pickup developer** — one concept ("info needed to proceed") rather than two near-synonyms.
6. **Outcome tags already provide forensic filtering** — `gh issue list --search "feature-bot: needs-input"` cleanly answers the "which cuts blocked on me?" question without a separate label.

**Rejected alternatives** (preserved):

| Alternative | Why rejected |
|---|---|
| **A1. Hard-error only (close sub-issue on any blocking question)** | Misclassifies "I need a decision" as "this cut is broken"; closes legitimate cuts; high friction to reopen |
| **A2. Invent `awaiting-input` label** | Two near-synonyms; cross-bot coordination cost; pressure to invent more parallel labels for future cases (Agent B input, prereq-missing input, etc.) |
| **A3. Overload `ready-for-human`** | Loses the "stuck, give up" vs. "waiting on decision" distinction; existing fix-bot semantics break |
| **A4. Comment-only, no label** | Bot's cron-time query still picks up the sub-issue; bot re-asks same question; loops |
| **A5. Open separate "design question" cross-linked issue** | Fragmentation; discoverability ↓; maintainer juggles 2 issues per question |

**Missing-prereq case** (Agent A discovers required infrastructure isn't in the codebase even though `Depends on` refs are closed): this is NEEDS_HUMAN, not NEEDS_INPUT. The cut spec or prior-cut PR is wrong; reopening requires reconciliation, not a decision. Close + skip-list + `ready-for-human`.

### Q7 — Skip-list reason codes: extend fix-bot's taxonomy with 4 feature-bot-specific reasons

**Decision**: Feature-bot's skip-list extends fix-bot's existing reason enum with 4 new typed values. Internal bot data structure; not labels.

```ts
type SkipReason =
  // Fix-bot's existing reasons (reused; same semantics across both bots)
  | 'needs-human'           // generic / catch-all
  | 'maintainer-rejected'   // past-PR feedback loop caught a closed-not-merged PR
  | 'tautological-test'     // reviewer's tautology check failed
  | 'wrong-root-cause'      // reviewer judged the fix targets wrong code
  // Feature-bot additions
  | 'missing-prereq'        // Agent A found required infrastructure absent despite closed deps
  | 'spec-too-vague'        // cut spec doesn't describe enough for Agent A to interpret
  | 'input-cycles-exceeded' // MAX_INPUT_REQUESTS=2 hit without resolution
  | 'files-conflict'        // cut's files overlap with another in-flight cut's open PR
  // Added later (see design-cut-planner.md Q6 and #840)
  | 'refinement-exhausted'  // cut-planner's refinement budget spent; the spec was not the problem
  | 'redecomposition-failed'// re-decomposition tried and did not help
  | 'delivery-failed'       // approved, but the push or PR failed — infrastructure, not cut quality
```

Schema in `bots/feature-bot/skip-list.ts` (mirrors fix-bot's existing shape):

```ts
interface SkipListEntry {
  fingerprint: { issueNumber: number }
  reason: SkipReason
  reasonNote: string  // free-text detail
  addedAt: string  // ISO timestamp
  addedBy: 'bot' | 'maintainer'
}
```

**Outcome tag format** on the skip-list-entry PR + sub-issue escalation comment includes the reason for forensic queries:

```
<!-- feature-bot: skip-entry issue=N reason=missing-prereq run=R -->
```

`gh issue list --search "feature-bot: skip-entry reason=missing-prereq"` cleanly filters by failure mode for compactor input and operator review.

**Why an extended typed enum** over alternatives:

1. **Compactor pattern recognition** — monthly bots-compact finds cross-finding patterns. Pattern-matching by typed reason is one comparison; pattern-matching by free-text note is many heuristics.
2. **Forensic queries via outcome tags** — typed reason in the tag enables structured filtering without parsing comment bodies.
3. **Four real failure modes** — `missing-prereq`, `spec-too-vague`, `input-cycles-exceeded`, `files-conflict` all surfaced during Q6 grilling as concrete scenarios. Not speculative.
4. **Strictly typed** — TS union prevents typos; vitest tests against the enum directly.
5. **Reuse where applicable** — `maintainer-rejected`, `tautological-test`, `wrong-root-cause` carry over from fix-bot because Agent B's reviewer runs the same checks. Rule 38 symmetric bots discipline.
6. **`needs-human` stays as catch-all** for cases not matching any specific reason. Falls back gracefully if bot emits an unrecognized reason.

**Note**: skip-list reasons are internal bot data, not labels. No GitHub-namespace impact. The corresponding labels (`needs-info` for NEEDS_INPUT, `ready-for-human` for NEEDS_HUMAN) are separate and stay reused per Q6's lock.

**Rejected alternatives** (preserved):

| Alternative | Why rejected |
|---|---|
| **A. Reuse fix-bot's taxonomy verbatim (all → `needs-human`)** | Compactor can't pattern-match common failure modes; loses the typed structure that enables forensic filtering and lessons generation |
| **C. Tagged sub-categories in `reasonNote`** | Tags-in-prose drift over time; less reliable than typed enum; same complexity as B with weaker contract |

### Q8 — Migration interaction: bot ignores non-issue impl docs

**Decision**: Feature-bot's input is `gh issue list --label enhancement --label ready-for-agent` only. The bot does NOT read `.claude/rules/design-*-implementation.md` files. Un-migrated impl docs are invisible to the bot.

**Migration path** (maintainer-driven, no flag day):
- Maintainer (in Claude Code) says "migrate design-redirect-ui's impl doc to tracking + sub-issues."
- Claude reads the impl doc, generates tracking issue body, generates per-cut sub-issue bodies (just-markdown per Q2), posts via `gh issue create`.
- Maintainer reviews + closes the impl doc (replacing its content with a header pointing at the tracking issue + absorbing "Deferred items" / "Lessons learned" sections into `design-{feature}.md`).
- Feature-bot picks up the newly-filed sub-issues on next cron.

**Migration is per-feature and per-maintainer-decision**. Some impl docs migrate this week; some next month; some never (feature was abandoned). All paths work — bot only sees what's been migrated.

**Edge cases handled**:
- Impl doc with all `✓ shipped` cuts (feature done): no migration; impl doc retires to its lessons-learned section absorbed into design doc.
- Impl doc with mixed ✓/◐/☐ cuts: only pending cuts become sub-issues; shipped ones stay as git-log history per existing prune-at-ship convention.
- Forgotten impl doc that's not priority: stays where it is. Lifecycle is maintainer's decision, not bot's.

**Why A (bot-ignores) over alternatives**:

1. **Matches Q1's lock.** Tracking + sub-issues are the source of truth; bot only sees the new system.
2. **No flag day required.** Incremental migration; bot works whenever sub-issues exist.
3. **Bot stays focused.** Feature-bot implements cuts; migration is maintainer's judgment per impl doc (which cuts are still relevant, which need re-scoping, which are stale).
4. **YAGNI on auto-migration tooling.** If hand-migrating 20+ docs via Claude Code becomes tedious, a `bots/feature-bot/migrate-impl-docs.ts` helper can be added later. Not a v1 dependency.

**Process-doc update required**: `feature-design-process.md` Phase 4 rewrite to reference the tracking-issue + cut-sub-issue model instead of the impl-doc table. Lands alongside the first feature-bot Cut.

**Rejected alternatives** (preserved):

| Alternative | Why rejected |
|---|---|
| **B. Bot auto-migrates impl docs it can parse** | Producer/consumer rule violation (asking Claude to parse markdown table for content generation); splitting impl doc into design-doc-absorbed sections + sub-issue content needs maintainer judgment per row; bot-generated migration skips the "is this cut still relevant?" review step |
| **C. Bot warns about un-migrated impl docs but doesn't act** | Notification spam at v1 ship (20 unmigrated docs = 20 reminder issues); bot becomes a migration nag, not an implementer; mission creep |
| **D-only. Maintainer migration script as v1 requirement** | Extra tooling to ship + maintain; YAGNI until maintainer reports pain. (D stays as future additive option.) |

### Q9 — Cut sequence lives in design doc; state lives in GitHub

**Decision**: Every `design-{feature}.md` gains a `## Cut sequence` section with a declarative table of cuts. The table is **intent only — no status column**. State (which cuts shipped, which are in progress) lives in GitHub sub-issue close-state, queryable on demand.

**Table shape** (5 columns, simple markdown):

```markdown
## Cut sequence

| # | What | Depends on | Test tier | Risk |
|---|---|---|---|---|
| 1 | Schema refinement (PageManifest + FragmentManifest) | — | unit-first | Low |
| 2 | Audit enum extension | — | unit-first | Low |
| 3 | POST /api/redirects route | 1, 2 | api-first | Medium |
| 4 | CreateRedirectDialog.vue + SiteTree button | 3 | component | Medium |
| ... |
```

Test tier values match [`testing-plan.md`](testing-plan.md) "Shape per sub-system": `unit-first`, `api-first`, `integration-first`, `e2e-first`, `component`, mixed values like `api+component`.

**Why no status column**: status drift was the impl-doc's main failure mode. Separating intent (design doc) from state (GitHub) eliminates the two-place-truth problem.

**Querying state** (when needed):
- `gh issue list --label enhancement` searches by feature slug in body's `**Feature**:` field
- Tracking issue's tasklist auto-checks as sub-issues close
- Cold-pickup answer: "open the design doc for intent; open the tracking issue for state"

**Issue-filing flow**:
1. After grilling completes and design doc is on main, maintainer asks (in Claude Code): "open cuts for design-redirect-ui."
2. Claude reads the `## Cut sequence` section.
3. For each row, Claude renders a cut sub-issue body in Q2's just-markdown format:
   - `**Feature**: redirect-ui`
   - `**Depends on**: #501, #502` (mapping `Depends on` column values to filed sub-issue numbers as they're created)
   - `## Spec` (narrative, sourced from the design doc's locked decisions for this cut's scope)
   - `## Acceptance` (sourced from the design doc's locked decisions)
4. Claude calls `gh issue create` per cut + opens tracking issue with the resulting tasklist.

**Re-scoping a cut** (post-filing): maintainer edits the design doc's cut sequence + asks "sync cuts." Claude diffs against existing sub-issues and updates bodies that changed. Atomic intent-then-state propagation.

**Why** (over alternatives, 18 POVs walked):

1. **Cut sequence is itself a design decision** worth grilling — ordering, deps, test tier, risk. Generating it ad-hoc at filing time skips this rigor.
2. **Deterministic re-filing.** Re-running "open cuts" against an unchanged design doc produces identical sub-issues. Non-deterministic generation (B) would race.
3. **Single source of truth for intent.** Design doc has the answer to "what does this feature decompose into and why?" GitHub answers "what's actually shipped."
4. **Cold-pickup readability.** Future-maintainer / contributor reads one file (design doc) to understand the whole feature including its decomposition. No "two artifacts to traverse."
5. **PR reviewer one-hop context.** Reviewer of Cut 3's PR clicks #503 → sees spec narrative → can click back to design doc to see the cut's place in the sequence.
6. **TDD-first alignment.** Test tier per cut row is a design-time commitment, not an implementation-time guess.
7. **Foundational-checks distribution.** The cut sequence is where you decide WHICH cut closes Multi-instance check vs Locale check etc. Locked at grilling, not deferred.
8. **Schema-evolution mechanical.** New foundational dimension lands → edit existing cut tables. Same shape across all design docs.
9. **Long-term documentary value.** Feature shipped 2 years ago — the design doc's cut sequence still tells future-you "this feature was built in 7 cuts; here's the rationale."

**Grilling protocol addition** (per `feature-design-process.md`): every design pass concludes with the cut-sequence Q. Maintainer + Claude grill the decomposition: what's Cut 1, what depends on what, what's the test tier, what's the risk gradient. Output: the cut sequence table.

**Rejected alternatives** (preserved):

| Alternative | Why rejected |
|---|---|
| **B. Generated at filing time, no durable artifact** | Non-deterministic; re-running prompt produces different cut counts; rigor of "cuts as design decisions" lost; documentary value zero |
| **C. Cut sequence lives only in tracking-issue tasklist** | Conflates design intent with operational state in GitHub; cold-pickup readability degraded (two artifacts); re-scoping requires direct GitHub edits divorced from the design doc |
| **D. Placeholder in design doc; populated at filing time** | Adds a "filed yet?" ambiguity to cold-pickup; same drift risk as A but with extra mode confusion; A's "intent without status" cleaner |

**Drift mitigation in A**: status column intentionally absent. If a future cut-sequence row needs to be removed (rejected mid-stream), edit the table; GitHub state catches up via sub-issue close. No two-place truth.

**Refinement (Cut 5)**: the `## Cut sequence` table stays at 5 columns; per-cut SOLID lenses and specific test files live in the cut sub-issue body's `## SOLID` and `## Tests` sections. Table is the index; sub-issue body is the implementable spec.

## Design (high level, pending Q2)

### Bot pipeline

```
Night shift (every night, right after cut-planner; night-shift.yml):
    ↓
1. Query: gh issue list --label feature-cut --label ready-for-agent --state open
    ↓
2. For each cut, check: are all deps (cut.depends-on) closed?
    ↓
3. Pick oldest unblocked cut.
    ↓
4. Generator-critic loop (max 5 attempts):
   - Agent A: write tests + impl (GREEN) → **SOLID research+fix loop
     (≤3 converge rounds)** → **runtime validation (prove every path)**
     → **improve/fix tests (logic-direct, data-driven, de-dup,
     schema-smell, + edge cases the exercise surfaced)** → **verify
     comments (rot-proof bar — every comment survives an arbitrary
     rewrite, else rewrite to the WHY or delete)** → **ONE commit** (all
     work stays uncommitted in the working tree until every check passes,
     then a single atomic commit of tests + impl) → push. Test
     improvement comes AFTER runtime validation so it's informed by what
     the exercise found.
   - Agent B: review diff, vote APPROVE / REJECT / NEEDS_HUMAN —
     runs the **tautology check (the SOLE anti-tautology gate)**,
     **independently judges SOLID**, and **scrutinizes test removals**
     (the removed-coverage backstop).
   - APPROVE → open PR; REJECT → reset + retry with reviewer note;
     NEEDS_HUMAN → close sub-issue + post-comment + skip-list entry

   **No TDD-first discipline on Agent A (2026-06-07 change).** Agent A
   no longer writes-failing-test-first or keeps tests frozen — it builds
   and freely rewrites/removes tests (the test-quality pass), commits
   nothing until all checks pass, then makes ONE atomic commit. The
   anti-tautology guarantee lives ENTIRELY at Agent B's revert check
   (revert the impl files → tests must fail → restore → pass). Agent B
   separates impl from tests **by path** (test files = `*.test.ts` /
   `*.spec.ts` / `tests/**`), so no special commit shape is needed —
   reverting `git checkout main -- <impl files>` leaves the tests in
   place. (The earlier soft-two-commit scaffolding was dropped in favor
   of this path-based separation, which is simpler and commit-count-
   agnostic.)

   **Deterministic branch start (2026-06-09 fix).** Each attempt builds
   the `feat/cut-NNN` branch fresh from `origin/main` (`git checkout -B
   $BRANCH_NAME origin/main`) and pushes with `--force-with-lease`, so a
   re-attempt NEVER builds on a stale leftover branch of the same name
   from a prior run. The bug this fixes (#550): a leftover remote
   `feat/cut-516` from an earlier run was reused — Agent A's `checkout`
   landed on it and the plain `git push` (rejected as non-fast-forward
   against the diverged stale branch) left the PR pointing at the stale
   commits, even though the PR body was freshly (and contradictorily)
   generated. Re-attempts are now reproducible from clean main.

   **SOLID research is Agent A self-work, not a separate agent.** A
   separate SOLID agent between A and B was rejected because (a) editing
   the diff mid-loop would muddy the single-commit / path-based revert B
   relies on, (b) "fresh eyes" from a separate Claude session is weak
   (same model, cleared context), and (c) the independent SOLID check
   already exists at Agent B. A researches + fixes its own structure
   (discovery, not just the declared `## SOLID` lenses), converging in
   ≤3 rounds.

   **The test-quality pass has unbounded edit authority — recorded
   residual risk.** A may rewrite (schema-only-smell → logic-direct),
   data-drive (`it.each`), and REMOVE tests. Agent B's revert check
   proves *surviving* tests are load-bearing but is **blind to removed
   coverage** (a deleted test that would have caught a bug). Mitigations:
   A is told never to remove a test to ease passing (only genuine
   duplicates), and B scrutinizes suspicious removals (test deleted in
   the same diff that adds the code it covers). Best-effort, not a
   guarantee — the maintainer accepted this risk to get autonomous
   test-quality improvement.
    ↓
5. PR opens with Fixes #<cut-sub-issue-N>. Merge closes sub-issue,
   advances tracking issue tasklist.
```

Feature-bot runs every night from `night-shift.yml`, right after cut-planner. Bot PRs are reviewed daily, so a cut merged during the day gets its successor implemented that night. From 2026-10-11 to 2026-10-24 it ran on Friday nights only, before a Saturday review; before that, on a daily cron.

Decided: maintainer, 2026-10-24 (#1238)

| Rejected | Why |
|---|---|
| A few nights a week (for example Monday, Wednesday and Friday) | With daily reviews, a cut merged on the other days waits a day or two for its successor |
| Friday nights only, with reviews on Saturdays | Each feature moves at most one cut a week |

### Durable memory (per `bots/README.md` "Durable memory pattern")

| Artifact | Persistence |
|---|---|
| `bots/feature-bot/skip-list.json` | Committed; "don't re-attempt these cuts" keyed by cut sub-issue number + reason |
| `bots/feature-bot/lessons-learned.md` | Committed; cross-cut patterns (loaded into Agent A's prompt each run) |
| `bots/feature-bot/reviewer-log.jsonl` | NOT committed; persisted via `actions/cache@v4` keyed `feature-bot-reviewer-log-v1`; compactor input |

Past-PR feedback loop (existing pattern): before working on a cut, check if there's a recent PR for the same cut sub-issue number. Closed-not-merged → mine rejection reason → add to skip-list. Open → wait. Merged → no-op.

Compactor cadence: monthly `bots-compact.yml` job. Same shape as fix-bot's compactor.

### Concurrency

Workflow-level `concurrency: group: feature-bot, cancel-in-progress: false` per ADR-0011 — no two feature-bot workflows run concurrently (would race on reviewer-log cache).

## Process changes

This bot's existence changes `feature-design-process.md` Phase 4 ("Implementation"). Specifically:

**Before** (current):
- Phase 4: "Ship in cuts per the implementation doc. Each cut updates the status table on completion."
- Required artifact: `design-{feature}-implementation.md` with cut-by-cut status table.

**After** (this design's Phase 4):
- Phase 4: "Ship in cuts via tracking issue + cut sub-issues. Feature-bot picks unblocked cuts and opens PRs; maintainer reviews + merges."
- Required artifact: tracking issue (per feature) + N cut sub-issues. Deferred items + lessons learned absorbed into `design-{feature}.md` at ship time.
- `design-{feature}-implementation.md` is **retired** as an artifact type.

This is a feature-design-process-level change. Once Q2 + remaining Qs lock, the process doc needs updating in the same shipping commit as the feature-bot Cut 1.

## Migration

Existing 20+ `design-{feature}-implementation.md` files with pending cuts need migrating to tracking issues + cut sub-issues. One-time script:

1. For each impl doc with at least one `☐ pending` cut:
   - Open a tracking issue (title: "Feature: {slug}", body: tasklist placeholder)
   - For each pending cut row, open a cut sub-issue (format pending Q2)
   - Update tracking issue body to reference the cut sub-issues
2. Retire the impl doc: replace its content with a header pointing at the tracking issue, plus the "Deferred items" + "Lessons learned" sections (which migrate into the design doc).
3. `design-{feature}.md` absorbs Deferred items + Lessons learned sections.

Cuts already shipped stay as `✓ shipped` historical record in git log; not re-issued.

Mechanical, bounded one-shot. Doesn't need to be perfect — sub-issues can be edited after creation. Plan to run after Q2 locks and the bot's first cut ships (so the bot can be the first consumer of its own migration output, validating the format).

## Foundational checks (high-level — full pass after Q2 locks)

This bot operates on issues and PRs; doesn't write to the data layer. Most foundational dimensions are N/A. Brief check:

- **Multi-instance**: workflow concurrency group prevents racing. ADR-0011 pattern. ✓
- **Scale**: per-cron candidate set is small (active cut sub-issues, tens not thousands). ✓
- **Locale / Themes**: N/A (bot infrastructure, not user-facing data).
- **Auth + RBAC**: bot uses `GH_TOKEN` (Actions default) + `CLAUDE_CODE_OAUTH_TOKEN`. Same trust posture as other producer bots.
- **Audit**: bot's actions logged via GitHub audit trail (issue events, PR events, workflow runs). No `action: 'feature-cut'` audit-log event needed.
- **Review workflow** / **Hook** / **Render** / **Validation** / **Plugin** / **Cache** / **Offline** / **Collaboration**: N/A (bot doesn't traverse any of these surfaces).

## Cut sequence

| # | What | Depends on | Test tier | Risk |
|---|---|---|---|---|
| 1 | feature-bot skeleton: `bots/feature-bot/index.ts` + `prompts/per-cut.md` + `prompts/reviewer.md` + skip-list/reviewer-log infrastructure (copy from fix-bot, adapt to enhancement queue + 3-tier escalation) | — | unit-first | Medium |
| 2 | Cut-sub-issue parser in `bots/_lib/cut-parser.ts`: extracts `**Feature**:` + `**Depends on**:` regex; validates referenced numbers at cron-tick; loud-fail on bad refs | 1 | unit-first | Low |
| 3 | Generator-critic loop wiring: Agent A (per-cut.md) → Agent B (reviewer.md) → three-tier escalation (APPROVE/NEEDS_INPUT/NEEDS_HUMAN); reuses fix-bot's `escalateToHuman` pattern with extended skip-list reasons (Q7 enum) | 1, 2 | api-first | Medium-high |
| 4 | `.github/workflows/feature-bot.yml`: daily cron 04:30 UTC; concurrency group; permissions; reviewer-log cache restore/save | 1, 3 | (deployment; smoke via dry-run) | Low |
| 5 | `feature-design-process.md` Phase 4 rewrite: tracking-issue + cut-sub-issue model; impl-doc artifact retired; cut sequence section convention | — | (docs) | Low |
| 6 | ADR-0015: impl-doc artifact retirement; Q1's load-bearing decision captured durably per `feature-design-process.md` "Where decisions live" criteria | 5 | (docs) | Low |
| 7 | First production migration: hand-migrate `design-redirect-ui-implementation.md` (active feature, 7 cuts) to tracking + sub-issues via Claude Code; validates feature-bot end-to-end against a real cut | 4, 5 | (manual smoke) | Medium |
| 8 | `bots/README.md` update: feature-bot row in active-bots table; `needs-info` docstring widening to cover maintainer-decision case (Q6 lock) | 1 | (docs) | Low |

Cuts 1-4 are bot infrastructure; can ship in parallel against an unrelated test feature. Cuts 5-8 land alongside the first real migration (Cut 7).

**Bootstrap note** (chicken-and-egg): feature-bot can't implement its own Cut 1 since it doesn't exist yet. Cut 1 ships maintainer-driven via Claude Code. From Cut 2 onward, feature-bot can self-host — but won't have any cut sub-issues to work on until Cut 7's migration lands. So all of feature-bot's own cuts ship maintainer-driven; subsequent features get the bot.

## Open questions for implementation

1. **Reviewer prompt reuse**: fix-bot's `reviewer.md` runs tautology check + non-mechanical checks + project-rule check. Feature-bot's reviewer needs the same plus "did Agent A satisfy the cut's acceptance criteria?" Likely fork the prompt for feature-specific concerns; revisit during Cut 3.
2. **Test name pinning per cut**: should the cut's `## Acceptance` section name the failing test file path explicitly? Helps Agent A's TDD-first discipline. Probably yes for high-risk cuts, optional for low-risk.
3. **Migration ordering**: which existing impl docs migrate first after feature-bot ships? Active features (ROADMAP Tier 1 / Tier 2) take priority over deferred ones.

## ADR candidacy

Q1's decision (retire impl-doc artifact; cuts live in tracking issues + sub-issues) passes the three ADR criteria:

1. **Hard to reverse** — migrating 20+ impl docs is bounded but real; reversing would mean migrating sub-issues back to docs.
2. **Surprising without context** — future readers will wonder "why did the project abandon the impl-doc artifact?"
3. **Real trade-off** — POV walks documented genuine alternatives; the decision picked one for specific reasons.

ADR-0015 (next number after 0014) to land alongside this design doc when Q2 + remaining Qs lock.

## Notes

- This doc is the working artifact during grilling. As Qs lock, the "Open questions" section shrinks and the "Design" section fills in.
- Per the grill-with-docs skill, terms land in `dev-glossary.md` as they're resolved. `feature-bot`, `tracking issue`, `cut sub-issue` will be added when this design ships (along with the rename of "impl doc" to a historical term).
