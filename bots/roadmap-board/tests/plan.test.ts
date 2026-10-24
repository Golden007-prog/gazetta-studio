/**
 * Sync planner tests.
 *
 * Derived from design-roadmap-board.md ("The sync", Q3, Q7 the Area rule,
 * Q8 the stop, Q13 the write count), NOT from observing the implementation
 * (team-preferences rule 31).
 */
import { describe, expect, it } from 'vitest'
import type { ParsedRoadmap } from '../parse.js'
import {
  areaOf,
  type Fields,
  type IssueInfo,
  OFF_ROADMAP_LIMIT,
  type ProjectItem,
  planSync,
  planWrites,
} from '../plan.js'

const roadmap = (over: Partial<ParsedRoadmap> = {}): ParsedRoadmap => ({
  placements: new Map(),
  repeated: [],
  drafts: [],
  sections: [],
  ...over,
})

const info = (number: number, state: 'OPEN' | 'CLOSED', labels: string[] = ['area: cms']): IssueInfo => ({
  number,
  id: `I_${number}`,
  state,
  labels,
})

const fields = (status: Fields['status'], section: string | null, area: string | null): Fields => ({
  status,
  section,
  area,
})

const issueItem = (number: number, f: Fields): ProjectItem => ({
  itemId: `PVTI_${number}`,
  type: 'issue',
  number,
  fields: f,
})

describe('planSync — issues the file mentions', () => {
  it('adds a mentioned open issue with its bucket, section and area', () => {
    const plan = planSync({
      roadmap: roadmap({ placements: new Map([[1068, { number: 1068, bucket: 'Now', section: 'Bug backlog' }]]) }),
      issues: new Map([[1068, info(1068, 'OPEN', ['bug', 'area: storage'])]]),
      items: [],
      allowRemovals: false,
    })
    expect(plan.addIssues).toEqual([
      { number: 1068, contentId: 'I_1068', fields: fields('Now', 'Bug backlog', 'storage') },
    ])
  })

  it('lists the closed issues the file still lists, for the Shipped appendix (Q15)', () => {
    const plan = planSync({
      roadmap: roadmap({
        placements: new Map([
          [515, { number: 515, bucket: 'Now', section: 'Review workflow' }],
          [516, { number: 516, bucket: 'Now', section: 'Review workflow' }],
        ]),
      }),
      issues: new Map([
        [515, info(515, 'CLOSED')],
        [516, info(516, 'OPEN')],
        [600, info(600, 'CLOSED')],
      ]),
      items: [],
      allowRemovals: false,
    })
    expect(plan.closedListed).toEqual([515])
  })

  it('puts a mentioned closed issue in Done and keeps its section', () => {
    const plan = planSync({
      roadmap: roadmap({ placements: new Map([[515, { number: 515, bucket: 'Now', section: 'Review workflow' }]]) }),
      issues: new Map([[515, info(515, 'CLOSED')]]),
      items: [],
      allowRemovals: false,
    })
    expect(plan.addIssues[0].fields).toEqual(fields('Done', 'Review workflow', 'cms'))
  })

  it('reports a mentioned number that is not an issue (a pull request, or missing)', () => {
    const plan = planSync({
      roadmap: roadmap({ placements: new Map([[1179, { number: 1179, bucket: 'Now', section: 'A' }]]) }),
      issues: new Map(),
      items: [],
      allowRemovals: false,
    })
    expect(plan.addIssues).toEqual([])
    expect(plan.notIssues).toEqual([1179])
  })
})

describe('planSync — open issues the file does not mention (Q3)', () => {
  it('adds them with no Status and no Section, so only "Not in ROADMAP.md" shows them', () => {
    const plan = planSync({
      roadmap: roadmap(),
      issues: new Map([[1061, info(1061, 'OPEN', ['bug', 'area: renderer'])]]),
      items: [],
      allowRemovals: false,
    })
    expect(plan.addIssues).toEqual([{ number: 1061, contentId: 'I_1061', fields: fields(null, null, 'renderer') }])
  })

  it('clears Status and Section on an item whose issue left the file but is still open', () => {
    const plan = planSync({
      roadmap: roadmap(),
      issues: new Map([[1061, info(1061, 'OPEN', ['area: renderer'])]]),
      items: [issueItem(1061, fields('Now', 'Bug backlog', 'renderer'))],
      allowRemovals: false,
    })
    expect(plan.updates).toEqual([{ itemId: 'PVTI_1061', label: '#1061', fields: { status: null, section: null } }])
    expect(plan.removals).toEqual([])
  })

  it('removes an issue item that is neither in the file nor open', () => {
    const plan = planSync({
      roadmap: roadmap(),
      issues: new Map(),
      items: [issueItem(200, fields('Done', null, 'cms'))],
      allowRemovals: false,
    })
    expect(plan.removals).toEqual([{ itemId: 'PVTI_200', label: '#200', reason: 'closed and not in ROADMAP.md' }])
  })
})

