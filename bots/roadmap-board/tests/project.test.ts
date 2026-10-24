/**
 * Tests for the pure parts of project.ts.
 *
 * Derived from design-roadmap-board.md ("Fields", "Project text"): Status
 * keeps GitHub's Done option and its id, so the built-in "closed → Done"
 * rule keeps working, and the project's text says which ROADMAP commit it
 * shows and how to finish the one-time setup; Q13: a run that reaches the
 * write cap stops between cards, never between a card and its fields.
 */
import { describe, expect, it } from 'vitest'
import type { SyncPlan } from '../plan.js'
import {
  applyPlan,
  type FieldOption,
  fieldMutation,
  fieldsToWrite,
  mergeOptions,
  missingViews,
  newSections,
  type ProjectState,
  readme,
  STATUS_OPTIONS,
  sameOptions,
  shortDescription,
  VIEWS,
} from '../project.js'

describe('the views (Q14, Q15)', () => {
  it('has no By area tab: Area is a slice of the bucket tabs', () => {
    expect(VIEWS.map(v => v.name)).toEqual(['Roadmap', 'Now', 'Next', 'Later', 'All', 'Not in ROADMAP.md'])
  })

  it('hides Done in the views that would show closed issues', () => {
    const filter = (name: string) => VIEWS.find(v => v.name === name)?.filter
    expect(filter('Roadmap')).toBe('has:section -status:Done')
    expect(filter('All')).toBe('has:section -status:Done')
    expect(filter('Now')).toBe('status:Now')
  })
})

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
    expect(text).toContain('Slice by Area')
    expect(text).not.toMatch(/by area:|By area/)
    expect(text).toContain('filter `is:issue is:open`')
  })

  it('says in the README what to do with new sections and with a run that stops at the cap', () => {
    const text = readme('gazetta-studio/gazetta-studio')
    expect(text).toContain('prints each Section option it creates')
    expect(text).toContain('hide the new option in the other two tabs, or show it in its own')
    expect(text).toContain('A run stops before 450 writes')
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
    closedListed: [],
    collidingDrafts: [],
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

describe('applyPlan: stops between cards at the cap (Q13)', () => {
  const plan: SyncPlan = {
    addIssues: [
      { number: 1, contentId: 'C1', fields: { status: 'Now', section: 'Bug backlog', area: 'cms' } },
      { number: 2, contentId: 'C2', fields: { status: 'Next', section: 'Offline', area: 'cli' } },
    ],
    addDrafts: [],
    updates: [],
    removals: [],
    offRoadmap: [],
    untouched: [],
    notIssues: [],
    multiArea: [],
    closedListed: [],
    collidingDrafts: [],
    blocked: null,
  }

  function recorder() {
    const sent: Array<{ query: string; variables?: Record<string, unknown> }> = []
    const gql = async <T>(query: string, variables?: Record<string, unknown>): Promise<T> => {
      sent.push({ query, variables })
      return { addProjectV2ItemById: { item: { id: 'I' } } } as T
    }
    return { gql, sent }
  }

  it("doesn't add a card whose writes don't fit, and says it stopped", async () => {
    const { gql, sent } = recorder()
    let budget = 6
    const fits = (n: number) => n <= budget
    const finished = await applyPlan(
      async <T>(query: string, variables?: Record<string, unknown>): Promise<T> => {
        budget -= query.includes('addProjectV2ItemById') ? 1 : 3
        return gql<T>(query, variables)
      },
      state,
      plan,
      () => {},
      fits,
    )
    expect(finished).toBe(false)
    // The first card and its fields (4 writes); the second needs 4 more, and only 2 are left.
    expect(sent).toHaveLength(2)
    expect(sent[0].variables).toMatchObject({ content: 'C1' })
  })

  it('finishes when everything fits', async () => {
    const { gql, sent } = recorder()
    expect(await applyPlan(gql, state, plan, () => {})).toBe(true)
    expect(sent).toHaveLength(4)
  })
})

describe('what a sync sets up (Q12, Q13)', () => {
  const wanted = {
    status: STATUS_OPTIONS,
    section: [
      { name: 'Bug backlog', color: 'GREEN' as const, description: 'Now' },
      { name: 'Onboarding', color: 'BLUE' as const, description: 'Next' },
    ],
    area: [],
  }

  it('lists the Section options a sync creates', () => {
    expect(newSections(state, wanted.section).map(s => s.name)).toEqual(['Onboarding'])
  })

  it('writes each field whose options change, once, and skips a field nothing needs', () => {
    expect(fieldsToWrite(state, wanted).map(f => f.name)).toEqual(['Status', 'Section'])
    const done = {
      ...state,
      status: { id: 'F_status', name: 'Status', options: STATUS_OPTIONS.map((o, i) => ({ id: `s${i}`, ...o })) },
      section: { id: 'F_section', name: 'Section', options: wanted.section.map((o, i) => ({ id: `x${i}`, ...o })) },
    }
    expect(fieldsToWrite(done, wanted)).toEqual([])
  })

  it('creates only the views the project lacks', () => {
    expect(missingViews(state)).toHaveLength(VIEWS.length)
    const some = {
      ...state,
      views: [
        { id: 'V1', name: 'Roadmap' },
        { id: 'V2', name: 'Now' },
      ],
    }
    expect(missingViews(some).map(v => v.name)).toEqual(VIEWS.slice(2).map(v => v.name))
  })
})
