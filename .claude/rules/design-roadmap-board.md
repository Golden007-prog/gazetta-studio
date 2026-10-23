# Roadmap board

A public GitHub Project that shows [`ROADMAP.md`](../../ROADMAP.md) as a board: a column per bucket (Now, Next, Later, Deferred, Done), a tab each for Now, Next and Later, a By area tab, and a tab for open issues the roadmap doesn't mention. A script generates it from the file; nobody edits it by hand.

**Status**: design pass complete (2026-10-23), grilled Q1–Q11. Implementation in #1198.

**Companion docs:**
- [`ROADMAP.md`](../../ROADMAP.md): the source; its Process section will link the board (cut 3)
- [`design-decision-review.md`](design-decision-review.md) and the [`review-prs` skill](../skills/review-prs/SKILL.md): the two skills that merge ROADMAP changes, and run the sync after merging one (Q5)
- [`feature-design-process.md`](feature-design-process.md) "Issue-classification discipline": every open issue is bucketed in ROADMAP.md; the "Not in ROADMAP.md" tab shows the ones that aren't (Q3)
- [`bots/README.md`](../../bots/README.md): where the script lives (Q6)

## Scope

**In v1:**
- One public project in the gazetta-studio org, linked to the repository
- A sync script that reads ROADMAP.md and adds, updates and removes the project's cards; dry run by default
- Fields: Status (the bucket), Section (the `###` heading), Area (the `area:` label)
- Views: Roadmap, Now, Next, Later, By area, All, Not in ROADMAP.md
- A draft card for each item the file lists without an issue
- Review-decisions and review-prs run the sync after merging a ROADMAP change

