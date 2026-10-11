/**
 * triage-bot — daily autonomous classification of incoming issues.
 *
 * Per-issue, the bot reads the body + comments + linked code, classifies
 * confidently as `bug` or `enhancement` when the body has concrete
 * evidence, OR escalates as `triage-uncertain` when the body is ambiguous.
 * For confident bugs that reproduce locally (or are producer-bot-filed),
 * the bot also auto-advances state to `ready-for-agent` so fix-bot picks
 * up the issue on its next cron.
 *
 * Maintainer UX target: morning view = `gh issue list --label triage-uncertain`
 * shows ONLY the issues the bot couldn't classify (target: 1-3 per week
 * in steady state). Confident classifications carry no maintainer-attention
 * label; the maintainer reviews fix-bot's PRs as the irreducible gate.
 *
 * The bot does NOT apply `needs-triage` (that label is skill-canonical
 * "no bot or human has looked yet"). The bot does NOT advance state past
 * `ready-for-agent` — `wontfix` / `needs-info` / `ready-for-human` are
 * maintainer-only via the interactive `/triage` skill.
 *
 * Conventions shared with the `/triage` skill (~/.claude/skills/triage/):
 *   - AI disclaimer prefix on every comment
 *   - Category roles: bug | enhancement (+ project-specific triage-uncertain)
 *   - Outcome-tag suffix per flake-watcher convention
 *
 * Run locally:
 *   DRY_RUN=1 GITHUB_REPOSITORY=gazetta-studio/gazetta-studio \
 *     GH_TOKEN=$(gh auth token) npm run triage-bot -w @gazetta/bots
 * Run in CI:
 *   .github/workflows/triage-bot.yml (daily 11:00 UTC)
 */
