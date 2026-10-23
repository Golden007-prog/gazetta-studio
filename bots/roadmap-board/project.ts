/**
 * GitHub Projects side of the roadmap board: read the project and the
 * repository's issues, keep the fields and views the board needs, and
 * write a sync plan (plan.ts).
 *
 * Everything goes through an injected GraphQL function, so the sync runs
 * with whatever token GH_TOKEN holds: the maintainer's `gh` login today, a
 * GitHub App's later (design-roadmap-board.md Q5). The API can create views
 * and set their layout, filter and visible fields, but not their columns or
 * grouping; those are set once by hand (the project's README lists them).
 */
import { WRITE_CAP } from './pace.js'
import {
  addWrites,
  type Fields,
  type IssueInfo,
  type ProjectItem,
  type Status,
  type SyncPlan,
  updateWrites,
} from './plan.js'

export type GraphQL = <T>(query: string, variables?: Record<string, unknown>) => Promise<T>

export type Color = 'GRAY' | 'BLUE' | 'GREEN' | 'YELLOW' | 'ORANGE' | 'RED' | 'PINK' | 'PURPLE'

export interface OptionSpec {
  name: string
  color: Color
  description: string
}

export interface FieldOption extends OptionSpec {
  id: string
}

export interface SingleSelectField {
  id: string
  name: string
  options: FieldOption[]
}

export interface ProjectState {
  id: string
  url: string
  /** Every field, by name: the board's three single selects and the built-in ones (Title, Labels…). */
  fieldIds: Map<string, string>
  status: SingleSelectField | null
  section: SingleSelectField | null
  area: SingleSelectField | null
  items: ProjectItem[]
  views: Array<{ id: string; name: string }>
}

export const STATUS_OPTIONS: readonly OptionSpec[] = [
  { name: 'Now', color: 'GREEN', description: 'Committed; in flight or starting in the next 4-8 weeks' },
  { name: 'Next', color: 'BLUE', description: 'Planned for the quarter after Now' },
  { name: 'Later', color: 'YELLOW', description: 'Sequenced behind Now / Next' },
  { name: 'Deferred', color: 'GRAY', description: 'Real gaps, no current trigger to start' },
  { name: 'Done', color: 'PURPLE', description: 'Closed, and still in ROADMAP.md' },
]

export const BUCKET_COLORS: Readonly<Record<Exclude<Status, 'Done'>, Color>> = {
  Now: 'GREEN',
  Next: 'BLUE',
  Later: 'YELLOW',
  Deferred: 'GRAY',
}

export const VIEWS: ReadonlyArray<{ name: string; layout: 'BOARD_LAYOUT' | 'TABLE_LAYOUT'; filter: string }> = [
  { name: 'Roadmap', layout: 'BOARD_LAYOUT', filter: 'has:section' },
  { name: 'Now', layout: 'BOARD_LAYOUT', filter: 'status:Now' },
  { name: 'Next', layout: 'BOARD_LAYOUT', filter: 'status:Next' },
  { name: 'Later', layout: 'BOARD_LAYOUT', filter: 'status:Later' },
  { name: 'By area', layout: 'BOARD_LAYOUT', filter: 'has:section' },
  { name: 'All', layout: 'TABLE_LAYOUT', filter: 'has:section' },
  { name: 'Not in ROADMAP.md', layout: 'TABLE_LAYOUT', filter: 'no:section is:open' },
]

const VISIBLE_FIELDS = ['Title', 'Status', 'Section', 'Area', 'Labels']

/**
 * The option list to send for a single select: the wanted options in order,
 * each keeping its id when an option of that name exists, so items keep
 * their value (GitHub's built-in "closed → Done" rule points at Done's id).
 */
export function mergeOptions(
  existing: readonly FieldOption[],
  wanted: readonly OptionSpec[],
): Array<OptionSpec & { id?: string }> {
  return wanted.map(w => {
    const id = existing.find(e => e.name === w.name)?.id
    return id ? { id, ...w } : { ...w }
  })
}

export function sameOptions(existing: readonly FieldOption[], wanted: readonly OptionSpec[]): boolean {
  return (
    existing.length === wanted.length &&
    wanted.every(
      (w, i) =>
        existing[i].name === w.name && existing[i].color === w.color && existing[i].description === w.description,
    )
  )
}

