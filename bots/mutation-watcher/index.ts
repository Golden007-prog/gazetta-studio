/**
 * mutation-watcher — daily review of Stryker mutation-testing results.
 *
 * Pairs with the existing `Mutation` workflow (`.github/workflows/mutation.yml`)
 * which runs Stryker nightly at 03:00 UTC and uploads an HTML report as the
 * `mutation-report` artifact. This bot runs at 03:30 UTC, fetches that
 * artifact, parses it server-side, and hands ONE per-file summary at a
 * time to `claude -p` to file/comment issues.
 *
 * Why parse-in-orchestrator (not parse-in-prompt):
 *
 *   The first iteration asked Claude to read the 3 MB mutation.html and
 *   parse it. That blew the context window — Claude correctly diagnosed
 *   the Stryker `"+"` quirk (string concat in JSON-shaped JS) and
 *   pivoted to vm.runInNewContext, but by the time it had a parsed
 *   summary + read source files for issue bodies, autocompact thrashed
 *   and the run failed with zero issues filed (run 25637089951).
 *
 *   This iteration moves the deterministic transformation (HTML → small
 *   per-file summary) into TS code. Claude receives a tiny JSON for ONE
 *   file at a time, writes a focused issue body, applies labels, and
 *   moves on. Same architecture as triage-bot's per-issue Claude call.
 *
 * Producer-bot pattern:
 *   Self-classifies output as `bug` + `area: X` + `ready-for-agent`,
 *   bypassing triage-bot. The mutation report IS the validation that
 *   the surviving mutant represents a real test gap. Goes straight
 *   into fix-bot's queue.
 *
 * Per-run budget: process at most N files per cron (default 5).
 * Backlog converges over multiple daily runs the same way triage-bot's
 * does. Files are sorted oldest-first by impact (most gaps first), so
 * the worst-coverage files always get attention first regardless of
 * when the bot was last run.
 *
 * Run locally:
 *   DRY_RUN=1 GITHUB_REPOSITORY=gazetta-studio/gazetta-studio \
 *     GH_TOKEN=$(gh auth token) npm run mutation-watcher -w @gazetta/bots
 * Run in CI:
 *   .github/workflows/mutation-watcher.yml (daily 03:30 UTC)
 */
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { LIGHT_MODEL, runClaude } from '../_lib/claude.js'
import { findWorkflowId, octokitFromEnv, repoFromEnv } from '../_lib/github.js'
import { type FileSummary, parseStrykerReport, pathToArea, summarizeReport } from './stryker-parse.js'
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
const REPO_ROOT = resolve(HERE, '../..')

const WORKFLOW_NAME = process.env.WORKFLOW_NAME ?? 'Mutation'
const ARTIFACT_NAME = process.env.ARTIFACT_NAME ?? 'mutation-report'
const DRY_RUN = process.env.DRY_RUN === '1'
const TRANSCRIPTS_DIR = resolve(HERE, '../transcripts')
const REPORT_STAGING_DIR = resolve(HERE, '../mutation-report-staging')
const RUN_TIMESTAMP = new Date().toISOString().replace(/[:.]/g, '-')

/**
 * Per-run cap on how many actionable files Claude is asked to process.
 * Each file = one Claude call (writes one issue or one comment), so
 * higher = longer runs. Mutation reports today have ~36 actionable
 * files; processing 5/run drains the backlog in ~7 days while the
 * Mutation workflow itself runs daily, so the queue stays steady-state.
 */
const PER_RUN_FILE_CAP = Number(process.env.PER_RUN_FILE_CAP ?? '5')

/**
 * Per-run wall-clock budget. Workflow timeout is 30 min; we exit
 * gracefully at 25 min to leave 5 min margin for the upload-artifacts
 * step.
 */
const PER_RUN_BUDGET_MS = Number(process.env.BUDGET_MS ?? 25 * 60 * 1000)