import { existsSync, mkdirSync, readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { LIGHT_MODEL, runClaude } from '../_lib/claude.js'
import { findIssuesByLabels, octokitFromEnv, repoFromEnv } from '../_lib/github.js'
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
// Repo root: bots/triage-bot/ → ../../
const REPO_ROOT = resolve(HERE, '../..')

const DRY_RUN = process.env.DRY_RUN === '1'
const TRANSCRIPTS_DIR = resolve(HERE, '../transcripts')
const RUN_TIMESTAMP = new Date().toISOString().replace(/[:.]/g, '-').replace(/Z$/, 'Z')

// Per-run budget. Workflow timeout is 60 min; we exit gracefully at 50 min
// to leave 10 min margin for the upload-artifacts step + any in-flight
// per-issue work. Issues we don't reach this run will be picked up by the
// next daily run (sorted oldest-first so the backlog converges in a few
// days for one-time spikes). Override via env for local manual runs.
const PER_RUN_BUDGET_MS = Number(process.env.BUDGET_MS ?? 50 * 60 * 1000)

async function main(): Promise<void> {
  printBanner({
    name: 'triage-bot',
    tagline: 'classifier',
    purpose: 'Classify open issues as bug / enhancement / triage-uncertain.',
    inputs: [
      'Open issues with NO classification (no bug / enhancement / triage-uncertain)',
      'AND no terminal-state label (no ready-for-agent / ready-for-human / wontfix / needs-info)',
    ],
    outputs: [
      'One of bug / enhancement / triage-uncertain + area: X',
      'Reproducible bug also gets ready-for-agent (auto-advances to fix-bot queue)',
    ],
  })

  const repo = repoFromEnv()
  const octokit = octokitFromEnv()

  printNotice(`Scanning ${repo.owner}/${repo.repo} for triage candidates`)

  // Triage-bot's input contract: any open issue with NO classification
  // yet (no `bug` / `enhancement` / `triage-uncertain`) AND no terminal-
  // state label (no `ready-for-agent` / `ready-for-human` / `wontfix` /
  // `needs-info`). Once classified, the issue is excluded forever — the
  // label IS the completion signal.
  //
  // Reclassification path: maintainer removes the existing classification
  // label to re-enqueue. Re-investigation across runs is the maintainer's
  // explicit gesture, not the bot's default.
  const allCandidates = await findIssuesByLabels(octokit, repo, {
    excludeAny: [
      'bug',
      'enhancement',
      'triage-uncertain',
      'ready-for-agent',
      'ready-for-human',
      'wontfix',
      'needs-info',
    ],
  })

  if (allCandidates.length === 0) {
    printNotice('No triage candidates found. Inbox zero — nothing to do. ✨')
    return
  }

  // Sort oldest-first so longest-untriaged issues get attention first.
  // Combined with the per-run budget below, this guarantees a one-time
  // backlog spike converges in a few daily runs rather than starving
  // newer issues forever (which a newest-first or arrival-order sort would).
  const candidates = [...allCandidates].sort((a, b) => a.createdAt.localeCompare(b.createdAt))

  printCandidateList({
    noun: 'issue',
    candidates: candidates.map(c => ({
      ref: `#${c.number}`,
      label: c.title,
      meta: c.labels.length ? `[${c.labels.join(', ')}]` : '[unlabeled]',
    })),
  })

  if (DRY_RUN) {
    printNotice(`DRY_RUN=1 — exiting before invoking Claude (${candidates.length} would be processed).`)
    return
  }

  const promptTemplate = readFileSync(PROMPT_PATH, 'utf-8')
  mkdirSync(TRANSCRIPTS_DIR, { recursive: true })

  // Pre-load reference docs the bot consults on EVERY investigation. Reading
  // these once at startup + injecting into the per-issue prompt avoids the
  // bot re-fetching them per issue. On the previous run, docs/non-goals.md
  // was opened 92 times across 44 investigations — that's pure waste.
  const nonGoalsPath = resolve(REPO_ROOT, 'docs/non-goals.md')
  const roadmapPath = resolve(REPO_ROOT, 'ROADMAP.md')
  const nonGoals = existsSync(nonGoalsPath) ? readFileSync(nonGoalsPath, 'utf-8') : '(docs/non-goals.md not present)'
  const roadmap = existsSync(roadmapPath) ? readFileSync(roadmapPath, 'utf-8') : '(ROADMAP.md not present)'
  const referenceDocsBlock = `

## Reference docs (pre-loaded; DO NOT re-read with cat / grep / Read)

These two files are consulted on every investigation. Their contents are
inlined below so you can match against them directly without tool calls.

### docs/non-goals.md

\`\`\`markdown
${nonGoals}
\`\`\`

### ROADMAP.md

\`\`\`markdown
${roadmap}
\`\`\`
`

  const runStart = Date.now()
  let processed = 0

  for (const candidate of candidates) {
    const elapsed = Date.now() - runStart
    if (elapsed > PER_RUN_BUDGET_MS) {
      const remaining = candidates.length - processed
      printWarning(
        `Per-run budget exhausted (${Math.round(elapsed / 1000)}s > ${Math.round(PER_RUN_BUDGET_MS / 1000)}s). Stopping with ${remaining} un-triaged; tomorrow's run picks them up.`,
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
      meta: candidate.labels.length ? [`labels: ${candidate.labels.join(', ')}`] : undefined,
      elapsedSec: Math.round(elapsed / 1000),
    })

    // Every investigation is fresh — the candidate query already excludes
    // classified issues, so any candidate we see is either brand-new or
    // explicitly re-enqueued by a maintainer (who removed the prior
    // classification label). In both cases, classify from scratch.
    const prompt = `${promptTemplate}${referenceDocsBlock}

ISSUE_NUMBER=${candidate.number}
ISSUE_TITLE=${candidate.title}
RUN_ID=${process.env.GITHUB_RUN_ID ?? 'local'}`

    const transcriptPath = resolve(TRANSCRIPTS_DIR, `${RUN_TIMESTAMP}-issue-${candidate.number}.jsonl`)
    printTranscriptPath(transcriptPath)

    try {
      // Triage needs more tools than flake-watcher: Bash for gh + npm test +
      // file inspection; Read for reading repo files Claude wants to inspect
      // outside of bash output.
      const result = await runClaude({
        model: LIGHT_MODEL,
        prompt,
        transcriptPath,
        allowedTools: ['Bash', 'Read', 'Grep', 'Glob'],
      })
      if (!result.success) {
        printWarning(`triage of #${candidate.number} exited ${result.exitCode}; continuing.`)
      }
    } catch (err) {
      printWarning(`triage of #${candidate.number} threw: ${err}; continuing.`)
    }

    // No chain-dispatch: discovery-prep-bot now runs on its own cron and
    // reads `enhancement` issues without `ready-for-human` (its label-
    // driven input). Triage-bot's job ends at classification; pipeline
    // hand-off happens via the issue tracker's label state, not via
    // workflow_dispatch.

    processed++
  }

  const totalSec = Math.round((Date.now() - runStart) / 1000)
  printRunSummary({
    verb: 'Triaged',
    processed,
    total: candidates.length,
    skipped: candidates.length - processed,
    notes: [`Transcripts: ${TRANSCRIPTS_DIR}`],
    elapsedSec: totalSec,
  })
}

main().catch(err => {
  console.error('Fatal error:', err)
  process.exit(1)
})
