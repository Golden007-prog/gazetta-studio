import { describe, expect, it } from 'vitest'
import { checkDeletionOnly } from '../deletion-gate.js'

// `git diff --numstat` rows are `<added>\t<deleted>\t<path>`; binary
// files show `-\t-\t<path>`.

describe('checkDeletionOnly', () => {
  it('passes a diff that only deletes lines', () => {
    expect(checkDeletionOnly('0\t4\tbots/dead-code-watcher/tests/skip-list.test.ts\n0\t7\tbots/x.ts\n')).toEqual({
      ok: true,
    })
  })

  it.each([
    ['an added line', '1\t4\tbots/x.ts\n', 'bots/x.ts (+1)'],
    ['an added line in one of several files', '0\t3\ta.ts\n2\t0\tb.ts\n', 'b.ts (+2)'],
    ['a binary change', '-\t-\tassets/logo.png\n', 'assets/logo.png (binary change)'],
  ])('fails %s, naming the file', (_label, numstat, named) => {
    const result = checkDeletionOnly(numstat)
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.reason).toContain(named)
  })

  it.each(['', '\n', '  \n'])('fails an empty diff (%j)', numstat => {
    expect(checkDeletionOnly(numstat)).toEqual({ ok: false, reason: 'the branch changes no files' })
  })
})
