/**
 * ROADMAP.md parser for the roadmap board.
 *
 * The board is generated one way from ROADMAP.md (design-roadmap-board.md
 * Q1). This module is the deterministic part: which bucket and section each
 * referenced issue belongs to (Q4), and which items the file lists without
 * an issue, which become draft cards (Q3). It reads only the four buckets,
 * `## Now`, `## Next`, `## Later` and `## Deferred`, and stops at the second
 * top-level heading (`# Appendix: Shipped status`), which Q3 leaves out.
 */

export type Bucket = 'Now' | 'Next' | 'Later' | 'Deferred'

export interface Placement {
  number: number
  bucket: Bucket
  /** The `###` heading the issue is under, or the bucket's name before any. */
  section: string
}

export interface Draft {
  title: string
  body: string
  bucket: Bucket
  section: string
}

export interface RepeatedMention {
  number: number
  /** Every `Bucket / Section` that mentions the issue, in file order. */
  sections: string[]
}

export interface ParsedRoadmap {
  /** Where each referenced number lands (Q4), keyed by number. */
  placements: Map<number, Placement>
  /** Numbers mentioned in more than one section; each run prints them. */
  repeated: RepeatedMention[]
  drafts: Draft[]
  /** Every section with a reference or a draft, in file order: the order of the Section field's options. */
  sections: Array<{ bucket: Bucket; section: string }>
}

type Kind = 'list' | 'table' | 'prose'

interface Mention {
  number: number
  bucket: Bucket
  section: string
  kind: Kind
}

