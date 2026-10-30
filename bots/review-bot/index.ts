/**
 * review-bot — autonomous code-improvement producer.
 *
 * Pipeline (per design-code-review.md "Review-bot (autonomous)"):
 *
 *   Phase 0  — Pick an area                          [Cut 18 — IMPLEMENTED]
 *              TS: score top 5 areas by recency + bot-touched + skip-list
 *              LLM: pick one with one-line context per candidate
 *
 *   Phase 1  — Discovery                             [Cut 19 — IMPLEMENTED]
 *              Skill: audit-area <picked-area>
 *              Output: ranked candidate improvements
 *
 *   Phase 2  — Pick top candidate                    [Cut 19 — IMPLEMENTED]
 *              TS: sort by (severity, confidence); skip skip-list matches;
 *              consult past-PR feedback loop
 *
 *   Phase 3  — Make the change (Agent A)             [Cut 19 — IMPLEMENTED]
 *              Prompt: prompts/agent-a.md with injected candidate +
 *              lessons-learned.md. TDD-first ordering.
 *
 *   Phase 4  — Review the diff (Agent B)             [Cut 19 — IMPLEMENTED]
 *              Skill: review-orchestrator on git diff main...improve/<id>
 *              Output: aggregated findings via JSONL fence
 *
 *   Phase 5  — Verdict + action                      [Cut 19 — IMPLEMENTED]
 *              CRITICAL with design-doc rule → NEEDS_HUMAN (skip-list)
 *              CRITICAL otherwise / only IMPORTANT  → REJECT (retry)
 *              NIT only / empty                      → APPROVE → push + open PR
 *
 * Generator-critic pattern matches dead-code-watcher + fix-bot
 * (per ADR-0011 + bots/README.md). Same memory model: skip-list
 * committed to repo; reviewer-log cached via actions/cache;
 * lessons-learned.md committed and rewritten by the monthly
 * compactor (Cut 22).
 *
 * Single-instance invariant: workflow concurrency group 'review-bot'
 * with cancel-in-progress: false (per ADR-0011).
 */
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { LIGHT_MODEL, runClaude } from '../_lib/claude.js'
import {
  branchHasCommits as branchHasCommitsLib,
  captureCommitMessages,
  captureDiff,
  resetToMain,
} from '../_lib/git-tree.js'
import { octokitFromEnv, repoFromEnv } from '../_lib/github.js'
import { extractLastAssistantText } from '../_lib/transcript.js'
import { printNotice, printWarning } from '../_lib/ui.js'
import { type AreaCandidate, scoreAreas } from './area-scorer.js'
import { type Candidate, extractCandidatesFence, parseCandidatesFence, rankCandidates } from './candidates.js'
import { collectBotPRsByArea, collectGitTouches, parsePickerOutput } from './phase0-collect.js'
import { fingerprintToBranch, pastPROutcome } from './past-pr.js'
import { checkDeletionOnly } from './deletion-gate.js'
import { type RecipeName, selectRecipe } from './recipe-select.js'
import { appendReviewerLog } from './reviewer-log.js'
import {
  type Fingerprint,
  isSkipped,
  readSkipList,
  recordSkipListEntry,
  type SkipList,
  writeSkipList,
} from './skip-list.js'
import { applyActionPolicy, extractFindingsFence, parseFindingsFence } from './verdict.js'

const HERE = dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = resolve(HERE, '..', '..')
const SKIPLIST_PATH = resolve(HERE, 'skip-list.json')
const LESSONS_PATH = resolve(HERE, 'lessons-learned.md')
const REVIEWER_LOG_PATH = resolve(HERE, 'reviewer-log.jsonl')
const PICKER_PROMPT_PATH = resolve(HERE, 'prompts', 'area-picker.md')
const AGENT_A_PROMPT_PATH = resolve(HERE, 'prompts', 'agent-a.md')
const RECIPES_DIR = resolve(HERE, 'prompts', 'recipes')
const TRANSCRIPT_DIR = resolve(HERE, '..', 'transcripts', 'review-bot')

const MAX_ATTEMPTS = Number(process.env.MAX_ATTEMPTS ?? '5')

