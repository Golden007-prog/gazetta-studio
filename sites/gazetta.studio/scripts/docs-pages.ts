#!/usr/bin/env tsx
/**
 * Generates the gazetta.studio docs section from the repo's docs/*.md files.
 *
 * Source of truth: scripts/docs-nav.json — nav groups and order, per-doc
 * label + description, internal docs, removed docs, and the banner text
 * (the banner names the npm release it applies to, so the clause can be
 * dropped when the next release catches up with main).
 *
 * Write mode (npm run docs:site) regenerates:
 *   - targets/local/pages/docs/page.json           (index, from getting-started.md)
 *   - targets/local/pages/docs/<slug>/page.json    (one per other published doc)
 *   - targets/local/fragments/docs-nav/fragment.json
 * Folders under pages/docs/ that no published doc owns are pruned; add a
 * slug to the nav's "removed" list when unpublishing a doc.
 *
 * Check mode (npm run docs:site -- --check) regenerates in memory and fails,
 * naming the fix, when:
 *   - a generated page.json or the nav fragment differs from the committed
 *     file                                  → run npm run docs:site
 *   - docs/ holds a top-level .md the nav does not mention
 *                                           → add it to a group or the internal list
 *   - AGENTS.md's Public docs list differs from the nav
 *                                           → update the Public docs list in AGENTS.md
 *   - pages/docs/ holds a folder no published doc owns
 *                                           → delete the folder or add the doc to the nav
 *   - a doc has a dead link, a missing anchor, raw HTML outside a code
 *     block, or no H1                       → fix the doc (file:line is named)
 *
 * Links in docs are rewritten for the site: links between published docs
 * become /docs/<slug>#anchor (anchors stay GitHub-compatible), links to
 * repo files or unpublished docs become absolute github.com blob/tree URLs.
 * Rendering (Markdown → HTML, highlighting, anchors) happens in the
 * templates/doc template at serve time; the generator only rewrites and
 * packages Markdown.
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const GITHUB_REPO = 'https://github.com/gazetta-studio/gazetta-studio'
const INDEX_FILE = 'getting-started.md'

export interface NavDoc {
  file: string
  label: string
  description: string
}
export interface NavGroup {
  title: string
  docs: NavDoc[]
}
export interface DocsNav {
  banner: string
  groups: NavGroup[]
  internal: { file: string; title: string }[]
  removed: string[]
}

export interface DocProblem {
  file: string
  line: number
  message: string
}

export interface Heading {
  depth: number
  text: string
  slug: string
}

/**
 * GitHub-compatible heading slug (the same rule github-slugger implements):
 * lowercase, drop everything that is not a letter, number, space, hyphen or
 * underscore, spaces become hyphens, and repeated headings get -1, -2, ...
 */
export function slugifyHeading(text: string, used: Map<string, number>): string {
  const base = text
    .toLowerCase()
    .trim()
    .replace(/[^\p{L}\p{N} _-]/gu, '')
    .replace(/\s+/g, '-')
  const seen = used.get(base)
  used.set(base, (seen ?? 0) + 1)
  return seen ? `${base}-${seen}` : base
}

/** Visible heading text: inline code/emphasis markers removed. */
function plainHeadingText(raw: string): string {
  return raw
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/[*`~]/g, '')
    .trim()
}

/** All headings in a Markdown document, ignoring fenced code blocks. */
export function extractHeadings(markdown: string): Heading[] {
  const used = new Map<string, number>()
  const headings: Heading[] = []
  let inFence = false
  for (const line of markdown.split('\n')) {
    if (line.trimStart().startsWith('```')) {
      inFence = !inFence
      continue
    }
    if (inFence) continue
    const m = /^(#{1,6})\s+(.+?)\s*#*\s*$/.exec(line)
    if (!m) continue
    const text = plainHeadingText(m[2])
    headings.push({ depth: m[1].length, text, slug: slugifyHeading(text, used) })
  }
  return headings
}

/** Raw HTML tags the docs renderer refuses to pass through. */
const RAW_HTML_RE =
  /<\/?(a|div|span|img|br|hr|table|thead|tbody|tr|td|th|p|ul|ol|li|section|article|aside|header|footer|button|iframe|video|source|style|script|details|summary|kbd|sub|sup|picture|figure|figcaption)(\s[^>]*)?\/?>/i

