/**
 * cut-planner's monthly memory compaction (design-cut-planner.md Q7a).
 *
 * Reads the raw tier (`decision-log.jsonl`, restored from actions/cache) and
 * has Claude rewrite the distilled tier (`lessons-learned.md`) holistically,
 * opening a PR. Rewrite, not append: a lesson that stopped being true must
 * leave the prompt, and git history keeps it.
 *
 * Expected to be idle for a while. Until cut-planner has acted on enough
 * features there is no signal, and the gate exits without calling Claude —
 * the honest cost of building the memory ahead of the signal (Q7a).
 *
 * Run locally:
 *   GITHUB_REPOSITORY=gazetta-studio/gazetta-studio GH_TOKEN=$(gh auth token) \
 *     npm run cut-planner:compact -w @gazetta/bots
 * Run in CI: .github/workflows/bots-compact.yml (first Saturday of the month)
 */
import { existsSync, mkdirSync, readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { LIGHT_MODEL, runClaude } from '../_lib/claude.js'
import { printBanner, printNotice, printRunSummary, printTranscriptPath, printWarning } from '../_lib/ui.js'
import { composeCompactPrompt, shouldCompact } from './compact-helpers.js'
import { DECISION_LOG_PATH, pruneDecisionLog, tailDecisionLog } from './decision-log.js'

const HERE = dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = resolve(HERE, '../..')
const LESSONS_PATH = 'bots/cut-planner/lessons-learned.md'
const TRANSCRIPTS_DIR = resolve(HERE, '../transcripts')
const RUN_TIMESTAMP = new Date().toISOString().replace(/[:.]/g, '-')
const DRY_RUN = process.env.DRY_RUN === '1'

/** Acted runs needed before a rewrite is worth it (idle/quota runs don't count). */
const MIN_ACTED_RUNS = Number(process.env.MIN_ACTED_RUNS ?? '5')
/** How much recent log the compactor reads. */
const LOG_WINDOW = Number(process.env.DECISION_LOG_WINDOW ?? '150')
/** Entries kept after a successful compaction — 2× the window, for headroom. */
const LOG_KEEP_LAST = Number(process.env.DECISION_LOG_KEEP_LAST ?? '300')

async function main(): Promise<void> {
  printBanner({
    name: 'cut-planner:compact',
    tagline: 'monthly memory compactor',
    purpose: 'Rewrite lessons-learned.md from the decision log, so planning prompts learn from how cuts actually went.',
    inputs: [
      'bots/cut-planner/decision-log.jsonl (cached raw tier)',
      'bots/cut-planner/lessons-learned.md (previous lessons)',
    ],
    outputs: ['A PR rewriting lessons-learned.md — or nothing, when there is not enough signal'],
  })

  const logAbs = resolve(REPO_ROOT, DECISION_LOG_PATH)
  const lessonsAbs = resolve(REPO_ROOT, LESSONS_PATH)
  const log = tailDecisionLog(logAbs, LOG_WINDOW)
  const previousLessons = existsSync(lessonsAbs) ? readFileSync(lessonsAbs, 'utf-8') : ''
  printNotice(`Decision log: ${log.length} recent entries (window=${LOG_WINDOW})`)

  const gate = shouldCompact(log, MIN_ACTED_RUNS, DRY_RUN)
  if (!gate.run) {
    printNotice(
      gate.reason === 'below-threshold'
        ? `Only ${gate.signal} acted run(s) logged; need ${gate.threshold}. Not enough signal to draw lessons from.`
        : 'DRY_RUN=1 — exiting before invoking Claude.',
    )
    return
  }

  mkdirSync(TRANSCRIPTS_DIR, { recursive: true })
  const transcriptPath = resolve(TRANSCRIPTS_DIR, `${RUN_TIMESTAMP}-cut-planner-compact.jsonl`)
  printTranscriptPath(transcriptPath)
  const startedAt = Date.now()

  const result = await runClaude({
    model: LIGHT_MODEL,
    prompt: composeCompactPrompt({
      template: readFileSync(resolve(HERE, 'prompts/compact.md'), 'utf-8'),
      lessonsPath: LESSONS_PATH,
      log,
      previousLessons,
      runId: process.env.GITHUB_RUN_ID ?? 'local',
    }),
    transcriptPath,
    allowedTools: ['Bash', 'Read', 'Write', 'Edit'],
  })

  const notes = [`Transcript: ${transcriptPath}`]
  if (result.success) {
    // Prune only after success: a failed run must not evict the input its
    // retry next month will need.
    const { dropped, kept } = pruneDecisionLog(logAbs, LOG_KEEP_LAST)
    notes.push(`Pruned decision log: ${dropped} dropped, ${kept} kept`)
  } else {
    printWarning(`Claude exited ${result.exitCode}; decision log left intact for the next attempt.`)
  }

  printRunSummary({
    verb: 'Compacted',
    processed: result.success ? 1 : 0,
    total: 1,
    skipped: result.success ? 0 : 1,
    notes,
    elapsedSec: Math.round((Date.now() - startedAt) / 1000),
  })
}

main().catch(err => {
  console.error('Fatal error:', err)
  process.exit(1)
})
