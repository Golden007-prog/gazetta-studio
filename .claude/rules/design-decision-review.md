---
paths:
  - ".claude/skills/review-decisions/**"
  - "bots/_lib/decision-answers.ts"
  - "bots/_lib/tests/decision-answers.test.ts"
---

# Decision review

A skill, `review-decisions`, reviews PRs that record the maintainer's design decisions, in the maintainer's place, and merges them when they pass. The maintainer still makes every decision, usually by answering grilling questions. The skill checks that a PR locks only what the maintainer answered, records it faithfully, and rests on true facts. Anything else comes back to the maintainer as a picker question.

**Status**: design pass complete (2026-10-22), grilled Q1–Q12. The lookup script, its tests and the skill shipped in #1132; this doc and the rule 33 clause were the skill's first review (#1133).

**Roles** used below:
- **The maintainer** makes the decisions.
- **The author** is Claude in the session with the maintainer. It writes the PR and runs the skill.
- **The checker** is a fresh Opus 5.5 agent that runs the checks (Q3, Q5).
- **The second opinion** is a fresh Fable 5.1 agent that raises concerns about the decisions (Q3a, Q5).

**Companion docs:**
- [`.claude/skills/review-decisions/SKILL.md`](../skills/review-decisions/SKILL.md): the skill
- [`bots/_lib/decision-answers.ts`](../../bots/_lib/decision-answers.ts): the transcript lookup (Q9), tested in `bots/_lib/tests/decision-answers.test.ts`
- [`team-preferences.md`](team-preferences.md) rule 33: design PRs wait for the maintainer's review, unless this skill approves them
- [`feature-design-process.md`](feature-design-process.md): how a design PR lists its decisions, and how the docs mark who made them
- [`design-code-review.md`](design-code-review.md): the code-review skills. This skill reviews decisions, not code
- [`design-cut-planner.md`](design-cut-planner.md) Q2: cut-planner copies locked decisions into cuts and never invents them, which assumes the locks are the maintainer's

## Why

Rule 33 makes design PRs wait for the maintainer's review: #963 was merged with decisions the maintainer hadn't seen, and #966 replaced its core the same day. Making the decisions costs the maintainer little, mostly one picker click each during grilling. Reading the PR that records them is what costs time: #1120 (nine files) waited hours for review, and the maintainer's answer to "merge them?" was to design this skill. Most of that review is re-reading the maintainer's own answers, which a checker can do.

## Scope

**In v1:**
- PRs that record decisions the maintainer made in a session on this machine, and touch only the files in Q7's scope
- Checks of provenance, fidelity, edits around decisions, and soundness (Q3), by the checker (Q5)
- A second opinion on each decision (Q3a), from Fable 5.1 (Q5)
- Merge on approval, then a one-line notice (Q6). A hold stops the merge (Q9)

**Out of v1:**
- Other docs-only PRs: `docs/audits/`, user docs (Q7)
- Code PRs, and anything that deploys (Q1, Q6)
- PRs from contributors and bots, which have no transcript to check (Q7)
- A digest of approvals (Q1)
- Tamper-proof evidence: a signature per PR, or a separate GitHub identity for the author (Q9; Future directions)

**Non-goals:**
- Making decisions. Neither the skill nor its second opinion can approve a decision the maintainer didn't make, or overrule one they did (Q1, Q3a).
- Judging writing quality (Q3).
- Running in CI. The evidence is on this machine (Q2, Q8).

## Locked decisions

### Q1 — Which PRs the skill may approve

The skill may approve PRs that record decisions the maintainer made, plus edits that follow from them. The maintainer still answers every design question. Rule 25 says every locked decision lists the alternatives it rejected, so any decision with a Rejected table was a real choice and needs the maintainer's answer. Edits without one (status lines, links, wording carried over from an answer) don't, but a decision derived from an earlier one has to say which one it follows from.

Escalations come as picker questions: one short question per item, with options and a recommendation, like the grilling, rather than a review brief to read. The verdict comment quotes the maintainer's actual answer for each decision, so checking any one takes seconds; it's for spot-checks only. There's no digest by default: "what did the skill approve this week?" can be answered on request. It's one skill, run as a fresh agent before merge, with no new bot or workflow.

