import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { appendReviewerLog, pruneReviewerLog, readReviewerLog, tailReviewerLog } from '../reviewer-log.js'

interface Entry {
  attempt: number
  verdict: string
}

let dir: string
let logPath: string

const entry = (attempt: number, verdict = 'approve'): Entry => ({ attempt, verdict })
const attempts = (entries: Entry[]) => entries.map(e => e.attempt)

beforeEach(() => {
  dir = mkdtempSync(resolve(tmpdir(), 'reviewer-log-test-'))
  logPath = resolve(dir, 'reviewer-log.jsonl')
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

describe('appendReviewerLog + readReviewerLog', () => {
  it('round-trips a single entry', () => {
    appendReviewerLog(logPath, entry(1))
    expect(readReviewerLog<Entry>(logPath)).toEqual([entry(1)])
  })

  it('appends in order', () => {
    appendReviewerLog(logPath, entry(1, 'reject'))
    appendReviewerLog(logPath, entry(2, 'approve'))
    appendReviewerLog(logPath, entry(3, 'needs-human'))
    expect(readReviewerLog<Entry>(logPath)).toEqual([entry(1, 'reject'), entry(2, 'approve'), entry(3, 'needs-human')])
  })

  it('writes one JSON object per line', () => {
    appendReviewerLog(logPath, entry(1))
    appendReviewerLog(logPath, entry(2))
    const lines = readFileSync(logPath, 'utf8').split('\n').filter(Boolean)
    expect(lines.map(l => JSON.parse(l).attempt)).toEqual([1, 2])
  })

  it('returns [] when the file does not exist', () => {
    expect(readReviewerLog(resolve(dir, 'missing.jsonl'))).toEqual([])
  })

  it('skips malformed lines', () => {
    writeFileSync(logPath, `${JSON.stringify(entry(1))}\nbroken\n${JSON.stringify(entry(2))}\n`)
    expect(readReviewerLog<Entry>(logPath)).toEqual([entry(1), entry(2)])
  })
})

describe('tailReviewerLog', () => {
  it('returns the last N entries in chronological order', () => {
    for (let i = 1; i <= 10; i++) appendReviewerLog(logPath, entry(i))
    expect(attempts(tailReviewerLog<Entry>(logPath, 3))).toEqual([8, 9, 10])
  })

  it('returns everything when N exceeds the entry count', () => {
    for (let i = 1; i <= 2; i++) appendReviewerLog(logPath, entry(i))
    expect(attempts(tailReviewerLog<Entry>(logPath, 50))).toEqual([1, 2])
  })

  it('returns [] when the file does not exist', () => {
    expect(tailReviewerLog(resolve(dir, 'missing.jsonl'), 5)).toEqual([])
  })
})

describe('pruneReviewerLog', () => {
  it('truncates to the last N entries and reports dropped/kept', () => {
    for (let i = 1; i <= 10; i++) appendReviewerLog(logPath, entry(i))
    expect(pruneReviewerLog(logPath, 3)).toEqual({ dropped: 7, kept: 3 })
    expect(attempts(readReviewerLog<Entry>(logPath))).toEqual([8, 9, 10])
  })

  it('is a no-op when under the threshold', () => {
    for (let i = 1; i <= 3; i++) appendReviewerLog(logPath, entry(i))
    expect(pruneReviewerLog(logPath, 100)).toEqual({ dropped: 0, kept: 3 })
    expect(attempts(readReviewerLog<Entry>(logPath))).toEqual([1, 2, 3])
  })

  it('handles a missing file without creating it', () => {
    const missing = resolve(dir, 'missing.jsonl')
    expect(pruneReviewerLog(missing, 10)).toEqual({ dropped: 0, kept: 0 })
    expect(existsSync(missing)).toBe(false)
  })

  it('is idempotent — a second prune drops nothing', () => {
    for (let i = 1; i <= 10; i++) appendReviewerLog(logPath, entry(i))
    pruneReviewerLog(logPath, 3)
    expect(pruneReviewerLog(logPath, 3)).toEqual({ dropped: 0, kept: 3 })
  })

  it('lets subsequent appends continue after a prune', () => {
    for (let i = 1; i <= 5; i++) appendReviewerLog(logPath, entry(i))
    pruneReviewerLog(logPath, 2)
    appendReviewerLog(logPath, entry(99))
    expect(attempts(readReviewerLog<Entry>(logPath))).toEqual([4, 5, 99])
  })
})