/** The project's one-line description: which ROADMAP commit the board shows, and when it was synced. */
export function shortDescription(commit: string, date: string): string {
  return `Generated from ROADMAP.md at ${commit} on ${date}. Edit the file, not the board.`
}

export function readme(repo: string): string {
  return `Generated from [ROADMAP.md](https://github.com/${repo}/blob/main/ROADMAP.md) by \`bots/roadmap-board/\`. Edit the file, not the board: the next sync undoes changes made here. The reasons and dependencies behind each item are in the file.

## Views

- **Roadmap**: a column per bucket (Now, Next, Later, Deferred), and Done for closed issues.
- **Now**, **Next**, **Later**: one bucket, with a column per section.
- **By area**: bucket columns, with a row per area.
- **All**: every item, grouped by section.
- **Not in ROADMAP.md**: open issues the file doesn't mention.

Cards without an issue are drafts: items the file lists without one.

## One-time setup

The API can't set a view's columns or grouping, or the auto-add rule, so they're set by hand once:

- Roadmap and By area: column by Status. By area: group by Area.
- Now, Next and Later: column by Section, and in the column menu hide the other buckets' sections, so each tab shows only its own.
- All: group by Section.
- Workflows, "Auto-add to project": repository \`${repo}\`, filter \`is:issue is:open\`.

## After a sync

- The sync prints each Section option it creates (a new \`###\` heading in ROADMAP.md). In the Now, Next and Later tabs, keep each tab to its own bucket's sections: hide the new option in the other two tabs, or show it in its own.
- A run stops before ${WRITE_CAP} writes, under GitHub's 500 an hour, and prints when to rerun. The description names the last sync that finished.
`
}

export async function findProject(gql: GraphQL, owner: string, title: string): Promise<string | null> {
  const data = await gql<{ organization: { projectsV2: { nodes: Array<{ id: string; title: string }> } } }>(
    `query($owner: String!, $title: String!) {
      organization(login: $owner) { projectsV2(first: 20, query: $title) { nodes { id title } } }
    }`,
    { owner, title },
  )
  return data.organization.projectsV2.nodes.find(p => p.title === title)?.id ?? null
}

interface RawItem {
  id: string
  content:
    | { __typename: 'Issue'; number: number; repository: { nameWithOwner: string } }
    | { __typename: 'PullRequest'; number: number; repository: { nameWithOwner: string } }
    | { __typename: 'DraftIssue'; id: string; title: string; body: string }
    | null
  fieldValues: { nodes: Array<{ name?: string; field?: { name?: string } }> }
}

export async function readProject(gql: GraphQL, projectId: string, repo: string): Promise<ProjectState> {
  const head = await gql<{
    node: {
      url: string
      fields: { nodes: Array<{ id: string; name: string; options?: FieldOption[] }> }
      views: { nodes: Array<{ id: string; name: string }> }
    }
  }>(
    `query($id: ID!) {
      node(id: $id) { ... on ProjectV2 {
        url
        fields(first: 50) { nodes {
          ... on ProjectV2FieldCommon { id name }
          ... on ProjectV2SingleSelectField { options { id name color description } }
        } }
        views(first: 50) { nodes { id name } }
      } }
    }`,
    { id: projectId },
  )
  const fields = head.node.fields.nodes
  const single = (name: string): SingleSelectField | null => {
    const f = fields.find(x => x.name === name && x.options)
    return f?.options ? { id: f.id, name: f.name, options: f.options } : null
  }

  const items: ProjectItem[] = []
  let after: string | null = null
  do {
    const page: {
      node: { items: { nodes: RawItem[]; pageInfo: { hasNextPage: boolean; endCursor: string | null } } }
    } = await gql(
      `query($id: ID!, $after: String) {
          node(id: $id) { ... on ProjectV2 { items(first: 100, after: $after) {
            nodes {
              id
              content {
                __typename
                ... on Issue { number repository { nameWithOwner } }
                ... on PullRequest { number repository { nameWithOwner } }
                ... on DraftIssue { id title body }
              }
              fieldValues(first: 20) { nodes {
                ... on ProjectV2ItemFieldSingleSelectValue { name field { ... on ProjectV2FieldCommon { name } } }
              } }
            }
            pageInfo { hasNextPage endCursor }
          } } }
        }`,
      { id: projectId, after },
    )
    for (const raw of page.node.items.nodes) items.push(toItem(raw, repo))
    after = page.node.items.pageInfo.hasNextPage ? page.node.items.pageInfo.endCursor : null
  } while (after)

  return {
    id: projectId,
    url: head.node.url,
    fieldIds: new Map(fields.filter(f => f.id).map(f => [f.name, f.id])),
    status: single('Status'),
    section: single('Section'),
    area: single('Area'),
    items,
    views: head.node.views.nodes,
  }
}

