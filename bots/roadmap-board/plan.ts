/**
 * Sync planner for the roadmap board.
 *
 * Compares what ROADMAP.md says (parse.ts) with the project's current items
 * and returns the changes, without touching GitHub, per
 * design-roadmap-board.md "The sync":
 * - every issue the file mentions gets its bucket (Done once closed),
 *   section and area;
 * - every open issue the file doesn't mention is on the board with no
 *   Status and no Section, so only the "Not in ROADMAP.md" view shows it;
 * - an issue that is neither is removed, and so is a draft the file no
 *   longer has; anything else (a pull request added by hand) is left alone;
 * - a run that would take more than OFF_ROADMAP_LIMIT cards off the roadmap
 *   is blocked (Q8). A misread file shows up that way: a lost section's open
 *   issues lose their Section, its closed issues and drafts are removed.
 *   Closed issues the file never listed leave without counting.
 * - drafts are matched by title, so of several rows with one title only the
 *   first gets a card; the plan lists them (Q3).
 */
import type { Bucket, Draft, ParsedRoadmap } from './parse.js'

export type Status = Bucket | 'Done'

export interface Fields {
  status: Status | null
  section: string | null
  area: string | null
}

export interface IssueInfo {
  number: number
  /** Node id, for adding the issue to the project. */
  id: string
  state: 'OPEN' | 'CLOSED'
  labels: string[]
}

export type ProjectItem =
  | { itemId: string; type: 'issue'; number: number; fields: Fields }
  | { itemId: string; type: 'draft'; draftId: string; title: string; body: string; fields: Fields }
  | { itemId: string; type: 'other'; label: string }

export interface PlanInput {
  roadmap: ParsedRoadmap
  /** Every mentioned number that is an issue, and every open issue. */
  issues: Map<number, IssueInfo>
  items: ProjectItem[]
  allowRemovals: boolean
}

export interface SyncPlan {
  addIssues: Array<{ number: number; contentId: string; fields: Fields }>
  addDrafts: Array<{ title: string; body: string; fields: Fields }>
  updates: Array<{ itemId: string; label: string; fields: Partial<Fields>; body?: { draftId: string; body: string } }>
  removals: Array<{ itemId: string; label: string; reason: string }>
  /** Cards leaving the roadmap, by label: removed, or their Section cleared. */
  offRoadmap: string[]
  /** Items the sync doesn't own, by label. */
  untouched: string[]
  /** Mentioned numbers that aren't issues: pull requests, or missing. */
  notIssues: number[]
  /** Issues with more than one area label; triage gives each issue one. */
  multiArea: number[]
  /** Draft titles the file has more than once, with where each is; only the first gets a card (Q3). */
  collidingDrafts: Array<{ title: string; places: string[] }>
  /** Why the run must stop before writing, or null. */
  blocked: string | null
}

export const OFF_ROADMAP_LIMIT = 10
export const AREA_ORDER: readonly string[] = ['cms', 'renderer', 'cli', 'storage', 'templates']

const AREA_PREFIX = 'area: '

/** The issue's area label; with two, the first in AREA_ORDER. */
export function areaOf(labels: readonly string[]): string | null {
  const rank = (area: string) => {
    const i = AREA_ORDER.indexOf(area)
    return i === -1 ? AREA_ORDER.length : i
  }
  const areas = labels.filter(l => l.startsWith(AREA_PREFIX)).map(l => l.slice(AREA_PREFIX.length))
  return areas.sort((a, b) => rank(a) - rank(b) || a.localeCompare(b))[0] ?? null
}

