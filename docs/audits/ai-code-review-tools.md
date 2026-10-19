# AI code-review tools for gazetta-studio

Researched 2026-10-19. Question: which third-party AI reviewer can a public repo on GitHub's free organisation plan connect for free, and how good are they?

**How we review.** The maintainer reviews every PR locally with Claude in VS Code (`/review-prs`). The `review-on-comment` workflow (`@claude review`) exists but isn't used. Before the trial, a PR got its first review only when that local session ran, so outside contributors waited for it. Since 2026-10-19, Sourcery also reviews every PR when it opens and on each push, drafts included, except dependency-bot PRs.

**Decision (updated 2026-10-19).** Trial **Sourcery** for 3–4 weeks on real PRs. CodeRabbit was tried first and dropped: its free plan allows one review an hour (see "Seeded-bug results"). The reviewer's comments are an input to the local review, which checks each claim before relying on it.

## Free options (checked against official pricing pages, 2026-10-19)

| Tool | Free for us? | Our API key? | Notes |
|---|---|---|---|
| **CodeRabbit** | "free reviews forever for public repositories" ([pricing](https://www.coderabbit.ai/pricing)) | No (GitHub App) | Summary, inline comments, chat. Skips drafts by default; bots ignored by username. "never uses customer code for training" ([FAQ](https://docs.coderabbit.ai/faq)). |
| **Sourcery** | "Code review for public repos — Free forever" ([pricing](https://sourcery.ai/pricing)) | No | Skips dependency bots and drafts by default. Doesn't train on code. |
| Codacy | Team plan "Free forever for open-source projects", includes "AI Reviewer" ([pricing](https://www.codacy.com/pricing)) | No | Mostly static analysis |
| SonarQube Cloud + Gitar | Free for public, OSI-licensed repos ([pricing](https://www.sonarsource.com/plans-and-pricing/sonarcloud/)) | No | Static analysis plus an AI reviewer |
| Greptile | 50 credits/month, or an OSS programme with instant approval at 50+ stars ([OSS](https://www.greptile.com/pricing/open-source)) | No | Too limited at 0 stars |
| PR-Agent ([repo](https://github.com/The-PR-Agent/pr-agent)), Kodus | Free software | Yes | We'd pay the model |

Not free for us: GitHub Copilot code review (organisations need a paid plan, [plans](https://docs.github.com/en/copilot/get-started/plans)), Gemini Code Assist on GitHub (consumer version shut down 2026-07-17, [notice](https://developers.google.com/gemini-code-assist/docs/deprecations/consumer-code-review)), hosted Qodo Merge, Graphite (personal-account repos only on Hobby), DeepSource AI review (pay-as-you-go), Bito, Cubic.

Who uses CodeRabbit (a `.coderabbit.yaml` in the repo): TanStack/query, trpc/trpc, biomejs/biome, and two CMSes, payloadcms/payload and strapi/strapi.

## Quality evidence

| Tool | Evidence | Kind |
|---|---|---|
| CodeRabbit | 31,073 comments on 10,191 PRs in 239 repos: 36.4% accepted, 7.3% discussed, 56.3% rejected, mostly false positives, redundancy or out of scope ([Lin et al., arXiv 2607.03316](https://arxiv.org/abs/2607.03316)) | Independent |
| CodeRabbit | Highest recall on Martian's online benchmark (0.54); Martian sells no coding tools and calls its numbers preliminary ([post](https://withmartian.com/post/code-review-bench-v0)) | Independent |
| CodeRabbit | One maintainer's month: 28 PRs, 35% quality improvements, 21% nitpicks, 15% useless, 13% wrong assumptions, 3% security ([Lychee](https://lycheeorg.dev/2025-09-13-code-rabbit/)) | Anecdote |
| PR-Agent | 73.8% of comments resolved in an industrial deployment, but PRs took longer to close; 2024 data ([ICSE-SEIP 2025](https://arxiv.org/abs/2412.18531)) | Independent |
| Sourcery | Two 2025 teams: one turned it off (about 50% noise, caught 2 of 4 seeded bugs, [post](https://piware.de/post/2025-08-09-sourcery)), one kept it ([Pulp](https://pulpproject.org/blog/2025/06/18/my-experience-with-sourcery-ai-in-pulp-service-development/)) | Anecdote |
| Codacy AI Reviewer, Gitar, Kodus | No independent numbers found | — |

General findings, all independent:
- Noise is the main failure mode: 12 of 13 review agents had under 60% useful comments ([arXiv 2604.03196](https://arxiv.org/abs/2604.03196)).
- Finding more issues costs precision; no tool found more than 63% of known issues on Martian's set.
- Every vendor benchmark (Greptile, Qodo, CodeAnt) ranks its own author first.
- No study measures a tool next to an existing Claude reviewer, which is our case.

Checked first-hand by the maintainer's session: CodeRabbit's pricing wording, the Gemini shutdown notice, the Lin et al. abstract and Martian's post. The rest is from two research passes that cited official pages; their unverified points are listed under "Unknown".

## Seeded-bug results (2026-10-19)

Four PRs (#1007–#1010) each undid the source part of one fix from that week, with tests and docs left in place and neutral titles. Each fix's own tests failed on its branch, so each bug was really back.

| Bug brought back | CodeRabbit | Sourcery |
|---|---|---|
| #979: restored reorders act on any page | Found half (`clear()` drops other pages' drafts), plus a stale-etag point. Took the other half as "update the test". | Found both halves, with the right fix |
| #971: previewing an archived page returns 500 | Not reviewed (rate limit) | Found, with the right fix |
| #984: edits made during a save get lost | Not reviewed (rate limit) | Found every part, as five findings |
| #983: metadata missing from the publish hash | Not reviewed (rate limit) | Found, including "absent and empty stay equal" |

- **CodeRabbit's limit:** after the first review, "Your plan provides up to 1 included review per hour". The next PRs got "Review limit reached" and aren't retried by themselves. Fix-bot can open several PRs a night, so this doesn't fit our volume.
- **Sourcery:** all four reviewed within minutes, no limit hit. One weak comment: on #1007 it suggested updating the failing tests to match the code, the same mistake CodeRabbit made.
- **Caveat:** these were easy targets. Each PR deleted protective code that is visible in the diff. Bugs written fresh, with no removed guard to see, are harder; the real-PR trial is what tests that.
- **Not tried:** Codacy AI Reviewer (its automatic review runs once at PR open and skips drafts, so fix-bot's draft PRs would need a manual run each time; it also adds static analysis and a status check to every PR). Gitar (needs an application, write access to Actions and workflows, and pushes its own commits to PR branches, which our reviewed-PR workflow rules out; budgets unpublished).

## Trial plan

1. **Installed:** the Sourcery GitHub App, on all org repos. Settings live in Sourcery's web settings, not in a repo file. Draft reviews are on (turned on 2026-10-19), because fix-bot and feature-bot open drafts once their work is done. Dependency-bot PRs are still skipped. **Auto-approve is off** (2026-10-19): Sourcery's approvals are real GitHub approvals, and branch protection needs one approving review, so a bot approval passed the gate meant for a person. CodeRabbit was uninstalled.
   Settings for the trial, kept fixed until it ends:
   - General: review comments on, review profile **Balanced**, review guide and sequence diagrams on (useful to people reading a PR), PR summary **off** (it edits the PR description; bodies are written on purpose and a stray "Fixes #N" would close an issue), tips-and-commands comment off, approval off, path filter `package-lock.json`.
   - Auto-review: no title, label or branch filters; drafts reviewed.
   - Security scanning on. Review rules empty; add targeted rules only after the trial, if the same misses repeat.
2. **Seeded bugs:** done, see above. Still open: a local review of the same four changes, in a fresh session that doesn't know the answers. `/review-prs` lists only open PRs and the seeded PRs are closed, so review each commit's revert directly (`git diff <sha> <sha>^ -- '*/src/*'` for `6e87c8f1`, `7adfced3`, `03757410`, `bbd678ab`) or reopen the PRs for it.
3. **Real PRs, 3–4 weeks from 2026-10-19.** For each Sourcery comment, record accepted, discussed or rejected (the Lin et al. categories), whether the local review had already found it, and any limit message.
4. **Decide.** Keep it if it catches bugs the local review misses, at a noise level the local review filters without much cost. If kept, add the Sourcery badge to the README. Otherwise uninstall it.

## Unknown

- Sourcery's limits for public repos (not published; paid plans list "higher review limits"), and whether it reviews fork PRs.
- Bot and fork-PR behaviour, training policy and quality for Codacy, Gitar, Kodus and CodeAnt.
- How much any tool overlaps with a Claude review of the same PR.