async function main(): Promise<void> {
  const dryRun = process.env.DRY_RUN === '1'
  const runId = process.env.GITHUB_RUN_ID ?? 'local'

  printNotice(`review-bot starting (run ${runId}; MAX_ATTEMPTS=${MAX_ATTEMPTS}${dryRun ? '; DRY_RUN' : ''})`)

  const skipList = readSkipList(SKIPLIST_PATH)
  printNotice(`Skip-list: ${skipList.entries.length} entries, ${skipList.rules.length} rules.`)

  // Phase 0 — area pick
  const pickedArea = await phase0AreaPick(skipList, runId, dryRun)
  if (!pickedArea) {
    printNotice('Phase 0 produced no area; exiting cleanly.')
    process.exit(0)
  }

  if (dryRun) {
    printNotice(`DRY_RUN=1: stopping after Phase 0 with picked area ${pickedArea}.`)
    process.exit(0)
  }

  // Phase 1 — discovery
  const candidates = await phase1Discovery(pickedArea, runId)
  printNotice(`Phase 1: surfaced ${candidates.length} candidate(s).`)
  if (candidates.length === 0) {
    printNotice('Phase 1 produced no candidates; exiting cleanly.')
    process.exit(0)
  }

  // Phase 2 — pick top candidate
  const ranked = rankCandidates(candidates, c => isSkipped(skipList, { area: c.area, type: c.type, rule: c.rule }))
  if (ranked.length === 0) {
    printNotice('Phase 2: all candidates were skip-listed or low-confidence; exiting cleanly.')
    process.exit(0)
  }
  const candidate = ranked[0]!
  const fingerprint: Fingerprint = { area: candidate.area, type: candidate.type, rule: candidate.rule }
  printNotice(
    `Phase 2: top candidate = ${candidate.type}/${candidate.severity} in ${candidate.area} — "${candidate.summary}"`,
  )

  // Past-PR check
  const octokit = octokitFromEnv()
  const repo = repoFromEnv()
  const past = await pastPROutcome(octokit, repo, fingerprint)
  if (past.state === 'open') {
    printNotice(`Past-PR check: PR #${past.prNumber} is open for this candidate; skipping.`)
    process.exit(0)
  }
  if (past.state === 'merged') {
    printNotice(`Past-PR check: PR #${past.prNumber} was merged; this candidate is fixed. Skipping.`)
    process.exit(0)
  }
  if (past.state === 'rejected') {
    printNotice(`Past-PR check: PR #${past.prNumber} was rejected; recording skip-list entry + skipping.`)
    await openSkipListPR(octokit, repo, skipList, fingerprint, {
      reason: 'maintainer-rejected',
      reasonNote: past.reasonNote,
      refPR: past.prNumber,
    })
    process.exit(0)
  }

  // Phases 3-5: generator-critic loop
  const branchName = fingerprintToBranch(fingerprint)
  const lessons = readFileSync(LESSONS_PATH, 'utf-8')

  let priorReviewerNote: string | null = null
  let approved = false
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    printNotice(`Attempt ${attempt}/${MAX_ATTEMPTS}: invoking Agent A (improve) on ${branchName}...`)
    // resetToMain (from _lib/git-tree) discards uncommitted state +
    // deletes the in-flight branch + checks out main. Agent A's
    // prompt creates the branch itself (`git checkout -b $BRANCH_NAME`).
    resetToMain(branchName, { cwd: REPO_ROOT })

    const agentAResult = await phase3AgentA(candidate, branchName, attempt, priorReviewerNote, lessons, runId)
    if (!agentAResult.pushed) {
      printWarning(`Agent A did not push commits (RESULT: ${agentAResult.kind}). Recording skip + exiting.`)

      // Append to reviewer-log even though Agent B never ran. The
      // compactor reads this to surface cross-candidate patterns
      // (e.g. "tests-class candidates with no failing-test driver
      // route consistently STUCK before fix-bot rewrites the
      // recipe table"). Without this append, the stuck-path is
      // invisible to the monthly compactor — patterns can't form.
      // verdict = 'needs-human' for stuck/crashed/no-commits per
      // the reviewer-log schema (we have no Agent B verdict yet).
      appendReviewerLog(REVIEWER_LOG_PATH, {
        ts: new Date().toISOString(),
        runId,
        fingerprint,
        fingerprintLabel: `${candidate.type}/${candidate.area}`,
        attempt,
        verdict: 'needs-human',
        reasoning: `Agent A ${agentAResult.kind}: ${agentAResult.note}`,
        agentASummary: `(no commits — ${agentAResult.kind})`,
      })

      await openSkipListPR(octokit, repo, skipList, fingerprint, {
        reason: agentAResult.kind === 'stuck' ? 'stuck' : 'needs-human',
        reasonNote: agentAResult.note,
      })
      process.exit(0)
    }

    // mechanical-cleanup has no counterfactual; its diff must be pure
    // deletion, checked here rather than taken on Agent A's word.
    const recipeName = selectRecipe(candidate)
    if (recipeName === 'mechanical-cleanup') {
      const gate = checkDeletionOnly(captureNumstat(branchName))
      if (!gate.ok) {
        printNotice(`Deletion-only gate failed: ${gate.reason}. Retrying without Agent B.`)
        appendReviewerLog(REVIEWER_LOG_PATH, {
          ts: new Date().toISOString(),
          runId,
          fingerprint,
          fingerprintLabel: `${candidate.type}/${candidate.area}`,
          attempt,
          verdict: 'reject',
          reasoning: `deletion-only gate: ${gate.reason}`,
          agentASummary: agentAResult.summary ?? '(no summary)',
        })
        priorReviewerNote = `The deletion-only gate rejected the diff: ${gate.reason}. Delete lines only, or emit RESULT: STUCK if the candidate needs more than a deletion.`
        continue
      }
    }

    // Phase 4 — reviewer (Agent B) via review-orchestrator skill
    printNotice(`Attempt ${attempt}/${MAX_ATTEMPTS}: invoking Agent B (review-orchestrator) on ${branchName}...`)
    const reviewerOutput = await phase4Reviewer(branchName, runId, attempt, recipeName)

    // Phase 5 — apply action policy
    const fenceBody = extractFindingsFence(reviewerOutput)
    const findings = parseFindingsFence(fenceBody)
    const verdict = applyActionPolicy(findings)

    appendReviewerLog(REVIEWER_LOG_PATH, {
      ts: new Date().toISOString(),
      runId,
      fingerprint,
      fingerprintLabel: `${candidate.type}/${candidate.area}`,
      attempt,
      verdict: verdict.kind,
      reasoning: verdict.kind === 'approve' ? verdict.reasoning : verdict.note,
      agentASummary: agentAResult.summary ?? '(no summary)',
    })

    if (verdict.kind === 'approve') {
      printNotice(`Verdict: APPROVE. Pushing ${branchName} + opening PR...`)
      try {
        await phase5Push(
          branchName,
          candidate,
          fingerprint,
          {
            attempt,
            approveReasoning: verdict.reasoning,
            agentASummary: agentAResult.summary ?? '(no summary)',
          },
          octokit,
          repo,
        )
        approved = true
        break
      } catch (err) {
        // git push or PR creation crashed AFTER Agent A + Agent B both
        // succeeded — the work is done locally but couldn't ship. Without
        // this catch the throw escapes uncaught, the bot crashes with
        // exit 1, no skip-list entry is recorded, and the next cron
        // redoes all of Agent A + Agent B work + crashes again on the
        // same root cause. Record needs-human + exit cleanly so the
        // maintainer can investigate. See review-bot run 26707064619
        // (2026-05-31) where an unsanitized branch name caused
        // `fatal: invalid refspec` at push time; the fix (#477) closed
        // the root cause but the bot still needs graceful handling for
        // any future push/PR-create failure (network, auth, permissions,
        // remote rejection, etc.).
        printWarning(`Push + PR creation failed for ${branchName}: ${err}`)
        await openSkipListPR(octokit, repo, skipList, fingerprint, {
          reason: 'needs-human',
          reasonNote: `Agent A + Agent B succeeded (verdict APPROVE) but push or PR creation crashed: ${err}. Branch state is local; maintainer can inspect or recover.`,
        })
        process.exit(0)
      }
    }
    if (verdict.kind === 'needs-human') {
      printWarning(`Verdict: NEEDS_HUMAN. Recording skip-list entry + exiting.`)
      await openSkipListPR(octokit, repo, skipList, fingerprint, {
        reason: 'needs-human',
        reasonNote: verdict.note,
      })
      process.exit(0)
    }
    // REJECT — loop with the reviewer's note for Agent A.
    printNotice(`Verdict: REJECT. Retrying with reviewer note.`)
    priorReviewerNote = verdict.note
  }

  if (!approved) {
    printWarning(`Loop exhausted after ${MAX_ATTEMPTS} attempts. Recording skip-list entry + exiting.`)
    await openSkipListPR(octokit, repo, skipList, fingerprint, {
      reason: 'needs-human',
      reasonNote: `Agent A and reviewer did not converge after ${MAX_ATTEMPTS} attempts. Last reviewer note: ${priorReviewerNote ?? '(none)'}`,
    })
  }

  process.exit(0)
}

