import { describe, expect, it } from 'vitest'
import type { IssueSummary } from '../../_lib/github.js'
import { orderCandidates } from '../candidate-order.js'

function issue(number: number, createdAt: string, labels: string[] = []): IssueSummary {
  return { number, title: `#${number}`, labels: ['bug', 'ready-for-agent', ...labels], createdAt, authorLogin: null }
}

const numbers = (list: IssueSummary[]) => list.map(i => i.number)

describe('orderCandidates', () => {
  it.each([
    {
      name: 'a newer `priority` issue before an older one without it',
      input: [issue(1, '2026-10-01T00:00:00Z'), issue(2, '2026-10-20T00:00:00Z', ['priority'])],
      expected: [2, 1],
    },
    {
      name: 'oldest first among `priority` issues',
      input: [issue(3, '2026-10-20T00:00:00Z', ['priority']), issue(4, '2026-10-05T00:00:00Z', ['priority'])],
      expected: [4, 3],
    },
    {
      name: 'oldest first among issues without `priority`',
      input: [issue(5, '2026-10-20T00:00:00Z'), issue(6, '2026-10-05T00:00:00Z')],
      expected: [6, 5],
    },
    {
      name: 'the lower issue number first when created at the same time',
      input: [issue(8, '2026-10-05T00:00:00Z'), issue(7, '2026-10-05T00:00:00Z')],
      expected: [7, 8],
    },
  ])('puts $name', ({ input, expected }) => {
    expect(numbers(orderCandidates(input))).toEqual(expected)
  })

  it('does not reorder the list it is given', () => {
    const input = [issue(1, '2026-10-01T00:00:00Z'), issue(2, '2026-10-20T00:00:00Z', ['priority'])]
    orderCandidates(input)
    expect(numbers(input)).toEqual([1, 2])
  })
})
