/**
 * feature-bot — implements `enhancement + ready-for-agent` cut sub-issues.
 *
 * Per design-feature-bot.md, feature-bot is a producer bot that reads
 * cut sub-issues from GitHub (per Q1: cuts live in tracking issues +
 * sub-issues, not in `.claude/rules/design-*-implementation.md` tables)
 * and ships one PR per cut via a generator-critic loop (per Q6: Agent A
 * implements, Agent B reviews, three-tier escalation
 * APPROVE / NEEDS_INPUT / NEEDS_HUMAN).
 *
 * # Cut 3 status (this file)
 *
 * Cut 3 ships the full generator-critic loop + three-tier escalation.
 * Cuts 1+2 shipped the skeleton + cut-parser respectively. Cut 4 will
 * ship the workflow + cron.
 *
 * # Two trigger modes
 *
 *   1. Cron (default): scans for `enhancement + ready-for-agent` issues
 *      that lack `ready-for-human` / `wontfix` / `needs-info`.
 *   2. Manual via `ISSUE_NUMBER` env: attempt a single specific sub-issue.
 *
 * # Per-cut, the bot:
 *   1. Validates the cut sub-issue body + dep refs via
 *      `validateCutSubIssue` (pre-Claude gate per Q3).
 *   2. Checks idempotency via `decideIdempotency`.
 *   3. Loads lessons-learned (currently empty placeholder).
 *   4. Generator-critic loop (MAX_ATTEMPTS=5):
 *      - Agent A reads design doc + cut body, builds + self-checks, then one commit.
 *      - Agent A signals: APPROVE_IMPLICIT (commits) / NEEDS_INPUT / NEEDS_HUMAN.
 *      - On APPROVE_IMPLICIT: Agent B reviews + verdicts.
 *      - `routeAttemptOutcome` decides the next step.
 *   5. Routes to: push-and-pr / retry-with-note / post-input-question /
 *      escalate-needs-human / escalate-failure.
 */
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { detectInfraStop, detectRateLimit, detectTransientAuthError, runClaude } from '../_lib/claude.js'
import { branchHasCommits, captureCommitMessages, captureDiff, resetToMain } from '../_lib/git-tree.js'
import { describeClaim, fetchIssueClaim } from '../_lib/issue-claim.js'
import { type DeliveryResult, deliveryFailureComment, pushBranch, runGh, savePatch } from '../_lib/delivery.js'
import {
  addLabel,
  findIssuesByLabels,
  getLabelAppliedAt,
  getReopenedAt,
  octokitFromEnv,
  removeLabel,
  repoFromEnv,
  type RepoIdentity,
} from '../_lib/github.js'
import { parseReviewerTranscript } from '../_lib/reviewer-verdict.js'
import { collectAssistantTexts, extractSummary } from '../_lib/transcript.js'
import {
  printBanner,
  printCandidateHeader,
  printCandidateList,
  printNotice,
  printRunSummary,
  printTranscriptPath,
  printWarning,
} from '../_lib/ui.js'
import { parseAgentASignal } from './agent-a-signal.js'
import { decideIdempotency } from './idempotency.js'
import { shouldEscalateForBudget } from './per-cut-budget.js'
import { escalationOutcomeTag, extractPriorReviewerNote } from './prior-reviewer-note.js'
import { appendReviewerLog, REVIEWER_LOG_PATH } from './reviewer-log.js'
import { composeRefinementComment, countPriorRefinements, filedByCutPlanner } from './refinement-handoff.js'
import { routeAttemptOutcome, type AttemptOutcome, type RouteContext, type RouteDecision } from './route-attempt.js'
import {
  appendEntry,
  findSkipMatch,
  type IssueFingerprint,
  readSkipList,
  type SkipList,
  type SkipListEntry,
  type SkipReason,
  SKIP_LIST_PATH,
  writeSkipList,
} from './skip-list.js'
import { validateCutSubIssue } from './validate-cut-sub-issue.js'

const HERE = dirname(fileURLToPath(import.meta.url))
const PROMPT_PATH = resolve(HERE, 'prompts/per-cut.md')
const REVIEWER_PROMPT_PATH = resolve(HERE, 'prompts/reviewer.md')
const REPO_ROOT = resolve(HERE, '../..')
const SKIP_LIST_ABS = resolve(REPO_ROOT, SKIP_LIST_PATH)
const REVIEWER_LOG_ABS = resolve(REPO_ROOT, REVIEWER_LOG_PATH)
const LESSONS_PATH = 'bots/feature-bot/lessons-learned.md'
const LESSONS_ABS = resolve(REPO_ROOT, LESSONS_PATH)

const DRY_RUN = process.env.DRY_RUN === '1'
const TRANSCRIPTS_DIR = resolve(HERE, '../transcripts')
const RUN_TIMESTAMP = new Date().toISOString().replace(/[:.]/g, '-')

// Per-RUN wall-clock budget, checked at the top of the candidate loop (so
// it bounds how many CUTS a run attempts, never interrupting one in
// flight). MUST exceed PER_CUT_BUDGET_MS below, or the pair is incoherent:
// a cut allowed 120 min would blow a 50-min run budget by design, firing
// the "stopping with N unprocessed" path on every substantive cut.
const PER_RUN_BUDGET_MS = Number(process.env.BUDGET_MS ?? 150 * 60 * 1000)
// Per-CUT wall-clock budget, checked at the top of each generator-critic
// attempt. The per-RUN budget above only fires BETWEEN candidates, so a
// single thrashing cut (e.g. an RBAC cut whose Agent-A pipeline +
// Agent-B architecture-review subagent + retries exceed the budget within
// one cut) would otherwise run until the workflow's `timeout-minutes`
// HARD-KILLS it mid-attempt — producing NO PR, NO escalation, no record
// (the #516 failure mode, 2026-06-09). Capping per-cut under the wall
// converts that silent kill into a graceful NEEDS_HUMAN escalation
// ("cut exceeds time budget — likely too large; split it").
//
// SIZING (2026-10-03). The previous 45-min cut budget with MAX_ATTEMPTS=5
// gave each generator-critic round ~9 minutes — and a single Agent A
// invocation was MEASURED at 638s (~10.6 min) on cut #524, run
// 37150215338. So one attempt could not fit its own slice, and five
// attempts (~60-75 min) exceeded both the cut budget and the 60-min
// workflow wall. Any substantive cut was guaranteed to escalate on budget
// regardless of its quality.
//
// Re-budgeted so ONE attempt is genuinely viable: 2 attempts x ~55 min.
// Fewer retries is deliberate — the 5 were never real (they shared 9
// minutes), and retry value is low in any case: ~82% of failed agent
// recoveries keep executing without progress, and "repeatedly fixing the
// wrong cause" accounts for ~39% of wasted execution.
//
// These numbers are a FIRST CALIBRATION on n=1 (one Agent A timing; Agent
// B had never completed a review before this change, because it died on
// `spawn E2BIG` — fixed separately). Re-check them against the first few
// completed loops rather than treating them as settled. The better
// long-term guard is repetition-based stuck detection, not a bigger timer.
const PER_CUT_BUDGET_MS = Number(process.env.CUT_BUDGET_MS ?? 120 * 60 * 1000)
const MAX_ATTEMPTS = Number(process.env.MAX_ATTEMPTS ?? '2')
const MAX_INPUT_CYCLES = Number(process.env.MAX_INPUT_CYCLES ?? '2')

