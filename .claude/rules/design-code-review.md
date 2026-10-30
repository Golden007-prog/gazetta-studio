# Code Review

How code review works in this project — what reviews exist, who invokes them, what artifacts are produced. Designed around the **two-phase model** (Discovery → Evaluation) and the **multi-angle skill family** that lets one skill set serve four consumers: local CLI, PR-comment trigger, fix-bot reviewer, and an autonomous review-bot.

**This doc covers the design:** scope, the two-phase model, skill family, severity model, dispatch, consumer action policies, foundational checks, UX, distinctive choices.

**Companion docs:**
- [`design-code-review-implementation.md`](design-code-review-implementation.md) — phased cut sequence, scope per cut, deferred items
- [`docs/adr/0012-skill-three-invocation-modes.md`](../../docs/adr/0012-skill-three-invocation-modes.md) — load-bearing decision: a Skill is one prompt body usable interactively, headlessly, and as a sub-agent
- [`docs/adr/0013-code-review-two-phase-model.md`](../../docs/adr/0013-code-review-two-phase-model.md) — load-bearing decision: Discovery (audit-area) and Evaluation (review-orchestrator + 6 angles) are separate skill families
- [`feature-design-process.md`](feature-design-process.md) — defines the design + implementation + ADR artifact pattern
- [`dev-glossary.md`](dev-glossary.md) — Skill, Bot, Reviewer, Generator-critic loop, Skip-list, Findings fence, Review angle, Severity
- [`bots/README.md`](../../bots/README.md) — Producer vs consumer rule; bot conventions
- [`team-preferences.md`](team-preferences.md) — rules 15/18 (SOLID), 24 (5K envelope), 31 (TDD-first / tautology), 33 (PR workflow)

## Scope

**In v1:**
- One **discovery** skill: `audit-area` — given a path or paths, surface candidate improvements ranked by severity
- One **evaluation orchestrator** skill: `review-orchestrator` — given a diff, dispatch to relevant angle skills and aggregate findings
- Six **evaluation angle** skills: `review-diff`, `review-architecture`, `review-security`, `review-tests`, `review-types`, `review-comments`
- One TS dispatch helper at `.claude/skills/review-orchestrator/dispatch.ts` that maps a diff to the list of angle skills to invoke
- Three consumers wired:
  - **Local CLI** — `/audit-area`, `/review-orchestrator`, `/review-{angle}`
  - **PR-comment trigger** — `@claude review [angle...]`, `@claude audit <path>` on PRs (workflow: `review-on-comment.yml`)
  - **Fix-bot reviewer** — `review-architecture` and `review-security` invoked as sub-agents (replacing the existing project-rule check)
- One autonomous bot: **`review-bot`** — picks an area (TS narrowing + LLM pick), invokes `audit-area`, picks top candidate, Agent A makes a change, Agent B (review-orchestrator) reviews it, opens PR on approve
- Glossary additions: Review angle, Findings fence, Severity, Generator-critic loop, Skip-list

**Reserved in v1 (skill family supports, no UI surface):**
- `audit-area` accepting multi-path input (the data structure supports it; the local CLI ships with single-path invocation in v1)