// --- Persistent skip-list landing -----------------------------------

/**
 * Record a skip-list entry locally AND open a draft PR landing it on
 * main. Without the PR step the runner-local write evaporates at job
 * teardown — the next cron's fresh clone reads the committed HEAD,
 * sees no entry, re-picks the same candidate, redoes all the work,
 * and crashes again on the same root cause.
 *
 * Mirrors fix-bot's `escalateToHuman` shape (the rule-38 reference).
 * fix-bot's `bots/fix-bot/index.ts` opens a `fix-bot-skip/...` branch
 * + draft PR titled `chore(skip-list): record <reason> for #<N>`. This
 * helper uses `review-bot-skip/...` branches; everything else is
 * structurally identical.
 *
 * Best-effort: the git ops and PR creation are wrapped so this helper
 * itself doesn't crash the bot if (say) the network is down. The
 * local write always happens first so even on PR-creation failure
 * the runner-tree state reflects intent.
 */
export interface SkipListPROptions {
  reason: 'needs-human' | 'maintainer-rejected' | 'stuck'
  reasonNote: string
  refPR?: number
  /**
   * Override the repo root for git ops. Defaults to REPO_ROOT.
   * Tests pass a tempdir to exercise the commit boundary without
   * touching the real repo.
   */
  cwd?: string
  /**
   * Override the skip-list path. Defaults to SKIPLIST_PATH (in
   * `bots/review-bot/skip-list.json`). Tests pass a path inside
   * `cwd` so the local-write step lands in the test's git tree.
   */
  skipListPath?: string
  /**
   * Override the skip-list path RELATIVE TO `cwd` for the `git add`
   * step. Defaults to `bots/review-bot/skip-list.json`. Tests pass
   * `skip-list.json` because the tempdir has the file at root.
   */
  skipListRelPath?: string
}