/**
 * How many times a cut may be handed to cut-planner (design-cut-planner.md
 * Q4/Q6) before feature-bot escalates it to a human itself.
 *
 * 3 = cut-planner's 2 spec refinements + 1 re-decomposition. feature-bot
 * does not know which of those cut-planner will choose — it only counts
 * hand-offs — so this MUST equal cut-planner's MAX_REFINEMENTS +
 * MAX_REDECOMPOSITIONS. With fewer, feature-bot would escalate terminally on
 * a hand-off cut-planner meant to re-decompose, and re-decomposition would
 * be unreachable. `bots/cut-planner/tests/budget-coherence.test.ts` pins the
 * equality across the two bots, which deliberately share no code.
 *
 * Set to 0 to disable the hand-off entirely (loop exhaustion then escalates
 * to a human, as before cut-planner existed).
 */
const MAX_HANDOFFS = Number(process.env.MAX_HANDOFFS ?? '3')

async function main(): Promise<void> {
  const repo = repoFromEnv()
  const octokit = octokitFromEnv()

  const issueNumberStr = process.env.ISSUE_NUMBER
  if (issueNumberStr) {
    if (!/^\d+$/.test(issueNumberStr)) {
      console.error(`ISSUE_NUMBER='${issueNumberStr}' must be a positive integer`)
      process.exit(2)
    }
    await fixOneCut(octokit, repo, Number(issueNumberStr))
    return
  }

  printBanner({
    name: 'feature-bot',
    tagline: 'implementer (Cut 3 — generator-critic loop)',
    purpose:
      'Implement `enhancement + ready-for-agent` cut sub-issues (build → SOLID → runtime validation → improve tests → verify comments → one commit).',
    inputs: [
      'Open issues with `enhancement` AND `ready-for-agent`',
      'AND no `ready-for-human` / `wontfix` / `needs-info`',
    ],
    outputs: [
      'EITHER draft PR (commit 1: failing test, commit 2: impl)',
      'OR NEEDS_INPUT comment + `needs-info` label (design question)',
      'OR escalation comment + `ready-for-human` label + skip-list PR',
    ],
  })

  printNotice(`Scanning ${repo.owner}/${repo.repo} for enhancement+ready-for-agent cut sub-issues`)

  const allCandidates = await findIssuesByLabels(octokit, repo, {
    requireAll: ['enhancement', 'ready-for-agent'],
    excludeAny: ['ready-for-human', 'wontfix', 'needs-info'],
  })

  if (allCandidates.length === 0) {
    printNotice('No feature-bot candidates found. Inbox zero — nothing to do. ✨')
    return
  }

  // Q4 lock: oldest-first sort, deterministic tiebreaker by issue number.
  const candidates = [...allCandidates].sort((a, b) => {
    if (a.createdAt !== b.createdAt) return a.createdAt.localeCompare(b.createdAt)
    return a.number - b.number
  })

  printCandidateList({
    noun: 'cut sub-issue',
    candidates: candidates.map(c => ({ ref: `#${c.number}`, label: c.title })),
  })

  if (DRY_RUN) {
    printNotice(`DRY_RUN=1 — exiting before invoking Claude (${candidates.length} would be processed).`)
    return
  }

  const runStart = Date.now()
  let processed = 0
  for (const candidate of candidates) {
    const elapsed = Date.now() - runStart
    if (elapsed > PER_RUN_BUDGET_MS) {
      const remaining = candidates.length - processed
      printWarning(
        `Per-run budget exhausted (${Math.round(elapsed / 1000)}s > ${Math.round(PER_RUN_BUDGET_MS / 1000)}s). Stopping with ${remaining} unprocessed; the next scheduled run picks them up.`,
      )
      for (const skipped of candidates.slice(processed)) {
        console.log(`     ⏭  #${skipped.number} "${skipped.title}"`)
      }
      break
    }

    printCandidateHeader({
      index: processed + 1,
      total: candidates.length,
      label: `#${candidate.number} · ${candidate.title}`,
      elapsedSec: Math.round(elapsed / 1000),
    })

    // Someone else is already on it (an assignee, or another open PR that
    // references the issue): skip rather than open a second PR. If the check
    // itself fails, skip too; the next run tries again.
    try {
      const claim = await fetchIssueClaim(octokit.graphql, repo, candidate.number, cutBranch(candidate.number))
      if (claim) {
        printNotice(`Skipping #${candidate.number}: ${describeClaim(claim)}.`)
        processed++
        continue
      }
    } catch (err) {
      printWarning(`Couldn't check #${candidate.number} for other open work (${err}); skipping it this run.`)
      processed++
      continue
    }

    let cutResult: CutResult = { rateLimited: false }
    try {
      cutResult = await fixOneCut(octokit, repo, candidate.number)
    } catch (err) {
      printWarning(`Cut attempt for #${candidate.number} threw: ${err}; continuing.`)
    }
    processed++

    // Rate-limit cascade-stop. If Agent A hit Anthropic's session limit,
    // every subsequent candidate's `claude -p` invocation crashes in 4s
    // against the rejected bucket. Continuing the loop creates spurious
    // `ready-for-human` escalations + skip-list PRs (see 2026-06-14
    // #587-#590). Stop processing; the next scheduled run resumes the queue.
    if (cutResult.rateLimited) {
      const remaining = candidates.length - processed
      printWarning(
        `Stopping the candidate queue due to Anthropic session-rate-limit. ${remaining} candidate(s) remain; the next scheduled run resumes after the bucket resets.`,
      )
      for (const skipped of candidates.slice(processed)) {
        console.log(`     ⏭  #${skipped.number} "${skipped.title}"`)
      }
      break
    }
  }

  const totalSec = Math.round((Date.now() - runStart) / 1000)
  printRunSummary({
    verb: 'Processed',
    processed,
    total: candidates.length,
    skipped: candidates.length - processed,
    elapsedSec: totalSec,
  })
}

/**
 * Attempt to implement one cut sub-issue. Used by cron mode (per-candidate
 * loop) and manual one-issue mode.
 */
/**
 * Result of attempting a single cut. The `rateLimited` flag tells the
 * outer candidate-loop to STOP processing the queue — every subsequent
 * cut would crash in seconds against the exhausted Anthropic session
 * bucket. See `detectRateLimit` and the outer-loop check in `main`.
 */
type CutResult = { rateLimited: boolean }

