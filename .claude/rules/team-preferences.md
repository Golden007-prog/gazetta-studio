# Team Preferences

Validated approaches and things to avoid. Each entry: rule, then why.

## Tag convention

Rules tagged `[local]` apply only to interactive Claude Code sessions (the maintainer working directly). Bots (feature-bot, fix-bot, dead-code-watcher, etc.) MUST exclude these rules from their context — bot prompts cite team-preferences with an "EXCEPT rules tagged `[local]`" clause.

Why: some rules describe processes bots structurally cannot do (research, grilling, releases, four-phase discipline). A bot honoring rule 25 ("grill design docs") could try to "grill" something inappropriately; excluding them prevents misapplication.

Default for new rules: untagged (apply universally). Add `[local]` only when bot application would be structurally wrong, not just irrelevant. Rules that self-gate via their body's conditional clauses (e.g., "When fixing a bug in one bot...") don't need a tag — Claude correctly ignores them when the condition doesn't match.

1. **No auto-save in CMS.** Edits stay in memory until explicit save. Preview uses POST with draft content overrides.
   Why: Auto-save doesn't fit the CMS UX — content authors need control over when changes are persisted.

2. **Use testcontainers for Docker-based integration tests, not docker-compose.**
   Why: Testcontainers manage lifecycle programmatically — cleaner setup/teardown, no manual docker-compose up.

3. **Use data-testid attributes for Playwright selectors, not CSS classes or aria-labels.**
   Why: CSS/aria selectors are brittle — break when PrimeVue updates or labels change. Test IDs are stable.

4. **Write tests alongside new functionality, in the same commit.**
   Why: Tests added as follow-up commits get forgotten or deprioritized. Ship tested code, not code then tests.

5. **Types infer from Zod schema — single source of truth.**
   Use `type Content = z.infer<typeof schema>` and `TemplateFunction<Content>`. Don't duplicate types manually.

6. **Content, not props.** The CMS vocabulary is "content" — matches what content authors see. Don't use React terminology (props) in CMS/template code.

7. **Consistent naming across CLI, UI, and API.** If the CMS button says "Publish", the CLI command is `gazetta publish`, the API endpoint is `/api/publish`. Don't use synonyms (build, deploy, push) for the same action. One word per concept.

8. **Update docs in the same commit as the feature.** When adding or changing user-facing behavior, update getting-started.md and gazetta.studio docs in the same commit. Don't leave docs as a follow-up.
   Why: Docs that lag behind the code mislead users and create extra issues to track.

9. **npm release: bump version, lockfile, commit, tag — all together, AND match CI's Node version.** `[local]`
   When bumping the gazetta package version, first verify local Node matches CI's Node (currently 22, per `.github/workflows/publish.yml`). Then:
   ```
   npm version <patch|minor|major> -w packages/gazetta
   git add packages/gazetta/package.json package-lock.json
   git commit -m "Bump gazetta to v$(node -p "require('./packages/gazetta/package.json').version")"
   git tag "v$(node -p "require('./packages/gazetta/package.json').version")"
   git push && git push --tags
   ```
   `npm version -w` updates package.json and lockfile but does NOT commit or tag (disabled for workspaces). Must do it manually.

   **Why local Node must match CI Node:** optional peer deps in the lockfile are Node-version-conditional. Running `npm version` on Node 25.1.0 stripped `@emnapi/core` + `@emnapi/runtime` from the lockfile that Node 22 CI requires; `npm ci` then failed with `Missing: @emnapi/core ... from lock file`. The same family of mismatch as the v0.1.1 lockfile bug — different mechanism.

   **The npm version must match too, not just Node.** Any lockfile regeneration — a release bump *or* a dependency change — must use the exact Node + npm pair CI uses, read from the `setup-node` step of a CI log (`node: v22.x`, `npm: 10.x`). On 2026-10-04 a lockfile produced by npm 11 running on Node 22 still failed CI's Node 22 + npm 10.9.9 `npm ci` (`Missing: @emnapi/runtime@1.11.3`). Fix: `npx -p node@<ver>` for the binary, `npx -p npm@<ver>` for npm, run `install --package-lock-only` with that pair, and verify with a real `npm ci` using the same pair before pushing.

   **Recovery shape when CI fails at `npm ci` because of lockfile drift:** restore the pre-bump lockfile (`git show <prev-sha>:package-lock.json > package-lock.json`), manually re-edit version in `packages/gazetta/package.json` AND the lockfile's `packages['packages/gazetta'].version` field, commit forward (branch protection blocks force-push to main), delete the remote tag, recreate it at the new commit, push. If npm hasn't published yet (`npm view gazetta@<version>` returns ENOTFOUND), the version is reusable.

   **Why:** v0.1.1 shipped with lockfile out of sync because the commit and tag were done without the lockfile. v0.8.0 (2026-05-14) shipped after one failed CI run because local Node 25.1.0 didn't match CI Node 22 — recovered via forward commit + tag move.

10. **E2e test isolation: per-worker temp sites, not in-place mutation.**
   Each Playwright worker gets its own `cp -r` of `examples/starter` into `{repo}/.tmp/e2e-{workerIdx}/project/` with its own dev server on port 3100+workerIdx. Mutation tests write to the copy, never to the repo. See `tests/e2e/fixtures.ts` for the worker-scoped `testSite` fixture.
   Why: Earlier approach (git checkout in beforeEach) leaked state between tests via SSE reload timing. Temp sites eliminate the class of problem.

11. **When adding CI steps, verify assumptions locally first.**
   Before pushing CI changes, check: default parallelism settings, async import behavior, file watcher side effects, and timing differences between local and CI. One fact-check round saves multiple CI push-fix cycles.
   Why: The e2e CI setup took 5 pushes because we assumed Playwright defaults, SSE timing, and Vite import behavior without verifying.

12. **Dark mode CSS: use non-scoped `<style>` block, not `:global(.dark)` in scoped styles.**
   Scoped selectors get `[data-v-xxx]` attributes which beat `:global(.dark)` in specificity. Put dark overrides in a separate `<style>` (no `scoped`) using `.dark .component-name` selectors. Follow PreviewPanel's pattern.
   Why: ComponentTree dark mode was broken — `:global(.dark) .node-root .node-label` lost to `.node-root .node-label[data-v-xxx]`.

13. **Vite dev: pre-scan custom editors in `optimizeDeps.entries` + include JSX auto-runtime explicitly.**
   When Vite finds a new dep at runtime (after initial optimization), it fires `optimized dependencies changed. reloading` — a full page reload that wipes editor state mid-session. Custom editors under `admin/editors/*.tsx` must be listed in `optimizeDeps.entries`, and `'react/jsx-dev-runtime'` / `'react/jsx-runtime'` must be in `optimizeDeps.include` (the scanner can't see them — they're injected by esbuild at transform time).
   Why: The #122 flake took 3 diagnosis iterations to find. Symptom ("Select a component to edit") looked like a store clear bug; actual cause was Vite's lazy dep optimizer. Always investigate with CI browser console capture before speculating.

14. **Editor mount composables: capture (mount, el) as a pair — don't rely on the ref's current value at unmount time.**
   When `editorMount` ref changes (e.g. default form → custom editor), calling `editorMount.value.unmount(el)` uses the NEW instance's unmount on a container mounted by the OLD one — it's a no-op, leaving the React root behind. Next `createRoot(el)` triggers "container already has root" warning. Fix: store `current = { mount, el }` at mount time, use `current.mount.unmount(current.el)` at unmount time.
   Why: Discovered while diagnosing #122. The React warning on its own didn't break things, but it compounded with the Vite reload bug.

15. **Apply SOLID principles to every change.**
   Single responsibility (one module = one reason to change — e.g. `sidecars.ts` owns sidecar I/O, nothing else), open/closed (extend via injection — `compareTargets` takes `scanTemplates` as an option rather than hard-coding the default), Liskov (substitutable providers — `StorageProvider` contract), interface segregation (narrow interfaces like `SourceSidecarWriter { writeFor, invalidate }` rather than god objects), dependency inversion (routes depend on the `SourceSidecarWriter` interface, not on `createSourceSidecarWriter`).
   Why: Explicit user preference, reinforced in every major refactor of the performance work.

16. **Rebase is the default git strategy.**
   Main is rebase/fast-forward only — no merge commits. Branch protection on main requires linear history. Apply at every level:
   - **PR merge:** `gh pr merge --rebase` (never `--merge`). Use `--squash` only when the branch has messy intermediate commits.
   - **Updating a PR branch against main:** `git fetch && git rebase origin/main && git push --force-with-lease`. Never `git merge origin/main` into a feature branch.
   - **Resolving conflicts:** fix during rebase, `git add`, `git rebase --continue`. Don't abort to a merge.
   - **Stacked PRs:** rebase each downstream branch on its updated parent, don't cross-merge.

   Why: Linear history on main is what lets publish.yml and deploy-site.yml trust push events without re-running CI — every commit on main is a SHA that already passed CI on its PR. Merge commits create new SHAs whose validation didn't happen.

