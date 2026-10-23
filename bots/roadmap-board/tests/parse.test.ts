/**
 * ROADMAP.md parser tests.
 *
 * Derived from design-roadmap-board.md (Q3, Q4, "The sync"), NOT from
 * observing the implementation (team-preferences rule 31): which lines
 * count, where an issue mentioned twice lands, and which items without an
 * issue become draft cards.
 */
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { parseRoadmap } from '../parse.js'

const issue = (n: number) => `[#${n}](https://github.com/gazetta-studio/gazetta-studio/issues/${n})`

const ROADMAP = `# Roadmap

## How to read this

- **Now** — committed ${issue(900)}

## Now (committed, 4-8 weeks)

Intro with no reference.

### MCP server design pass

${issue(49)}: design now. Bulk edits (${issue(1170)}) are one of its use cases.

### Bug backlog

User-visible bugs, all with fix-bot except ${issue(1162)}:

- ${issue(1149)} \`_redirects\` rows
- ${issue(1162)} component tree

Decided: maintainer, 2026-10-23 (#1179)

### Review workflow — finish

The back end (${issue(515)}–${issue(520)}) shipped; a long span ${issue(100)}–${issue(200)} doesn't expand.

## Next (planned, the quarter after Now)

### Onboarding sprint

- ${issue(209)} Netlify static, after ${issue(1152)}'s cuts and ${issue(1149)}. #1152's cut 2 waits
- Found on the onboarding walk:
  - ${issue(1185)} a site with an R2 target

### \`gazetta validate\` checks target connectivity

${issue(91)}.

### Phase 1 — Remaining foundations

| Foundation | Estimate | Status |
|---|---|---|
| \`NotificationProvider\` (in-admin only) | 1w | ☐ pending |

### Offline

- The save queue (Cut 9c): a save made offline goes out by itself. Its audit events carry replay metadata.

### MCP server build

${issue(49)}, after its design pass in Now.

## Later (sequenced behind Now / Next)

### Content features

- ${issue(1170)} bulk edits
- Static hosts:
  - ${issue(208)} GitHub Pages

## Deferred — real gaps, no current trigger

| Item | Trigger to revisit |
|---|---|
| Real-time presence MVP | Operator demand for live collaboration awareness |
| Google Cloud Storage provider (${issue(8)}) | Operator asks |

## Non-goals

- Memberships ${issue(777)}
- E-commerce primitives

# Appendix: Shipped status

## Now

- ${issue(888)} shipped long ago
`

describe('parseRoadmap — buckets and sections', () => {
  const parsed = parseRoadmap(ROADMAP)

  it('places a listed issue in its bucket and ### section', () => {
    expect(parsed.placements.get(1162)).toEqual({ number: 1162, bucket: 'Now', section: 'Bug backlog' })
  })

  it('strips markdown from section names', () => {
    expect(parsed.placements.get(91)).toEqual({
      number: 91,
      bucket: 'Next',
      section: 'gazetta validate checks target connectivity',
    })
  })

  it('gives items before any ### heading the bucket name as their section (Deferred)', () => {
    expect(parsed.placements.get(8)).toEqual({ number: 8, bucket: 'Deferred', section: 'Deferred' })
  })

  it('ignores sections outside the four buckets and everything after a top-level heading', () => {
    expect(parsed.placements.has(900)).toBe(false) // "How to read this"
    expect(parsed.placements.has(777)).toBe(false) // Non-goals
    expect(parsed.placements.has(888)).toBe(false) // a "## Now" inside the appendix
  })

  it('skips Decided lines', () => {
    expect(parsed.placements.has(1179)).toBe(false)
  })
})

describe('parseRoadmap — references', () => {
  const parsed = parseRoadmap(ROADMAP)

  it('counts bare #N references as well as links', () => {
    const bare = parseRoadmap("## Now\n\n### A\n\nWaits for #1234 and #1235's cut.\n")
    expect([...bare.placements.keys()].sort()).toEqual([1234, 1235])
  })

  it('counts a link to an issue whatever its text', () => {
    const linked = parseRoadmap(
      '## Now\n\n### A\n\n- [cut 9](https://github.com/gazetta-studio/gazetta-studio/issues/1081) waits for the planner\n- [the fix](https://github.com/gazetta-studio/gazetta-studio/issues/1082#issuecomment-1) landed\n',
    )
    expect([...linked.placements.keys()].sort()).toEqual([1081, 1082])
    expect(linked.drafts).toEqual([])
  })

  it('expands a range of up to 30 numbers', () => {
    for (const n of [515, 516, 517, 518, 519, 520]) {
      expect(parsed.placements.get(n)?.section).toBe('Review workflow — finish')
    }
  })

  it('keeps only the ends of a longer range', () => {
    expect(parsed.placements.has(100)).toBe(true)
    expect(parsed.placements.has(200)).toBe(true)
    expect(parsed.placements.has(150)).toBe(false)
  })
})