async function fixOneCut(
  octokit: ReturnType<typeof octokitFromEnv>,
  repo: ReturnType<typeof repoFromEnv>,
  issueNumber: number,
): Promise<CutResult> {
  const { data: issue } = await octokit.issues.get({ ...repo, issue_number: issueNumber })
  if (issue.pull_request) {
    printNotice(`#${issueNumber} is a pull request, not an issue. Skipping.`)
    return { rateLimited: false }
  }
  if (issue.state !== 'open') {
    printNotice(`#${issueNumber} is ${issue.state}; nothing to do.`)
    return { rateLimited: false }
  }
  const labels = issue.labels.map(l => (typeof l === 'string' ? l : (l.name ?? ''))).filter(Boolean)
  if (!labels.includes('enhancement') || !labels.includes('ready-for-agent')) {
    printNotice(`#${issueNumber} lacks 'enhancement' + 'ready-for-agent' (current: [${labels.join(', ')}]); skipping.`)
    return { rateLimited: false }
  }
  if (labels.includes('ready-for-human') || labels.includes('wontfix') || labels.includes('needs-info')) {
    printNotice(`#${issueNumber} has terminal-state label; skipping.`)
    return { rateLimited: false }
  }

  // Idempotency: skip if the `feature-bot-attempted` label is present AND
  // the issue hasn't been reopened since the label was applied.
  // Mirrors fix-bot's auto-clear-on-reopen pattern (rule 38 symmetric audit).
  const attemptedAt = await getLabelAppliedAt(octokit, repo, issueNumber, 'feature-bot-attempted')
  const reopenedAt = attemptedAt !== null ? await getReopenedAt(octokit, repo, issueNumber) : null
  const idempotencyDecision = decideIdempotency({ attemptedAt, reopenedAt })
  if (idempotencyDecision.kind === 'skip') {
    printNotice(
      `#${issueNumber}: feature-bot-attempted label present and no reopen since. To re-attempt, remove the label OR reopen the issue.`,
    )
    return { rateLimited: false }
  }
  if (idempotencyDecision.kind === 'proceed-after-reopen') {
    printNotice(
      `#${issueNumber}: prior feature-bot-attempted (${attemptedAt}); reopened at ${reopenedAt}. Re-attempting.`,
    )
  }

  // Pre-Claude gate: parse body + validate deps. Loud-fail on bad refs.
  const issueBody = issue.body ?? ''
  const validation = await validateCutSubIssue(octokit as never, repo, issueNumber, issueBody)

  if (validation.kind === 'body-error') {
    await postBodyErrorComment(octokit, repo, issueNumber, validation.errors)
    await applyLabelBestEffort(octokit, repo, issueNumber, 'needs-info')
    await applyLabelBestEffort(octokit, repo, issueNumber, 'feature-bot-attempted')
    return { rateLimited: false }
  }

  if (validation.kind === 'self-reference') {
    const skipList = readSkipList(SKIP_LIST_ABS)
    await escalateToHuman(
      octokit,
      repo,
      issueNumber,
      skipList,
      { issueNumber },
      {
        reason: 'spec-too-vague',
        reasonNote: `Cut body references its own issue number in **Depends on**. This is a structurally broken spec.`,
        // Pre-Claude gate — orchestrator-authored, no Agent B involvement.
        source: 'orchestrator',
      },
    )
    return { rateLimited: false }
  }

  if (validation.kind === 'dep-invalid') {
    await postDepInvalidComment(octokit, repo, issueNumber, validation.depNumber, validation.reason)
    await applyLabelBestEffort(octokit, repo, issueNumber, 'needs-info')
    await applyLabelBestEffort(octokit, repo, issueNumber, 'feature-bot-attempted')
    return { rateLimited: false }
  }

  if (validation.kind === 'dep-rejected') {
    const skipList = readSkipList(SKIP_LIST_ABS)
    await escalateToHuman(
      octokit,
      repo,
      issueNumber,
      skipList,
      { issueNumber },
      {
        reason: 'missing-prereq',
        reasonNote: `Cut depends on #${validation.depNumber} which was closed without merging. The prerequisite work was rejected; this cut may need re-scoping.`,
        // Pre-Claude gate — orchestrator-authored, no Agent B involvement.
        source: 'orchestrator',
      },
    )
    return { rateLimited: false }
  }

  if (validation.kind === 'dep-unverified') {
    await postDepInvalidComment(octokit, repo, issueNumber, validation.depNumber, 'unverified')
    await applyLabelBestEffort(octokit, repo, issueNumber, 'needs-info')
    return { rateLimited: false }
  }

  if (validation.kind === 'dep-open') {
    // No labels applied — bot retries next cron when dep closes.
    await postDepOpenComment(octokit, repo, issueNumber, validation.openDeps)
    return { rateLimited: false }
  }

  // validation.kind === 'ready'
  const parsed = validation.parsed
  const featureSlug = parsed.feature ?? 'unknown'

  // Skip-list check (durable memory of "don't try this again").
  const skipList = readSkipList(SKIP_LIST_ABS)
  const fingerprint: IssueFingerprint = { issueNumber }
  const skipMatch = findSkipMatch(skipList, fingerprint)
  if (skipMatch) {
    printNotice(`#${issueNumber}: skip-list match (${skipMatch.reason}); skipping.`)
    return { rateLimited: false }
  }

  // Lessons-learned — loaded once, inlined into every Agent A + reviewer prompt.
  const lessonsLearned = existsSync(LESSONS_ABS) ? readFileSync(LESSONS_ABS, 'utf-8') : ''
  printNotice(`Lessons file: ${lessonsLearned ? `${lessonsLearned.length} bytes` : 'absent'}`)

  // Count prior NEEDS_INPUT cycles via outcome-tag query on existing comments.
  const priorInputCycles = await countPriorInputCycles(octokit, repo, issueNumber)
  // Both budgets read from the SAME comment list, but count different
  // outcome tags — they are independent budgets and must not conflate
  // (a NEEDS_INPUT cycle is not a spec refinement).
  const priorHandoffs = await countPriorRefinementsOnIssue(octokit, repo, issueNumber)
  // Hand-offs only for cuts cut-planner filed; old-model cuts would be
  // parked in a queue nothing reads (see filedByCutPlanner).
  const handoffBudget = filedByCutPlanner(issueBody) ? MAX_HANDOFFS : 0
  if (priorInputCycles > 0) {
    printNotice(`#${issueNumber}: ${priorInputCycles} prior NEEDS_INPUT cycle(s) recorded.`)
  }

  const branchName = cutBranch(issueNumber)

  const agentAPromptTemplate = readFileSync(PROMPT_PATH, 'utf-8')
  const reviewerPromptTemplate = readFileSync(REVIEWER_PROMPT_PATH, 'utf-8')

  mkdirSync(TRANSCRIPTS_DIR, { recursive: true })
  // Seed from historical reviewer-sourced escalation comments so a
  // requeued cut doesn't start blind. When the maintainer removed
  // `ready-for-human` to retry this cut, any prior Agent B rejection
  // note lives only inside the escalation comment — without seeding,
  // attempt 1 of the next run has no memory of what the reviewer said.
  // Orchestrator-sourced escalations (budget, crash, dep) are ignored
  // by the parser (prior-reviewer-note.ts) because their notes would
  // mislead Agent A if fed back as reviewer feedback.
  let priorReviewerNote: string | null = await fetchPriorReviewerNote(octokit, repo, issueNumber)
  if (priorReviewerNote) {
    printNotice(`#${issueNumber}: seeded PRIOR_REVIEWER_NOTE from a historical reviewer-sourced escalation.`)
  }
  let finalOutcome: 'approved' | 'escalated' | 'needs-input-posted' | 'loop-exhausted' = 'loop-exhausted'

  // Per-cut wall-clock anchor. MUST be captured per cut (not at
  // module init): a multi-cut cron run would otherwise let cut #2
  // inherit cut #1's elapsed time and escalate prematurely. The
  // shouldEscalateForBudget helper's signature enforces the
  // cut-scoped contract — it takes `cutStart` as an arg.
  const cutStart = Date.now()

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    // Per-cut deadline guard. Without this, a thrashing cut runs until the
    // workflow's 60-min hard kill, producing nothing (the #516 failure
    // mode). Check BEFORE each attempt: if we'd likely not finish another
    // generator-critic round before the budget, stop and escalate so the
    // cut is recorded as needing human attention (probably too large —
    // split it) instead of vanishing into a silent timeout.
    //
    // LIMITATION: this fires only BETWEEN attempts. A single attempt
    // (one Agent A pipeline + one Agent B review) that alone exceeds the
    // budget still gets hard-killed mid-attempt — the guard can't
    // interrupt an in-flight runClaude. It catches the common multi-
    // attempt-thrash case; per-call timeouts on runClaude are the fuller
    // fix if single-attempt overruns recur.
    const now = Date.now()
    const cutElapsed = now - cutStart
    if (shouldEscalateForBudget({ cutStart, now, budget: PER_CUT_BUDGET_MS })) {
      printWarning(
        `Per-cut budget exhausted for #${issueNumber} (${Math.round(cutElapsed / 1000)}s > ${Math.round(PER_CUT_BUDGET_MS / 1000)}s) after ${attempt - 1} attempt(s). Escalating before the workflow hard-kill.`,
      )
      resetToMain(branchName, { cwd: REPO_ROOT })
      await escalateToHuman(octokit, repo, issueNumber, skipList, fingerprint, {
        reason: 'needs-human',
        reasonNote: `Cut exceeded the per-cut time budget (${Math.round(PER_CUT_BUDGET_MS / 60000)} min) after ${attempt - 1} generator-critic attempt(s) without an APPROVE. The cut is likely too large or the loop is thrashing — consider splitting it into smaller cuts or tightening its spec. (Stopped before the workflow's 60-min hard-kill to leave a record instead of a silent timeout.)`,
        // Budget-exhausted — orchestrator-authored, not an Agent B verdict.
        source: 'orchestrator',
      })
      finalOutcome = 'escalated'
      break
    }
    printNotice(`Attempt ${attempt}/${MAX_ATTEMPTS}: invoking Agent A…`)
    resetToMain(branchName, { cwd: REPO_ROOT })

    const agentATranscript = resolve(
      TRANSCRIPTS_DIR,
      `${RUN_TIMESTAMP}-feature-cut-${issueNumber}-attempt${attempt}-A.jsonl`,
    )
    printTranscriptPath(agentATranscript)

    const agentAPrompt = `${agentAPromptTemplate}

ISSUE_NUMBER=${issueNumber}
ISSUE_TITLE=${issue.title}
FEATURE_SLUG=${featureSlug}
ISSUE_BODY=
${issueBody}

BRANCH_NAME=${branchName}
ATTEMPT=${attempt}
MAX_ATTEMPTS=${MAX_ATTEMPTS}
${priorReviewerNote ? `PRIOR_REVIEWER_NOTE=${priorReviewerNote}\n\n` : ''}LESSONS_LEARNED=
${lessonsLearned}
RUN_ID=${process.env.GITHUB_RUN_ID ?? 'local'}`

    const aResult = await runClaude({
      prompt: agentAPrompt,
      transcriptPath: agentATranscript,
      allowedTools: ['Bash', 'Read', 'Grep', 'Glob', 'Write', 'Edit'],
    })

    // Rate-limit cascade-stop. When Anthropic's 5-hour session bucket
    // is exhausted, this and every subsequent cut crash in seconds
    // against the rejected bucket. Escalating to `ready-for-human`
    // would create spurious skip-list PRs (see 2026-06-14 #587-#590);
    // the cut is fine, the bucket isn't. Leave the cut on the queue,
    // signal the outer loop to STOP processing more candidates, and
    // skip the `feature-bot-attempted` label so the next scheduled run
    // re-picks this cut at the front.
    if (!aResult.success && detectRateLimit(agentATranscript)) {
      printWarning(
        `Anthropic session-rate-limit hit on attempt ${attempt}; stopping the queue (this cut + remaining candidates will be retried by the next scheduled run after the bucket resets).`,
      )
      resetToMain(branchName, { cwd: REPO_ROOT })
      return { rateLimited: true }
    }

    // Transient AUTH / entitlement failure (401 / 403) — same category as
    // the rate-limit above: the cut is fine, the infrastructure isn't.
    // Without this the non-zero exit routes to `agent-a-failure` →
    // `escalate-failure` → a TERMINAL `needs-human` skip entry, which is
    // exactly how a momentary org-level 403 on 2026-06-24 froze cut #524
    // (and the whole review-workflow dependency chain behind it) for three
    // months. Leave the cut on the queue and stop the queue: if auth is
    // down for this run it's down for every subsequent candidate too, so
    // continuing would burn the remaining budget on identical failures.
    if (!aResult.success && detectTransientAuthError(agentATranscript)) {
      printWarning(
        `Transient auth/entitlement failure on attempt ${attempt}; stopping the queue (this cut + remaining candidates stay eligible for the next cron).`,
      )
      resetToMain(branchName, { cwd: REPO_ROOT })
      return { rateLimited: true }
    }

    const ctx: RouteContext = {
      attempt,
      maxAttempts: MAX_ATTEMPTS,
      priorInputCycles,
      maxInputCycles: MAX_INPUT_CYCLES,
      priorHandoffs,
      maxHandoffs: handoffBudget,
    }

    let outcome: AttemptOutcome
    if (!aResult.success) {
      outcome = { kind: 'agent-a-failure', exitCode: aResult.exitCode }
    } else {
      const agentATexts = collectAssistantTexts(agentATranscript)
      const lastText = agentATexts.at(-1) ?? ''
      const signal = parseAgentASignal(lastText)

      if (signal.kind === 'needs-input' || signal.kind === 'needs-human') {
        outcome = { kind: 'agent-a-signaled', signal }
      } else {
        // approve-implicit — Agent A should have committed work.
        const hasCommits = branchHasCommits(branchName, { cwd: REPO_ROOT })
        if (!hasCommits) {
          outcome = { kind: 'agent-a-no-output' }
        } else {
          // Invoke Agent B.
          printNotice(`Attempt ${attempt}/${MAX_ATTEMPTS}: invoking Agent B (reviewer)…`)
          const diff = captureDiff(branchName, { cwd: REPO_ROOT })
          const commitMessages = captureCommitMessages(branchName, { cwd: REPO_ROOT })
          const reviewerTranscript = resolve(
            TRANSCRIPTS_DIR,
            `${RUN_TIMESTAMP}-feature-cut-${issueNumber}-attempt${attempt}-B.jsonl`,
          )
          printTranscriptPath(reviewerTranscript)

          const agentASummary = extractSummary(agentATranscript)
          const reviewerPrompt = `${reviewerPromptTemplate}

ISSUE_NUMBER=${issueNumber}
ISSUE_TITLE=${issue.title}
FEATURE_SLUG=${featureSlug}
ISSUE_BODY=
${issueBody}

BRANCH_NAME=${branchName}
ATTEMPT=${attempt}
${priorReviewerNote ? `PRIOR_REVIEWER_NOTE=${priorReviewerNote}\n` : ''}DIFF=
${diff}

COMMIT_MESSAGES=
${commitMessages}

AGENT_A_SUMMARY=
${agentASummary || '(no SUMMARY block captured from Agent A — REJECT with note: your run did not emit a SUMMARY block; emit one per the per-cut prompt APPROVE-path step 10)'}

RUN_ID=${process.env.GITHUB_RUN_ID ?? 'local'}`

          const bResult = await runClaude({
            prompt: reviewerPrompt,
            transcriptPath: reviewerTranscript,
            // Reviewer needs:
            //   - Bash for tautology check (git revert + vitest)
            //   - Read for source + rule files on demand
            //   - Agent for delegating review-architecture +
            //     review-security to subagents (keeps the skills'
            //     heavy context out of Agent B's window — same
            //     pattern fix-bot adopted in #471 after the VERDICT
            //     line was getting eaten by the findings fence)
            //   - Skill kept so the subagents (spawned via Agent)
            //     can invoke the skills they need
            // Explicitly NOT Write/Edit — reviewer doesn't modify code.
            allowedTools: ['Bash', 'Read', 'Agent', 'Skill'],
          })
          if (!bResult.success && detectInfraStop(reviewerTranscript)) {
            // Quota / transient auth during review says nothing about the
            // cut — same handling as Agent A's guard above (#892).
            printWarning(
              `Agent B hit the session limit or a transient auth failure on attempt ${attempt}; stopping the queue (this cut stays eligible for the next cron).`,
            )
            resetToMain(branchName, { cwd: REPO_ROOT })
            return { rateLimited: true }
          }
          if (!bResult.success) {
            printWarning(`Agent B exited ${bResult.exitCode} on attempt ${attempt}; treating as needs-human.`)
            await escalateToHuman(octokit, repo, issueNumber, skipList, fingerprint, {
              reason: 'needs-human',
              reasonNote: `Reviewer crashed on attempt ${attempt}. See transcript ${reviewerTranscript}.`,
              // Reviewer crash — orchestrator detected it, no verdict was produced.
              source: 'orchestrator',
            })
            finalOutcome = 'escalated'
            break
          }

          const reviewerTexts = collectAssistantTexts(reviewerTranscript)
          const verdict = parseReviewerTranscript(reviewerTexts)

          try {
            appendReviewerLog(REVIEWER_LOG_ABS, {
              ts: new Date().toISOString(),
              runId: process.env.GITHUB_RUN_ID ?? 'local',
              fingerprint,
              fingerprintLabel: `#${issueNumber}`,
              attempt,
              verdict:
                verdict.kind === 'approve' ? 'approve' : verdict.kind === 'needs-human' ? 'needs-human' : 'reject',
              reasoning: verdict.kind === 'approve' ? verdict.reasoning : verdict.note,
              agentASummary: extractSummary(agentATranscript),
            })
          } catch (err) {
            printWarning(`reviewer-log append failed (non-fatal): ${err}`)
          }

          outcome = { kind: 'agent-b-judged', signal, verdict }
        }
      }
    }

    const decision = routeAttemptOutcome(outcome, ctx)

    if (decision.kind === 'push-and-pr') {
      printNotice(`✅ Reviewer APPROVED on attempt ${attempt}/${MAX_ATTEMPTS}: ${decision.reasoning.slice(0, 120)}`)
      // Both steps report their outcome and BOTH are checked (#840). A
      // swallowed push used to fall through to "approved": approved work
      // discarded, no PR, no comment, and the cut still ready-for-agent — so
      // the next run rebuilt it and failed the same way, forever.
      const pushed = pushBranch(branchName, { cwd: REPO_ROOT, forceWithLease: true })
      const delivered = pushed.ok
        ? openCutPR(
            repo,
            issueNumber,
            issue.title,
            featureSlug,
            branchName,
            decision.reasoning,
            extractSummary(
              resolve(TRANSCRIPTS_DIR, `${RUN_TIMESTAMP}-feature-cut-${issueNumber}-attempt${attempt}-A.jsonl`),
            ),
          )
        : pushed
      if (delivered.ok) {
        finalOutcome = 'approved'
        break
      }
      await escalateDeliveryFailure(octokit, repo, issueNumber, skipList, fingerprint, {
        stage: pushed.ok ? 'pr' : 'push',
        branchName,
        error: delivered.error,
      })
      finalOutcome = 'escalated'
      break
    }

    if (decision.kind === 'retry-with-note') {
      printNotice(`Reviewer REJECTED on attempt ${attempt}/${MAX_ATTEMPTS}: ${decision.note.slice(0, 120)}`)
      priorReviewerNote = decision.note
      continue
    }

    if (decision.kind === 'post-input-question') {
      printNotice(`Agent A asked NEEDS_INPUT: ${decision.question.slice(0, 120)}`)
      await postInputQuestion(octokit, repo, issueNumber, decision.body)
      await applyLabelBestEffort(octokit, repo, issueNumber, 'needs-info')
      resetToMain(branchName, { cwd: REPO_ROOT })
      finalOutcome = 'needs-input-posted'
      break
    }

    if (decision.kind === 'escalate-needs-human') {
      printWarning(`⚠ Escalating to NEEDS_HUMAN (reason=${decision.reason}): ${decision.reasonNote.slice(0, 120)}`)
      await escalateToHuman(octokit, repo, issueNumber, skipList, fingerprint, {
        reason: decision.reason,
        reasonNote: decision.reasonNote,
        // route-attempt.ts set source based on which path produced the
        // decision (Agent B verdict vs orchestrator-detected failure).
        source: decision.source,
      })
      finalOutcome = 'escalated'
      break
    }

    if (decision.kind === 'escalate-failure') {
      printWarning(`Agent A exited ${decision.exitCode} on attempt ${attempt}; escalating.`)
      await escalateToHuman(octokit, repo, issueNumber, skipList, fingerprint, {
        reason: 'needs-human',
        reasonNote: `Agent A's Claude invocation exited ${decision.exitCode} on attempt ${attempt}. See transcript.`,
        // Agent A non-zero exit — orchestrator-detected, not a reviewer verdict.
        source: 'orchestrator',
      })
      finalOutcome = 'escalated'
      break
    }

    // Non-terminal hand-off to cut-planner (design-cut-planner.md Q4).
    // Exactly two writes, both on THIS cut issue: an outcome-tagged comment
    // carrying Agent B's verdict, and a label swap. No skip-list entry, no
    // `ready-for-human`, issue stays open — the cut is not abandoned.
    //
    // feature-bot deliberately does NOT touch the planner issue: it never
    // learns the planner issue exists, so it cannot fail because of it. The
    // label IS the channel.
    if (decision.kind === 'escalate-needs-refinement') {
      printNotice(
        `Reviewer rejected after ${attempt} attempts; handing to cut-planner (hand-off ${decision.priorHandoffs + 1} of ${handoffBudget}).`,
      )
      await handOffForRefinement(octokit, repo, issueNumber, {
        reviewerNote: decision.reviewerNote,
        priorHandoffs: decision.priorHandoffs,
        maxHandoffs: handoffBudget,
        attempts: attempt,
      })
      finalOutcome = 'escalated'
      break
    }
  }

  // If we fell through without break, the loop hit MAX_ATTEMPTS with all
  // REJECT verdicts (handled inside the loop on the last iteration via
  // attempt >= maxAttempts in routeAttemptOutcome). But the no-break path
  // here is defense-in-depth.
  if (finalOutcome === 'loop-exhausted') {
    printWarning(`Loop exhausted after ${MAX_ATTEMPTS} attempts.`)
    await escalateToHuman(octokit, repo, issueNumber, skipList, fingerprint, {
      reason: 'needs-human',
      reasonNote: `Loop exhausted after ${MAX_ATTEMPTS} attempts. Last reviewer note: ${priorReviewerNote ?? '(none)'}`,
      // Defense-in-depth fallthrough — should not fire in practice (route-attempt
      // returns escalate-needs-human on the final reject). If priorReviewerNote
      // exists, the embedded note is reviewer-sourced; if null, there was no
      // Agent B verdict to carry over, so this is orchestrator-authored.
      source: priorReviewerNote ? 'reviewer' : 'orchestrator',
    })
  }

  await applyLabelBestEffort(octokit, repo, issueNumber, 'feature-bot-attempted')
  return { rateLimited: false }
}

