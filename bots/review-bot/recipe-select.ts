/**
 * Recipe selector — maps a candidate to the Agent A recipe file the
 * orchestrator composes onto the shared agent-a.md base.
 *
 * Two layers:
 *   1. A narrow, conservative override: a candidate whose suggested
 *      action is a pure, no-behavior-change deletion selects
 *      `mechanical-cleanup`.
 *   2. Otherwise the candidate's type decides. The
 *      Record<CandidateType, RecipeName> shape makes a new
 *      CandidateType without a recipe a compile error.
 *
 * The override errs toward NOT matching: mechanical-cleanup is the one
 * recipe with no counterfactual, so a candidate that only might be a
 * pure deletion falls through to its type's recipe, which goes STUCK
 * if it doesn't fit.
 *
 * See bots/review-bot/prompts/recipes/README.md for naming and
 * extension rules.
 */
import type { Candidate, CandidateType } from './candidates.js'

export type RecipeName = 'tdd-first' | 'coverage-shape' | 'mechanical-cleanup'

export type RecipeInput = Pick<Candidate, 'type' | 'summary' | 'suggested_action'>

const RECIPE_BY_TYPE: Record<CandidateType, RecipeName> = {
  // Bug-class candidates: failing-test → fix is the right shape.
  correctness: 'tdd-first',
  security: 'tdd-first',
  architecture: 'tdd-first',
  types: 'tdd-first',

  // Documentation + style candidates: the test captures the
  // documentation invariant or style violation.
  comments: 'tdd-first',
  style: 'tdd-first',

  // Coverage-gap candidates: TDD-first can't drive working code.
  tests: 'coverage-shape',
}

// The lenses whose candidates can be dead code: comment rot (comments),
// dead test setup (tests), and audit-area's general lens, which emits
// dead code as `correctness`. Security, architecture and types
// candidates are never routed here, whatever their wording.
const CLEANUP_TYPES = new Set<CandidateType>(['comments', 'tests', 'correctness'])

const DELETION_LEAD = /^\s*(delete|remove|drop)\b/i

const NO_CHANGE_CLAIM = /no behaviou?r change/gi

// The candidate must say what it deletes is inert.
const INERT_MARKER =
  /\b(dead|unused|orphaned|unreachable|stale|redundant|obsolete|no-op|never (read|used|called)|overwritten|duplicated?)\b|no behaviou?r change/i

// Any of these means the change does more than delete; the phrase
// "no behavior change" is removed before this check.
const BEHAVIOR_CHANGE =
  /\b(add|adds|adding|replace|rewrite|change|update|fix|rename|move|extract|split|refactor|implement|introduce|convert|inline|instead|assert|assertion|expect|return|wire|swap)\b/i

/** True when the candidate describes a pure, no-behavior-change deletion. */
export function isPureDeletionCandidate(candidate: RecipeInput): boolean {
  if (!CLEANUP_TYPES.has(candidate.type)) return false
  const action = candidate.suggested_action
  if (!DELETION_LEAD.test(action)) return false
  if (BEHAVIOR_CHANGE.test(action.replace(NO_CHANGE_CLAIM, ''))) return false
  return INERT_MARKER.test(action) || INERT_MARKER.test(candidate.summary)
}

export function selectRecipe(candidate: RecipeInput): RecipeName {
  if (isPureDeletionCandidate(candidate)) return 'mechanical-cleanup'
  return RECIPE_BY_TYPE[candidate.type]
}
