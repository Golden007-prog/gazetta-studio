/**
 * review-bot's memory-compaction pass.
 *
 * Runs monthly alongside fix-bot's + dead-code-watcher's compactors
 * (per `.github/workflows/bots-compact.yml`). Reads the per-candidate
 * skip-list + recent reviewer-log entries and rewrites
 * `bots/review-bot/lessons-learned.md` holistically — pruning lessons
 * that no longer apply, adding new ones that recur across attempts.
 *
 * Same shape as fix-bot's compactor: holistic rewrite (not append) so
 * the lessons file stays fresh as the codebase evolves. Git history
 * preserves dropped lessons; they're not lost, just no longer in
 * Agent A's active prompt context.
 *
 * Different from dead-code-watcher's compactor: review-bot's skip-list
 * isn't compacted into glob-rules (most rejections are per-candidate-
 * unique). The valuable compaction here is cross-candidate pattern
 * surfacing into prose that becomes part of Agent A's prompt context.
 *
 * Run locally:
 *   GITHUB_REPOSITORY=gazetta-studio/gazetta-studio \
 *     GH_TOKEN=$(gh auth token) npm run review-bot:compact -w @gazetta/bots
 * Run in CI:
 *   .github/workflows/bots-compact.yml (1st Sat of each month)
 */
import { existsSync, mkdirSync, readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { LIGHT_MODEL, runClaude } from '../_lib/claude.js'
import { printBanner, printNotice, printRunSummary, printTranscriptPath, printWarning } from '../_lib/ui.js'
import { pruneReviewerLog, REVIEWER_LOG_PATH, tailReviewerLog } from './reviewer-log.js'
import { readSkipList, SKIP_LIST_PATH } from './skip-list.js'

const HERE = dirname(fileURLToPath(import.meta.url))
const PROMPT_PATH = resolve(HERE, 'prompts/compact.md')
const REPO_ROOT = resolve(HERE, '../..')
const SKIP_LIST_ABS = resolve(REPO_ROOT, SKIP_LIST_PATH)
const REVIEWER_LOG_ABS = resolve(REPO_ROOT, REVIEWER_LOG_PATH)
const LESSONS_PATH = 'bots/review-bot/lessons-learned.md'
const LESSONS_ABS = resolve(REPO_ROOT, LESSONS_PATH)
const TRANSCRIPTS_DIR = resolve(HERE, '../transcripts')
const RUN_TIMESTAMP = new Date().toISOString().replace(/[:.]/g, '-').replace(/Z$/, 'Z')

const DRY_RUN = process.env.DRY_RUN === '1'

/**
 * Minimum entries required to consider running the compactor. Below
 * this we exit early without invoking Claude — not enough signal to
 * surface patterns from. Counts skip-list entries + reviewer-log
 * entries together; either signal is enough to justify a rewrite.
 */
const MIN_ENTRIES_FOR_COMPACTION = Number(process.env.MIN_ENTRIES_FOR_COMPACTION ?? '3')

/**
 * How many recent reviewer-log entries the compactor reads. Older
 * entries don't inform lessons — they may reflect outdated patterns
 * from past prompt iterations.
 */
const REVIEWER_LOG_WINDOW = Number(process.env.REVIEWER_LOG_WINDOW ?? '100')

/**
 * How many entries the compactor keeps after pruning. 2× the read
 * window so the next monthly run has headroom. Older entries
 * dropped — the compactor IS the memory-trimmer for this surface.
 */
const REVIEWER_LOG_KEEP_LAST = Number(process.env.REVIEWER_LOG_KEEP_LAST ?? '200')

async function main(): Promise<void> {
  printBanner({
    name: 'review-bot:compact',
    tagline: 'monthly memory compactor',
    purpose: 'Rewrite lessons-learned.md from skip-list + reviewer-log patterns; keep cross-candidate memory fresh.',
    inputs: [
      'bots/review-bot/skip-list.json (per-candidate rejections)',
      'bots/review-bot/reviewer-log.jsonl (Agent B verdicts)',
      'bots/review-bot/lessons-learned.md (previous lessons)',
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

  // Either signal can justify a rewrite — they capture complementary
  // patterns (skip-list = "don't try again"; reviewer-log = "what to
  // notice next time").
  const totalSignal = entryCount + reviewerLog.length
  if (totalSignal < MIN_ENTRIES_FOR_COMPACTION) {
    printNotice(
      `Below MIN_ENTRIES_FOR_COMPACTION=${MIN_ENTRIES_FOR_COMPACTION} (skip-list=${entryCount} + reviewer-log=${reviewerLog.length}) — not enough signal to surface patterns. ✨`,
    )
    return
  }

  if (DRY_RUN) {
    printNotice('DRY_RUN=1 — exiting before invoking Claude.')
    return
  }

  mkdirSync(TRANSCRIPTS_DIR, { recursive: true })
  const promptTemplate = readFileSync(PROMPT_PATH, 'utf-8')
  const transcriptPath = resolve(TRANSCRIPTS_DIR, `${RUN_TIMESTAMP}-review-bot-compact.jsonl`)
  printTranscriptPath(transcriptPath)

  const runStart = Date.now()
  const prompt = `${promptTemplate}

SKIP_LIST_PATH=${SKIP_LIST_PATH}
LESSONS_PATH=${LESSONS_PATH}
SKIP_LIST_JSON=${JSON.stringify(skipList, null, 2)}
REVIEWER_LOG_JSON=${JSON.stringify(reviewerLog, null, 2)}
PREVIOUS_LESSONS=
${lessonsContent}
RUN_ID=${process.env.GITHUB_RUN_ID ?? 'local'}`

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

  // Prune the reviewer-log AFTER Claude succeeds. If Claude failed,
  // keep the full log so next month's run can retry with the same
  // input. Pruning on success keeps the cached file bounded across
  // many months.
  const pruneNotes: string[] = []
  if (claudeSucceeded) {
    const { dropped, kept } = pruneReviewerLog(REVIEWER_LOG_ABS, REVIEWER_LOG_KEEP_LAST)
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