/**
 * Count prior NEEDS_INPUT cycles for this cut sub-issue.
 *
 * Reads existing comments and counts those with the outcome tag
 * `<!-- feature-bot: needs-input issue=N run=R -->`. Used to enforce
 * MAX_INPUT_CYCLES per Q6 lock.
 */
async function countPriorInputCycles(
  octokit: ReturnType<typeof octokitFromEnv>,
  repo: RepoIdentity,
  issueNumber: number,
): Promise<number> {
  const { data: comments } = await octokit.issues.listComments({
    ...repo,
    issue_number: issueNumber,
    per_page: 100,
  })
  const marker = `feature-bot: needs-input issue=${issueNumber}`
  return comments.filter(c => (c.body ?? '').includes(marker)).length
}

/**
 * Count prior refinement hand-offs for this cut (design-cut-planner.md Q6).
 *
 * I/O wrapper around the pure `countPriorRefinements`. Same durable-record
 * trick as `countPriorInputCycles`: the outcome tag on the comment IS the
 * budget state, so it survives runner restarts and cache misses with no
 * committed file.
 */
async function countPriorRefinementsOnIssue(
  octokit: ReturnType<typeof octokitFromEnv>,
  repo: RepoIdentity,
  issueNumber: number,
): Promise<number> {
  const { data: comments } = await octokit.issues.listComments({
    ...repo,
    issue_number: issueNumber,
    per_page: 100,
  })
  return countPriorRefinements(
    comments.map(c => c.body),
    issueNumber,
  )
}