function toItem(raw: RawItem, repo: string): ProjectItem {
  const value = (field: string) => raw.fieldValues.nodes.find(v => v.field?.name === field)?.name ?? null
  const fields: Fields = { status: value('Status') as Status | null, section: value('Section'), area: value('Area') }
  const c = raw.content
  if (c?.__typename === 'Issue' && c.repository.nameWithOwner === repo)
    return { itemId: raw.id, type: 'issue', number: c.number, fields }
  if (c?.__typename === 'DraftIssue')
    return { itemId: raw.id, type: 'draft', draftId: c.id, title: c.title, body: c.body, fields }
  const label =
    c && 'number' in c
      ? `${c.__typename === 'PullRequest' ? 'pull request' : 'issue'} ${c.repository.nameWithOwner}#${c.number}`
      : `item ${raw.id}`
  return { itemId: raw.id, type: 'other', label }
}

interface RawIssue {
  id: string
  number: number
  state: 'OPEN' | 'CLOSED'
  labels: { nodes: Array<{ name: string }> }
}

const ISSUE_FIELDS = 'id number state labels(first: 30) { nodes { name } }'

function toIssue(raw: RawIssue): IssueInfo {
  return { number: raw.number, id: raw.id, state: raw.state, labels: raw.labels.nodes.map(l => l.name) }
}

/** The numbers that are issues (pull requests and missing numbers are left out). */
export async function readIssues(
  gql: GraphQL,
  repo: string,
  numbers: readonly number[],
): Promise<Map<number, IssueInfo>> {
  const [owner, name] = repo.split('/')
  const out = new Map<number, IssueInfo>()
  for (let i = 0; i < numbers.length; i += 50) {
    const batch = numbers.slice(i, i + 50)
    const fields = batch.map(
      n => `n${n}: issueOrPullRequest(number: ${n}) { __typename ... on Issue { ${ISSUE_FIELDS} } }`,
    )
    const data = await gql<{ repository: Record<string, (RawIssue & { __typename: string }) | null> }>(
      `query($owner: String!, $name: String!) { repository(owner: $owner, name: $name) { ${fields.join('\n')} } }`,
      { owner, name },
    )
    for (const raw of Object.values(data.repository)) if (raw?.__typename === 'Issue') out.set(raw.number, toIssue(raw))
  }
  return out
}

export async function readOpenIssues(gql: GraphQL, repo: string): Promise<IssueInfo[]> {
  const [owner, name] = repo.split('/')
  const out: IssueInfo[] = []
  let after: string | null = null
  do {
    const page: {
      repository: { issues: { nodes: RawIssue[]; pageInfo: { hasNextPage: boolean; endCursor: string | null } } }
    } = await gql(
      `query($owner: String!, $name: String!, $after: String) {
          repository(owner: $owner, name: $name) { issues(states: OPEN, first: 100, after: $after) {
            nodes { ${ISSUE_FIELDS} }
            pageInfo { hasNextPage endCursor }
          } }
        }`,
      { owner, name, after },
    )
    out.push(...page.repository.issues.nodes.map(toIssue))
    after = page.repository.issues.pageInfo.hasNextPage ? page.repository.issues.pageInfo.endCursor : null
  } while (after)
  return out
}

export interface WantedOptions {
  status: readonly OptionSpec[]
  section: readonly OptionSpec[]
  area: readonly OptionSpec[]
}

/** The fields whose options a sync creates or changes: one write each. */
export function fieldsToWrite(
  state: ProjectState,
  wanted: WantedOptions,
): Array<{ field: SingleSelectField | null; name: string; options: readonly OptionSpec[] }> {
  return (
    [
      [state.status, 'Status', wanted.status],
      [state.section, 'Section', wanted.section],
      [state.area, 'Area', wanted.area],
    ] as const
  )
    .filter(([field, , options]) => options.length > 0 && (!field || !sameOptions(field.options, options)))
    .map(([field, name, options]) => ({ field, name, options }))
}

