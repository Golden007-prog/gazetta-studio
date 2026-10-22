# Dev Glossary

Process and infrastructure vocabulary used across this project's design docs,
team preferences, bots, and AI-agent surfaces. Companion to [`CONTEXT.md`](../../CONTEXT.md)
(product domain) — this file covers HOW we work, that file covers WHAT we
build.

Entries appear when a term is project-specific (precise meaning here that
doesn't generalize), used in two or more places, and surprised someone
recently (i.e. needed disambiguation in conversation or PR review). Single-use
coinages and obvious general English don't earn entries.

Add entries lazily — when a term first surfaces a real ambiguity. Don't
audit speculatively.

## Design process

**Discovery**:
Phase 1 of feature work. Read existing design docs, audit competitors, walk
the relevant scenarios, identify the actor types affected. May produce a
durable research artifact under [`docs/audits/`](../../docs/audits/) when
substantial. See [feature-design-process.md](feature-design-process.md).

**UX-grilling**:
Dedicated grilling pass for the user-facing surface, run BEFORE
implementation-grilling so UX choices aren't compromised by implementation
convenience. Walks actor scenarios, flow sketches, "what can I remove?"
(Krug-aligned), failure-mode UX, capability-gap surfaces. Output: the design
doc's "UX check" section.

**Story-as-spec** (lock-states-in-design-doc → bot-transcribes-per-cut):
The pattern for getting feature-bot to implement UX cuts reliably. The bot is
fine at *implementing* Vue components but bad at *designing* them — so the UX
design decision is locked **in the design doc** (the state table: every
component state with exact copy + `data-testid`s) during the UX-grilling pass.
Within each component cut, the bot **transcribes** that locked table into the
component's `.stories.ts` *and* implements the `.vue` to satisfy it; the story
runs green under `@storybook/addon-vitest` (`npm run test:storybook`) in CI. The independent human spec is
the design-doc table (plus the cut's `## Acceptance`), **not** a hand-authored
story file — so the bot authoring both story and component is bounded-tautology,
not free invention. This makes [team-preferences.md rule 31](team-preferences.md)
(TDD-first when delegating to AI) cover UI: the design-doc state table is the
failing spec, the story+component turn it green. Per
[ADR-0016](../../docs/adr/0016-storybook-for-bot-executable-ux-specs.md) (whose
correction history records why the earlier "human authors the story" framing
was revised). Storybook already ships (`@storybook/vue3-vite`,
`ArchiveBanner.stories.ts`); the only added infra is `@storybook/addon-vitest`
so stories execute rather than view-only.

**DevPlayground vs Storybook** (the two component-isolation surfaces):
Two surfaces, no overlap, per [ADR-0016](../../docs/adr/0016-storybook-for-bot-executable-ux-specs.md).
**DevPlayground** (`/admin/dev`) — template live-preview *with real content*;
template-developer turf ("does my template render this page correctly?").
**Storybook** — admin-shell component states (banners, dialogs, badges,
action bars) *as design + bot spec*; CMS-developer turf ("what are this
component's states, and is its implementation correct against them?"). A
component goes in Storybook when it's admin chrome with discrete states a
human designs and a bot implements; in DevPlayground when it's a content
template previewed against author content.

**5K-envelope gate**:
Pre-implementation checkpoint validating that proposed primitives hold at
the documented operating envelope (5,000 pages, 20,000 assets, 50 components
per page) per [design-scale.md](design-scale.md). Required between
UX-grilling and implementation-grilling. Failure means redesign before
proceeding — not "we'll add a sidecar later." See
[team-preferences.md rule 24](team-preferences.md).

**Implementation-grilling**:
Second grilling pass after UX-grilling. Walks the technical design tree:
architecture, data model, lifecycle, multi-instance, cache, audit, hooks,
validation, render, plugin, offline, collaboration. One question at a time
with named rejected alternatives per question.

**Grilling**:
The shared technique used in UX-grilling and implementation-grilling. One
structural question at a time, present 2-3 alternatives, recommend with
reasoning, wait for confirmation, capture decision. Codified by the
[`grill-with-docs`](https://github.com/anthropics/claude-skills/tree/main/skills/grill-with-docs)
and `grill-me` skills. The discipline: never lock a Q without enumerated
rejected alternatives ([rule 25](team-preferences.md)).

**Retrospective**:
Phase 5 of feature work. After ship (or at significant milestones), review
the session for new learnings. Produces durable artifacts: new entries in
`team-preferences.md`, updates to `feature-design-process.md`, or new ADRs.
The conversation itself is ephemeral; the artifacts are the point.

**Foundational dimensions**:
Thirteen cross-cutting concerns every feature design must respect (Scale,
Themes, Locale, Auth+RBAC, Audit, Review, Hooks, Rendering, Validation,
Plugin, Cache, Offline, Collaboration). Plus the discipline of
Multi-instance correctness. Each has its own design pass; new features
answer each one in their "Foundational checks" section.

**Non-foundational disciplines**:
Six narrower invariants that compose with implementation but don't rise to
dimension level: MCP schema discipline, real-time event-source discipline,
multi-instance discipline, logging discipline, no-aggregate-manifests rule,
capability-gap-UX-at-four-points. Documented inline in
[feature-design-process.md](feature-design-process.md), not in their own
design files.

## Design documentation

**Design doc** (`design-{feature}.md`):
Required durable artifact per feature. Captures Scope, Companion docs,
Design model, Distinctive choices, Foundational checks, UX check, Migration,
Open questions, Future directions. Survives the feature shipping; describes
the durable model. Distinct from the implementation doc (which is pruned at
ship time).

**Implementation doc** (`design-{feature}-implementation.md`):
Working document per feature. Status table, per-cut scope, effort estimates,
deferred items, SOLID checks per cut. Pruned at the same commit that ships
the last cut — kept entries: header pointer to the design doc, deferred-items
table (for v1.5 planning), lessons learned. Cut-by-cut detail recoverable
from git log.

**Reference doc** (`design-{feature}-reference.md`):
Optional artifact when a feature design has 5+ external claims needing
versioning, licensing, or citation. Houses the fact-check ledger. Below the
5-claim threshold, inline citations in the design doc are clearer.

**Companion docs block**:
Standard section near the top of every design doc listing the impl doc,
reference doc, and any ADRs that travel with the feature. Tells a cold
reader which docs go together. Format: `- [name](relative-path) — one-line
description`.

**Foundational checks**:
Required section in every new design doc answering each of the 13
foundational dimensions plus the multi-instance check. Documents the
feature's interaction (or non-interaction) with each. A feature designed
before a dimension's design pass has shipped MUST document the assumption
it's making about the pending dimension's contract.

**Punch list**:
Ordered, blast-radius-ranked list of cross-foundation integration test gaps
in [testing-plan.md](testing-plan.md), or deferred features in implementation
docs. Items land alongside the next feature cut that touches the relevant
foundation, not as a backlog batch.

**ADR (Architecture Decision Record)**:
Durable doc at `docs/adr/NNNN-slug.md` for load-bearing decisions. Three
criteria, all required: hard to reverse, surprising without context, result
of a real trade-off. Most decisions live as "Distinctive choices" sections
in feature design docs; ADRs are reserved for the load-bearing few.

## Testing

**Storage tier**:
Test-isolation choice. `memoryStorage()` (fresh per test, ~10ms setup) is
the default; filesystem (`createFilesystemProvider` + `tempDir`) is required
only for tests exercising real binary I/O, hash-in-path filename
construction, file watcher, or starter-site smoke. See
[testing-plan.md](testing-plan.md) "Storage tier" section.

**Per-test isolation**:
Discipline that every test gets fresh storage / fresh tempdir; no
module-level state shared between tests; no implicit ordering dependency.
Vitest's serial-within-file mode is a soft guarantee, not a contract — code
defensively. Captured in [team-preferences.md rule 26](team-preferences.md).

**Mutation scope**:
The set of source modules currently subjected to StrykerJS mutation testing.
Expanded smallest-first so the workflow calibrates triage-time and
artifact-handling on focused surfaces before tackling large ones. See
[testing-plan.md](testing-plan.md).

**Mutation-area-picker (strategic)**:
Weekly autonomous bot that owns the `mutate` glob in
`stryker.config.json`. Manages a PORTFOLIO of mutated modules under a
runtime budget (currently ~1h 45m, hard ceiling 3h). Picks one of
ADD / SWAP / REMOVE / NOOP per cron based on risk-weighted heuristic
signals (AI-pairing density, test/source LOC ratio, churn, flake
correlation, bug-fix correlation) and empirical eviction per
[ADR-0014](../../docs/adr/0014-mutation-eviction-by-empirical-evidence.md)
(kill ratio sustained + fix rate met). Bootstrap weeks 1-4 do ADD-only.
Opens a draft PR on acting weeks; exits silently on NOOP weeks. NO
compactor in v1 — at ~52 decisions/year, signal volume is too thin to
justify one; deferred until skip-list crosses 10 entries OR reviewer-log
hits its 200-entry cache ceiling. Distinct from mutation-watcher
(consumes Stryker output) and from the mutation-target-prioritiser
(tactical, per-cron).

**Mutation-target-prioritiser (tactical)**:
Per-cron bot that re-ranks the "top-N actionable files" mutation-watcher
investigates each run. Default ranking today is "highest surviving-mutant
count first"; this bot widens that with cross-references (module
importance, mutant class, churn). Designed-but-deferred surface — earns
its place when actionable-file set grows large enough that count-only
ranking misses high-value targets. Distinct from mutation-area-picker
(strategic, monthly).

**Tautological tests**:
Tests written after observing the implementation's output, asserting on what
was observed rather than what should be true. Pass without proving anything;
caught by mutation testing and prevented by TDD-first ordering. Industry
mutation scores on AI-generated tests-after-implementation hover around 20%
— meaning ~80% of injected faults survive.

**TDD-first ordering**:
When delegating non-trivial code to an AI agent, write the failing test in
commit N, the implementation in commit N+1, and tell the agent "do not
modify the failing tests." Per [team-preferences.md rule 31](team-preferences.md).
The dominant failure mode of AI test-writing is tautology; this ordering
prevents it.

**Trophy / pyramid / honeycomb shape**:
Test-distribution shapes per sub-system. Core (renderer, hash, sidecars) is
**pyramid** (heavy unit). Storage providers are **honeycomb** (heavy
integration via testcontainers). Admin SPA is **trophy** (component +
scenario). CLI is **crab** (heavy scenario). The shape determines test-tier
defaults; rule 31 also references this for which tier API tests belong to.

## Git + workflow

**Rebase posture**:
Default git strategy. Main is rebase / fast-forward only — no merge commits,
linear history. Apply at every level: PR merge via `gh pr merge --rebase`,
PR-branch updates via `git fetch && git rebase origin/main`, conflict
resolution during rebase, stacked PRs rebased on each other. See
[team-preferences.md rule 16](team-preferences.md).

**Boy Scout rule**:
When passing through a file for a real change, fix small broken things you
see along the way (pre-existing type error, dead re-export, stale comment,
missing test, obvious typo). Scope stays tight to "cheap and adjacent." See
[team-preferences.md rule 19](team-preferences.md).

## Bots and skills

**Bot**:
Autonomous, scheduled, repo-scoped automation that runs in GitHub Actions
without human invocation. Lives under [`bots/`](../../bots/). Each has its
own subdirectory with `index.ts` + `prompt.md`, shares helpers from
[`bots/_lib/`](../../bots/_lib/), runs on a daily cron via
`.github/workflows/<bot-name>.yml`. Distinct from a Skill: bots run
unattended, skills are user-invoked.

**Skill**:
A reusable Claude prompt body with defined input + output contracts.
Lives under `.claude/skills/<name>/SKILL.md` (project-level, versioned
with the repo) or `~/.claude/skills/<name>/SKILL.md` (global, cross-project).
Invokable in three modes:

- **Interactive** — user types `/<name>` in a Claude Code session; the
  skill walks them through a process step by step. Example: the
  [`triage`](https://github.com/anthropics/claude-skills/tree/main/skills/triage)
  skill.
- **Headless** — a Bot orchestrator passes the skill's prompt body to
  `claude -p` non-interactively; orchestrator parses structured output
  (e.g. JSONL findings fence, `VERDICT:` line).
- **Sub-agent** — another Claude session spawns the skill via the
  `Agent` tool; output appears as that agent's final message; the
  parent session consumes it.

The same SKILL.md serves all three modes; the skill's input + output
contract is mode-agnostic. See [`bots/README.md`](../../bots/README.md)
"Producer vs consumer" for the rule that determines what work belongs
in the skill body (Claude judgment) vs the invoking orchestrator
(deterministic parsing). Distinct from a Bot: Skills are reusable
prompt artifacts; Bots are autonomous orchestrators that may invoke
Skills among other steps. The interactive `triage` skill and the
autonomous `triage-bot` cover the same domain at different audiences;
the interactive [`review-orchestrator`](../skills/review-orchestrator/SKILL.md)
skill and the autonomous `pr-review-bot` will follow the same pattern.

**Transcript**:
JSONL stream-json artifact written by [`bots/_lib/claude.ts`](../../bots/_lib/claude.ts)
on every bot's `claude -p` invocation. One JSON event per line: tool calls,
tool results, assistant messages. Uploaded as the `<bot-name>-transcripts`
GitHub Actions artifact (90-day retention). Read by future agents to
understand what a past bot run did and why; primary input to the replay loop.

**Decision log**:
Convention requiring bot prompts to instruct Claude to articulate
load-bearing choices inline as `> Decision: <why>` text blocks. The
transcript captures the WHAT (every tool call) automatically; the
decision log captures the WHY in Claude's own words. Skip narration of
trivial tool calls — only call out choices a reviewer would want explained.

**Outcome tag**:
Convention requiring every bot-authored comment or new issue body to end
with `<!-- <bot-name>: run=$RUN_ID -->`. Lets a future agent query
`gh issue list --search "<bot-name>: run=12345"` to find every issue a bot
touched in any past run, joining intent (transcript) with outcome (issue
tracker activity).

**Replay loop**:
The mechanism for improving a bot's prompt over time. Steps: download a past
workflow's transcripts artifact, identify quality issues, edit the prompt,
run `npm run replay -w @gazetta/bots <bot-name> <past-run-id>` which
re-invokes the current prompt against the same flakes the bot saw, write
new transcripts beside the originals, diff to evaluate. Documented in
[`bots/README.md`](../../bots/README.md).

**Hard exclusion**:
Triage-bot pattern. A category of issue (security keywords, CVE, etc.) that
the bot must NEVER deep-investigate because misclassification is dangerous.
Bot applies `needs-triage`, posts a deferral notice, and exits — no labels
beyond `needs-triage`, no investigation, no agent brief. Maintainer reviews
personally.

**Soft bail**:
Triage-bot pattern weaker than hard exclusion. A category where the bot
could try but is poorly equipped (visual / UI bugs without browser,
performance complaints without baseline). Bot applies labels, posts a brief
"out of my depth" comment, exits. Distinct from hard exclusion: soft bails
are about competence (bot can't add value), hard exclusions are about
safety (bot might cause harm).

**Investigation notes**:
Triage-bot artifact for the human running `/triage` next. Includes file
paths and line numbers (transient — they may go stale in weeks but are
immediately useful). Audience: maintainer. Distinct from an Agent brief:
notes are research findings; the brief is a durable spec the AFK agent
works from.

**Agent brief**:
Durable spec on a `ready-for-agent` issue, authored by a human (not the
bot) per
[`~/.claude/skills/triage/AGENT-BRIEF.md`](https://github.com/anthropics/claude-skills/tree/main/skills/triage/AGENT-BRIEF.md).
Behavioral, not procedural. No file paths, no line numbers — those go stale
between when the brief is written and when the AFK agent picks it up. The
triage-bot does NOT write briefs; it writes Investigation notes and lets
the maintainer convert them.

**Disclaimer prefix**:
Convention requiring every AI-authored triage comment to start with
`> *This was generated by AI during triage.*`. Per the
[`triage` skill](https://github.com/anthropics/claude-skills/tree/main/skills/triage).
Lets maintainers scan an issue thread and immediately distinguish bot output
from human notes.

**Per-run budget**:
Bot pattern preventing GitHub Actions workflow timeout. Triage-bot sorts
candidates oldest-first, processes in order, exits gracefully when 50 min
elapsed (10 min margin from the 60-min workflow timeout). One-time backlog
spikes converge in 2-3 daily runs without ever hitting the timeout.

**cut-planner**:
Autonomous bot that owns a feature's cut pipeline: it files the next cut
sub-issue one at a time, revises cuts feature-bot hands back, and
escalates to a human when it can't go further. feature-bot's peer, not its
manager — they communicate only through labels and comments and never
import each other. Reads only the planner issue, never a design doc. See
[design-cut-planner.md](design-cut-planner.md).

**Planner issue**:
The one long-lived issue per feature that cut-planner works from:
`**Feature**:` + `**Design**:` front-matter, an advisory `## Suggested plan`,
cut-planner's `## State`, and the `## Locked decisions` it may transcribe.
Labelled `enhancement` + `area: X`, never `ready-for-agent`. Seeded by the
maintainer; replaces the tracking issue for features that use cut-planner.
Distinct from a **cut sub-issue** (has `## Spec`) and from a legacy
**tracking issue** (a tasklist, no planner sections).

**Landed (cut)**:
A cut that was closed by a merged PR that **names it** — `#N` in the PR
title, a `feat/cut-N` head branch, or feature-bot's `feature-bot: issue=N`
marker. Distinct from merely *closed*: #517 was closed as "completed" by
#557, an unrelated PR that only mentioned it, so the work it was meant to
deliver never existed. feature-bot's dependency gate and cut-planner's
"file the next cut" step both require *landed*, not closed
(`bots/_lib/cut-landing.ts`). Closed as "not planned" is **superseded** —
neither landed nor a defect.

**Hand-off** / **`needs-refinement` (label)**:
feature-bot passing a cut back to cut-planner after its generator-critic
loop exhausts on *substantive* reviewer rejections: a comment quoting
Agent B's verdict, then `ready-for-agent` → `needs-refinement`. A hand-off
is not the same as a refinement — cut-planner decides whether each
hand-off becomes a spec refinement or (once refinements run out) a
re-decomposition. So feature-bot counts hand-offs (`MAX_HANDOFFS` = 3) and
cut-planner counts refinements (2) and re-decompositions (1); conflating
the two units under one name once made re-decomposition unreachable.
Infrastructure failures (rate limits, `spawn E2BIG`) never cause a
hand-off — they say nothing about the spec.

## Decision review

**review-decisions**:
Skill that reviews a PR recording the maintainer's design decisions, in the
maintainer's place, and merges it when it passes. It checks that every
decision the PR locks traces to the maintainer's own answer in this
machine's session transcript, is recorded faithfully, and rests on true
facts. The AI reviewers' comments are the second opinion, and a Fable agent
adds one when the maintainer wants it. Whatever only the maintainer can decide
becomes a picker question; the author fixes its own recording errors. Distinct from the code-review skills
(`review-orchestrator` and its angles), which judge code. See
[design-decision-review.md](design-decision-review.md).

**Decision list**:
The `## Decisions` table in a design PR's body: one row per decision the PR
locks, with the session id and timestamp of the maintainer's answer, or the
decision it follows from. `review-decisions` looks each answer up in the
session transcript. Distinct from a bot's **decision log** (`> Decision:`
lines in a bot transcript), which records a bot's own reasoning.

**Decided mark**:
The line `Decided: maintainer, <date> (#<PR>)` under each locked decision a
PR adds or changes, or `Follows from <decision>` for one derived from an
earlier decision. Tells readers and contributors who made the decision;
seeding a planner issue copies it into the issue's `## Locked decisions`.
Older decisions aren't backfilled.

**Hold**:
"hold #N" in a session, or a `hold` label on the PR: `review-decisions`
won't merge that PR. Taken from Kubernetes' `/hold`.

**Session transcript**:
The JSONL file Claude Code writes for an interactive session, under
`~/.claude/projects/<project>/<session id>.jsonl`. The evidence
`review-decisions` checks (`bots/_lib/decision-answers.ts`). Distinct from
a bot's **transcript** (the `<bot-name>-transcripts` Actions artifact).

## Issue triage

**State role** / **Category role**:
Two label dimensions per the
[`triage` skill](https://github.com/anthropics/claude-skills/tree/main/skills/triage).
**Category roles**: `bug` | `enhancement`. **State roles**: `needs-triage`
| `needs-info` | `ready-for-agent` | `ready-for-human` | `wontfix`. Every
triaged issue carries exactly one of each. The triage-bot applies category
roles autonomously; advances confident bugs to `ready-for-agent` for
fix-bot to pick up; never advances to `needs-info` / `ready-for-human` /
`wontfix` (those require maintainer judgment via `/triage`).

**`needs-triage` (label)**:
Skill-canonical "no bot or human has looked yet" state. The bot does NOT
apply this label — once the bot has classified, the bot HAS looked. The
interactive `/triage` skill queries this label for issues the bot
hasn't gotten to (rare; typically only for issues filed before the bot
existed). Spelled with a hyphen per the skill's canonical name (the
project briefly used `needs triage` with a space — migrated 2026-05-10).

**`triage-uncertain` (label)**:
Bot looked but couldn't classify confidently. Applied by triage-bot when
the issue body has both bug-language AND enhancement-language, or
neither. The maintainer's primary morning queue:
`gh issue list --label triage-uncertain`. Steady-state target: 1-3 per
week. Distinct from `needs-triage` (which means "never been looked at").
The bot's lean (if any) goes in the comment body, not the label —
applying a category guess in the label would defeat the "trust labels
to mean confident classification" UX.

**`ready-for-human` (label)**:
Project-specific overload of the skill-canonical `ready-for-human` state
role. Used in three contexts:

- **discovery-prep-bot output**: "Discovery research posted as a comment;
  design grilling can start whenever the maintainer is ready."
- **fix-bot output (when stuck)**: "Tried but couldn't capture the bug as
  a failing test; needs human to write the test or close as wontfix."
- **Maintainer-applied via `/triage`**: Skill-canonical "needs human
  implementation, can't be delegated."

Disambiguate by reading the latest bot comment's outcome tag
(`<!-- discovery-prep-bot:` vs `<!-- fix-bot:`). The skill's canonical
"needs human implementation" usage is preserved — maintainer-applied
`ready-for-human` via `/triage` keeps that meaning. Three contexts on
one label is the trade-off accepted to avoid a new label per bot.

The label is also a pipeline gate: once applied, the issue is excluded
from triage-bot's and discovery-prep-bot's input queries. Maintainer
intervention is required to re-enter the bot pipeline (remove the
label).

**`flake` (label)**:
CI test-flake classification — intermittent failure, not a real bug until
proven otherwise via triage. Applied by flake-watcher to every issue it
files. Skipped only when the bot's hypothesis concludes the failure is
structurally a real bug masquerading as a flake (e.g. an equal-millisecond
ordering race). Provenance is captured by the outcome tag, not the label.

**`recurring-flake` (label)**:
Same flake observed three or more times across distinct days. Applied by
flake-watcher when the threshold is met. Signals "root-cause work should be
prioritized over continued tracking."

**Failure mode** (flake dedup grain):
The unit of flake dedup: same test path + same line (or same locator + same
symptom). Two failures of `publish.spec.ts:33` are the same mode; a failure
of `:33` and a failure of `:199` are different modes. Flake-watcher files
one issue per failure mode, not per test file — the right grain because
fixes correlate with mode, not file.

**First investigation vs subsequent investigations**:
Bot pattern. First investigation = labels applied + comment posted.
Subsequent investigations = append-only comments; labels never changed,
prior bot comments never edited. Detect by checking for any prior comment
starting with the AI disclaimer prefix.

## Flagged ambiguities

Terms the project once conflated. Resolved here so future use stays clean.

- **"Bot" vs "Skill"**: distinct surfaces (autonomous vs interactive). Don't
  call a skill a bot or vice versa.
- **"Agent brief" vs "Investigation notes" vs "Triage notes"**: three
  artifacts. Agent brief = durable spec the AFK agent works from, written
  by a human. Investigation notes = bot's research output for the maintainer
  running `/triage` next. Triage notes = informal term for what `/triage`
  produces interactively (no fixed format).
- **"Flake" the concept** (a test that intermittently fails) vs **"flake"
  the label** (provenance + classification by the flake-watcher bot).
  Resolved: the label classifies, doesn't merely tag bot provenance — the
  outcome tag handles provenance.
- **"Hard exclusion" vs "soft bail"**: both prevent the bot from
  investigating, but for different reasons. Hard = safety (bot might harm),
  soft = competence (bot can't help).
- **"Companion docs" block (in design doc)** vs **"Companion docs" the
  conceptual pairing of design + impl + reference**: same word, two scopes.
  The block is the load-bearing artifact.