/**
 * Fetch the latest reviewer-sourced note recorded in this cut's historical
 * escalation comments (if any). I/O wrapper around the pure
 * `extractPriorReviewerNote`.
 *
 * Mirrors `countPriorInputCycles` / `countPriorRefinementsOnIssue`: the
 * outcome tag is the durable record, so a requeued cut survives runner
 * teardown with no committed state. Returns null when no previous run
 * escalated with a reviewer verdict for this cut.
 */
async function fetchPriorReviewerNote(
  octokit: ReturnType<typeof octokitFromEnv>,
  repo: RepoIdentity,
  issueNumber: number,
): Promise<string | null> {
  const { data: comments } = await octokit.issues.listComments({
    ...repo,
    issue_number: issueNumber,
    per_page: 100,
  })
  return extractPriorReviewerNote(
    comments.map(c => c.body ?? null),
    issueNumber,
  )
}

/**
 * Hand a cut to cut-planner: comment, then swap the label.
 *
 * Order matters. The comment lands FIRST so the outcome tag exists before
 * the cut leaves feature-bot's queue — if the label swap then fails, the
 * next run still counts this refinement and the budget cannot be bypassed
 * by a partial write. The reverse order would risk a cut sitting in
 * `needs-refinement` with no verdict for cut-planner to read.
 *
 * Label removal is best-effort-after: `needs-refinement` is added before
 * `ready-for-agent` is removed, so a failure between the two leaves the cut
 * visible to BOTH queues (noisy, recoverable) rather than to neither
 * (silently parked, which is the shape Q6a forbids).
 */
