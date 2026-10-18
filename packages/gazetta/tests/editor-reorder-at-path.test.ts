import { describe, it, expect } from 'vitest'
import { reorderAtPath } from '../src/editor/reorder-at-path.js'

const data = () => ({
  nav: ['N1', 'N2', 'N3'],
  nav_links: ['L1', 'L2', 'L3'],
  settings: { items: ['S1', 'S2', 'S3'], title: 'x' },
  groups: [
    { name: 'G1', tags: ['T1', 'T2', 'T3'] },
    { name: 'G2', tags: ['U1', 'U2'] },
  ],
})

describe('reorderAtPath', () => {
  it.each([
    ['top-level', ['nav'], (d: ReturnType<typeof data>) => d.nav, ['N2', 'N1', 'N3']],
    ['underscore in the name', ['nav_links'], (d: ReturnType<typeof data>) => d.nav_links, ['L2', 'L1', 'L3']],
    ['inside an object', ['settings', 'items'], (d: ReturnType<typeof data>) => d.settings.items, ['S2', 'S1', 'S3']],
    ['inside array items', ['groups', 0, 'tags'], (d: ReturnType<typeof data>) => d.groups[0].tags, ['T2', 'T1', 'T3']],
  ] as const)('moves the array %s and nothing else', (_, path, pick, expected) => {
    const before = data()
    const after = reorderAtPath(before, path, 0, 1)!
    expect(pick(after)).toEqual(expected)
    const untouched = { ...data() }
    // every other array keeps its order
    for (const [k, v] of Object.entries(untouched))
      if (k !== path[0]) expect((after as Record<string, unknown>)[k]).toEqual(v)
  })

  it('moves an item to the end and to the start', () => {
    expect(reorderAtPath(data(), ['nav'], 0, 2)!.nav).toEqual(['N2', 'N3', 'N1'])
    expect(reorderAtPath(data(), ['nav'], 2, 0)!.nav).toEqual(['N3', 'N1', 'N2'])
  })

  it('does not mutate the input and keeps unrelated branches by reference', () => {
    const before = data()
    const after = reorderAtPath(before, ['groups', 0, 'tags'], 0, 1)!
    expect(before.groups[0].tags).toEqual(['T1', 'T2', 'T3'])
    expect(after.groups[1]).toBe(before.groups[1])
    expect(after.settings).toBe(before.settings)
    expect(after.groups[0].name).toBe('G1')
  })

  it.each([
    ['same index', ['nav'], 1, 1],
    ['no array at the path', ['settings'], 0, 1],
    ['missing key', ['missing'], 0, 1],
    ['index out of range', ['nav'], 0, 5],
    ['path through a primitive', ['settings', 'title', 'x'], 0, 1],
  ] as const)('returns null when nothing would change: %s', (_, path, from, to) => {
    expect(reorderAtPath(data(), path, from, to)).toBeNull()
  })
})