17. **Build and validate, don't spike.** When validating risky technical decisions, build the real thing in a sequence of rollback-able commits — no throwaway/spike code. Each commit must:
   - Produce real code that stays if the approach works (not demos to be deleted)
   - Be independently rollback-able (reverting restores the previous state cleanly)
   - Validate the riskiest assumptions early, as actual features rather than spike branches

   Order implementation steps by design-risk blast radius: low-risk foundational first, highest-risk architectural bets as single revertable commits near the end. If a risky step fails, reverting one commit loses one step of work — not a week of spike-then-reslice.

   Why: spikes get deleted; validated production code is permanent progress. A spike that "proves it works" still requires rewriting the real version afterward; building the real version directly means the proof *is* the progress.

18. **Build structurally right from the start — don't patch SOLID in.**
   Apply SOLID at module creation, not as an after-the-fact audit. Before writing code, identify the concerns being addressed and give each its own module; before introducing an interface, decide whether it's a single contract or a capability that not every implementation supports.

   Concretely:
   - **Before creating a file**, ask: what single reason does this have to change? If there are two, create two files.
   - **Before adding a method to an existing interface**, ask: will every implementation honor it? If not, it's a capability — create a separate interface and a type guard.
   - **Never ship stubs that throw `not implemented`** to satisfy an interface. That's LSP violation dressed as progress.
   - **Extract shared code when you first see the split concern**, not after a third caller — waiting until the 3-caller threshold (rule #15) applies to "shared utility functions," not to separating concerns that are already distinct at creation.

   When a review identifies SOLID violations, the fix is structural correction (new files, split interfaces, extracted policies), not patching. If the amendment is large enough to change the shape, amend the commit before it lands; if it already merged, land the restructure as its own commit with a clear "structural correction" message.

   Why: SOLID violations compound. A fused module with three concerns becomes three fused modules when its consumers copy the pattern. A stub-that-throws teaches callers to defensively check before every call, poisoning every downstream surface. Getting the structure right once is cheaper than fixing it in every caller later.

   Example (media v1 step 1): initial draft fused node-fs adapter, atomicity policy, and stream-interop into one 136-line filesystem provider, and stubbed `readStream`/`writeStream` on R2/S3/Azure with `throw new Error('not implemented')`. Correct structure split into three provider files (`filesystem.ts` as pure adapter, `_atomic-write.ts` for atomicity, `_stream-interop.ts` for web/node bridge) and introduced `BinaryStorage` as a separate capability interface with `isBinaryCapable()` type guard, eliminating the stubs. Amended the commit before merge — structure was wrong, not the features.

19. **Boy Scout rule — leave the code cleaner than you found it.**
   When you're passing through a file for a real change, fix the small broken things you see along the way: a pre-existing type error, a dead re-export, a stale comment, a missing test, an obvious typo. You don't need permission — that's the rule. Scope stays tight: only fix what's cheap *and* adjacent to the work you're already doing. The test for "adjacent": if the fix and the main change belong in the same logical commit, fix it; if cleaning it up would balloon the diff into unrelated territory, leave it (or file a separate commit).

   What counts as "passing through":
   - Editing a file for a real change → fair game to also fix anything obviously broken in it
   - Running `tsc --noEmit` and seeing a pre-existing error → fair game to fix if it's small
   - Running tests that pass but emit warnings → fair game to silence the warning's root cause

   What does NOT count:
   - Rewriting unrelated code "because you're in the file anyway" — that's scope creep
   - Aggressive refactors disguised as cleanup — if it's an architectural change, it deserves its own commit and design consideration

   Why: broken-window theory at the file level. A file with one pre-existing type error attracts more; a file that type-checks and tests cleanly stays that way. Small debt, cheap to fix right now, expensive to fix later when the context has evaporated.

   Example (media v1 step 5): `apps/admin/src/client/stores/editing.ts` was re-exporting `actions.open` which hadn't existed since the `useEditorActions` migration to `navigate()`. Type-checker flagged it; no runtime callers. Dropped the line as a drive-by fix in the same pass as adding the asset library store wiring.

20. **Fact-check claims before building on them.**
   When citing a competitor feature, an industry fact, an external API behavior, or anything you didn't directly verify, check it against the official source (vendor docs, GitHub releases, the actual API/SDK) before treating it as ground truth. Third-party blogs, summaries, and your own training data lie or drift. If you can't verify, say so explicitly — don't guess.

   Concretely:
   - When researching CMS features for design pressure, cite official docs URLs, not blog posts
   - When asserting "tool X does Y," verify; when you can't, say "appears to" or "claimed by" with the source
   - When a fact informs a structural decision, the decision is only as solid as the fact
   - When time is short, skip the citation — but flag the claim as unverified, not as ground truth

   Why: in the CMS feature audit (May 2026), of 27 cited claims about competitor features: 14 verified, 6 partially-correct or wrong, 5 unverifiable, 2 outright wrong. Wrong claims about Webflow's "backlinks" and Strapi's draft validation almost informed strategic decisions. The fact-check itself was cheap (~10 minutes via subagent); the cost of building on wrong claims is high.

   Example: I claimed "Contentful has contentful-merge for content models" — fact-check found no such feature in official docs. Would have proposed Gazetta features pattern-matching a thing that doesn't exist. Caught before commitment.

21. **Research informs design; design absorbs the conclusions; the research itself stays durable.** `[local]`
   When deep research feeds into a design decision, capture the research durably — competitive context, fact-check findings, rejected alternatives — somewhere reusable. The design doc absorbs the conclusions; the research itself shouldn't die in a transcript.

   Where research goes:
   - **Competitive audit / external benchmarking** → `docs/audits/{topic}.md`
   - **Rejected alternatives + reasoning** → `design-{feature}.md` "Distinctive choices" section
   - **Fact-check ledger** → in the research doc itself (which claims verified, which corrected)
   - **Strategic non-goals derived from research** → `docs/non-goals.md`
   - **Strategic prioritization** → `ROADMAP.md`

   Why: the same research informs future decisions on adjacent features. Re-doing it from scratch every time is wasteful; losing the rejected-alternatives reasoning means future-me re-litigates the same debate.

   Example: the CMS feature audit produced 22 categories of features modern CMSes ship; 13 were genuinely new to the roadmap. Captured in [`docs/audits/cms-feature-audit.md`](../../docs/audits/cms-feature-audit.md), driving [`ROADMAP.md`](../../ROADMAP.md) and [`docs/non-goals.md`](../../docs/non-goals.md). Without these durable artifacts the analysis would have died with the conversation.

22. **Every kind of work has a durable artifact home; if a session ends without producing it, the work dies.**
   The resumability contract: feature designs go in `design-{feature}.md` + `-implementation.md`; ADRs go in `docs/adr/`; domain language goes in `CONTEXT.md`; research goes in `docs/audits/`; strategic priorities go in `ROADMAP.md`; non-goals go in `docs/non-goals.md`; lessons go here in `team-preferences.md`. See [`feature-design-process.md`](feature-design-process.md) for the full mapping.

   Why: long conversations produce work in many shapes. Without designated homes, only feature-design work tends to survive (because the design-doc pattern is established); strategic prioritization, research, fact-check findings, and process conventions all die in transcripts. Naming a home for each kind of work makes "is this resumable?" answerable.

23. **UX follows "Don't Make Me Think" (Steve Krug).** When designing user-facing UI, ask "what can I remove?" not "what should I add?":

   - **Absence of indicator IS a state** — show indicators only when something is NOT-default or needs attention. The default state should be visually quiet.
   - **Universal icons over jargon** — cloud-with-slash, not "Queued"; refresh icon, not "Reload page from server."
   - **Same affordances regardless of system state** when possible — e.g., save button identical online and offline; author's mental model unchanged by connection state.
   - **Plain language** — "Was edited by someone else" not "STALE conflict"; "Saved locally" not "Queued."
   - **When tempted to add a help tooltip, fix the UI instead** — if the indicator needs explanation, the indicator is wrong.
   - **Offer UX choices as what the author does and sees** — when options behave differently, describe each as the author's steps and what they see afterwards, next to today's behaviour. The mechanism that differs hides the consequence the decision is about.

   Why: every sub-decision in UX work risks accumulating cognitive load on users. The default question for any UI element should be "can I remove this without losing meaning?" not "what should I add?"

   Example: `design-offline.md`'s sync-state visibility went through three iterations — initially 5 explicit states with "Queued" badges and numeric progress; the Krug-aligned final has a cloud-with-slash icon (synced is the absence of indicator), plain-language messages, and an identical save button online/offline. Two-thirds of the original UI surface removed without losing meaning.

   Example (offering a choice): #981's row-revert question first described each option's mechanism ("a row's revert keeps calling Discard when its component is open"), and the maintainer asked for the UX view. The second version was a table of author scenarios showing what each option undoes, next to today's behaviour. Its key row: with hero open, reverting hero would also drop the page's SEO edit, which isn't on screen. That settled it in one answer.

24. **Validate every primitive against the 5K-page envelope.** Per [`design-scale.md`](.claude/rules/design-scale.md), Gazetta targets 5,000 pages / 20,000 assets / 50 components-per-page as the operating envelope. Every new primitive (route handler, validator, walk, lookup, sidecar, cache key) must hold there:

   - **Avoid O(N-pages) walks at request time or on hot paths.** When a check would walk the whole content tree (e.g., "find archives whose `aliasOf === X`"), build a per-edge sidecar index and `readDir` it instead — same pattern as `asset-refs` and `fragment-deps` per [`sidecars.md`](.claude/rules/sidecars.md). The sidecar pattern is the established Gazetta way; deviating from it for "cut size" is short-term thinking — retrofitting later means rewriting consumers.

   - **Check the bench cost before assuming "fast enough."** Filesystem walk at 5K pages is ~150ms cold / ~10ms warm. Cloud storage (R2/S3/Azure) walks at 5K pages project to 30–60s on real cloud (per `design-media-implementation.md`'s asset-refs measurement). Anything over the 5-second admin SLA at envelope is structurally wrong, not just slow.

   - **`design-scale.md`'s envelope is the gate, not a future goal.** Implementation cuts that say "we'll add a sidecar later if perf becomes a concern" violate this — the sidecar IS the perf design.

   - **Synthetic-site benchmarks are the gate.** When in doubt, run against `tests/_helpers/synthetic-site.ts`'s 5K-page generator (per `design-scale.md` Cut 1's perf-regression CI work).

   Why: the asset-refs sidecar grilling that locked per-edge files (`design-media-implementation.md`) was driven precisely by the 5K-page measurement (walk-on-demand at 5K = ~30s on cloud, sidecar = ~5ms). Same logic generalizes: every cross-cutting check needs a sidecar OR an explicit declaration that the walk cost is acceptable at envelope.

   Example (Cut 5 of soft-delete): purge-blocked check needs "any archive aliasing this name." Walking 5K manifests = bad; per-edge `.gazetta/alias-targets/{target}/{archive}` sidecar = `readDir`-fast. Pattern consistent with existing `asset-refs` and `fragment-deps`.

25. **Grill design docs the same as code — never lock a Q without enumerated rejected alternatives.** `[local]` "We discussed it" isn't a justification; "we walked the alternatives and rejected each for documented reasons" is. When a design lock has only one option enumerated, that's a smell — re-grill before shipping.

   **How to apply:** before writing a Q's lock paragraph, list at least 2-3 alternatives. For each rejection, name the specific failure mode that disqualifies it. If only one option survives the walk, ask honestly: "did I actually evaluate alternatives or take the path of least resistance?" If the latter, re-grill.

   **Why:** design docs become enforced contracts that shape every downstream cut. Locks that were never grilled compound — Cut N starts implementing, hits the unjustified lock as a constraint, has to either work around it (creating inconsistency) or rip it out (creating churn). Re-grilling at lock time is cheap; rip-out at impl time isn't.

   Example: `design-soft-delete.md` Q10 originally locked HTML-marker-for-static + per-edge-sidecar-for-ESI as a dual mechanism. The second mechanism was speculative — both worked for both target types. Caught during Cut 3 implementation when the user asked "why two mechanisms?" Reframed to one. Cost: one commit updating the doc + impl. Avoidable cost: zero rework if the original Q10 grilling had enumerated "HTML-marker-everywhere" as an alternative.

26. **Default to test-isolation paranoia.** Every new test file: per-test fresh storage / fresh tempdir; module-level constants reviewed; no implicit sharing. Vitest's default serial-within-file mode is a soft guarantee, not a contract.

   **How to apply:** before writing the first test in a new file, write down the answer to:
   - What state is module-level vs per-test?
   - Two tests in this file run sequentially today — would they break if vitest ever ran them in parallel?
   - Two test files importing the same helper — do they share filesystem paths via `Date.now()` collision?

   When in doubt, prefer per-test fresh resources (memory storage, per-test tempdir suffix) over module-level constants. The cost is one extra setup line per test; the benefit is robustness against future vitest config changes.

   **Why:** flaky tests born from shared state are diagnosed late and expensively. The pre-existing pattern in `publish.test.ts` (`tempDir(name + Date.now())` at module scope, `beforeEach` recreate, `afterEach` rm-rf) is safe under serial-within-file but would fail under parallel-within-file. New test files inherit that fragility unless the author thinks about it explicitly.

   Example: Cut 3 archive publish tests — 5 of 7 use fresh `memoryStorage()` per test (clean isolation), 2 use module-level filesystem `tempDir`. Both safe under current vitest mode; the latter would need per-test suffixes to survive future parallelism.

   **Operational rule:** the storage-tier choice (memory by default, fs only for binary I/O / hash-in-path / watcher / starter smoke) lives in [`testing-plan.md`'s "Storage tier" section](testing-plan.md). This rule is the principle; that section is the rule.

27. **Label assertion provenance.** When stating UX, design, or workflow opinions, prefix with the source: "intuition," "training-data pattern match," "verified against [specific doc]," "verified against [user research]." Without the label, an opinion reads as authoritative when it might be a guess.

   **How to apply:** before writing "I think X should..." or "the right pattern is...":
   - If asserting from intuition or generic pattern memory, say so: "Intuition (un-verified): the publish dialog should gain a Schedule tab."
   - If asserting from a specific doc, cite it: "Per `design-soft-delete.md` Q10: ...".
   - If asserting from user research, name it: "Verified against the May 2026 CMS audit: ..."
   - If you don't know whether you have data or intuition, **stop and figure that out before asserting**.

   **Why:** unlabeled opinions accumulate as facts. A reader (including future-me) treats a confident statement as researched unless told otherwise; the cost of mistaking intuition for data is downstream rework when the intuition turns out wrong.

   Example: `design-scheduling.md` Q6 (admin UX) — drafted detailed surfaces (publish dialog tab, archive modal option, visibility metadata, schedule chip, dashboard) based on intuition + training-data pattern matching. Asked "are you satisfied with UX research?" Honest answer was no. Re-locked Q6 to commit only structural decisions ("publish dialog gains schedule capability") and explicitly defer detailed UX to a focused research pass. The relabel was the fix.

28. **Every feature follows the four-phase + retrospective discipline.** `[local]` Per [`feature-design-process.md`](feature-design-process.md): Discovery → UX-grilling → 5K-envelope gate → Implementation-grilling → Design → Implementation → Retrospective. The grilling step splits in two: UX surface gets its own pass before implementation grilling, with a 5K-envelope gate between them.

   **Why split UX from implementation grilling:** UX choices made inside implementation grilling get compromised by implementation convenience. Same lesson as `design-scheduling.md` Q6 — when UX is implicit inside the design Qs, intuition fills the gap. Separate UX-grilling forces explicit time on the user-facing surface.

   **Why the 5K-envelope gate sits between them:** per rule 24, every primitive must hold at envelope. Catching scale issues in implementation-grilling (before lock) is cheap; catching them mid-cut means rework. The gate is a forcing function: name the cross-cutting checks the UX requires, identify their walk costs, decide whether sidecars are needed — then proceed to implementation Qs.

   **Why the retrospective:** patterns that worked but weren't named die. The session that produced rules 24-27 was retrospective in shape; without locking them durably they would have died with the conversation. Run retrospectives after feature ships, at significant milestones, when sessions end with multiple "we should remember X" observations, or when the user asks "what did we learn?"

   **How to apply mid-feature:** when starting any new feature (or significant feature milestone), open with phase 1 (Discovery), then 2a (UX-grilling — actor scenarios + user flows + Krug-lens removal), then 2b (5K-envelope gate — name primitives + walk costs + sidecar requirements), then 2c (Implementation-grilling). Land the design doc with all three grilling outputs reflected. After implementation completes, run phase 5 (Retrospective) and produce durable artifacts (new rules, doc updates, ADRs).

   Example: this rule itself is the retrospective output of the soft-delete session. The session produced rules 24-27 the same way: caught patterns mid-implementation, locked them durably so future features inherit the awareness.

29. **`data-testid` is part of every UI cut's definition of done.** Modals, banners, pickers, and any new interactive component land with `data-testid` attributes during the UI cut that creates them — not deferred to the e2e cut that needs them. Extends rule 3 ("Use data-testid attributes for Playwright selectors").

   **Why:** every modal/dialog without testids creates an opportunity for the next person to add one inconsistently. The e2e cut (typically the final cut of a sequence) becomes a junkyard of "Boy Scout" testid additions across components from many earlier cuts; each addition risks naming-convention drift, and review burden goes up because the e2e PR touches files outside its conceptual scope.

   **How to apply:** before marking a UI cut complete, grep the new component(s) for `data-testid=` and confirm every interactive element (modal root, primary action button, secondary action button, every input field used by tests) has one. Naming convention: `{feature}-{action}` for buttons (`archive-confirm`, `purge-cancel`); `{feature}-modal` for modal roots; `{feature}-{field}-input` for inputs.

   Example: soft-delete Cut 10 shipped ArchiveModal with no testids; Cut 15's e2e couldn't be written without adding 4 testids as Boy Scout fixes. Better path: Cut 10 lands with testids alongside the modal markup, Cut 15's e2e is pure scenario-writing.

30. **Forward-compat changes touch every projection layer.** When adding a field for a future foundation (e.g., a future-version `reviewState` ahead of review-workflow shipping), trace the field's path through every layer it traverses: storage → parser → typed manifest → route handler → response → audit / cache / sidecar. Skipping any layer means the field is invisible at runtime even though the unit-level contract works.

   **Why:** layered projections (whitelist parsers, type narrowing, audit-event shapes, cache-key encoders) each commit to "fields I know about." A new field invisible to one of them is silently dropped at that layer; downstream consumers see `undefined` and the gate that should activate stays inert. Unit tests of the helper pass; integration tests fail.

   **How to apply:** when introducing a field for forward-compat (no current consumer), enumerate the layers explicitly:
   - Manifest parser (`parseXManifest` whitelist) — does the field round-trip through the whitelist?
   - Save handler — does the field survive the save → re-load cycle?
   - Audit shape — does the field appear in audit metadata if relevant?
   - Cache key — does the field affect cache invalidation?
   - Sidecar shape — does the field affect any per-edge sidecar?

   Land a route-level integration test that exercises the full save → read chain; unit-level helper tests aren't sufficient.

   Example: soft-delete Cut 14's `reviewState` field — the helper functions (`buildAutoWithdrawEvent`, `archiveReviewMetadata`) had passing unit tests, but the route-level integration tests failed because `parsePageManifest` whitelisted fields and dropped `reviewState`. Required adding `parseReviewFields` passthrough alongside `parseArchiveFields`. The integration test caught the gap; without it, the forward-compat code would have been silently dead until review-workflow shipped.

   **Symmetric pattern — when RETIRING an artifact, audit each contract it carried.** Same projection-layer principle, reversed direction. When deleting or replacing a document / module / mechanism, list every distinct requirement the old artifact carried; promote each to its new home explicitly. Don't assume the replacement covers them implicitly — it usually doesn't.

   Example: ADR-0015 retired the `design-{feature}-implementation.md` artifact. The old impl doc carried at least 5 distinct contracts: cut-by-cut status tracking, per-cut SOLID checks, per-cut Tests enumeration, deferred-items list, lessons-learned. Cut 5's first commit replaced Phase 4 of `feature-design-process.md` with the new tracking-issue + sub-issue model and preserved cut tracking (via GitHub state) + deferred items (via Cut 7's consolidation), but **silently dropped the per-cut SOLID + Tests requirement.** Caught at PR review by the maintainer asking "do we still have SOLID check and other requirements for cuts?" Closed via commit `ac77dc3` adding the sub-issue body convention (`## SOLID`, `## Tests` sections). The discipline that would have caught this at design time: when shipping the retirement, enumerate the artifact's contracts and confirm each one's new home BEFORE merging.

31. **TDD-first ordering when delegating to AI agents.** When asking Claude (or any agent) to add or fix behavior in a non-trivial module, write the test first in its own commit, confirm it fails, then ask the agent to implement. Tell the agent explicitly "do not modify the failing tests" — agents will otherwise weaken assertions to make red turn green.

   **Why:** the dominant failure mode of AI-generated tests is **tautological assertions** — the agent writes implementation first, observes the output, then writes tests that assert on the observed output. The test passes; it proves nothing. ThoughtWorks Tech Radar (Vol 34, "AI-aided test-first development") and Anthropic's own engineering posture converge on TDD ordering as the single highest-leverage correctness pattern with AI. Industry-cited mutation scores on LLM-generated tests written-after-implementation hover around 20% — meaning ~80% of injected faults survive the test suite.

   **How to apply:**
   - For pure-logic changes (renderer, sidecars, manifest parser, hash, validators, hook dispatch): write the failing test in commit N, the implementation in commit N+1. Commit message on N: `failing test: <behavior>`. Both commits land in the same PR.
   - For UI-only changes (CSS, layout, copy): TDD ordering doesn't apply; ship the change with a Vue Test Utils or Playwright test alongside per [team-preferences rule 4](team-preferences.md).
   - **Default test tier matches the sub-system's shape** (per [`testing-plan.md`](testing-plan.md) "Shape per sub-system"): pyramid sub-systems (core: renderer, hash, sidecars, parsers) → unit-first; trophy / honeycomb sub-systems (admin-API surface, validators, hooks, audit, auth) → API-first via `app.request()` against `createAdminApp()` or a route-mounted Hono. Deviate only when the SUT is genuinely cross-tier (e.g. behavior that spans a CLI command, a route, AND an internal helper — pick the highest tier that exercises all three). API-first is the highest-leverage default with AI agents because route + audit + sidecar assertions are hardest to fake-pass.
   - When the agent says "tests pass," verify yourself per [Simon Willison's reviewer-time-as-burden discipline](https://simonwillison.net/2025/Dec/18/code-proven-to-work/) — run the suite locally, confirm the relevant test fails when the implementation commit is reverted.
   - If the agent edits the failing tests during implementation, that's a structural correction (not a patch): revert, re-prompt with "the tests you committed in <sha> are the spec; do not modify them."

   **Skip when:**
   - Trivial one-liners (typo, comment fix, dependency bump) — TDD ordering is overhead.
   - Investigative work where the spec emerges from exploration. In that case, capture the discovered spec in tests at the end and treat the impl commit as throwaway.

   **Pairs with:**
   - [`tdd` skill](~/.claude/skills/tdd/) — the existing red-green-refactor harness; this rule makes its use the default rather than opt-in.
   - Mutation testing nightly (StrykerJS, already shipped per [`testing-plan.md`](testing-plan.md)) catches the residual tautological tests that slip through TDD ordering.

   Example: validation Cut 1's save-delta orchestrator — failing test landed first (`save returns 409 with the introduced ref's issue, not pre-existing issues`), then the diff implementation. Reverting the implementation re-fails the test; the TDD ordering proved the diff logic was load-bearing, not vestigial. Without the ordering, the agent would have written `expect(response.status).toBeOneOf([200, 409])` — passing whether or not the diff worked.

32. **Read all failures before editing; iterate on a single file via vitest watch mode.** Two complementary patterns for the test-error inner loop:

   **Pattern A — when a single run produces N independent failures, fix all N in one edit pass before rerunning.** Common case in API/contract work: different routes, different validator surfaces, different return shapes — each failure has its own root cause, none caused by another. Sequential single-fix-per-run is a heuristic for *coupled* changes (where the second failure might be caused by the first fix). Applied to independent contract mismatches, it just multiplies run cost by N. Reading two types and editing two call sites in one pass is the same cognitive cost as four serialized read-then-edit-then-rerun cycles, but one test run instead of four.

   **Pattern B — when iterating on a single test file (refining assertions, narrowing a flake, exploring a behavior), use `vitest` (watch mode), not `vitest run`.** Each subsequent edit reruns the changed file in ~10-50ms instead of paying the ~400ms-1.2s cold-start tax per `vitest run` invocation. Background it via `Bash run_in_background` if conversational visibility matters; otherwise run inline and read output between edits.

   **When NOT to apply A:** when failures are genuinely coupled (a state-machine transition test where fixing the first transition might cascade into the second). Read the failure messages and judge — if each failure names a different file/route/type, they're independent.

   **When NOT to apply B:** one-shot verification ("did my fix work?") — `vitest run path/to/file.test.ts` is fine; the cold-start tax pays once. Watch mode earns its keep on the third-or-later invocation against the same file.

   **Why:** the iterate-on-test loop is one of the highest-frequency activities in any session. A 3-failure sequence costs 4× a 1-pass fix; a 5-edit watch loop costs 1× the watch startup vs 5× the run cold-start. Both compound across sessions.

   Example: cross-foundation gap #3 produced 3 independent surface failures at once (validator scope shape wrong, publish/audit body shape wrong, consistency check cascading from #4). I fixed them sequentially across 3 runs (~3.6s total). Pattern A would have fixed all 3 in one edit pass and one rerun (~1.2s) — same diagnostic effort, one-third the runs.

33. **Never commit directly to `main`. Every change goes through a PR.** Even one-line doc fixes. Even when admin privileges allow `git push` to bypass branch protection. The protection rule is the workflow; respecting it is non-negotiable.

   **How to apply:**
   - Before the first edit of any change destined for main, `git checkout -b <branch>`. Branch naming: `<kind>/<slug>` (`docs/...`, `fix/...`, `feat/...`, `test/...`, `chore/...`).
   - Commit and push the branch; open a PR via `gh pr create`.
   - Wait for CI green; merge with `gh pr merge --rebase --delete-branch` (per rule 16).
   - If branch protection blocks merge (1-approval required) and admin bypass is needed, ask the user explicitly per-PR. Default is to wait for review.
   - A PR that locks or changes a design decision waits for the maintainer's review even when it's docs-only, and even under a standing merge permission. The doc-only fast path (no CI wait) applies once it's approved. #963 was self-merged with decisions the maintainer hadn't seen; #966 replaced its core the same day.

   **Commit grouping inside a PR.** A PR can carry multiple commits — one PR ≠ one commit. Group commits into one PR when they share a theme or land in the same workflow pass; keep them as separate commits inside the PR for revertability and reviewability. Examples:
   - 7 cross-foundation gap fixes → one PR (`cross-foundation-tests`), seven commits
   - MCP wiring + CLAUDE.md command expansion + rule 32 → one PR, three commits (related session-pass output)
   - Pure docs typo + unrelated bug fix → two PRs (different concerns; reviewers shouldn't context-switch mid-PR)

   The grouping test: would a reviewer naturally evaluate these commits together, or are they independent enough that one being rejected shouldn't block the other? Together → one PR. Independent → separate PRs.

   **Why:** branch protection encodes team policy at the repo level. Bypassing it because a change is "just docs" or "obviously safe" is the same shape as rule 31's anti-pattern of weakening a failing test because the assertion is "obvious." The rule is the rule. Workflow respect is a forcing function for thinking before merging — even small commits get one CI pass + one read-through before they touch main, which catches typos / accidental file additions / test breakage that "I'll just push it" would miss.

   **Why this rule earns a number despite seeming obvious:** it failed twice in one session (commits `1a2493c` and `b332826` straight to main). Slippage was driven by "this change is small enough to not need ceremony" reasoning. Capturing it as a numbered preference makes the default explicit: every commit, every time, branch + PR.

   **The only exceptions** are operations where main IS the working tree by design — none currently exist in this project. If one ever does, document it explicitly here.

34. **Know the GitHub Actions trigger gotchas.** Four sharp edges that cost real time when missed; each has a one-line workaround once you know the cause.

   **(a) `pull_request:` defaults exclude `ready_for_review`.** Default activity types are `[opened, synchronize, reopened]` only. A draft flipped to ready does NOT fire CI without explicit `types: [opened, synchronize, reopened, ready_for_review]` in the workflow's trigger. Fix-bot opens PRs as drafts; without this, every flip-to-ready leaves CI silent until a subsequent push fires `synchronize`. ([docs](https://docs.github.com/en/actions/using-workflows/events-that-trigger-workflows))

   **(b) `GITHUB_TOKEN` triggers no downstream workflows.** Per [GitHub's anti-recursion safety](https://docs.github.com/en/actions/using-workflows/triggering-a-workflow): "events triggered by the `GITHUB_TOKEN` will not create a new workflow run." Applies to ALL event types — `opened`, `synchronize`, `reopened`, `ready_for_review`. Affects every bot that opens PRs or pushes commits using the default Actions token (fix-bot, triage-bot, flake-watcher). Workarounds: user account close+reopen (bot's own close+reopen stays suppressed), `workflow_dispatch`/`repository_dispatch` (the documented escape hatches), or switch the bot to a GitHub App installation token / PAT (the permanent fix — tracked in #336).

   **(c) Cancelled-run jobs show up alongside the current run in `gh pr checks`.** After a force-push, the older run gets cancelled by the concurrency rule (`cancel-in-progress`). Its `pack`-needing jobs (`smoke`, etc.) get marked `fail` because their `needs:` dependency was cancelled mid-flight — not because of a test failure. `gh pr checks <N>` lists both runs together with no separator. Aggregate scripts ("are all checks green?") will misclassify. Filter by `runId`:
   ```bash
   gh pr view <N> --json statusCheckRollup --jq '.statusCheckRollup
     | group_by(.detailsUrl | capture("runs/(?<id>[0-9]+)").id)'
   ```
   The highest `runId` is the current run; verify all of its jobs show `SUCCESS` before drawing conclusions.

   **(d) `git rebase` auto-drops cherry-pick equivalents.** When a stacked PR's parent merges, rebasing the child onto fresh main makes git skip the parent's commits via patch-id detection (`warning: skipped previously applied commit XXX`). No interactive rebase needed; no manual `git drop`. The opposite — `--reapply-cherry-picks` — preserves them, but the default is what you want for stacked-PR cleanup. Reference example: today's #325 → #326 → #327 chain cleaned up with three plain `git rebase origin/main` calls.

   **(e) Monitor commands polling `gh pr checks` must filter to the newest run of each workflow.** Operational discipline that flows from (c). When watching a PR's CI completion with a poll loop, a bare `gh pr checks <N> --json name,bucket` query returns checks across ALL runs — cancelled + current + everything. The naïve "all non-pending" exit condition (`all(.bucket != "pending")`) evaluates true the moment the older cancelled run's jobs settle, even though the current run still has 10 pending jobs. Monitor exits early; you miss the actual completion.

   Filtering to the newest run *overall* isn't enough, because each workflow has its own run ID. A PR here runs CI (16 checks) plus `actionlint` and `zizmor` (one check each), and on #981 the highest run ID was zizmor's. A loop filtered to it stops when zizmor finishes, while CI is still running. If it also expects CI's job count, it never stops: the #973 and #981 watchers waited for more than 10 checks and ran until stopped by hand.

   The fix: keep the newest run of each workflow before evaluating completion:

   ```bash
   while true; do
     s=$(gh pr checks <N> --json name,workflow,bucket,link)
     # Per workflow, keep only the jobs of its newest run
     current=$(jq '[group_by(.workflow)[] | (map(.link | capture("runs/(?<id>[0-9]+)").id | tonumber) | max) as $rid | .[] | select(.link | contains("runs/\($rid)/"))]' <<<"$s")
     jq -e 'length > 0 and all(.bucket != "pending")' <<<"$current" >/dev/null && break
     sleep 30
   done
   ```

   Simpler alternative if you know the run ID up front: poll `gh run view <run-id> --json status,conclusion` instead. One run = no ambiguity.

   **This gotcha is rule-34(c)'s operational consequence**, not a separate failure mode. Captured separately because the discipline is enforced at Monitor-command-write time, not at result-inspection time.

   **(f) `close + reopen` re-runs CI against the STALE branch — only a rebase pulls in a merged main-fix.** When you fix something on `main` and need the open PRs to pick it up, re-triggering their CI (close+reopen, empty commit, etc.) does NOT help: CI runs against each PR's own branch, which still predates the fix. The tell is a PR that keeps failing on the *exact thing main just fixed*. The fix is per-PR `git checkout -B <br> origin/<br> && git rebase origin/main && git push --force-with-lease`. Under strict-up-to-date branch protection (`required_status_checks.strict: true`) the rebase is mandatory before merge anyway — so propagate the main-fix by rebasing, not by re-triggering. (Saga of #823: after merging the docker fix I close+reopened 10 blocked PRs; #815 kept failing on the old quay tag because its branch never received the fix — rebasing each branch was the actual propagation step.)

   **Why this rule earns a number:** today's `/review-prs` session lost ~30 minutes across cycles of "why isn't CI firing?" (a + b), "did the test really fail?" (c), and "how do I unstack this?" (d). Subsection (e) cost ~5 minutes more in the feature-bot-validation session — Monitor exited early TWICE on the same PR because the poll didn't filter by runId. Subsection (f) cost most of a `/review-prs` pass in the #823 docker saga — 10 blocked PRs were close+reopened instead of rebased, so they kept re-running against stale branches that lacked the just-merged fix. Each gotcha is documented somewhere in GitHub's docs but the docs don't surface them together; you only discover them via the failure mode. Centralizing them here means the next session reads one rule instead of rediscovering six.

35. **Flake fixes that pass CI on the first run are not proven.** Rule 31's "verify by reverting and confirming the test fails" doesn't catch race conditions — the race doesn't reproduce locally on demand, and a single green CI run is consistent with the flake simply not firing this time. Before merging a flake-fix PR, verify durability under shard-load conditions:

   ```bash
   npx playwright test --project=dev --shard=<N>/7 <spec-file> --repeat-each=5
   ```

   5 consecutive passes on the affected shard = durable fix. Less than 5 = still flaky; the hypothesis was wrong or the fix is incomplete. Run on CI (where the flake originally surfaced), not locally — local hardware often masks races that only appear under CI's resource constraints.

   **Why:** PR #325 added a double-`requestAnimationFrame` gate to ostensibly fix `component-ops.spec.ts:84` (#288). The PR passed CI on its first run; the issue auto-closed. Within hours #288's same failure recurred verbatim on an unrelated PR (#335) — the gate didn't actually close the race. Costs: stale "closed" issue tracking real flake; reviewer time on the recurrence; fix-bot will now re-attempt with possibly the same hypothesis. A `--repeat-each=5` shard run on #325's branch before merge would have surfaced the hole.

   **How to apply:**
   - Mandatory for any PR whose title / body claims to fix a `flake`-labeled issue
   - The PR description must include the `--repeat-each=N` command run and its result count ("5/5 pass on shard 1 = durable")
   - Single-run green CI alone is NOT acceptable evidence to merge a flake fix
   - When the hypothesis turns out wrong (recurrence within a week), reopen the issue with the recurrence evidence and the next hypothesis — don't silently re-attempt without acknowledging the prior failure

36. **Check the model before iterating the prompt.** When an autonomous agent fails on what feels like a "smart enough" task — autocompact thrash, re-reading the same file, "I can't fit this" self-diagnoses — check what model it's running on BEFORE blaming the prompt or the architecture. The Claude Code CLI's default (`claude` without `--model`) is `claude-sonnet-4-6` with a 200K context window; long-context tasks need Opus 4.7's 1M window via the explicit `claude-opus-4-7[1m]` model ID (the bare `opus` alias resolves to 4.6, still 200K).

   **How to apply:** when a bot fails, the first diagnostic question is "what's in the `system.init` event's `model` field of the transcript?" If it's not the model you expect, that's the bug — fix it via `--model` before touching anything else. Per-bot model override is a one-line change in `bots/_lib/claude.ts`; the default is Opus 4.7 [1m] for all bots per [`design-bots.md`](../../bots/README.md).

   **Why:** the mutation-watcher and fix-bot iterations from May 2026 spent meaningful time refactoring prompts (parse-in-prompt → parse-in-TS, source pre-loading, prompt-rewrite for variable body shapes) when the load-bearing constraint was Sonnet 4.6's 200K window. Once Opus 4.7 [1m] landed (PR #314), the autocompact failures stopped — and the pre-load infrastructure we'd built to work around the 200K window became unnecessary, so we reverted it (PR #318). Net: ~150 LOC of speculative work, plus ~3 hours of debugging, that all evaporated when we flipped the model flag.

   **Pairs with rule 37 (don't stack fixes for the same failure mode):** model upgrades subsume most "Claude is running out of room" prompt-engineering. Try the cheap structural fix before the elaborate defensive one.

37. **When two fixes target the same failure mode, question whether both pay rent.** Premature optimization is fixing what's not broken; speculative defense is fixing what just got fixed differently. Both burn time and add code that has to be maintained forever. The signal is when a defensive fix (adding a code path, adding fallbacks, adding a parser) lands in the same window as a structural fix (changing a config flag, upgrading a model, switching an architecture). Ask: "does the defensive one still pay rent after the structural one lands?"

   **How to apply:** when shipping or reviewing a fix-on-top-of-a-fix, write down what failure mode each one addresses. If they're the same failure mode, the structural one usually wins and the defensive one should be reverted before it ossifies. Don't merge both as "belt and suspenders" — that's how complexity compounds.

   **Why:** PR #316 added a source-file pre-load to fix-bot specifically to address autocompact thrash on 22.7KB source files. It was motivated by a real bug. But PR #314 (shipped the same day) upgraded the model to Opus 4.7 [1m] — 5× the context window — which addressed the same failure mode structurally. We shipped both; the pre-load had to be reverted in PR #318 ten hours later after the user flagged "looks too complex." Cost: 150 LOC + ~1.5 hours building + the revert PR + the cognitive overhead of "what does this defensive code path do?" for anyone reading the code in the meantime.

   **Distinct from premature optimization** (rule against fixing what's not broken): the defensive fix WAS motivated by a real bug. The lesson is timing — when a structural fix lands in the same window, the defensive one becomes load-bearing-for-a-day and dead-code-thereafter. Either ship the structural one first and observe whether the defensive one is still needed, or pair them as "structural primary, defensive as fallback" with a deletion plan if the structural holds.

38. **When fixing a pattern bug in one bot, audit symmetric bots in the same PR.** Bots share architectural patterns (skip-list memory, reviewer loops, escalation paths). When a bug surfaces in one — and the same shape exists in a sibling bot — fix both in one PR. A "we'll get to the other one later" gap silently rots until production catches it.

   **How to apply:** before merging a bot-specific bug fix, ask "does this pattern exist in any sibling bot?" Search by grep for the symptom (e.g. `recordSkipListEntry` without an accompanying PR push), not just the bot's name. If the sibling has the same hole, extend the PR; don't open a follow-up "track for later" issue that will sit for weeks.

   **Why:** PR #384 (2026-05-14) fixed dead-code-watcher's SKIP-path bug: the orchestrator was writing skip-list entries to runner-local fs but never opening a PR to land them on main. Added `openAgentASkipPR` helper. fix-bot had the identical pattern — `recordSkipListEntry` wrote locally with no follow-up PR — and was not touched.

   Cost surfaced 2026-05-29: issues #414 and #415 (filed May 22) sat silent for 6 days. Fix-bot's reviewer loop ran ~28 minutes of compute on May 23, produced substantive verdicts (verified by reading transcripts after the fact), recorded skip-list entries that evaporated when the runner shut down. Every subsequent cron saw the `fix-bot-attempted` label and exited in 2 seconds without explaining anything. Maintainer had no visible signal until grepping workflow logs by hand.

   The cost wasn't just the 6 days of confusion — it was the lost ~$10 of Claude API work whose conclusions are only retrievable via transcript archaeology. Symmetric-bot audit on PR #384 day would have caught this in 10 minutes.

   **Pairs with rule 18 (build structurally right from the start):** if a pattern needs an escalation path in one bot, assume it needs the same path in every bot sharing the pattern. Cargo-cult the helper into siblings preemptively when its absence would be a silent-failure mode.

39. **Self-audit before claiming confidence.** When you've recommended a structural choice without enumerating the alternatives walked, the recommendation is at-risk. Before stating "confident" or "ready to ship," check: did I list 2-3 alternatives? Did I name the specific failure mode that disqualifies each rejected option? If only one option survives the walk, ask honestly: "did I evaluate alternatives or take the path of least resistance?"

   **Where this fires:**
   - Design grilling (per rule 25): every Q's lock must enumerate rejected alternatives.
   - Mid-implementation recommendations: when you say "I'll pick X" or "let's go with X," name the Y and Z you rejected.
   - "Confident" claims: the maintainer-side prompt "are you confident?" earns a permanent place in your self-audit. The right answer is "yes, because I walked these 3 alternatives and X wins on these axes" — NOT just "yes."
   - Mid-session re-grilling: when the user prompts "look from all POV," that IS the audit. Don't recommend without doing it.

   **Signal that the rule is being violated:** a recommendation states only what was picked, not what was rejected. Or a "confident" answer doesn't survive a second "are you confident?" prompt. Both are the same shape: locking without grilling.

   **Why:** AI agents (Claude included) are pattern-matchers, not deliberators by default. The "calibrated confidence" research from Anthropic + the broader LLM-evaluation literature converges on this: confidence without enumerated alternatives is rationalization, not analysis. Capturing the discipline as a numbered preference makes it explicit instead of implicit, and rule-39 citations in design docs / PR review comments create a forcing function.

   **Example — this session's pendulum.** During the design grilling for feature-bot's cut sub-issue body format (Q2), I flipped 5 times across consecutive turns: A → G → C → D → F → D. Each individual flip was reasoned, but the trajectory was lossy. The maintainer asked "are you confident?" twice; I downgraded my answer the second time and caught a real hole (un-fact-checked claim about front-matter YAML being conventional in GitHub issue bodies). The discipline that would have prevented the pendulum: each recommendation explicitly lists alternatives + their failure modes BEFORE locking. Cited in commit message when the rule lands.

   **Pairs with rule 25 (grill design docs the same as code — never lock a Q without enumerated rejected alternatives):** rule 25 is the design-time discipline; rule 39 is its operational consequence across the full session (design + implementation + review + retrospective phases). Same shape; broader scope.

   **Pairs with rule 27 (label assertion provenance):** un-graded confidence and un-labeled assertions are the same failure mode — claims without grounding. Rule 27 makes you cite the source ("verified against X"); rule 39 makes you cite the alternatives walked. Together: a recommendation reads as "I chose A over B, C because [failure modes]; A is grounded in [source]."

40. **Route bot tasks by task shape, not by `bug`/`enhancement` label.** `[local]` Fix-bot handles **one-shot atomic tasks** — no sequencing, no design doc, single PR. Feature-bot handles **sequenced cuts of a designed feature** — depends on prior cuts, follows `design-{feature}.md`, lives under a tracking issue with a `**Feature**:` front-matter field on the sub-issue.

   The labels (`bug + ready-for-agent` vs `enhancement + ready-for-agent`) are a forwarding mechanism, not the load-bearing axis. The load-bearing axis is task shape:
   - **One-shot** (refactor, hygiene, SOLID/DRY violation, rule-15 extraction trigger, missing-test backfill, small enhancement without design doc) → `bug + ready-for-agent` → fix-bot
   - **Cut of designed feature** (references a `design-{feature}.md`, depends on other cuts, part of a tracking issue) → `enhancement + ready-for-agent` → feature-bot

   **Why:** SOLID/DRY violations, missing tests per rule 4, format violations per rule 30 are "bugs" in the rule-contract sense even though they read like enhancements. The codebase being out of compliance with a team-preferences rule IS the bug; the fix is restoring compliance. Fix-bot's TDD-first contract still applies — the "failing test" pins a structural contract (e.g., "exactly one `lookupManifest` definition exists" + "the three route files import from it") instead of a behavior contract.

   **How to apply:**
   - When triaging a new `ready-for-agent` issue, ask: "is this a cut of a designed feature, or one-shot?" One-shot → `bug` label. Cut → `enhancement` label + must reference a design doc via `**Feature**:` front-matter, and must live under a tracking issue.
   - When relabeling an issue between the two queues, the relabel itself is the routing decision — don't implement directly to bypass the question.
   - Mistakes are correctable: relabel, the cron picks up the new queue next run.

   **Why this rule earns a number:** issue #463 (extract triplicated `lookupManifest` after #461 crossed rule 15's 3-caller threshold) initially landed as `enhancement` and got routed to feature-bot — where it stalled because feature-bot's parser rejects bodies without `**Feature**:`. The implicit rule (`enhancement` → feature-bot, `bug` → fix-bot) treated the labels as primary. The actual primary is task shape; the labels exist to forward to the right bot.

   **Pairs with rule 31 (TDD-first when delegating):** structural tests (assert N copies of X exist before fix, 1 copy after) are a legitimate TDD shape for non-behavior cuts. The TDD contract is "the test fails when the impl is reverted" — that holds for structural assertions, not just behavior assertions.

41. **Proof-of-work tests for one-shot structural cuts get pruned after the bot validates the cut — "the compiler can't catch it" is necessary but not sufficient to keep one.** A file-content test (reads a `src/` file as text, regex-matches the source) that pins "the extraction happened" / "no inline copy remains" has done its job once the diff is on main. The production diff IS the proof the refactor happened; the bot's 4-step revert+rerun already validated the cut. Re-asserting it on every CI run via a brittle string match (blind to renames, arrow-fn rewrites, reformatting) is proof-of-work redundancy.

   **The real test, not the skill's old phrasing:** the review-prs skill said "keep file-content tests that pin something the compiler can't catch; drop ones the current state already proves." That's too permissive — it kept tests that merely *could* drift in theory. The sharper question: **after the diff is on main, can this invariant drift through a NATURAL edit, or only through a deliberate, against-the-grain re-introduction?**
   - Rule-15 extraction ("no shadow copy of `lookupManifest`") → only drifts if someone deliberately re-adds a local function that shadows the import they also kept. Nobody does that by accident. **Prune.**
   - "No deprecated `oldApi()` calls remain" / "no `console.log` in production code" → drifts naturally every time someone adds a call without thinking. **Keep** (or better, make it a lint rule).

   The distinction is drift PROBABILITY through normal work, not drift POSSIBILITY in principle.

   **How to apply:** when reviewing a bot's `Mode: structural` PR, for each file-content `it()` block ask "would a lint rule or the compiler be the right home for this, and is the drift it guards against something a developer would do without noticing?" If the answer is "a developer would never accidentally do this" → prune the block, keep the behavior tests (which exercise the real symbol and catch real regressions). If it's genuinely drift-prone, file a follow-up to replace the regex-over-source assertion with an ESLint `no-restricted-syntax` rule — string-matching source text enforces the *spelling*, not the *invariant*.

   **Why this rule earns a number:** in the 2026-05-31 `/review-prs` session on PR #474 (fix-bot's `lookupManifest` extraction), I applied the skill's "keep compiler-invisible invariants" rule mechanically and concluded "nothing to prune." The maintainer pushed back twice — "why would we need them" then "the cut was already validated by the bot, why not clean up" — and was right both times. The file-content block was pure proof-of-work; the two behavior tests were the load-bearing contract. An AI-authored rule (I wrote the skill's pruning section in commit `7be6504`) had a blind spot a maintainer corrected on the same day. That's the rule-39 "self-audit before confidence" failure mode in the wild.

   **Pairs with rule 39 (self-audit before confidence):** "nothing to prune" is a confidence claim. Before asserting it, walk each candidate against the drift-probability test above, not just the drift-possibility test. **Pairs with rule 37 (don't keep a fix after its motivation evaporates):** the proof-of-work test's motivation (be red-before-green) evaporates the moment the cut is validated; the test outlives its reason the same way a defensive fix outlives a structural one.

42. **On a bot-authored PR, prefer an additive commit on top over amending/rebasing the bot's commits.** When the maintainer asks for a change to a bot's PR (prune a test, fix a residue, tweak a comment), default to a new commit on top of the bot's untouched commits — NOT an interactive-rebase-and-amend of the bot's history. Additive leaves the bot's commits byte-identical, needs no force-push (a plain `git push` works, and the maintainer's account identity fires the `synchronize` CI event normally per rule 34b), and keeps the bot's transcript-referenced SHAs valid.

   **When amend/rebase IS warranted:** only when the change must live INSIDE one of the bot's commits for the TDD contract to hold — e.g. editing the failing-test commit so commit-1-fails-in-isolation still holds. That's the review-prs skill's three-gate destructive workflow. It's the exception, not the default.

   **The skill over-indexed on the destructive path.** review-prs documents an elaborate three-confirmation force-push-to-bot-branch workflow for pruning. That ceremony is correct for amending the bot's commits, but most maintainer-requested tweaks don't need it — an additive commit sidesteps the destructive-rebase concern entirely. Reach for the lighter tool first.

   **How to apply:** maintainer asks for a change to a bot PR → make the edit → commit it as a new commit on top → plain `git push`. Only if the change must be folded into a bot commit (TDD-contract reasons) do you checkout, edit, rebase-edit the test commit, run the 4-step tautology check, and force-push. If you START additive and later need to amend YOUR OWN commit (not the bot's), `--force-with-lease` is fine — you're rewriting your commit, not the bot's.

   **Why this rule earns a number:** same #474 session. I reflexively proposed the skill's full checkout → rebase-edit-the-test-commit → force-push workflow. The maintainer said "add another commit" — the simpler, non-destructive path that leaves fix-bot's two commits intact. I'd defaulted to the heavy tool because the skill foregrounds it.

43. **Verify platform/tooling behavior against sources or a live test before locking a design decision on it — don't reason from memory or assume.** When a design choice depends on how an external platform actually behaves — an API's auth model, where bytes physically land, merge/CDN/cache semantics, whether a URL renders inline, what an endpoint requires — confirm it against official docs, a verified source, or a throwaway live test *before* writing the decision into a doc/ADR/issue. Memory and plausible-reasoning are not evidence; they're the thing that gets corrected.

   **How to apply:**
   - Before asserting "X works / X doesn't / X requires Y" about a platform, ask: have I *verified* this, or am I pattern-matching? If unverified, label it (per rule 27) AND verify before locking.
   - For anything cheap to test live (does this URL render? does this endpoint accept a token? does deleting this actually remove it?), run the throwaway test — create-inspect-teardown — rather than trust a doc or a search result. Docs drift; search results are often stale or wrong.
   - Triangulate the load-bearing facts: official docs say one thing, a community tool's *requirements* (not its marketing) say another, a live probe says a third. The live probe wins.
   - When verifying a NEGATIVE ("X is gated / blocked / unavailable"), probe a known-good control in the same call. If the control also fails, your egress / tooling is the problem and the probe proves nothing about X. (Saga of #823: I read a real `401` on `minio/minio` as "my curl is being blocked" for two fix attempts; a `library/alpine → 200` control alongside would have shown the 401 was X's real gating, not noise.)
   - Record what was verified (and any caveat the test surfaced) in the durable artifact, so the next reader inherits evidence, not a fresh assumption.

   **Why this rule earns a number:** the 2026-06-07 feature-bot-candidate session re-decided the "how does the bot put screenshots in a PR" question ~5 times, each flip caused by *verifying* a prior claim and finding it wrong: (1) ADR-0016 first asserted "adopt Storybook" — Storybook was already installed (never checked the repo); (2) "browser-flow upload to user-attachments works token-only" — the tools that do it actually require a logged-in browser-cookie session, useless to a headless `GH_TOKEN` bot; (3) "feature-branch commit dies with the branch on merge" — the commits actually merge INTO `main`'s history under squash/rebase/merge (a correctness bug the maintainer caught, not me); (4) "release-asset URLs serve `image/png`" — they serve `application/octet-stream` + `attachment`, yet GitHub renders them inline anyway (only a live browser test revealed this); (5) "delete-asset is instant cleanup" — the signed CDN URL kept serving cached bytes for ~50 min. Each correction was cheap *because* it was caught at verify-time; each would have been an expensive shipped-wrong if the assertion had been trusted. Pairs with rule 27 (label assertion provenance — un-verified is a provenance state) and rule 39 (self-audit before confidence — "I'm confident X works" must mean "I verified X works").

44. **Don't pin an ephemeral image tag for "reproducibility" in a throwaway CI / test-container image — it rots into a time-bomb.** `.hotfix.*` / datestamp RELEASE tags get pruned by registries: a pinned digest that pulls today returns `unauthorized` / `manifest unknown` weeks later and red-gates `main` on every PR. A throwaway test container (testcontainers MinIO, Azurite, etc.) needs *a* working image, not a frozen version — reproducibility across runs isn't worth the time-bomb. Use `:latest`, or a stable non-ephemeral tag you've verified is durable.

   **Registry anonymous-pull policy drifts too.** A namespace that's public today can require auth tomorrow — `minio/minio` went gated on BOTH Docker Hub and quay.io across two weeks. So (a) re-verify anonymity when a pull starts failing rather than assuming "it worked before" (per rule 43's control-probe bullet), and (b) pre-pull / retry loops MUST echo the underlying command's stderr — `if err=$(docker pull "$image" 2>&1); then echo "$err"; …` — or a deterministic `unauthorized` hides for a cycle behind a generic "failed (attempt N/3)" and you waste a pass guessing.

   **Why this rule earns a number:** twice-learned. #481 — Docker Hub gated anonymous `minio/minio` pulls (fixed by moving to quay). #823 — the quay fix pinned a `.hotfix.*` RELEASE tag "for reproducibility"; the tag was pruned two weeks later, `unauthorized` red-gated the `admin` job on every open PR, and the masked retry loop hid the real cause for a full cycle. Two wrong fixes (re-pin, then `:latest` — quay had gated the whole namespace) preceded the real fix (`bitnamilegacy/minio`, a verified-public image). The saga cost most of a `/review-prs` pass; a durable image + echoed pull errors would have made it a one-commit fix.

45. **Read every file:line a change would touch — in this session — before proposing the change. Treat our own code as un-knowable-by-inference, exactly like an external API.** Rule 43 says verify *platform* behavior rather than reasoning from memory. The same discipline applies with equal force to **this repo's own code**, and that's the gap it doesn't cover: internal code *feels* knowable by inference (we designed it, the docs describe it, the naming is good), so the read gets skipped in a way nobody would skip reading an unfamiliar vendor API. A fix described without having read its target is a **hypothesis**, and must be labeled one.

   **How to apply:**
   - Before describing a fix, name the `file:line` it changes and confirm you've read that span in this session. If you can't, the proposal is a hypothesis — say so, then read.
   - **State the diff, not the direction.** "Fix the classification bug" is unfalsifiable and hides unread code; "add `detectTransientAuthError` in `claude.ts`, wire it into the `!aResult.success` guard at `index.ts:438`" is checkable — and only becomes sayable *after* reading.
   - **Check the proposal against evidence you already gathered.** If you just cited research, does your fix contradict it? (Quoting "blanket retry mostly re-burns budget" and then proposing a 5× retry is the failure mode.)
   - **Find the control group before theorizing about a cause.** For any "X causes the failures" claim, ask whether the *successes* also have X. If they do, X isn't the cause.
   - **Prefer widening a proven path over adding a parallel one.** Once you've read the surrounding code you can usually see the existing mechanism for the same category of problem; reusing it beats inventing a sibling (and avoids rule 37's stacked-fix trap).

   **Why this rule earns a number:** the 2026-10-03 feature-bot session produced **four** wrong fixes in a row for the same bug, each corrected only when forced to read code that had been available the whole time: (1) "feature-bot's `route-attempt.ts` misclassifies infra failures" — the router was correct; the defect was the orchestrator at `index.ts:596` collapsing `escalate-failure` into `escalateToHuman`. (2) "change `break` to `continue` so it retries 5×" — blanket retry, directly contradicting research quoted minutes earlier (environment errors are only ~9.4% of agent failures). (3) "retrying risks state contamination" — `resetToMain(branchName)` already runs before every attempt. (4) "thin specs cause the failures" — the control group refuted it instantly (a cut landed on a 367-char spec; a failed one had 1210). The fifth version survived because `route-attempt.ts`, the retry loop, `escalateToHuman`, the call site, and `detectRateLimit` were all read **first** — and that reading also surfaced a docstring proving two of the three stuck cuts were already-diagnosed cascade victims, which reframed the remedy from "gamble on a retry" to "delete stale residue". Pairs with rule 39 (self-audit before confidence — the maintainer's repeated "are you confident?" was doing the work this rule makes mechanical) and rule 27 (label provenance — "inferred from the design doc" is a provenance state, not a verification). The same session then produced a **fifth** instance that reached production: `workflows: write` was added to `.github/workflows/feature-bot.yml` as a `permissions:` key without checking it against the valid-scope list and without a dispatch probe. It is not a valid `GITHUB_TOKEN` scope, GitHub treats an unknown permission value as a parse error for the whole file, and **feature-bot went offline** — every dispatch returned `HTTP 422` for ~25 minutes until the revert (#838 → #841, see #840). The "precedent" recalled for it was a false grep hit: `mutation-watcher.yml`'s `workflow_run.workflows: [Mutation]` is a trigger filter, structurally unrelated to `permissions:`. Two lessons worth their own sentence: a grep match is not a precedent, and an invalid config key is not ignored — it can take the whole surface down, so the blast radius of an unverified key is larger than the feature it was meant to enable. Note also that every one of the five was committed while this rule was already on main with bullets that cover them — the recurring failure is compliance, not missing guidance, so the fix is to run the read, not to add text here.

46. **When a bot misbehaves, replay its real transcript through the real code before changing its prompt.** A bot's stated failure reason is produced by parsing code, and that code can be what's wrong. Download the run's transcripts artifact (`gh run download <run-id>`) and run the actual parser/router on it (`collectAssistantTexts` → `parseReviewerTranscript` etc.) to see whether the output says what the escalation claims.

   **Why:** #517 escalated twice with "Reviewer voted REJECT but provided no Note." In June, #557 responded by adding a prompt rule requiring a Note. But the reviewer *had* written one: it put `VERDICT: REJECT` + `Note:` mid-message, then restated a bare `VERDICT: REJECT` as the last line, and the parser read the note only after the last line. Replaying the real transcript found it in minutes (#876). A prompt fix for a code bug moves the failure without removing it, and costs another failed run to find out. Pairs with rule 45 (read before asserting) and rule 37 (don't stack a second fix on the same failure mode).

47. **A new check isn't done until a deliberate violation makes it fail.** When adding a gate (CI job, validator, lint rule, a11y check, test project), commit a deliberate violation locally, confirm the gate fails on it *for the reason intended*, then remove it. A gate that has never failed is an assumption, not a gate.

   **Why:** on 2026-10-04, ADR-0016 said Storybook a11y violations hard-block CI. They didn't: `@storybook/addon-a11y` only *reports* by default (`a11y.test` must be `'error'`); a story with a missing `alt` passed. The dark-mode story project's first run then failed 8 stories for an environment reason — the page background lived in `App.vue`, which Storybook never loads — which a light-only gate could never have shown. Each gap was found only by a deliberate violation (a throwing story, a missing alt, a forced white page in `.dark`). Pairs with rule 31 (the gate is the failing spec) and rule 43 (verify behaviour, don't assume it).
