/**
 * roadmap-board — sync the public "Roadmap" GitHub Project from ROADMAP.md.
 *
 * Run from a checkout of main after a ROADMAP change merges; review-decisions
 * does this after merging one (design-roadmap-board.md Q5):
 *
 *   GH_TOKEN=$(gh auth token) npm run roadmap-board -w @gazetta/bots              # print the plan
 *   GH_TOKEN=$(gh auth token) npm run roadmap-board -w @gazetta/bots -- --apply   # write it
 *
 * The token needs the `project` scope (`gh auth refresh -s project`).
 * `--allow-removals` lets a run remove more than REMOVAL_LIMIT items.
 */
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { octokitFromEnv } from '../_lib/github.js'
import { type Bucket, type ParsedRoadmap, parseRoadmap } from './parse.js'
import { AREA_ORDER, areaOf, type IssueInfo, planSync, type SyncPlan } from './plan.js'
import {
  applyPlan,
  BUCKET_COLORS,
  type Color,
  ensureFields,
  ensureViews,
  findProject,
  type GraphQL,
  type OptionSpec,
  readIssues,
  readme,
  readOpenIssues,
  readProject,
  STATUS_OPTIONS,
  shortDescription,
  updateProjectText,
} from './project.js'

const OWNER = 'gazetta-studio'
const REPO = 'gazetta-studio/gazetta-studio'
const TITLE = 'Roadmap'
const AREA_COLORS: Readonly<Record<string, Color>> = {
  cms: 'BLUE',
  renderer: 'PURPLE',
  cli: 'ORANGE',
  storage: 'YELLOW',
  templates: 'PINK',
}

async function main(argv: string[]): Promise<number> {
  const apply = argv.includes('--apply')
  const allowRemovals = argv.includes('--allow-removals')
  const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
  const roadmap = parseRoadmap(readFileSync(join(repoRoot, 'ROADMAP.md'), 'utf8'))
  const commit = git(repoRoot, ['rev-parse', '--short', 'HEAD'])
  if (apply && git(repoRoot, ['status', '--porcelain', '--', 'ROADMAP.md']) !== '') {
    console.error('ROADMAP.md has uncommitted changes. Sync from a clean checkout of main.')
    return 1
  }

  const octokit = octokitFromEnv()
  const gql = withRetry(<T>(query: string, variables?: Record<string, unknown>) => octokit.graphql<T>(query, variables))
  const projectId = await findProject(gql, OWNER, TITLE)
  if (!projectId) {
    console.error(
      `No project titled "${TITLE}" in ${OWNER}. Create it first: gh project create --owner ${OWNER} --title ${TITLE}`,
    )
    return 1
  }

  const issues = await readIssues(gql, REPO, [...roadmap.placements.keys()])
  for (const i of await readOpenIssues(gql, REPO)) if (!issues.has(i.number)) issues.set(i.number, i)

  let state = await readProject(gql, projectId, REPO)
  let plan = planSync({ roadmap, issues, items: state.items, allowRemovals })
  report(roadmap, plan, commit, state.url, state.items.length)
  if (plan.blocked) {
    console.error(plan.blocked)
    return 1
  }
  if (!apply) {
    console.log('Dry run: nothing written. Rerun with --apply to write it.')
    return 0
  }

  await ensureFields(gql, state, {
    status: STATUS_OPTIONS,
    section: sectionOptions(roadmap, issues),
    area: areaOptions(issues),
  })
  // Option changes can clear values, so plan again against what the fields hold now.
  state = await readProject(gql, projectId, REPO)
  plan = planSync({ roadmap, issues, items: state.items, allowRemovals })
  if (plan.blocked) {
    console.error(plan.blocked)
    return 1
  }
  await applyPlan(gql, state, plan, line => console.log(`  ${line}`))
  const views = await ensureViews(gql, state)
  if (views.length > 0)
    console.log(`Created views: ${views.join(', ')}. Set their columns and grouping by hand once (see the README).`)
  await updateProjectText(gql, projectId, shortDescription(commit, new Date().toISOString().slice(0, 10)), readme(REPO))
  console.log(`Synced ${state.url}`)
  return 0
}