async function main(): Promise<void> {
  printBanner({
    name: 'mutation-watcher',
    tagline: 'producer bot · self-classifies',
    purpose: 'Review Stryker mutation report; file issues for surviving mutants.',
    inputs: [
      `Latest successful ${WORKFLOW_NAME} workflow run's mutation-report artifact`,
      'Open issues for the affected source files (for dedup)',
    ],
    outputs: [
      'New issue per source file with surviving mutants — `bug` + `area: X` + `ready-for-agent`',
      'Or comment on existing matching issue (source-run-deduped)',
    ],
  })

  const repo = repoFromEnv()
  const octokit = octokitFromEnv()
  const workflowId = await findWorkflowId(octokit, repo, WORKFLOW_NAME)

  printNotice(`Looking up latest successful ${WORKFLOW_NAME} run (workflow id ${workflowId})`)

  const { data: runs } = await octokit.actions.listWorkflowRuns({
    ...repo,
    workflow_id: workflowId,
    status: 'success',
    per_page: 1,
  })
  const sourceRun = runs.workflow_runs[0]
  if (!sourceRun) {
    printNotice(`No successful ${WORKFLOW_NAME} runs found. Nothing to analyze.`)
    return
  }

  printNotice(`Source run: ${sourceRun.id} · sha ${sourceRun.head_sha.slice(0, 8)} · ${sourceRun.created_at}`)

  // Stage the report on disk + parse it.
  if (existsSync(REPORT_STAGING_DIR)) {
    rmSync(REPORT_STAGING_DIR, { recursive: true, force: true })
  }
  mkdirSync(REPORT_STAGING_DIR, { recursive: true })

  printNotice(`Downloading ${ARTIFACT_NAME} from run ${sourceRun.id}…`)
  const dl = spawnSync('gh', ['run', 'download', String(sourceRun.id), '-n', ARTIFACT_NAME, '-D', REPORT_STAGING_DIR], {
    cwd: REPO_ROOT,
    stdio: 'inherit',
  })
  if (dl.status !== 0) {
    printWarning(`Failed to download ${ARTIFACT_NAME} from run ${sourceRun.id}.`)
    printWarning('Is the artifact still available (30-day retention)?')
    process.exit(1)
  }

  const htmlPath = findReportHtml(REPORT_STAGING_DIR)
  if (!htmlPath) {
    printWarning(`No mutation.html found under ${REPORT_STAGING_DIR}. Listing:`)
    for (const entry of readdirSync(REPORT_STAGING_DIR, { recursive: true, withFileTypes: true })) {
      const path = entry.parentPath ? resolve(entry.parentPath, entry.name) : entry.name
      console.error(`  ${path}`)
    }
    process.exit(1)
  }

  // Parse + summarize. Claude never sees the raw 3 MB report.
  printNotice(`Parsing ${htmlPath}…`)
  const report = parseStrykerReport(htmlPath)
  const summary = summarizeReport(report)

  printNotice(
    `Stryker analysis: ${summary.totalFiles} files mutated · ${summary.totalSurvived} survived · ${summary.totalNoCoverage} no-coverage · ${summary.skippedHighScoreFiles} files filtered (mostly-tested)`,
  )

  if (summary.files.length === 0) {
    printNotice('No actionable files. Coverage is healthy. ✨')
    return
  }

  const candidates = summary.files.slice(0, PER_RUN_FILE_CAP)
  if (summary.files.length > PER_RUN_FILE_CAP) {
    printNotice(
      `Capping to top ${PER_RUN_FILE_CAP} of ${summary.files.length} actionable files this run; remainder picked up by future cron.`,
    )
  }

  printCandidateList({
    noun: 'file',
    candidates: candidates.map(f => ({
      ref: f.path,
      label: `${f.survivedCount + f.noCoverageCount} gaps`,
      meta: `kill-ratio ${(f.killRatio * 100).toFixed(0)}% · ${pathToArea(f.path)}`,
    })),
  })

  if (DRY_RUN) {
    printNotice(`DRY_RUN=1 — exiting before invoking Claude (${candidates.length} files would be processed).`)
    return
  }

  mkdirSync(TRANSCRIPTS_DIR, { recursive: true })
  const promptTemplate = await import('node:fs').then(fs => fs.readFileSync(PROMPT_PATH, 'utf-8'))

  const runStart = Date.now()
  let processed = 0
  for (const file of candidates) {
    const elapsed = Date.now() - runStart
    if (elapsed > PER_RUN_BUDGET_MS) {
      const remaining = candidates.length - processed
      printWarning(
        `Per-run budget exhausted (${Math.round(elapsed / 1000)}s > ${Math.round(PER_RUN_BUDGET_MS / 1000)}s). Stopping with ${remaining} unprocessed; tomorrow's run picks them up.`,
      )
      for (const skipped of candidates.slice(processed)) {
        console.log(`     ⏭  ${skipped.path}`)
      }
      break
    }

    printCandidateHeader({
      index: processed + 1,
      total: candidates.length,
      label: file.path,
      meta: [
        `${file.survivedCount + file.noCoverageCount} gaps · kill-ratio ${(file.killRatio * 100).toFixed(0)}% · ${pathToArea(file.path)}`,
      ],
      elapsedSec: Math.round(elapsed / 1000),
    })

    try {
      await fileOneIssue(file, sourceRun, promptTemplate)
    } catch (err) {
      printWarning(`processing ${file.path} threw: ${err}; continuing.`)
    }
    processed++
  }

  const totalSec = Math.round((Date.now() - runStart) / 1000)
  printRunSummary({
    verb: 'Processed',
    processed,
    total: candidates.length,
    skipped: candidates.length - processed,
    notes: [
      `Source run: ${sourceRun.id}`,
      summary.files.length > PER_RUN_FILE_CAP
        ? `${summary.files.length - PER_RUN_FILE_CAP} more file(s) queued for tomorrow's cron`
        : 'All actionable files processed this run',
    ],
    elapsedSec: totalSec,
  })
}

