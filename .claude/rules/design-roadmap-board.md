# Roadmap board

A public GitHub Project that shows [`ROADMAP.md`](../../ROADMAP.md) as a board of three tables: the plan (Now, Next and Later) and everything the file lists, each grouped by area, and the open issues the roadmap doesn't mention. A script generates it from the file; nobody edits it by hand.

**Status**: design pass complete (2026-10-23), grilled Q1–Q15; Q14 and Q15 revised and Q12 superseded on 2026-10-24 (#1228). Cuts 1 and 2 in #1198, Q14 and Q15 in #1226 and #1228; cut 3 is #1222.

**Companion docs:**
- [`ROADMAP.md`](../../ROADMAP.md): the source; its Process section will link the board (cut 3)
- [`design-decision-review.md`](design-decision-review.md) and the [`review-prs` skill](../skills/review-prs/SKILL.md): the skills a session merges ROADMAP changes with; they run the sync after merging one (Q5, cut 2)
- [`feature-design-process.md`](feature-design-process.md) "Issue-classification discipline": every open issue is bucketed in ROADMAP.md; the "Not in ROADMAP.md" tab shows the ones that aren't (Q3)
- [`bots/README.md`](../../bots/README.md): where the script lives (Q6)

## Scope

**In v1:**
- One public project in the gazetta-studio org, linked to the repository
- A sync script that reads ROADMAP.md and adds, updates and removes the project's cards; dry run by default
- Fields: Status (the bucket), Section (the `###` heading), Area (the `area:` label)
- Views: Roadmap, All, Not in ROADMAP.md
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
- A board's available columns are its column field's options, and a view chooses which of them to display. The docs don't say a board hides empty columns.
- GitHub's secondary rate limits allow 80 content-generating requests a minute and 500 an hour, counting the GraphQL API, and its docs ask for a pause of at least 1 second between mutative requests ([REST](https://docs.github.com/en/rest/using-the-rest-api/rate-limits-for-the-rest-api), [GraphQL](https://docs.github.com/en/graphql/overview/rate-limits-and-query-limits-for-the-graphql-api)). They don't say whether project writes are content-generating, or how a request carrying several mutations counts. A GitHub CLI maintainer reports that the content limit counts each creation, not each request, isn't shown in response headers, and answers "was submitted too quickly" ([cli/cli#4801](https://github.com/cli/cli/issues/4801), 2022).

- A table can be grouped by a field and sorted by a field, with an optional secondary sort ([table layout](https://docs.github.com/en/issues/planning-and-tracking-with-projects/customizing-views-in-your-project/customizing-the-table-layout), checked 2026-10-24). The API reads a view's grouping and sort (`groupByFields`, `verticalGroupByFields`, `sortByFields`), but its view configuration sets only visible fields; `deleteProjectV2View` deletes a view.

Not checked yet (cut 3 checks it when setting the sort): the docs don't say whether a single-select field sorts by its options' order or alphabetically, which decides whether Status sorts Now, Next, Later.

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

The views are tabs in one project: the plan and everything the file lists, as tables grouped by area (Q14), and the open issues the file doesn't mention. Moving an issue between buckets changes its Status and Section, not its card.

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

- Every issue the four buckets (Now, Next, Later, Deferred) mention, open or closed. Closed ones are in Done, which no view shows (Q15).
- A draft card for each item the file lists without an issue: a table row or bullet that names no issue and has no sub-bullets. A bullet with sub-bullets ("Static hosts:") is a heading. A draft is matched by its title (a table row's first cell, a bullet's first sentence): rewording the title replaces its card, and a change to the rest of its text updates the card in place. Each run prints drafts whose titles collide: only the first gets a card.
- Open issues the file doesn't mention, shown only in the "Not in ROADMAP.md" tab.

Decided: maintainer, 2026-10-23 (#1197)

| Rejected | Why |
|---|---|
| Issues and drafts only | Open issues the file misses stay invisible (17 at dcfcdb8 on 2026-10-23, including #729 and 3 good first issues: #1050, #1057, #1062) |
| Issues and the extra tab only | Deferred would show 4 cards for its 37 rows; items without an issue don't show |
| Issues only | Both of the above |
| Drafts matched by their whole text | Editing a row's other cells (a Deferred row's trigger) would replace its card, and editing more than 10 rows in one PR would stop the sync (Q8) |
| Drafts matched by section and title | A row that moves to another section is replaced, a removal plus an add, which counts toward Q8's stop |
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
- A ROADMAP change merged another way, such as in the web UI, waits for the next sync.

Decided: maintainer, 2026-10-23 (#1197)

| Rejected | Why |
|---|---|
| A workflow on every push to main, plus nightly, with a token | A long-lived secret with write access to the project, and a new workflow file. Revisit when the bots have a GitHub App token that can reach projects |
| After merges, without auto-add | "Not in ROADMAP.md" would miss issues opened since the last ROADMAP merge, often a week |
| Only when asked | The board drifts from the file between runs, and a reader can't tell how far |
| Review-decisions only | ROADMAP changes in bot docs cuts and mixed PRs merge through review-prs, and the board would stay stale until the next ROADMAP PR review-decisions merges |
| A rule in CLAUDE.md for any session | A rule to remember rather than a step in the merging skills' checklists |

### Q6 — The script lives in `bots/roadmap-board/`; this doc holds the rules

CI's bots job already runs that workspace's tests, and the script needs no new dependency. The skills' sync steps and a `bots/README.md` row come with the script.

Decided: maintainer, 2026-10-23 (#1197)

| Rejected | Why |
|---|---|
| The rules only in the script header and the project's README | Later sessions don't look there, so the decisions get re-argued, and review-decisions can't check them |
| `scripts/` | No CI job runs tests there; wiring one is a workflow change |
| A new workspace (`tools/roadmap-board/`) | A lockfile change made with CI's exact Node and npm, and a new CI job, for one script |

It runs from a session, not on a schedule, so the bot conventions (cron, transcripts, outcome tags, skip-lists) don't apply; `bots/README.md` (cut 2) and `dev-glossary.md` say so.

Follows from Q5.

### Q7 — An issue with two area labels gets the first in a fixed order

The order is cms, renderer, cli, storage, templates. The card still shows both labels, and each run lists these issues: triage gives each issue one area label, so two is a slip to fix.

Decided: maintainer, 2026-10-23 (#1197)

| Rejected | Why |
|---|---|
| A "several" value | A group in the Roadmap and All tables that isn't an area, and the items leave both areas' groups |
| A multi-select Area field | GitHub's docs don't say a view can group by one |
| No Area field, one tab per area label | Five tabs instead of a group per area in one table; a new area label needs a new tab |

### Q8 — A dry run by default, and a stop when more than 10 cards would leave the roadmap

The sync only prints its plan unless run with `--apply`. A run that would take more than 10 cards off the roadmap stops unless `--allow-removals` is passed. That counts cards whose Section it would clear (a lost section's open issues) and listed issues or drafts it would remove. Closed issues the file never listed leave without counting. When it stops, the merging session shows the maintainer the plan and asks before rerunning.

Decided: maintainer, 2026-10-23 (#1197)

| Rejected | Why |
|---|---|
| A dry run only, with no stop | A large removal goes through once `--apply` is passed, unless someone read the plan |
| A stop above 20% of the items | 20% of about 155 items is 31: a whole lost section can pass |
| Apply by default, no stop | A misread file empties part of the board until the next good run |
| Count every removal | With auto-add, issues that close without being in the file are removals (66 of the 70 closed in the two weeks to 2026-10-23 weren't on the roadmap, in its four buckets, at dcfcdb8), so it would stop most runs, and it misses a lost section's open issues |
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
| In this PR | The link would show an empty, private board until the script landed and the first sync ran |
| No link | ROADMAP readers wouldn't learn the board exists |

### Q11 — Deferred items get the Section "Deferred"

Section marks what's on the roadmap, so every listed card needs one, and Deferred has no `###` headings.

Decided: maintainer, 2026-10-23 (#1197)

| Rejected | Why |
|---|---|
| A separate "On roadmap" field | One more field to sync and show |
| Status as the marker (`has:status`) | GitHub's built-in rule gives every closing issue the Status Done, including ones the file never listed, so they'd show in the roadmap tabs until the next sync. Only the sync sets Section |

### Q12 — Each bucket tab shows only its own sections (superseded)

Superseded by Q14 on 2026-10-24 (#1228): there are no bucket tabs, so no columns to hide, and a new section needs no step. The decision and its alternatives are in #1197.

### Q13 — The sync paces and caps its writes

The sync waits 1 second per write, sets a card's fields in one request, doesn't clear fields on a card it has just added, and stops before 450 writes in a run, saying when to rerun. A "was submitted too quickly" error counts as a rate limit. GitHub's docs don't say how a request carrying several mutations counts, and the one report found says each creation counts (What GitHub allows), so the sync counts writes. The first sync, about 580 writes, takes two runs an hour apart; later syncs write a handful.

Decided: maintainer, 2026-10-23 (#1197)

| Rejected | Why |
|---|---|
| Keep the pacing per request and document the risk | If GitHub counts each write, a request with a card's three field writes counts three times: the first sync could pass 500 writes in an hour and stop with cards added but some fields missing, and reaching the limit pauses all content writes from the maintainer's account for up to an hour |
| Cap only creations (cards, drafts, views) | Rests on a guess: the report is about creating issues, and GitHub's docs don't say whether a field update counts |
| Write as fast as possible, and rerun if GitHub stops the first sync | About 580 writes back to back: the first sync may stop at the hourly limit with cards added but no fields, until a rerun an hour later |
| Retry for up to an hour on a rate-limit error | A session sits blocked, and the writes still ignore GitHub's 1-second guidance |

### Q14 — Tables grouped by area, sorted by bucket and section

The Roadmap and All views are tables grouped by Area and sorted by Status, then Section: each area lists Now's items first, then Next's and Later's, and within a bucket each initiative's items together, in the file's order. Roadmap shows Now, Next and Later; All shows everything the file lists, Deferred and Done included (Q15). There are no bucket tabs and no By area tab. The grouping and sort are set by hand.

Decided: maintainer, 2026-10-24 (#1228)

| Rejected | Why |
|---|---|
| Bucket tabs with a column per section, sliced by Area (#1226) | Three tabs to read the plan, and each needed the other buckets' sections hidden by hand (Q12) |
| One board: a column per bucket, a lane per area | Five lanes by three columns make narrow cards, and the section shows only inside each card |
| A table grouped by Status, with Area as a column | Answers "what's next" first and "whose" second |
| Rows in the order they were added | Matches the file's order only until new items arrive: they go to the bottom, and an item that changes bucket keeps its place |
| Sorted by Section only | The same order for open items, but in All the closed issues stay mixed in with their initiative's open ones |
| Deferred on the Roadmap table | Its 33 drafts have no Area, so they'd be the biggest group, about 29% of the view |

### Q15 — Roadmap hides Done; All shows it until the file moves it to Shipped

The Roadmap view filters out Done (`-status:Done`), so a closed issue leaves the plan as soon as GitHub's built-in rule sets Done. All shows the closed issues ROADMAP.md still lists, sorted last in each area (Q14): they're the cleanup the merging session has to do, moving them to the Shipped appendix; the next sync then removes their cards, like any closed issue the file doesn't list (Q3). Each run also prints them.

Decided: maintainer, 2026-10-23 (#1226); All shows Done: maintainer, 2026-10-24 (#1228)

| Rejected | Why |
|---|---|
| A Done column on the Roadmap view | Not needed on a roadmap |
| Hide Done in All too (#1226) | The cleanup would show only in the sync's output, which the merging session sees |
| Remove closed issues from the board even when ROADMAP.md lists them | Readers see the same; Q3 changes, and Q8's 10-card stop would have to leave these removals out |

## The board

### Fields

Follows from Q2, Q3, Q5, Q7, Q11, Q14 and Q15.

| Field | Values | Set by |
|---|---|---|
| Status (built in) | Now, Next, Later, Deferred, Done | The sync: the item's bucket, or Done when its issue is closed, as completed or not planned. GitHub's built-in rule also sets Done when an issue closes. Its options' order sorts the rows (Q14); only All shows Done (Q15) |
| Section | The `###` heading the item is under; "Deferred" for Deferred items (Q11). Its options follow the file's order, which sorts the items within a bucket (Q14) | The sync. Only items the file lists have one, so Section marks what's on the roadmap |
| Area | The issue's `area:` label: cms, renderer, cli, storage, templates; Q7 for an issue with two | The sync |

Status keeps GitHub's Done option and its id, so the built-in rule keeps working; Todo and In Progress are replaced by the four buckets.

### Views

Follows from Q2, Q3, Q5, Q11, Q14 and Q15.

| View | Layout | Filter | Set by hand once |
|---|---|---|---|
| Roadmap | Table | `has:section -status:Done -status:Deferred` | Group by Area; sort by Status, then Section |
| All | Table | `has:section` | Group by Area; sort by Status, then Section |
| Not in ROADMAP.md | Table | `no:section is:open` | — |

The sync creates missing views with their layout, filter and visible fields. Their grouping and sort are set once in GitHub's view menu, since the API can't; the project's README lists the steps. Drafts have no Area, so they're grouped with any other item without one.

### Project text

Follows from Q9.

- Description: "Generated from ROADMAP.md at `<commit>` on `<date>`. Edit the file, not the board." The sync updates it each run.
- README: what each view shows, a link to ROADMAP.md for the reasons and dependencies behind each item, and the one-time setup steps.

## The sync

Follows from Q1, Q3, Q4, Q7, Q8, Q13 and Q15.

1. Read ROADMAP.md. `## Now`, `## Next`, `## Later` and `## Deferred` start a bucket; any other `##` heading ends it, and the second top-level heading (`# Appendix: Shipped status`) ends the plan. `###` headings set the Section.
2. Collect issue references: links to an issue, whatever their text, and bare `#N`. A link counts as its issue's number, so a range of links (`[#515](…)–[#520](…)`) expands like `#A–#B` (spans of up to 30). `Decided:` and `Follows from` lines are skipped. Each reference is a list item, table row or prose mention, and Q4 picks its place.
3. Collect drafts (Q3). A table row's draft takes its first cell as the title and the other cells as the body; a bullet's takes its first sentence as the title and the whole text as the body.
4. Look the numbers up and keep issues; pull requests are dropped. List the repository's open issues too: those the file doesn't mention go on the board with no Status or Section, since auto-add only adds issues created or updated after it's turned on.
5. Read the project: fields, items and their values.
6. Plan: add missing items, set fields that differ, and remove issue items that are neither on the roadmap nor open. Drafts are matched to the file one-to-one by title (Q3), and one whose body changed is updated in place; drafts the file no longer has, and extra copies, are deleted. Items that aren't issues of this repository or drafts (a pull request added by hand) are left alone and reported.
7. Every run prints the plan, the issues mentioned in more than one place, the issues with two area labels, drafts whose titles collide (Q3) and the closed issues the file still lists (Q15). Without `--apply` it stops there. With it, it writes the changes, paced and capped as Q13 says, updates the description and prints what changed; a run that reaches the cap says when to rerun. Q8's stop applies before anything is written.

Two runs at once converge on issues: adding an issue that's already on the board returns its item, and the later run sets the fields again. They can both add a new draft; the next run deletes the extra copy.

## Foundational checks

Dev-process tooling with no product surface. Scale: about 155 items, far below GitHub's 50,000 per project. GitHub allows 80 content-generating requests a minute and 500 an hour (What GitHub allows); the sync waits 1 second per write and stops before 450 a run (Q13), so the first sync takes two runs an hour apart and later ones a few seconds. Multi-instance: see "The sync". Auth: the sync uses the maintainer's `gh` login with the `project` scope; nothing is stored. Audit: GitHub's issue timelines record each add and Status change. Locale, themes, review workflow, hooks, render, validation, plugin, cache, offline and collaboration: N/A.

## UX check

The board is quiet when the file and the issues agree: no badges or notes of its own, and no closed issues in the plan (Q15). Each table answers where first, with a group per area, then when, with rows sorted by bucket and each initiative's items together (Q14). Names are the file's words. The description says when the board was last synced, and the README sends readers to ROADMAP.md for the reasons.

## Cut sequence

Follows from Q5, Q6, Q10, Q13 and Q14.

| # | What | Depends on | Test tier | Risk |
|---|---|---|---|---|
| 1 | `bots/roadmap-board/`: parser, planner and sync with dry run and `--apply`, writes paced and capped (Q13); creates the project's fields and views when missing | — | unit + manual run | Medium |
| 2 | The sync steps in review-decisions and review-prs, the matching update to `design-decision-review.md`, and a `bots/README.md` row | 1 | (docs) | Low |
| 3 | Make the project public (it exists as the org's project 1, linked to the repository on 2026-10-23); run the first sync from `main`, in two runs an hour apart (Q13); set the Roadmap and All views' grouping and sort (Q14) and the auto-add rule by hand, checking that Status sorts Now, Next, Later; link the board from ROADMAP.md's Process section (Q10) | 1, 2 | (manual) | Low |

## Migration

None: the project is new.

## Future directions

- **Run the sync from a workflow** on every push to main that changes ROADMAP.md, once the bots have a GitHub App token that can reach projects. No open issue tracks that token: #336 was closed in May by an unrelated fix (#338).
- **Progress per initiative**: milestones per section (Q2) or sub-issue links from planner issues to their cuts, so planner cards show the sub-issue progress field.
- **A "Good first issues" view**, if contributors ask.
