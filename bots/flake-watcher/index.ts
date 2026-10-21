/**
 * flake-watcher — daily CI flake detection.
 *
 * Strategy: rerun-then-passed. A workflow run with `run_attempt >= 2` means
 * an earlier attempt failed on the SAME SHA and someone hit "Re-run". This
 * is the strongest possible flake signal — same code, different outcome,
 * in the same workflow.
 *
 * Why not "two distinct same-SHA runs": GitHub Actions reruns are additional
 * attempts under the SAME run ID, not new runs. Looking for two distinct run
 * IDs with the same SHA returns cross-workflow noise (CI failure + Deploy
 * success on one commit isn't a flake).
 *
 * When a flake is found, hand the run to `claude -p` with the prompt in
 * `prompt.md`. Claude reads failed-attempt logs, searches existing open
 * issues for a match, and either comments on the existing issue (with
 * dedup against the run ID) or files a new one per the producer-bot
 * pattern (self-classifies as bug + applies ready-for-agent).
 *
 * Run locally:
 *   DRY_RUN=1 LOOKBACK_HOURS=336 npm run flake-watcher -w @gazetta/bots
 * Run in CI:
 *   .github/workflows/flake-watcher.yml (daily 12:00 UTC)
 */
import { mkdirSync, readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { LIGHT_MODEL, runClaude } from '../_lib/claude.js'
import { findFlakeCandidates, findWorkflowId, octokitFromEnv, repoFromEnv } from '../_lib/github.js'
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

const LOOKBACK_HOURS = Number(process.env.LOOKBACK_HOURS ?? '48')
const WORKFLOW_NAME = process.env.WORKFLOW_NAME ?? 'CI'
const DRY_RUN = process.env.DRY_RUN === '1'
// Transcripts are uploaded as a workflow artifact. One JSONL per investigated
// run, named by the run ID + ISO date so a future agent can browse them.
const TRANSCRIPTS_DIR = resolve(HERE, '../transcripts')
const RUN_TIMESTAMP = new Date().toISOString().replace(/[:.]/g, '-')

async function main(): Promise<void> {
  printBanner({
    name: 'flake-watcher',
    tagline: 'producer bot · self-classifies',
    purpose: `Find CI flakes (run_attempt >= 2) and file/comment issues.`,
    inputs: [
      `${WORKFLOW_NAME} runs in the last ${LOOKBACK_HOURS}h with run_attempt >= 2`,
      'Open issues matching the failed test path (for dedup)',
    ],
    outputs: [
      'New issue with `bug` + `flake` + `area: X` + `ready-for-agent`',
      'Or comment on existing matching issue (run-ID-deduped)',
    ],
  })

  const repo = repoFromEnv()
  const octokit = octokitFromEnv()
  const workflowId = await findWorkflowId(octokit, repo, WORKFLOW_NAME)

  const sinceMs = Date.now() - LOOKBACK_HOURS * 60 * 60 * 1000
  const sinceIso = new Date(sinceMs).toISOString().replace(/\.\d{3}Z$/, 'Z')

  printNotice(`Scanning ${WORKFLOW_NAME} (workflow id ${workflowId}) since ${sinceIso}`)

  const flakes = await findFlakeCandidates(octokit, repo, workflowId, sinceIso)

  if (flakes.length === 0) {
    printNotice(`No flakes found in last ${LOOKBACK_HOURS}h. CI is healthy. ✨`)
    return
  }

  printCandidateList({
    noun: 'flake',
    candidates: flakes.map(f => ({
      ref: `run ${f.runId}`,
      label: `sha ${f.headSha.slice(0, 8)}`,
      meta: `attempt ${f.runAttempt}, ${f.conclusion}`,
    })),
  })

  if (DRY_RUN) {
    printNotice(`DRY_RUN=1 — exiting before invoking Claude (${flakes.length} flake(s) would be processed).`)
    return
  }

  const promptTemplate = readFileSync(PROMPT_PATH, 'utf-8')
  mkdirSync(TRANSCRIPTS_DIR, { recursive: true })

  const runStart = Date.now()
  let processed = 0
  for (const flake of flakes) {
    const elapsed = Math.round((Date.now() - runStart) / 1000)
    printCandidateHeader({
      index: processed + 1,
      total: flakes.length,
      label: `Investigating run ${flake.runId}`,
      meta: [`sha ${flake.headSha.slice(0, 8)}, attempt ${flake.runAttempt}, ${flake.conclusion}`],
      elapsedSec: elapsed,
    })

    const prompt = `${promptTemplate}

RUN_ID=${flake.runId}
LOOKBACK_HOURS=${LOOKBACK_HOURS}`

    const transcriptPath = resolve(TRANSCRIPTS_DIR, `${RUN_TIMESTAMP}-run-${flake.runId}.jsonl`)
    printTranscriptPath(transcriptPath)

    try {
      const result = await runClaude({ model: LIGHT_MODEL, prompt, transcriptPath })
      if (!result.success) {
        // Don't let one failed investigation kill the whole job.
        printWarning(`investigation of run ${flake.runId} exited ${result.exitCode}; continuing.`)
      }
    } catch (err) {
      printWarning(`investigation of run ${flake.runId} threw: ${err}; continuing.`)
    }
    processed++
  }

  const total = Math.round((Date.now() - runStart) / 1000)
  printRunSummary({
    verb: 'Investigated',
    processed,
    total: flakes.length,
    skipped: flakes.length - processed,
    notes: [`Transcripts: ${TRANSCRIPTS_DIR}`],
    elapsedSec: total,
  })
}

main().catch(err => {
  console.error('Fatal error:', err)
  process.exit(1)
})