/** Section options in file order, only for sections that hold an item; coloured by bucket. */
function sectionOptions(roadmap: ParsedRoadmap, issues: Map<number, IssueInfo>): OptionSpec[] {
  const used = new Set<string>()
  for (const p of roadmap.placements.values()) if (issues.has(p.number)) used.add(key(p.bucket, p.section))
  for (const d of roadmap.drafts) used.add(key(d.bucket, d.section))
  const seen = new Set<string>()
  const out: OptionSpec[] = []
  for (const s of roadmap.sections) {
    if (!used.has(key(s.bucket, s.section)) || seen.has(s.section)) continue
    seen.add(s.section)
    out.push({ name: s.section, color: BUCKET_COLORS[s.bucket], description: s.bucket })
  }
  return out
}

function areaOptions(issues: Map<number, IssueInfo>): OptionSpec[] {
  const areas = new Set<string>()
  for (const i of issues.values()) {
    const area = areaOf(i.labels)
    if (area) areas.add(area)
  }
  const rank = (a: string) => (AREA_ORDER.includes(a) ? AREA_ORDER.indexOf(a) : AREA_ORDER.length)
  return [...areas]
    .sort((a, b) => rank(a) - rank(b) || a.localeCompare(b))
    .map(name => ({ name, color: AREA_COLORS[name] ?? 'GRAY', description: `area: ${name}` }))
}

function key(bucket: Bucket, section: string): string {
  return `${bucket} / ${section}`
}

function report(roadmap: ParsedRoadmap, plan: SyncPlan, commit: string, url: string, itemCount: number): void {
  console.log(
    `ROADMAP.md at ${commit}: ${roadmap.placements.size} references, ${roadmap.drafts.length} items without an issue`,
  )
  console.log(`Project ${url}: ${itemCount} items`)
  const onRoadmap = plan.addIssues.filter(a => a.fields.section !== null).length
  console.log(
    `Plan: add ${plan.addIssues.length} issues (${onRoadmap} on the roadmap, ${plan.addIssues.length - onRoadmap} not in ROADMAP.md) and ${plan.addDrafts.length} drafts; update ${plan.updates.length}; remove ${plan.removals.length}`,
  )
  for (const u of plan.updates) {
    const changes = Object.entries(u.fields).map(([field, value]) => `${field} → ${value ?? '(empty)'}`)
    if (u.body) changes.push('body')
    console.log(`  update ${u.label}: ${changes.join(', ')}`)
  }
  for (const r of plan.removals) console.log(`  remove ${r.label} (${r.reason})`)
  if (roadmap.repeated.length > 0) {
    console.log('Mentioned in more than one place:')
    for (const r of roadmap.repeated) {
      const p = roadmap.placements.get(r.number)
      const used = p ? key(p.bucket, p.section) : ''
      console.log(`  #${r.number}: ${used} (used); also ${r.sections.filter(s => s !== used).join(', ')}`)
    }
  }
  if (plan.multiArea.length > 0)
    console.log(`Issues with two area labels: ${plan.multiArea.map(n => `#${n}`).join(', ')}`)
  if (plan.notIssues.length > 0)
    console.log(`Not issues (pull requests or missing): ${plan.notIssues.map(n => `#${n}`).join(', ')}`)
  if (plan.untouched.length > 0) console.log(`Left alone: ${plan.untouched.join(', ')}`)
}

/** Retry on GitHub's rate limits; a first sync makes a few hundred calls. */
function withRetry(gql: GraphQL): GraphQL {
  return async <T>(query: string, variables?: Record<string, unknown>): Promise<T> => {
    for (let attempt = 1; ; attempt++) {
      try {
        return await gql<T>(query, variables)
      } catch (err) {
        if (attempt >= 5 || !/rate limit/i.test(String(err))) throw err
        const seconds = 60 * attempt
        console.error(`Rate limited; retrying in ${seconds}s`)
        await new Promise(resolve => setTimeout(resolve, seconds * 1000))
      }
    }
  }
}

function git(cwd: string, args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim()
}

const isMain = import.meta.url === `file://${process.argv[1]}` || fileURLToPath(import.meta.url) === process.argv[1]
if (isMain) {
  main(process.argv.slice(2)).then(
    code => process.exit(code),
    err => {
      console.error(err)
      process.exit(1)
    },
  )
}
