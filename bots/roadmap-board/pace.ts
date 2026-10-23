/**
 * Write pacing for the roadmap board sync (design-roadmap-board.md Q13).
 *
 * GitHub's docs ask clients to "pause at least 1 second between mutative
 * requests"; its secondary limits allow 80 content-generating requests a
 * minute and 500 an hour, and don't say whether project writes count. The
 * first sync writes about 330 times, so every mutation waits until a second
 * after the previous one finished. Reads go straight through.
 */
import type { GraphQL } from './project.js'

const MUTATION = /^\s*mutation\b/

export interface PaceOptions {
  intervalMs?: number
  now?: () => number
  sleep?: (ms: number) => Promise<void>
}

export function paceMutations(gql: GraphQL, options: PaceOptions = {}): GraphQL {
  const interval = options.intervalMs ?? 1000
  const now = options.now ?? Date.now
  const sleep = options.sleep ?? (ms => new Promise<void>(resolve => setTimeout(resolve, ms)))
  let lastDone = Number.NEGATIVE_INFINITY
  // Writes started together still go one at a time, each a second after the last.
  let queue: Promise<unknown> = Promise.resolve()

  return <T>(query: string, variables?: Record<string, unknown>): Promise<T> => {
    if (!MUTATION.test(query)) return gql<T>(query, variables)
    const run = queue.then(async () => {
      const wait = lastDone + interval - now()
      if (wait > 0) await sleep(wait)
      try {
        return await gql<T>(query, variables)
      } finally {
        lastDone = now()
      }
    })
    queue = run.catch(() => undefined)
    return run
  }
}
