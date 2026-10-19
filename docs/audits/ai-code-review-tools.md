# AI code-review tools for gazetta-studio

Researched 2026-10-19. Question: which third-party AI reviewer can a public repo on GitHub's free organisation plan connect for free, and how good are they?

**How we review today.** The maintainer reviews every PR locally with Claude in VS Code (`/review-prs`). The `review-on-comment` workflow (`@claude review`) exists but isn't used. A PR gets its first review only when that local session runs, and outside contributors wait for it.

**Decision.** Trial CodeRabbit for 3–4 weeks (`.coderabbit.yaml`), judged by the plan below. Its comments are an input to the local review, which checks each claim before relying on it.

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

## Trial plan

1. **Install** the CodeRabbit GitHub App on `gazetta-studio/gazetta-studio` (organisation owner). Config: `quiet` profile, Dependabot ignored, drafts skipped, lockfile excluded.
2. **Seeded bugs.** For each fix below, open a PR that reverts only its source changes (tests kept out), titled `[seeded-bug test]`, not a draft, and close it without merging. Record whether CodeRabbit flags the bug, and whether a local `/review-prs` session does.
   - `6e87c8f1`: restored reorder drafts act on whichever page is open (#979)
   - `7adfced3`: previewing a redirect returns 500 (#971)
   - `03757410`: edits made while a save runs get lost (#984)
   - `bbd678ab`: a metadata-only edit doesn't count as a change for publishing (#983)
3. **Real PRs, 3–4 weeks.** For each CodeRabbit comment, record accepted, discussed or rejected (the Lin et al. categories), and whether the local review had already found it.
4. **Decide.** Keep it if it catches bugs the local review misses, at a noise level the local review filters without much cost. Otherwise uninstall it and delete `.coderabbit.yaml`. Fallback to try: Sourcery.

## Unknown

- CodeRabbit's rate limits for open-source plans (not published), and whether it reviews fork PRs.
- Bot and fork-PR behaviour, training policy and quality for Codacy, Gitar, Kodus and CodeAnt.
- How much any tool overlaps with a Claude review of the same PR.
