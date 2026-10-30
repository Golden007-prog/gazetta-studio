# Recipes

Per-candidate-type contract fragments that Agent A follows. The shared
base prompt lives in `bots/review-bot/prompts/agent-a.md`; each recipe
here is a self-contained discipline composed onto the base at
invocation time by the orchestrator.

## What a recipe is

A recipe is a **commit-shape + anti-tautology discipline** tailored to
one class of candidate. Different candidate types need different
contracts:

- A bug fix wants TDD-first ordering (failing test → fix)
- A coverage gap can't drive working code with TDD-first; it needs a
  single-commit shape with anti-tautology counterfactuals
- A refactor (future) wants behavior-preserving multi-commit ordering

The recipe names a commit shape, when to consider yourself stuck, and
the specific RESULT format Agent A emits on success.

## Available recipes

| File | Used for | Commit shape |
|---|---|---|
| `tdd-first.md` | `correctness`, `security`, `architecture`, `types`, `comments`, `style` | Failing test commit → fix commit |
| `coverage-shape.md` | `tests` (coverage gap) | Single test commit against working code, with anti-tautology counterfactuals |
| `mechanical-cleanup.md` | `comments`, `tests`, `correctness` whose suggested action is a pure, no-behavior-change deletion | Single deletion-only commit; zero references + green suite instead of a counterfactual |

The candidate → recipe mapping lives in `../../recipe-select.ts`.
The candidate's type decides (typed exhaustive switch — adding a new
`CandidateType` forces a compile error if no recipe is assigned, so
this layer can't silently drop a type), except that a candidate whose
suggested action is a pure deletion selects `mechanical-cleanup`. That
check errs toward not matching: a candidate that only might be a pure
deletion keeps its type's recipe, which goes STUCK if it doesn't fit.
The orchestrator also checks a `mechanical-cleanup` diff adds no lines
(`../../deletion-gate.ts`) before Agent B runs.

## Adding a new recipe

1. **Write the recipe file** at `bots/review-bot/prompts/recipes/<name>.md`.
   Follow the existing recipes' structure:
   - Use when / not for (preamble)
   - The contract (the load-bearing rules)
   - Process (step-by-step)
   - Recipe-specific stuck conditions
   - RESULT format (parsed by `bots/review-bot/index.ts`)
   - Reviewer expectations (Agent B's view) — optional but
     recommended; helps the reviewer apply matching action policy

2. **Add to `recipe-select.ts`**: extend the `RecipeName` union with
   the new recipe's filename (minus `.md`) and add an entry to
   `RECIPE_BY_TYPE` for the candidate types that select it, or a
   candidate check like `isPureDeletionCandidate` when the type alone
   doesn't decide.

3. **Add a vitest case** in `bots/review-bot/tests/recipe-select.test.ts`
   pinning the dispatch (e.g.,
   `expect(selectRecipe(refactorCandidate)).toBe('refactor-shape')`).

4. **Update this README's "Available recipes" table.**

## Naming convention

Filenames describe the **recipe shape**, not the candidate type they
serve. Reasoning:
- One recipe can serve multiple types (`tdd-first` serves 5 of the
  7 candidate types)
- One type can in principle select different recipes per context
  (a future security candidate with new-capability shape might use
  a different recipe than one with missing-gate shape)
- Recipe names compose naturally across bots — `tdd-first` reads
  identically whether fix-bot or review-bot uses it

## Cross-bot promotion

Per `bots/README.md`: "If three+ bots end up needing the same helper,
extract to `_lib/`." If a third bot starts using one of these recipes,
promote the file to `bots/_lib/recipes/<name>.md` and update both
consumers' `recipe-select.ts` to import the path.

Today (v1):
- review-bot uses recipes for Agent A
- fix-bot has its own per-issue prompt that COULD adopt this pattern
  (its TDD-first contract is structurally identical to ours); not
  refactored yet — would land as a separate fix-bot consolidation cut
- dead-code-watcher deletes exported symbols with its own reviewer
  checks; `mechanical-cleanup` is narrower (inert lines only) and
  isn't shared with it