async function handOffForRefinement(
  octokit: ReturnType<typeof octokitFromEnv>,
  repo: RepoIdentity,
  issueNumber: number,
  input: { reviewerNote: string; priorHandoffs: number; maxHandoffs: number; attempts: number },
): Promise<void> {
  const body = composeRefinementComment({
    issueNumber,
    reviewerNote: input.reviewerNote,
    priorHandoffs: input.priorHandoffs,
    maxHandoffs: input.maxHandoffs,
    attempts: input.attempts,
    runId: process.env.GITHUB_RUN_ID ?? 'local',
  })
  try {
    await octokit.issues.createComment({ ...repo, issue_number: issueNumber, body })
  } catch (err) {
    // Loud, and we stop: without the comment there is no verdict for
    // cut-planner to act on and no durable budget record, so swapping the
    // label would park the cut in a queue with nothing to work from.
    printWarning(`Couldn't post refinement comment on #${issueNumber}: ${err}. Leaving labels unchanged.`)
    return
  }
  await addLabel(octokit, repo, issueNumber, 'needs-refinement').catch(err => {
    printWarning(`Couldn't apply needs-refinement to #${issueNumber}: ${err}`)
  })
  await removeLabel(octokit, repo, issueNumber, 'ready-for-agent').catch(err => {
    printWarning(`Couldn't remove ready-for-agent from #${issueNumber}: ${err}`)
  })
}

/**
 * Approved work that did not land (#840). Save it BEFORE escalating:
 * `escalateToHuman` resets to main to build its skip-list branch, which
 * would otherwise discard the approved commits on the runner. Then hand it
 * to a human with the git error and the patch, and record `delivery-failed`
 * so the cut is not rebuilt on every run.
 */
async function escalateDeliveryFailure(
  octokit: ReturnType<typeof octokitFromEnv>,
  repo: RepoIdentity,
  issueNumber: number,
  skipList: SkipList,
  fingerprint: IssueFingerprint,
  f: { stage: 'push' | 'pr'; branchName: string; error: string },
): Promise<void> {
  printWarning(`Approved but not delivered (${f.stage} failed) for #${issueNumber}: ${f.error.slice(0, 200)}`)
  const patchName = `${RUN_TIMESTAMP}-feature-cut-${issueNumber}`
  const patch =
    f.stage === 'push'
      ? savePatch({ cwd: REPO_ROOT, dir: TRANSCRIPTS_DIR, name: patchName, branch: f.branchName })
      : null
  const runId = process.env.GITHUB_RUN_ID ?? 'local'
  const runUrl =
    runId === 'local'
      ? '(local run)'
      : `${process.env.GITHUB_SERVER_URL ?? 'https://github.com'}/${repo.owner}/${repo.repo}/actions/runs/${runId}`
  // The full comment (with the patch inline when small) goes up first and
  // independently: escalateToHuman truncates its note, and a failure there
  // must not lose the work.
  await octokit.issues
    .createComment({
      ...repo,
      issue_number: issueNumber,
      body: deliveryFailureComment({
        bot: 'feature-bot',
        issueNumber,
        stage: f.stage,
        branch: f.branchName,
        error: f.error,
        patch,
        patchFileName: patch ? `${patchName}.patch` : null,
        runUrl,
        runId,
      }),
    })
    .catch(err => printWarning(`Couldn't post the delivery-failure comment on #${issueNumber}: ${err}`))
  resetToMain(f.branchName, { cwd: REPO_ROOT })
  await escalateToHuman(octokit, repo, issueNumber, skipList, fingerprint, {
    reason: 'delivery-failed',
    reasonNote: `Approved by the reviewer, but the ${f.stage === 'push' ? 'push' : 'PR creation'} failed: ${f.error.slice(0, 400)}. See the delivery-failure comment above for the preserved work.`,
    // Delivery failure is orchestrator-detected infrastructure, not an
    // Agent B verdict (the reviewer DID approve — the push/PR step failed).
    source: 'orchestrator',
  })
}