**Out of v1 (explicit):**
- `--paths` mode on evaluation skills (Phase 2 is diff-only by design)
- Cross-run "still present / resolved" annotation in any consumer (developer-iteration use case acknowledged but not built; v1 ships fresh-each-run)
- Per-finding stable fingerprint across invocations (skip-list at the candidate level covers review-bot's cross-run need)
- Auto-fix mode (review skills are advisory; fix-bot owns auto-fix for bugs; future `auto-fix-review` is a separate skill family)
- IDE plugin integration beyond the CLI invocation surface
- Review of issues (the comment trigger filters PRs only; issues have a different lifecycle owned by triage/discovery-prep/fix bots)

**Non-goals:**
- Replacing fix-bot's runtime tautology check (the 4-step revert+rerun) — that stays in fix-bot's reviewer; review-tests does static + judgment only
- Replacing dead-code-watcher's reviewer (deletion-specific checks; no skill invocation needed)
- Becoming a "code coverage" or "test coverage" gate — review-tests judges test quality, not metric coverage
- Becoming a linter — review-diff catches what humans should catch, not what eslint/biome catches

## The two-phase model

Code review breaks naturally into two phases with different shapes:

| Phase | Question | Input | Output | When invoked |
|---|---|---|---|---|
| **Discovery** | What's worth changing in this area? | Path(s) | Ranked candidate improvements | Review-bot Phase 1; `/audit-area` interactive; `@claude audit <path>` on PR |
| **Evaluation** | Is this proposed diff good? | Diff | Findings (with severity, file:line, rule) | Local CLI `/review-orchestrator`; PR-comment `@claude review`; fix-bot reviewer (Agent B); review-bot's Agent B |

Phase 1 is **forward-looking** — "where should I improve?" Phase 2 is **backward-looking** — "is this change sound?" Confusing them produces a skill that's mediocre at both. They share infrastructure (severity model, output format, decision-log convention) but ship as separate skills with distinct invocation contracts.

ADR-0013 captures the locked decision.

## Skill family

```
.claude/skills/
├── audit-area/                       # PHASE 1 — Discovery
│   ├── SKILL.md
│   └── tests/                        # vitest tests for any TS helpers
│
├── review-orchestrator/               # PHASE 2 — Evaluation orchestrator
│   ├── SKILL.md
│   ├── dispatch.ts                   # diff → list of angle skills to invoke
│   └── tests/
│
├── review-diff/SKILL.md               # PHASE 2 — bugs/style/CLAUDE.md baseline
├── review-architecture/SKILL.md       # PHASE 2 — foundational dimensions + ADR + design-doc fit
├── review-security/SKILL.md           # PHASE 2 — SSRF, capability bypass, sanitization, secret leakage
├── review-tests/SKILL.md              # PHASE 2 — TDD ordering, tautology (static), tier shape, isolation
├── review-types/SKILL.md              # PHASE 2 — invariants, encapsulation, illegal-states-unrepresentable
└── review-comments/SKILL.md           # PHASE 2 — comment accuracy, rot, completeness
```

Eight files. Each SKILL.md is self-contained and follows the broadened Skill contract (ADR-0012): one prompt body, three invocation modes (interactive, headless from a bot, sub-agent from another Claude session).

### Why this set, not the upstream `pr-review-toolkit` set

The Anthropic `pr-review-toolkit` plugin ships six agents (`code-reviewer`, `comment-analyzer`, `pr-test-analyzer`, `silent-failure-hunter`, `type-design-analyzer`, `code-simplifier`). Gazetta's family overlaps and diverges:

| Gazetta angle | Maps to toolkit | Differs because |
|---|---|---|
| `review-diff` | `code-reviewer` | Same purpose. Tuned to CLAUDE.md + team-preferences rules. |
| `review-architecture` | NEW — no toolkit equivalent | Walks the 13 foundational dimensions + ADRs + design-*.md. Specific to this project's structural model. |
| `review-security` | NEW — no toolkit equivalent (silent-failure-hunter is adjacent but error-handling-only) | SSRF, capability gates, RBAC, sanitization (SVG/MIME), secret-leakage are project-specific surfaces |
| `review-tests` | `pr-test-analyzer` + extra | Adds TDD ordering check, tautology detection (static), tier-shape per `testing-plan.md`, isolation per rule 26 |
| `review-types` | `type-design-analyzer` | Same purpose. Tuned to Zod-schema-driven types + `Content<typeof schema>` + capability interfaces. |
| `review-comments` | `comment-analyzer` | Same purpose. No project-specific divergence. |
| Dropped from toolkit | `code-simplifier` | Not review; refactor. Belongs in a separate skill family if it ever earns one. |
| Dropped from toolkit | `silent-failure-hunter` | Folded into `review-diff` for v1. Promote to standalone if error-handling becomes a frequent finding category. |

## Skill contract

### Input

Single mode: **diff** (for Phase 2 evaluation skills). The orchestrator gathers the diff from the appropriate source per consumer:

| Consumer | Diff source |
|---|---|
| Local CLI `/review-orchestrator` | `git diff HEAD` (uncommitted) or `git diff main...HEAD` (branch vs main) |
| PR-comment trigger | `gh pr diff <N>` |
| Fix-bot reviewer (Agent B) | `git diff main...fix/issue-NNN` |
| Review-bot Agent B | `git diff main...improve/<candidate-id>` |

The skill receives a structured payload:

```yaml
mode: diff
base: main
files:
  - path: packages/gazetta/src/auth/principal.ts
    status: modified
    content: |
      [unified diff or full file as needed]
  - path: packages/gazetta/src/auth/principal.test.ts
    status: added
    content: |
      [...]
metadata:
  pr: 123                  # present only when source is gh pr diff
  base: main
  commit_log:              # present for diff-from-branch invocations
    - "test: failing test for principal capability check"
    - "fix: enforce capability gate on /api/admin/users"
```

The orchestrator constructs this payload (producer work). Each skill SKILL.md documents which payload fields it reads.

### Phase 1 (`audit-area`) input

Different shape — takes a path or paths instead of a diff:

```yaml
mode: paths
paths:
  - packages/gazetta/src/auth/
focus: security            # optional hint; "architecture" / "tests" / "security" / null (full sweep)
```

### Output — Findings fence

Every Phase 2 skill emits:

1. **Prose reasoning** with `> Decision: ...` notes per `bots/README.md`'s decision-log convention. Includes which docs were read and why.
2. **JSONL findings fence** — possibly empty — at the end:

````
```findings
{"severity":"CRITICAL","file":"packages/gazetta/src/auth/principal.ts","line":47,"confidence":92,"category":"security","rule":"design-auth-rbac.md#capability-gate","message":"...","suggestion":"..."}
{"severity":"IMPORTANT","file":"packages/gazetta/src/auth/principal.ts","line":89,"confidence":85,"category":"validation","rule":"design-validation.md#save-delta","message":"...","suggestion":"..."}
```
````

Six fields per finding:

| Field | Purpose |
|---|---|
| `severity` | `CRITICAL` / `IMPORTANT` / `NIT` (absolute, not consumer-relative) |
| `file` | Repo-relative path |
| `line` | First line of the issue in the new (post-change) file |
| `confidence` | 0-100; threshold ≥80 to emit |
| `category` | Coarse type: `correctness` / `security` / `architecture` / `tests` / `types` / `comments` / `style` |
| `rule` | Citation to the project doc that defines the rule violated. Format: `doc-name.md` or `doc-name.md#anchor` |
| `message` | One-sentence problem description, human-readable |
| `suggestion` | One-sentence concrete fix |

When the skill has no findings ≥80 confidence, the fence is **empty** but still present:

````
```findings
```
````

The prose above the empty fence explains what was checked (which dimensions, which docs, why nothing fired). Per Krug rule 23: absence is itself a state, and the explanation prevents readers from mistaking "no findings" for "didn't run."

### Output — Candidates fence (Phase 1)

`audit-area` emits a different JSONL schema since its output is forward-looking, not backward-looking:

````
```candidates
{"area":"packages/gazetta/src/auth/","type":"security","severity":"IMPORTANT","summary":"capability check missing on 3 admin routes","suggested_action":"add requireCapability middleware to /api/admin/users, /api/admin/roles, /api/admin/audit-log per design-auth-rbac.md line 142","confidence":85,"rule":"design-auth-rbac.md#capability-gate"}
{"area":"packages/gazetta/src/auth/","type":"tests","severity":"NIT","summary":"3 test files exceed 200 lines","suggested_action":"split into per-feature files","confidence":80}
```
````

`type` here is the angle the candidate belongs to (security / architecture / tests / types / comments / style). `suggested_action` is the **starting point** review-bot's Agent A reads when picked.

## Severity

Three levels, absolute (set by the skill, never modified by consumer):

| Severity | Trigger | Confidence floor |
|---|---|---|
| **CRITICAL** | Contract-break, security issue, foundational-dimension violation, data loss | ≥ 90 |
| **IMPORTANT** | Rule violation, missing test, misleading commit message, cross-cutting concern not respected | ≥ 80 |
| **NIT** | Style preference, optional improvement, praise-with-suggestion | ≥ 80 |

Anything below 80 confidence is dropped at the skill (not emitted). Cuts false positives per Anthropic's GA Code Review pattern (reported <1% FP rate).

Severity is **emitted once by the skill**; the consumer's "what do I do with a CRITICAL?" is a separate **action policy** decision (see below).

## Consumer action policies

Each consumer maps severity to behavior. Same skill output, different action:

| Consumer | CRITICAL | IMPORTANT | NIT |
|---|---|---|---|
| Local CLI `/review-orchestrator` | Red text | Yellow text | Grey text |
| PR-comment trigger | Inline PR comment + summary entry | Summary entry | Collapsed/optional |
| Fix-bot reviewer (Agent B) | `REJECT` or `NEEDS_HUMAN` | `REJECT` with Note for retry | Mention in Reasoning; don't block |
| Review-bot Agent B | `REJECT` or `NEEDS_HUMAN` | `REJECT` with Note for retry | Mention in Reasoning; don't block |

The "action policy" lives in each consumer's prompt or orchestrator code. The skills themselves are policy-free judges.

## Dispatch

The Phase 2 orchestrator decides which angle skills fire based on what the diff touches. Decision is **deterministic** (a path-glob table in TS), then sub-agents run in **parallel**.

### Dispatch table (documented in `review-orchestrator/SKILL.md`)

| Diff includes… | Always | Conditionally |
|---|---|---|
| Any code change | `review-diff` | — |
| `tests/`, `*.test.ts`, `*.spec.ts` | + `review-tests` | — |
| New / modified `z.object(...)` or `interface`/`type` | + `review-types` | — |
| `packages/gazetta/src/{audit,validation,hooks,auth,review,scheduling,soft-delete}/`, `.claude/rules/design-*.md`, `docs/adr/` | + `review-architecture` | — |
| `admin-api/`, `providers/`, `*sanitize*`, `*capability*`, `*auth*`, dependency-version bumps in `package.json` | + `review-security` | — |
| Comment-only changes | + `review-comments` | — |

### Implementation

`dispatch.ts` is ~50-100 lines of TypeScript that:
1. Reads `git diff --name-only` (or accepts a path list)
2. Matches paths against the table
3. Reads diff content for fine-grained checks (e.g., "does this diff include `z.object`?")
4. Emits one angle skill name per line on stdout

The orchestrator's SKILL.md calls `dispatch.ts` via Bash, reads the line-separated list, spawns each as an Agent sub-task **in parallel** (single message, N Agent tool calls).

Tests live under `.claude/skills/review-orchestrator/tests/dispatch.test.ts` (vitest).

## Aggregation

When sub-agents return their JSONL findings, the orchestrator aggregates:

1. Parse each sub-agent's response for its `findings` fence (regex against ` ```findings ... ``` `)
2. Concatenate all JSONL lines
3. Group by `(file, line, category)` — keep one per group: max severity → max confidence → longest message
4. Drop findings with `confidence < 80` (belt-and-suspenders; skills already filter)
5. Sort: severity rank (CRITICAL=0, IMPORTANT=1, NIT=2), then file path alphabetical
6. Render to consumer: counts + per-finding lines + per-finding `rule` citation

The orchestrator's output is **structured stdout**: a markdown summary + a fresh `findings` JSONL fence holding the aggregated set. Whichever caller invoked the orchestrator (local CLI, comment-trigger workflow, fix-bot reviewer, review-bot Agent B) reads stdout and applies its action policy.

## Review-bot (autonomous)

The third bot with the generator-critic loop pattern (after dead-code-watcher and fix-bot). Mirrors their layout under `bots/review-bot/`.

### Pipeline

```
Phase 0 — Pick an area  (TS orchestrator + LLM)
  - TS scores top 5 areas by:
    - Recently-touched but not bot-reviewed (git log + outcome-tag query)
    - Validators flagging issues in that area
    - Mutation surviving counts (from mutation-watcher data)
    - Coverage gaps
    - Skip-list-aware: drops areas with active or recently-closed review-bot PRs
  - LLM picks one of the 5 with context: candidate list + per-area one-liner

Phase 1 — Discovery  (audit-area skill)
  - Invoke audit-area on the picked area
  - Output: ranked candidates JSONL fence

Phase 2 — Pick top candidate  (TS)
  - Sort candidates by (severity, confidence)
  - Skip any whose fingerprint matches skip-list
  - Pick top remaining

Phase 3 — Make the change  (Agent A)
  - Orchestrator composes the shared agent-a.md base + the per-type
    recipe from prompts/recipes/ (selected by `recipe-select.ts`)
  - Recipes today: `tdd-first` (correctness/security/architecture/types/
    comments/style) + `coverage-shape` (tests) + `mechanical-cleanup`
    (comments/tests/correctness candidates whose action is a pure,
    no-behavior-change deletion: one deletion-only commit, with zero
    references and a green suite in place of a counterfactual; the
    orchestrator rejects a diff that adds lines, and Agent B is told
    to treat any behavior change as CRITICAL). New recipes land at
    prompts/recipes/<shape>.md + one switch arm in `recipe-select.ts`
  - Agent A follows the recipe's commit shape + anti-tautology
    discipline; tdd-first emits 2 commits, coverage-shape emits 1

Phase 4 — Review the diff  (Agent B — review-orchestrator skill)
  - Invoke review-orchestrator on git diff main...improve/<candidate-id>
  - Agent B (the orchestrator skill) emits aggregated findings

Phase 5 — Verdict  (TS orchestrator parses aggregated findings)
  - CRITICAL findings → REJECT (or NEEDS_HUMAN if no retry can help)
  - Only IMPORTANT → REJECT with note for Agent A's next attempt
  - Only NIT or empty → APPROVE
  - APPROVE: push branch, open PR
  - REJECT: reset, retry up to MAX_ATTEMPTS (default 5)
  - NEEDS_HUMAN: record in skip-list, post a note for maintainer
```

### Durable memory (per `bots/README.md` "Durable memory pattern")

| Artifact | Persistence |
|---|---|
| `bots/review-bot/skip-list.json` | Committed; "don't re-propose these candidates" keyed by candidate fingerprint |
| `bots/review-bot/lessons-learned.md` | Committed; cross-finding patterns; loaded into Agent A's prompt every run |
| `bots/review-bot/reviewer-log.jsonl` | NOT committed; persisted via `actions/cache@v4` keyed `review-bot-reviewer-log-v1`; raw input to compactor |

Past-PR feedback loop (`bots/review-bot/past-pr.ts`): before investigating, check for recent review-bot PRs touching this candidate's area. Closed-not-merged → mine the rejection reason → add to skip-list. Open → wait. Merged → no-op.

Compaction (`bots-compact.yml` weekly): rewrites lessons-learned from skip-list + reviewer-log patterns. Same shape as dead-code-watcher's compactor.

### Workflow

```yaml
# .github/workflows/review-bot.yml
on:
  schedule:
    - cron: '30 04 * * *'    # daily; after fix-bot (04:00)
  workflow_dispatch:

concurrency:
  group: review-bot           # per ADR-0011
  cancel-in-progress: false
```

Permissions: `actions: read`, `issues: read`, `contents: write` (commits to branch), `pull-requests: write` (opens PR).

## PR-comment trigger workflow

`.github/workflows/review-on-comment.yml` listens to `issue_comment` events on PRs only.

### Grammar

| Comment text | Triggers |
|---|---|
| `@claude review` | Full Phase 2 orchestrator on `gh pr diff <N>` |
| `@claude review security` | Single angle (`review-security`) |
| `@claude review architecture tests` | Multiple specific angles |
| `@claude audit packages/gazetta/src/auth/` | Phase 1 `audit-area` on the path |

Filter: `if: github.event.issue.pull_request != null` — restricts to PR comments; comments on regular issues don't trigger.

### Reaction feedback

Standard Anthropic `claude-code-action` convention:
- 👀 added to trigger comment when workflow starts
- ✅ added on successful completion
- ❌ added on error

The workflow posts ONE review comment to the PR with the findings (or candidate list for audit), grouped + sorted per the aggregation rules. Each post has an outcome tag: `<!-- review-on-comment: run=$RUN_ID -->`.

Each invocation posts a fresh comment (no edit-in-place). Re-running on a fixed PR produces a new comment; the older one stays as history. (Editing in place is a future workflow polish; not v1.)

## Fix-bot reviewer integration

Existing artifact: [`bots/fix-bot/prompts/reviewer.md`](../../bots/fix-bot/prompts/reviewer.md). Today it has 5 steps:

1. Tautology check (4-step runtime: revert fix → test must fail → matches issue symptom → re-apply → test must pass)
2. Non-mechanical checks (root cause, scope creep, commit message)
3. Project-rule check (reads up to 2 design docs based on a path table)
4. (Implicit) form verdict
5. (Implicit) emit `VERDICT:` line

**v1 change:** Step 3 is **replaced**, and a new Step 3b is **added**:

- Step 3 (was: project-rule check) → invoke `review-architecture` sub-agent on the diff
- Step 3b (NEW) → if the diff touches security-sensitive paths (`admin-api/`, `providers/`, `*sanitize*`, `*capability*`, `*auth*`), invoke `review-security` sub-agent

Other angles (`review-diff`, `review-tests`, `review-types`, `review-comments`) are NOT invoked from fix-bot reviewer:

- `review-diff` would duplicate the non-mechanical checks (step 2)
- `review-tests` static check would duplicate the runtime tautology check (step 1)
- `review-types` is rare for bug fixes; can be added later if useful
- `review-comments` is rare for bug fixes

Action policy:

| Finding severity | Effect on verdict |
|---|---|
| One or more CRITICAL | `REJECT` (or `NEEDS_HUMAN` if the issue requires redesign) |
| Only IMPORTANT findings | `REJECT` with Note citing them — Agent A can address on retry |
| Only NIT findings | Mention in `Reasoning:` but don't block (still `APPROVE` if other checks pass) |
| No findings | `APPROVE` (subject to the existing checks) |

The reviewer cites the finding's `rule` field in `Note:` when REJECT-ing so Agent A knows which design doc to read.

## Dead-code-watcher reviewer integration

**No change.** Dead-code-watcher's reviewer's four checks (hidden public API, accidental refactor, misleading commit, feels architecturally wrong) are deletion-specific and don't have skill equivalents. Invoking `review-architecture` would partly overlap with "feels architecturally wrong" but adds little for deletion-specific judgment.

If a future case surfaces where deletion needs more than the existing checks, that's a separate design pass.

## Local CLI surface

Slash commands:

| Command | What it does |
|---|---|
| `/review-orchestrator` | Full Phase 2 on `git diff HEAD` (default) or `git diff main...HEAD` (with `--branch` flag) |
| `/review-orchestrator --pr <N>` | Phase 2 on `gh pr diff <N>` |
| `/review-{angle}` | Single angle directly (e.g. `/review-security`, `/review-tests`) |
| `/audit-area <path>` | Phase 1 on the path |

Default invocation is uncommitted-changes review (`git diff HEAD`). Developers iterating on Claude-generated code see fresh findings on each invocation; cross-run "still present / resolved" annotation is not built in v1 (see Out of v1).

## Foundational checks

How code review composes with each of the 13 foundational dimensions plus the multi-instance discipline. Code review is itself dev-process infrastructure, not a foundational dimension; this section is brief.

### Multi-instance discipline
- Skills are stateless. Multi-instance admin / multi-developer / multi-bot invocation has no shared in-memory state.
- review-bot's skip-list and lessons-learned persist via committed files (atomically updated via PRs) and `actions/cache` (single-instance via workflow concurrency group). Same pattern as dead-code-watcher / fix-bot per ADR-0011.

### Scale (#1)
- Skills are invoked per-PR or per-diff; no whole-repo walks at invocation time. Phase 1 `audit-area` accepts a path argument that scopes the read.
- review-bot's Phase 0 scoring is O(area-count); at 5K-page envelope the relevant areas number in low tens (per package / per directory granularity). Comfortable.
- Findings aggregation is O(N-findings) per invocation; bounded by what fits in one Claude response context (~hundreds).

### Locale (#2)
- Skills don't translate findings. Findings are emitted in English (the project's editorial default). Future localized review output is not in scope.
- Reviewing locale-variant code (`page.fr.json`, `hero.asset.fr.json`) is no different from reviewing the default-locale equivalents; the skill reads what's in the diff.