export function planSync(input: PlanInput): SyncPlan {
  const plan: SyncPlan = {
    addIssues: [],
    addDrafts: [],
    updates: [],
    removals: [],
    offRoadmap: [],
    untouched: [],
    notIssues: [],
    multiArea: [],
    collidingDrafts: [],
    blocked: null,
  }

  const wanted = new Map<number, { info: IssueInfo; fields: Fields }>()
  for (const p of input.roadmap.placements.values()) {
    const info = input.issues.get(p.number)
    if (!info) {
      plan.notIssues.push(p.number)
      continue
    }
    const status: Status = info.state === 'CLOSED' ? 'Done' : p.bucket
    wanted.set(p.number, { info, fields: { status, section: p.section, area: areaOf(info.labels) } })
  }
  for (const info of input.issues.values()) {
    if (info.state === 'OPEN' && !wanted.has(info.number)) {
      wanted.set(info.number, { info, fields: { status: null, section: null, area: areaOf(info.labels) } })
    }
  }
  for (const { info } of wanted.values()) {
    if (info.labels.filter(l => l.startsWith(AREA_PREFIX)).length > 1) plan.multiArea.push(info.number)
  }

  const wantedDrafts = new Map<string, Draft>()
  const draftPlaces = new Map<string, string[]>()
  for (const d of input.roadmap.drafts) {
    if (!wantedDrafts.has(d.title)) wantedDrafts.set(d.title, d)
    draftPlaces.set(d.title, [...(draftPlaces.get(d.title) ?? []), `${d.bucket} / ${d.section}`])
  }
  for (const [title, places] of draftPlaces) if (places.length > 1) plan.collidingDrafts.push({ title, places })

  const seenIssues = new Set<number>()
  const seenDrafts = new Set<string>()
  for (const item of input.items) {
    const listed = item.type !== 'other' && item.fields.section !== null
    if (item.type === 'issue') {
      const w = wanted.get(item.number)
      if (!w) {
        plan.removals.push({ itemId: item.itemId, label: `#${item.number}`, reason: 'closed and not in ROADMAP.md' })
        if (listed) plan.offRoadmap.push(`#${item.number}`)
        continue
      }
      seenIssues.add(item.number)
      if (listed && w.fields.section === null) plan.offRoadmap.push(`#${item.number}`)
      const changes = changedFields(item.fields, w.fields)
      if (Object.keys(changes).length > 0)
        plan.updates.push({ itemId: item.itemId, label: `#${item.number}`, fields: changes })
    } else if (item.type === 'draft') {
      const d = wantedDrafts.get(item.title)
      if (!d || seenDrafts.has(item.title)) {
        plan.removals.push({ itemId: item.itemId, label: item.title, reason: 'no longer in ROADMAP.md' })
        if (listed) plan.offRoadmap.push(item.title)
        continue
      }
      seenDrafts.add(item.title)
      const changes = changedFields(item.fields, draftFields(d))
      const bodyChanged = item.body !== d.body
      if (Object.keys(changes).length > 0 || bodyChanged) {
        plan.updates.push({
          itemId: item.itemId,
          label: item.title,
          fields: changes,
          ...(bodyChanged ? { body: { draftId: item.draftId, body: d.body } } : {}),
        })
      }
    } else {
      plan.untouched.push(item.label)
    }
  }

  for (const [number, w] of wanted) {
    if (!seenIssues.has(number)) plan.addIssues.push({ number, contentId: w.info.id, fields: w.fields })
  }
  for (const [title, d] of wantedDrafts) {
    if (!seenDrafts.has(title)) plan.addDrafts.push({ title, body: d.body, fields: draftFields(d) })
  }

  if (plan.offRoadmap.length > OFF_ROADMAP_LIMIT && !input.allowRemovals) {
    plan.blocked = `The sync would take ${plan.offRoadmap.length} cards off the roadmap, more than ${OFF_ROADMAP_LIMIT}. Check the plan, then rerun with --allow-removals.`
  }
  return plan
}

/** Writes to add a card: the card, then each field it gets (an empty one isn't cleared on a new card, Q13). */
export function addWrites(fields: Fields): number {
  return 1 + Object.values(fields).filter(v => v !== null).length
}

/** Writes to update a card: each field set or cleared, and a draft's body. */
export function updateWrites(update: SyncPlan['updates'][number]): number {
  return Object.keys(update.fields).length + (update.body ? 1 : 0)
}

/** Writes the plan takes once the fields exist; the cap and the dry run count with it (Q13). */
export function planWrites(plan: SyncPlan): number {
  let n = plan.removals.length
  for (const a of plan.addIssues) n += addWrites(a.fields)
  for (const d of plan.addDrafts) n += addWrites(d.fields)
  for (const u of plan.updates) n += updateWrites(u)
  return n
}

function draftFields(d: Draft): Fields {
  return { status: d.bucket, section: d.section, area: null }
}

function changedFields(current: Fields, wanted: Fields): Partial<Fields> {
  const out: Partial<Fields> = {}
  if (current.status !== wanted.status) out.status = wanted.status
  if (current.section !== wanted.section) out.section = wanted.section
  if (current.area !== wanted.area) out.area = wanted.area
  return out
}
