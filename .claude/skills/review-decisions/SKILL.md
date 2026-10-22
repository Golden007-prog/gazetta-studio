---
name: review-decisions
description: Review a PR that records design decisions in the maintainer's place, and merge it when it passes. Approves only when every decision the PR locks traces to the maintainer's own answer in this machine's session transcript, the docs record it faithfully, and nothing it rests on is false; asks the maintainer with picker questions otherwise. Seer's and Sourcery's comments are the second opinion; a Fable agent adds one when the maintainer asks. Run it right after opening an in-scope PR, and from /review-prs on any in-scope PR without a passing verdict for its latest commit.
allowed-tools: Bash Read Grep Glob Agent AskUserQuestion
argument-hint: <PR number>
---

# Review-decisions

Stands in for the maintainer's review of PRs that write down decisions the maintainer made, usually in a grilling session. Deciding stays with the maintainer: this skill checks that a PR locks only what the maintainer answered, records it faithfully, and rests on true facts; then it merges. Anything else becomes a short picker question for the maintainer.

Design and the reasons behind each rule: [`design-decision-review.md`](../../rules/design-decision-review.md).

## 1. Is the PR in scope?

```bash
gh pr view <N> --json number,title,body,headRefOid,files,labels,author
```

In scope only when all of these hold:
- **Every** changed file is under `.claude/rules/` or `docs/adr/`, is the root `CLAUDE.md`, `bots/README.md`, `CONTEXT.md`, `ROADMAP.md` or `docs/non-goals.md`, or is a `SKILL.md` under `.claude/skills/`. One other file (code, workflows, user docs, audits) puts the whole PR out of scope.
- The PR doesn't change this skill: not `.claude/skills/review-decisions/`, not `.claude/rules/design-decision-review.md`, and not the `review-decisions` clause of rule 33 in `.claude/rules/team-preferences.md`. A PR that does goes to the maintainer, because this copy of the skill would be reviewing changes to itself.
- The PR's author is the account this session posts as (`gh api user --jq .login`): PRs from contributors and bots didn't come out of a session with the maintainer.
- The PR body has a `## Decisions` table pointing at this machine's transcripts (step 3).

Out of scope: say so in one line and stop. The PR gets the normal review and the maintainer's merge OK.

Record `headRefOid`: the verdict applies to that commit only.

## 2. Is it held?

A `hold` label means the maintainer wants it left alone: stop, and say it's held. The maintainer can also say "hold #N" in the session; then add the label (`gh pr edit <N> --add-label hold`) and stop.

## 3. The decision list

The PR body carries:

```markdown
## Decisions
| # | Where | Decision | Your answer | Kind |
|---|---|---|---|---|
| 1 | design-x.md Q2 | <the decision in one line> | 0d1ec6e3-9705-40e8-88e6-8758b4d8f010 @ 2026-10-22T10:11:52.123Z | yours |
| 2 | design-x.md Q2 | <a decision derived from another> | — | follows from design-y.md Q2 F1 |
```

- **Your answer** is the session id and the answer's timestamp, exactly as the transcript has them. Find them with `./node_modules/.bin/tsx bots/_lib/decision-answers.ts --list --since <time>` (newest session by default; `--session <id>` for another).
- **Kind** is `yours` (the maintainer answered it) or `follows from <decision>` (no Rejected table of its own; it carries out a decision that already exists, which the row names).
- In the docs, each locked decision the PR adds or changes ends with `Decided: maintainer, <date> (#<PR>)`, or `Follows from <decision>` for a derived one. Older decisions aren't backfilled.

A PR without the list can't pass: write the list (if you're its author), or treat the PR as out of scope.

## 4. Look up the answers

For each session in the list:

```bash
./node_modules/.bin/tsx bots/_lib/decision-answers.ts --session <id> --at <ts> [--at <ts> ...]
```

