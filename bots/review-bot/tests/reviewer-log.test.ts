import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { appendReviewerLog, pruneReviewerLog, type ReviewerLogEntry, tailReviewerLog } from '../reviewer-log.js'

let dir: string
let logPath: string

function entry(overrides: Partial<ReviewerLogEntry> = {}): ReviewerLogEntry {
  return {
    ts: '2026-10-12T12:00:00Z',
    runId: '123',
    fingerprint: { area: 'packages/gazetta/src/auth/', type: 'security', rule: 'design-auth-rbac.md' },
    fingerprintLabel: 'packages/gazetta/src/auth/ security',
    attempt: 1,
    verdict: 'approve',
    reasoning: 'capability gate added with a failing test first',
    agentASummary: 'added requireCapability to /api/admin/users',
    ...overrides,
  }
}

const ALL = Number.MAX_SAFE_INTEGER

beforeEach(() => {
  dir = mkdtempSync(resolve(tmpdir(), 'review-bot-reviewer-log-test-'))
  logPath = resolve(dir, 'reviewer-log.jsonl')
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

describe('appendReviewerLog + tailReviewerLog (review-bot)', () => {
  it('round-trips an entry keyed by candidate fingerprint', () => {
    const e = entry()
    appendReviewerLog(logPath, e)
    expect(tailReviewerLog(logPath, ALL)).toEqual([e])
  })

  it('appends in order across verdict types', () => {
    const reject = entry({ verdict: 'reject', reasoning: 'test asserts on observed output' })
    const approve = entry({ attempt: 2, verdict: 'approve' })
    const human = entry({
      fingerprint: { area: 'bots/', type: 'tests', rule: 'team-preferences.md#26' },
      fingerprintLabel: 'bots/ tests',
      verdict: 'needs-human',
    })
    appendReviewerLog(logPath, reject)
    appendReviewerLog(logPath, approve)
    appendReviewerLog(logPath, human)
    expect(tailReviewerLog(logPath, ALL)).toEqual([reject, approve, human])
  })

  it('writes one JSON object per line', () => {
    appendReviewerLog(logPath, entry({ attempt: 1 }))
    appendReviewerLog(logPath, entry({ attempt: 2 }))
    const lines = readFileSync(logPath, 'utf8').split('\n').filter(Boolean)
    expect(lines.map(l => JSON.parse(l).attempt)).toEqual([1, 2])
  })
})

describe('tailReviewerLog (review-bot)', () => {
  it('returns [] when the file does not exist', () => {
    expect(tailReviewerLog(resolve(dir, 'missing.jsonl'), 5)).toEqual([])
  })

  it('skips malformed lines', () => {
    const good = entry()
    writeFileSync(logPath, `${JSON.stringify(good)}\nbroken\n${JSON.stringify(good)}\n`)
    expect(tailReviewerLog(logPath, ALL)).toEqual([good, good])
  })

  it('returns the last N entries in chronological order', () => {
    for (let i = 1; i <= 10; i++) appendReviewerLog(logPath, entry({ attempt: i }))
    expect(tailReviewerLog(logPath, 3).map(e => e.attempt)).toEqual([8, 9, 10])
  })

  it('returns everything when N exceeds the entry count', () => {
    for (let i = 1; i <= 2; i++) appendReviewerLog(logPath, entry({ attempt: i }))
    expect(tailReviewerLog(logPath, 50).map(e => e.attempt)).toEqual([1, 2])
  })
})

describe('pruneReviewerLog (review-bot)', () => {
  it('truncates to the last N entries and reports dropped/kept', () => {
    for (let i = 1; i <= 10; i++) appendReviewerLog(logPath, entry({ attempt: i }))
    expect(pruneReviewerLog(logPath, 3)).toEqual({ dropped: 7, kept: 3 })
    expect(tailReviewerLog(logPath, ALL).map(e => e.attempt)).toEqual([8, 9, 10])
  })

  it('is a no-op when under the threshold', () => {
    for (let i = 1; i <= 3; i++) appendReviewerLog(logPath, entry({ attempt: i }))
    expect(pruneReviewerLog(logPath, 100)).toEqual({ dropped: 0, kept: 3 })
    expect(tailReviewerLog(logPath, ALL).map(e => e.attempt)).toEqual([1, 2, 3])
  })

  it('handles a missing file without creating it', () => {
    const missing = resolve(dir, 'missing.jsonl')
    expect(pruneReviewerLog(missing, 10)).toEqual({ dropped: 0, kept: 0 })
    expect(existsSync(missing)).toBe(false)
  })

  it('lets subsequent appends continue after a prune', () => {
    for (let i = 1; i <= 5; i++) appendReviewerLog(logPath, entry({ attempt: i }))
    pruneReviewerLog(logPath, 2)
    appendReviewerLog(logPath, entry({ attempt: 99 }))
    expect(tailReviewerLog(logPath, ALL).map(e => e.attempt)).toEqual([4, 5, 99])
  })
})