function openCutPR(
  _repo: RepoIdentity,
  issueNumber: number,
  issueTitle: string,
  featureSlug: string,
  branchName: string,
  reviewerReasoning: string,
  agentASummary: string,
): DeliveryResult {
  const body = `## Summary

Implements cut #${issueNumber} for the \`${featureSlug}\` feature.

Closes #${issueNumber}.

Implemented by Agent A, then independently reviewed by Agent B (both
Claude Code sessions). Agent A's flow: write tests + impl, SOLID
research+fix, runtime validation, improve/fix tests, verify comments —
then one atomic commit.

## What Agent A did

${agentASummary || '(no Agent A summary captured)'}

## Reviewer's assessment

${reviewerReasoning || '(no reviewer reasoning captured)'}

Agent B is the sole anti-tautology gate: it separated impl from tests by
path, reverted only the impl (tests must fail), restored (tests must
pass), verified each \`## Acceptance\` bullet is pinned, independently
checked SOLID, scrutinized any test removals, and verified the diff
implements the design doc's Locked decisions.

## Verification

One atomic commit (tests + impl together). CI re-runs the full suite;
Agent B's revert check already proved the tests are load-bearing.

## What if this is wrong?

Close the PR. The bot's feedback loop will read the close reason from
your comment and add a skip-list entry so it doesn't re-attempt the
same cut shape.

<!-- feature-bot: issue=${issueNumber} run=${process.env.GITHUB_RUN_ID ?? 'local'} -->`
  return runGh(
    [
      'pr',
      'create',
      '--draft',
      '--title',
      `feat: cut #${issueNumber} — ${issueTitle}`,
      '--body',
      body,
      '--head',
      branchName,
    ],
    REPO_ROOT,
  )
}

/**
 * Post the structured NEEDS_INPUT question as a sub-issue comment + apply
 * `needs-info` label. The body is Agent A's verbatim block (question +
 * options + recommendation). Maintainer's answer (any non-bot reply OR
 * removing `needs-info`) re-enters the queue.
 */
async function postInputQuestion(
  octokit: ReturnType<typeof octokitFromEnv>,
  repo: RepoIdentity,
  issueNumber: number,
  body: string,
): Promise<void> {
  const runId = process.env.GITHUB_RUN_ID ?? 'local'
  const commentBody = `> *This was generated by AI during triage.*

⚠ **Feature-bot needs your input to proceed.**

Agent A reached a design decision that the cut spec + design doc don't
answer. Choosing one path without your input would either contradict the
design doc OR commit the project to a path you might reject.

${body}

**To resolve:**

1. Read the question + Agent A's recommendation
2. Reply with your answer (or just remove the \`needs-info\` label if
   Agent A's recommendation is correct)
3. The next cron picks up this cut with your input in context

If Agent A asks the same question twice without resolution, I'll escalate
to \`ready-for-human\` (per the MAX_INPUT_REQUESTS=2 cap).

<!-- feature-bot: needs-input issue=${issueNumber} run=${runId} -->`

  try {
    await octokit.issues.createComment({ ...repo, issue_number: issueNumber, body: commentBody })
  } catch (err) {
    printWarning(`Could not post NEEDS_INPUT comment on #${issueNumber}: ${err}`)
  }
}

async function postBodyErrorComment(
  octokit: ReturnType<typeof octokitFromEnv>,
  repo: RepoIdentity,
  issueNumber: number,
  errors: readonly { kind: string; section?: string }[],
): Promise<void> {
  const sections = errors
    .filter(e => e.kind === 'missing-required-section')
    .map(e => e.section)
    .filter(Boolean)
    .map(s => `\`## ${s![0].toUpperCase() + s!.slice(1)}\``)
    .join(', ')
  const hasMissingFeature = errors.some(e => e.kind === 'missing-feature')
  const lines = [
    '> *This was generated by AI during triage.*',
    '',
    '⚠ **Cut sub-issue body is missing required fields.**',
    '',
  ]
  if (hasMissingFeature) {
    lines.push('- Missing `**Feature**: <slug>` field at the top of the body')
  }
  if (sections) {
    lines.push(`- Missing required section(s): ${sections}`)
  }
  lines.push(
    '',
    'Per `design-feature-bot.md` Q2 + Cut 5 refinement, the cut sub-issue body must contain:',
    '',
    '```markdown',
    '**Feature**: <slug>',
    '**Depends on**: #N, #M  (or empty/none)',
    '',
    '## Spec',
    '...narrative...',
    '',
    '## Acceptance',
    '- ...',
    '',
    '## SOLID (when applicable)',
    '...',
    '',
    '## Tests',
    '- bots/.../tests/foo.test.ts',
    '```',
    '',
    'Edit the body to add the missing fields, then remove the `needs-info` label to re-queue.',
    '',
    `<!-- feature-bot: body-error issue=${issueNumber} run=${process.env.GITHUB_RUN_ID ?? 'local'} -->`,
  )
  try {
    await octokit.issues.createComment({ ...repo, issue_number: issueNumber, body: lines.join('\n') })
  } catch (err) {
    printWarning(`Could not post body-error comment on #${issueNumber}: ${err}`)
  }
}

async function postDepInvalidComment(
  octokit: ReturnType<typeof octokitFromEnv>,
  repo: RepoIdentity,
  issueNumber: number,
  depNumber: number,
  reason: 'not-found' | 'not-a-cut' | 'unverified',
): Promise<void> {
  const why =
    reason === 'not-found'
      ? `#${depNumber} doesn't exist in this repository.`
      : reason === 'not-a-cut'
        ? `#${depNumber} exists but isn't labeled \`enhancement\` — it's not a cut sub-issue.`
        : `#${depNumber} is closed, but no merged PR that names it closed it — so there's no evidence it landed. If it did, add \`#${depNumber}\` to the title of the PR that implemented it; if it didn't, reopen #${depNumber}.`
  const body = `> *This was generated by AI during triage.*

⚠ **${reason === 'unverified' ? 'Cut depends on a cut with no evidence it landed.' : 'Cut sub-issue references an invalid dependency.'}**

The \`**Depends on**:\` line cites #${depNumber}, but ${why}

${reason === 'unverified' ? 'Then' : 'Fix the dependency reference in the body, then'} remove the \`needs-info\` label to re-queue.

<!-- feature-bot: ${reason === 'unverified' ? 'dep-unverified' : 'dep-invalid'} issue=${issueNumber} dep=${depNumber} run=${process.env.GITHUB_RUN_ID ?? 'local'} -->`
  try {
    await octokit.issues.createComment({ ...repo, issue_number: issueNumber, body })
  } catch (err) {
    printWarning(`Could not post dep-invalid comment on #${issueNumber}: ${err}`)
  }
}

async function postDepOpenComment(
  octokit: ReturnType<typeof octokitFromEnv>,
  repo: RepoIdentity,
  issueNumber: number,
  openDeps: readonly number[],
): Promise<void> {
  // Skip if we've already posted a wait-for-dep comment on this cut for
  // these same deps — avoid spamming the issue on every cron tick.
  const marker = `feature-bot: dep-waiting issue=${issueNumber}`
  try {
    const { data: comments } = await octokit.issues.listComments({
      ...repo,
      issue_number: issueNumber,
      per_page: 100,
    })
    if (comments.some(c => (c.body ?? '').includes(marker))) {
      printNotice(`#${issueNumber}: dep-waiting comment already posted; staying quiet this cron.`)
      return
    }
  } catch {
    // best-effort
  }
  const depList = openDeps.map(n => `#${n}`).join(', ')
  const body = `> *This was generated by AI during triage.*

ℹ **Waiting for dependencies to close.**

This cut depends on ${depList} which ${openDeps.length === 1 ? 'is' : 'are'} still open. I'll retry on the next cron after ${openDeps.length === 1 ? 'it closes' : 'they close'}.

<!-- feature-bot: dep-waiting issue=${issueNumber} run=${process.env.GITHUB_RUN_ID ?? 'local'} -->`
  try {
    await octokit.issues.createComment({ ...repo, issue_number: issueNumber, body })
  } catch (err) {
    printWarning(`Could not post dep-waiting comment on #${issueNumber}: ${err}`)
  }
}