export async function openSkipListPR(
  octokit: ReturnType<typeof octokitFromEnv>,
  repo: ReturnType<typeof repoFromEnv>,
  skipList: SkipList,
  fingerprint: Fingerprint,
  opts: SkipListPROptions,
): Promise<void> {
  const cwd = opts.cwd ?? REPO_ROOT
  const skipListPath = opts.skipListPath ?? SKIPLIST_PATH
  const skipListRelPath = opts.skipListRelPath ?? 'bots/review-bot/skip-list.json'

  // Step 1: local write (working tree).
  const updated = recordSkipListEntry(skipList, fingerprint, {
    reason: opts.reason,
    reasonNote: opts.reasonNote,
    ...(opts.refPR !== undefined ? { refPR: opts.refPR } : {}),
  })
  writeSkipList(skipListPath, updated)
  printNotice(`Recorded skip-list entry for ${fingerprint.type}/${fingerprint.area} (${opts.reason})`)

  // Step 2: branch + commit + push + PR so the entry lands on main.
  const dateStr = new Date().toISOString().slice(0, 10)
  const safeArea = fingerprint.area
    .replace(/\/$/, '')
    .replace(/[^a-zA-Z0-9-]/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60)
  const skipBranch = `review-bot-skip/${dateStr}-${fingerprint.type}-${safeArea}`
  try {
    execFileSync('git', ['checkout', '-b', skipBranch], { cwd, stdio: 'inherit' })
    execFileSync('git', ['add', skipListRelPath], { cwd, stdio: 'inherit' })
    execFileSync(
      'git',
      [
        'commit',
        '-m',
        `chore(skip-list): record ${opts.reason} for ${fingerprint.type}/${fingerprint.area}\n\n${opts.reasonNote.slice(0, 500)}`,
      ],
      { cwd, stdio: 'inherit' },
    )
    execFileSync('git', ['push', '-u', 'origin', skipBranch], { cwd, stdio: 'inherit' })

    await octokit.pulls.create({
      ...repo,
      title: `chore(skip-list): record ${opts.reason} for ${fingerprint.type}/${fingerprint.area}`,
      head: skipBranch,
      base: 'main',
      draft: true,
      body: `> *This was generated by AI during review-bot's autonomous run.*

Adds a skip-list entry so review-bot doesn't re-pick the same candidate on every cron.

**Reason:** \`${opts.reason}\`
**Fingerprint:** \`${fingerprint.type}\` in \`${fingerprint.area}\` (rule: \`${fingerprint.rule}\`)

**Note from the orchestrator:**

> ${opts.reasonNote.slice(0, 1500)}

**What to do next:**

If the reason looks right, merge this PR (durable skip). If the reason looks wrong (the bot misjudged), close this PR and the next cron will re-pick the candidate.

<!-- review-bot: skip-entry fingerprint=${fingerprint.type}/${fingerprint.area}/${fingerprint.rule} reason=${opts.reason} run=${process.env.GITHUB_RUN_ID ?? 'local'} -->`,
    })
    printNotice(`Opened skip-list PR for ${fingerprint.type}/${fingerprint.area}`)
  } catch (err) {
    printWarning(`Couldn't open skip-list PR for ${fingerprint.type}/${fingerprint.area}: ${err}`)
  } finally {
    try {
      execFileSync('git', ['checkout', 'main'], { cwd, stdio: 'inherit' })
    } catch {
      // best-effort
    }
  }
}

