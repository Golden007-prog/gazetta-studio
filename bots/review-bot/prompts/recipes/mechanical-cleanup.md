# Recipe: mechanical-cleanup

**Use when** the candidate's `suggested_action` is a pure deletion that
changes no observable behavior: an orphaned comment, dead test setup
that is overwritten before it is read, an unused local or import.
`recipe-select.ts` picks this recipe only for `comments`, `tests` and
`correctness` candidates whose action starts with delete / remove /
drop, says what it deletes is inert (dead, unused, orphaned, redundant,
overwritten…), and names no other change.

**Not for** anything that adds, rewrites, moves or replaces code, or
removes a test assertion. Those change behavior and belong to
`tdd-first` or `coverage-shape`; if neither fits, the answer is STUCK.

## Why there is no failing test

`tdd-first` needs a defect to test-drive and `coverage-shape` needs a
coverage gap; a pure deletion has neither. A test written only to
prove that a comment is gone is the file-content proof-of-work test
team-preferences rule 41 says to prune. So this recipe is the one
exception to the failing-test-first contract, and the weakest
anti-tautology posture in the bot fleet. It is acceptable only because
the change is a deletion, and only with these two checks in place of
a counterfactual:

1. **Zero references.** Nothing outside the deleted lines uses what you
   delete. Hard gate: if you can't show it, stop.
2. **The wider suite stays green** after the deletion.

## Mechanical-cleanup contract

1. **Single commit, deletion only.** The diff removes lines and adds
   none. The orchestrator checks this with `git diff --numstat` before
   Agent B runs and rejects the attempt if any file adds a line. Don't
   reformat or reflow what remains; if the deletion needs an edit to a
   surrounding line (a trailing comma, a changed argument list), it is
   not a pure deletion: STUCK.
   Subject: `chore(<area>): remove <what was removed>`.
2. **No behavior change.** No test assertion, return value, export,
   side effect or log output may change. Agent B emits a CRITICAL
   finding for any behavior change, which rejects the attempt.
3. **No new tests, no edited tests** beyond the deleted lines
   themselves.

## Process

### 1. Read CANDIDATE_JSON and LESSONS_LEARNED

Open the file the candidate names and find the exact lines. Confirm the
premise: the comment really documents something that isn't there; the
setup line really is overwritten or never read; the symbol really is
unused.

### 2. Zero-references check (hard gate)

For every symbol, import, variable, file or fixture the deletion
removes, search the whole repository:

```bash
git grep -n -w '<symbol>' -- . ':!node_modules'
```

The only hits allowed are the lines you are deleting. Emit the command
and its result as a `> Decision:` note. If anything else references
it (another file, a dynamic import, a string lookup, a doc link), stop:
`RESULT: STUCK`.

For dead setup lines in a test, also show why they are inert (the value
is overwritten on line N before it is read; the directory is already
created by `mkdtempSync`), in a `> Decision:` note.

### 3. Delete the lines

Delete only what the candidate names. Leave everything else in the file
byte-for-byte as it was.

### 4. Run the wider suite

Run the tests of the package the file belongs to, and the tests of any
package that imports it:

```bash
npm test -w <workspace>
```

All must pass. Any failure means the deleted lines were not inert:
restore them and emit `RESULT: STUCK`.

### 5. Commit

```bash
git add -A
git commit -m "chore(<area>): remove <what was removed>"
```

Check `git diff --numstat main...HEAD`: every row must read `0` added.

## Mechanical-cleanup stuck conditions

In addition to the shared stop conditions in `agent-a.md`:

- **References remain**: the zero-references check finds a use outside
  the deleted lines.
- **The suite fails** after the deletion.
- **More than a deletion is needed**: a surrounding line must change,
  or the candidate turns out to change behavior (a removed assertion,
  a changed return). Recommend filing it as a `tdd-first` candidate.

## RESULT format

On success:

```
RESULT: PUSHED
Branch: improve/<candidate-id>
Commit: <subject>
References: <the grep commands run and "no other references">
```

On stuck:

```
RESULT: STUCK
Reason: <one paragraph: which check failed and what the maintainer
should do instead>
```

## Reviewer expectations (Agent B's view)

The orchestrator tells Agent B the diff came from this recipe. Agent B
reviews as normal, and emits a CRITICAL finding when:

- any deleted line changes observable behavior (a test assertion, a
  return value, an export, a side effect);
- a deleted symbol still has references elsewhere.

A CRITICAL finding rejects the attempt.
