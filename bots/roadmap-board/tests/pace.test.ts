/**
 * Write pacing tests.
 *
 * Derived from design-roadmap-board.md Q13, NOT from observing the
 * implementation (team-preferences rule 31): the sync waits 1 second per
 * write, counting each mutation in a request, stops before 450 writes in a
 * run, treats "was submitted too quickly" as a rate limit, and doesn't hold
 * reads back.
 */
import { describe, expect, it } from 'vitest'
import { countWrites, isRateLimitError, paceWrites, WRITE_CAP, WriteCapReached } from '../pace.js'

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

const one = 'mutation { a(input: {}) { id } }'
const three = 'mutation {\n  w0: a(input: {}) { id }\n  w1: b(input: {}) { id }\n  w2: c( input: {}) { id }\n}'

describe('countWrites', () => {
  it('counts each mutation in a request, and nothing for a read', () => {
    expect(countWrites(one)).toBe(1)
    expect(countWrites(three)).toBe(3)
    expect(countWrites('query($id: ID!) { node(id: $id) { id } }')).toBe(0)
    expect(countWrites('{ viewer { login } }')).toBe(0)
  })
})

describe('paceWrites: 1 second per write (Q13)', () => {
  it('sends the next write 1 second after the previous one', async () => {
    const clock = fakeClock()
    const { gql, sent } = recorder(clock)
    const paced = paceWrites(gql, clock)
    await paced.gql(one)
    clock.advance(300)
    await paced.gql(`\n  ${one}`)
    expect(sent.map(s => s.at)).toEqual([0, 1000])
    expect(clock.waits).toEqual([700])
  })

  it('waits a second for each write the previous request carried', async () => {
    const clock = fakeClock()
    const { gql, sent } = recorder(clock)
    const paced = paceWrites(gql, clock)
    await paced.gql(three)
    await paced.gql(one)
    expect(sent.map(s => s.at)).toEqual([0, 3000])
  })

  it("doesn't wait when the previous write was long enough ago", async () => {
    const clock = fakeClock()
    const paced = paceWrites(recorder(clock).gql, clock)
    await paced.gql(one)
    clock.advance(1500)
    await paced.gql(one)
    expect(clock.waits).toEqual([])
  })

  it("doesn't hold back reads", async () => {
    const clock = fakeClock()
    const paced = paceWrites(recorder(clock).gql, clock)
    await paced.gql(three)
    await paced.gql('query($id: ID!) { node(id: $id) { id } }')
    await paced.gql('{ viewer { login } }')
    expect(clock.waits).toEqual([])
  })

  it('keeps writes started together a second apart', async () => {
    const clock = fakeClock()
    const { gql, sent } = recorder(clock)
    const paced = paceWrites(gql, clock)
    await Promise.all([paced.gql(one), paced.gql(one), paced.gql(one)])
    expect(sent.map(s => s.at)).toEqual([0, 1000, 2000])
  })

  it('still paces the next write after a write fails', async () => {
    const clock = fakeClock()
    let calls = 0
    const paced = paceWrites(async <T>(): Promise<T> => {
      calls++
      if (calls === 1) throw new Error('boom')
      return {} as T
    }, clock)
    await expect(paced.gql(one)).rejects.toThrow('boom')
    await paced.gql(one)
    expect(clock.waits).toEqual([1000])
  })

  it('records when the run sent its first write', async () => {
    const clock = fakeClock()
    const paced = paceWrites(recorder(clock).gql, clock)
    clock.advance(5000)
    expect(paced.firstWriteAt()).toBeNull()
    await paced.gql('{ viewer { login } }')
    expect(paced.firstWriteAt()).toBeNull()
    await paced.gql(one)
    await paced.gql(one)
    expect(paced.firstWriteAt()).toBe(5000)
  })
})

describe('paceWrites: the cap (Q13)', () => {
  it(`stops before ${WRITE_CAP} writes by default`, async () => {
    const clock = fakeClock()
    const { gql, sent } = recorder(clock)
    const paced = paceWrites(gql, clock)
    for (let i = 0; i < WRITE_CAP; i++) await paced.gql(one)
    expect(paced.written()).toBe(WRITE_CAP)
    expect(paced.fits(0)).toBe(true)
    expect(paced.fits(1)).toBe(false)
    await expect(paced.gql(one)).rejects.toBeInstanceOf(WriteCapReached)
    expect(sent).toHaveLength(WRITE_CAP)
  })

  it('refuses a request whose writes would pass the cap, without sending it', async () => {
    const clock = fakeClock()
    const { gql, sent } = recorder(clock)
    const paced = paceWrites(gql, { ...clock, cap: 4 })
    await paced.gql(three)
    expect(paced.fits(1)).toBe(true)
    expect(paced.fits(2)).toBe(false)
    await expect(paced.gql(three)).rejects.toBeInstanceOf(WriteCapReached)
    expect(sent).toHaveLength(1)
    await paced.gql(one)
    expect(paced.written()).toBe(4)
  })

  it("doesn't count a write GitHub refused", async () => {
    const clock = fakeClock()
    const paced = paceWrites(async <T>(): Promise<T> => {
      throw new Error('was submitted too quickly')
    }, clock)
    await expect(paced.gql(three)).rejects.toThrow()
    expect(paced.written()).toBe(0)
  })
})

describe('isRateLimitError (Q13)', () => {
  it('treats GitHub\'s rate-limit errors, "was submitted too quickly" included, as rate limits', () => {
    expect(isRateLimitError(new Error('API rate limit exceeded for user ID 1'))).toBe(true)
    expect(isRateLimitError(new Error('You have exceeded a secondary rate limit'))).toBe(true)
    expect(isRateLimitError(new Error('was submitted too quickly'))).toBe(true)
    expect(isRateLimitError(new Error('Could not resolve to a node with the global id'))).toBe(false)
    expect(isRateLimitError(new WriteCapReached(449))).toBe(false)
  })
})