describe('parseRoadmap — an issue mentioned in more than one place (Q4)', () => {
  const parsed = parseRoadmap(ROADMAP)

  it('uses the first list item or table row over an earlier prose mention', () => {
    // Now names #1170 in prose as an MCP use case; Later lists it.
    expect(parsed.placements.get(1170)).toEqual({ number: 1170, bucket: 'Later', section: 'Content features' })
  })

  it('uses the first list item when several list items name it', () => {
    expect(parsed.placements.get(1149)).toEqual({ number: 1149, bucket: 'Now', section: 'Bug backlog' })
  })

  it('uses the first prose mention when no list item or table row names it', () => {
    expect(parsed.placements.get(49)).toEqual({ number: 49, bucket: 'Now', section: 'MCP server design pass' })
  })

  it('reports each issue mentioned in more than one place, with each mention', () => {
    const byNumber = new Map(parsed.repeated.map(r => [r.number, r.places]))
    expect(byNumber.get(1170)).toEqual(['Now / MCP server design pass (prose)', 'Later / Content features (list)'])
    expect(byNumber.get(49)).toEqual(['Now / MCP server design pass (prose)', 'Next / MCP server build (prose)'])
    // Twice within one section counts too: "more than one place" (Q4).
    expect(byNumber.get(1162)).toEqual(['Now / Bug backlog (prose)', 'Now / Bug backlog (list)'])
    expect(byNumber.has(91)).toBe(false) // mentioned once
  })
})

describe('parseRoadmap — items without an issue become drafts (Q3)', () => {
  const parsed = parseRoadmap(ROADMAP)
  const titles = parsed.drafts.map(d => d.title)

  it('turns a table row that names no issue into a draft, with the other cells as its body', () => {
    expect(parsed.drafts).toContainEqual({
      title: 'Real-time presence MVP',
      body: 'Trigger to revisit: Operator demand for live collaboration awareness',
      bucket: 'Deferred',
      section: 'Deferred',
    })
    expect(parsed.drafts).toContainEqual({
      title: 'NotificationProvider (in-admin only)',
      body: 'Estimate: 1w\nStatus: ☐ pending',
      bucket: 'Next',
      section: 'Phase 1 — Remaining foundations',
    })
  })

  it('turns a bullet that names no issue and has no sub-bullets into a draft titled by its first sentence', () => {
    expect(parsed.drafts).toContainEqual({
      title: 'The save queue (Cut 9c): a save made offline goes out by itself.',
      body: 'The save queue (Cut 9c): a save made offline goes out by itself. Its audit events carry replay metadata.',
      bucket: 'Next',
      section: 'Offline',
    })
  })

  it('treats a bullet with sub-bullets as a heading, not a draft', () => {
    expect(titles.some(t => t.startsWith('Static hosts'))).toBe(false)
    expect(titles.some(t => t.startsWith('Found on the onboarding walk'))).toBe(false)
  })

  it("makes no draft from a table's header row, from a row that names an issue, or from prose", () => {
    expect(titles).not.toContain('Item')
    expect(titles).not.toContain('Foundation')
    expect(titles.some(t => t.startsWith('Google Cloud Storage'))).toBe(false)
    expect(titles.some(t => t.startsWith('Intro'))).toBe(false)
  })

  it('makes no drafts outside the four buckets', () => {
    expect(titles).not.toContain('E-commerce primitives')
  })
})

describe('parseRoadmap — sections', () => {
  it('lists every section with a reference or a draft, in file order, so the Section options follow the file', () => {
    expect(parseRoadmap(ROADMAP).sections).toEqual([
      { bucket: 'Now', section: 'MCP server design pass' },
      { bucket: 'Now', section: 'Bug backlog' },
      { bucket: 'Now', section: 'Review workflow — finish' },
      { bucket: 'Next', section: 'Onboarding sprint' },
      { bucket: 'Next', section: 'gazetta validate checks target connectivity' },
      { bucket: 'Next', section: 'Phase 1 — Remaining foundations' },
      { bucket: 'Next', section: 'Offline' },
      { bucket: 'Next', section: 'MCP server build' },
      { bucket: 'Later', section: 'Content features' },
      { bucket: 'Deferred', section: 'Deferred' },
    ])
  })
})

describe('parseRoadmap — the repository file', () => {
  it("finds items in each of the four buckets of the repository's ROADMAP.md", () => {
    const here = dirname(fileURLToPath(import.meta.url))
    const parsed = parseRoadmap(readFileSync(join(here, '..', '..', '..', 'ROADMAP.md'), 'utf8'))
    const buckets = new Set([...parsed.placements.values()].map(p => p.bucket))
    for (const d of parsed.drafts) buckets.add(d.bucket)
    expect([...buckets].sort()).toEqual(['Deferred', 'Later', 'Next', 'Now'])
  })
})
