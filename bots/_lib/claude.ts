/**
 * Claude Code CLI wrapper for bots.
 *
 * Bots delegate the "intelligent" part of their work to a headless `claude -p`
 * invocation. The orchestration (data plumbing, dedup, action) stays in TS;
 * the prompt-driven analysis and tool-call sequence belongs to Claude.
 *
 * Auth: CLAUDE_CODE_OAUTH_TOKEN env var. The Claude Code CLI reads it
 * automatically — no flag needed. Bills against the Claude account's
 * subscription rather than per-token API spend.
 *
 * Transparency: Claude is invoked with `--output-format stream-json --verbose`
 * so every tool call, tool result, and assistant message lands as one JSON
 * event per line. The wrapper writes the raw JSONL to a transcript file (for
 * a future agent to read) AND renders a human-readable summary to stdout
 * (for live workflow log viewing). See `bots/README.md` "Improving the bot"
 * for how the transcripts feed the replay loop.
 */
import { spawn } from 'node:child_process'
import { createWriteStream, existsSync, readFileSync } from 'node:fs'
import { mkdir } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { type PendingTool, type RenderCounters, renderSummaryLine } from './claude-render.js'

/**
 * Repo root, derived from this file's location: bots/_lib/claude.ts → ../../
 *
 * Default cwd for spawned `claude` processes. Without this, npm-run lands the
 * script in `bots/`, and Claude's relative-path tool calls (cat docs/...,
 * grep ROADMAP.md) miss — costing 2-5 wasted retries per investigation.
 * Verified live on triage-bot run 25630679446: docs/non-goals.md was opened
 * 92 times across 44 investigations because relative paths kept failing.
 */
const REPO_ROOT = resolve(fileURLToPath(import.meta.url), '../../..')

export interface ClaudeOptions {
  /** The prompt content (system + user combined). */
  prompt: string
  /**
   * Tools Claude is allowed to invoke. Default `['Bash']` — most bots only
   * need to shell out to gh CLI. Pass `['Bash', 'Read']` if Claude also
   * needs to read repo files, etc.
   */
  allowedTools?: string[]
  /**
   * Working directory for tool calls. Defaults to the repo root (derived from
   * this file's location) so Claude's relative paths land in the project tree
   * rather than in `bots/` (where npm-run leaves the script).
   */
  cwd?: string
  /**
   * Path to write the raw JSONL transcript to. Required — agents replaying
   * past investigations read transcripts; if you don't want one, you don't
   * want this wrapper.
   */
  transcriptPath: string
  /**
   * Model to use. Defaults to `DEFAULT_MODEL` below (Opus 5.5). Pass
   * `LIGHT_MODEL` for light roles (compaction, summarising, picking).
   * Opus 5.5 and Sonnet 5.5 both have a 1M context window without a
   * `[1m]` suffix; older models needed it (`'claude-opus-4-7[1m]'`).
   */
  model?: string
}

/**
 * Default model for bot Claude invocations: Opus 5.5 (1M context natively,
 * no `[1m]` suffix; needs Claude Code CLI >= 2.1.280, which CI's
 * `npm install -g @anthropic-ai/claude-code` provides).
 *
 * Bots read many files per run, so most of their spend is CACHE READS: every
 * turn re-reads the growing context. Sampled 2026-10-11 (103 transcripts on
 * Opus 4.7): one feature-bot Agent A run was $42 of which $33 was cache reads
 * (66M tokens over 104 turns). Opus 5.5 is cheaper on exactly that line
 * ($0.20 vs $0.50 per MTok cached; $4/$20 vs $5/$25 in/out, list prices),
 * so moving to it roughly halves bot usage of the shared subscription
 * budget without dropping to a smaller model.
 *
 * History: Sonnet 4.6 (200K window) once blew the context on fix-bot
 * (run 25639089938, autocompact thrash) — the reason bots moved to a 1M
 * Opus. Both models below have a 1M window, so that failure doesn't recur.
 */
const DEFAULT_MODEL = 'claude-opus-5-5'

/**
 * Model for LIGHT roles: compaction, parsing / summarising bot output,
 * classification, picking a candidate. Sonnet 5.5 (1M context, $0.10 cached
 * / $10 out per MTok). Implementers (Agent A), reviewers (Agent B) and spec
 * writers stay on DEFAULT_MODEL: they decide what reaches the maintainer's
 * review queue.
 */
export const LIGHT_MODEL = 'claude-sonnet-5-5'

export interface ClaudeResult {
  /** Exit code from the claude binary. 0 = success. */
  exitCode: number
  /** True when claude exited 0. */
  success: boolean
  /** Path the JSONL transcript was written to. */
  transcriptPath: string
}

