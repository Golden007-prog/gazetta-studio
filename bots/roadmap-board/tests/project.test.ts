/**
 * Tests for the pure parts of project.ts.
 *
 * Derived from design-roadmap-board.md ("Fields", "Project text"): Status
 * keeps GitHub's Done option and its id, so the built-in "closed → Done"
 * rule keeps working, and the project's text says which ROADMAP commit it
 * shows and how to finish the one-time setup.
 */
import { describe, expect, it } from 'vitest'
import { type FieldOption, mergeOptions, readme, STATUS_OPTIONS, sameOptions, shortDescription } from '../project.js'

const option = (id: string, name: string, color: FieldOption['color'] = 'GRAY', description = ''): FieldOption => ({
  id,
  name,
  color,
  description,
})

describe('mergeOptions', () => {
  const fresh = [option('o1', 'Todo', 'GREEN'), option('o2', 'In Progress', 'YELLOW'), option('o3', 'Done', 'PURPLE')]

  it('keeps the id of an option that keeps its name, so items holding it keep their value', () => {
    const merged = mergeOptions(fresh, STATUS_OPTIONS)
    expect(merged.find(o => o.name === 'Done')?.id).toBe('o3')
  })

  it('sends new options without an id and drops options that are no longer wanted', () => {
    const merged = mergeOptions(fresh, STATUS_OPTIONS)
    expect(merged.map(o => o.name)).toEqual(['Now', 'Next', 'Later', 'Deferred', 'Done'])
    expect(merged.filter(o => o.name !== 'Done').every(o => o.id === undefined)).toBe(true)
  })
})

describe('sameOptions', () => {
  it('is true only when names, colours, descriptions and order all match', () => {
    const wanted = [
      { name: 'Now', color: 'GREEN' as const, description: 'a' },
      { name: 'Next', color: 'BLUE' as const, description: 'b' },
    ]
    expect(sameOptions([option('1', 'Now', 'GREEN', 'a'), option('2', 'Next', 'BLUE', 'b')], wanted)).toBe(true)
    expect(sameOptions([option('2', 'Next', 'BLUE', 'b'), option('1', 'Now', 'GREEN', 'a')], wanted)).toBe(false)
    expect(sameOptions([option('1', 'Now', 'GRAY', 'a'), option('2', 'Next', 'BLUE', 'b')], wanted)).toBe(false)
    expect(sameOptions([option('1', 'Now', 'GREEN', 'a')], wanted)).toBe(false)
  })
})

describe('project text', () => {
  it('names the ROADMAP commit and the sync date in the description', () => {
    expect(shortDescription('dcfcdb8', '2026-10-23')).toBe(
      'Generated from ROADMAP.md at dcfcdb8 on 2026-10-23. Edit the file, not the board.',
    )
  })

  it('links ROADMAP.md and lists the one-time setup in the README', () => {
    const text = readme('gazetta-studio/gazetta-studio')
    expect(text).toContain('https://github.com/gazetta-studio/gazetta-studio/blob/main/ROADMAP.md')
    expect(text).toContain('column by Section')
    expect(text).toContain('group by Area')
    expect(text).toContain('filter `is:issue is:open`')
  })
})