/** Section options a sync would create: the wanted ones the field doesn't have yet (Q12). */
export function newSections(state: ProjectState, wanted: readonly OptionSpec[]): OptionSpec[] {
  return wanted.filter(w => !state.section?.options.some(o => o.name === w.name))
}

/** Make Status, Section and Area hold exactly these options, keeping existing ids. */
export async function ensureFields(gql: GraphQL, state: ProjectState, wanted: WantedOptions): Promise<void> {
  if (!state.status) throw new Error('The project has no Status field')
  for (const { field, name, options } of fieldsToWrite(state, wanted)) {
    if (!field) {
      await gql(
        `mutation($project: ID!, $name: String!, $options: [ProjectV2SingleSelectFieldOptionInput!]!) {
          createProjectV2Field(input: { projectId: $project, dataType: SINGLE_SELECT, name: $name, singleSelectOptions: $options }) { clientMutationId }
        }`,
        { project: state.id, name, options },
      )
    } else {
      await gql(
        `mutation($field: ID!, $options: [ProjectV2SingleSelectFieldOptionInput!]!) {
          updateProjectV2Field(input: { fieldId: $field, singleSelectOptions: $options }) { clientMutationId }
        }`,
        { field: field.id, options: mergeOptions(field.options, options) },
      )
    }
  }
}

/** The board's views the project doesn't have yet; each takes two writes (create, then filter). */
export function missingViews(state: ProjectState): typeof VIEWS {
  const names = new Set(state.views.map(v => v.name))
  return VIEWS.filter(v => !names.has(v.name))
}

/** Create the views the board needs that don't exist yet; existing views are left as they are. */
export async function ensureViews(gql: GraphQL, state: ProjectState): Promise<string[]> {
  const created: string[] = []
  const visibleFieldIds = VISIBLE_FIELDS.map(n => state.fieldIds.get(n)).filter((id): id is string => !!id)
  const missing = missingViews(state)
  // A new project comes with one empty table view; it becomes the first board view.
  const spare = missing.length === VIEWS.length && state.views.length === 1 ? state.views[0] : null
  for (const view of missing) {
    let viewId = spare && view === VIEWS[0] ? spare.id : null
    if (viewId) {
      await gql(
        `mutation($view: ID!, $name: String!, $layout: ProjectV2ViewLayout!, $fields: [ID!]) {
          updateProjectV2View(input: { viewId: $view, name: $name, layout: $layout, configuration: { visibleFieldIds: $fields } }) { clientMutationId }
        }`,
        { view: viewId, name: view.name, layout: view.layout, fields: visibleFieldIds },
      )
    } else {
      const data = await gql<{ createProjectV2View: { projectV2View: { id: string } } }>(
        `mutation($project: ID!, $name: String!, $layout: ProjectV2ViewLayout!, $fields: [ID!]) {
          createProjectV2View(input: { projectId: $project, name: $name, layout: $layout, configuration: { visibleFieldIds: $fields } }) { projectV2View { id } }
        }`,
        { project: state.id, name: view.name, layout: view.layout, fields: visibleFieldIds },
      )
      viewId = data.createProjectV2View.projectV2View.id
    }
    await gql(
      `mutation($view: ID!, $filter: String!) { updateProjectV2View(input: { viewId: $view, filter: $filter }) { clientMutationId } }`,
      { view: viewId, filter: view.filter },
    )
    created.push(view.name)
  }
  return created
}

/**
 * Write a plan, a card at a time while `fits` allows that card's writes, so a
 * run that reaches the cap never leaves a card added without its fields (Q13).
 * Returns false when it stopped early. `state` must be read after
 * ensureFields, so every option it needs exists.
 */
