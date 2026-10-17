import { describe, expect, it } from 'vitest'
import { countWeeklyRuns, type ReviewerLogEntry } from '../reviewer-log.js'

function entry(overrides: Partial<ReviewerLogEntry> = {}): ReviewerLogEntry {
  return {
    ts: '2026-05-17T12:00:00Z',
    runId: 'run-1',
    action: 'add',
    addedModule: 'packages/gazetta/src/archive/index.ts',
    removedModule: null,
    topInclusionScore: 0.72,
    worstEvictionScore: 0.3,
    estimatedRuntimeAfterMinutes: 120,
    reasoning: 'top candidate scored above INCLUSION_THRESHOLD',
    bootstrapWeek: null,
    ...overrides,
  }
}

describe('countWeeklyRuns', () => {
  it('returns 0 for empty entries', () => {
    expect(countWeeklyRuns([])).toBe(0)
  })

  it('counts distinct YYYY-MM-DD dates', () => {
    const entries = [
      entry({ ts: '2026-05-17T05:00:00Z' }),
      entry({ ts: '2026-05-17T06:00:00Z' }), // same day, doesn't count again
      entry({ ts: '2026-05-24T05:00:00Z' }),
      entry({ ts: '2026-05-31T05:00:00Z' }),
    ]
    expect(countWeeklyRuns(entries)).toBe(3)
  })
})
