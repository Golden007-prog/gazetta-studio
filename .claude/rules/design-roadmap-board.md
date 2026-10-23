# Roadmap board

A public GitHub Project that shows [`ROADMAP.md`](../../ROADMAP.md) as a board: a column per bucket (Now, Next, Later, Deferred, Done), a tab per bucket and per area, and a tab for open issues the roadmap doesn't mention. A script generates it from the file; nobody edits it by hand.

**Status**: design pass complete (2026-10-23), grilled Q1–Q6. Implementation not started.

**Companion docs:**
- [`ROADMAP.md`](../../ROADMAP.md): the source; its Process section links the board
- [`design-decision-review.md`](design-decision-review.md): ROADMAP changes merge through review-decisions, which runs the sync after merging (Q5)
- [`feature-design-process.md`](feature-design-process.md) "Issue-classification discipline": every open issue is bucketed in ROADMAP.md; the "Not in ROADMAP.md" tab shows the ones that aren't (Q3)
- [`bots/README.md`](../../bots/README.md): where the script lives (Q6)
- [#336](https://github.com/gazetta-studio/gazetta-studio/issues/336): a GitHub App token for the bots, which a workflow running the sync would use (Future directions)

## Scope

**In v1:**
- One public project in the gazetta-studio org, linked to the repository
- A sync script that reads ROADMAP.md and adds, updates and removes the project's cards; dry run by default
- Fields: Status (the bucket), Section (the `###` heading), Area (the `area:` label)
- Views: Roadmap, Now, Next, Later, By area, All, Not in ROADMAP.md
- A draft card for each item the file lists without an issue
- The review-decisions skill runs the sync after merging a ROADMAP change

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
- A project's built-in rule moves a closed issue to Done, and its auto-add rule adds new issues from a repository (one auto-add rule on the Free plan).

Not checked yet (the first cut checks them): the column field a new board view starts with, and the filters the auto-add rule accepts.

## Locked decisions

### Q1 — ROADMAP.md is the source; the board is generated from it

A script builds the board from the file: it adds cards, sets each card's fields, and removes cards the file no longer lists. Nobody edits the board by hand; the next sync undoes it. Plan changes keep going through PRs and review-decisions.

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

The per-bucket and per-area views are tabs in one project. Moving an issue between buckets changes one field.

Decided: maintainer, 2026-10-23 (#1197)

| Rejected | Why |
|---|---|
| A project per bucket (Now, Next, Later, Deferred) | No overview: four links. A move deletes the card in one project and recreates it in the other. Its only gain, no setup by hand, is a few clicks once |
| A project per area | No overview: about seven links; nobody owns an area here; an issue with two area labels needs a rule |
| No project (milestones or labels only) | No board |
| Milestones per bucket | No board; one dimension per issue; a percentage per bucket mixes unrelated work |
| Milestones per section | About 20 milestones; the design sections list planner issues, which close only when a whole feature ships, so they sit near 0% for months |
| Milestones per area | Repeats the `area:` labels |
| Labels | Can't be columns or groups |

### Q3 — The project holds the plan, its items without issues, and what it misses

- Every issue the four buckets (Now, Next, Later, Deferred) mention, open or closed. Closed ones are in Done.
- A draft card for each item the file lists without an issue: a table row or bullet that names no issue and has no sub-bullets. A bullet with sub-bullets ("Static hosts:") is a heading. The draft's title is the row's first cell or the bullet's text; its body is the rest of the row (Deferred's trigger).
- Open issues the file doesn't mention, shown only in the "Not in ROADMAP.md" tab.

Decided: maintainer, 2026-10-23 (#1197)

| Rejected | Why |
|---|---|
| Issues and drafts only | Open issues the file misses stay invisible (19 on 2026-10-23, including the tracking issue #514 and 3 good first issues) |
| Issues and the extra tab only | Deferred would show 4 cards for its 37 rows; items without an issue don't show |
| Issues only | Both of the above |
| Everything the file mentions, Shipped appendix and PRs included | Done fills with history; PRs (the Decided lines) aren't plan items |

### Q4 — An issue mentioned twice lands where a list item or table row first names it

Prose mentions count only when no list item or table row names the issue. Each run prints the issues mentioned in more than one place and where they went. On 2026-10-23 that's four: #1170 (bulk edits) lands in Later, where it's listed, not in Now, where the MCP paragraph names it as a use case; #49, #1149 and #1152 land in Now.

Decided: maintainer, 2026-10-23 (#1197)

| Rejected | Why |
|---|---|
| The first mention anywhere | A cross-reference in an earlier bucket pulls an item forward (#1170 into Now) |
| Mark the home mention in the file (only it is a link) | Every ROADMAP edit has to keep the rule, and a missed link moves or drops a card |
| Refuse duplicates | The cross-references (the MCP use case, #209's dependencies) would have to be reworded or dropped |

### Q5 — The merging session runs the sync; GitHub's auto-add adds new issues

- The review-decisions skill runs the sync after it merges a PR that changes ROADMAP.md.
- GitHub's auto-add rule adds new issues at once, with no Section, so they appear only in "Not in ROADMAP.md".
- GitHub's built-in rule moves closed issues to Done.
- No secret is stored.

Decided: maintainer, 2026-10-23 (#1197)

| Rejected | Why |
|---|---|
| A workflow on every push to main, plus nightly, with a token | A long-lived secret with write access to the project, and a new workflow file. Revisit when #336's GitHub App exists |
| After merges, without auto-add | "Not in ROADMAP.md" would miss issues opened since the last ROADMAP merge, often a week |
| Only when asked | The board drifts from the file between runs, and a reader can't tell how far |

### Q6 — The script lives in `bots/roadmap-board/`; this doc holds the rules

CI's bots job already runs that workspace's tests, and the script needs no new dependency. The review-decisions step and a `bots/README.md` row come with the script.

Decided: maintainer, 2026-10-23 (#1197)

| Rejected | Why |
|---|---|
| The rules only in the script header and the project's README | Later sessions don't look there, so the decisions get re-argued, and review-decisions can't check them |
| `scripts/` | No CI job runs tests there; wiring one is a workflow change |
| A new workspace (`tools/roadmap-board/`) | A lockfile change made with CI's exact Node and npm, and a new CI job, for a ~300-line script |

## The board

### Fields

| Field | Values | Set by |
|---|---|---|
| Status (built in) | Now, Next, Later, Deferred, Done | The sync: the item's bucket, or Done when its issue is closed. GitHub's built-in rule also sets Done when an issue closes |
| Section | The `###` heading the item is under; "Deferred" for Deferred items, which have none | The sync. Only items the file lists have one, so Section marks what's on the roadmap |
| Area | The issue's `area:` label: cms, renderer, cli, storage, templates. An issue with two gets the first in that order, and each run lists such issues, since triage gives each issue one | The sync |

Status keeps GitHub's Done option and its id, so the built-in rule keeps working; Todo and In Progress are replaced by the four buckets.

### Views

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

- Description: "Generated from ROADMAP.md at `<commit>` on `<date>`. Edit the file, not the board." The sync updates it each run.
- README: what each view shows, a link to ROADMAP.md for the reasons and dependencies behind each item, and the one-time setup steps.

## The sync

1. Read ROADMAP.md. `## Now`, `## Next`, `## Later` and `## Deferred` start a bucket; any other `##` or `#` heading ends it. `###` headings set the Section.
2. Collect issue references: links to an issue and bare `#N`, with `#A–#B` ranges expanded (spans of up to 30). `Decided:` and `Follows from` lines are skipped. Each reference is a list item, table row or prose mention, and Q4 picks its place.
3. Collect drafts (Q3).
4. Look the numbers up and keep issues; pull requests are dropped.
5. Read the project: fields, items and their values.
6. Plan: add missing items, set fields that differ, delete drafts the file no longer has, and remove issue items that are neither on the roadmap nor open. Items that aren't issues or drafts of this repository (a pull request added by hand) are left alone and reported.
7. Without `--apply`, print the plan and stop. With it, write the changes, update the description, and print what changed and the issues mentioned in more than one place. A run that would remove more than 10 items stops unless `--allow-removals` is passed: a ROADMAP format change the parser misses would otherwise empty the board.

Two runs at once converge: adding an issue that's already on the board returns its item, and the later run sets the fields again.

## Foundational checks

Dev-process tooling with no product surface. Scale: about 160 items, far below GitHub's 50,000 per project. Multi-instance: see "The sync". Auth: the sync uses the maintainer's `gh` login with the `project` scope; nothing is stored. Audit: GitHub's issue timelines record each add and Status change. Locale, themes, review workflow, hooks, render, validation, plugin, cache, offline and collaboration: N/A.

## UX check

The board is quiet when the file and the issues agree: no badges or notes of its own. Names are the file's words. The description says when the board was last synced, and the README sends readers to ROADMAP.md for the reasons.

## Cut sequence

| # | What | Depends on | Test tier | Risk |
|---|---|---|---|---|
| 1 | `bots/roadmap-board/`: parser, planner and sync with dry run and `--apply`; creates the project's fields and views when missing; checks the two unchecked facts above | — | unit + manual run | Medium |
| 2 | The review-decisions step that runs the sync after merging a ROADMAP change; a `bots/README.md` row | 1 | (docs) | Low |
| 3 | Create the project (public, linked to the repository), run the first sync from `main`, set each view's columns and grouping and the auto-add rule by hand, and link the board from ROADMAP.md's Process section | 1 | (manual) | Low |

## Migration

None: the project is new.

## Future directions

- **Run the sync from a workflow** on every push to main that changes ROADMAP.md, once #336's GitHub App gives the bots a token that can reach projects.
- **Progress per initiative**: milestones per section (Q2) or sub-issue links from planner issues to their cuts, so planner cards show the sub-issue progress field.
- **A "Good first issues" view**, if contributors ask.