describe('planSync — drafts (Q3)', () => {
  const draft = {
    title: 'Real-time presence MVP',
    body: 'Trigger to revisit: Operator demand',
    bucket: 'Deferred' as const,
    section: 'Deferred',
  }

  it('adds a draft card for an item without an issue', () => {
    const plan = planSync({ roadmap: roadmap({ drafts: [draft] }), issues: new Map(), items: [], allowRemovals: false })
    expect(plan.addDrafts).toEqual([
      { title: draft.title, body: draft.body, fields: fields('Deferred', 'Deferred', null) },
    ])
  })

  it('matches drafts by title: updates a changed body and deletes drafts the file no longer has', () => {
    const plan = planSync({
      roadmap: roadmap({ drafts: [draft] }),
      issues: new Map(),
      items: [
        {
          itemId: 'PVTI_d1',
          type: 'draft',
          draftId: 'DI_1',
          title: draft.title,
          body: 'old',
          fields: fields('Deferred', 'Deferred', null),
        },
        {
          itemId: 'PVTI_d2',
          type: 'draft',
          draftId: 'DI_2',
          title: 'Gone row',
          body: '',
          fields: fields('Deferred', 'Deferred', null),
        },
      ],
      allowRemovals: false,
    })
    expect(plan.addDrafts).toEqual([])
    expect(plan.updates).toEqual([
      { itemId: 'PVTI_d1', label: draft.title, fields: {}, body: { draftId: 'DI_1', body: draft.body } },
    ])
    expect(plan.removals).toEqual([{ itemId: 'PVTI_d2', label: 'Gone row', reason: 'no longer in ROADMAP.md' }])
  })

  it('gives only the first of several rows with one title a card, and lists them', () => {
    const later = { ...draft, body: 'another row', bucket: 'Later' as const, section: 'Onboarding' }
    const plan = planSync({
      roadmap: roadmap({ drafts: [draft, later, { ...draft, title: 'Other row' }] }),
      issues: new Map(),
      items: [],
      allowRemovals: false,
    })
    expect(plan.addDrafts.map(d => [d.title, d.body])).toEqual([
      [draft.title, draft.body],
      ['Other row', draft.body],
    ])
    expect(plan.collidingDrafts).toEqual([
      { title: draft.title, places: ['Deferred / Deferred', 'Later / Onboarding'] },
    ])
  })

  it('lists no collisions when every title is different', () => {
    const plan = planSync({ roadmap: roadmap({ drafts: [draft] }), issues: new Map(), items: [], allowRemovals: false })
    expect(plan.collidingDrafts).toEqual([])
  })
})

describe('planSync — what it leaves alone', () => {
  it('changes nothing when the board already matches', () => {
    const plan = planSync({
      roadmap: roadmap({ placements: new Map([[1068, { number: 1068, bucket: 'Now', section: 'Bug backlog' }]]) }),
      issues: new Map([[1068, info(1068, 'OPEN')]]),
      items: [issueItem(1068, fields('Now', 'Bug backlog', 'cms'))],
      allowRemovals: false,
    })
    expect(plan.addIssues).toEqual([])
    expect(plan.updates).toEqual([])
    expect(plan.removals).toEqual([])
  })

  it('updates only the fields that differ', () => {
    const plan = planSync({
      roadmap: roadmap({ placements: new Map([[1068, { number: 1068, bucket: 'Next', section: 'Bug backlog' }]]) }),
      issues: new Map([[1068, info(1068, 'OPEN')]]),
      items: [issueItem(1068, fields('Now', 'Bug backlog', 'cms'))],
      allowRemovals: false,
    })
    expect(plan.updates).toEqual([{ itemId: 'PVTI_1068', label: '#1068', fields: { status: 'Next' } }])
  })

  it('leaves items that are neither issues of this repository nor drafts, and reports them', () => {
    const plan = planSync({
      roadmap: roadmap(),
      issues: new Map(),
      items: [{ itemId: 'PVTI_pr', type: 'other', label: 'pull request #1179' }],
      allowRemovals: false,
    })
    expect(plan.removals).toEqual([])
    expect(plan.untouched).toEqual(['pull request #1179'])
  })
})

