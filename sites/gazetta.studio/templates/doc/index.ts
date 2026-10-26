import GithubSlugger from 'github-slugger'
import { Marked } from 'marked'
import { createHighlighter, type Highlighter } from 'shiki'
import { z } from 'zod'
import type { TemplateFunction } from 'gazetta'

// Docs page renderer. Content is the page's Markdown source as one plain
// string (scripts/docs-pages.ts rewrites links and prepends the banner);
// this template does the Markdown → HTML rendering: syntax highlighting,
// GitHub-compatible heading ids with a visible # link, and an "On this
// page" list of the H2/H3 headings.
export const schema = z.string().describe('Markdown source of the docs page')

// Languages highlighted with Shiki; anything else renders as plain text.
const HIGHLIGHT_LANGS = [
  'typescript',
  'ts',
  'tsx',
  'bash',
  'sh',
  'json',
  'jsonc',
  'diff',
  'toml',
  'dockerfile',
  'nginx',
  'css',
  'yaml',
]

const ESCAPES: Record<string, string> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
}
const escapeHtml = (s: string): string => s.replace(/[&<>"']/g, c => ESCAPES[c])

let highlighter: Highlighter | null = null

async function getHighlighter(): Promise<Highlighter> {
  if (!highlighter) {
    highlighter = await createHighlighter({
      themes: ['github-dark'],
      langs: HIGHLIGHT_LANGS,
    })
  }
  return highlighter
}

const template: TemplateFunction = async ({ content }) => {
  const source = typeof content === 'string' ? content : ''
  const hl = await getHighlighter()
  const slugger = new GithubSlugger()
  const toc: { depth: number; text: string; slug: string }[] = []

  // A fresh Marked instance per render: the heading renderer carries the
  // per-page slugger state, so a shared instance would leak slugs across
  // pages.
  const marked = new Marked()
  marked.use({
    renderer: {
      heading({ tokens, depth, raw }) {
        const html = this.parser.parseInline(tokens)
        const plain = raw
          .replace(/^#{1,6}\s+/, '')
          .replace(/\s+#+\s*$/, '')
          .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
          .replace(/[*`~]/g, '')
          .trim()
        const slug = slugger.slug(plain)
        if (depth === 2 || depth === 3) toc.push({ depth, text: plain, slug })
        return `<h${depth} id="${slug}"><a class="anchor" href="#${slug}" aria-hidden="true" tabindex="-1">#</a>${html}</h${depth}>`
      },
      code({ text, lang }) {
        const language = (lang ?? '').toLowerCase()
        if (HIGHLIGHT_LANGS.includes(language)) {
          try {
            return hl.codeToHtml(text, { lang: language, theme: 'github-dark' })
          } catch {
            // Unknown to the highlighter after all: fall through to plain.
          }
        }
        return `<pre><code>${escapeHtml(text)}</code></pre>`
      },
      // The generator refuses docs with raw HTML; escape here too so a
      // hand-authored page can never inject markup.
      html({ text }) {
        return escapeHtml(text)
      },
    },
  })

  const bodyHtml = marked.parse(source) as string

  const tocHtml = toc.length
    ? `<nav class="on-this-page" aria-label="On this page">
  <h2 class="on-this-page-title">On this page</h2>
  <ul>${toc
    .map(t => `<li class="toc-depth-${t.depth}"><a href="#${t.slug}">${escapeHtml(t.text)}</a></li>`)
    .join('')}</ul>
</nav>`
    : ''

  return {
    html: `<article class="doc">
${tocHtml}
<div class="doc-body">
${bodyHtml}
</div>
</article>`,
    css: `.doc { max-width: 46rem; margin: 0 auto; padding: 2.5rem 1.5rem 4rem; width: 100%; min-width: 0; }
.doc-body { overflow-wrap: break-word; }
.doc h1 { font-size: 2rem; font-weight: 700; color: #fafafa; margin-bottom: 1rem; }
.doc h2 { font-size: 1.375rem; font-weight: 600; color: #f4f4f5; margin: 2.5rem 0 0.75rem; }
.doc h3 { font-size: 1.125rem; font-weight: 600; color: #e4e4e7; margin: 1.75rem 0 0.5rem; }
.doc h4 { font-size: 1rem; font-weight: 600; color: #e4e4e7; margin: 1.5rem 0 0.5rem; }
.doc .anchor { opacity: 0; margin-left: -1.25rem; padding-right: 0.375rem; color: #52525b; font-weight: 400; }
.doc h1:hover .anchor, .doc h2:hover .anchor, .doc h3:hover .anchor, .doc h4:hover .anchor, .doc .anchor:focus { opacity: 1; }
.doc p, .doc li { color: #d4d4d8; }
.doc p { margin-bottom: 1rem; }
.doc ul, .doc ol { margin: 0 0 1rem 1.5rem; }
.doc li { margin-bottom: 0.25rem; }
.doc strong { color: #fafafa; }
.doc a { color: #a78bfa; }
.doc a:hover { color: #c4b5fd; }
.doc code { background: #18181b; padding: 0.125rem 0.375rem; border-radius: 4px; font-size: 0.875em; font-family: 'JetBrains Mono', 'Fira Code', monospace; }
.doc pre { background: #16161a; border: 1px solid #27272a; border-radius: 8px; padding: 1rem 1.25rem; overflow-x: auto; margin-bottom: 1rem; font-size: 0.875rem; line-height: 1.7; }
.doc pre code { background: none; padding: 0; border-radius: 0; font-size: inherit; }
.doc pre.shiki { background-color: #16161a !important; }
.doc blockquote { border-left: 3px solid #8b5cf6; background: #18181b; padding: 0.75rem 1rem; border-radius: 0 6px 6px 0; margin-bottom: 1rem; }
.doc blockquote p { margin-bottom: 0; color: #c4b5fd; }
.doc table { display: block; width: 100%; border-collapse: collapse; margin-bottom: 1rem; font-size: 0.875rem; overflow-x: auto; }
.doc th, .doc td { text-align: left; padding: 0.5rem 0.75rem; border-bottom: 1px solid #27272a; color: #d4d4d8; }
.doc th { color: #fafafa; font-weight: 600; }
.doc hr { border: none; border-top: 1px solid #27272a; margin: 2rem 0; }
.doc img { max-width: 100%; }
.on-this-page { display: none; }
@media (min-width: 88rem) {
  .on-this-page { display: block; position: fixed; top: 5rem; right: max(1rem, calc(50% - 39rem)); width: 13rem; font-size: 0.8125rem; max-height: calc(100vh - 7rem); overflow-y: auto; }
  .on-this-page-title { font-size: 0.75rem; text-transform: uppercase; letter-spacing: 0.05em; color: #71717a; margin-bottom: 0.5rem; }
  .on-this-page ul { list-style: none; }
  .on-this-page li { margin: 0.25rem 0; }
  .on-this-page .toc-depth-3 { padding-left: 1rem; }
  .on-this-page a { color: #71717a; }
  .on-this-page a:hover { color: #e4e4e7; }
}
@media (prefers-color-scheme: light) {
  .doc h1 { color: #18181b; }
  .doc h2 { color: #27272a; }
  .doc h3, .doc h4 { color: #3f3f46; }
  .doc .anchor { color: #a1a1aa; }
  .doc p, .doc li { color: #3f3f46; }
  .doc strong { color: #18181b; }
  .doc a { color: #7c3aed; }
  .doc a:hover { color: #6d28d9; }
  .doc code { background: #f4f4f5; }
  .doc pre { border-color: #d4d4d8; }
  .doc blockquote { background: #f4f4f5; }
  .doc blockquote p { color: #6d28d9; }
  .doc th, .doc td { border-bottom-color: #e4e4e7; color: #3f3f46; }
  .doc th { color: #18181b; }
  .doc hr { border-top-color: #e4e4e7; }
}
@media (prefers-color-scheme: light) and (min-width: 88rem) {
  .on-this-page-title { color: #52525b; }
  .on-this-page a { color: #52525b; }
  .on-this-page a:hover { color: #18181b; }
}`,
    js: '',
    head: `<style>
/* Light mode for the docs pages. The shared site chrome is dark-only; these
   overrides flip it just here. The html body prefix outranks both the layout's
   body rule and the scoped data-gz rules; !important only where the original rule uses it. */
@media (prefers-color-scheme: light) {
  html body { background: #ffffff; color: #1f2328; }
  html body .site .navbar-brand { color: #18181b; }
  html body .site .navbar-links a { color: #3f3f46; }
  html body .site .navbar-links a:hover { color: #09090b; }
  html body .site .navbar-cta { background: #e4e4e7; color: #1f2328 !important; }
  html body .site .navbar-cta:hover { background: #d4d4d8; }
  html body .site .footer-brand strong { color: #18181b; }
  html body .site .footer-brand p { color: #6b7280; }
  html body .site .footer-claude { color: #6b7280; }
  html body .site .footer-claude:hover { color: #d97757; }
  html body .site .footer-copy { color: #9ca3af; }
</style>`,
  }
}

export default template