For each timestamp it returns `status` (`ok`, `not-found`, `not-your-input`, `broken-link`), `kind` (`typed` or `picker`), `answer`, and `shown`: the picker's questions and options as the maintainer saw them, or my messages in the turn a typed reply answered. It also returns `transcriptWrites`: the commands and file edits, in the session and its sub-agents (`source` names the sub-agent's file), that may have written to a transcript. It over-reports on purpose; the checker says which ones could matter.

Only `status: ok` is evidence. The script decides what counts as the maintainer's own input; don't second-guess it in either direction.

## 5. Run the checks (fresh agent)

Seer's and Sourcery's comments on the PR are the second opinion, and the checker reads them, so start it once Seer (`sentry[bot]`) has reacted to the PR, commented or reviewed, or after 15 minutes, whichever comes first. On a clean docs PR Seer posts no comment: a 🎉 reaction (`gh api repos/{owner}/{repo}/issues/<N>/reactions`) is its "reviewed, nothing to say".

Spawn one agent with the Agent tool (no `model` override: it runs on the session's Opus). Give it the PR diff (`gh pr diff <N>`), the decision list, the lookup output, the PR's Sourcery and Seer comments (`gh api repos/{owner}/{repo}/pulls/<N>/comments`, plus `.../pulls/<N>/reviews` and `.../issues/<N>/comments`), and this brief:

> You are checking a PR that records design decisions, on behalf of the project's maintainer, who will not read it. Your job is to find every way the PR goes beyond, falls short of, or misstates what the maintainer decided. Read before asserting: open every file and line you cite.
>
> 1. **Provenance.** Every decision the PR locks — anything with its own Rejected table, and anything the docs mark "Decided" — must have a row in the decision list whose lookup is `ok`. A decision without one is a finding.
> 2. **Fidelity.** Compare each decision in the docs with exactly what the maintainer was shown (`shown`) and answered (`answer`):
>    - For a picker answer, the doc may lock the chosen option as its label and description say, nothing more. A free-text answer is the maintainer's own words.
>    - For a typed "agree", "ok" or similar, the maintainer accepted the recommendation in the `shown` messages as stated. The doc may not lock anything those messages didn't state.
>    - An extra condition, a dropped condition, a different option, or a broader scope is a finding.
> 3. **Edits around decisions.** An edit with no Rejected table must either change no decision (status lines, links, wording carried over from an answer) or follow from a named existing decision, cited in the doc. Deleting or changing an existing decision is a decision and needs an answer.
> 4. **Soundness.** Re-read, at the cited file and line, every claim about code or behaviour that a decision rests on. Check the PR doesn't contradict other design docs, ADRs (`docs/adr/`), `docs/non-goals.md` or `CONTEXT.md`. A claim the doc labels "read from code, not reproduced" stays a hypothesis; flag it only if it's wrong, or a decision rests on an unlabelled one.
> 5. **Transcript writes.** For each entry in `transcriptWrites`, say whether it could have changed an entry the decision list relies on.
> 6. **The AI reviewers' comments** are the second opinion on the decisions. Check each against the code. One that holds and raises a concrete problem the maintainer wasn't shown (compare with `shown`) is a `decision` finding: an alternative or failure mode missing from the decision's Rejected table, a failed foundational check (5,000-page envelope, multi-instance correctness, or another dimension in `.claude/rules/feature-design-process.md`), a clash with a rule in `.claude/rules/team-preferences.md`, or a cost the decision doesn't mention. Otherwise it's mechanical, or nothing. Don't raise anything of your own out of general doubt.
>
> Classify each finding:
> - `mechanical`: the doc misrecords an answer, lacks a citation, or cites stale text, and the fix is to make the doc match the evidence;
> - `decision`: the maintainer has to decide. This covers a decision without an answer, a changed or removed decision, a wrong fact a decision rests on, a contradiction with an earlier decision, ADR or non-goal, and a transcript write that could have changed evidence.
>
> End with a fenced block, one JSON object per line, possibly empty:
>
> ```findings
> {"decision": 3, "check": "fidelity", "level": "mechanical", "problem": "…", "fix": "…"}
> ```

## 6. A Fable second opinion, when the maintainer asks

Only when the maintainer asks for one on this PR ("second opinion #N"). On a later round (after a fix or an answer), give it only the decisions whose text changed since its last pass; its earlier result stands for the rest.

Spawn a second agent with `model: "fable"` (Claude Fable 5.1). If that fails, use the default model: the second opinion still runs, on Opus. Give it the PR diff, the decision list with the `shown` text for each decision, and the PR's Sourcery and Seer comments (`gh api repos/{owner}/{repo}/pulls/<N>/comments`, plus `.../reviews`), with this brief:

> You are giving a second opinion on decisions a project's maintainer has made, before they're merged into the design docs. You don't decide and you don't block. You raise concrete concerns, and only ones the maintainer wasn't shown when deciding (compare with the `shown` text).
>
> A concrete concern is one of:
> - an alternative or failure mode missing from the decision's Rejected table;
> - a failed foundational check (5,000-page envelope, multi-instance correctness, or another dimension in `.claude/rules/feature-design-process.md`);
> - a clash with a rule in `.claude/rules/team-preferences.md`;
> - a cost the decision doesn't mention, such as being hard to reverse, touching production, or making work for contributors.
>
> Treat Sourcery's and Seer's comments as leads: check each against the code, and raise only the ones that hold. Raise nothing out of general doubt. "Are you sure?" with no new evidence is not a concern.
>
> End with a fenced block, one JSON object per line, possibly empty:
>
> ```concerns
> {"decision": 2, "concern": "…", "evidence": "file:line or source", "options": ["Keep", "Change: …"], "recommendation": "Keep|Change", "why": "…"}
> ```

## 7. Act on the results

- **Mechanical findings:** fix them in the PR yourself (if you can push to its branch), push, and start again from step 1 for the new commit (step 6 then covers only the decisions that changed). Stop after three rounds without passing, and hand the PR to the maintainer with what still fails.
- **Decision findings and concerns:** ask the maintainer, all at once for this PR, with AskUserQuestion (up to four questions per call, more calls if needed). Each question names the decision, says what's wrong or new in a sentence or two, and offers the choices with your recommendation first. Then write the answers into the docs and the decision list (the new answers have their own timestamps), push, and start again from step 1.
- **No findings and no concerns:** go to step 8.

## 8. Verdict and merge

Post one comment on the PR:

```markdown
<!-- review-decisions: head=<headRefOid> verdict=approve -->
**review-decisions: approved** (commit <short sha>)

| # | Decision | Evidence |
|---|---|---|
| 1 | <decision> | picked "<option label>" (<timestamp>) |
| 2 | <decision> | "<short typed answer>" to the recommendation of <timestamp> |
| 3 | <decision> | follows from <decision> |

Fixed before approving: <list, or "nothing">
Second opinion: <what Seer and Sourcery said and what came of it, and a Fable pass if one was asked for: "no concerns", or each concern and the maintainer's answer>
Transcript writes: <"none", or each one and why it doesn't affect the evidence>
```

Quote only picker labels or short answers. The repo is public, and a longer free-text answer may hold something the maintainer didn't mean to publish: summarise it instead.

Then merge, only if all three hold:
- the head is still `headRefOid`;
- there's no `hold` label;
- the comment is posted.

```bash
gh pr merge <N> --rebase --delete-branch --admin --match-head-commit <headRefOid>
```

`--match-head-commit` makes GitHub refuse the merge if anything was pushed after the verdict.

Tell the maintainer in one line: "Merged #N: <k> decisions, all yours; <second-opinion outcome>."

## Rules that don't bend

- No evidence, no approval. A decision whose lookup isn't `ok` goes to the maintainer.
- Never review a PR that changes this skill; it goes to the maintainer.
- Never merge a held PR, or a commit other than the one the verdict names.
- The second opinion can't approve or block. Its concerns become questions.
- No Fable pass unless the maintainer asks for it.
- Don't run outside this machine: the evidence is here.