describe('planSync — the stop on cards leaving the roadmap (Q8)', () => {
  const numbers = (count: number) => Array.from({ length: count }, (_, i) => i + 1)
  /** Listed issues, now closed and gone from the file: removed. */
  const listedClosed = (count: number) => numbers(count).map(n => issueItem(n, fields('Done', 'Bug backlog', 'cms')))
  /** Open issues still on the board with a Section the file no longer gives them. */
  const listedOpen = (count: number) =>
    numbers(count).map(n => issueItem(n, fields('Later', 'Content features', 'cms')))
  /** Closed issues the file never listed: removed, but they were never on the roadmap. */
  const neverListed = (count: number) => numbers(count).map(n => issueItem(n, fields('Done', null, 'cms')))

  it(`stops a run that would remove more than ${OFF_ROADMAP_LIMIT} listed issues`, () => {
    const plan = planSync({
      roadmap: roadmap(),
      issues: new Map(),
      items: listedClosed(OFF_ROADMAP_LIMIT + 1),
      allowRemovals: false,
    })
    expect(plan.blocked).toMatch(/--allow-removals/)
  })

  it('counts open issues whose Section it would clear, as when the parser misses a section', () => {
    const open = new Map(numbers(OFF_ROADMAP_LIMIT + 1).map(n => [n, info(n, 'OPEN')]))
    const plan = planSync({
      roadmap: roadmap(),
      issues: open,
      items: listedOpen(OFF_ROADMAP_LIMIT + 1),
      allowRemovals: false,
    })
    expect(plan.removals).toEqual([])
    expect(plan.offRoadmap).toHaveLength(OFF_ROADMAP_LIMIT + 1)
    expect(plan.blocked).toMatch(/--allow-removals/)
  })

  it('counts drafts it would remove', () => {
    const drafts: ProjectItem[] = numbers(OFF_ROADMAP_LIMIT + 1).map(n => ({
      itemId: `PVTI_d${n}`,
      type: 'draft',
      draftId: `DI_${n}`,
      title: `Row ${n}`,
      body: '',
      fields: fields('Deferred', 'Deferred', null),
    }))
    expect(planSync({ roadmap: roadmap(), issues: new Map(), items: drafts, allowRemovals: false }).blocked).toMatch(
      /--allow-removals/,
    )
  })

  it('lets closed issues the file never listed leave without counting', () => {
    const plan = planSync({ roadmap: roadmap(), issues: new Map(), items: neverListed(50), allowRemovals: false })
    expect(plan.removals).toHaveLength(50)
    expect(plan.offRoadmap).toEqual([])
    expect(plan.blocked).toBeNull()
  })

  it(`lets ${OFF_ROADMAP_LIMIT} through, and more with allowRemovals`, () => {
    const run = (count: number, allowRemovals: boolean) =>
      planSync({ roadmap: roadmap(), issues: new Map(), items: listedClosed(count), allowRemovals }).blocked
    expect(run(OFF_ROADMAP_LIMIT, false)).toBeNull()
    expect(run(OFF_ROADMAP_LIMIT + 1, true)).toBeNull()
  })
})

describe('areaOf — the Area rule', () => {
  it('takes the area: label', () => {
    expect(areaOf(['bug', 'area: storage'])).toBe('storage')
  })

  it('takes the first of cms, renderer, cli, storage, templates when an issue has two', () => {
    expect(areaOf(['area: templates', 'area: renderer'])).toBe('renderer')
    expect(areaOf(['area: storage', 'area: cms'])).toBe('cms')
  })

  it('returns null without an area label', () => {
    expect(areaOf(['bug'])).toBeNull()
  })

  it('lists issues with two area labels in the plan', () => {
    const plan = planSync({
      roadmap: roadmap(),
      issues: new Map([[1061, info(1061, 'OPEN', ['area: cli', 'area: cms'])]]),
      items: [],
      allowRemovals: false,
    })
    expect(plan.multiArea).toEqual([1061])
  })
})

describe('planWrites (Q13)', () => {
  it('counts a write per card added and per field it gets, but none for an empty field on a new card', () => {
    const plan = planSync({
      roadmap: roadmap({
        placements: new Map([[1, { number: 1, bucket: 'Now', section: 'Offline' }]]),
        drafts: [{ title: 'Row', body: '', bucket: 'Later', section: 'Onboarding' }],
      }),
      issues: new Map([
        [1, info(1, 'OPEN')],
        [2, info(2, 'OPEN', [])],
      ]),
      items: [],
      allowRemovals: false,
    })
    // #1: card + Status + Section + Area; #2 (not in the file, no area): card only; the draft: card + Status + Section.
    expect(planWrites(plan)).toBe(4 + 1 + 3)
  })

  it('counts each field an update sets or clears, a draft body, and each removal', () => {
    const plan = planSync({
      roadmap: roadmap({ drafts: [{ title: 'Row', body: 'new', bucket: 'Now', section: 'Offline' }] }),
      issues: new Map([[5, info(5, 'OPEN')]]),
      items: [
        issueItem(5, fields('Now', 'Offline', 'cms')),
        issueItem(6, fields('Done', 'Offline', 'cms')),
        {
          itemId: 'PVTI_d',
          type: 'draft',
          draftId: 'DI',
          title: 'Row',
          body: 'old',
          fields: fields('Later', 'Offline', null),
        },
      ],
      allowRemovals: false,
    })
    // #5 left the file but is open: Status and Section cleared (2). #6 is closed and gone: removed (1).
    // The draft moved to Now with a new body: Status (1) and body (1).
    expect(planWrites(plan)).toBe(2 + 1 + 2)
  })
})
