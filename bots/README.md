# Bots

Repo-scoped bots that run on GitHub Actions cron schedules. Each bot:

- Lives in its own subdirectory (`<bot-name>/`)
- Has an `index.ts` entry point + a `prompt.md` for the headless Claude call
- Shares cross-bot infrastructure from `_lib/` (GitHub API wrapping via Octokit, Claude CLI invocation, git-tree ops, reviewer-verdict parser)
- Owns its bot-specific memory + parsers locally (per-bot `skip-list.ts`, `knip-parse.ts`, `stryker-parse.ts`, `past-pr.ts`) — different bots have different schemas, so memory doesn't leak across bot boundaries
- Has a corresponding workflow at `.github/workflows/<bot-name>.yml`

One exception: `roadmap-board/` is a tool a session runs after merging a ROADMAP change, kept here for its tests. It has no workflow or prompt, and the bot conventions (cron, transcripts, outcome tags, skip-lists) don't apply to it ([design-roadmap-board.md](../.claude/rules/design-roadmap-board.md) Q6).

## Layout

```
bots/
├── package.json              # one workspace, one entry per bot
├── tsconfig.json
├── _lib/                     # cross-bot infrastructure — only modules used by 2+ bots
│   ├── github.ts             # Octokit wrapper + repo identity
│   ├── claude.ts             # claude -p wrapper; writes JSONL transcript
│   ├── git-tree.ts           # local-tree git ops (reset, capture diff)
│   ├── reviewer-verdict.ts   # parse APPROVE | REJECT | NEEDS_HUMAN from Agent B output
│   └── replay.ts             # rerun past investigations against current prompt
├── transcripts/              # JSONL transcripts (gitignored; CI uploads as artifact)
└── <bot-name>/                       # per-bot — owns its memory + parsers
    ├── index.ts                      # entry point
    ├── skip-list.{ts,json}           # durable memory (when memoryful)
    ├── lessons-learned.md            # cross-issue patterns (when applicable)
    ├── knip-parse.ts / stryker-parse.ts / past-pr.ts  # bot-specific parsers
    └── prompts/<phase>.md            # Claude prompt templates
```

`bots/` is a top-level peer of `apps/`, `packages/`, `tools/`. They live at the
root because they're autonomous infrastructure — different audience and lifecycle
from `tools/` (developer/operator utilities run on demand).

## Conventions

- **Auth**: `CLAUDE_CODE_OAUTH_TOKEN` (Claude account subscription) + `GH_TOKEN` (GitHub Actions default token). Both flow through env; never hardcoded. The OAuth token is an org-level secret; new bots inherit it automatically.
- **Permissions**: workflow declares `actions: read` + `issues: write` (most bots) + nothing else. Add `contents: write` only when the bot commits to the repo.
- **Failure isolation**: workflow uses `continue-on-error: true`. Bot's `index.ts` wraps each per-target investigation in a try/catch so one bad investigation doesn't kill the run.
- **Dry-run**: every bot supports `DRY_RUN=1` env to list candidates without invoking Claude. Used for local testing and prompt iteration.
- **Cron**: schedule for results visible by the maintainer's morning review (09:00 CEST). Bots fire 02:00–04:00 UTC = 04:00–06:00 CEST, with 0–3h GitHub Actions skew baked in. Defensive timing guarantees worst-case completion by 09:00 CEST.

## Adding a new bot

1. `cp -r flake-watcher <new-bot>`
2. Rewrite `<new-bot>/index.ts` for the new task; reuse `_lib/` helpers
3. Rewrite `<new-bot>/prompt.md` with the new task's investigation steps
4. Add the npm script: `"<new-bot>": "tsx <new-bot>/index.ts"` in `package.json`
5. Copy `.github/workflows/flake-watcher.yml` to `.github/workflows/<new-bot>.yml`; update the cron, the run command, and the description

If three+ bots end up needing the same helper (e.g., posting structured comments, parsing test output), extract to `_lib/`. Until then, inline — and if the helper is bot-specific (a parser for one tool's output, a memory shape with one bot's domain types), keep it under that bot's directory even if it grows large. Each bot owns its own memory and domain modules; `_lib/` is reserved for genuinely cross-bot infrastructure.

## Architecture: producer vs consumer — where does work live?