// --- Phase 0 ---------------------------------------------------------

async function phase0AreaPick(skipList: SkipList, runId: string, dryRun: boolean): Promise<string | null> {
  printNotice('Phase 0: collecting signals...')
  const touches = await collectGitTouches({ sinceDays: 30 })
  const botPRs = await collectBotPRsByArea({ sinceDays: 180 })
  const candidates = scoreAreas(touches, botPRs, skipList, { topN: 5, maxDepth: 3 })

  printNotice(`Phase 0: scored ${candidates.length} candidate area(s).`)
  for (const c of candidates) {
    const colddays = Number.isFinite(c.daysSinceBotTouched) ? `${Math.round(c.daysSinceBotTouched)}d` : '∞'
    printNotice(`  ${c.area} — score=${c.score.toFixed(1)}, files=${c.touchedFiles}, bot-touched=${colddays} ago`)
  }

  if (candidates.length === 0) return null
  if (dryRun) return candidates[0]!.area

  printNotice('Phase 0: invoking area-picker...')
  const result = await runPicker(candidates, runId)
  if (!result.area) {
    printWarning(`Phase 0 picker returned no area: ${result.reasoning}`)
    return null
  }
  printNotice(`Phase 0: picked ${result.area}`)
  return result.area
}

async function runPicker(
  candidates: readonly AreaCandidate[],
  runId: string,
): Promise<{ area: string | null; reasoning: string }> {
  const promptTemplate = readFileSync(PICKER_PROMPT_PATH, 'utf-8')
  const lessons = readFileSync(LESSONS_PATH, 'utf-8')
  const candidatesBlock = candidates
    .map(c => {
      const cd = Number.isFinite(c.daysSinceBotTouched) ? `${Math.round(c.daysSinceBotTouched)}d` : 'never'
      return `- ${c.area} | touchedFiles=${c.touchedFiles} | bot-touched=${cd} | score=${c.score.toFixed(1)}`
    })
    .join('\n')

  const prompt = `${promptTemplate}\n\n# Inputs\n\nCANDIDATES:\n${candidatesBlock}\n\nLESSONS_LEARNED:\n${lessons}\n\nRUN_ID: ${runId}\n`
  const transcriptPath = resolve(TRANSCRIPT_DIR, `picker-${runId}.jsonl`)
  const result = await runClaude({ model: LIGHT_MODEL, prompt, transcriptPath, allowedTools: ['Bash', 'Read'] })

  if (!result.success) return { area: null, reasoning: `picker Claude exited ${result.exitCode}` }
  return parsePickerOutput(extractLastAssistantText(transcriptPath))
}

