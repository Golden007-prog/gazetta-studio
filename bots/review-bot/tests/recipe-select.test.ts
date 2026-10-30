import { describe, expect, it } from 'vitest'
import type { CandidateType } from '../candidates.js'
import { isPureDeletionCandidate, type RecipeInput, selectRecipe } from '../recipe-select.js'

// Tests derived from the candidate → recipe mapping in
// prompts/recipes/README.md "Available recipes" and from cut #729's
// spec, not from observing the implementation (team-preferences rule 31).

const ALL_TYPES: CandidateType[] = ['correctness', 'security', 'architecture', 'tests', 'types', 'comments', 'style']

/** A candidate whose wording names no deletion, so only its type decides. */
function byType(type: CandidateType): RecipeInput {
  return { type, summary: 'something to improve', suggested_action: 'improve it per the cited rule' }
}

// Mirrors #728: dead setup lines in a passing test.
const DEAD_TEST_SETUP: RecipeInput = {
  type: 'tests',
  summary:
    'dead setup lines in skip-list.test.ts: mkdirSync after mkdtempSync, and a first writeSkipList call immediately overwritten',
  suggested_action:
    'delete the redundant mkdirSync(tempDir) on line 287 and the first writeSkipList call on line 289; no behavior change',
}

// Mirrors #702: a JSDoc left behind when its function moved.
const ORPHANED_JSDOC: RecipeInput = {
  type: 'comments',
  summary:
    'orphaned JSDoc in dead-code-watcher/index.ts documents extractLastAssistantText, moved to _lib/transcript.ts',
  suggested_action: 'remove the orphaned JSDoc block above openSkipListPR',
}

const COVERAGE_GAP: RecipeInput = {
  type: 'tests',
  summary: 'no test covers the 404 path of GET /api/assets/:name',
  suggested_action: 'add a test asserting GET /api/assets/missing returns 404 with code asset_not_found',
}

describe('selectRecipe — type mapping when no pure deletion is described', () => {
  it.each([
    ['correctness', 'tdd-first'],
    ['security', 'tdd-first'],
    ['architecture', 'tdd-first'],
    ['types', 'tdd-first'],
    ['comments', 'tdd-first'],
    ['style', 'tdd-first'],
    ['tests', 'coverage-shape'],
  ] as const)('%s selects %s', (type, recipe) => {
    expect(selectRecipe(byType(type))).toBe(recipe)
  })

  it('every CandidateType has a recipe assignment (exhaustive)', () => {
    for (const t of ALL_TYPES) {
      expect(['tdd-first', 'coverage-shape', 'mechanical-cleanup']).toContain(selectRecipe(byType(t)))
    }
  })
})

describe('selectRecipe — mechanical-cleanup for pure deletions', () => {
  it('routes the #728 dead-test-setup candidate to mechanical-cleanup', () => {
    expect(selectRecipe(DEAD_TEST_SETUP)).toBe('mechanical-cleanup')
  })

  it('routes the #702 orphaned-JSDoc candidate to mechanical-cleanup', () => {
    expect(selectRecipe(ORPHANED_JSDOC)).toBe('mechanical-cleanup')
  })

  it('routes a dead-code correctness candidate (general lens) to mechanical-cleanup', () => {
    expect(
      selectRecipe({
        type: 'correctness',
        summary: 'unreachable branch after an early return',
        suggested_action: 'drop the unreachable else branch in resolveLocale',
      }),
    ).toBe('mechanical-cleanup')
  })

  it('keeps a coverage-gap candidate on coverage-shape', () => {
    expect(selectRecipe(COVERAGE_GAP)).toBe('coverage-shape')
  })
})

describe('selectRecipe — falls through when the deletion is not clearly inert', () => {
  it.each([
    // Behavior-changing wording after a deletion verb.
    ['tests', 'dead test', 'remove the stale assertion on line 40'],
    ['tests', 'redundant expect', 'delete the redundant expect() and add one for the error path'],
    ['comments', 'stale comment', 'remove the stale comment and rewrite the function signature'],
    ['comments', 'obsolete JSDoc', 'remove the obsolete JSDoc and replace it with a note about locales'],
    ['correctness', 'unused export', 'delete the unused export and return null from resolve instead'],
    // A deletion verb but no claim that what goes is inert.
    ['tests', 'test exceeds 200 lines', 'remove the second describe block'],
    // Not a deletion at all.
    ['comments', 'dead link in comment', 'update the comment to link the new doc'],
  ] as const)('%s: "%s" / "%s" keeps its type recipe', (type, summary, suggested_action) => {
    const candidate: RecipeInput = { type, summary, suggested_action }
    expect(isPureDeletionCandidate(candidate)).toBe(false)
    expect(selectRecipe(candidate)).not.toBe('mechanical-cleanup')
  })

  it.each(['security', 'architecture', 'types', 'style'] as const)(
    'never routes %s candidates to mechanical-cleanup, however they are worded',
    type => {
      expect(selectRecipe({ ...DEAD_TEST_SETUP, type })).toBe('tdd-first')
    },
  )
})