The single most important question when designing a new bot is **what work lives in the orchestrator (TS code) vs the prompt (Claude)**. Get this wrong and the bot will either fail with context overruns, file duplicate noise, or do brittle pattern-matching that breaks on language variation.

**Rule of thumb:**

| Kind of work | Lives in | Why |
|---|---|---|
| Parsing, filtering, paginating, summarising large inputs | **Orchestrator (TS)** | Deterministic; testable with vitest; doesn't burn context |
| Deduping against prior bot output | **Orchestrator (TS)** | Cheap `gh issue list` filters + outcome-tag regex; needs to be reliable across runs |
| Identity / classification of inputs (which producer filed this issue?) | **Orchestrator (TS)** | Outcome-tag regex is more reliable than asking Claude to recognize bot-authored bodies |
| Interpretation, classification of natural language | **Prompt (Claude)** | Judgment work; pattern-match across context |
| Writing prose (issue bodies, comments, fix recommendations) | **Prompt (Claude)** | Generative work; needs context awareness |
| Picking which fix to apply, which test to write | **Prompt (Claude)** | Judgment work; benefits from reading the actual code |
| Deciding "the bug is too vague — apply ready-for-human and bail" | **Prompt (Claude)** | Self-awareness; needs to see the bug's repro to decide |

**Why this matters:** mutation-watcher's first iteration asked Claude to parse a 3 MB Stryker HTML report (`mutation-watcher/prompt.md` step 1: "extract the JSON via grep + node -e"). Claude *did* parse it correctly — and exhausted its context window doing so, exiting before filing any issues. The fix was `bots/mutation-watcher/stryker-parse.ts` — 50 lines of TS that handle parsing, summarising, and per-file capping. Claude now consumes a small JSON summary per file (~few KB), one Claude call per file, and writes focused issue bodies. Same architecture pattern as triage-bot's per-issue Claude call.

**Symptoms that tell you the producer/consumer split is wrong:**

- **Autocompact thrashes** ("the context refilled to the limit within 3 turns") — Claude is being asked to hold more state than fits. Move parsing/state-tracking to TS.
- **Brittle regex parsers in the orchestrator** to match Claude's output shapes — you're asking the consumer to deal with a producer that writes prose. Either tighten the producer's prompt (lock body shape) OR move what you're parsing back into TS-generated structured output.
- **Repeated `gh issue list --state open` searches that re-file duplicates** of recently-closed issues — dedup logic that only looks at open issues misses the fixed-but-still-flagged case. Search `--state all` and skip on closed-match.
- **Silent failures** (exit 1 with no comment, no label change) — orchestrator should catch non-zero exits, mine the transcript for the failure mode, post a maintainer-readable comment. See `bots/fix-bot/failure-diagnostic.ts` for the pattern.

**When in doubt:** prefer pushing work to the orchestrator. The TS code is testable (vitest), debugger-friendly (real stack traces, not transcript archaeology), and doesn't burn context budget. Claude's strengths are judgment and prose — use them there, not for stuff a parser could do deterministically.

## Running locally

```bash
# Dry-run (no Claude invocation)
DRY_RUN=1 GITHUB_REPOSITORY=gazetta-studio/gazetta-studio GH_TOKEN=$(gh auth token) \
  npm run flake-watcher -w @gazetta/bots

# Real run (invokes Claude — uses local CLI auth)
GITHUB_REPOSITORY=gazetta-studio/gazetta-studio GH_TOKEN=$(gh auth token) \
  npm run flake-watcher -w @gazetta/bots
```

## Active bots