const LINK_RE = /(!?)\[([^\]]*)\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g

interface RewriteContext {
  docsDir: string
  repoRoot: string
  doc: NavDoc
  headings: Heading[]
  headingsByFile: Map<string, Heading[]>
  publishedByFile: Map<string, NavDoc>
}

function slugOf(doc: NavDoc): string {
  return doc.file.replace(/\.md$/, '')
}

function sitePathOf(doc: NavDoc): string {
  return doc.file === INDEX_FILE ? '/docs' : `/docs/${slugOf(doc)}`
}

/** Rewrites one link target, or returns a problem message for it. */
function rewriteUrl(url: string, line: number, ctx: RewriteContext): { url: string } | { problem: string } {
  if (/^(https?:)?\/\//.test(url) || url.startsWith('mailto:')) return { url }
  if (url.startsWith('#')) {
    const anchor = url.slice(1)
    if (anchor && !ctx.headings.some(h => h.slug === anchor)) {
      return { problem: `link to missing anchor ${url} — fix the anchor or the target heading` }
    }
    return { url }
  }
  const hashIndex = url.indexOf('#')
  const pathPart = hashIndex === -1 ? url : url.slice(0, hashIndex)
  const anchor = hashIndex === -1 ? '' : url.slice(hashIndex + 1)
  const decoded = decodeURIComponent(pathPart)
  const resolved = resolve(ctx.docsDir, decoded)
  if (!existsSync(resolved)) {
    return { problem: `dead link: ${url} (no such file or directory)` }
  }
  const relToDocs = relative(ctx.docsDir, resolved)
  const published = ctx.publishedByFile.get(relToDocs)
  if (published) {
    if (anchor) {
      const targetHeadings = ctx.headingsByFile.get(published.file) ?? []
      if (!targetHeadings.some(h => h.slug === anchor)) {
        return {
          problem: `link to missing anchor #${anchor} in docs/${published.file} — fix the anchor or the target heading`,
        }
      }
      return { url: `${sitePathOf(published)}#${anchor}` }
    }
    return { url: sitePathOf(published) }
  }
  const relToRepo = relative(ctx.repoRoot, resolved).split('\\').join('/')
  const kind = statSync(resolved).isDirectory() ? 'tree' : 'blob'
  return { url: `${GITHUB_REPO}/${kind}/main/${relToRepo}${anchor ? `#${anchor}` : ''}` }
}

/**
 * Rewrites links in one Markdown document and collects problems. Fenced
 * code blocks and inline code spans are left untouched; line numbers in
 * problems refer to the original document.
 */
export function rewriteLinks(markdown: string, ctx: RewriteContext): { markdown: string; problems: DocProblem[] } {
  const problems: DocProblem[] = []
  const out: string[] = []
  let inFence = false
  markdown.split('\n').forEach((line, index) => {
    const lineNo = index + 1
    if (line.trimStart().startsWith('```')) {
      inFence = !inFence
      out.push(line)
      return
    }
    if (inFence) {
      out.push(line)
      return
    }
    // Blank out inline code so links inside it are not rewritten; the
    // replacement keeps every character offset identical.
    const scannable = line.replace(/`[^`\n]*`/g, m => ' '.repeat(m.length))
    const html = RAW_HTML_RE.exec(scannable)
    if (html) {
      problems.push({
        file: ctx.doc.file,
        line: lineNo,
        message: `raw HTML (${html[0].slice(0, 40)}) outside a code block — rewrite it as Markdown`,
      })
    }
    let cursor = 0
    let rewritten = ''
    for (const m of scannable.matchAll(LINK_RE)) {
      const isImage = m[1] === '!'
      const linkText = m[2]
      const target = m[3]
      const urlStart = m.index + m[1].length + 1 + linkText.length + 2 // ![ + text + ](
      // Offsets from the scannable copy match the original line exactly.
      rewritten += line.slice(cursor, urlStart)
      if (isImage) {
        // Images keep their target; rewriting an image src to a /docs/
        // path would be wrong.
        rewritten += target
      } else {
        const result = rewriteUrl(target, lineNo, ctx)
        if ('problem' in result) {
          problems.push({ file: ctx.doc.file, line: lineNo, message: result.problem })
          rewritten += target
        } else {
          rewritten += result.url
        }
      }
      cursor = urlStart + target.length
    }
    out.push(rewritten + line.slice(cursor))
  })
  return { markdown: out.join('\n'), problems }
}

export interface BuildOptions {
  docsDir: string
  nav: DocsNav
}

export interface BuildResult {
  /** Path relative to the site directory → parsed JSON content. */
  files: Map<string, unknown>
  problems: DocProblem[]
}

/** Generates every page.json + the nav fragment, in memory. */
export function buildDocsPages({ docsDir, nav }: BuildOptions): BuildResult {
  const files = new Map<string, unknown>()
  const problems: DocProblem[] = []
  const published = nav.groups.flatMap(g => g.docs)
  const publishedByFile = new Map(published.map(d => [d.file, d]))

  const headingsByFile = new Map<string, Heading[]>()
  for (const doc of published) {
    const path = join(docsDir, doc.file)
    if (!existsSync(path)) {
      problems.push({
        file: doc.file,
        line: 0,
        message: `${doc.file} is listed in scripts/docs-nav.json but does not exist`,
      })
      continue
    }
    headingsByFile.set(doc.file, extractHeadings(readFileSync(path, 'utf8')))
  }

  for (const doc of published) {
    const path = join(docsDir, doc.file)
    if (!existsSync(path)) continue
    const source = readFileSync(path, 'utf8')
    const headings = headingsByFile.get(doc.file) ?? []
    const h1 = headings.find(h => h.depth === 1)
    if (!h1) {
      problems.push({ file: doc.file, line: 1, message: `${doc.file} has no H1 heading — add one` })
      continue
    }
    const { markdown, problems: linkProblems } = rewriteLinks(source, {
      docsDir,
      repoRoot: resolve(docsDir, '..'),
      doc,
      headings,
      headingsByFile,
      publishedByFile,
    })
    problems.push(...linkProblems)

    const body =
      `> ${nav.banner}\n\n${markdown.trimEnd()}\n\n---\n\n` +
      `[Edit this page on GitHub](${GITHUB_REPO}/edit/main/docs/${doc.file})\n`

    const slug = slugOf(doc)
    const dir = doc.file === INDEX_FILE ? 'targets/local/pages/docs' : `targets/local/pages/docs/${slug}`
    files.set(`${dir}/page.json`, {
      template: 'site-layout',
      metadata: {
        title: `${h1.text} — Gazetta`,
        description: doc.description,
      },
      components: [
        '@header',
        '@docs-nav',
        {
          name: `docs-${slug}-body`,
          template: 'doc',
          content: body,
        },
        '@footer',
      ],
    })
  }

  files.set('targets/local/fragments/docs-nav/fragment.json', {
    template: 'docs-nav',
    content: {
      groups: nav.groups.map(group => ({
        title: group.title,
        items: group.docs.map(doc => ({ label: doc.label, href: sitePathOf(doc) })),
      })),
    },
  })

  return { files, problems }
}

/** Parses AGENTS.md's "Public docs" bullet list into docs/<file> paths. */
export function parseAgentsPublicDocs(agentsMd: string): string[] {
  const out: string[] = []
  let inList = false
  for (const line of agentsMd.split('\n')) {
    if (/^\*\*Public docs\*\*/.test(line.trim())) {
      inList = true
      continue
    }
    if (!inList) continue
    const m = /^- `(docs\/[^`]+\.md)`/.exec(line.trim())
    if (m) {
      out.push(m[1])
    } else if (out.length > 0) {
      break
    }
  }
  return out
}

const stringify = (value: unknown): string => `${JSON.stringify(value, null, 2)}\n`

interface CliOptions {
  check: boolean
  docsDir: string
  siteDir: string
  agentsMd: string
}

function parseArgs(argv: string[]): CliOptions {
  const scriptDir = dirname(fileURLToPath(import.meta.url))
  const siteDir = resolve(scriptDir, '..')
  const opts: CliOptions = {
    check: false,
    docsDir: resolve(siteDir, '..', '..', 'docs'),
    siteDir,
    agentsMd: resolve(siteDir, '..', '..', 'AGENTS.md'),
  }
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (arg === '--check') opts.check = true
    else if (arg === '--docs-dir') opts.docsDir = resolve(argv[++i])
    else if (arg === '--site-dir') opts.siteDir = resolve(argv[++i])
    else if (arg === '--agents-md') opts.agentsMd = resolve(argv[++i])
    else {
      console.error(`Unknown argument: ${arg}`)
      process.exit(2)
    }
  }
  return opts
}

function main(): void {
  const opts = parseArgs(process.argv.slice(2))
  const navPath = join(opts.siteDir, 'scripts', 'docs-nav.json')
  const nav = JSON.parse(readFileSync(navPath, 'utf8')) as DocsNav
  const published = nav.groups.flatMap(g => g.docs)

  const { files, problems } = buildDocsPages({ docsDir: opts.docsDir, nav })
  const errors: string[] = problems.map(p => `docs/${p.file}${p.line ? `:${p.line}` : ''}: ${p.message}`)

  // Every top-level docs/*.md must be accounted for by the nav.
  const known = new Set([
    ...published.map(d => d.file),
    ...nav.internal.map(d => d.file),
    ...nav.removed.map(slug => `${slug}.md`),
  ])
  for (const entry of readdirSync(opts.docsDir)) {
    if (entry.endsWith('.md') && !known.has(entry)) {
      errors.push(`docs/${entry} is not listed in scripts/docs-nav.json — add it to a group or the internal list`)
    }
  }

  // AGENTS.md's Public docs list must match the nav's published docs.
  const agentsList = new Set(
    parseAgentsPublicDocs(readFileSync(opts.agentsMd, 'utf8')).map(p => p.replace(/^docs\//, '')),
  )
  const navList = new Set(published.map(d => d.file))
  if (agentsList.size !== navList.size || [...agentsList].some(f => !navList.has(f))) {
    errors.push(
      'AGENTS.md Public docs list differs from scripts/docs-nav.json — update the Public docs list in AGENTS.md',
    )
  }

  // No stray folders under pages/docs/.
  const pagesDocsDir = join(opts.siteDir, 'targets', 'local', 'pages', 'docs')
  const expectedFolders = new Set(published.filter(d => d.file !== INDEX_FILE).map(d => slugOf(d)))
  if (existsSync(pagesDocsDir)) {
    for (const entry of readdirSync(pagesDocsDir, { withFileTypes: true })) {
      if (entry.isDirectory() && !expectedFolders.has(entry.name)) {
        errors.push(
          `targets/local/pages/docs/${entry.name}/ does not belong to a published doc — delete the folder or add the doc to scripts/docs-nav.json`,
        )
      }
    }
  }

  if (opts.check) {
    for (const [rel, json] of files) {
      const abs = join(opts.siteDir, rel)
      if (!existsSync(abs)) {
        errors.push(`${rel} is missing — run npm run docs:site`)
        continue
      }
      const committed = JSON.parse(readFileSync(abs, 'utf8')) as unknown
      if (stringify(committed) !== stringify(json)) {
        errors.push(`${rel} is out of date — run npm run docs:site`)
      }
    }
    if (errors.length > 0) {
      console.error(`docs:site check failed with ${errors.length} problem(s):`)
      for (const e of errors) console.error(`  - ${e}`)
      process.exit(1)
    }
    console.log(`docs:site check passed (${files.size} files in sync)`)
    return
  }

  // Write mode: prune stray folders, then write changed files.
  if (existsSync(pagesDocsDir)) {
    for (const entry of readdirSync(pagesDocsDir, { withFileTypes: true })) {
      if (entry.isDirectory() && !expectedFolders.has(entry.name)) {
        rmSync(join(pagesDocsDir, entry.name), { recursive: true, force: true })
        console.log(`pruned targets/local/pages/docs/${entry.name}/`)
      }
    }
  }
  let written = 0
  let unchanged = 0
  for (const [rel, json] of files) {
    const abs = join(opts.siteDir, rel)
    const next = stringify(json)
    if (existsSync(abs) && readFileSync(abs, 'utf8') === next) {
      unchanged++
      continue
    }
    mkdirSync(dirname(abs), { recursive: true })
    writeFileSync(abs, next)
    written++
    console.log(`wrote ${rel}`)
  }
  if (errors.length > 0) {
    console.error(`docs:site found ${errors.length} problem(s):`)
    for (const e of errors) console.error(`  - ${e}`)
    process.exit(1)
  }
  console.log(`docs:site: ${written} written, ${unchanged} unchanged`)
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main()
}