**Out of v1:**
- Running the sync from GitHub Actions (needs a token the Actions token can't replace; Future directions)
- Milestones (Q2)

**Non-goals:**
- Planning on the board. Changes go through ROADMAP.md (Q1).

## What GitHub allows

Checked 2026-10-23 in the GitHub docs and the GraphQL API:
- A board's columns can only be a single-select or iteration field.
- A view can be grouped by a custom field, not by labels, title, reviewers or linked pull requests.
- The API creates views and sets their name, layout, filter and visible fields (`createProjectV2View`, `updateProjectV2View`), not their columns, grouping or sort. Those are set by hand once per view, and they stay.
- Updating a single-select field's options keeps each option's id when it's passed back, so items keep their values.
- The Actions token can't reach projects.
- Adding an issue to a project and changing its Status leave events on the issue's timeline (`ADDED_TO_PROJECT_V2_EVENT`, `PROJECT_V2_ITEM_STATUS_CHANGED_EVENT`).
- A project's built-in rule moves a closed issue to Done. Its auto-add rule adds issues from a repository as they're created or updated, but "existing items matching your criteria will not be added"; it filters with `is` (open, closed, merged, draft, issue, pr), `label`, `reason`, `assignee` and `no`. The Free plan allows one auto-add rule.
- Adding an issue that's already on the project returns its existing item.

Not checked yet (cut 1 checks it on the first run): the column field a new board view starts with.

## Locked decisions

### Q1 — ROADMAP.md is the source; the board is generated from it

A script builds the board from the file: it adds cards, sets each card's fields, and removes cards the file no longer lists. The board is read-only by convention: the next sync resets the cards it manages and reports anything else added by hand. Plan changes keep going through PRs and review-decisions.

Decided: maintainer, 2026-10-23 (#1197)

| Rejected | Why |
|---|---|
| The board is the source; a script writes ROADMAP.md through a PR | Bucket changes become clicks with no PR, no review-decisions and no Decided line; reasons and dependency chains need a new home |
| The board is the source; ROADMAP.md retired | As above, and triage-bot loses the plan: it reads ROADMAP.md into every investigation, and the Actions token can't read projects |
| The board owns buckets, the file keeps the prose | Bucket changes skip review, triage-bot can't see them, and one plan lives in two places |
| `roadmap:` labels own buckets | Relabelling skips review; four more labels to keep right |
| Synced both ways | A drag has to turn into a ROADMAP PR; conflicts need rules; several times the code |
| A board kept by hand | The two copies drift apart |

### Q2 — One public project with several views; no milestones

The per-bucket and per-area views are tabs in one project. Moving an issue between buckets changes its Status and Section, not its card.

Decided: maintainer, 2026-10-23 (#1197)

| Rejected | Why |
|---|---|
| A project per bucket (Now, Next, Later, Deferred) | No overview: four links. A move deletes the card in one project and recreates it in the other. Its only gain, no setup by hand, is a few clicks once |
| A project per area | No overview: five links; nobody owns an area here; an issue with two area labels needs a rule |
| No project (milestones or labels only) | No board |
| Milestones per bucket | One dimension per issue; a percentage per bucket mixes unrelated work |
| Milestones per section | About 20 milestones; the design sections list planner issues, which close only when a whole feature ships, so they sit near 0% for months |
| Milestones per area | Repeats the `area:` labels |
| Labels | Can't be columns or groups |

### Q3 — The project holds the plan, its items without issues, and what it misses

- Every issue the four buckets (Now, Next, Later, Deferred) mention, open or closed. Closed ones are in Done.
- A draft card for each item the file lists without an issue: a table row or bullet that names no issue and has no sub-bullets. A bullet with sub-bullets ("Static hosts:") is a heading. A draft is matched by its text, so rewording a row replaces its card.
- Open issues the file doesn't mention, shown only in the "Not in ROADMAP.md" tab.

Decided: maintainer, 2026-10-23 (#1197)

| Rejected | Why |
|---|---|
| Issues and drafts only | Open issues the file misses stay invisible (17 at dcfcdb8 on 2026-10-23, including #729 and 3 good first issues: #1050, #1057, #1062) |
| Issues and the extra tab only | Deferred would show 4 cards for its 37 rows; items without an issue don't show |
| Issues only | Both of the above |
| Everything the file mentions, Shipped appendix and PRs included | Done fills with history; PRs (the Decided lines) aren't plan items |

### Q4 — An issue mentioned twice lands where a list item or table row first names it

Prose mentions count only when no list item or table row names the issue. Each run prints the issues mentioned in more than one place and where they went. At dcfcdb8 on 2026-10-23 that's six. #1170 (bulk edits) lands in Later, where it's listed, not in Now, where the MCP paragraph names it as a use case; #49, #1149 and #1152 land in Now; #1162 and #253 are mentioned twice within their own section.

Decided: maintainer, 2026-10-23 (#1197)

| Rejected | Why |
|---|---|
| The first mention anywhere | A cross-reference in an earlier bucket pulls an item forward (#1170 into Now) |
| Mark the home mention in the file (only it is a link) | Every ROADMAP edit has to keep the rule, and a missed link moves or drops a card |
| Refuse duplicates | The cross-references (the MCP use case, #209's dependencies) would have to be reworded or dropped |

### Q5 — The merging session runs the sync; GitHub's auto-add adds new issues

- The session that merges a ROADMAP change runs the sync: review-decisions after merging a PR that changes ROADMAP.md, and review-prs after merging any PR whose diff includes it (feature-bot's docs cuts, and PRs that also change code or user docs).
- GitHub's auto-add rule adds new issues at once, with no Section, so they appear only in "Not in ROADMAP.md".
- GitHub's built-in rule moves closed issues to Done.
- No secret is stored.

Decided: maintainer, 2026-10-23 (#1197)

| Rejected | Why |
|---|---|
| A workflow on every push to main, plus nightly, with a token | A long-lived secret with write access to the project, and a new workflow file. Revisit when the bots have a GitHub App token that can reach projects |
| After merges, without auto-add | "Not in ROADMAP.md" would miss issues opened since the last ROADMAP merge, often a week |
| Only when asked | The board drifts from the file between runs, and a reader can't tell how far |
| Review-decisions only | ROADMAP changes in bot docs cuts and mixed PRs merge through review-prs, and the board would stay stale until the next ROADMAP PR review-decisions merges |
| A rule in CLAUDE.md for any session | A rule to remember rather than a step in the merging skills' checklists |

### Q6 — The script lives in `bots/roadmap-board/`; this doc holds the rules

CI's bots job already runs that workspace's tests, and the script needs no new dependency. It runs from a session, not on a schedule, so the bot conventions (cron, transcripts, outcome tags, skip-lists) don't apply; `bots/README.md` and `dev-glossary.md` say so. The skills' sync steps and a `bots/README.md` row come with the script.

Decided: maintainer, 2026-10-23 (#1197)

| Rejected | Why |
|---|---|
| The rules only in the script header and the project's README | Later sessions don't look there, so the decisions get re-argued, and review-decisions can't check them |
| `scripts/` | No CI job runs tests there; wiring one is a workflow change |
| A new workspace (`tools/roadmap-board/`) | A lockfile change made with CI's exact Node and npm, and a new CI job, for a ~300-line script |

### Q7 — An issue with two area labels gets the first in a fixed order

The order is cms, renderer, cli, storage, templates. The card still shows both labels, and each run lists these issues: triage gives each issue one area label, so two is a slip to fix.

Decided: maintainer, 2026-10-23 (#1197)

| Rejected | Why |
|---|---|
| A "several" value | A row in By area that isn't an area, and the cards leave both areas' rows |
| A multi-select Area field | GitHub's docs don't say a view can group by one |
| No Area field, one tab per area label | Five tabs instead of one view with a row per area; a new area label needs a new tab |

### Q8 — A dry run by default, and a stop when more than 10 cards would leave the roadmap

The sync only prints its plan unless run with `--apply`. A run that would take more than 10 cards off the roadmap stops unless `--allow-removals` is passed. That counts cards whose Section it would clear (a lost section's open issues) and listed issues or drafts it would remove. Closed issues the file never listed leave without counting. When it stops, the merging session shows the maintainer the plan and asks before rerunning.

Decided: maintainer, 2026-10-23 (#1197)

| Rejected | Why |
|---|---|
| A dry run only, with no stop | A large removal goes through once `--apply` is passed, unless someone read the plan |
| A stop above 20% of the items | 20% of about 155 items is 31: a whole lost section can pass |
| Apply by default, no stop | A misread file empties part of the board until the next good run |
| Count every removal | With auto-add, issues that close without being in the file are removals (66 of the 70 closed in the two weeks to 2026-10-23 weren't in ROADMAP.md at dcfcdb8), so it would stop most runs, and it misses a lost section's open issues |
| Count only removals of open issues and drafts | Open issues are never removed, only moved to "Not in ROADMAP.md", so it would count drafts alone |

### Q9 — The project says when it was synced and where the reasons are

The description names the ROADMAP commit and the date of the last sync. The README explains each view, links ROADMAP.md for the reasons and dependencies behind each item, and lists the one-time setup steps.

Decided: maintainer, 2026-10-23 (#1197)

| Rejected | Why |
|---|---|
| The README only | A reader can't tell how fresh the board is |
| No text | No pointer to ROADMAP.md for the reasons, and no record of the one-time setup |
| The sync date in the README | Works, but the README is longer to rewrite than one line |

### Q10 — ROADMAP.md links the board in the last cut

The link goes into ROADMAP.md's Process section once the project exists and has had its first sync, so it never points at an empty or missing board.

Decided: maintainer, 2026-10-23 (#1197)

| Rejected | Why |
|---|---|
| In this PR | The project would have to be created first, and the link would show an empty, private board until the script landed |
| No link | ROADMAP readers wouldn't learn the board exists |

### Q11 — Deferred items get the Section "Deferred"

Section marks what's on the roadmap, so every listed card needs one, and Deferred has no `###` headings.

Decided: maintainer, 2026-10-23 (#1197)

| Rejected | Why |
|---|---|
| A separate "On roadmap" field | One more field to sync and show |
| Status as the marker (`has:status`) | GitHub's built-in rule gives every closing issue the Status Done, including ones the file never listed, so they'd show in the roadmap tabs until the next sync. Only the sync sets Section |

## The board

### Fields

Follows from Q2, Q5, Q7 and Q11.

| Field | Values | Set by |
|---|---|---|
| Status (built in) | Now, Next, Later, Deferred, Done | The sync: the item's bucket, or Done when its issue is closed. GitHub's built-in rule also sets Done when an issue closes |
| Section | The `###` heading the item is under; "Deferred" for Deferred items (Q11). Its options follow the file's order, which orders a bucket tab's columns | The sync. Only items the file lists have one, so Section marks what's on the roadmap |
| Area | The issue's `area:` label: cms, renderer, cli, storage, templates; Q7 for an issue with two | The sync |

Status keeps GitHub's Done option and its id, so the built-in rule keeps working; Todo and In Progress are replaced by the four buckets.

### Views

Follows from Q2, Q3 and Q5.

| View | Layout | Filter | Set by hand once |
|---|---|---|---|
| Roadmap | Board | `has:section` | Columns: Status |
| Now | Board | `status:Now` | Columns: Section |
| Next | Board | `status:Next` | Columns: Section |
| Later | Board | `status:Later` | Columns: Section |
| By area | Board | `has:section` | Columns: Status; groups: Area |
| All | Table | `has:section` | Grouped by Section |
| Not in ROADMAP.md | Table | `no:section is:open` | — |

The sync creates missing views with their layout, filter and visible fields. Their columns and grouping are set once in GitHub's view menu, since the API can't; the project's README lists the steps.

### Project text

Follows from Q9.

- Description: "Generated from ROADMAP.md at `<commit>` on `<date>`. Edit the file, not the board." The sync updates it each run.
- README: what each view shows, a link to ROADMAP.md for the reasons and dependencies behind each item, and the one-time setup steps.

## The sync

Follows from Q1, Q3, Q4 and Q8.

1. Read ROADMAP.md. `## Now`, `## Next`, `## Later` and `## Deferred` start a bucket; any other `##` heading ends it, and the second top-level heading (`# Appendix: Shipped status`) ends the plan. `###` headings set the Section.
2. Collect issue references: links to an issue and bare `#N`, with `#A–#B` ranges expanded (spans of up to 30). `Decided:` and `Follows from` lines are skipped. Each reference is a list item, table row or prose mention, and Q4 picks its place.
3. Collect drafts (Q3). A table row's draft takes its first cell as the title and the other cells as the body; a bullet's takes its first sentence as the title and the whole text as the body.
4. Look the numbers up and keep issues; pull requests are dropped. List the repository's open issues too: those the file doesn't mention go on the board with no Status or Section, since auto-add only adds issues created or updated after it's turned on.
5. Read the project: fields, items and their values.
6. Plan: add missing items, set fields that differ, and remove issue items that are neither on the roadmap nor open. Drafts are matched to the file one-to-one by title; drafts the file no longer has, and extra copies, are deleted. Items that aren't issues of this repository or drafts (a pull request added by hand) are left alone and reported.
7. Without `--apply`, print the plan and stop. With it, write the changes, update the description, and print what changed, the issues mentioned in more than one place, and the issues with two area labels. Q8's stop applies before anything is written.

Two runs at once converge on issues: adding an issue that's already on the board returns its item, and the later run sets the fields again. They can both add a new draft; the next run deletes the extra copy.

## Foundational checks

Dev-process tooling with no product surface. Scale: about 155 items, far below GitHub's 50,000 per project. Multi-instance: see "The sync". Auth: the sync uses the maintainer's `gh` login with the `project` scope; nothing is stored. Audit: GitHub's issue timelines record each add and Status change. Locale, themes, review workflow, hooks, render, validation, plugin, cache, offline and collaboration: N/A.

## UX check

The board is quiet when the file and the issues agree: no badges or notes of its own. Names are the file's words. The description says when the board was last synced, and the README sends readers to ROADMAP.md for the reasons.

## Cut sequence

| # | What | Depends on | Test tier | Risk |
|---|---|---|---|---|
| 1 | `bots/roadmap-board/`: parser, planner and sync with dry run and `--apply`; creates the project's fields and views when missing | — | unit + manual run | Medium |
| 2 | The sync steps in review-decisions and review-prs, the matching update to `design-decision-review.md`, and a `bots/README.md` row | 1 | (docs) | Low |
| 3 | Create the project (public, linked to the repository), run the first sync from `main` and check the column field a new board view starts with, set each view's columns and grouping and the auto-add rule by hand, and link the board from ROADMAP.md's Process section (Q10) | 1, 2 | (manual) | Low |

## Migration

None: the project is new.

## Future directions

- **Run the sync from a workflow** on every push to main that changes ROADMAP.md, once the bots have a GitHub App token that can reach projects. No open issue tracks that token: #336 was closed in May by an unrelated fix (#338).
- **Progress per initiative**: milestones per section (Q2) or sub-issue links from planner issues to their cuts, so planner cards show the sub-issue progress field.
- **A "Good first issues" view**, if contributors ask.