This rests on a premise the maintainer confirmed: answering decision questions is cheap, and reading design docs is the expensive part.

Decided: maintainer, 2026-10-22 (#1133)

| Rejected | Why |
|---|---|
| A, plus small decisions the author makes that look reversible and local: wording, copy, test ids, cut order | "Looks low-risk" would be judged by the same kind of model that wrote the PR, and the maintainer would never see the cases it misjudged. It saves questions, which were never the cost |
| Any design PR; the skill escalates only problems it can detect | How #963 happened: a decision the maintainer never saw gets locked. A checker can catch contradictions, but it can't tell that a decision isn't the one the maintainer would have made |
| A short review brief; the maintainer still approves every design PR | The same bottleneck, slightly smaller |
| A, plus a periodic digest of what it approved | A recurring reading chore, the kind of process the maintainer avoids |
| Every docs-only PR: audit logs, skill edits, user docs | Those need only the maintainer's merge OK, not a design review: a separate merge-permission question |
| Every PR, code included | Code PRs already get CI, Sourcery, Seer and the author's review, so what's left is merge permission, and merging `packages/gazetta` deploys production. A separate decision, better made once the skill has a track record |

### Q2 — How the skill learns what the maintainer decided

The PR body lists each decision with the timestamp of the maintainer's answer. The skill looks up each one in the session transcript and confirms it's really the maintainer's input: one lookup per decision, instead of searching the whole file. It runs only on this machine, where the transcripts are, which fits because design PRs come out of sessions with the maintainer.

Three rules:
1. A typed "agree" accepts the recommendation in the author's message just before it. The evidence is the pair, and the doc can't lock more than that message offered.
2. Only the maintainer's own input counts. System notices, pasted text and tool output are excluded.
3. The verdict comment quotes only the picker label or the short answer, because the repo is public.

Q2 first called the transcript "the only evidence I can't write". Q9 corrects that: it is tamper-evident, not tamper-proof.

Decided: maintainer, 2026-10-22 (#1133)

| Rejected | Why |
|---|---|
| The skill searches the transcript for each decision | Slow and fuzzy: the file is 141 MB, and a short answer like "agree" means nothing without the question before it |
| A decision log the author writes during grilling, trusted as written | The author's own writing |
| The maintainer confirms each PR on GitHub, with a comment or reaction | The author posts as the maintainer's account, so a confirmation looks the same whoever wrote it |
| A channel only the maintainer can write to: a signed commit, a second GitHub account for the author, or a passphrase | As strong, but it needs setup and a step on every PR, the kind of ceremony the maintainer avoids |

### Q3 — What the skill checks

- **Provenance and fidelity:** every locked decision has the maintainer's answer, and the doc says what the maintainer chose, no more and no less.
- **Edits around decisions:** an edit without a Rejected table must cite the decision it follows from (or change no decision, per Q1). Deleting or changing an existing decision needs the maintainer's answer.
- **Soundness:** the code claims the decisions rest on are re-read at the cited file and line, and the PR mustn't contradict other design docs, ADRs, `docs/non-goals.md` or `CONTEXT.md`.

This covers both of #963's failures. It locked decisions the maintainer hadn't seen, and it rested on a diagnosis read from code, which a reproduction disproved the same day. It doesn't judge the maintainer's choices; it only says when one rests on something false or clashes with an earlier decision.

The skill can re-read code, but it can't reproduce behaviour. A claim the doc marks "read from code, not reproduced" stays a labelled hypothesis. The skill escalates only when a decision rests on a claim that turns out wrong, or on one that isn't labelled at all.

Decided: maintainer, 2026-10-22 (#1133)

| Rejected | Why |
|---|---|
| Provenance and fidelity only | A decision made on a wrong fact still passes: #963's second failure |
| Provenance, fidelity and edits around decisions | The same gap |
| All of the above, plus writing quality | Not what the maintainer's review is for: Sourcery, Seer and the docs style already cover it, and it would add escalations |
| All of the above, plus whether each decision is good | Deciding is the maintainer's, done when they answered. A model second-guessing it is Q1's "any design PR" again. The maintainer asked for a second opinion that can only raise concerns instead (Q3a) |

### Q3a — The second opinion

The maintainer wants a second opinion on their decisions as well. That doesn't undo Q1, as long as the second opinion can only raise concerns and the decision stays the maintainer's.

For each decision, the second opinion looks for **concrete** problems the maintainer wasn't shown when deciding. Each concern comes to the maintainer as a picker question with the evidence (keep or change), and the PR waits for the answer. With no concerns, there's nothing to answer. A concrete problem is one of these:
- an alternative or failure mode that's missing from the decision's Rejected table;
- a failed foundational check, such as the 5,000-page limit or multi-instance correctness;
- a clash with one of the maintainer's rules in `team-preferences.md`;
- a cost the decision didn't mention, such as being hard to reverse, affecting production, or making work for contributors.

Decided: maintainer, 2026-10-22 (#1133)

| Rejected | Why |
|---|---|
| A short assessment of each decision in the verdict comment; nothing waits on it | The maintainer doesn't read verdict comments, so a note nobody reads changes nothing |
| Any doubt becomes a question, including "are you sure?" with no new evidence | Noise: once "keep" is clicked without reading, the real concerns get lost too |
| The second opinion can refuse a decision it thinks is wrong | That's the skill deciding, which Q1 ruled out |

### Q4 — Who handles a failed check

A failed check is either something the author recorded wrong, which the author can fix, or something only the maintainer can decide. The author fixes the mechanical failures and re-runs the check; only decision-level failures reach the maintainer.

| Failure | Handled by |
|---|---|
| The doc says something different from the maintainer's answer (a recording error) | The author fixes the doc to match the answer, and the skill re-checks |
| An edit with no citation that follows from an existing decision | The author adds the citation |
| A stale cross-reference in another doc that the decision replaces | The author updates it, citing the decision |
| A wrong code claim that the decision doesn't depend on | The author fixes it and notes it in the verdict |
| A locked decision with no answer from the maintainer, including the author's own "extensions" of an answer | The maintainer |
| An existing decision changed or removed | The maintainer |
| A wrong code claim that a decision rests on | The maintainer: "Q6 assumed X, it's actually Y — keep the decision?" |
| A contradiction with an ADR, `docs/non-goals.md`, or an earlier decision of the maintainer's | The maintainer: which one wins |

Two limits:
- **A loop cap.** After three fix-and-recheck rounds without passing, the PR comes to the maintainer with what's still failing. This is cut-planner's rule (Q6a): if the job can't be completed, hand it to a human.
- **One batch per PR.** The maintainer's questions for a PR arrive together, up to four per picker, each with options and a recommendation. Every fix the author made is listed in the verdict comment.

Decided: maintainer, 2026-10-22 (#1133)

| Rejected | Why |
|---|---|
| Every failed check becomes a question for the maintainer | Floods the maintainer with things the author should just fix |
| The skill edits the PR itself | The reviewer becomes an author, then reviews its own fixes: that loses the independence Q1 needs |
| Any failure sends the whole PR back to the maintainer's review | Back to reading docs, over small issues |
| Severity levels: the maintainer sees critical failures, the rest are ignored | Whether the maintainer decided something is yes or no, not a matter of severity. An ignored "minor" unanswered decision is still one they didn't make |

### Q5 — Who runs the checks, and who gives the second opinion

A fresh Opus 5.5 agent runs the checks, which are lookups and re-reads. A fresh Fable 5.1 agent gives the second opinion. A second opinion needs independence from the author (who runs on Opus 5.5) and at least the author's capability, and Fable 5.1 is the only model with both. It also reads Sourcery's and Seer's comments on the PR: they're inputs, worth turning into questions when they hold, not the opinion itself. If Fable isn't available, a second fresh Opus agent gives the second opinion.

The cost is one Fable pass per design PR, at 2.5 times Opus's price per token, which can take several minutes. (Prices from the bundled model reference dated 2026-10-06: Fable 5.1 $10 / $50 per million tokens in / out, Opus 5.5 $4 / $20.)

Decided: maintainer, 2026-10-22 (#1133)

| Rejected | Why |
|---|---|
| One fresh Opus agent does both | The author's model, so the same blind spots; having just verified everything also anchors its opinion |
| A second fresh Opus agent gives the second opinion | Still the author's model, with its blind spots (kept as the fallback) |
| Sonnet 5.5 or Haiku 5.5 gives the second opinion | A weaker reviewer misses what the stronger author missed, and adds false alarms |
| Sourcery and Seer alone | Sourcery's free budget for the maintainer's account was spent until about 2026-10-26, and both mainly look for code bugs; they can't be asked about decisions, and their comments go unread |
| Fable and Opus both, escalating only when they agree | Twice the cost, and it would drop real concerns only one of them sees |

### Q6 — Who merges

The author merges as soon as the skill approves, or right after the maintainer answers its escalations, and then tells the maintainer in one line ("merged #1124: all 3 decisions yours, no concerns"). The approval is the review it replaces, so asking again adds nothing. Nothing in scope deploys (Q7). A wrong merge is cheap to undo: revert a docs commit, and the verdict comment shows what was approved and on what evidence.

"Ask before every merge" stays for everything outside the skill's scope, including code PRs and anything that deploys.

Decided: maintainer, 2026-10-22 (#1133)

| Rejected | Why |
|---|---|
| The author asks "merge?" each time | A yes to an approval the maintainer didn't read: a rubber stamp that only adds a wait |
| GitHub auto-merge, after the verdict is posted and checks are green | The same result with more machinery: an auto-merge setting, plus a status check for the skill to set |
| Approved PRs wait, and the maintainer confirms them all at the end of a session | Holds back planner issues and cuts, and the click is still a rubber stamp |
| A cooling-off period, say a day, then merge unless the maintainer objects | Slows everything for an objection that has no trigger, since the maintainer won't be reading the PRs |

### Q7 — Which PRs are in scope

The skill's scope is every file that records the maintainer's decisions: everything under `.claude/rules/` and `docs/adr/`, plus `CONTEXT.md`, `ROADMAP.md`, `docs/non-goals.md`, and `SKILL.md` files under `.claude/skills/`. It's the same review whichever file the decision is in: did the maintainer decide this, and is it recorded faithfully? Folders rather than a list of files, so new design or rule files are covered without updating the skill. None of these files deploy.

Two rules:
- **A PR that touches any file outside the set is out of scope.** It gets the normal review and the maintainer's merge OK. This keeps code, workflows and anything that deploys out.
- **A PR that didn't come out of a session with the maintainer is out of scope**, because there's no transcript to check: contributors' and bots' PRs.

Decided: maintainer, 2026-10-22 (#1133)

| Rejected | Why |
|---|---|
| Only the design docs rule 33 names: `.claude/rules/design-*.md`, `docs/adr/`, `CONTEXT.md` | Changes to rules, priorities and skills would still wait for the maintainer, though they record decisions the same way |
| The scope above, plus research and trial-log records under `docs/audits/` | Those contain facts, not decisions. Merging them without the maintainer's OK is the separate merge-permission question from Q1, best added once the skill has a track record |
| Any PR that touches only docs, including the user-facing docs under `docs/` | User docs make public claims about behaviour, which goes beyond "did the maintainer decide this?" |

### Q8 — When the skill runs

Right after the author opens an in-scope PR, in the same session, so escalations arrive while the decisions are fresh and the maintainer is still there. And `/review-prs` runs it on any in-scope PR still open without a passing verdict for its latest commit, which picks up PRs from a session that ended and ones that changed after their verdict.

Two rules:
- **Each verdict names the commit it checked.** If anything is pushed afterwards, the skill runs again before merge, so an approval of an older version doesn't count: the "check against the PR's head" lesson from #1122.
- **The maintainer can ask for a run at any time** ("review #1120").

Decided: maintainer, 2026-10-22 (#1133)

| Rejected | Why |
|---|---|
| Only right after the author opens the PR | PRs left open when a session ends have nothing to pick them up |
| Only when the author is about to merge | Escalations can arrive after the maintainer has left, so the PR waits for the next session |
| Only in `/review-prs` passes | Design PRs wait until the maintainer runs one |
| On a schedule, from a bot | Not possible: the transcripts are on this machine (Q2) |

### Q9 — How the lookup works

A script looks up the timestamps the PR lists, returns each answer with the question it answers, and rejects anything that isn't the maintainer's input. It also checks for tampering: each picker answer must link back to a real picker call, the chain of transcript entries must hold, and any command of the author's that wrote to a transcript file is flagged.

This corrects Q2. Claude Code writes the transcript, but nothing stops a shell command of the author's from editing it, so it is tamper-evident rather than tamper-proof. Such a command would itself be recorded in the transcript, and a faked answer wouldn't fit the links. The realistic failure is the author recording an answer wrong: paraphrasing past what was chosen, losing detail after compaction, or getting the order mixed up. The lookup catches that every time, and a deliberate fake would leave a trace, which is enough for a solo project.

Three additions, from how others record a person's decisions:
1. **Exact comparison** (from "Loopjacking", arXiv 2609.21081: "complete canonical approval rendering and exact use-time comparison"). The script returns the question exactly as the maintainer saw it: the question, each option with its description, and the pick. The doc may lock only what that shows. For a typed "agree", what the maintainer saw is the author's message just before, so recommendations must state each decision in full, never "agree with the direction, details later".
2. **A hold** (from Kubernetes' `/hold`). The maintainer says "hold #N", or adds a `hold` label, and the skill won't merge that PR.
3. **"Decided by" on every locked decision** (from MADR's decision-makers), for example "Decided: maintainer, 2026-10-22 (#1124)". Q10 places it.

Decided: maintainer, 2026-10-22 (#1133)

| Rejected | Why |
|---|---|
| Trust the decision list the author writes in the PR | Proves nothing (Q2) |
| The checker reads the 141 MB transcript itself, with grep or jq | Fragile: the "is this the maintainer's input?" rules get reapplied by hand on every run, and tampering is checked only if it remembers to |
| The lookup without the tamper checks | Blind to deliberate edits |
| A script lists all the maintainer's answers in a time range, and the checker matches them against the PR | Fuzzy matching, rejected in Q2 |
| A Claude Code hook copies each answer into a decisions file as the maintainer gives it | A plain file the author can edit, with no links to check: weaker evidence than the transcript, for more setup |
| That hook, plus a fingerprint of each answer sent to a remote log | The hook runs as the same user as the author, so its credentials are readable too: complexity without real gain |
| A one-click "are these all yours?" picker per PR | Adds the maintainer's effort but no trust: the click goes into the same transcript |
| The maintainer signs each PR's decision list with a key that needs a passphrase or hardware touch | Tamper-proof, at the cost of a step on every PR, the ceremony this skill exists to remove. It can be added on top later without redoing anything |
| The author gets its own GitHub identity (a bot account or GitHub App), so the maintainer's GitHub actions can only be theirs | Tamper-proof on GitHub, but it brings back a click per PR, and changes every `gh` step the author runs (Future directions) |

### Q10 — How decisions are recorded

**In the PR body** (fixed by Q2 and Q9), a `## Decisions` table that the lookup reads: one row per decision, with where it is, the decision in one line, the maintainer's answer (session and timestamp), and its kind: `yours`, or `follows from <decision>`.

**In the docs**, a line under each locked decision the PR adds or changes: "Decided: maintainer, 2026-10-22 (#1124)". A decision that follows from another cites it instead: "Follows from Q2 F1". The mark sits where the decision is read, which matters for cut-planner when it copies locked decisions into cuts. It's MADR's "decision-makers" idea applied per decision, since our docs hold many decisions. It costs one line per new decision, and it makes derived decisions name their source, which Q1 already requires.

Older decisions aren't backfilled: only decisions a PR adds or changes get the mark. Session ids and timestamps stay out of the docs, because a reader can't use them; they live in the PR list and the verdict comment.

Decided: maintainer, 2026-10-22 (#1133)

| Rejected | Why |
|---|---|
| A table at the top of each design doc listing every decision with who and when | Drifts from the Q sections it repeats, and the doc grows a second copy of every decision |
| One metadata block per doc, MADR-style | Our docs hold many decisions from different dates, while MADR covers one decision per record |
| No mark in the doc; provenance only in the PR and the verdict comment | Nobody can tell from the doc who decided, which matters to readers and to cut-planner |

### Q11 — Name and home

The skill is `review-decisions`, in `.claude/skills/review-decisions/`. The name fits the existing `review-*` skills and says what it reviews; "maintainer-review" would suggest it replaces the maintainer, which for decisions it doesn't. Its design is this doc, which has a `paths:` header so it's read only when someone works on the skill, the way `testing-plan.md` loads only for tests. The one thing every session needs, how a design PR lists its decisions, goes as a few lines in `feature-design-process.md`, which is always loaded. Small amendments to rule 33, `review-prs` and `dev-glossary.md` complete it.

The lookup script and its tests live in `bots/_lib/` (`decision-answers.ts`, tests in `bots/_lib/tests/`), like `review-orchestrator`'s `review-dispatch.ts`, so CI's bots job runs the tests. This replaces Q11's first answer, which put them in the skill folder.

Decided: maintainer, 2026-10-22 (#1133)

| Rejected | Why |
|---|---|
| A section in `design-code-review.md` instead of a new doc | That doc covers the code-review angles (diff, security, tests); reviewing the maintainer's decisions is a different concern |
| Only the skill, with its design written into `SKILL.md`, plus the rule 33 amendment | The reasons behind the decisions would live in a file loaded on every run, which isn't where design rationale belongs (rule 22) |
| This doc, plus an ADR | Fails the ADR test "hard to reverse": one clause in rule 33 turns the skill off |
| The script and its tests in the skill folder | Needs CI wiring so its tests run, since no workspace covers that folder |

### Q12 — Building it and switching it on

Built in one session, riskiest part first: the lookup script with tests, then `SKILL.md` (checking agent, Fable second opinion, verdict comment, questions, fix-and-recheck loop, hold, merge), then this doc and the rule amendments, then first runs on #1120 and #1124. That makes two PRs: a code PR (#1132: the script, its tests and the skill), merged with the maintainer's usual OK, and a docs PR (this doc, rule 33 and the process lines), which the skill reviews as its first run, checking Q1–Q12 against the session transcript. Turning the skill off means removing one clause from rule 33.

Decided: maintainer, 2026-10-22 (#1133)

| Rejected | Why |
|---|---|
| The maintainer reads the docs PR, since its rule 33 change gives the skill its authority | The safest start, but exactly the read the skill exists to save |
| A planner issue, and feature-bot builds it | Bots run in CI, where there are no transcripts, so they can't run or test the skill; and a planner issue is heavy for a small skill |
| A trial period: the skill only posts verdicts, and the maintainer still approves before it merges | The maintainer would be reading PRs again during the trial |

## How a review runs

Follows from Q1–Q12; [`SKILL.md`](../skills/review-decisions/SKILL.md) has the steps.

```
in-scope PR, opened in a session with the maintainer (Q7, Q8)
  │  held? → stop (Q9)
  ▼
lookup: bots/_lib/decision-answers.ts --at <each listed timestamp> (Q2, Q9)
  ▼
checker (fresh Opus 5.5): provenance, fidelity, edits around decisions,
  soundness, transcript writes (Q3, Q5)
second opinion (fresh Fable 5.1): concrete concerns only (Q3a, Q5)
  ▼
mechanical findings → the author fixes them and re-runs, at most 3 rounds (Q4)
decision findings and concerns → picker questions, one batch per PR (Q3a, Q4)
  ▼
verdict comment naming the commit it checked (Q8)
  → merge if the head is unchanged and there's no hold (Q6, Q9)
  → one line to the maintainer (Q6)
```

## Foundational checks

A dev-process skill: it reads docs and a transcript, and writes PR comments. Like `design-code-review.md` and `design-cut-planner.md`, most dimensions don't apply.

- **Multi-instance:** none. It runs in one session on one machine; its only state is the verdict comment on each PR.
- **Scale:** one lookup per decision. The script streams the session file once: this session's 141 MB file took about 0.7 seconds.
- **Auth + RBAC:** gazetta's capabilities aren't involved. The author comments and merges as the maintainer's GitHub account, as for every merge today, which is why the evidence is the transcript and not the account (Q2).
- **Audit:** the verdict comment on each PR, with each decision and its evidence, is the record. No gazetta audit event.
- **Review:** distinct from gazetta's content review workflow (`design-review-workflow.md`).
- **Locale, themes, hooks, render, validation, plugin, cache, offline, collaboration:** not applicable.

## UX check

Rule 23: a clean PR is silent until it's merged, and the maintainer sees only what needs a decision.
- A clean PR costs the maintainer nothing but one line after the merge (Q6).
- Questions come only when something needs the maintainer: an unanswered or changed decision, a wrong fact a decision rests on, a contradiction, or a concrete concern from the second opinion (Q3a, Q4).
- Questions arrive as pickers, one batch per PR, each with options and a recommendation (Q1, Q4).
- The verdict comment is for spot-checks, not for reading (Q1).
- "hold #N" is the only command the maintainer needs to know (Q9).

## Cut sequence

Follows from Q12.

| # | What | Depends on | Test tier | Risk |
|---|---|---|---|---|
| 1 | Lookup script `bots/_lib/decision-answers.ts`, with unit tests on sample transcripts (#1132) | — | unit-first | Medium |
| 2 | `SKILL.md`: scope, hold, decision list, lookup, checker, second opinion, fix-and-recheck loop, questions, verdict, merge (#1132) | 1 | (first runs) | Medium |
| 3 | This doc, the rule 33 clause, `feature-design-process.md` lines, the `review-prs` hook, glossary entries, and the `hold` label; reviewed by the skill as its first run | 2 | (docs) | Low |
| 4 | First runs on #1120 and #1124, after adding a decision list to each PR body | 3 | (manual) | Low |

## Migration

Design PRs opened before this doc (#1120, #1124) get a `## Decisions` list added to their PR body before the skill runs on them (Q12). Decisions already in the docs keep no mark (Q10). To switch the skill off, remove its clause from rule 33 (Q12).

## Open questions

1. **The transcript format isn't a documented interface.** The lookup relies on fields Claude Code writes today (`uuid`, `parentUuid`, `origin`, `toolUseResult`, `sourceToolAssistantUUID`). If they change, lookups come back `not-found` or `broken-link`, which sends decisions to the maintainer instead of approving them: it fails safe, but it would stop the skill being useful until the script is updated.
2. **Whether Fable 5.1 is available to sub-agents on the maintainer's plan.** The first run shows it; the fallback is a second Opus agent (Q5).

## Future directions

- **Tamper-proof evidence:** the maintainer signs each PR's decision list, added on top of the lookup without redoing anything (Q9).
- **A separate GitHub identity for the author** (a bot account or GitHub App): how GitHub, Kubernetes and SLSA make "who did this" provable, and it would make the maintainer's own GitHub actions, such as a hold or an approval, unambiguous (Q9).
- **A digest of what the skill approved,** if the maintainer ever wants one; until then, on request (Q1).
- **A wider scope:** `docs/audits/` and user docs (Q7), and merge permission for other PRs (Q1), once the skill has a track record.

## Implementation notes

Choices made while building #1132, each carrying out a decision above.

| Topic | Implemented | Follows from |
|---|---|---|
| What a typed answer was shown | All of the author's messages since the maintainer's previous input, oldest first | Q2 rule 1; Q9 exact comparison |
| Pasted text | Replaced by "[pasted text]" and flagged; the maintainer's own words around it still count | Q2 rule 2 |
| The entry chain | A session's first entry has no parent; every other entry's parent must be an earlier entry | Q9 |
| Writes to a transcript | Flagged when a command names a `.jsonl` file under `.claude/projects` and redirects or tees into it, edits it in place, moves, copies or truncates it, or runs code that writes a file; heredoc bodies are ignored, so read-only scripts aren't flagged | Q9 |
| Verdict marker | `<!-- review-decisions: head=<sha> verdict=approve -->`, which `/review-prs` reads to find PRs without a passing verdict for their head | Q8 |
| Merge gate | The head is the one the verdict names, there's no `hold` label, and the verdict is posted; then a rebase-merge | Q6, Q8, Q9; rule 16 |
| Second opinion's model | `model: "fable"`; if that fails, the default model | Q5 |
