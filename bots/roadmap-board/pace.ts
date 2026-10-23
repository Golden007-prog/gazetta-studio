/**
 * Write pacing and the per-run cap for the roadmap board sync
 * (design-roadmap-board.md Q13).
 *
 * GitHub's docs ask clients to "pause at least 1 second between mutative
 * requests"; its secondary limits allow 80 content-generating requests a
 * minute and 500 an hour. They don't say how a request carrying several
 * mutations counts, and the one report found counts each creation, so the
 * sync counts writes: after a request with n writes the next waits n seconds,
 * and a run stops before WRITE_CAP writes. Reads go straight through.
 */
import type { GraphQL } from './project.js'

const MUTATION = /^\s*mutation\b/
// Every mutation field the sync sends takes one `input:` argument.
const INPUT = /\(\s*input\s*:/g

/** A run stops before this many writes, under GitHub's 500 an hour. */
export const WRITE_CAP = 450

/** The writes a request carries: none for a read, one per mutation field otherwise. */
export function countWrites(query: string): number {
  if (!MUTATION.test(query)) return 0
  return Math.max(1, query.match(INPUT)?.length ?? 0)
}

/** GitHub's rate-limit errors: the documented one, and the content limit's "was submitted too quickly". */
export function isRateLimitError(err: unknown): boolean {
  return /rate limit|submitted too quickly/i.test(String(err))
}

export class WriteCapReached extends Error {
  constructor(readonly written: number) {
    super(`Stopped after ${written} writes, before the ${WRITE_CAP}-write cap`)
    this.name = 'WriteCapReached'
  }
}

export interface PaceOptions {
  intervalMs?: number
  cap?: number
  now?: () => number
  sleep?: (ms: number) => Promise<void>
}

export interface PacedWrites {
  gql: GraphQL
  /** Writes GitHub accepted in this run. */
  written(): number
  /** Whether n more writes stay within the cap. */
  fits(n: number): boolean
  /** When this run sent its first write, or null before it. */
  firstWriteAt(): number | null
}

export function paceWrites(gql: GraphQL, options: PaceOptions = {}): PacedWrites {
  const interval = options.intervalMs ?? 1000
  const cap = options.cap ?? WRITE_CAP
  const now = options.now ?? Date.now
  const sleep = options.sleep ?? (ms => new Promise<void>(resolve => setTimeout(resolve, ms)))
  let nextAt = Number.NEGATIVE_INFINITY
  let written = 0
  let first: number | null = null
  // Writes started together still go one at a time.
  let queue: Promise<unknown> = Promise.resolve()

  const paced: GraphQL = <T>(query: string, variables?: Record<string, unknown>): Promise<T> => {
    const n = countWrites(query)
    if (n === 0) return gql<T>(query, variables)
    const run = queue.then(async () => {
      if (written + n > cap) throw new WriteCapReached(written)
      const wait = nextAt - now()
      if (wait > 0) await sleep(wait)
      first ??= now()
      try {
        const result = await gql<T>(query, variables)
        written += n
        return result
      } finally {
        nextAt = now() + interval * n
      }
    })
    queue = run.catch(() => undefined)
    return run
  }

  return {
    gql: paced,
    written: () => written,
    fits: n => written + n <= cap,
    firstWriteAt: () => first,
  }
}
