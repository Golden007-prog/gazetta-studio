/**
 * fix-bot's memory-compaction pass.
 *
 * Runs monthly alongside dead-code-watcher's compactor (per
 * `.github/workflows/bots-compact.yml`). Reads the per-issue
 * skip-list and rewrites `bots/fix-bot/lessons-learned.md`
 * holistically — pruning lessons that no longer apply, adding new
 * ones that recur across rejections.
 *
 * Different shape from dead-code-watcher's compactor: fix-bot's
 * skip-list rarely benefits from glob-rule compaction (most
 * rejections are per-issue, not per-issue-shape). The valuable
 * compaction here is **cross-issue pattern surfacing into prose**
 * that becomes part of Agent A's prompt context.
 *
 * Holistic rewrite (not append): Claude is asked to rewrite the
 * lessons file from scratch each month, given the full
 * skip-list. This prevents lessons from a now-fixed bug class
 * staying around forever and misleading future Agent A runs.
 * Git history preserves the dropped lessons; they're not lost,
 * just no longer in active context.
 *
 * Run locally:
 *   GITHUB_REPOSITORY=gazetta-studio/gazetta-studio \
 *     GH_TOKEN=$(gh auth token) npm run fix-bot:compact -w @gazetta/bots
 * Run in CI:
 *   .github/workflows/bots-compact.yml (1st Sat of each month, 03:00 UTC)
 */