/**
 * Run `claude -p` headless. Writes raw JSONL transcript to disk; renders a
 * human-readable summary to stdout in real time.
 *
 * Live-rendering rules + stream-json event types live in `./claude-render.ts`
 * (split for unit-testability). This wrapper owns process orchestration:
 * spawn, transcript IO, child stdio buffering, exit-code translation. Per
 * line of JSONL stdout we write to the transcript verbatim AND pass to
 * `renderSummaryLine` for the human-readable summary.
 *
 * Flag rationale:
 *   --print                       : non-interactive, exit after response
 *   --output-format stream-json   : emit one JSON event per line — required
 *                                   for the transcript + summary split
 *   --verbose                     : required alongside stream-json (CLI
 *                                   refuses without it)
 *   --model <id>                  : Opus 5.5 (1M context) by default —
 *                                   see DEFAULT_MODEL below for rationale
 *   --allowedTools <list>         : restrict to tools the prompt needs
 *   --dangerously-skip-permissions: no human in CI to approve tool calls;
 *                                   --allowedTools is the safety boundary
 *
 * Do NOT pass --bare — it disables OAuth token reading per the CLI docs.
 */
export async function runClaude(opts: ClaudeOptions): Promise<ClaudeResult> {
  const tools = opts.allowedTools ?? ['Bash']
  const model = opts.model ?? DEFAULT_MODEL
  await mkdir(dirname(opts.transcriptPath), { recursive: true })
  const transcript = createWriteStream(opts.transcriptPath, { flags: 'w' })

  // Per-call rendering state. Pending tool calls indexed by tool_use_id so
  // the matching tool_result can backfill duration + size. Counters drive
  // the final summary line.
  const pending = new Map<string, PendingTool>()
  const counters: RenderCounters = { toolCalls: 0, decisions: 0 }

  return new Promise((resolve, reject) => {
    // The prompt goes in on STDIN, not as an argv entry. Passing it as an
    // argument put the whole prompt — reviewer template + issue body +
    // the full `git diff` of Agent A's work — into the exec argument
    // vector, which the OS caps at ARG_MAX (~256 KB on Linux). A cut
    // with a large diff therefore died with `spawn E2BIG` *after* Agent
    // A had already done the work: observed 2026-10-03 on cut #524
    // ("#524 threw: Error: spawn E2BIG"), where Agent A committed the
    // story-render gate and the reviewer invocation then blew up. The
    // generator half of the loop worked; the critic half was unreachable
    // for any cut whose diff was big enough.
    //
    // `claude --print` reads the prompt from stdin when no prompt
    // argument is supplied, so this removes the ceiling entirely — a
    // pipe has no size limit.
    const child = spawn(
      'claude',
      [
        '--print',
        '--output-format',
        'stream-json',
        '--verbose',
        '--model',
        model,
        '--allowedTools',
        tools.join(','),
        '--dangerously-skip-permissions',
      ],
      { cwd: opts.cwd ?? REPO_ROOT, env: process.env, stdio: ['pipe', 'pipe', 'inherit'] },
    )

    // Write the prompt and close stdin so `claude` sees EOF and starts.
    // EPIPE is possible if the child dies before draining (bad model
    // name, missing binary); the 'error'/'close' handlers below own that
    // reporting, so swallow it here rather than crashing the bot.
    child.stdin.on('error', () => {})
    child.stdin.end(opts.prompt)

    // Buffer stdout to handle JSONL events split across chunks. Each complete
    // line is parsed for the human summary AND written verbatim to the
    // transcript. Anything we can't parse is still preserved in the transcript.
    let stdoutBuffer = ''
    child.stdout.on('data', (chunk: Buffer) => {
      stdoutBuffer += chunk.toString('utf-8')
      let nlIndex = stdoutBuffer.indexOf('\n')
      while (nlIndex !== -1) {
        const line = stdoutBuffer.slice(0, nlIndex)
        stdoutBuffer = stdoutBuffer.slice(nlIndex + 1)
        if (line.trim()) {
          transcript.write(`${line}\n`)
          renderSummaryLine(line, pending, counters)
        }
        nlIndex = stdoutBuffer.indexOf('\n')
      }
    })

    child.on('error', err => {
      transcript.end()
      reject(err)
    })
    child.on('close', code => {
      // Flush any tail without trailing newline.
      if (stdoutBuffer.trim()) {
        transcript.write(`${stdoutBuffer}\n`)
        renderSummaryLine(stdoutBuffer, pending, counters)
      }
      transcript.end()
      const exitCode = code ?? 1
      resolve({ exitCode, success: exitCode === 0, transcriptPath: opts.transcriptPath })
    })
  })
}

/**
 * Detect whether a Claude transcript ended because of an Anthropic
 * session-rate-limit (5-hour bucket exhausted). Returns true iff the
 * transcript contains EITHER:
 *   - a `rate_limit_event` line with `status: 'rejected'` (the cascade
 *     case — every cut after the one that exhausted the bucket starts
 *     with this event before Claude even begins the conversation), OR
 *   - a `result` event with `api_error_status: 429` (the cut that
 *     actually hit the wall).
 *
 * Bots check this AFTER each Agent A invocation to decide whether to
 * STOP the candidate queue (rate-limited → tomorrow's cron retries) vs.
 * escalate this cut to `ready-for-human` (real failure). Without the
 * check, one 429 cascades into N spurious skip-list PRs as every
 * subsequent candidate crashes in 4s on the exhausted bucket.
 *
 * Discovered 2026-06-14, run 27493085111 — Cut #519 burned $35.29 over
 * 88 turns and hit the 5-hour limit; cuts #520, #524, #526 each crashed
 * in 4s producing PRs #587-#590 with reason `needs-human` that were in
 * fact transient rate-limit cascade victims.
 *
 * Defensive against missing / malformed transcripts: returns false on
 * any read or parse error. The caller's worst case in that branch is
 * "the bot escalates a cut it could have left on the queue" — strictly
 * less bad than the cascade we're preventing.
 */
