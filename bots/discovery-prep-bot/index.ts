/**
 * discovery-prep-bot — researches confident-enhancement issues.
 *
 * Two trigger modes:
 *
 *   1. Cron (default): scans for issues matching the input contract
 *      (label `enhancement`, lacks any of `ready-for-human`,
 *      `ready-for-agent`, `wontfix`, `needs-info`). Processes oldest-first
 *      with a per-run budget. Backlog converges over multiple daily runs.
 *
 *   2. workflow_dispatch with `issue` input: researches one specific
 *      issue, regardless of label state. Useful for re-research after
 *      prompt iteration.
 *
 * Per-issue, the bot:
 *   1. Reads the issue body + comments
 *   2. Researches: competitor implementations (web fetch + fact-check),
 *      related project ADRs/design-docs/audits, actor-scenario mapping
 *      (per docs/actor-scenarios.md), foundational-dimensions checklist,
 *      open questions for grilling
 *   3. Posts findings as a single issue comment
 *   4. Adds `ready-for-human` label (signals: research done, design
 *      grilling can start)
 *
 * Output is an ISSUE COMMENT plus the `ready-for-human` label. No PR,
 * no repo file. The label is the bot's idempotency contract — once
 * applied, future cron runs skip the issue (since the label is in the
 * exclude-set of the input query).
 *
 * The `ready-for-human` label is shared with fix-bot's "stuck — needs
 * human" state. Maintainer disambiguates by reading the comment thread:
 * a discovery-prep-bot outcome tag means "research done"; a fix-bot
 * outcome tag means "fix-bot stuck."
 *
 * The bot does NOT write a design doc. Per `feature-design-process.md`,
 * design docs are the OUTPUT of grilling — bot can't substitute. Discovery
 * compresses Phase 1 of feature work; the maintainer grills + decides + writes
 * the design doc themselves.
 *
 * Run locally:
 *   # Cron mode — scan all open enhancements:
 *   GITHUB_REPOSITORY=gazetta-studio/gazetta-studio \
 *     GH_TOKEN=$(gh auth token) npm run discovery-prep-bot -w @gazetta/bots
 *   # Manual one-issue mode:
 *   ISSUE_NUMBER=192 GITHUB_REPOSITORY=gazetta-studio/gazetta-studio \
 *     GH_TOKEN=$(gh auth token) npm run discovery-prep-bot -w @gazetta/bots
 * Run in CI:
 *   .github/workflows/discovery-prep-bot.yml (cron + workflow_dispatch)
 */