### Themes (#3)
- N/A. Skills are dev-process artifacts; no theme variant.

### Auth + RBAC (#4)
- Skill invocations happen in three contexts (local CLI, headless bot, sub-agent) — none traverses gazetta's `Principal` / capability system. Review skills are project-development infrastructure, not runtime authorization surface.
- The PR-comment-trigger workflow uses `GITHUB_TOKEN` to read PRs and post comments; standard Actions auth. No `Principal` involved.

### Audit (#5)
- Skill invocations don't emit gazetta-style audit events. Forensic record lives in:
  - Bot transcripts (90-day GH Actions artifact)
  - Outcome tags on PR/issue comments
  - PR + commit history for review-bot's proposed changes
- If a compliance use case ever requires "every code review event captured to gazetta audit log," that's a future surface; not v1.

### Review workflow (#6)
- Distinct from gazetta's content review workflow (`design-review-workflow.md`). Code review is dev-process; content review is product feature. They don't overlap.

### Hooks (#7)
- No code-review hooks. Skill invocations are fire-and-forget; their stdout is the only output.

### Render (#8)
- N/A. Skills operate on source code + design docs, not on rendered output.

### Validation (#9)
- `review-architecture` may surface validation-system violations (a new validator firing at the wrong phase per `design-validation.md`) as findings. It does NOT itself run validators against the diff — that's the build / CI's job.
- The validator framework's `Validator` interface is distinct from review skills. A future angle skill could focus exclusively on validator quality; not v1.

