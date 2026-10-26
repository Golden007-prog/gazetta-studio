import { z } from 'zod'
import type { TemplateFunction } from 'gazetta'

// Docs sidebar. Content comes from the generated docs-nav fragment
// (scripts/docs-pages.ts); the small script marks the link for the
// current page with aria-current="page".
export const schema = z.object({
  groups: z
    .array(
      z.object({
        title: z.string().describe('Group heading'),
        items: z.array(
          z.object({
            label: z.string().describe('Link label'),
            href: z.string().describe('Link target, e.g. /docs/cache'),
          }),
        ),
      }),
    )
    .describe('Nav groups in display order'),
})

type Content = z.infer<typeof schema>

const ESCAPES: Record<string, string> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
}
const escapeHtml = (s: string): string => s.replace(/[&<>"']/g, c => ESCAPES[c])

const template: TemplateFunction<Content> = ({ content }) => {
  const groups = content?.groups ?? []
  return {
    html: `<aside class="docs-nav">
  <nav aria-label="Docs">
    ${groups
      .map(
        group => `<section class="docs-nav-group">
      <h2>${escapeHtml(group.title)}</h2>
      <ul>${group.items
        .map(item => `<li><a href="${escapeHtml(item.href)}">${escapeHtml(item.label)}</a></li>`)
        .join('')}</ul>
    </section>`,
      )
      .join('\n    ')}
  </nav>
</aside>`,
    css: `.docs-nav { padding: 1.5rem; border-bottom: 1px solid #27272a; }
.docs-nav-group { margin-bottom: 1.5rem; }
.docs-nav-group:last-child { margin-bottom: 0; }
.docs-nav-group h2 { font-size: 0.75rem; font-weight: 600; text-transform: uppercase; letter-spacing: 0.05em; color: #71717a; margin-bottom: 0.375rem; }
.docs-nav-group ul { list-style: none; }
.docs-nav-group a { display: block; padding: 0.25rem 0; color: #a1a1aa; font-size: 0.875rem; }
.docs-nav-group a:hover { color: #e4e4e7; }
.docs-nav-group a[aria-current='page'] { color: #a78bfa; font-weight: 500; }
@media (min-width: 72rem) {
  .docs-nav { position: fixed; top: 4rem; left: max(1rem, calc(50% - 39rem)); width: 15rem; max-height: calc(100vh - 6rem); overflow-y: auto; border-bottom: none; padding: 2.5rem 1rem; }
}`,
    js: `document.querySelectorAll('.docs-nav a').forEach(function (a) {
  if (a.getAttribute('href') === window.location.pathname) {
    a.setAttribute('aria-current', 'page')
  }
})`,
  }
}

export default template