// --- Phase 1 ---------------------------------------------------------

async function phase1Discovery(area: string, runId: string): Promise<Candidate[]> {
  const transcriptPath = resolve(TRANSCRIPT_DIR, `discovery-${runId}.jsonl`)
  const prompt = `Invoke the \`audit-area\` skill via the Skill tool with the path argument \`${area}\`.

Pass through audit-area's complete output verbatim — including the prose-with-
\`> Decision: ...\` notes ABOVE the candidates fence that the skill's prompt
requires. The orchestrator's TS parser extracts only the fence body (via
\`extractCandidatesFence\`); the surrounding prose is preserved in the transcript
for replay-loop diffability + maintainer review of what the skill considered
before settling on the emitted candidates.

If audit-area returns no candidates, the skill emits an empty \`\`\`candidates\`\`\`
fence with prose explaining what was checked. Pass that through too — the
"no-candidates + reason" outcome is informative and the empty fence still
parses correctly.
`
  const result = await runClaude({
    model: LIGHT_MODEL,
    prompt,
    transcriptPath,
    allowedTools: ['Bash', 'Read', 'Grep', 'Glob', 'Skill'],
  })
  if (!result.success) {
    printWarning(`Phase 1 Claude exited ${result.exitCode}; treating as empty discovery.`)
    return []
  }
  const text = extractLastAssistantText(transcriptPath)
  return parseCandidatesFence(extractCandidatesFence(text))
}

// --- Phase 3: Agent A ------------------------------------------------

interface AgentAResult {
  pushed: boolean
  kind: 'pushed' | 'stuck' | 'crashed' | 'no-commits'
  note: string
  summary?: string
}

async function phase3AgentA(
  candidate: Candidate,
  branchName: string,
  attempt: number,
  priorReviewerNote: string | null,
  lessons: string,
  runId: string,
): Promise<AgentAResult> {
  const template = readFileSync(AGENT_A_PROMPT_PATH, 'utf-8')
  const recipeName = selectRecipe(candidate)
  const recipeTemplate = readFileSync(resolve(RECIPES_DIR, `${recipeName}.md`), 'utf-8')
  const candidateBlock = JSON.stringify(candidate, null, 2)

  // Compose: shared base + recipe contract for this candidate's type + injected inputs.
  // The recipe is the load-bearing per-type discipline; the base is the
  // shared scaffolding (inputs format, RESULT shape, stop conditions).
  const prompt = `${template}\n\n## Recipe (composed by orchestrator for type=${candidate.type})\n\n${recipeTemplate}\n\n# Inputs\n\nCANDIDATE_JSON:\n${candidateBlock}\n\nRECIPE=${recipeName}\nBRANCH_NAME=${branchName}\nATTEMPT=${attempt}\nMAX_ATTEMPTS=${MAX_ATTEMPTS}\n${priorReviewerNote ? `PRIOR_REVIEWER_NOTE=${priorReviewerNote}\n` : ''}LESSONS_LEARNED=\n${lessons}\n\nRUN_ID=${runId}\n`

  const transcriptPath = resolve(TRANSCRIPT_DIR, `agent-a-${runId}-attempt${attempt}.jsonl`)
  const result = await runClaude({
    prompt,
    transcriptPath,
    allowedTools: ['Bash', 'Read', 'Grep', 'Glob', 'Write', 'Edit'],
  })
  if (!result.success) {
    return { pushed: false, kind: 'crashed', note: `Agent A exited ${result.exitCode}; see ${transcriptPath}` }
  }
  const text = extractLastAssistantText(transcriptPath)

  // Parse RESULT: line (RESULT: PUSHED / RESULT: STUCK)
  if (/^RESULT:\s*PUSHED/m.test(text)) {
    return {
      pushed: true,
      kind: 'pushed',
      note: '',
      summary: extractResultSummary(text),
    }
  }
  if (/^RESULT:\s*STUCK/m.test(text)) {
    const reason = text.match(/^Reason:\s*(.+)$/m)?.[1] ?? '(no reason)'
    return { pushed: false, kind: 'stuck', note: reason }
  }
  // No RESULT line — check whether Agent A actually pushed
  if (branchHasCommits(branchName)) {
    return { pushed: true, kind: 'pushed', note: '', summary: '(Agent A pushed but emitted no RESULT line)' }
  }
  return { pushed: false, kind: 'no-commits', note: 'Agent A produced no commits + no RESULT line' }
}