import { mkdirSync, readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { runClaude } from '../_lib/claude.js'
import { findIssuesByLabels, hasPriorCommentFromBot, octokitFromEnv, repoFromEnv } from '../_lib/github.js'
import { isDesignPassedWork } from './design-passed.js'
import {
  printBanner,
  printCandidateHeader,
  printCandidateList,
  printNotice,
  printRunSummary,
  printTranscriptPath,
  printWarning,
} from '../_lib/ui.js'

const HERE = dirname(fileURLToPath(import.meta.url))
const PROMPT_PATH = resolve(HERE, 'prompt.md')

const DRY_RUN = process.env.DRY_RUN === '1'
const TRANSCRIPTS_DIR = resolve(HERE, '../transcripts')
const RUN_TIMESTAMP = new Date().toISOString().replace(/[:.]/g, '-')

// Per-run budget. Discovery is expensive (~5-10 min per issue: web search,
// fact-check, multi-doc grep). Workflow timeout is 60 min; exit gracefully
// at 50 min for the upload-artifacts step + any in-flight per-issue work.
// Override via env for local manual runs.
const PER_RUN_BUDGET_MS = Number(process.env.BUDGET_MS ?? 50 * 60 * 1000)

async function main(): Promise<void> {
  const repo = repoFromEnv()
  const octokit = octokitFromEnv()

  // Manual one-issue mode short-circuits the cron scan.
  const issueNumberStr = process.env.ISSUE_NUMBER
  if (issueNumberStr) {
    if (!/^\d+$/.test(issueNumberStr)) {
      console.error(`ISSUE_NUMBER='${issueNumberStr}' must be a positive integer`)
      process.exit(2)
    }
    await researchOneIssue(octokit, repo, Number(issueNumberStr))
    return
  }

  printBanner({
    name: 'discovery-prep-bot',
    tagline: 'researcher',
    purpose: 'Research confident-enhancement issues; prepare design grilling.',
    inputs: [
      'Open issues with `enhancement`',
      'AND no `ready-for-human` / `ready-for-agent` / `wontfix` / `needs-info`',
    ],
    outputs: [
      'Research comment (competitor scan, ADRs, scenarios, open questions)',
      '`ready-for-human` label (signals research done; grilling can start)',
    ],
  })

  printNotice(`Scanning ${repo.owner}/${repo.repo} for confident-enhancement candidates`)

  // Label-driven input: every enhancement that hasn't been handed off
  // downstream. Once `ready-for-human` is applied (after research is
  // posted), the issue is excluded forever — the label IS the
  // completion signal. Maintainer re-enqueues by removing the label.
  const allCandidates = await findIssuesByLabels(octokit, repo, {
    requireAll: ['enhancement'],
    excludeAny: ['ready-for-human', 'ready-for-agent', 'wontfix', 'needs-info'],
  })

  if (allCandidates.length === 0) {
    printNotice('No discovery-prep candidates found. Inbox zero — nothing to do. ✨')
    return
  }

  // Oldest-first so longest-waiting enhancements get research first.
  const candidates = [...allCandidates].sort((a, b) => a.createdAt.localeCompare(b.createdAt))

  printCandidateList({
    noun: 'enhancement',
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
        `Per-run budget exhausted (${Math.round(elapsed / 1000)}s > ${Math.round(PER_RUN_BUDGET_MS / 1000)}s). Stopping with ${remaining} un-researched; tomorrow's run picks them up.`,
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

    try {
      await researchOneIssue(octokit, repo, candidate.number)
    } catch (err) {
      printWarning(`research of #${candidate.number} threw: ${err}; continuing.`)
    }
    processed++
  }

  const totalSec = Math.round((Date.now() - runStart) / 1000)
  printRunSummary({
    verb: 'Researched',
    processed,
    total: candidates.length,
    skipped: candidates.length - processed,
    elapsedSec: totalSec,
  })
}

/**
 * Research one issue. Used by both cron mode (per-candidate loop) and
 * manual mode (single ISSUE_NUMBER input).
 *
 * Validates the issue is open + enhancement + not already commented on
 * by discovery-prep-bot. The label-driven cron candidate query already
 * applies these filters — but a manual `gh workflow run -f issue=N` can
 * target any issue, so the per-issue checks are defense-in-depth.
 */
async function researchOneIssue(
  octokit: ReturnType<typeof octokitFromEnv>,
  repo: ReturnType<typeof repoFromEnv>,
  issueNumber: number,
): Promise<void> {
  const { data: issue } = await octokit.issues.get({ ...repo, issue_number: issueNumber })
  if (issue.pull_request) {
    printNotice(`#${issueNumber} is a pull request, not an issue. Skipping.`)
    return
  }
  if (issue.state !== 'open') {
    printNotice(`#${issueNumber} is ${issue.state}; nothing to research.`)
    return
  }
  const labels = issue.labels.map(l => (typeof l === 'string' ? l : (l.name ?? ''))).filter(Boolean)
  if (!labels.includes('enhancement')) {
    printNotice(`#${issueNumber} is not labeled 'enhancement' (current: [${labels.join(', ')}]); nothing to research.`)
    return
  }

  // Design-passed work is not discovery's business. Discovery precedes
  // design; an issue carrying `**Feature**:` front-matter already sits
  // downstream of a design pass — a cut-planner planner issue, a cut handed
  // back to cut-planner (`needs-refinement` drops `ready-for-agent`, which
  // is what made it look like an unresearched enhancement), or a
  // pre-cut-planner tracking issue. Researching one would post noise and,
  // worse, apply `ready-for-human`, which removes it from cut-planner's
  // queue and silently stalls the feature.
  if (isDesignPassedWork(issue.body ?? '')) {
    printNotice(`#${issueNumber} carries **Feature**: front-matter (design-passed work); not a discovery candidate.`)
    return
  }

  // Idempotency: skip if discovery-prep-bot has already commented. The
  // label-driven input check would catch this for cron-mode candidates
  // (because we'd have applied `ready-for-human` after the prior comment),
  // but a manual one-issue invocation can target any issue.
  const alreadyCommented = await hasPriorCommentFromBot(octokit, repo, issueNumber, 'discovery-prep-bot')
  if (alreadyCommented) {
    printNotice(
      `#${issueNumber}: discovery-prep-bot has already commented. To re-research, delete the prior comment AND remove ready-for-human, then re-run.`,
    )
    return
  }

  if (DRY_RUN) {
    printNotice(`DRY_RUN=1 — exiting before invoking Claude.`)
    return
  }

  const promptTemplate = readFileSync(PROMPT_PATH, 'utf-8')
  mkdirSync(TRANSCRIPTS_DIR, { recursive: true })
  const transcriptPath = resolve(TRANSCRIPTS_DIR, `${RUN_TIMESTAMP}-discovery-issue-${issueNumber}.jsonl`)
  printTranscriptPath(transcriptPath)

  const prompt = `${promptTemplate}

ISSUE_NUMBER=${issueNumber}
ISSUE_TITLE=${issue.title}
RUN_ID=${process.env.GITHUB_RUN_ID ?? 'local'}`

  const result = await runClaude({
    prompt,
    transcriptPath,
    allowedTools: ['Bash', 'Read', 'Grep', 'Glob', 'WebFetch', 'WebSearch'],
  })
  if (!result.success) {
    printWarning(`discovery for #${issueNumber} exited ${result.exitCode}`)
  }
}

main().catch(err => {
  console.error('Fatal error:', err)
  process.exit(1)
})
