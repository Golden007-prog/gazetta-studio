import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

// Structural smoke tests on feature-bot's reviewer prompt — catches
// accidental removal of load-bearing sections. We don't test Claude's
// behavior; we test that the prompt still contains the contracts it
// promises downstream tooling. Mirror of fix-bot's reviewer-prompt
// structural test (`bots/fix-bot/tests/reviewer-prompt.test.ts`).

const __dirname = dirname(fileURLToPath(import.meta.url))
const PROMPT_PATH = resolve(__dirname, '..', 'prompts', 'reviewer.md')
const prompt = readFileSync(PROMPT_PATH, 'utf-8')

describe('feature-bot reviewer prompt — structural contracts', () => {
  it('keeps the four-step path-based tautology check', () => {
    expect(prompt).toMatch(/### Step 1: classify the commit's files into impl vs tests/)
    expect(prompt).toMatch(/### Step 2: revert ONLY the impl files/)
    expect(prompt).toMatch(/### Step 3: verify the failure matches/)
    expect(prompt).toMatch(/### Step 4: restore the impl/)
  })

  it('keeps the acceptance + runtime-exercise + SOLID + locked-decisions sections', () => {
    expect(prompt).toMatch(/## The acceptance check/)
    expect(prompt).toMatch(/## The runtime-exercise check/)
    expect(prompt).toMatch(/## The SOLID check/)
    expect(prompt).toMatch(/## The locked-decisions check/)
  })

  it('delegates review-architecture to a subagent', () => {
    // The Skill tool (used DIRECTLY) loads heavy context into Agent B's
    // window and pulls Agent B toward early termination (fix-bot's #469
    // failure mode). Subagent delegation isolates the skill's context.
    expect(prompt).toMatch(/## The architecture-review check/)
    expect(prompt).toMatch(/review-architecture/)
    expect(prompt).toMatch(/Agent\(\{/)
  })

  it('conditionally spawns review-security subagent for security-sensitive paths', () => {
    expect(prompt).toMatch(/review-security/)
    expect(prompt).toMatch(/security-sensitive path/)
  })

  it('documents parallel spawning in the body section (bold IN PARALLEL)', () => {
    // Both skills are read-only by contract (`allowed-tools: Bash Read
    // Grep Glob` in their SKILL.md — no Write, no Edit). They can't
    // race on tree state. Parallel keeps wall-clock to ~30s instead
    // of ~60s.
    //
    // Anchor on the bold **IN PARALLEL** declaration. A loose substring
    // search (`/parallel/i`) would still pass if a refactor flipped
    // step 7 to "SEQUENTIALLY" but left "parallel" elsewhere in the
    // rationale — exactly the regression this test should catch.
    expect(prompt).toMatch(/\*\*IN PARALLEL\*\*/)
  })

  it('documents parallel spawning in the Process step list too', () => {
    // Process step 7 carries the actionable instruction; the body
    // section carries the rationale. They must agree — a body that
    // says "parallel" with a step list that says "sequential" gives
    // the reviewer contradictory guidance (the failure mode that
    // shipped in fix-bot's reviewer.md pre-#480).
    expect(prompt).toMatch(/^\d+\.\s+\*\*Spawn subagents\*\*[\s\S]*?IN PARALLEL/m)
  })

  it('keeps the "When to skip the subagent spawns" guardrail subsection', () => {
    // Lists conditions under which review-architecture / review-security
    // delegation is skipped (trivial docs cuts, pure data-shape cuts,
    // bots/-only diffs). Silent removal would cause the reviewer to
    // always spawn subagents — wasted API budget on diffs that don't
    // benefit + context burn.
    expect(prompt).toMatch(/### When to skip the subagent spawns/)
  })

  it('keeps the "When NOT to fold a finding" guardrail subsection', () => {
    // Carve-outs where the reviewer should NOT route a skill-emitted
    // finding into the verdict (e.g., finding cites a doc modified in
    // the same diff; finding contradicts an explicit PRIOR_REVIEWER_NOTE
    // on retry). Silent removal would cause false REJECTs Agent A
    // can't address.
    expect(prompt).toMatch(/### When NOT to fold a finding/)
  })

  it('Rules section lists Agent + Skill among allowed tools (not just Bash + Read)', () => {
    // The orchestrator's reviewer allowedTools includes 'Agent' and
    // 'Skill' (see bots/feature-bot/index.ts). The prompt's Rules
    // section must reflect this — otherwise the reviewer reads
    // "Bash + Read only" at the end and treats the new subagent
    // delegation (Process step 7) as forbidden, defeating the pattern.
    expect(prompt).toMatch(/Bash[\s\S]{0,50}Read[\s\S]{0,50}Agent[\s\S]{0,50}Skill/)
  })

  it('documents the severity-to-verdict action policy table', () => {
    expect(prompt).toMatch(/Action policy for skill findings/)
    expect(prompt).toMatch(/CRITICAL/)
    expect(prompt).toMatch(/IMPORTANT/)
    expect(prompt).toMatch(/NIT/)
  })

  it('keeps the VERDICT line contract (parseable by reviewer-verdict.ts)', () => {
    expect(prompt).toMatch(/VERDICT: APPROVE/)
    expect(prompt).toMatch(/VERDICT: REJECT/)
    expect(prompt).toMatch(/VERDICT: NEEDS_HUMAN/)
  })

  it('keeps the Process list with nine steps', () => {
    // Nine numbered items: tautology / acceptance / runtime-exercise /
    // visual / SOLID / locked-decisions / non-mechanical /
    // spawn-subagents / form-verdict.
    const processMatch = prompt.match(/## Process\n\n([\s\S]+?)(?=\n##|\n```)/)
    expect(processMatch, 'Process section missing').toBeTruthy()
    const body = processMatch![1]
    const numbered = body.split('\n').filter(l => /^\d+\.\s/.test(l))
    expect(numbered).toHaveLength(9)
  })

  it('declares Agent tool as needed (documented in prose)', () => {
    // Reviewer spawns subagents via the Agent tool for review-architecture
    // and review-security; this isolates the skills' heavy context from
    // Agent B's window so the findings fence doesn't pull Agent B toward
    // early termination before emitting VERDICT.
    expect(prompt).toMatch(/via the `Agent`\s*\n?\s*tool/)
  })
})