function extractResultSummary(text: string): string {
  // RESULT: PUSHED can carry one of two shapes depending on recipe:
  //   - tdd-first: Branch + Test commit + Fix commit
  //   - coverage-shape (and other single-commit recipes): Branch + Commit + (optional) Counterfactuals
  //   - mechanical-cleanup: Branch + Commit + References
  // Extract all known fields; concatenate the ones present.
  const branch = text.match(/^Branch:\s*(.+)$/m)?.[1]
  const test = text.match(/^Test commit:\s*(.+)$/m)?.[1]
  const fix = text.match(/^Fix commit:\s*(.+)$/m)?.[1]
  const single = text.match(/^Commit:\s*(.+)$/m)?.[1]
  const counterfactuals = text.match(/^Counterfactuals:\s*(.+)$/m)?.[1]
  const references = text.match(/^References:\s*(.+)$/m)?.[1]
  return [branch, test, fix, single, counterfactuals, references].filter(Boolean).join(' | ') || '(no summary)'
}

// --- Phase 4: Agent B (review-orchestrator) --------------------------

// Agent B's angle skills don't know the recipe. A mechanical-cleanup
// diff claims to change no behavior, so the reviewer is told to treat
// any behavior change as CRITICAL (which the action policy rejects).
const MECHANICAL_CLEANUP_REVIEW_NOTE = `

This diff was made under the \`mechanical-cleanup\` recipe: it claims to be a pure deletion that changes no observable behavior and removes nothing still referenced. In addition to the orchestrator's findings, emit a CRITICAL finding (category \`correctness\`, rule \`bots/review-bot/prompts/recipes/mechanical-cleanup.md\`) in the findings fence for each deletion that changes observable behavior (a test assertion, a return value, an export, a side effect) or removes a symbol that still has references (check with grep).
`

async function phase4Reviewer(branchName: string, runId: string, attempt: number, recipe: RecipeName): Promise<string> {
  const prompt = `Invoke the \`review-orchestrator\` skill via the Skill tool with arguments \`--base main\` while the working tree is on branch \`${branchName}\` (already checked out by the orchestrator).

The orchestrator's diff source is \`git diff main\`. Let it dispatch the appropriate angle skills + aggregate findings.

Emit ONLY the orchestrator's output to stdout — the markdown summary + the aggregated \`findings\` JSONL fence. Don't add prose around it.

If review-orchestrator emits an empty findings fence (no concerns ≥ 80 confidence), emit it verbatim — the bot's verdict logic treats empty as APPROVE.
${recipe === 'mechanical-cleanup' ? MECHANICAL_CLEANUP_REVIEW_NOTE : ''}`
  const transcriptPath = resolve(TRANSCRIPT_DIR, `agent-b-${runId}-attempt${attempt}.jsonl`)
  const result = await runClaude({
    prompt,
    transcriptPath,
    allowedTools: ['Bash', 'Read', 'Grep', 'Glob', 'Skill'],
  })
  if (!result.success) {
    printWarning(`Agent B Claude exited ${result.exitCode}; treating as empty findings (degraded mode).`)
    return ''
  }
  return extractLastAssistantText(transcriptPath)
}

// --- Phase 5: push + open PR -----------------------------------------

interface AttemptRecord {
  attempt: number
  approveReasoning: string
  agentASummary: string
}