import { existsSync, mkdirSync, readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { LIGHT_MODEL, runClaude } from '../_lib/claude.js'
import { printBanner, printNotice, printRunSummary, printTranscriptPath, printWarning } from '../_lib/ui.js'
import { composePrompt, handlePostClaude, shouldRunCompaction } from './compact-helpers.js'
import { REVIEWER_LOG_PATH, tailReviewerLog } from './reviewer-log.js'
import { readSkipList, SKIP_LIST_PATH } from './skip-list.js'

const HERE = dirname(fileURLToPath(import.meta.url))
const PROMPT_PATH = resolve(HERE, 'prompts/compact.md')
const REPO_ROOT = resolve(HERE, '../..')
const SKIP_LIST_ABS = resolve(REPO_ROOT, SKIP_LIST_PATH)
const REVIEWER_LOG_ABS = resolve(REPO_ROOT, REVIEWER_LOG_PATH)
const LESSONS_PATH = 'bots/fix-bot/lessons-learned.md'
const LESSONS_ABS = resolve(REPO_ROOT, LESSONS_PATH)
const TRANSCRIPTS_DIR = resolve(HERE, '../transcripts')
const RUN_TIMESTAMP = new Date().toISOString().replace(/[:.]/g, '-').replace(/Z$/, 'Z')

const DRY_RUN = process.env.DRY_RUN === '1'

/**
 * Minimum entries required to consider running the compactor. Below
 * this we exit early without invoking Claude — there's not enough
 * signal to surface patterns from. Counts the larger of skip-list
 * size + reviewer-log size — either signal is enough to justify a
 * rewrite.
 */
const MIN_ENTRIES_FOR_COMPACTION = Number(process.env.MIN_ENTRIES_FOR_COMPACTION ?? '3')

/**
 * How many recent reviewer-log entries the compactor reads. Older
 * entries don't inform lessons — they may reflect outdated patterns
 * from a past prompt iteration.
 */
const REVIEWER_LOG_WINDOW = Number(process.env.REVIEWER_LOG_WINDOW ?? '100')

/**
 * How many entries the compactor keeps after pruning. Set to 2× the
 * read window so the next monthly run has headroom. Older entries
 * dropped — the compactor IS the memory-trimmer for this surface.
 */
const REVIEWER_LOG_KEEP_LAST = Number(process.env.REVIEWER_LOG_KEEP_LAST ?? '200')

async function main(): Promise<void> {
  printBanner({
    name: 'fix-bot:compact',
    tagline: 'monthly memory compactor',
    purpose: 'Rewrite lessons-learned.md from skip-list + reviewer-log patterns; keep cross-issue memory fresh.',
    inputs: [
      'bots/fix-bot/skip-list.json (per-issue rejections)',
      'bots/fix-bot/reviewer-log.jsonl (Agent B verdicts)',
      'bots/fix-bot/lessons-learned.md (previous lessons)',
    ],
    outputs: ['PR rewriting lessons-learned.md with current recurring patterns'],
  })

  const skipList = readSkipList(SKIP_LIST_ABS)
  const entryCount = skipList.entries.length
  const ruleCount = skipList.rules.length
  const reviewerLog = tailReviewerLog(REVIEWER_LOG_ABS, REVIEWER_LOG_WINDOW)
  const lessonsExists = existsSync(LESSONS_ABS)
  const lessonsContent = lessonsExists ? readFileSync(LESSONS_ABS, 'utf-8') : ''

  printNotice(`Current skip-list: ${entryCount} entries + ${ruleCount} rules`)
  printNotice(`Reviewer-log: ${reviewerLog.length} recent entries (window=${REVIEWER_LOG_WINDOW})`)
  printNotice(`Current lessons file: ${lessonsExists ? `${lessonsContent.length} bytes` : 'absent'}`)

  const gate = shouldRunCompaction({
    entryCount,
    reviewerLogCount: reviewerLog.length,
    minEntriesForCompaction: MIN_ENTRIES_FOR_COMPACTION,
    dryRun: DRY_RUN,
  })
  if (!gate.run) {
    if (gate.reason === 'below-threshold') {
      printNotice(
        `Below MIN_ENTRIES_FOR_COMPACTION=${gate.threshold} (skip-list=${entryCount} + reviewer-log=${reviewerLog.length}) — not enough signal to surface patterns. ✨`,
      )
    } else {
      printNotice('DRY_RUN=1 — exiting before invoking Claude.')
    }
    return
  }

  mkdirSync(TRANSCRIPTS_DIR, { recursive: true })
  const promptTemplate = readFileSync(PROMPT_PATH, 'utf-8')
  const transcriptPath = resolve(TRANSCRIPTS_DIR, `${RUN_TIMESTAMP}-fix-bot-compact.jsonl`)
  printTranscriptPath(transcriptPath)

  const runStart = Date.now()
  const prompt = composePrompt({
    promptTemplate,
    skipListPath: SKIP_LIST_PATH,
    lessonsPath: LESSONS_PATH,
    skipList,
    reviewerLog,
    lessonsContent,
    runId: process.env.GITHUB_RUN_ID ?? 'local',
  })

  let claudeSucceeded = false
  try {
    const result = await runClaude({
      model: LIGHT_MODEL,
      prompt,
      transcriptPath,
      allowedTools: ['Bash', 'Read', 'Write', 'Edit'],
    })
    if (!result.success) {
      printWarning(`Claude exited ${result.exitCode}; transcript at ${transcriptPath}`)
    } else {
      claudeSucceeded = true
    }
  } catch (err) {
    printWarning(`compact threw: ${err}; transcript at ${transcriptPath}`)
  }

  const outcome = handlePostClaude({
    claudeSucceeded,
    reviewerLogPath: REVIEWER_LOG_ABS,
    keepLast: REVIEWER_LOG_KEEP_LAST,
  })
  const pruneNotes: string[] = []
  if (outcome.prune) {
    const { dropped, kept } = outcome.prune
    if (dropped > 0) {
      printNotice(`Pruned reviewer-log: dropped ${dropped} old entries, kept ${kept} most-recent`)
      pruneNotes.push(`Pruned reviewer-log: ${dropped} dropped, ${kept} kept`)
    } else {
      printNotice(`Reviewer-log under prune threshold (${kept}/${REVIEWER_LOG_KEEP_LAST}) — no entries dropped`)
    }
  } else {
    printNotice("Claude did not succeed — skipping reviewer-log prune to preserve next month's input")
  }

  const totalSec = Math.round((Date.now() - runStart) / 1000)
  printRunSummary({
    verb: 'Compacted',
    processed: 1,
    total: 1,
    skipped: 0,
    notes: [`Transcript: ${transcriptPath}`, ...pruneNotes],
    elapsedSec: totalSec,
  })
}

main().catch(err => {
  console.error('Fatal error:', err)
  process.exit(1)
})
