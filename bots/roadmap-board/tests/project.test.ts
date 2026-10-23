/**
 * Tests for the pure parts of project.ts.
 *
 * Derived from design-roadmap-board.md ("Fields", "Project text"): Status
 * keeps GitHub's Done option and its id, so the built-in "closed → Done"
 * rule keeps working, and the project's text says which ROADMAP commit it
 * shows and how to finish the one-time setup.
 */
import { describe, expect, it } from 'vitest'
import type { SyncPlan } from '../plan.js'
import {
  applyPlan,
  type FieldOption,
  fieldMutation,
  mergeOptions,
  type ProjectState,
  readme,
  STATUS_OPTIONS,
  sameOptions,
  shortDescription,
} from '../project.js'

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
    expect(text).toContain("hide the other buckets' sections")
    expect(text).toContain('group by Area')
    expect(text).toContain('filter `is:issue is:open`')
  })
})

const field = (id: string, name: string, options: string[]) => ({
  id,
  name,
  options: options.map((o, i) => option(`${id}-${i}`, o)),
})

const state: ProjectState = {
  id: 'P',
  url: '',
  fieldIds: new Map(),
  status: field('F_status', 'Status', ['Now', 'Next', 'Done']),
  section: field('F_section', 'Section', ['Bug backlog', 'Offline']),
  area: field('F_area', 'Area', ['cms', 'cli']),
  items: [],
  views: [],
}

describe('fieldMutation: one request per card (Q13)', () => {
  it('sets every field of a card in a single mutation', () => {
    const m = fieldMutation(
      state,
      'ITEM',
      { status: 'Now', section: 'Bug backlog', area: 'cms' },
      { clearEmpty: false },
    )
    expect(m?.query.match(/updateProjectV2ItemFieldValue/g)).toHaveLength(3)
    expect(m?.variables).toMatchObject({ project: 'P', item: 'ITEM' })
    expect(Object.values(m?.variables ?? {})).toEqual(
      expect.arrayContaining(['F_status', 'F_status-0', 'F_section', 'F_section-0', 'F_area', 'F_area-0']),
    )
  })

  it("doesn't clear empty fields on a card it has just added", () => {
    const m = fieldMutation(state, 'ITEM', { status: null, section: null, area: 'cli' }, { clearEmpty: false })
    expect(m?.query).not.toMatch(/clearProjectV2ItemFieldValue/)
    expect(m?.query.match(/updateProjectV2ItemFieldValue/g)).toHaveLength(1)
  })

  it('clears a field an update empties, in the same request as the other changes', () => {
    const m = fieldMutation(state, 'ITEM', { status: null, section: 'Offline' }, { clearEmpty: true })
    expect(m?.query.match(/clearProjectV2ItemFieldValue/g)).toHaveLength(1)
    expect(m?.query.match(/updateProjectV2ItemFieldValue/g)).toHaveLength(1)
  })

  it('sends nothing when there is nothing to write', () => {
    expect(fieldMutation(state, 'ITEM', {}, { clearEmpty: true })).toBeNull()
    expect(fieldMutation(state, 'ITEM', { section: null }, { clearEmpty: false })).toBeNull()
  })

  it('refuses a value the field has no option for', () => {
    expect(() => fieldMutation(state, 'ITEM', { section: 'Gone' }, { clearEmpty: false })).toThrow(/no option "Gone"/)
  })
})

describe('applyPlan: two requests per new card, and no clears on it (Q13)', () => {
  const emptyPlan: SyncPlan = {
    addIssues: [],
    addDrafts: [],
    updates: [],
    removals: [],
    offRoadmap: [],
    untouched: [],
    notIssues: [],
    multiArea: [],
    blocked: null,
  }

  it('adds each card, then writes its fields in one request; an update still clears what it empties', async () => {
    const sent: string[] = []
    const gql = async <T>(query: string): Promise<T> => {
      sent.push(query)
      if (query.includes('addProjectV2ItemById')) return { addProjectV2ItemById: { item: { id: 'I' } } } as T
      if (query.includes('addProjectV2DraftIssue')) return { addProjectV2DraftIssue: { projectItem: { id: 'D' } } } as T
      return {} as T
    }
    await applyPlan(
      gql,
      state,
      {
        ...emptyPlan,
        addIssues: [
          { number: 1, contentId: 'C1', fields: { status: null, section: null, area: 'cms' } },
          { number: 2, contentId: 'C2', fields: { status: 'Now', section: 'Bug backlog', area: 'cli' } },
        ],
        addDrafts: [{ title: 'Row', body: '', fields: { status: 'Next', section: 'Offline', area: null } }],
        updates: [{ itemId: 'U', label: '#3', fields: { section: null } }],
      },
      () => {},
    )
    const adds = sent.filter(q => q.includes('addProjectV2'))
    const fieldWrites = sent.filter(q => !q.includes('addProjectV2'))
    expect(adds).toHaveLength(3)
    expect(fieldWrites).toHaveLength(4)
    expect(fieldWrites.slice(0, 3).some(q => q.includes('clearProjectV2ItemFieldValue'))).toBe(false)
    expect(fieldWrites[3]).toContain('clearProjectV2ItemFieldValue')
  })
})