### Plugin (#10)
- Skills aren't an extension surface for plugins. Operators wanting different review behavior fork the skill SKILL.md or write their own.
- Future direction: `.claude/skills/` could become operator-extensible (drop in `review-{custom}/SKILL.md`); the orchestrator's dispatch table would need to learn about it. Not v1.

### Cache (#11)
- No caching across invocations. Each invocation is fresh (per Out of v1).

### Offline (#12)
- Skills work offline (read files + emit stdout). Bot orchestrators need GitHub network access; that's an infrastructure-layer concern, not skill-layer.

### Collaboration (#13)
- Findings on PRs surface as PR comments — the same surface gazetta's collaboration design uses for content comments. The two don't conflict because they're on different platforms (GitHub PR comments vs admin in-app comments).

## UX check (per team-preferences rule 23)

Per Krug-aligned UX principles applied to developer + bot UX:

### Absence is a state
- Empty findings fence + prose-what-was-checked surfaces "no findings" as a definite outcome, not silence. Developer sees evidence the skill ran.
- "Resolved since last run" annotation is **NOT shipped** in v1 — Krug-allowed: developer-iteration use case can rely on within-conversation memory + fresh review.

### Universal language
- `CRITICAL` / `IMPORTANT` / `NIT` are not project-specific neologisms — they're industry-standard severity terminology.
- `findings` / `candidates` distinguish Phase 2 vs Phase 1 outputs unambiguously.