/**
 * Hand one file's per-file summary to Claude. The prompt instructs
 * Claude to: search for an existing issue tracking this file, decide
 * file-vs-comment, write the body using the supplied mutant table,
 * apply labels.
 */
async function fileOneIssue(
  file: FileSummary,
  sourceRun: { id: number; head_sha: string; created_at: string | null | undefined },
  promptTemplate: string,
): Promise<void> {
  // Build the per-file payload Claude will consume. JSON is small
  // (single file, capped mutants), so total prompt stays well under
  // any context concern.
  const payload = {
    sourceRunId: sourceRun.id,
    sourceRunSha: sourceRun.head_sha,
    sourceRunSha8: sourceRun.head_sha.slice(0, 8),
    sourceRunCreatedAt: sourceRun.created_at,
    file: {
      path: file.path,
      filename: file.path.split('/').pop() ?? file.path,
      areaLabel: pathToArea(file.path),
      totalMutants: file.totalMutants,
      killedCount: file.killedCount,
      survivedCount: file.survivedCount,
      noCoverageCount: file.noCoverageCount,
      killRatioPct: Math.round(file.killRatio * 100),
      mutants: file.mutants,
      mutantsTruncatedFromCount: file.survivedCount + file.noCoverageCount - file.mutants.length,
    },
  }

  const transcriptPath = resolve(TRANSCRIPTS_DIR, `${RUN_TIMESTAMP}-mutation-${file.path.replace(/[/.]/g, '-')}.jsonl`)
  printTranscriptPath(transcriptPath)

  const prompt = `${promptTemplate}

PAYLOAD_JSON=${JSON.stringify(payload, null, 2)}
CLOSED_FOLLOWUP_WINDOW_DAYS=${process.env.CLOSED_FOLLOWUP_WINDOW_DAYS ?? '30'}
WATCHER_RUN_ID=${process.env.GITHUB_RUN_ID ?? 'local'}`

  // Stage the payload to a file too — Claude can re-read it via Read
  // if the prompt's inline JSON gets truncated by some upstream layer.
  // (Defense in depth; the inline JSON is small enough that this
  // shouldn't trigger.)
  writeFileSync(resolve(TRANSCRIPTS_DIR, `${RUN_TIMESTAMP}-payload-${file.path.replace(/[/.]/g, '-')}.json`), prompt)

  const result = await runClaude({
    model: LIGHT_MODEL,
    prompt,
    transcriptPath,
    // Bash for `gh` (issue search/file/comment/label), Read for
    // optionally checking ONE source file when writing fix
    // recommendations. No Grep/Glob — the orchestrator already
    // identified the affected file path.
    allowedTools: ['Bash', 'Read'],
  })
  if (!result.success) {
    printWarning(`Claude exited ${result.exitCode} on ${file.path}; transcript at ${transcriptPath}`)
  }
}

/**
 * Walk the staging dir looking for `mutation.html`. Stryker's HTML reporter
 * always writes that filename; the artifact contents may or may not include
 * a wrapping subdirectory depending on how the workflow uploaded it.
 */
function findReportHtml(root: string): string | null {
  for (const entry of readdirSync(root, { recursive: true, withFileTypes: true })) {
    if (entry.isFile() && entry.name === 'mutation.html') {
      const parent = entry.parentPath ?? root
      return resolve(parent, entry.name)
    }
  }
  return null
}

main().catch(err => {
  console.error('Fatal error:', err)
  process.exit(1)
})