| Bot | Trigger | Input (label-driven, except producer bots) | Output | Role |
|---|---|---|---|---|
| `flake-watcher` | Daily 02:00 UTC + workflow_dispatch | CI events (run_attempt >= 2) — not labels | New issue with `bug` + `flake` + `area: X` + `ready-for-agent` (+ `recurring-flake` when applicable) | **Producer** — self-classifies, bypasses triage |
| `mutation-watcher` | `workflow_run` on Mutation completion + workflow_dispatch | Latest Mutation artifact — not labels | New issue with `bug` + `area: X` + `ready-for-agent` per source file with surviving mutants | **Producer** — self-classifies, bypasses triage |
| `dead-code-watcher` | [`night-shift`](../.github/workflows/night-shift.yml), Thu night + workflow_dispatch | knip JSON output (files, exports, types, deps) — not labels; ≥30-day stable filter | Delete-PR per safe finding (full pipeline, NOT delegated to fix-bot) OR skip-list-entry PR | **Producer** — autonomous fixer with durable memory + generator-critic reviewer loop |
| `bots-compact` | [`night-shift`](../.github/workflows/night-shift.yml), first Sun night of the month + workflow_dispatch | All memoryful bots' skip-lists (one job per bot) | Per-bot PRs: glob-rule compaction (dead-code-watcher), lessons-learned.md rewrite (fix-bot, review-bot, cut-planner) | Memory compactor |
| `triage-bot` | Daily 03:00 UTC + workflow_dispatch | Open issue lacking all of `bug`, `enhancement`, `triage-uncertain`, `ready-for-agent`, `ready-for-human`, `wontfix`, `needs-info` | One of `bug` / `enhancement` / `triage-uncertain` + `area: X`. Reproducible bug also gets `ready-for-agent`. While fewer than 3 issues carry `good first issue`, a small bug in one area that says what should happen also gets it (#1271). | Classifier |
| `discovery-prep-bot` | Daily 04:00 UTC + workflow_dispatch | `enhancement` AND lacks all of `ready-for-human`, `ready-for-agent`, `wontfix`, `needs-info` AND body has no `**Feature**:` front-matter (design-passed work — planner issues and cuts — is never researched) | Research comment + `ready-for-human` label | Researcher |
| `fix-bot` | [`night-shift`](../.github/workflows/night-shift.yml), every night after feature-bot + workflow_dispatch | `bug` + `ready-for-agent` AND lacks all of `ready-for-human`, `wontfix`, `needs-info` AND no `fix-bot-attempted` since reopen AND no skip-list match; issues labelled `priority` first, then oldest | PR (two commits: failing test + fix) on approve, skip-list entry on reject/needs-human, OR stuck-comment + `ready-for-human` on stuck path; on an approved fix whose push or PR fails, the work saved as a patch + comment + `ready-for-human` (`delivery-failed`) | Implementer — generator-critic reviewer loop + durable memory + lessons-learned |
| `feature-bot` | [`night-shift`](../.github/workflows/night-shift.yml), every night after cut-planner + workflow_dispatch | `enhancement` + `ready-for-agent` AND lacks all of `ready-for-human`, `wontfix`, `needs-info` AND `**Depends on**:` refs all **landed** (closed by a merged PR that names them — `_lib/cut-landing.ts`) | Draft PR on APPROVE; `ready-for-human` + skip-list entry on NEEDS_HUMAN (the issue stays open); comment + `needs-info` on NEEDS_INPUT; comment + `needs-refinement` hand-off to cut-planner when the loop exhausts on a cut-planner-filed cut; comment + `needs-info` when a dependency is closed but has no evidence it landed (`dep-unverified`); on an approved cut whose push or PR fails, the work saved as a patch + comment + `ready-for-human` (`delivery-failed`). When a cut touches a story or its component, Agent B also gets screenshots of each affected story, and the PR embeds them from `bot-screenshots` release assets, which each run deletes once their PR is merged or closed | Implementer — feature cuts via generator-critic reviewer loop + durable memory + lessons-learned. See [design-feature-bot.md](../.claude/rules/design-feature-bot.md). |
| `cut-planner` | [`night-shift`](../.github/workflows/night-shift.yml), every night before feature-bot (up to 4 runs); daily 03:00 UTC as a backup; + workflow_dispatch | Planner issues (`enhancement` + `**Feature**:` + `**Design**:`/`## State`, no `ready-for-agent`) AND cut issues labelled `needs-refinement` | At most ONE action per run: a new cut sub-issue (`ready-for-agent`, or `ready-for-human` when it edits `.github/workflows/**`), a revised spec + `needs-refinement` → `ready-for-agent`, a re-decomposition, or an escalation (`needs-info` on the planner / `ready-for-human` on the cut). Before filing it checks that the feature's closed cuts actually landed; an unverified one escalates the feature (`unverified-close`) instead | **Planner** — owns the per-feature cut pipeline; feature-bot's peer, never imports it. See [design-cut-planner.md](../.claude/rules/design-cut-planner.md). |
| `mutation-area-picker` | Weekly Sun 03:30 UTC + workflow_dispatch | `stryker.config.json` + git/GitHub cross-references (AI-pairing, churn, flake, fix-rate) | Draft PR adding/swapping/removing one module in `mutate` glob, OR silent NOOP | **Strategic portfolio manager** — owns mutation scope under runtime budget. Design: [`.claude/rules/design-mutation-area-picker.md`](../.claude/rules/design-mutation-area-picker.md). Empirical eviction per [ADR-0014](../docs/adr/0014-mutation-eviction-by-empirical-evidence.md). |
| `roadmap-board` | Manual: review-decisions and review-prs run it after merging a ROADMAP change | `ROADMAP.md`, the repository's open issues and the project's items — not labels | The public Roadmap project's items, fields, views and text; a dry run unless `--apply` | **Board generator** — shows ROADMAP.md as a GitHub Project, one way. See [design-roadmap-board.md](../.claude/rules/design-roadmap-board.md). |

**Producer bots vs triage-bot.** Producer bots (`flake-watcher`,
`mutation-watcher`, `dead-code-watcher`) consume CI signal or
static-analysis output and self-classify their output, bypassing
triage-bot. Triage-bot's input contract excludes issues already
carrying `bug` / `enhancement` / `triage-uncertain`, so producer-bot
output flows straight into fix-bot's queue. The signal IS the
validation; no triage step adds value.

**Autonomous fixers vs pipeline producers.** `flake-watcher` and
`mutation-watcher` are *pipeline* producers: they file issues that
fix-bot picks up later. `dead-code-watcher` is an *autonomous*
producer: it files PRs directly, no fix-bot involvement. The
difference is whether the bot can complete the loop end-to-end.
Dead-code-watcher can because deletion's "test" is "existing tests
pass" — fix-bot's TDD-first contract doesn't compose with deletion.

**Generator-critic loop pattern.** Dead-code-watcher was the first bot
with two Claude agents in series. Fix-bot and feature-bot follow the
same pattern. Agent A (cleanup / implementation) investigates and
makes changes locally; Agent B (reviewer) inspects the diff fresh —
no shared transcript — and votes APPROVE / REJECT / NEEDS_HUMAN
(feature-bot also has a NEEDS_INPUT verdict — see
[design-feature-bot.md](../.claude/rules/design-feature-bot.md) Q6).
On REJECT, the orchestrator resets the working tree and re-runs
Agent A with the reviewer's specific note. Up to `MAX_ATTEMPTS`
iterations (default 5, configurable) before the bot gives up and
records `needs-human` in the skip-list.

The reviewer catches failure modes the test-suite gate can't:
hidden public-API surfaces (JSDoc `@public` markers), accidental
refactors disguised as deletions, misleading commit messages, and
architecturally-questionable deletions (extension points,
documented contracts). Reviewer has `Bash` + `Read` only — no
ability to push code or modify the diff. Verdict line format
`VERDICT: APPROVE|REJECT|NEEDS_HUMAN` followed by `Reasoning:` or
`Note:` is parsed by the orchestrator.

**Durable memory pattern.** Three bots have cross-run memory:
dead-code-watcher, fix-bot, and feature-bot. Each has three memory
surfaces, each with its own persistence model:

  - **`skip-list.json`** (per-bot, committed to repo) — durable
    "don't try this again" decisions. dead-code-watcher's is keyed
    by knip fingerprint; fix-bot's by GitHub issue number.
    Persists via PR + merge to main; the bot reads on checkout.
  - **`lessons-learned.md`** (per-bot, committed to repo) — distilled
    cross-finding/cross-issue patterns. Loaded into Agent A's prompt
    every run. The monthly compactor rewrites holistically;
    persists via PR + merge to main.
  - **`reviewer-log.jsonl`** (per-bot, **NOT** committed) — every
    Agent B verdict (APPROVE / REJECT / NEEDS_HUMAN) appended by the
    daily bot. The raw input the compactor reads to produce
    lessons-learned. Persists via `actions/cache@v4` keyed
    `{bot}-reviewer-log-v1` — see "Reviewer-log persistence" below.

Each memoryful bot also has a Past-PR feedback loop (e.g. `bots/dead-code-watcher/past-pr.ts`):
before investigating, the bot checks if there's a recent PR for
this fingerprint. Closed-not-merged → mine the rejection reason →
add to skip-list. Open → wait. Merged → no-op (the underlying
issue should be gone). Mining happens inside Agent A's flow on
retry attempts, not in the orchestrator's pre-pass.

**Compaction differs per bot.**
  - **dead-code-watcher's compactor** does two things in one PR:
    generalizes 3+ skip-list entries sharing a pattern into one
    glob-scoped rule (skip-list shrinks AND becomes more powerful),
    AND rewrites lessons-learned.md from cross-finding patterns
    in the reviewer-log.
  - **fix-bot's compactor** rewrites lessons-learned.md from both
    skip-list patterns AND reviewer-log patterns. The skip-list
    stays per-issue (most rejections are per-issue-unique).

Both compactors also **prune the reviewer-log** to a bounded window
(default 200 most-recent entries) after Claude succeeds — the
compactor IS the memory-trimmer for that surface, keeping the cached
file size bounded across many months of runs.

Both run in the same `bots-compact.yml` workflow (one job per bot)
on the first Sunday night of each month, started by `night-shift.yml`.

**cut-planner's memory is two-tier, with no skip-list.** Per-feature
state lives in the planner issue (body = current `## State`, comments =
append-only `> Decision:` log). Cross-feature learning uses
`decision-log.jsonl` (cached, one entry per run that examined a planner
issue) distilled monthly into `lessons-learned.md`, which is loaded into
every planning prompt. Its compactor counts only runs that *acted* —
idle and quota-stopped runs are not evidence about how cuts are
specified. It has no skip-list of its own: a terminal cut escalation is
`ready-for-human`, which already removes the cut from feature-bot's
queue. Its compactor job uses the restore/save cache split with
per-run keys (see #854 for why the static-key form other jobs use
reads a stale log).

### Reviewer-log persistence

The reviewer-log is operational signal, not the forensic record
(audit log + transcripts artifact serve that purpose). It persists
via `actions/cache` between runs, using the **restore/save split**
(not the combined `actions/cache@vN`, which skips its save on a
cache hit — #581):

  - **Cache key:** `{bot-name}-reviewer-log-v1-${{ github.run_id }}`
    on save — every run writes its own immutable entry. Restore uses
    `restore-keys: {bot-name}-reviewer-log-v1-` (trailing dash, per
    #620) to pick up the newest one. Bump the `v1` if the JSONL
    schema changes incompatibly.
  - **Cache path:** `bots/{bot-name}/reviewer-log.jsonl`.
  - **Workflows that touch it:** each bot's daily workflow (appends)
    and its job in `bots-compact.yml` (prunes after producing the
    lessons rewrite). **Both must use the same split and key family.**
    Until #854 the compactor jobs used a static exact key the daily
    runs never write, so they read a stale log; a test in
    `bots/_lib/tests/compact-cache-wiring.test.ts` now pins every
    pair.
  - **Eviction:** GH Actions caches evict after 7 days from last
    access. Every daily cron touches the cache → effectively
    permanent under daily-bot cadence. A 7+ day bot outage = log
    gone; recovery is a fresh start (lessons-learned.md remains in
    the repo).

**Single-instance invariant.** Two workflows of the same bot must
never run concurrently — they'd race on the cache and lose entries.
Enforced by workflow-level `concurrency:` groups with literal
names matching across `{bot}.yml` and the corresponding job in
`bots-compact.yml`:

```yaml
concurrency:
  group: dead-code-watcher    # or 'fix-bot'
  cancel-in-progress: false   # queue, don't cancel in-flight work
```

See ADR-0011 for the full design rationale.

### Pipeline shape (label-driven)

```
Producer bots — bypass triage-bot, go straight to fix-bot's queue:
─────────────────────────────────────────────────────────────────
flake-watcher (cron 02:00 UTC)         mutation-watcher (workflow_run on Mutation)
    ↓ files issue with                     ↓ files issue with
      bug + flake + ready-for-agent          bug + ready-for-agent
                          \           /
                           \         /
Human-filed issues — go through triage:
──────────────────────────────────────
issue filed by maintainer / contributor (no labels)
    ↓
triage-bot (cron 03:00 UTC) — input: open + no classification
    ├─→ confident bug + reproducible → applies bug + ready-for-agent
    │
    ├─→ confident enhancement → applies enhancement
    │       ↓
    │   discovery-prep-bot (cron 04:00 UTC) — input: enhancement + not yet handed off
    │       ↓ posts research comment + applies ready-for-human
    │   maintainer reads comment, starts grilling at their pace
    │
    └─→ triage-uncertain → maintainer's morning queue
            gh issue list --label triage-uncertain

All confident-bug paths converge here:
─────────────────────────────────────
                          ↓
                          ↓ (bug + ready-for-agent from any source)
                          ↓
fix-bot (night-shift, every night) — input: bug + ready-for-agent + no prior fix-bot comment
    ↓ EITHER opens draft PR (failing test + fix),
      OR posts stuck-comment + applies ready-for-human
maintainer reviews PR, merges
```

### Feature cuts (cut-planner ↔ feature-bot)

```
maintainer seeds ONE planner issue per feature (enhancement + area: X,
                                                no ready-for-agent)
    ↓
cut-planner (night-shift, every night, up to 4 runs; cron 03:00 UTC as a backup)
    — one action per run, feedback first (Q5a):
    1. a cut in needs-refinement?   → revise its spec, swap back to ready-for-agent
    2. a cut still in flight?       → do nothing this run
    3. otherwise                    → file the next cut (enhancement + ready-for-agent)
    ↓
feature-bot (night-shift, every night, right after cut-planner) — implements the cut
    ├─→ APPROVE → draft PR; maintainer merges; cut closes
    └─→ loop exhausts on substantive rejects
          → comment + ready-for-agent → needs-refinement   ("hand-off")
          → back to cut-planner step 1
```

**The hand-off contract.** feature-bot posts a comment tagged
`<!-- feature-bot: needs-refinement issue=N -->` quoting Agent B's
verdict, then swaps `ready-for-agent` → `needs-refinement` (add before
remove). cut-planner reads the latest such comment, revises, and swaps
back. Budgets: cut-planner refines a cut twice, then re-decomposes it
once per feature, then escalates to a human — so feature-bot's
`MAX_HANDOFFS` (3) must equal cut-planner's `MAX_REFINEMENTS` (2) +
`MAX_REDECOMPOSITIONS` (1). `bots/cut-planner/tests/budget-coherence.test.ts`
pins this, because the two bots deliberately share no code. feature-bot
only hands off cuts cut-planner filed (it checks the cut's own body for
cut-planner's filed tag); older cuts escalate to a human as before.

**Pipeline state lives in labels, not in code or workflow runs.** Each bot's input is a label query; each bot's output is a label mutation. To re-run any bot on an issue, remove its output label — the next cron picks it up. To opt-out an issue, apply a terminal-state label (`wontfix` / `ready-for-human`).

**Maintainer queries:**

```bash
# What did the bot flag for me?
gh issue list --label triage-uncertain

# What's in design-grilling territory? (read the latest comment to know
# whether it's discovery-prep-bot's research or fix-bot's stuck case)
gh issue list --label ready-for-human

# What's queued for fix-bot / feature-bot?
gh issue list --label bug --label ready-for-agent
gh issue list --label enhancement --label ready-for-agent

# What's waiting on info or a maintainer decision? (see "needs-info semantics" below)
gh issue list --label needs-info

# Which cuts are with cut-planner for a spec revision?
gh issue list --label needs-refinement
```

`ready-for-human` is shared between discovery-prep-bot ("research done, grilling can start") and fix-bot ("stuck — needs human"). Disambiguate by reading the most recent bot comment's outcome tag.

**`needs-info` semantics (widened for feature-bot).** The label means "bot
must exclude from queue; requires additional information to proceed." Two
sources of the information may be: (1) the issue reporter (triage-bot's
"could not reproduce" path) OR (2) a design decision from the maintainer
(feature-bot's NEEDS_INPUT escalation when Agent A hits a question it
can't resolve from the cut spec + design doc), OR (3) on a cut-planner
planner issue, a design decision the planner issue doesn't lock, or a
feature cut-planner can't take further (its comment says which). The comment thread carries
specifics in both cases. Remove the label (or have the bot remove it on
its next cron after the comment thread resolves) to re-trigger bot
processing.

Each bot is independent. Failures are isolated (per-bot try/catch + workflow `continue-on-error`). The cheap bots run on their own crons; the heavy ones (feature-bot, fix-bot, review-bot, dead-code-watcher, the compactors) have no cron and are started one at a time by [`night-shift.yml`](../.github/workflows/night-shift.yml), which checks the account's Claude usage before each and stops when the week is ahead of pace. Either way the issue's label state is the input, and a failed bot never blocks the next.

**Night shift.** Every night: cut-planner (up to four runs, until one takes no action), feature-bot, fix-bot. Thursday adds dead-code-watcher, Sunday and Tuesday add review-bot, and the first Sunday of the month adds the compactors. Bot PRs are reviewed daily, so a cut merged during the day gets its successor implemented that night. Scheduled at 20:37 UTC with a 21:37 backup; GitHub starts scheduled runs late, so they usually start around 23:00–01:00 UTC. Run one lineup by hand with `gh workflow run night-shift.yml -f lineup="fix-bot review-bot"` (add `-f dry_run=1` to exercise the chain without spending budget).

**Usage budget.** The bots share the maintainer's Claude subscription (Max 20x) with the maintainer's own sessions, PR reviews and autonomous runs. Before each bot the chain reads the account's weekly usage and stops when the week is ahead of pace: up to 20% plus 10% for each day since the weekly reset, and never past 70%. From 70% to 80% stays for PR reviews and autonomous runs, external contributors' PRs first, and the last 20% for the maintainer's other work. Bots after the first also stop when the 5-hour window is at 80%. The numbers are `PACE_START`, `PACE_PER_DAY` and `BOT_WEEK_CAP` in `night-shift.yml`.

Measured on the first Max 20x runs (2026-10-23/24): one feature-bot cut, retries included, used about 1.6% of the week and 7% of a 5-hour window; a busy fix-bot night used 3–5% of the week before the upgrade. At those rates a quiet day leaves room for about two cuts and a fix-bot run that night; after a heavy day of sessions, the pace stops the chain earlier.

Decided: maintainer, 2026-10-24 (#1238). The 70% cap follows from the maintainer's two conditions that day: 20% of the week stays for other work, and the budget has to cover PR reviews and autonomous runs, external contributors included.

| Rejected | Why |
|---|---|
| A fixed cap at 50% | The bots could use the whole 50% early in the week, leaving the last days to sessions alone |
| The previous guard (the first bot always ran; later ones stopped at 80% of the 5-hour window or 90% of the week) | Nothing kept the bots from using the week's last 20%, or the room reviews need late in the week |

## Improving a bot

Bots are designed for an agent (you, in a future session) to improve over time.
Three signals make the loop work:

1. **JSONL transcripts** — every Claude invocation writes one line per event
   (tool call, tool result, assistant text) to `bots/transcripts/`. CI uploads
   them as the `<bot-name>-transcripts` artifact (90-day retention). To read a
   past run's transcripts: `gh run download <run-id> -n flake-watcher-transcripts`.
2. **Decision-log convention** — bot prompts ask Claude to articulate
   load-bearing decisions inline (`> Decision: ...`). The transcript captures
   the WHY, not just the WHAT.
3. **Outcome tags** — every comment / new issue ends with
   `<!-- flake-watcher: run=$RUN_ID -->`. Lets you query
   `gh issue list --search "flake-watcher: run=12345"` to find what the bot
   touched in any past run, joining intent (transcript) with outcome (issue
   activity).

### Replay loop (the actual improvement workflow)

```bash
# 1. Pick a recent workflow run
gh run list --workflow=flake-watcher.yml --limit 5

# 2. Read transcripts to find quality issues — over-eager dedup, missed
#    root-cause class, etc. Outcome tags let you cross-check what each
#    investigation actually produced on the issue tracker.
gh run download <run-id> -n flake-watcher-transcripts -D /tmp/transcripts

# 3. Edit the prompt (bots/<bot-name>/prompt.md)

# 4. Replay the same flakes against the new prompt — writes side-by-side
#    transcripts to bots/transcripts/<bot>/replay-from-<source-run>/.
npm run replay -w @gazetta/bots <bot-name> <source-run-id>

# 5. Diff <run-id>-original.jsonl vs <run-id>-replay.jsonl per investigation;
#    decide if the change is an improvement.

# 6. Open a PR with the prompt change; cite which past runs replay improved.
```

**Replay safety**: replays invoke real Claude with real tools. The current
prompt may instruct Claude to file/comment on issues — replays will too.
Always inspect transcripts before shipping a prompt change. Future work:
add a `REPLAY=1` env that the prompt can read to suppress side effects.