async function applyLabelBestEffort(
  octokit: ReturnType<typeof octokitFromEnv>,
  repo: RepoIdentity,
  issueNumber: number,
  label: string,
): Promise<void> {
  try {
    await addLabel(octokit, repo, issueNumber, label)
  } catch (err) {
    printWarning(`Could not apply '${label}' to #${issueNumber}: ${err}`)
  }
}

/**
 * Reviewer-loop escalation. Mirrors fix-bot's escalateToHuman shape
 * (rule 38 symmetric audit) — four steps:
 *
 *   1. Append entry to skip-list.json locally
 *   2. Open a draft PR with that skip-list entry (so next run honors it
 *      even after runner-local fs is gone)
 *   3. Post a stuck-comment on the sub-issue explaining why
 *   4. Apply `ready-for-human` + close the sub-issue
 *
 * Without steps 2-4, the only memory of the bot's reviewer loop is the
 * runner-local skip-list.json that vanishes on workflow teardown.
 */
/** The working branch for a cut. One definition, so escalation resets the same branch the loop built. */
function cutBranch(issueNumber: number): string {
  return `feat/cut-${issueNumber}`
}

async function escalateToHuman(
  octokit: ReturnType<typeof octokitFromEnv>,
  repo: ReturnType<typeof repoFromEnv>,
  issueNumber: number,
  skipList: SkipList,
  fingerprint: IssueFingerprint,
  opts: { reason: SkipReason; reasonNote: string; source: 'reviewer' | 'orchestrator' },
): Promise<void> {
  // Step 0: back to a clean main FIRST. The skip-list branch below is cut
  // from HEAD, so a caller still on the cut branch would ship the cut's
  // unreviewed commits inside the skip-list PR (#892). Resetting here, not
  // in each caller, means no caller can forget. It must precede step 1:
  // resetToMain runs `git reset --hard`, which would discard the
  // skip-list write.
  resetToMain(cutBranch(issueNumber), { cwd: REPO_ROOT })

  // Step 1: write skip-list locally
  const entry: SkipListEntry = {
    fingerprint,
    reason: opts.reason,
    reasonNote: opts.reasonNote,
    addedAt: new Date().toISOString(),
    addedBy: 'bot',
  }
  const added = appendEntry(skipList, entry)
  if (added) {
    writeSkipList(SKIP_LIST_ABS, skipList)
    printNotice(`Recorded skip-list entry for #${fingerprint.issueNumber} (${opts.reason})`)
  }

  // Step 2: open draft PR for the skip-list change so it lands on main.
  const dateStr = new Date().toISOString().slice(0, 10)
  const skipBranch = `feature-bot-skip/${dateStr}-cut-${issueNumber}`
  try {
    execFileSync('git', ['checkout', '-b', skipBranch], { cwd: REPO_ROOT, stdio: 'inherit' })
    execFileSync('git', ['add', SKIP_LIST_PATH], { cwd: REPO_ROOT, stdio: 'inherit' })
    execFileSync(
      'git',
      [
        'commit',
        '-m',
        `chore(skip-list): record ${opts.reason} for #${issueNumber}\n\n${opts.reasonNote.slice(0, 500)}`,
      ],
      { cwd: REPO_ROOT, stdio: 'inherit' },
    )
    execFileSync('git', ['push', '-u', 'origin', skipBranch], { cwd: REPO_ROOT, stdio: 'inherit' })
    execFileSync(
      'gh',
      [
        'pr',
        'create',
        '--draft',
        '--title',
        `chore(skip-list): record ${opts.reason} for #${issueNumber}`,
        '--body',
        `> *This was generated by AI during triage.*

Adds a skip-list entry so feature-bot doesn't re-attempt cut #${issueNumber} on every cron.

**Reason:** \`${opts.reason}\`

**Note from the reviewer loop:**

> ${opts.reasonNote.slice(0, 1500)}

**What to do next:**

Read the comment feature-bot just posted on #${issueNumber}. If the reasoning looks right, either merge this PR (durable skip), close the underlying issue, or open the cut yourself based on the analysis. If the reasoning was wrong, close this PR and reopen #${issueNumber} (or remove the \`ready-for-human\` label) to let feature-bot retry.

<!-- feature-bot: skip-entry issue=${issueNumber} reason=${opts.reason} run=${process.env.GITHUB_RUN_ID ?? 'local'} -->`,
      ],
      { cwd: REPO_ROOT, stdio: 'inherit' },
    )
    printNotice(`Opened skip-list-entry PR for #${issueNumber}`)
  } catch (err) {
    printWarning(`Couldn't open skip-list PR for #${issueNumber}: ${err}`)
  } finally {
    try {
      execFileSync('git', ['checkout', 'main'], { cwd: REPO_ROOT, stdio: 'inherit' })
    } catch {
      // best-effort
    }
  }

  // Step 3 + 4: post stuck-comment + apply ready-for-human + close.
  try {
    const ghServer = process.env.GITHUB_SERVER_URL ?? 'https://github.com'
    const repoSlug = `${repo.owner}/${repo.repo}`
    const runId = process.env.GITHUB_RUN_ID ?? 'local'
    const workflowRunUrl =
      runId === 'local' ? '(local run — no workflow URL)' : `${ghServer}/${repoSlug}/actions/runs/${runId}`

    // Multi-line reasonNote: prefix each line with `> ` so the whole
    // note renders as one blockquote AND the parser in
    // prior-reviewer-note.ts can simply consume consecutive `> ` lines.
    const quotedNote = opts.reasonNote.slice(0, 2000).replace(/\n/g, '\n> ')
    const tag = escalationOutcomeTag({ issueNumber, reason: opts.reason, runId, source: opts.source })
    const body = `> *This was generated by AI during triage.*

⚠ **Feature-bot escalation — needs human attention.**

**Reason:** \`${opts.reason}\`

**Note from the loop:**

> ${quotedNote}

**Workflow run:** ${workflowRunUrl}

I've stopped attempting this cut and applied \`ready-for-human\` (removing it from my queue). Next steps for the maintainer:

1. **Read the reasoning** above + the workflow run's transcript artifact (\`bots/transcripts/\`) for the full analysis
2. **If the reasoning is right** — close this cut OR implement it manually based on the analysis
3. **If you want me to retry** — remove the \`ready-for-human\` label AND remove (or clear) the skip-list entry (the PR I just opened). Then the next cron picks this cut up again.

${tag}`

    await octokit.issues.createComment({ ...repo, issue_number: issueNumber, body })
    await addLabel(octokit, repo, issueNumber, 'ready-for-human')
    // Remove ready-for-agent since we've terminally escalated. Cron's
    // exclude filter handles ready-for-human, but clearing ready-for-agent
    // makes the maintainer's intent clearer when they re-queue.
    await removeLabel(octokit, repo, issueNumber, 'ready-for-agent').catch(() => {})
    printNotice(`Posted escalation comment + applied ready-for-human on #${issueNumber}`)
  } catch (err) {
    printWarning(`Could not post escalation comment on #${issueNumber}: ${err}`)
  }
}

main().catch(err => {
  console.error('Fatal error:', err)
  process.exit(1)
})

// Re-export the routing types so external consumers (replay tooling, future
// compactor) can read the orchestrator's decision-making vocabulary without
// reaching into private modules. Cargo-cult-free per rule 19 — these are
// already the names tests use.
export type { AttemptOutcome, RouteContext, RouteDecision }