export async function applyPlan(
  gql: GraphQL,
  state: ProjectState,
  plan: SyncPlan,
  log: (line: string) => void,
  fits: (writes: number) => boolean = () => true,
): Promise<boolean> {
  for (const r of plan.removals) {
    if (!fits(1)) return false
    await gql(
      `mutation($project: ID!, $item: ID!) { deleteProjectV2Item(input: { projectId: $project, itemId: $item }) { deletedItemId } }`,
      { project: state.id, item: r.itemId },
    )
    log(`removed ${r.label} (${r.reason})`)
  }
  for (const a of plan.addIssues) {
    if (!fits(addWrites(a.fields))) return false
    const data = await gql<{ addProjectV2ItemById: { item: { id: string } } }>(
      `mutation($project: ID!, $content: ID!) { addProjectV2ItemById(input: { projectId: $project, contentId: $content }) { item { id } } }`,
      { project: state.id, content: a.contentId },
    )
    // A new card has nothing to clear (Q13). A value a project rule sets on it differs from the plan, so the next sync resets it.
    await setFields(gql, state, data.addProjectV2ItemById.item.id, a.fields, { clearEmpty: false })
    log(`added #${a.number}`)
  }
  for (const d of plan.addDrafts) {
    if (!fits(addWrites(d.fields))) return false
    const data = await gql<{ addProjectV2DraftIssue: { projectItem: { id: string } } }>(
      `mutation($project: ID!, $title: String!, $body: String) {
        addProjectV2DraftIssue(input: { projectId: $project, title: $title, body: $body }) { projectItem { id } }
      }`,
      { project: state.id, title: d.title, body: d.body },
    )
    await setFields(gql, state, data.addProjectV2DraftIssue.projectItem.id, d.fields, { clearEmpty: false })
    log(`added draft "${d.title}"`)
  }
  for (const u of plan.updates) {
    if (!fits(updateWrites(u))) return false
    await setFields(gql, state, u.itemId, u.fields, { clearEmpty: true })
    if (u.body) {
      await gql(
        `mutation($draft: ID!, $body: String!) { updateProjectV2DraftIssue(input: { draftIssueId: $draft, body: $body }) { clientMutationId } }`,
        { draft: u.body.draftId, body: u.body.body },
      )
    }
    log(`updated ${u.label}`)
  }
  return true
}

async function setFields(
  gql: GraphQL,
  state: ProjectState,
  itemId: string,
  fields: Partial<Fields>,
  options: { clearEmpty: boolean },
): Promise<void> {
  const mutation = fieldMutation(state, itemId, fields, options)
  if (mutation) await gql(mutation.query, mutation.variables)
}

/**
 * One mutation that writes all of a card's fields (Q13), each field an aliased
 * update or clear. Empty fields are cleared only when `clearEmpty` is set: an
 * update that empties a field clears it, a card just added has nothing to clear.
 * Returns null when there's nothing to write.
 */
export function fieldMutation(
  state: ProjectState,
  itemId: string,
  fields: Partial<Fields>,
  options: { clearEmpty: boolean },
): { query: string; variables: Record<string, unknown> } | null {
  const params = ['$project: ID!', '$item: ID!']
  const variables: Record<string, unknown> = { project: state.id, item: itemId }
  const writes: string[] = []
  for (const [key, field] of [
    ['status', state.status],
    ['section', state.section],
    ['area', state.area],
  ] as const) {
    if (!(key in fields) || !field) continue
    const value = fields[key]
    const n = writes.length
    if (value === null || value === undefined) {
      if (!options.clearEmpty) continue
      params.push(`$field${n}: ID!`)
      variables[`field${n}`] = field.id
      writes.push(
        `w${n}: clearProjectV2ItemFieldValue(input: { projectId: $project, itemId: $item, fieldId: $field${n} }) { clientMutationId }`,
      )
      continue
    }
    const option = field.options.find(o => o.name === value)
    if (!option) throw new Error(`${field.name} has no option "${value}"`)
    params.push(`$field${n}: ID!`, `$option${n}: String!`)
    variables[`field${n}`] = field.id
    variables[`option${n}`] = option.id
    writes.push(
      `w${n}: updateProjectV2ItemFieldValue(input: { projectId: $project, itemId: $item, fieldId: $field${n}, value: { singleSelectOptionId: $option${n} } }) { clientMutationId }`,
    )
  }
  if (writes.length === 0) return null
  return { query: `mutation(${params.join(', ')}) {\n  ${writes.join('\n  ')}\n}`, variables }
}

export async function updateProjectText(
  gql: GraphQL,
  projectId: string,
  description: string,
  text: string,
): Promise<void> {
  await gql(
    `mutation($project: ID!, $description: String!, $readme: String!) {
      updateProjectV2(input: { projectId: $project, shortDescription: $description, readme: $readme }) { clientMutationId }
    }`,
    { project: projectId, description, readme: text },
  )
}
