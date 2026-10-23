/**
 * Write pacing tests.
 *
 * Derived from design-roadmap-board.md Q13, NOT from observing the
 * implementation (team-preferences rule 31): the sync waits 1 second
 * between writes, as GitHub's docs ask for mutative requests, and reads
 * aren't held back.
 */
import { describe, expect, it } from 'vitest'
import { paceMutations } from '../pace.js'

function fakeClock() {
  let time = 0
  const waits: number[] = []
  return {
    now: () => time,
    sleep: async (ms: number) => {
      waits.push(ms)
      time += ms
    },
    advance: (ms: number) => {
      time += ms
    },
    waits,
  }
}

function recorder(clock: { now: () => number }) {
  const sent: Array<{ query: string; at: number }> = []
  const gql = async <T>(query: string): Promise<T> => {
    sent.push({ query, at: clock.now() })
    return {} as T
  }
  return { gql, sent }
}

describe('paceMutations (Q13)', () => {
  it('sends the next write 1 second after the previous one', async () => {
    const clock = fakeClock()
    const { gql, sent } = recorder(clock)
    const paced = paceMutations(gql, clock)
    await paced('mutation { a }')
    clock.advance(300)
    await paced('\n  mutation($x: ID!) { b }')
    expect(sent.map(s => s.at)).toEqual([0, 1000])
    expect(clock.waits).toEqual([700])
  })

  it("doesn't wait when the previous write was more than a second ago", async () => {
    const clock = fakeClock()
    const paced = paceMutations(recorder(clock).gql, clock)
    await paced('mutation { a }')
    clock.advance(1500)
    await paced('mutation { b }')
    expect(clock.waits).toEqual([])
  })

  it("doesn't hold back reads", async () => {
    const clock = fakeClock()
    const paced = paceMutations(recorder(clock).gql, clock)
    await paced('mutation { a }')
    await paced('query($id: ID!) { node(id: $id) { id } }')
    await paced('{ viewer { login } }')
    expect(clock.waits).toEqual([])
  })

  it('keeps writes started together a second apart', async () => {
    const clock = fakeClock()
    const { gql, sent } = recorder(clock)
    const paced = paceMutations(gql, clock)
    await Promise.all([paced('mutation { a }'), paced('mutation { b }'), paced('mutation { c }')])
    expect(sent.map(s => s.at)).toEqual([0, 1000, 2000])
  })

  it('still paces the next write after a write fails', async () => {
    const clock = fakeClock()
    let calls = 0
    const paced = paceMutations(async <T>(): Promise<T> => {
      calls++
      if (calls === 1) throw new Error('boom')
      return {} as T
    }, clock)
    await expect(paced('mutation { a }')).rejects.toThrow('boom')
    await paced('mutation { b }')
    expect(clock.waits).toEqual([1000])
  })
})
