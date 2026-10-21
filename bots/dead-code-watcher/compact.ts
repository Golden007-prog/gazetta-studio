/**
 * dead-code-watcher's memory-compaction pass.
 *
 * Runs monthly (per `.github/workflows/bots-compact.yml`). Reads
 * three durable memory surfaces and produces TWO outputs in one PR:
 *
 *   1. Skip-list compaction: groups of ≥3 skip-list entries sharing
 *      a pattern collapse into glob rules. Same shape as v1.
 *
 *   2. Lessons-learned rewrite: holistic regeneration of
 *      `lessons-learned.md` from the reviewer-log's valuable signal
 *      (reject→retry→approve sequences, substantive APPROVE caveats,
 *      loop-exhausted failure modes). Same shape as fix-bot's
 *      compactor — surfaces cross-finding patterns into Agent A's
 *      proactive context.
 *
 * The compactor is the value filter. The reviewer-log is the raw
 * append-only signal. The compactor decides which entries deserve
 * to become lessons; trivial first-attempt approves with "looks
 * good" reasoning never make it to lessons-learned.
 *
 * Conservatism applies to both:
 *  - Skip-list rules: only when 3+ entries share a clear pattern
 *  - Lessons: only when 2+ reviewer-log entries share a failure mode
 *
 * Run locally:
 *   GITHUB_REPOSITORY=gazetta-studio/gazetta-studio \
 *     GH_TOKEN=$(gh auth token) npm run dead-code-watcher:compact -w @gazetta/bots
 * Run in CI:
 *   .github/workflows/bots-compact.yml (1st Sat 03:00 UTC)
 */
