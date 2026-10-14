/**
 * Prompt composition, against the REAL template files — a placeholder the
 * templates use but the composer doesn't fill would ship a literal `$NAME`
 * to Claude.
 */
import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import type { PlanContext } from '../execute.js'
import type { Mode } from '../plan-output.js'
import { composePrompt, type PromptTemplates } from '../prompt.js'

const DIR = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'prompts')
const read = (f: string) => readFileSync(resolve(DIR, f), 'utf-8')
const templates: PromptTemplates = {
  context: read('_context.md'),
  contract: read('_contract.md'),
  lessons: readFileSync(resolve(DIR, '..', 'lessons-learned.md'), 'utf-8'),
  modes: { file: read('file.md'), refine: read('refine.md'), redecompose: read('redecompose.md') },
}

const ctx: PlanContext = {
  planner: {
    feature: 'rw',
    designPath: '.claude/rules/design-rw.md',
    suggestedPlan: '| 5 | gate |',
    state: 'Next: cut 5',
    lockedDecisions: '',
  },
  plannerIssueNumber: 900,
  locks: ['use computeSaveEtag (#837)', 'second lock'],
  cut: { number: 519, title: 'rw: gate', body: 'body mentioning $FEATURE literally', reviewerNote: 'Architecture gap' },
}

describe.each<Mode>(['file', 'refine', 'redecompose'])('composePrompt(%s)', mode => {
  const p = composePrompt(templates, mode, ctx)

  it('leaves no unfilled $PLACEHOLDER from the templates', () => {
    // The cut body deliberately contains "$FEATURE"; that one is user text.
    expect(p.replace('body mentioning $FEATURE literally', '').match(/\$[A-Z_]{3,}/g)).toBeNull()
  })

  it('numbers the locks so Claude can select them by index', () => {
    expect(p).toContain('0. use computeSaveEtag (#837)\n1. second lock')
  })

  it('carries the output contract', () => {
    expect(p).toContain('```cut-plan')
  })
})

describe('composePrompt — substitution safety', () => {
  it('does not re-substitute placeholders that appear inside inserted text', () => {
    const p = composePrompt(templates, 'refine', ctx)
    expect(p).toContain('body mentioning $FEATURE literally')
  })

  it('inserts shared fragments verbatim, even when they contain $-replacement patterns', () => {
    const fragment = "literal $& and $' and $$ and $` here"
    const p = composePrompt({ ...templates, context: fragment, contract: fragment }, 'refine', ctx)
    expect(p.split(fragment).length - 1).toBe(2)
  })

  it('includes the reviewer verdict for refine, and says so when there is none', () => {
    expect(composePrompt(templates, 'refine', ctx)).toContain('Architecture gap')
    const none = composePrompt(templates, 'refine', { ...ctx, cut: { ...ctx.cut!, reviewerNote: null } })
    expect(none).toContain('no reviewer verdict was found')
  })
})

describe('composePrompt — lessons (Q7a)', () => {
  it('loads lessons-learned.md into every mode', () => {
    for (const mode of ['file', 'refine', 'redecompose'] as const) {
      expect(composePrompt({ ...templates, lessons: 'Specs that defer a decision fail.' }, mode, ctx)).toContain(
        'Specs that defer a decision fail.',
      )
    }
  })
})

describe('prompt ↔ parser field parity', () => {
  // The first live run failed because the prompt described the file answer
  // in shorthand and the model omitted a field. Every field the parser reads
  // for a mode's primary action must appear, literally, in that mode's prompt.
  it.each<[Mode, string[]]>([
    [
      'file',
      [
        '"action": "file"',
        '"title"',
        '"spec"',
        '"acceptance"',
        '"tests"',
        '"solid"',
        '"lockIndices"',
        '"files"',
        '"state"',
        '"deviation"',
        '"needs-input"',
        '"plan-complete"',
      ],
    ],
    ['refine', ['"action": "refine"', '"lockIndices"', '"files"', '"summary"', '"design-objection"', '"needs-input"']],
    [
      'redecompose',
      [
        '"action": "redecompose"',
        '"first"',
        '"remaining"',
        '"summary"',
        '"state"',
        '"lockIndices"',
        '"design-objection"',
      ],
    ],
  ])('%s prompt shows every field', (mode, fields) => {
    const p = composePrompt(templates, mode, ctx)
    for (const f of fields) expect(p, f).toContain(f)
  })
})

describe('prompts teach the #NEW placeholder', () => {
  it.each<Mode>(['file', 'redecompose'])('%s prompt uses #NEW, never a vague "this cut"', mode => {
    const p = composePrompt(templates, mode, ctx)
    expect(p).toContain('#NEW')
    // The first live run copied the example's "In flight: this cut" verbatim.
    expect(p).not.toContain('In flight: this cut')
  })
})
