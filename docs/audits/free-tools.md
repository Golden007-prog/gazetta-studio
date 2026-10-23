# Free tools and services for gazetta-studio

Researched 2026-10-23. Question: beyond what's already on, which free tools or services should a public repository on GitHub's free organisation plan start using?

**Decision (2026-10-23, the maintainer's answers).**
- Private vulnerability reporting: turned on 2026-10-23, with a security policy in #1207.
- Dependabot: the six open alerts fixed by hand (#1202); why Dependabot opened no PR for them is #1214.
- Socket: try its free Team account for open-source projects (#1208). The maintainer asks Socket for it and installs the app.
- An outage alert for gazetta.studio: optional (#1209).
- pkg.pr.new preview builds: with the onboarding work (#1210).
- Merge queue: not now (see below).

## Already on (2026-10-23)

CodeQL (default setup), secret scanning with push protection, Dependabot security updates, OpenSSF Scorecard, dependency review (`fail-on-severity: moderate`, so a PR fails only on a *known* vulnerability), and Discussions. The default `GITHUB_TOKEN` permission is `read`.

## Candidates (checked against the official pages, 2026-10-23)

| Tool | Free terms | What it fixes here | Call |
|---|---|---|---|
| **Private vulnerability reporting** (GitHub) | "Owners and administrators of public repositories can allow security researchers to report vulnerabilities securely in the repository by enabling private vulnerability reporting" ([docs](https://docs.github.com/en/code-security/security-advisories/working-with-repository-security-advisories/configuring-private-vulnerability-reporting-for-a-repository)). No plan or price is named | Reports arrive privately instead of as public issues; Scorecard flagged the missing security policy | **Done** (#1207) |
| **Socket** | "Socket is and will always be free to use for open-source. If you want a free Team account for your open-source project, contact us." The Free plan has 1 dev seat, and "a developer is someone who made a commit to your organization's repository scanned by Socket in the past 90 days" ([pricing](https://socket.dev/pricing)) | Flags what a new package version does: known malware, install scripts, typosquats and more ([docs](https://docs.socket.dev/docs/socket-for-github)) | **Try** (#1208) |
| **UptimeRobot** | Free: 50 monitors, 5-minute checks, 1 basic status page, 5 integrations, the mobile app ([pricing](https://uptimerobot.com/pricing/)); "available for any use, including commercial and business use" ([terms](https://uptimerobot.com/terms/)) | gazetta.studio has no outage alert; it's checked only after deploys | Optional (#1209) |
| **pkg.pr.new** | MIT; v0.0.92 tagged 2026-10-16, after two other October tags ([repo](https://github.com/stackblitz-labs/pkg.pr.new)). No free-tier terms or limits are stated | Install a PR's `gazetta` build without an npm release | With onboarding (#1210) |
| **Merge queue** (GitHub) | "Merge queue is available on private and public repos on the GitHub Enterprise Cloud plan and all public repos owned by organizations" ([changelog, 2023-07-12](https://github.blog/changelog/2023-07-12-pull-request-merge-queue-is-now-generally-available/)); today's docs don't say either way | A PR that falls behind `main` updates and reruns CI by itself | Not now |

### Private vulnerability reporting

From [Managing privately reported security vulnerabilities](https://docs.github.com/en/code-security/how-tos/report-and-fix-vulnerabilities/fix-reported-vulnerabilities/manage-vulnerability-reports) and [Privately reporting a security vulnerability](https://docs.github.com/en/code-security/security-advisories/guidance-on-reporting-and-writing-information-about-vulnerabilities/privately-reporting-a-security-vulnerability):
- "An advisory that was reported privately has a status of `Triage`."
- "When the report is submitted, GitHub automatically adds the reporter of the vulnerability as a collaborator and as a credited user on the proposed advisory."
- "To accept the reported vulnerability, click Accept and open as draft to accept the vulnerability report as a draft advisory on GitHub."
- "To collaborate on a patch in private, click Start a temporary private fork…"
- Notifications go to repository administrators and security managers who watch the repository or subscribe to security alerts.

### Socket

- The app comments on a pull request that adds a risky dependency, and offers a check, "Socket Security: Pull Request Alerts", that can be made required ([branch protection](https://docs.socket.dev/docs/enable-branch-protection.md)).
- The risks its guide lists: typosquats, install scripts, telemetry, native code, known malware, shell script overrides, mutable git or HTTP dependencies, invalid manifests, protestware.
- `main` had 4 human committers in the 90 days to 2026-10-23, so the Free plan's one seat doesn't fit. Not stated: whether bot accounts count as seats, and whether any detection is paid-only.

### UptimeRobot

- The Free plan's integrations are Google Chat, Discord, Pushover, Pushbullet and Splunk ([pricing.md](https://uptimerobot.com/pricing.md)).
- The pricing pages contradict each other on Free's monitor types: the plan card lists SSL, API and DNS monitoring, while the table, the FAQ and pricing.md say those are paid. Email alerts on Free aren't confirmed either way.
- Open-source and non-profit projects can apply for a "sponsored subscription" with paid features (terms, section 3; the sponsorship page wasn't read).
- Uptime monitoring is a non-goal for Gazetta the product (`design-live-check.md`); this would watch the project's own site.

### pkg.pr.new

- Setup: install its GitHub App, add `pkg-pr-new` as a devDependency (a lockfile change, made with CI's Node and npm, team rule 9), and run it from the lockfile ("avoid `npx` … for this step") as `npm exec pkg-pr-new publish './packages/gazetta'`.
- "Releasing approved pull requests is the recommended way of having continuous releases", which also keeps a fork's untrusted code from getting an installable URL under the project's name.
- Not stated: limits, retention, and whether PRs from forks can publish. Preview builds keep the package's version unless `--previewVersion` is passed.

### Merge queue

- "You must use the `merge_group` event to trigger your GitHub Actions workflow when a pull request is added to a merge queue" ([docs](https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/configuring-pull-request-merges/managing-a-merge-queue)). Rebase merging is supported.
- **Why not now:** `gh pr merge --help` (gh 2.87.3) says "To bypass a merge queue and merge directly, pass the `--admin` flag." `main` requires an approving review, which the maintainer can't give their own PRs, so those all merge with `--admin` and would skip the queue. It would help only contributor and bot PRs.
- Revisit when contributor or bot PRs often fall behind `main` and wait for CI twice.

## Worth an hour, with no new tool (2026-10-23)

- **Dependabot.** The six alerts (`vitest`, `@vitest/mocker`, `qs`) are fixed by #1202. Two new ones came the same evening:
  - 196, `serialize-javascript` (low, dev-only): Dependabot's #1206, with its lockfile rewritten by CI's npm.
  - 199, `undici` (high: denial of service via excessive content-encodings), dev-only, in `sites/gazetta.studio/worker/package-lock.json`. `miniflare` pins `undici` to exactly 7.29.1, and so does the latest `wrangler` (4.152.0). Decided 2026-10-23: wait for `wrangler` to move; Dependabot opens that PR.
- **Scorecard: 46 alerts** (#1211).
  - 24 token permissions: 14 workflows have no top-level `permissions:` block, and 10 job-level writes are ones the bots need.
  - 17 pinned dependencies: 12 workflows install `@anthropic-ai/claude-code@stable` (15 times; `bots-compact.yml` has four), `scripts/actionlint.sh` pipes a downloaded script to `bash`, and `scripts/smoke-publish.sh` installs a local tarball.
  - One each for security policy (#1207), vulnerabilities (the Dependabot alerts), code review (a solo maintainer merging with `--admin`), SAST, and the OpenSSF best-practices badge.
- **CodeQL: 2 alerts**, both in test code: shell commands built from a temp path in `packages/gazetta/tests/cli.test.ts` (#1212).
- **Found while checking:** nothing tracks a GitHub App token for the bots since #336 closed (#1213), and `design-feature-bot.md` still says `has_projects` is false (#1215).

## Not recommended

- **CodeRabbit:** dropped in the AI review trial, because its free plan allows one review an hour (`ai-code-review-tools.md`).
- **Codecov:** coverage is a report here, not a gate (`AGENTS.md`).

## Fact-check ledger

The first answer, given before every page was read, had three things wrong or open:
- **Private vulnerability reporting:** it said reports "arrive privately as draft advisories". They arrive in Triage; accepting one makes the draft.
- **UptimeRobot:** it said commercial use wasn't stated. The terms allow "any use, including commercial and business use".
- **Merge queue:** availability was unchecked (found in the 2023 changelog), and the `--admin` catch was missing.

Still unknown: whether merge queue is available today (only the 2023 changelog says so), UptimeRobot's email alerts and SSL checks on Free, pkg.pr.new's limits and support for fork PRs, and Socket's seat rule for bots and its paid-only detections.