### Same affordances across contexts
- Same SKILL.md for local CLI / headless bot / sub-agent. Developer's mental model unchanged by invocation mode.
- Same severity scheme + same output format across all six angle skills. Reading one finding looks the same as reading another.

### Plain language
- Finding `message` field is one sentence describing the problem in human terms.
- Finding `suggestion` field is one sentence describing the fix.
- No internal jargon ("VERDICT" stays as fix-bot reviewer's contract; skills don't emit it).

### No help-tooltips-as-bandaid
- The dispatch table is in the skill prompt + as TS code; readers see both. No "we'll write a help page" required.
- The severity definitions are in the skill prompts themselves; no external glossary lookup needed.

## Distinctive choices

| Choice | What we picked | What was rejected |
|---|---|---|
| **Skill definition** | Broadened: one prompt body, three invocation modes | Narrow Skill = interactive-only; would force a new term ("Review module" / "Prompt"). ADR-0012. |
| **Phase split** | Discovery (audit-area) + Evaluation (orchestrator + 6 angles) | Single family with `--discover` mode (mode-confusion in skill body); single mega-skill (loses parallelism). ADR-0013. |
| **Dispatch** | Deterministic TS table; parallel sub-agents | LLM-chosen dispatch (non-determinism, context burn, producer/consumer violation); always-run-all (waste on trivial diffs); LLM-hierarchical (two layers of dispatch reasoning) |
| **Output format** | Prose with `> Decision:` + JSONL findings fence | Markdown table (semantic-dedup-burdens-Claude); free-form prose (no structure); verdict-line-only (loses per-finding detail) |
| **Severity** | Skill emits absolute; consumer applies action policy | Consumer-relative severity (loses Claude's domain knowledge); raw scores (every consumer reimplements thresholds); two-pass scoring (premature complexity) |
| **Dedup** | Within-run by (file,line,category); no cross-run fingerprint | Per-finding fingerprint (over-built — only useful for iteration use case which isn't v1) |
| **Confidence floor** | ≥80 dropped at skill | Surface all findings (signal-to-noise) — Anthropic GA's <1% FP rate driven by aggressive filtering |
| **Input mode** | Diff only (Phase 2); paths (Phase 1) | `--paths` for Phase 2 (would push audit into evaluation skills, conflating the phases); `--pr` separately (PR is just a diff with metadata) |
| **Fix-bot integration** | Replace project-rule check with `review-architecture`; add `review-security` for sensitive paths | Additive (keep both — duplication); replace project-rule with all 6 angles (duplicates tautology + non-mechanical checks); skip integration (loses fix-bot quality lift) |
| **Review-bot Phase 0** | TS narrows top 5; LLM picks one with context | Fully deterministic (misses "feels neglected"); fully LLM (burns context on a sort) |
| **Comment grammar** | `@claude review [angle...]` + `@claude audit <path>` | `/review` (no upstream precedent; inconsistent with @claude); review-on-issues (unclear ownership with triage/discovery-prep) |
| **Cross-run state** | None (each invocation fresh) | `.gazetta/.review-state.jsonl` (premature; iteration use case not committed); fingerprint-in-comment block (over-built) |

## Migration

None — this is new infrastructure. Existing review surfaces continue to work:

- Existing `/review-prs` slash-command skill (project-local, walks open PRs) is **unchanged**. It composes naturally with the new family: a future enhancement could have `/review-prs` invoke `review-orchestrator` per PR, but v1 keeps them separate.
- Existing fix-bot reviewer (`bots/fix-bot/prompts/reviewer.md`) is **modified** per the integration section.
- Existing dead-code-watcher reviewer (`bots/dead-code-watcher/prompts/reviewer.md`) is **unchanged**.
- Existing global pr-review-toolkit plugin (`~/.claude/plugins/...`) is **unaffected**; users can install both. Project-level `.claude/skills/` review-* skills shadow any global skill with the same name in this repo, but the global plugin's `/pr-review-toolkit:review-pr` slash command is namespaced and unaffected.

## Open implementation questions

1. **Dispatch table fidelity.** The proposed table covers the common path patterns but won't catch everything (e.g., a Zod schema added inside `apps/admin/src/client/`). Some refinement after first 10-20 invocations is expected.

2. **`review-architecture` context loading.** Per the Q-decision, it always loads CLAUDE.md + dev-glossary.md + the 13-dimension list; per-feature design-*.md docs load on demand. The on-demand mapping (which doc per diff path) needs to be a maintained table inside the SKILL.md. Drift risk if new design docs ship without updating it.

3. **Review-bot's MAX_ATTEMPTS for review-driven retries.** Default 5 per dead-code-watcher / fix-bot. May need to be lower since the review-orchestrator can produce multiple distinct findings on Agent A's attempts.

4. **PR-comment workflow rate-limiting.** A PR with high comment activity could trigger the workflow many times. GitHub Actions has its own rate limits; the workflow's concurrency group (`review-on-comment-pr-{N}`) prevents overlapping runs on the same PR. Multi-PR fan-out is bounded by Actions limits.

5. **Skill discovery and slash-command naming.** Project-level `.claude/skills/` skills are invoked via `/<name>` in Claude Code. The 8 skills introduce 8 new slash commands. None collide with existing global skills (`/review-prs` is the only existing review skill, project-local).

6. **`audit-area` output stability under reinvocation.** Re-running `audit-area` on the same path should produce roughly stable candidates (modulo new commits to that path). Validating this in practice is part of cut acceptance.

## Future directions

- **Cross-run "resolved / still present" annotation** for the local CLI iteration use case. Add when concrete demand surfaces from generated-code iteration workflows.
- **Custom angle skills** via plugin extension surface. Operators or contributors add `.claude/skills/review-{custom}/SKILL.md`; orchestrator's dispatch.ts learns about it. When 3+ operators want a custom angle, ship the extension surface.
- **Severity-promotion config** per consumer (e.g., review-bot treats IMPORTANT as REJECT in production-touching paths). Opt-in via a config file consumed by the orchestrator. Currently each consumer's action policy is hardcoded.
- **`@claude review --reply <hash>`** in PR comments — re-run review with the previous comment's findings as input ("did the developer's fix address this?"). Approximates the cross-run-state use case without adding state.
- **Bulk-audit CLI** (`gazetta audit packages/gazetta/src/auth/`) as a non-interactive Phase 1 invocation from CI or local terminal. Currently slash-command-only.
- **Confidence calibration** — periodic review of false-positive rate per angle skill; tune confidence thresholds per category. Mutation-watcher-style nightly run to validate.
- **`silent-failure-hunter` promoted to its own angle** if error-handling findings recur frequently in `review-diff`'s output. Defer until concrete signal.
- **`code-simplifier`-style refactor skill family** as a separate set when proactive simplification becomes a workflow need. Today the Boy Scout rule (team-preferences #19) covers it in passing.
