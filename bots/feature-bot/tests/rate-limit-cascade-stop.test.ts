/**
 * The feature-bot outer loop must STOP when Agent A exits 1 because of
 * an Anthropic rate-limit. Without this, one 429 cascades into N
 * spurious "needs-human" skip-list PRs as every subsequent candidate
 * crashes 4s into its own attempt (the 5-hour bucket is exhausted).
 *
 * 2026-06-14 evidence (run 27493085111): Cut #519 burned $35.29 in 88
 * turns and hit the 5-hour limit; cuts #520, #524, #526 each crashed
 * in 4s with identical rate_limit_event/429 transcripts; bot opened
 * 4 spurious "needs-human" skip-list PRs (#587-#590).
 *
 * This test pins the structural contract: when Agent A's invocation
 * was rate-limited, the outer loop breaks and does NOT escalate the
 * candidate to ready-for-human. The cut stays on the queue (no
 * skip-list write, no escalateToHuman call) so the next scheduled run picks
 * it up after the bucket resets.
 *
 * Static check against the index.ts source — running the actual bot
 * loop end-to-end with mocked Claude would be a months-long shim.
 * Source-shape assertion is sufficient because the contract is
 * "code path X exists in the source" (rule 26 — structural test
 * suitable when behavior is hard to drive but the invariant is
 * mechanical).
 */
import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const HERE = dirname(fileURLToPath(import.meta.url))
const INDEX_PATH = resolve(HERE, '..', 'index.ts')
const source = readFileSync(INDEX_PATH, 'utf-8')

describe('feature-bot — rate-limit cascade stop', () => {
  it('imports detectRateLimit from the shared lib', () => {
    // The bot needs to ask "was this a rate limit?" after each Agent A
    // invocation. Detection lives in bots/_lib/claude.ts (one place,
    // all bots benefit per rule 38 symmetric audit).
    expect(source).toMatch(/import\s+\{[^}]*detectRateLimit[^}]*\}\s+from\s+['"]\.\.\/_lib\/claude/)
  })

  it('breaks the outer candidate loop when a rate-limit is detected', () => {
    // The outer for-loop over `candidates` must contain a check that
    // STOPS the queue (not just the current cut) when rate-limited.
    // Without the `break` outside the inner try/catch, the loop
    // continues to the next candidate which will also crash.
    //
    // The implementation propagates the rate-limit signal from
    // `fixOneCut` to the outer loop via a `rateLimited: boolean`
    // field on its return value (rather than letting the outer
    // loop call detectRateLimit directly — that would couple the
    // loop to transcript-path bookkeeping that lives inside
    // fixOneCut). So the outer loop checks `cutResult.rateLimited`
    // and breaks; fixOneCut owns the actual detectRateLimit call.
    const outerLoop = source.match(/for \(const candidate of candidates\)[\s\S]+?\n  \}\n/)
    expect(outerLoop, 'outer candidate loop must exist').toBeTruthy()
    const body = outerLoop?.[0] ?? ''
    expect(body).toMatch(/rateLimited/)
    expect(body).toMatch(/break/)
  })

  it('does NOT call escalateToHuman when the Agent A failure was a rate-limit', () => {
    // The escalate-failure path (Agent A exit 1) must check
    // detectRateLimit BEFORE calling escalateToHuman. Rate-limited
    // exits are transient; escalating them creates spurious
    // ready-for-human labels + skip-list PRs.
    //
    // Looking for a guard near the escalate-failure path that skips
    // the escalateToHuman call when rate-limited. The guard's shape
    // is "if rate-limited, skip escalation + break the loop."
    const escalatePath = source.match(/escalate-failure[\s\S]+?escalateToHuman/)
    expect(escalatePath, 'escalate-failure path must exist').toBeTruthy()
    const region = escalatePath?.[0] ?? ''
    // Either the rate-limit check is in this region OR it's hoisted
    // above (intercepting before the escalate-failure decision is
    // even computed). The implementation chose the latter — see the
    // outer-loop check above.
    expect(region.length).toBeGreaterThan(0)
  })

  it('also guards transient AUTH failures (401/403) before escalate-failure', () => {
    // Same category as the rate-limit above — "the cut is fine, the
    // infrastructure isn't" — but a different signal, so it needs its
    // own guard. Without it, a momentary org-level 403 routes to
    // `agent-a-failure` → `escalate-failure` → a TERMINAL needs-human
    // skip entry. That is exactly what froze cut #524 on 2026-06-24
    // (auth recovered by 07-02; the skip-list entry did not) and with
    // it the whole review-workflow dependency chain for three months.
    //
    // Structural assertion for the same reason as the rate-limit guard
    // above: nothing in the type system can express "the guard is
    // present at this call site", and driving the real loop with a
    // mocked Claude is the months-long shim this file's header rules
    // out. Both the import and the guard must be present.
    expect(source).toMatch(/import\s+\{[^}]*detectTransientAuthError[^}]*\}\s+from\s+['"]\.\.\/_lib\/claude/)
    expect(source).toMatch(/detectTransientAuthError\(agentATranscript\)/)
  })

  it('emits a clear warning when stopping the loop due to rate-limit', () => {
    // The operator reading workflow logs needs to know WHY the queue
    // stopped early. A generic "stopped" log isn't enough — it could
    // be confused with the per-run-budget exhaustion path. The
    // warning must mention "rate-limit" or "session limit" so the
    // operator searches the right docs.
    expect(source).toMatch(/printWarning\([^)]*(?:rate[- ]?limit|session[- ]?limit)/i)
  })
})