export function detectRateLimit(transcriptPath: string): boolean {
  if (!existsSync(transcriptPath)) return false
  let content: string
  try {
    content = readFileSync(transcriptPath, 'utf-8')
  } catch {
    return false
  }
  const lines = content.split('\n')
  for (const line of lines) {
    const trimmed = line.trim()
    if (!trimmed) continue
    let event: unknown
    try {
      event = JSON.parse(trimmed)
    } catch {
      continue
    }
    if (!event || typeof event !== 'object') continue
    const e = event as Record<string, unknown>
    if (e.type === 'rate_limit_event') {
      const info = e.rate_limit_info as { status?: string } | undefined
      if (info?.status === 'rejected') return true
    }
    if (e.type === 'result' && e.is_error === true && e.api_error_status === 429) {
      return true
    }
  }
  return false
}

/**
 * Detect whether a Claude transcript ended because of a transient
 * AUTH / entitlement failure (401 / 403) rather than anything wrong
 * with the work. Sibling to `detectRateLimit` — same "the cut is fine,
 * the infrastructure isn't" category, different signal.
 *
 * Matches EITHER:
 *   - a `result` event with `api_error_status` 401 or 403, OR
 *   - a `result` event whose error text names the entitlement failure
 *     (the observed 2026-06-24 wording was "Your organization has
 *     disabled Claude subscription access for Claude Code").
 *
 * Why the text fallback: `api_error_status` is confirmed present for
 * 429 (see `detectRateLimit`), but the June 2026 transcripts that
 * carried the 403 aged out of the 90-day artifact retention before
 * the exact field shape could be confirmed. Matching both shapes is
 * defensive; if the status code is present we catch it, and if the
 * CLI only surfaced prose we still catch it.
 *
 * Why this matters: without it, a momentary org-level auth blip makes
 * Agent A exit non-zero, which routes to `agent-a-failure` →
 * `escalate-failure` → a TERMINAL `needs-human` skip entry +
 * `ready-for-human` + closed issue. That is what froze cut #524 (and
 * with it the whole review-workflow dependency chain) for three
 * months after a single transient 403 on 2026-06-24 — the auth was
 * working again by 07-02, but the skip-list entry made the cut
 * permanently invisible to the cron.
 *
 * Defensive against missing / malformed transcripts: returns false on
 * any read or parse error, same as `detectRateLimit`. Worst case in
 * that branch is the pre-existing behavior (escalate a cut that could
 * have stayed on the queue).
 */
export function detectTransientAuthError(transcriptPath: string): boolean {
  if (!existsSync(transcriptPath)) return false
  let content: string
  try {
    content = readFileSync(transcriptPath, 'utf-8')
  } catch {
    return false
  }
  for (const line of content.split('\n')) {
    const trimmed = line.trim()
    if (!trimmed) continue
    let event: unknown
    try {
      event = JSON.parse(trimmed)
    } catch {
      continue
    }
    if (!event || typeof event !== 'object') continue
    const e = event as Record<string, unknown>
    if (e.type !== 'result' || e.is_error !== true) continue

    if (e.api_error_status === 401 || e.api_error_status === 403) return true

    // Text fallback — the CLI may surface the entitlement failure as
    // prose without a status code. Keep the match narrow: an auth
    // keyword AND a Claude-Code-entitlement keyword, so an unrelated
    // 403 from a tool the agent called (e.g. a curl in Bash) doesn't
    // mask a genuine code-level failure as "transient infra".
    const text = typeof e.result === 'string' ? e.result.toLowerCase() : ''
    if (!text) continue
    const authish =
      text.includes('unauthorized') ||
      text.includes('forbidden') ||
      text.includes('authentication') ||
      text.includes('subscription access')
    const entitlementish = text.includes('claude code') || text.includes('organization has disabled')
    if (authish && entitlementish) return true
  }
  return false
}

/**
 * True when a failed Claude call stopped for infrastructure reasons — the
 * session rate limit or a transient auth/entitlement error — rather than
 * anything about the work. Callers must treat it as "come back later":
 * stop the queue, record nothing, leave the item where it was.
 *
 * Applies to EVERY agent a bot runs, not just the first. #519's reviewer
 * (Agent B) hit the session limit in run 37770034162, and with the check
 * only on Agent A the bot read it as a reviewer crash and parked the cut
 * as needs-human (#892).
 */
export function detectInfraStop(transcriptPath: string): boolean {
  return detectRateLimit(transcriptPath) || detectTransientAuthError(transcriptPath)
}