const BUCKETS: readonly Bucket[] = ['Now', 'Next', 'Later', 'Deferred']
/** Longer spans in `#A–#B` are more likely a typo than a list of issues. */
const MAX_RANGE = 30
const MAX_TITLE = 256
const ISSUE_LINK = /\[#(\d+)\]\(https:\/\/github\.com\/gazetta-studio\/gazetta-studio\/(?:issues|pull)\/\d+\)/g
const RANGE = /#(\d+)\s*[–—-]\s*#(\d+)/g
const REF = /(^|[^\w&])#(\d+)\b/g
const LIST_ITEM = /^(\s*)(?:[-*+]|\d+\.)\s+/

export function parseRoadmap(markdown: string): ParsedRoadmap {
  const lines = markdown.split('\n')
  const mentions: Mention[] = []
  const drafts: Draft[] = []
  const sections: ParsedRoadmap['sections'] = []
  const useSection = (b: Bucket, s: string) => {
    if (!sections.some(x => x.bucket === b && x.section === s)) sections.push({ bucket: b, section: s })
  }
  let topLevelHeadings = 0
  let bucket: Bucket | null = null
  let section = ''
  let tableHeader: string[] | null = null

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    const heading = /^(#{1,6})\s+(.*)$/.exec(line)
    if (heading) {
      const level = heading[1].length
      if (level === 1 && ++topLevelHeadings > 1) break
      if (level <= 2) {
        bucket = level === 2 ? bucketOf(heading[2]) : null
        section = bucket ?? ''
      } else if (bucket) {
        section = plainText(heading[2])
      }
      tableHeader = null
      continue
    }
    if (!bucket || /^\s*(Decided:|Follows from)/.test(line)) continue

    const isTable = /^\s*\|/.test(line)
    if (!isTable) tableHeader = null
    const kind: Kind = isTable ? 'table' : LIST_ITEM.test(line) ? 'list' : 'prose'
    const numbers = references(line)
    for (const number of numbers) mentions.push({ number, bucket, section, kind })
    if (numbers.length > 0) useSection(bucket, section)

    if (isTable) {
      const cells = tableCells(line)
      if (cells.every(c => /^:?-{3,}:?$/.test(c))) continue
      if (!tableHeader) {
        tableHeader = cells
        continue
      }
      if (numbers.length === 0) {
        drafts.push(tableDraft(cells, tableHeader, bucket, section))
        useSection(bucket, section)
      }
    } else if (kind === 'list' && numbers.length === 0 && !hasSubItems(lines, i)) {
      drafts.push(listDraft(line, bucket, section))
      useSection(bucket, section)
    }
  }

  return { placements: placementsOf(mentions), repeated: repeatedOf(mentions), drafts, sections }
}

function bucketOf(headingText: string): Bucket | null {
  const first = /^(\w+)/.exec(headingText.trim())?.[1]
  return BUCKETS.find(b => b === first) ?? null
}

/** Issue numbers on one line: links, bare `#N`, and `#A–#B` ranges. */
function references(line: string): number[] {
  const text = line.replace(ISSUE_LINK, '#$1')
  const found = new Set<number>()
  for (const m of text.matchAll(RANGE)) {
    const from = Number(m[1])
    const to = Number(m[2])
    if (to > from && to - from <= MAX_RANGE) for (let n = from; n <= to; n++) found.add(n)
  }
  for (const m of text.matchAll(REF)) found.add(Number(m[2]))
  return [...found]
}

/** Q4: the first list item or table row that names the issue; else its first prose mention. */
function placementsOf(mentions: Mention[]): Map<number, Placement> {
  const byNumber = new Map<number, Mention[]>()
  for (const m of mentions) byNumber.set(m.number, [...(byNumber.get(m.number) ?? []), m])
  const out = new Map<number, Placement>()
  for (const [number, ms] of byNumber) {
    const chosen = ms.find(m => m.kind !== 'prose') ?? ms[0]
    out.set(number, { number, bucket: chosen.bucket, section: chosen.section })
  }
  return out
}

function repeatedOf(mentions: Mention[]): RepeatedMention[] {
  const byNumber = new Map<number, string[]>()
  for (const m of mentions) {
    const where = `${m.bucket} / ${m.section}`
    const seen = byNumber.get(m.number) ?? []
    if (!seen.includes(where)) byNumber.set(m.number, [...seen, where])
  }
  return [...byNumber].filter(([, sections]) => sections.length > 1).map(([number, sections]) => ({ number, sections }))
}

function tableCells(line: string): string[] {
  return line
    .trim()
    .replace(/^\|/, '')
    .replace(/\|$/, '')
    .split('|')
    .map(c => c.trim())
}

function tableDraft(cells: string[], header: string[], bucket: Bucket, section: string): Draft {
  const body = cells
    .slice(1)
    .map((cell, j) => [plainText(header[j + 1] ?? ''), plainText(cell)] as const)
    .filter(([, value]) => value !== '')
    .map(([name, value]) => (name ? `${name}: ${value}` : value))
    .join('\n')
  return { title: truncate(plainText(cells[0])), body, bucket, section }
}

function listDraft(line: string, bucket: Bucket, section: string): Draft {
  const text = plainText(line.replace(LIST_ITEM, ''))
  const title = truncate(/^(.+?[.!?])(?:\s|$)/.exec(text)?.[1] ?? text)
  return { title, body: text === title ? '' : text, bucket, section }
}

/** A bullet whose next non-blank line is a more indented bullet is a heading ("Static hosts:"). */
function hasSubItems(lines: string[], i: number): boolean {
  const indent = LIST_ITEM.exec(lines[i])?.[1].length ?? 0
  const next = lines.slice(i + 1).find(l => l.trim() !== '')
  const nextIndent = next === undefined ? undefined : LIST_ITEM.exec(next)?.[1].length
  return nextIndent !== undefined && nextIndent > indent
}

function plainText(markdown: string): string {
  return markdown
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/`/g, '')
    .replace(/\*\*|__/g, '')
    .replace(/\s+/g, ' ')
    .trim()
}

function truncate(title: string): string {
  return title.length <= MAX_TITLE ? title : `${title.slice(0, MAX_TITLE - 1)}…`
}