async function phase5Push(
  branchName: string,
  candidate: Candidate,
  fingerprint: Fingerprint,
  attemptRecord: AttemptRecord,
  octokit: ReturnType<typeof octokitFromEnv>,
  repo: ReturnType<typeof repoFromEnv>,
): Promise<void> {
  // Capture commit log + diff stat for the PR body (per fix-bot's
  // structured-PR-body convention). Done BEFORE push so we read the
  // local branch state, not the remote.
  const commitMessages = captureCommitMessages(branchName, { cwd: REPO_ROOT })
  const diffStat = captureDiffStat(branchName)

  // Push the branch
  execFileSync('git', ['push', '-u', 'origin', branchName, '--force-with-lease'], {
    cwd: REPO_ROOT,
    stdio: 'inherit',
  })

  // Open the PR with the structured body shape (mirrors fix-bot's
  // sections: candidate context, what Agent A did, how Agent B
  // reviewed, test plan).
  const title = `improve(${candidate.type}): ${candidate.summary.slice(0, 60)}`
  const body = `## Summary

Autonomous improvement proposed by review-bot.

- **Area**: \`${candidate.area}\`
- **Type**: \`${candidate.type}\`
- **Severity**: \`${candidate.severity}\`
- **Rule cited**: \`${candidate.rule}\`
- **Attempts**: ${attemptRecord.attempt} (generator-critic loop)

## Candidate context (from \`audit-area\`)

${candidate.summary}

**Suggested action** (Agent A's starting point):
${candidate.suggested_action}

## What Agent A did

${attemptRecord.agentASummary}

### Commits

\`\`\`
${commitMessages || '(commit log unavailable)'}
\`\`\`

### Diff stat

\`\`\`
${diffStat || '(diff stat unavailable)'}
\`\`\`

## How Agent B reviewed

Invoked \`review-orchestrator\` skill which fanned out to the
applicable angle skills (per the dispatch table — see
[\`bots/_lib/review-dispatch.ts\`](bots/_lib/review-dispatch.ts)).
Findings were aggregated, deduped by \`(file, line, category)\`, and
filtered to confidence ≥ 80.

### Verdict reasoning

${attemptRecord.approveReasoning}

## Test plan

- [ ] Inspect the failing-test commit; verify it captures the candidate's
      problem (test should reasonably fail without the fix)
- [ ] Inspect the fix commit; verify it addresses the test's assertion
      narrowly (no scope creep)
- [ ] Run \`npm test\` locally; verify both commits + the diff cleanly
- [ ] If the candidate's \`type\` is security or architecture, eyeball
      the corresponding design doc cited in \`rule\` to confirm the
      change respects the contract

## Bot disclosure

> *This was generated by AI during autonomous improvement review.*

<!-- review-bot: candidate=${fingerprint.type}/${fingerprint.area}/${fingerprint.rule} -->
`
  await octokit.pulls.create({
    ...repo,
    title,
    head: branchName,
    base: 'main',
    body,
    draft: true,
  })
  printNotice(`PR opened for ${branchName}`)
}

function captureDiffStat(branchName: string): string {
  try {
    return execFileSync('git', ['diff', `main...${branchName}`, '--stat'], {
      cwd: REPO_ROOT,
      encoding: 'utf-8',
      maxBuffer: 1 * 1024 * 1024,
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim()
  } catch {
    return ''
  }
}

function captureNumstat(branchName: string): string {
  try {
    return execFileSync('git', ['diff', '--numstat', `main...${branchName}`], {
      cwd: REPO_ROOT,
      encoding: 'utf-8',
      maxBuffer: 1 * 1024 * 1024,
      stdio: ['ignore', 'pipe', 'ignore'],
    })
  } catch {
    return ''
  }
}

// --- Branch helpers --------------------------------------------------
// Implementations live in bots/_lib/git-tree.ts (shared with fix-bot +
// dead-code-watcher). This file imports them at the top and exposes
// thin per-bot wrappers when needed.

function branchHasCommits(branchName: string): boolean {
  return branchHasCommitsLib(branchName, { cwd: REPO_ROOT })
}

main().catch(err => {
  printWarning(`review-bot failed: ${err instanceof Error ? err.message : String(err)}`)
  process.exit(1)
})