import { existsSync, mkdirSync, readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { LIGHT_MODEL, runClaude } from '../_lib/claude.js'
import { handlePostClaude } from './post-claude.js'
import { REVIEWER_LOG_PATH, tailReviewerLog } from './reviewer-log.js'
import { readSkipList, SKIP_LIST_PATH } from './skip-list.js'
import { printBanner, printNotice, printRunSummary, printTranscriptPath, printWarning } from '../_lib/ui.js'

const HERE = dirname(fileURLToPath(import.meta.url))
const PROMPT_PATH = resolve(HERE, 'prompts/compact.md')
const REPO_ROOT = resolve(HERE, '../..')
const SKIP_LIST_ABS = resolve(REPO_ROOT, SKIP_LIST_PATH)
const REVIEWER_LOG_ABS = resolve(REPO_ROOT, REVIEWER_LOG_PATH)
const LESSONS_PATH = 'bots/dead-code-watcher/lessons-learned.md'
const LESSONS_ABS = resolve(REPO_ROOT, LESSONS_PATH)
const TRANSCRIPTS_DIR = resolve(HERE, '../transcripts')
const RUN_TIMESTAMP = new Date().toISOString().replace(/[:.]/g, '-')

const DRY_RUN = process.env.DRY_RUN === '1'

/**
 * Minimum skip-list entries to consider glob-rule compaction. Below
 * this we still run the lessons rewrite (it has its own threshold).
 */
const MIN_ENTRIES_FOR_COMPACTION = Number(process.env.MIN_ENTRIES_FOR_COMPACTION ?? '3')

/**
 * Minimum reviewer-log entries to consider rewriting lessons-learned.
 * Below this the signal-to-noise ratio is too low — keep the
 * existing lessons file untouched.
 */
const MIN_REVIEWER_LOG_FOR_LESSONS = Number(process.env.MIN_REVIEWER_LOG_FOR_LESSONS ?? '5')

/**
 * How many recent reviewer-log entries the compactor reads. Older
 * entries don't inform lessons — they may reflect outdated patterns.
 */
const REVIEWER_LOG_WINDOW = Number(process.env.REVIEWER_LOG_WINDOW ?? '100')

/**
 * How many entries the compactor keeps in the file after pruning.
 * Set to 2× the read window so the next monthly run has headroom
 * for new appends without losing recent-but-not-most-recent context.
 * Older entries are dropped — the compactor IS the memory-trimmer
 * for this surface.
 */
const REVIEWER_LOG_KEEP_LAST = Number(process.env.REVIEWER_LOG_KEEP_LAST ?? '200')

async function main(): Promise<void> {
  printBanner({
    name: 'dead-code-watcher:compact',
    tagline: 'monthly memory compactor',
    purpose: 'Generalize skip-list entries into rules + rewrite lessons-learned from reviewer-log.',
    inputs: [
      'bots/dead-code-watcher/skip-list.json (per-finding rejections)',
      'bots/dead-code-watcher/reviewer-log.jsonl (Agent B verdicts)',
      'bots/dead-code-watcher/lessons-learned.md (previous lessons)',
    ],
    outputs: [
      'PR replacing N specific entries with M general rules (compactedFrom: N)',
      'PR rewriting lessons-learned.md with current recurring patterns',
    ],
  })

  const skipList = readSkipList(SKIP_LIST_ABS)
  const entryCount = skipList.entries.length
  const ruleCount = skipList.rules.length
  const reviewerLog = tailReviewerLog(REVIEWER_LOG_ABS, REVIEWER_LOG_WINDOW)
  const lessonsExists = existsSync(LESSONS_ABS)
  const lessonsContent = lessonsExists ? readFileSync(LESSONS_ABS, 'utf-8') : ''

  printNotice(`Current skip-list: ${entryCount} entries + ${ruleCount} rules`)
  printNotice(`Reviewer-log: ${reviewerLog.length} recent entries (window=${REVIEWER_LOG_WINDOW})`)
  printNotice(`Lessons file: ${lessonsExists ? `${lessonsContent.length} bytes` : 'absent'}`)

  const skipListEligible = entryCount >= MIN_ENTRIES_FOR_COMPACTION
  const lessonsEligible = reviewerLog.length >= MIN_REVIEWER_LOG_FOR_LESSONS

  if (!skipListEligible && !lessonsEligible) {
    printNotice(
      `Below both thresholds (skip-list ${entryCount}/${MIN_ENTRIES_FOR_COMPACTION}, reviewer-log ${reviewerLog.length}/${MIN_REVIEWER_LOG_FOR_LESSONS}) — nothing to compact. ✨`,
    )
    return
  }

  if (!skipListEligible) {
    printNotice(
      `Skip-list below threshold (${entryCount}/${MIN_ENTRIES_FOR_COMPACTION}) — skipping rule compaction; doing lessons only.`,
    )
  }
  if (!lessonsEligible) {
    printNotice(
      `Reviewer-log below threshold (${reviewerLog.length}/${MIN_REVIEWER_LOG_FOR_LESSONS}) — skipping lessons rewrite; doing rule compaction only.`,
    )
  }

  if (DRY_RUN) {
    printNotice('DRY_RUN=1 — exiting before invoking Claude.')
    return
  }

  // Hand the full memory surface to Claude. Skip-list + reviewer-log
  // are both small (under 100 entries typically); previous lessons
  // are bounded under 4KB. No context pressure.
  mkdirSync(TRANSCRIPTS_DIR, { recursive: true })
  const promptTemplate = readFileSync(PROMPT_PATH, 'utf-8')
  const transcriptPath = resolve(TRANSCRIPTS_DIR, `${RUN_TIMESTAMP}-dead-code-compact.jsonl`)
  printTranscriptPath(transcriptPath)

  const runStart = Date.now()
  const prompt = `${promptTemplate}

SKIP_LIST_PATH=${SKIP_LIST_PATH}
LESSONS_PATH=${LESSONS_PATH}
SKIP_LIST_ELIGIBLE=${skipListEligible}
LESSONS_ELIGIBLE=${lessonsEligible}
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

  const outcome = handlePostClaude({
    claudeSucceeded,
    lessonsPath: LESSONS_ABS,
    reviewerLogPath: REVIEWER_LOG_ABS,
    keepLast: REVIEWER_LOG_KEEP_LAST,
  })

  if (outcome.violations.length > 0) {
    for (const v of outcome.violations) {
      printWarning(
        `Signal-count drift in ${LESSONS_PATH}: header says ${v.header}, sub-tallies sum to ${v.sum} — "${v.line.trim()}"`,
      )
    }
    printWarning(
      `${outcome.violations.length} Signal-count violation(s) — failing the compaction run so the PR does not open with drift. Fix lessons-learned.md so each Signal header equals the sum of its sub-tallies.`,
    )
    process.exit(outcome.exitCode)
  }

  const pruneNotes: string[] = []
  if (outcome.prune) {
    const { dropped, kept } = outcome.prune
    if (dropped > 0) {
      printNotice(`Pruned reviewer-log: dropped ${dropped} old entries, kept ${kept} most-recent`)
      pruneNotes.push(`Pruned reviewer-log: ${dropped} dropped, ${kept} kept`)
    } else {
      printNotice(`Reviewer-log under prune threshold (${kept}/${REVIEWER_LOG_KEEP_LAST}) — no entries dropped`)
    }
  } else if (!claudeSucceeded) {
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
