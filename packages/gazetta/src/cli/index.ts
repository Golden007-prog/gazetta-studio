#!/usr/bin/env node

import { resolve, join, dirname, relative } from 'node:path'
import { watch, existsSync, readFileSync, realpathSync } from 'node:fs'
import { serve } from '@hono/node-server'
import { serveStatic } from '@hono/node-server/serve-static'
import { Hono } from 'hono'
import { streamSSE } from 'hono/streaming'
import { loadSite } from '../site-loader.js'
import { resolvePage } from '../resolver.js'
import { renderPage } from '../renderer.js'
import { createFilesystemProvider } from '../providers/filesystem.js'
import { invalidateTemplate, invalidateAllTemplates } from '../template-loader.js'
import { REQUIRED_NODE_RANGE } from '../node-floor.js'
import { isTemplateEventRecent, TEMPLATE_RECENT_CHANGE_WINDOW_MS } from './dev-template-watcher.js'
// createTargetRegistry is used lazily by admin-api publish routes
import type { SiteManifest } from '../types.js'
import type { Issue } from '../validation/types.js'
import { getEnvironment, getType, isEditable } from '../types.js'
import { buildHooksRegistry, createAdminApp } from '../admin-api/index.js'
import { parseValidateFlags } from './validate-flags.js'
import { logDefaultedPublicTargets } from '../validation/validators/public-storage-config.js'
import { parseArgs } from './args.js'
import { authTrustOf, exitOnListenError, resolveListenHost, SERVER_COMMANDS } from './listen-host.js'
import { devNotFound } from './dev-not-found.js'
import { isInside } from './is-inside.js'
import { isArchived } from '../archive-helpers.js'
import { viteCacheDir } from './vite-cache-dir.js'
import { isStatePath, STATE_ROOT } from '../state-folders.js'

// ANSI color helpers — no dependency, suppressed when NO_COLOR or CI
const noColor = !!process.env.NO_COLOR || !process.stdout.isTTY
const c = {
  bold: (s: string) => (noColor ? s : `\x1b[1m${s}\x1b[22m`),
  dim: (s: string) => (noColor ? s : `\x1b[2m${s}\x1b[22m`),
  cyan: (s: string) => (noColor ? s : `\x1b[36m${s}\x1b[39m`),
  green: (s: string) => (noColor ? s : `\x1b[32m${s}\x1b[39m`),
  yellow: (s: string) => (noColor ? s : `\x1b[33m${s}\x1b[39m`),
  red: (s: string) => (noColor ? s : `\x1b[31m${s}\x1b[39m`),
  magenta: (s: string) => (noColor ? s : `\x1b[35m${s}\x1b[39m`),
  bgGreen: (s: string) => (noColor ? s : `\x1b[42m\x1b[30m${s}\x1b[39m\x1b[49m`),
}

const args = process.argv.slice(2)
const command = args[0]

/**
 * Load a site manifest from `siteDir` via the TS config loader. Recognizes
 * `site.config.ts`, `site.config.js`, and `site.config.mjs`.
 *
 * Returns null when no config file is found.
 */
async function loadSiteManifestForCli(siteDir: string): Promise<SiteManifest | null> {
  const tsConfigCandidates = ['site.config.ts', 'site.config.js', 'site.config.mjs']
  if (!tsConfigCandidates.some(f => existsSync(join(siteDir, f)))) return null
  const { loadSiteConfig, siteConfigToManifest } = await import('../config/loader.js')
  const loaded = await loadSiteConfig(siteDir)
  if (!loaded) return null
  return siteConfigToManifest(loaded.config)
}

/**
 * Read `admin.hooks` factory contributions from a site manifest.
 *
 * The manifest types `admin?` as a loose record (`Record<string, unknown>`)
 * to keep `SiteManifest` stable across foundation additions; each foundation
 * narrow-types its own block at the consumption site. For hooks the runtime
 * shape is `ReadonlyArray<HookContribution>` (per design-hooks.md
 * "Registration"); we accept it as `unknown` here and cast at the boundary.
 *
 * Returns undefined when the field is absent or empty.
 */
function readHookContributions(
  manifest: SiteManifest | null,
): ReadonlyArray<import('../hooks/index.js').HookContribution> | undefined {
  const hooks = manifest?.admin?.hooks
  if (!Array.isArray(hooks) || hooks.length === 0) return undefined
  return hooks as ReadonlyArray<import('../hooks/index.js').HookContribution>
}

// Served to /admin/* requests during dev-server startup before Vite middleware
// is attached. Polls /admin/ping every 500ms and reloads when the admin becomes
// reachable. See #132 and cli/index.ts for why this is needed.
const LOADER_HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>Loading Gazetta admin…</title>
<style>
  /* Neutral tones — the loader is a transitional state and we don't yet know
     whether the user has customized the admin theme. Mid-gray reads as
     "loading" on any conceivable admin background. */
  html, body { height: 100%; margin: 0; overflow: hidden; }
  body { font-family: system-ui, -apple-system, sans-serif; background: #262626; color: #a3a3a3; transition: opacity 200ms ease; position: relative; }
  body.light { background: #f5f5f5; color: #525252; }
  body.leaving { opacity: 0; }

  /* Watermark — full-width brand fill, faint so it reads as background. */
  .brand {
    position: absolute; inset: 0; display: flex; align-items: center; justify-content: center;
    font-weight: 800; letter-spacing: -0.04em; color: currentColor; opacity: 0.08;
    font-size: clamp(6rem, 22vw, 18rem); line-height: 1;
    pointer-events: none; user-select: none;
  }

  /* Status pill — top-left, fades in only if startup is slow. */
  .progress {
    position: absolute; top: 1rem; left: 1rem;
    display: flex; align-items: center; gap: 0.5rem;
    font-size: 0.8125rem; opacity: 0; transition: opacity 300ms ease;
  }
  .progress.shown { opacity: 0.75; }
  .spinner { width: 14px; height: 14px; border: 2px solid currentColor; border-right-color: transparent; border-radius: 50%; animation: spin 0.8s linear infinite; }
  @keyframes spin { to { transform: rotate(360deg); } }
</style>
</head>
<body>
  <div class="brand" aria-hidden="true">GAZETTA</div>
  <div class="progress" role="status" aria-live="polite">
    <div class="spinner" aria-hidden="true"></div>
    <span class="label">Starting admin…</span>
  </div>
  <script>
    // Match the user's saved admin theme if present; fall back to dark default
    // (admin defaults to dark on first load).
    try {
      var saved = localStorage.getItem('gazetta_theme')
      if (saved === 'light') document.body.classList.add('light')
    } catch (e) { /* ignore */ }

    // Delay the spinner + label by 400ms so warm restarts never paint them.
    // The brand wordmark is always visible — it's safe; nothing about it
    // implies "this is taking a while".
    var progress = document.querySelector('.progress')
    var showTimer = setTimeout(function () { progress.classList.add('shown') }, 400)

    ;(function poll() {
      fetch('/admin/ping', { cache: 'no-store' })
        .then(function (r) { return r.ok ? r.json() : null })
        .then(function (j) {
          if (j && j.ready) {
            clearTimeout(showTimer)
            // Fade body out, then reload — softer handoff than an instant swap
            document.body.classList.add('leaving')
            setTimeout(function () { window.location.reload() }, 200)
          } else {
            setTimeout(poll, 500)
          }
        })
        .catch(function () { setTimeout(poll, 500) })
    })()
  </script>
</body>
</html>`

/**
 * Detect the project root from a site directory.
 * Walks up from siteDir looking for a parent that contains templates/.
 * Falls back to siteDir for flat projects (templates/ inside site dir).
 */
function detectProjectRoot(siteDir: string): string {
  // If siteDir itself has templates/, it's a flat project
  if (existsSync(join(siteDir, 'templates'))) return siteDir
  // Walk up looking for templates/
  let dir = resolve(siteDir)
  const root = resolve('/')
  while (dir !== root) {
    const parent = dirname(dir)
    if (existsSync(join(parent, 'templates'))) return parent
    dir = parent
  }
  // Fallback — use siteDir (templates/ may not exist yet)
  return siteDir
}

/**
 * Resolve the siteDir for any CLI command by extracting the site
 * positional from the parsed args per the command's documented
 * positional layout. Pure fs walk; no config eval — safe to call
 * before env-load.
 *
 * Single dispatch table so env-load happens exactly once at the top
 * of `main()`, before any config-eval can read process.env.
 */
async function resolveSiteDirForCommand(cmd: string, parsed: { positional: readonly string[] }): Promise<string> {
  // Commands whose site positional sits at a fixed index.
  if (cmd === 'build') return resolveSiteDir(parsed.positional[0])
  if (cmd === 'dev' || cmd === 'validate' || cmd === 'admin') return resolveSiteDir(parsed.positional[0])

  // `rollback <rev> [target|site] [site]`: site is positional[1] when
  // site-shaped, else positional[2].
  if (cmd === 'rollback') {
    const second = parsed.positional[1]
    const third = parsed.positional[2]
    const secondIsSite = second && (second.includes('/') || hasSiteConfig(resolve(second)))
    return resolveSiteDir(secondIsSite ? second : third)
  }

  // `publish|serve|deploy|history|undo [target|site] [site]`: site is
  // positional[0] when site-shaped, else positional[1].
  if (cmd === 'publish' || cmd === 'serve' || cmd === 'deploy' || cmd === 'history' || cmd === 'undo') {
    const first = parsed.positional[0]
    const firstIsSite = first && (first.includes('/') || hasSiteConfig(resolve(first)))
    return resolveSiteDir(firstIsSite ? first : parsed.positional[1])
  }

  // `translate <item> --to <locale> [target]` — no explicit site arg.
  if (cmd === 'translate') return resolveSiteDir(undefined)

  // `assets <subcmd> [args...] [target] [site]`: layout differs by subcmd.
  if (cmd === 'assets') {
    const subcmd = parsed.positional[0]
    const sitePositional = subcmd === 'info' ? parsed.positional[3] : parsed.positional[2]
    return resolveSiteDir(sitePositional)
  }

  // `archive <subcmd> [args...] [target] [site]`: site at trailingStart+1.
  if (cmd === 'archive') {
    const subcmd = parsed.positional[0]
    const requiredArgs = subcmd === 'rename' ? 2 : subcmd === 'purge' || subcmd === 'restore' ? 1 : 0
    return resolveSiteDir(parsed.positional[1 + requiredArgs + 1])
  }

  // `state remove <target> [site]`: site at positional[2].
  if (cmd === 'state') return resolveSiteDir(parsed.positional[2])

  // Unknown command → auto-detect (main's switch will reject with a
  // clear "Unknown command" error after env-load runs).
  return resolveSiteDir(undefined)
}

/**
 * Load `.env` + `.env.local` from project root and site dir, in that
 * order, so per-site secrets override project-wide defaults. Must run
 * BEFORE the first config-eval (the site's storage / deploy / etc.
 * factories read `process.env` synchronously at construction). Skipped
 * in CI — CI runners inject env directly.
 *
 * Per Q1 of CLI env-loading discipline: site-local `.env` is honored
 * (gazetta.studio has its own `.env` with R2/Cloudflare creds; this
 * function ensures factories see them at config-eval time).
 */
function loadEnvFiles(siteDir: string): void {
  if (process.env.CI) return
  const projectRoot = detectProjectRoot(siteDir)
  const envDirs = projectRoot !== siteDir ? [projectRoot, siteDir] : [siteDir]
  for (const dir of envDirs) {
    for (const name of ['.env', '.env.local']) {
      const envPath = join(dir, name)
      if (!existsSync(envPath)) continue
      for (const line of readFileSync(envPath, 'utf-8').split('\n')) {
        const m = line.match(/^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.*)$/)
        if (m && !(m[1] in process.env)) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '')
      }
    }
  }
}

function printHelp() {
  console.log(`
  gazetta - Stateless CMS for composable websites

  Usage:
    gazetta init [dir]              Create a new site
    gazetta dev [site]              Start dev server + CMS at /admin
    gazetta build                   Build admin UI for production
    gazetta admin [site]            Run production CMS admin server
    gazetta publish [target] [site] Pre-render and publish to a target
    gazetta serve [target] [site]   Serve published pages from target storage
    gazetta deploy [target] [site]  Deploy worker to hosting (one-time setup)
    gazetta validate [site]         Check site for broken references
    gazetta translate <item> --to <locale> [target]
                                    Create a locale copy of a page or fragment
    gazetta history [target] [site] List revisions on a target
    gazetta undo [target] [site]    Restore the previous revision (soft undo)
    gazetta rollback <rev> [target] [site]
                                    Restore an arbitrary revision by id
    gazetta assets list [target] [site]
                                    List assets on a target
    gazetta assets info <name> [target] [site]
                                    Show full detail (variants, overrides, refs) for one asset
    gazetta assets reindex [target] [site]
                                    Rebuild the asset-refs sidecar index from manifests
    gazetta archive list [--kind=page|fragment] [target] [site]
                                    List archived items
    gazetta archive purge <name> [--kind=...] [--force] [target] [site]
                                    Permanently delete an archive
    gazetta archive restore <name> [--kind=...] [target] [site]
                                    Unarchive an item (back to live)
    gazetta archive rename <oldname> <newname> [--kind=...] [--no-keep-alias] [target] [site]
                                    Rename a live item; keeps the redirect by default
    gazetta state remove <target> [site]
                                    Delete history, audit and review from a target's storage
    gazetta help                    Show this help message

  Options:
    --port, -p <port>               Server port (default: 3000)
    --host <address>                Address to listen on (dev, and admin without auth: 127.0.0.1; otherwise all interfaces)
    --force, -f                     Publish all items (skip unchanged check)
    --yes, -y                       Skip confirmation prompt (required in CI
                                    for undo/rollback on production targets
                                    and for state remove)
    --limit <n>                     Max revisions to list (default: 50)

  Auto-detection:
    Site is auto-detected from sites/ directory. If multiple sites exist,
    you'll be prompted to choose (or pass it as an argument).

    Target is auto-detected as the first target in site.config.ts. If multiple
    targets exist, you'll be prompted to choose (or pass it as an argument).

  Examples:
    gazetta init my-site                # scaffold a new site
    gazetta dev                         # dev server (auto-detect site)
    gazetta publish                     # publish to default target
    gazetta publish production          # publish to production
    gazetta publish production my-site  # publish specific site to production
    gazetta serve production -p 8080    # serve production on port 8080
    gazetta validate                    # check site for errors
    gazetta history                     # list revisions on default target
    gazetta undo production --yes       # undo last write on production (CI-safe)
    gazetta rollback rev-1776337441608  # roll back to a specific revision
`)
}

/**
 * Resolve the site directory from positional args or auto-detection.
 * For commands like `dev` and `validate`, the first positional is the site.
 * For commands like `publish` and `serve`, the first positional is the target
 * and the second is the site.
 */
/** Returns true if the directory contains a Gazetta site config (`site.config.ts`/.js/.mjs). */
function hasSiteConfig(dir: string): boolean {
  return (
    existsSync(join(dir, 'site.config.ts')) ||
    existsSync(join(dir, 'site.config.js')) ||
    existsSync(join(dir, 'site.config.mjs'))
  )
}

async function resolveSiteDir(positionalSite?: string): Promise<string> {
  // Explicit site dir provided
  if (positionalSite) {
    const dir = resolve(positionalSite)
    if (hasSiteConfig(dir)) return dir
    // Maybe it's a site name under sites/
    const sitesSubdir = resolve('sites', positionalSite)
    if (hasSiteConfig(sitesSubdir)) return sitesSubdir
    // Maybe it's a project root with sites/
    const mainSite = resolve(dir, 'sites/main')
    if (hasSiteConfig(mainSite)) return mainSite
    return dir // let loadSite produce a clear error
  }

  // Auto-detect: check current dir first
  if (hasSiteConfig(resolve('.'))) return resolve('.')

  // Check sites/ directory
  const sitesDir = resolve('sites')
  if (existsSync(sitesDir)) {
    const { readdirSync, statSync } = await import('node:fs')
    const sites = readdirSync(sitesDir).filter(name => {
      const dir = join(sitesDir, name)
      return statSync(dir).isDirectory() && hasSiteConfig(dir)
    })

    if (sites.length === 1) return join(sitesDir, sites[0])
    if (sites.length > 1) {
      if (process.env.CI) {
        console.error(
          `\n  Error: multiple sites found. Specify one: gazetta ${command} <site>\n  Available: ${sites.join(', ')}\n`,
        )
        process.exit(1)
      }
      const { select } = await import('@clack/prompts')
      const result = await select({
        message: 'Select site:',
        options: sites.map(s => ({ value: s, label: s })),
      })
      if (typeof result === 'symbol') process.exit(0) // cancelled
      return join(sitesDir, result as string)
    }
  }

  // No site found — give a helpful error
  console.error(`\n  Error: no site found in current directory.\n`)
  console.error(`  To create a new project:  gazetta init my-site`)
  console.error(`  To use an existing site:  gazetta ${command} <path-to-site>\n`)
  process.exit(1)
}

/**
 * Resolve target from positional args or auto-detection.
 * Prompts if multiple targets and no explicit choice.
 */
async function resolveTarget(positionalTarget: string | undefined, siteDir: string): Promise<string | undefined> {
  if (positionalTarget) return positionalTarget

  const manifest = await loadSiteManifestForCli(siteDir)
  if (!manifest) return undefined
  const targets = Object.keys(manifest.targets ?? {})

  if (targets.length <= 1) return targets[0] // auto-select if 0 or 1

  if (process.env.CI) {
    console.error(
      `\n  Error: multiple targets found. Specify one: gazetta ${command} <target>\n  Available: ${targets.join(', ')}\n`,
    )
    process.exit(1)
  }

  const { select } = await import('@clack/prompts')
  const result = await select({
    message: 'Select target:',
    options: targets.map(t => ({ value: t, label: t })),
  })
  if (typeof result === 'symbol') process.exit(0)
  return result as string
}

async function runInit(dir: string) {
  const { writeFile, mkdir } = await import('node:fs/promises')
  const target = resolve(dir)

  if (existsSync(join(target, 'sites')) || existsSync(join(target, 'site.config.ts'))) {
    console.error(`\n  Error: project already exists in ${target}\n`)
    process.exit(1)
  }

  const name = target.split('/').pop() ?? 'my-site'

  // A new site depends on a caret range of the CLI's own version, not '*':
  // npm's caret on 0.x allows only patch updates, so a breaking minor never
  // arrives unchosen while fixes still do. A prerelease CLI pins the site to
  // the prerelease itself.
  const ownPackageJson = ['../../package.json', '../package.json']
    .map(candidate => resolve(import.meta.dirname, candidate))
    .find(candidate => existsSync(candidate))
  if (!ownPackageJson) {
    console.error(`\n  Error: could not locate gazetta's own package.json to determine the dependency range\n`)
    process.exit(1)
  }
  const cliVersion = (JSON.parse(readFileSync(ownPackageJson, 'utf-8')) as { version: string }).version
  const gazettaRange = cliVersion.includes('-') ? cliVersion : `^${cliVersion}`

  const files: Record<string, string> = {
    // First write: if init is interrupted, later state is still ignored.
    '.gitignore': `node_modules/\ndist/\n.env\n.env.local\n**/${STATE_ROOT}/\n\n# Publish output under any target dir: rendered HTML, the publish-time\n# site manifest, and transient per-item sidecars (#1181). The editable\n# sources (page.json, fragment.json, an author's robots.txt) stay tracked.\n**/targets/**/.[0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f].hash\n**/targets/**/.[0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f].hash.*\n**/targets/**/.pub-*\n**/targets/**/index.html\n**/targets/**/index.*.html\n**/targets/**/404.html\n**/targets/**/site.json\n**/targets/*/index/\n`,

    'sites/main/site.config.ts': `import { defineSite, filesystemStorage } from 'gazetta'

export default defineSite({
  name: '${name}',
  version: '1.0.0',
  systemPages: ['404'],
  targets: {
    local: {
      storage: filesystemStorage(),
      // The editing target keeps history, so its storage must be private.
      publicStorage: false,
      // environment: 'local' (default); editable: true (default for a
      // private local target); filesystemStorage() defaults path to ./targets/local
    },
    staging: {
      storage: filesystemStorage({ path: './dist/staging' }),
      // Served by \`gazetta serve\`, which never serves \`.gazetta/\`, so history stays private.
      publicStorage: false,
      environment: 'staging',
    },
  },
})
`,

    'templates/page-layout/index.ts': `import { z } from 'zod'
import type { TemplateFunction } from 'gazetta'

export const schema = z.object({
  title: z.string().describe('Page title'),
  description: z.string().optional().describe('Page description'),
})

type Content = z.infer<typeof schema>

const template: TemplateFunction<Content> = ({ content, children = [] }) => ({
  html: \`<main>\${children.map(c => c.html).join('\\n')}</main>\`,
  css: \`main { max-width: 800px; margin: 0 auto; padding: 2rem; font-family: system-ui, sans-serif; }
\${children.map(c => c.css).join('\\n')}\`,
  js: children.map(c => c.js).filter(Boolean).join('\\n'),
  head: \`<title>\${content?.title ?? ''}</title>
\${content?.description ? \`<meta name="description" content="\${content.description}">\` : ''}
<link rel="icon" href="data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 100 100'><text y='.9em' font-size='90'>⚡</text></svg>">
\${children.map(c => c.head).filter(Boolean).join('\\n')}\`,
})

export default template
`,

    'templates/hero/index.ts': `import { z } from 'zod'
import type { TemplateFunction } from 'gazetta'

export const schema = z.object({
  title: z.string().describe('Page title'),
  subtitle: z.string().optional().describe('Subtitle text'),
})

type Content = z.infer<typeof schema>

const template: TemplateFunction<Content> = ({ content }) => ({
  html: \`<section class="hero">
  <h1>\${content?.title ?? ''}</h1>
  <p>\${content?.subtitle ?? ''}</p>
</section>\`,
  css: \`.hero { text-align: center; padding: 4rem 0; }
.hero h1 { font-size: 2.5rem; margin-bottom: 0.5rem; }
.hero p { color: #666; font-size: 1.25rem; }\`,
  js: '',
})

export default template
`,

    'templates/text-block/index.ts': `import { z } from 'zod'
import type { TemplateFunction } from 'gazetta'

export const schema = z.object({
  body: z.string().describe('Text content (HTML allowed)'),
})

type Content = z.infer<typeof schema>

const template: TemplateFunction<Content> = ({ content }) => ({
  html: \`<div class="text-block">\${content?.body ?? ''}</div>\`,
  css: \`.text-block { line-height: 1.6; margin: 2rem 0; }\`,
  js: '',
})

export default template
`,

    'templates/nav/index.ts': `import { z } from 'zod'
import type { TemplateFunction } from 'gazetta'

export const schema = z.object({
  brand: z.string().describe('Site name'),
  links: z.array(z.object({
    label: z.string(),
    href: z.string(),
  })).describe('Navigation links'),
})

type Content = z.infer<typeof schema>

const template: TemplateFunction<Content> = ({ content }) => {
  const links = content?.links ?? []
  return {
    html: \`<nav class="nav">
  <a class="nav-brand" href="/">\${content?.brand ?? ''}</a>
  <div class="nav-links">\${links.map(l => \`<a href="\${l.href}">\${l.label}</a>\`).join('\\n    ')}</div>
</nav>\`,
    css: \`.nav { display: flex; align-items: center; justify-content: space-between; padding: 1rem 2rem; border-bottom: 1px solid #eee; }
.nav-brand { font-weight: 700; font-size: 1.125rem; text-decoration: none; color: #1a1a1a; }
.nav-links { display: flex; gap: 1.5rem; }
.nav-links a { text-decoration: none; color: #555; font-size: 0.875rem; }
.nav-links a:hover { color: #1a1a1a; }\`,
    js: '',
  }
}

export default template
`,

    'sites/main/targets/local/fragments/header/fragment.json':
      JSON.stringify(
        {
          template: 'nav',
          content: { brand: name, links: [{ label: 'Home', href: '/' }] },
        },
        null,
        2,
      ) + '\n',

    'sites/main/targets/local/pages/home/page.json':
      JSON.stringify(
        {
          template: 'page-layout',
          content: { title: name, description: 'A site built with Gazetta' },
          components: [
            '@header',
            {
              name: 'hero',
              template: 'hero',
              content: { title: `Welcome to ${name}`, subtitle: 'A site built with Gazetta' },
            },
            {
              name: 'intro',
              template: 'text-block',
              content: {
                body: '<p>Run <code>npx gazetta dev</code> and open /admin to edit this content.</p>',
              },
            },
          ],
        },
        null,
        2,
      ) + '\n',

    'sites/main/targets/local/pages/404/page.json':
      JSON.stringify(
        {
          template: 'page-layout',
          content: { title: 'Page Not Found', description: "The page you're looking for doesn't exist." },
        },
        null,
        2,
      ) + '\n',

    'admin/.gitkeep': '',

    'package.json':
      JSON.stringify(
        {
          name,
          private: true,
          type: 'module',
          engines: { node: REQUIRED_NODE_RANGE },
          scripts: { dev: 'gazetta dev' },
          dependencies: { gazetta: gazettaRange, react: '^19.0.0', 'react-dom': '^19.0.0', zod: '^4.0.0' },
        },
        null,
        2,
      ) + '\n',
  }

  for (const [path, content] of Object.entries(files)) {
    const fullPath = join(target, path)
    await mkdir(join(fullPath, '..'), { recursive: true })
    await writeFile(fullPath, content)
  }

  const { intro, outro, note, spinner } = await import('@clack/prompts')
  intro(c.bgGreen(c.bold(' gazetta ')))

  note(
    `${c.bold('templates/')}          ${c.dim('4 templates (hero, nav, page-layout, text-block)')}\n` +
      `${c.bold('admin/')}              ${c.dim('custom editors and fields')}\n` +
      `${c.bold('sites/main/')}         ${c.dim('the site')}\n` +
      `  ${c.dim('site.config.ts')}    ${c.dim('site config + local target')}\n` +
      `  ${c.dim('targets/local/')}    ${c.dim('content served by gazetta dev')}\n` +
      `    ${c.dim('pages/home/')}       ${c.dim('home page with hero + intro')}\n` +
      `    ${c.dim('pages/404/')}        ${c.dim('error page')}\n` +
      `    ${c.dim('fragments/header/')} ${c.dim('shared header nav')}\n` +
      `${c.bold('package.json')}`,
    `Created ${c.green(name)}/`,
  )

  // Run npm install
  const s = spinner()
  s.start('Installing dependencies')
  try {
    const { execSync } = await import('node:child_process')
    execSync('npm install', { cwd: target, stdio: 'pipe' })
    s.stop('Dependencies installed')
  } catch (err) {
    // #1300: a failed install used to print "Done!" and exit 0, so a
    // newcomer (or the Stage 1 tutorial's CI check) ran `gazetta dev` in a
    // site with no dependencies. The files init wrote stay in place; show
    // npm's own error, say how to finish, and exit non-zero.
    s.stop('npm install failed')
    const e = err as { stdout?: unknown; stderr?: unknown }
    const npmOutput = [e.stdout, e.stderr]
      .filter(Boolean)
      .map(out => String(out).trim())
      .filter(Boolean)
      .join('\n')
    if (npmOutput) console.error(npmOutput)
    const retryStep = dir !== '.' ? `cd ${dir} && ` : ''
    outro(`Setup is incomplete. Finish it yourself: ${c.cyan(`${retryStep}npm install`)}`)
    process.exit(1)
  }

  const cdStep = dir !== '.' ? `cd ${dir} && ` : ''
  outro(`Done! Run: ${c.cyan(`${cdStep}npx gazetta dev`)}`)
}

async function runPublish(siteDir: string, targetName?: string, opts: { force?: boolean } = {}) {
  const projectRoot = detectProjectRoot(siteDir)
  const templatesDir = join(projectRoot, 'templates')

  // One target is the editing target itself: publishing would render the
  // site into its own source storage, reachable by no visitor (#1286).
  // Check before buildSourceContext so nothing is written, not even the
  // source target's initialized storage.
  const prePublishManifest = await loadSiteManifestForCli(siteDir)
  if (prePublishManifest?.targets && Object.keys(prePublishManifest.targets).length === 1) {
    console.error(`\n  Error: This site has one target, so there's nowhere to publish to.`)
    console.error(`  Add a target in site.config.ts: https://gazetta.studio/docs\n`)
    process.exit(1)
  }

  // Source comes from the default editable target in site.config.ts.
  const { buildSourceContext } = await import('./bootstrap.js')
  let source, manifest, targetConfigs
  try {
    ;({ source, manifest, targetConfigs } = await buildSourceContext({ projectSiteDir: siteDir }))
  } catch (err) {
    console.error(`\n  ${c.red('Error:')} ${(err as Error).message}\n`)
    process.exit(1)
  }
  const storage = source.storage
  const site = await loadSite({ contentRoot: source.contentRoot, templatesDir, manifest })

  const siteYaml = manifest
  if (!siteYaml.targets || Object.keys(siteYaml.targets).length === 0) {
    console.error(`\n  Error: no targets configured in site.config.ts`)
    process.exit(1)
  }

  // Determine which targets to publish to. Never the editing source: the
  // copy would write the site onto itself, and parallel copies read each
  // other's half-written temp files (#1526).
  const sourceTarget = source.targetName
  const targetNames = targetName ? [targetName] : Object.keys(siteYaml.targets).filter(name => name !== sourceTarget)
  for (const name of targetNames) {
    if (!siteYaml.targets[name]) {
      console.error(`\n  Error: Unknown target "${name}". Available: ${Object.keys(siteYaml.targets).join(', ')}\n`)
      process.exit(1)
    }
    if (name === sourceTarget) {
      console.error(`\n  Error: "${name}" is the editing source, so there's nothing to publish it from.`)
      console.error(`  Publish to another target.\n`)
      process.exit(1)
    }
  }

  // Initialize targets
  const { createTargetRegistry } = await import('../targets.js')
  const targets = await createTargetRegistry(Object.fromEntries(targetNames.map(n => [n, siteYaml.targets![n]])))

  // Per Cut 6 cutover + publish-undo cut 1 (#1426): the per-target
  // publish goes through the shared target-publish function (imported
  // at the use site), which runs publishRun's render loop (per-item
  // dispatch + asset publish + dep indices + site manifest) plus the
  // history record, manifest copy, generated files and CDN purge.
  // CLI keeps: incremental skip via compareTargets, locale fan-out
  // into ItemRefs, console output and exit codes.
  const { scanTemplates, reportTemplateErrors } = await import('../templates-scan.js')

  // Validate templates once for this publish run. publishRun consumes
  // templateInfos directly and computes hashes internally (per Cut 5
  // expansion); CLI only needs to scan + bail on invalid templates
  // before launching the run.
  const templateInfos = await scanTemplates(templatesDir, projectRoot)
  const invalid = reportTemplateErrors(templateInfos)
  if (invalid > 0) {
    console.error(`\n  ${c.red('✗')} Refusing to publish with invalid templates.`)
    process.exit(1)
  }

  console.log()
  console.log(`  ${c.bgGreen(c.bold(' gazetta '))} ${c.green('publish')} ${c.dim(site.manifest.name)}`)
  console.log()
  console.log(`  ${c.dim('┃')} Pages      ${c.dim([...site.pages.keys()].join(', '))}`)
  console.log(`  ${c.dim('┃')} Fragments  ${c.dim([...site.fragments.keys()].join(', '))}`)
  console.log(`  ${c.dim('┃')} Targets    ${targetNames.join(', ')}`)
  console.log()

  // Cutover (Cut 6 of publish-pipeline-extraction): per-target render
  // loop now delegates to `publishRun` for the per-target × per-item
  // dispatch + asset publish + dep indices + site manifest. CLI keeps
  // ownership of:
  //   - target registry init + per-target loop (so target-init failures
  //     can short-circuit just that target)
  //   - incremental skip via compareTargets (publishRun is filter-blind;
  //     CLI pre-filters ItemRefs[] based on per-locale unchanged sets)
  //   - locale fan-out (CLI expands page name → ItemRef[] including all
  //     locale variants supported by the target)
  //   - console output (onProgress callback formats human-readable lines;
  //     generated-file and purge lines are echoed from the shared
  //     function's result)
  //
  // publishRun owns: per-item mode dispatch, archive short-circuit,
  // sidecar emit, asset publish, dep indices, site manifest emit.

  let failedItems = 0
  const failedTargets: string[] = []
  const purgeReports: { name: string; outcome: import('../publish-target.js').PurgeOutcome }[] = []
  for (const name of targetNames) {
    const targetStorage = targets.get(name)
    if (!targetStorage) {
      console.error(`  ${name}: SKIPPED (failed to initialize)`)
      failedTargets.push(name)
      continue
    }

    const targetConfig = siteYaml.targets![name]
    const { getType } = await import('../types.js')
    const targetType = targetConfig ? getType(targetConfig) : 'static'
    console.log(`  ${c.bold(name)} ${c.dim(`(${targetType})`)}`)
    let totalFiles = 0
    let totalRemoved = 0

    // Incremental: compare source hashes against target sidecars, skip
    // items whose hash already matches the target. --force bypasses.
    const unchanged = new Set<string>()
    if (!opts.force) {
      const { compareTargets } = await import('../compare.js')
      const cmp = await compareTargets({
        sourceRoot: source.contentRoot,
        target: targetStorage,
        templatesDir,
        projectRoot,
        type: targetType,
        scanTemplates: async () => templateInfos,
        manifest,
      })
      for (const item of cmp.unchanged) unchanged.add(item)
    }
    let skipped = 0

    // Build the per-target ItemRef list. CLI does the locale fan-out
    // explicitly here (vs publishRun, which treats the input list
    // verbatim). Each (page|fragment, locale) cell becomes one ItemRef
    // unless the unchanged set covers it.
    const targetLocales = targetConfig?.locales
    const itemRefs: { kind: 'page' | 'fragment'; name: string; locale?: string }[] = []
    const skippedNames = new Set<string>() // for console output (item entirely skipped)

    // Pages — default + per-locale variants, filtered by target.locales when set.
    for (const [pageName] of site.pages) {
      const pageLocales = site.pageLocales.get(pageName)
      const localesForPage: (string | undefined)[] = [undefined]
      if (pageLocales) {
        for (const loc of pageLocales.locales.keys()) {
          if (targetLocales && !targetLocales.includes(loc)) continue
          localesForPage.push(loc)
        }
      }
      let added = 0
      for (const loc of localesForPage) {
        const key = loc ? `pages/${pageName}:${loc}` : `pages/${pageName}`
        if (unchanged.has(key)) continue
        itemRefs.push({ kind: 'page', name: pageName, locale: loc })
        added++
      }
      if (added === 0 && localesForPage.length > 0) {
        skippedNames.add(`pages/${pageName}`)
        skipped++
      }
    }

    // Fragments — only emitted as separate items for non-static targets
    // (static bakes them into pages). For static, the publishRun spine
    // still needs them in the site for page rendering (already loaded).
    if (targetType !== 'static') {
      for (const [fragName] of site.fragments) {
        const fragLocales = site.fragmentLocales.get(fragName)
        const localesForFrag: (string | undefined)[] = [undefined]
        if (fragLocales) {
          for (const loc of fragLocales.locales.keys()) {
            if (targetLocales && !targetLocales.includes(loc)) continue
            localesForFrag.push(loc)
          }
        }
        let added = 0
        for (const loc of localesForFrag) {
          const key = loc ? `fragments/${fragName}:${loc}` : `fragments/${fragName}`
          if (unchanged.has(key)) continue
          itemRefs.push({ kind: 'fragment', name: fragName, locale: loc })
          added++
        }
        if (added === 0 && localesForFrag.length > 0) {
          skippedNames.add(`fragments/${fragName}`)
          skipped++
        }
      }
    }

    // Cutover (publish-undo cut 1, #1426): the approval-gate place,
    // history record (#1079), source manifest copy, render loop,
    // sitemap/robots/redirects, publish generation and CDN purge all
    // run inside the shared target-publish function; the CLI keeps
    // target iteration, incremental filtering, the locale fan-out
    // above, console output and the exit code. The manifest copy is
    // per item DIRECTORY (bare item strings), the same whole-folder
    // publishItems step publishRun's step 13b ran.
    const sharedItems = [...new Set(itemRefs.map(ref => `${ref.kind === 'page' ? 'pages' : 'fragments'}/${ref.name}`))]
    const { publishToTarget } = await import('../publish-target.js')
    const shared = await publishToTarget({
      targetName: name,
      targetStorage,
      targetConfig,
      sourceRoot: source.contentRoot,
      sourceName: source.targetName,
      site,
      siteManifest: manifest,
      items: sharedItems,
      itemRefs,
      templateInfos,
      purgeScope: 'all',
      onProgress: ev => {
        if (ev.kind === 'item-done') {
          if (ev.result.ok) {
            const label = ev.result.kind === 'fragment' ? `@${ev.result.name}` : ev.result.name
            const localeMark = ev.result.locale ? c.dim(` (${ev.result.locale})`) : ''
            console.log(`    ${c.green('✓')} ${label}${localeMark}`)
          } else {
            const label = ev.result.kind === 'fragment' ? `@${ev.result.name}` : ev.result.name
            console.error(`    ${c.red('✗')} ${label}: ${ev.result.code}`)
            failedItems++
          }
        }
      },
      onHistoryError: message => {
        console.warn(`publishRun: history record failed for ${name}: ${message}`)
      },
    })

    // Aggregate counts: the shared function's manifest copy plus
    // publishRun's per-target render result.
    totalFiles += shared.copiedFiles
    const tr = shared.run
    if (tr) {
      totalFiles += tr.filesWritten
      totalRemoved += tr.filesRemoved
      if (tr.failed) {
        console.error(`    ${c.red('✗')} target failed: ${tr.failureReason ?? 'all items failed'}`)
        failedTargets.push(name)
      }
    }
    purgeReports.push({ name, outcome: shared.purge })

    if (skipped > 0) console.log(`    ${c.dim(`· ${skipped} unchanged (skipped)`)}`)

    // Sitemap, robots.txt, host-format redirects, the publish
    // generation and the CDN purge ran inside the shared target-publish
    // function (#1426). Echo the files it wrote in the CLI's own lines
    // and keep the per-target count identical (one per generated file).
    for (const file of shared.generatedFiles) {
      totalFiles++
      console.log(`    ${c.dim(`· ${file}`)}`)
    }

    const removedMsg = totalRemoved > 0 ? c.dim(` (${totalRemoved} old files cleaned)`) : ''
    console.log(`\n  ${c.green('✓')} ${c.bold(name)}: ${totalFiles} files published${removedMsg}\n`)
  }

  // CDN purge outcomes, one line per target after the loop as before.
  // The purge itself ran inside the shared function (#1426); the CLI
  // keeps its own wording.
  for (const { name, outcome } of purgeReports) {
    if (outcome.kind === 'purged-all') {
      console.log(`  ${name}: cache purged`)
    } else if (outcome.kind === 'skipped-no-token') {
      console.log(`  ${name}: purge.apiToken not set, skipping cache purge`)
    } else if (outcome.kind === 'skipped-no-zone') {
      console.log(`  ${name}: zone not found, set purge.zoneId or siteUrl`)
    } else if (outcome.kind === 'failed') {
      console.warn(`  ${name}: cache purge failed: ${outcome.message}`)
    }
  }

  // Non-zero exit when anything failed, so CI publish steps go red
  // (cli.md "Exit Codes"). exitCode, not exit(): let pending output flush.
  if (failedItems > 0 || failedTargets.length > 0) {
    const parts: string[] = []
    if (failedItems > 0) parts.push(`${failedItems} failed`)
    if (failedTargets.length > 0) parts.push(`target(s) failed: ${failedTargets.join(', ')}`)
    console.error(`  ${c.red('Publish incomplete')} — ${parts.join('; ')}\n`)
    process.exitCode = 1
    return
  }

  console.log(`  Done!\n`)
}

async function runBuild(siteDir: string) {
  const projectRoot = detectProjectRoot(siteDir)
  const outDir = join(projectRoot, 'dist', 'admin')

  console.log()
  console.log(`  ${c.bgGreen(c.bold(' gazetta '))} ${c.green('build')}`)
  console.log()

  // Find the admin source (monorepo) or pre-built admin (npm package)
  const cmsWebDir = findCmsDir()
  const cmsStaticDir = findCmsStaticDir()

  if (cmsWebDir) {
    // Monorepo — build from source via Vite
    console.log(`  ${c.dim('┃')} Admin source  ${c.dim(cmsWebDir)}`)
    console.log(`  ${c.dim('┃')} Output        ${c.dim(outDir)}`)
    console.log()

    const { build } = await import('vite')
    await build({
      configFile: join(cmsWebDir, 'vite.config.ts'),
      root: cmsWebDir,
      base: '/admin/',
      build: {
        outDir,
        emptyOutDir: true,
        chunkSizeWarningLimit: 2000,
        // Vite 8: rollupOptions renamed to rolldownOptions, and manualChunks only
        // accepts the function form (Rolldown doesn't support the object record form).
        rolldownOptions: {
          output: {
            manualChunks(id: string) {
              if (id.includes('node_modules/react/') || id.includes('node_modules/react-dom/')) return 'vendor-react'
              if (id.includes('node_modules/@rjsf/') || id.includes('node_modules/@hello-pangea/dnd'))
                return 'vendor-editor'
              if (id.includes('node_modules/@tiptap/')) return 'vendor-tiptap'
              return undefined
            },
          },
          onwarn(warning, defaultHandler) {
            const code = (warning as { code?: string }).code
            const message = (warning as { message?: string }).message
            if (code === 'MODULE_LEVEL_DIRECTIVE') return
            if (code === 'PLUGIN_WARNING' && message?.includes('dynamically imported')) return
            defaultHandler(warning)
          },
        },
      },
      logLevel: 'warn',
    })

    console.log(`  ${c.green('✓')} Admin UI built to ${c.dim(outDir)}`)
  } else if (cmsStaticDir) {
    // npm package — copy pre-built admin
    const { cp } = await import('node:fs/promises')
    const { mkdir } = await import('node:fs/promises')
    await mkdir(outDir, { recursive: true })
    await cp(cmsStaticDir, outDir, { recursive: true })
    console.log(`  ${c.green('✓')} Admin UI copied to ${c.dim(outDir)}`)
  } else {
    console.error(`  ${c.red('Error:')} admin UI source not found`)
    console.error(`  ${c.dim('Run from monorepo or install gazetta from npm')}`)
    process.exit(1)
  }

  // Bundle custom editors and fields with esbuild + shared import map
  const adminDir = join(projectRoot, 'admin')
  const editorsDir = join(adminDir, 'editors')
  const fieldsDir = join(adminDir, 'fields')

  const entryExtensions = ['.ts', '.tsx', '.jsx']
  const hasEditors =
    existsSync(editorsDir) &&
    (await import('node:fs')).readdirSync(editorsDir).some(f => entryExtensions.some(ext => f.endsWith(ext)))
  const hasFields =
    existsSync(fieldsDir) &&
    (await import('node:fs')).readdirSync(fieldsDir).some(f => entryExtensions.some(ext => f.endsWith(ext)))

  if (hasEditors || hasFields) {
    const { build: esbuild } = await import('esbuild')
    const { writeFile: writeFileAsync, mkdir: mkdirAsync } = await import('node:fs/promises')
    const sharedDir = join(outDir, '_shared')
    await mkdirAsync(sharedDir, { recursive: true })

    // Build shared dependency bundles (one copy of React, etc.)
    const sharedDeps: Record<string, string> = {
      react: 'export * from "react"; import React from "react"; export default React;',
      'react-dom/client': 'export * from "react-dom/client";',
      'react/jsx-runtime': 'export * from "react/jsx-runtime";',
      'gazetta/editor': 'export * from "gazetta/editor";',
      'gazetta/types': 'export * from "gazetta/types";',
    }

    const importMap: Record<string, string> = {}
    for (const [specifier, stub] of Object.entries(sharedDeps)) {
      const safeName = specifier.replace(/\//g, '_')
      const stubFile = join(sharedDir, `_stub_${safeName}.js`)
      await writeFileAsync(stubFile, stub)
      const outfile = join(sharedDir, `${safeName}.js`)
      try {
        await esbuild({
          entryPoints: [stubFile],
          outfile,
          bundle: true,
          format: 'esm',
          platform: 'browser',
          target: 'es2022',
          minify: true,
          define: { 'process.env.NODE_ENV': '"production"' },
          logLevel: 'warning',
        })
        importMap[specifier] = `/admin/_shared/${safeName}.js`
      } catch {
        /* skip — dep may not be installed */
      }
      await import('node:fs/promises').then(fs => fs.rm(stubFile, { force: true }))
    }

    console.log(`  ${c.green('✓')} Shared deps: ${Object.keys(importMap).join(', ')}`)

    // Bundle each custom editor/field with shared deps externalized
    const externals = Object.keys(importMap)
    let bundledCount = 0

    for (const [kind, srcDir] of [
      ['editors', editorsDir],
      ['fields', fieldsDir],
    ] as const) {
      if (!existsSync(srcDir)) continue
      const { readdirSync } = await import('node:fs')
      const files = readdirSync(srcDir).filter(
        f => entryExtensions.some(ext => f.endsWith(ext)) && !f.startsWith('.') && !f.startsWith('_'),
      )

      for (const file of files) {
        const name = file.replace(/\.(ts|tsx|jsx)$/, '')
        const entryPoint = join(srcDir, file)
        const outfile = join(outDir, kind, `${name}.js`)
        await esbuild({
          entryPoints: [entryPoint],
          outfile,
          bundle: true,
          format: 'esm',
          platform: 'browser',
          target: 'es2022',
          minify: true,
          external: externals,
          define: { 'process.env.NODE_ENV': '"production"' },
          logLevel: 'warning',
        })
        bundledCount++
        console.log(`  ${c.green('✓')} ${kind}/${name}.js`)
      }
    }

    // Inject import map into index.html
    const indexPath = join(outDir, 'index.html')
    if (existsSync(indexPath)) {
      let html = readFileSync(indexPath, 'utf-8')
      const mapScript = `<script type="importmap">\n${JSON.stringify({ imports: importMap }, null, 2)}\n</script>`
      html = html.replace('<head>', `<head>\n${mapScript}`)
      await writeFileAsync(indexPath, html)
      console.log(`  ${c.green('✓')} Import map injected into index.html`)
    }

    console.log(`\n  ${bundledCount} custom ${bundledCount === 1 ? 'module' : 'modules'} bundled`)
  }

  console.log()
}

async function runAdmin(siteDir: string, port: number, hostFlag?: string) {
  const projectRoot = detectProjectRoot(siteDir)
  const templatesDir = join(projectRoot, 'templates')
  const adminDir = join(projectRoot, 'admin')
  const builtAdminDir = join(projectRoot, 'dist', 'admin')

  if (!existsSync(join(builtAdminDir, 'index.html'))) {
    console.error(`\n  ${c.red('Error:')} admin UI not built`)
    console.error(`  Run ${c.cyan('gazetta build')} first\n`)
    process.exit(1)
  }

  const app = new Hono()
  app.get('/__reload', ctx => ctx.body(null, 204))

  const { buildSourceContext } = await import('./bootstrap.js')
  const { source, targetConfigs } = await buildSourceContext({ projectSiteDir: siteDir })
  const manifest = await loadSiteManifestForCli(siteDir)
  const hookContributions = readHookContributions(manifest)
  await setupProductionMode(
    app,
    source,
    siteDir,
    builtAdminDir,
    templatesDir,
    adminDir,
    targetConfigs,
    hookContributions,
    manifest,
    // #1305: no site is loaded at admin boot, so defer the capability
    // warning to the first request that loads one.
    'defer',
  )

  // SPA fallback for non-API admin routes
  app.get('*', ctx => {
    const indexPath = join(builtAdminDir, 'index.html')
    if (existsSync(indexPath)) return ctx.html(readFileSync(indexPath, 'utf-8'))
    return ctx.notFound()
  })

  const siteManifest = (await loadSiteManifestForCli(siteDir)) ?? ({ name: 'gazetta' } as SiteManifest)

  const server = serve(
    { fetch: app.fetch, port, hostname: resolveListenHost('admin', hostFlag, authTrustOf(siteManifest.admin?.auth)) },
    () => {
      console.log()
      console.log(`  ${c.bgGreen(c.bold(' gazetta '))} ${c.green('admin')} ${c.dim(siteManifest.name)}`)
      console.log()
      console.log(`  ${c.dim('┃')} Admin    ${c.cyan(`http://localhost:${port}/admin`)}`)
      console.log()
    },
  )
  exitOnListenError(server, port)

  for (const signal of ['SIGINT', 'SIGTERM'] as const) {
    process.on(signal, () => {
      console.log(`\n  Shutting down...`)
      server.close(() => process.exit(0))
    })
  }
}

async function runServe(siteDir: string, port: number, targetName?: string, hostFlag?: string) {
  const siteYaml = await loadSiteManifestForCli(siteDir)
  if (!siteYaml) {
    console.error(`\n  Error: no site config found in ${siteDir} (looked for site.config.ts)\n`)
    process.exit(1)
  }
  if (!siteYaml.targets || Object.keys(siteYaml.targets).length === 0) {
    console.error('\n  Error: no targets configured in site config\n')
    process.exit(1)
  }

  const name = targetName ?? Object.keys(siteYaml.targets)[0]
  const config = siteYaml.targets[name]
  if (!config) {
    console.error(`\n  Error: target "${name}" not found in site config\n`)
    process.exit(1)
  }

  // Storage is already a constructed provider (Path X — operator-facing
  // factory ran at config-eval).
  const storage = config.storage
  const { getType } = await import('../types.js')
  const { createServer, serveLocaleOptions } = await import('../serve.js')
  const app = createServer({ storage, type: getType(config), ...serveLocaleOptions(siteYaml) })

  const server = serve({ fetch: app.fetch, port, hostname: resolveListenHost('serve', hostFlag) }, () => {
    console.log()
    console.log(`  ${c.bgGreen(c.bold(' gazetta '))} ${c.green('serve')} ${c.dim(siteYaml.name)} ${c.dim(`(${name})`)}`)
    console.log()
    console.log(`  ${c.dim('┃')} Local    ${c.cyan(`http://localhost:${port}/`)}`)
    console.log()
  })
  exitOnListenError(server, port)

  for (const signal of ['SIGINT', 'SIGTERM'] as const) {
    process.on(signal, () => {
      console.log(`\n  Shutting down...`)
      server.close(() => process.exit(0))
    })
  }
}

async function runDeploy(siteDir: string, targetName?: string) {
  const siteYaml = await loadSiteManifestForCli(siteDir)
  if (!siteYaml) {
    console.error(`\n  Error: no site config found at ${siteDir} (looked for site.config.ts)\n`)
    process.exit(1)
  }
  if (!siteYaml.targets) {
    console.error(`\n  Error: No targets configured in site config\n`)
    process.exit(1)
  }
  if (!targetName) {
    console.error(`\n  ${c.red('Error:')} target is required for deploy\n  Usage: gazetta deploy <target-name>\n`)
    process.exit(1)
  }
  const target = siteYaml.targets[targetName]
  if (!target) {
    console.error(`\n  Error: Unknown target "${targetName}". Available: ${Object.keys(siteYaml.targets).join(', ')}\n`)
    process.exit(1)
  }
  if (!target.deploy) {
    console.error(
      `\n  Error: Target "${targetName}" has no \`deploy:\` adapter configured. Add to site.config.ts:\n\n  ` +
        `import { cloudflareWorkersDeploy } from 'gazetta'\n  ` +
        `deploy: cloudflareWorkersDeploy({\n  ` +
        `  apiToken: process.env.CLOUDFLARE_API_TOKEN!,\n  ` +
        `  accountId: process.env.CLOUDFLARE_ACCOUNT_ID!,\n  ` +
        `  name: '${targetName}',\n  ` +
        `  bucket: '${targetName}',\n  })\n\n` +
        `For container hosts (Fly.io, Cloud Run, Railway, Render), use platform-native\n` +
        `deploy tooling; see docs/container-deployment.md.\n`,
    )
    process.exit(1)
  }

  const adapter = target.deploy
  console.log(`  ${c.cyan(`Deploying via ${adapter.name}...`)}`)

  // Build a no-op logger; v1 deploy doesn't require structured logging yet.
  const logger = {
    debug: (_o: object | string, _m?: string) => {},
    info: (_o: object | string, _m?: string) => {},
    warn: (o: object | string, m?: string) => console.warn(`  ${typeof o === 'string' ? o : (m ?? '')}`),
    error: (o: object | string, m?: string) => console.error(`  ${typeof o === 'string' ? o : (m ?? '')}`),
  }

  try {
    const result = await adapter.execute({
      target,
      targetName,
      site: siteYaml,
      // outputDir not used by worker-deploy adapters (worker reads R2 at request).
      // Adapters that need bytes (static-host) read storage themselves.
      outputDir: join(siteDir, 'dist', targetName),
      storage: target.storage,
      env: process.env,
      logger,
      signal: new AbortController().signal,
    })

    if (result.url) console.log(`  ${c.green('✓')} Deployed: ${result.url}`)
    else console.log(`  ${c.green('✓')} Deployed.`)
    if (target.siteUrl) console.log(`  Site: ${target.siteUrl}`)
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    const adapterTag = (err as { adapter?: string }).adapter ?? adapter.name
    console.error(`\n  ${c.red(`Deploy failed (${adapterTag}):`)} ${message}\n`)
    process.exit(1)
  }

  console.log(
    `\n  ${c.green('✓')} Deploy complete. Publish content with:\n    ${c.cyan(`gazetta publish ${targetName}`)}\n`,
  )
}

const QUALITY_VALIDATORS = new Set(['accessibility', 'html-validity', 'broken-links'])

async function runValidate(siteDir: string, rawArgs: readonly string[] = []) {
  const projectRoot = detectProjectRoot(siteDir)
  const templatesDir = join(projectRoot, 'templates')
  const opts = parseValidateFlags(rawArgs)

  console.log()
  console.log(`  ${c.bgGreen(c.bold(' gazetta '))} ${c.green('validate')} ${c.dim(siteDir)}`)
  console.log()

  // 1. Load site
  const configLabel = existsSync(join(siteDir, 'site.config.ts'))
    ? 'site.config.ts'
    : existsSync(join(siteDir, 'site.config.js'))
      ? 'site.config.js'
      : 'site.config.mjs'
  const { buildSourceContext } = await import('./bootstrap.js')
  let site: Awaited<ReturnType<typeof loadSite>>
  let source: Awaited<ReturnType<typeof buildSourceContext>>['source']
  try {
    const built = await buildSourceContext({ projectSiteDir: siteDir })
    source = built.source
    site = await loadSite({ contentRoot: source.contentRoot, templatesDir, manifest: built.manifest })
    console.log(`  ${c.green('✓')} ${configLabel} ${c.dim(`— ${site.manifest.name}`)}`)
  } catch (err) {
    console.error(`  ${c.red('✗')} ${configLabel} ${c.dim(`— ${(err as Error).message}`)}`)
    process.exit(1)
  }

  // 2. Build the registry. Skip quality validators (a11y, html-validity)
  //    unless `--include-quality` — they trigger rendering and add seconds
  //    per page; default keeps the CLI snappy for CI ref-existence gating.
  const { defaultValidatorRegistry } = await import('../validation/default-registry.js')
  const { createValidatorRegistry } = await import('../validation/registry.js')
  const fullRegistry = defaultValidatorRegistry()
  const filtered = opts.includeQuality
    ? fullRegistry
    : createValidatorRegistry(fullRegistry.all().filter(v => !QUALITY_VALIDATORS.has(v.name)))

  // 3. Run via the scanner — same orchestrator as the admin background scan,
  //    so the CLI exercises identical code paths.
  const { createValidationScanner } = await import('../validation/scanner.js')
  const { createMemoryCache } = await import('../cache/memory.js')
  const scanner = createValidationScanner({
    storage: source.storage,
    contentRoot: source.contentRoot,
    registry: filtered,
    cache: createMemoryCache(),
    siteOptions: { templatesDir, manifest: site.manifest },
    loadSiteImpl: async () => site,
  })
  await scanner.scanAll()
  // Site-config validators (targets, deploy adapters) check the whole config
  // once rather than per item, so the scanner never runs them.
  const configIssues: Issue[] = []
  for (const validator of filtered.forStage('cli')) {
    if (validator.stages.includes('background')) continue
    configIssues.push(
      ...(await validator.validate({
        stage: 'cli',
        site,
        contentRoot: source.contentRoot,
        storage: source.storage,
        scope: { kind: 'cli' },
      })),
    )
  }
  const allIssues = [...scanner.allIssues(), ...configIssues]

  // 4. Per-item summary. Pages first, then fragments — matches the existing
  //    output ordering for unsurprising diff vs. the prior implementation.
  let errorCount = 0
  let warnCount = 0
  let infoCount = 0
  type IssueOf<T> = T extends ReadonlyArray<infer U> ? U : never
  const issuesByPath = new Map<string, Array<IssueOf<typeof allIssues>>>()
  for (const issue of allIssues) {
    const list = issuesByPath.get(issue.itemPath) ?? []
    list.push(issue)
    issuesByPath.set(issue.itemPath, list)
    if (issue.severity === 'error') errorCount++
    else if (issue.severity === 'warn') warnCount++
    else infoCount++
  }

  function summaryGlyph(issues: readonly { severity: string }[]): { glyph: string; color: (s: string) => string } {
    if (issues.some(i => i.severity === 'error')) return { glyph: '✗', color: c.red }
    if (issues.some(i => i.severity === 'warn')) return { glyph: '⚠', color: c.yellow }
    if (issues.length > 0) return { glyph: 'ⓘ', color: c.cyan }
    return { glyph: '✓', color: c.green }
  }

  function shouldShow(severity: 'error' | 'warn' | 'info'): boolean {
    if (opts.severity === 'all') return true
    if (opts.severity === 'warn') return severity !== 'info'
    return severity === 'error'
  }

  // Config issues are about the site's setup, so like the project-structure
  // checks below they show whatever `--severity` is; info never fails.
  for (const issue of configIssues) {
    console.log(`  ${severityIcon(issue.severity)} ${issue.message}`)
  }

  for (const [pageName, page] of site.pages) {
    const path = `${page.dir}/page.json`
    const issues = issuesByPath.get(path) ?? []
    const visible = issues.filter(i => shouldShow(i.severity))
    const { glyph, color } = summaryGlyph(visible)
    const componentCount = page.components?.length ?? 0
    console.log(`  ${color(glyph)} ${pageName} ${c.dim(`(${componentCount} components)`)}`)
    if (opts.verbose) {
      for (const issue of visible) {
        console.log(`      ${severityIcon(issue.severity)} ${issue.message}`)
      }
    }
  }

  for (const [fragName, frag] of site.fragments) {
    const path = `${frag.dir}/fragment.json`
    const issues = issuesByPath.get(path) ?? []
    const visible = issues.filter(i => shouldShow(i.severity))
    const { glyph, color } = summaryGlyph(visible)
    const childCount = frag.components?.length ?? 0
    console.log(`  ${color(glyph)} @${fragName} ${c.dim(`(${childCount} components)`)}`)
    if (opts.verbose) {
      for (const issue of visible) {
        console.log(`      ${severityIcon(issue.severity)} ${issue.message}`)
      }
    }
  }

  // 5. Project-structure checks (orphaned editors, missing custom fields).
  //    These are project-layout concerns rather than per-item content rules,
  //    so they don't fit the Validator interface — kept inline here.
  const adminDir = join(projectRoot, 'admin')
  const projectStorage = createFilesystemProvider()
  let templateNames: string[] = []
  try {
    const entries = await projectStorage.readDir(templatesDir)
    templateNames = entries.filter(e => e.isDirectory).map(e => e.name)
  } catch {
    /* templates dir missing — site already errored above */
  }

  // 5a. Orphaned editors: editor file exists but no matching template.
  //     Always shown regardless of --severity since these are structural
  //     issues operators need to know about even at the strictest filter.
  const editorsDir = join(adminDir, 'editors')
  if (existsSync(editorsDir)) {
    const fs = await import('node:fs')
    const editorFiles = fs.readdirSync(editorsDir).filter(f => f.endsWith('.ts') || f.endsWith('.tsx'))
    for (const file of editorFiles) {
      const editorName = file.replace(/\.(ts|tsx)$/, '')
      if (!templateNames.includes(editorName)) {
        console.log(
          `  ${c.yellow('⚠')} orphaned editor: ${c.dim(`admin/editors/${file}`)} ${c.dim('— no matching template')}`,
        )
        warnCount++
      }
    }
  }

  // 5b. Missing custom fields: schema references field: 'name' but no
  //     admin/fields/name.{ts,tsx}. Hard error — render fails without it.
  const fieldsDir = join(adminDir, 'fields')
  const fieldFiles = existsSync(fieldsDir)
    ? (await import('node:fs'))
        .readdirSync(fieldsDir)
        .filter(f => f.endsWith('.ts') || f.endsWith('.tsx'))
        .map(f => f.replace(/\.(ts|tsx)$/, ''))
    : []
  if (templateNames.length > 0) {
    const { loadTemplate } = await import('../template-loader.js')
    const zod = await import('zod')
    for (const tplName of templateNames) {
      try {
        const loaded = await loadTemplate(projectStorage, templatesDir, tplName)
        const jsonSchema = zod.z.toJSONSchema(loaded.schema as import('zod').ZodType) as Record<string, unknown>
        const props = jsonSchema.properties as Record<string, Record<string, unknown>> | undefined
        if (!props) continue
        for (const [propName, prop] of Object.entries(props)) {
          const fieldRef = prop.field as string | undefined
          if (fieldRef && !fieldFiles.includes(fieldRef)) {
            console.error(
              `  ${c.red('✗')} template ${tplName}.${propName} references field "${fieldRef}" ${c.dim('— not found in admin/fields/')}`,
            )
            errorCount++
          }
        }
      } catch {
        /* template load errors surface via referenced-template-exists */
      }
    }
  }

  // 6. Footer + exit code.
  console.log()
  const totalShown =
    opts.severity === 'all'
      ? errorCount + warnCount + infoCount
      : opts.severity === 'warn'
        ? errorCount + warnCount
        : errorCount
  if (totalShown === 0) {
    console.log(`  ${c.green('All good.')}\n`)
    return
  }

  const parts: string[] = []
  if (errorCount > 0) parts.push(`${errorCount} error${errorCount > 1 ? 's' : ''}`)
  if (warnCount > 0 && opts.severity !== 'error') parts.push(`${warnCount} warning${warnCount > 1 ? 's' : ''}`)
  if (infoCount > 0 && opts.severity === 'all') parts.push(`${infoCount} info`)
  const summary = parts.join(', ')
  console.log(`  ${summary}.\n`)

  // Exit non-zero if errors OR (warns AND warn-as-error is on).
  const fail = errorCount > 0 || (opts.warnAsError && warnCount > 0)
  if (fail) process.exit(1)
}

function severityIcon(severity: 'error' | 'warn' | 'info'): string {
  if (severity === 'error') return c.red('✗')
  if (severity === 'warn') return c.yellow('⚠')
  return c.cyan('ⓘ')
}

function renderErrorOverlay(err: Error): string {
  const message = err.message.replace(/</g, '&lt;').replace(/>/g, '&gt;')
  const stack = (err.stack ?? '').replace(/</g, '&lt;').replace(/>/g, '&gt;')

  // Extract file path from error message or stack
  const fileMatch = stack.match(/\(?(\/[^\s:)]+):(\d+)/)
  const filePath = fileMatch ? fileMatch[1] : ''
  const lineNum = fileMatch ? fileMatch[2] : ''
  const location = filePath ? `${filePath}${lineNum ? `:${lineNum}` : ''}` : ''

  return `<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8">
  <title>Error — Gazetta</title>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body { font-family: system-ui, -apple-system, sans-serif; background: #1a1a2e; color: #e4e4e7; min-height: 100vh; display: flex; align-items: center; justify-content: center; }
    .overlay { max-width: 48rem; width: 100%; margin: 2rem; }
    .header { display: flex; align-items: center; gap: 0.75rem; margin-bottom: 1.5rem; }
    .header svg { flex-shrink: 0; }
    .header h1 { font-size: 1.25rem; font-weight: 600; color: #f87171; }
    .message { background: #0f0f1a; border: 1px solid #27272a; border-radius: 8px; padding: 1.5rem; margin-bottom: 1rem; font-family: 'JetBrains Mono', 'Fira Code', monospace; font-size: 0.875rem; line-height: 1.7; white-space: pre-wrap; word-break: break-word; color: #fca5a5; }
    .location { font-size: 0.8125rem; color: #71717a; margin-bottom: 1rem; }
    .location span { color: #a78bfa; }
    .stack { background: #0f0f1a; border: 1px solid #27272a; border-radius: 8px; padding: 1.5rem; font-family: 'JetBrains Mono', 'Fira Code', monospace; font-size: 0.75rem; line-height: 1.7; white-space: pre-wrap; word-break: break-word; color: #52525b; max-height: 20rem; overflow: auto; }
    .hint { margin-top: 1.5rem; font-size: 0.8125rem; color: #52525b; }
  </style>
</head>
<body>
  <div class="overlay">
    <div class="header">
      <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="#f87171" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/></svg>
      <h1>Template Error</h1>
    </div>
    ${location ? `<div class="location">File: <span>${location}</span></div>` : ''}
    <div class="message">${message}</div>
    <details>
      <summary style="color:#52525b;font-size:0.8125rem;cursor:pointer;margin-bottom:0.5rem">Stack trace</summary>
      <div class="stack">${stack}</div>
    </details>
    <div class="hint">Fix the error and save — the page will reload automatically.</div>
  </div>
  <script>new EventSource('/__reload').onmessage = () => location.reload()</script>
</body>
</html>`
}

async function runDev(siteDir: string, port: number, hostFlag?: string) {
  const projectRoot = detectProjectRoot(siteDir)
  const templatesDir = join(projectRoot, 'templates')
  const adminDir = join(projectRoot, 'admin')

  // Build the source context from the default editable target in site.config.ts.
  // Cloud targets aren't init'd — admin API handles them lazily.
  const { buildSourceContext } = await import('./bootstrap.js')
  const { source, manifest, targetConfigs } = await buildSourceContext({ projectSiteDir: siteDir })
  const site = await loadSite({ contentRoot: source.contentRoot, templatesDir, manifest })
  const storage = source.storage

  // #1305: the boot capability-gap warning fires only once the site has
  // an archived page. The boot load above already walked the content, so
  // the flag costs nothing extra.
  const anyArchived = [...site.pages.values()].some(page => isArchived(page))

  // Live config state, swapped in place when site.config.ts changes on disk
  // (#1353). Request-time handlers read through `live` so an edit takes
  // effect without a restart; boot-time route registration keeps the
  // initial values.
  const live: { source: typeof source; manifest: typeof manifest; targetConfigs: typeof targetConfigs } = {
    source,
    manifest,
    targetConfigs,
  }

  const app = new Hono()

  // ---- Live reload (SSE) ----
  let reloadId = 0
  const reloadListeners = new Set<() => void>()
  function notifyReload() {
    reloadId++
    for (const l of reloadListeners) l()
  }

  const RELOAD_SCRIPT = `<script>new EventSource('/__reload').onmessage = () => location.reload()</script>`

  app.get('/__reload', c => {
    return streamSSE(c, async stream => {
      let lastId = reloadId
      const check = async () => {
        if (reloadId !== lastId) {
          lastId = reloadId
          await stream.writeSSE({ data: 'reload', event: 'message' })
        }
      }
      reloadListeners.add(check)
      stream.onAbort(() => {
        reloadListeners.delete(check)
      })
      while (true) {
        await stream.sleep(500)
        await check()
      }
    })
  })

  // ---- Trailing slash normalization ----
  // Strip trailing slashes so /fr/ resolves as /fr and /fr/about/ as
  // /fr/about. Re-dispatches through the Hono router with the clean URL.
  // No redirect — preserves POST body and avoids round-trips.
  app.use(async (c, next) => {
    const url = new URL(c.req.url)
    if (url.pathname !== '/' && url.pathname.endsWith('/')) {
      url.pathname = url.pathname.slice(0, -1)
      // Copy the fields across instead of passing c.req.raw as the init:
      // @hono/node-server's request isn't a native Request, and Node 26's
      // fetch throws reading its `duplex` getter ("Illegal invocation").
      const raw = c.req.raw
      const init: RequestInit & { duplex?: 'half' } = { method: raw.method, headers: raw.headers, signal: raw.signal }
      if (raw.body) {
        init.body = raw.body
        init.duplex = 'half'
      }
      return app.fetch(new Request(url, init), c.env)
    }
    return next()
  })

  // ---- Asset serve route ----
  // Serves /assets/* from the active source target's storage. Matches the
  // URL pattern emitted by the asset resolver, so templates rendering
  // <img src="/assets/hero-a3b2c1d4.jpg"> load from here in dev.
  const { assetServeRoutes } = await import('../assets/serve-route.js')
  app.route(
    '/',
    assetServeRoutes(async () => live.source.storage),
  )

  // ---- Site page routes (default + locale variants) ----
  const { allPageEntries } = await import('../site-loader.js')
  const { defaultLocaleFor: _devDefaultLocaleFor } = await import('../locale.js')
  for (const { name: pageName, page, locale: pageLocale } of allPageEntries(site)) {
    app.get(page.route, async c => {
      try {
        const freshSite = await loadSite({
          contentRoot: live.source.contentRoot,
          templatesDir,
          manifest: live.manifest,
        })
        const resolved = await resolvePage(pageName, freshSite, pageLocale)
        const freshPage = pageLocale
          ? freshSite.pageLocales.get(pageName)?.locales.get(pageLocale)
          : freshSite.pages.get(pageName)
        const html = await renderPage(resolved, {
          routeParams: c.req.param(),
          metadata: freshPage?.metadata ?? page.metadata,
          route: freshPage?.route ?? page.route,
          seo: {
            siteName: freshSite.manifest.name,
            locale: pageLocale ?? _devDefaultLocaleFor(freshSite.manifest),
            defaultOgImage: freshSite.manifest.defaultOgImage,
          },
        })
        return c.html(html.replace('</body>', `${RELOAD_SCRIPT}\n</body>`))
      } catch (err) {
        return c.html(renderErrorOverlay(err as Error), 500)
      }
    })
  }

  // ---- Locale fallback routes for pages without locale variants ----
  // When a page exists in the default locale but has no page.fr.json,
  // register /fr{route} that renders the default content with FR locale context.
  // This prevents 404s on locale-prefixed URLs for untranslated pages.
  const { resolveSiteLocales } = await import('../locale.js')
  const resolvedLocales = resolveSiteLocales(manifest)
  if (resolvedLocales) {
    const nonDefaultLocales = resolvedLocales.supported.filter(l => l !== resolvedLocales.default)
    for (const loc of nonDefaultLocales) {
      for (const [pageName, page] of site.pages) {
        const hasLocaleVariant = site.pageLocales.get(pageName)?.locales.has(loc)
        if (hasLocaleVariant) continue // already registered by allPageEntries
        const localeRoute = `/${loc}${page.route === '/' ? '' : page.route}`
        app.get(localeRoute, async c => {
          try {
            const freshSite = await loadSite({
              contentRoot: live.source.contentRoot,
              templatesDir,
              manifest: live.manifest,
            })
            const resolved = await resolvePage(pageName, freshSite, loc)
            const freshPage = freshSite.pages.get(pageName)
            const html = await renderPage(resolved, {
              routeParams: c.req.param(),
              metadata: freshPage?.metadata,
              route: freshPage?.route,
              seo: {
                siteName: freshSite.manifest.name,
                locale: loc,
                defaultOgImage: freshSite.manifest.defaultOgImage,
              },
            })
            return c.html(html.replace('</body>', `${RELOAD_SCRIPT}\n</body>`))
          } catch (err) {
            return c.html(renderErrorOverlay(err as Error), 500)
          }
        })
      }
    }
  }

  // ---- Detect mode: dev (monorepo with apps/admin source) vs production (pre-built) ----
  const cmsWebDir = findCmsDir()
  const cmsStaticDir = findCmsStaticDir()
  const isDevMode = cmsWebDir !== null

  // Admin Hono instance — captured so the template file watcher can
  // invalidate its memoized template-scan cache on .ts/.tsx changes.
  // `rescanForTemplate` is optional: only the dev-mode setup decorates
  // it (production has no file watcher). Watcher uses optional-chaining.
  let cmsApp:
    | (Hono & {
        invalidateTemplatesCache(): void
        invalidateContentCache(): Promise<void>
        rescanForTemplate?(name: string): Promise<void>
      })
    | null = null
  const hookContributions = readHookContributions(manifest)
  if (isDevMode) {
    // Dev mode: mount CMS API inline (same process = shared template cache)
    cmsApp = await setupCmsApi(
      app,
      source,
      siteDir,
      templatesDir,
      adminDir,
      targetConfigs,
      hookContributions,
      manifest,
      anyArchived,
    )
  } else if (cmsStaticDir) {
    // Production mode: inline CMS API + static files
    cmsApp = await setupProductionMode(
      app,
      source,
      siteDir,
      cmsStaticDir,
      templatesDir,
      adminDir,
      targetConfigs,
      hookContributions,
      manifest,
      anyArchived,
    )
  }

  // ---- Per-request page resolution and the site's own 404 (#1318) ----
  // Boot registers routes for the pages and locales that existed at
  // start-up; everything else lands here. That covers pages created while
  // the server runs, locale-prefixed paths for locales added to
  // `supported` after boot (#1353), and unknown URLs. Resolve against a
  // freshly loaded site built from the live source/manifest, the same
  // per-request loadSite the boot page handlers do, so new pages answer
  // without a restart. When no page matches, render the site's own /404
  // page with status 404 (the decided behavior from #1318, matching
  // `gazetta serve` and the worker); the devNotFound route list stays
  // only for a site with no 404 page. Registered last: Hono
  // short-circuits on the first handler that returns, so existing routes
  // win and only otherwise-404 paths reach here.
  const matchPageRoute = (pattern: string, path: string): Record<string, string> | null => {
    const pp = pattern.split('/').filter(Boolean)
    const sp = path.split('/').filter(Boolean)
    if (pp.length !== sp.length) return null
    const params: Record<string, string> = {}
    for (let i = 0; i < pp.length; i++) {
      if (pp[i].startsWith(':')) params[pp[i].slice(1)] = decodeURIComponent(sp[i])
      else if (pp[i] !== sp[i]) return null
    }
    return params
  }
  app.all('*', async c => {
    const pathname = new URL(c.req.url).pathname
    const segs = pathname.split('/').filter(Boolean)
    const liveLocales = resolveSiteLocales(live.manifest)
    let loc: string | undefined
    let rest = pathname
    if (segs[0] && liveLocales && segs[0] !== liveLocales.default && liveLocales.supported.includes(segs[0])) {
      loc = segs[0]
      rest = '/' + segs.slice(1).join('/')
    }
    try {
      const freshSite = await loadSite({ contentRoot: live.source.contentRoot, templatesDir, manifest: live.manifest })
      const renderFresh = async (pageName: string, routeParams: Record<string, string>, status: 200 | 404) => {
        const page = freshSite.pages.get(pageName)
        if (!page) return null
        const resolved = await resolvePage(pageName, freshSite, loc)
        const freshPage = (loc ? freshSite.pageLocales.get(pageName)?.locales.get(loc) : undefined) ?? page
        const html = await renderPage(resolved, {
          routeParams,
          metadata: freshPage?.metadata ?? page.metadata,
          route: freshPage?.route ?? page.route,
          seo: {
            siteName: freshSite.manifest.name,
            locale: loc ?? _devDefaultLocaleFor(freshSite.manifest),
            defaultOgImage: freshSite.manifest.defaultOgImage,
          },
        })
        return c.html(
          html.replace(
            '</body>',
            `${RELOAD_SCRIPT}
</body>`,
          ),
          status,
        )
      }
      for (const [pageName, page] of freshSite.pages) {
        const routeParams = matchPageRoute(page.route, rest)
        if (!routeParams) continue
        const rendered = await renderFresh(pageName, routeParams, 200)
        if (rendered) return rendered
      }
      const notFoundPage = [...freshSite.pages.entries()].find(([, p]) => p.route === '/404')
      if (notFoundPage) {
        const rendered = await renderFresh(notFoundPage[0], {}, 404)
        if (rendered) return rendered
      }
      return devNotFound(freshSite.pages)(c)
    } catch (err) {
      return c.html(renderErrorOverlay(err as Error), 500)
    }
  })

  // ---- 404 ----
  app.notFound(devNotFound(site.pages))

  // ---- Start server ----
  const startTime = performance.now()
  const nodeServer = serve({ fetch: app.fetch, port, hostname: resolveListenHost('dev', hostFlag) }, async () => {
    const elapsed = Math.round(performance.now() - startTime)
    console.log()
    console.log(`  ${c.bgGreen(c.bold(' gazetta '))} ${c.green(site.manifest.name)} ${c.dim(`ready in ${elapsed} ms`)}`)
    console.log()
    console.log(`  ${c.dim('┃')} Local    ${c.cyan(`http://localhost:${port}/`)}`)
    // #1317: the CMS is mounted in both modes (inline Vite in the monorepo,
    // pre-built static files in the packed package). Print its URL whenever
    // it is served, not only in monorepo dev mode.
    if (cmsApp) {
      console.log(`  ${c.dim('┃')} CMS      ${c.cyan(`http://localhost:${port}/admin`)}`)
    }
    if (isDevMode) {
      console.log(`  ${c.dim('┃')} Dev      ${c.cyan(`http://localhost:${port}/admin/dev`)}`)
    }
    console.log()

    console.log(
      `  ${c.dim('┃')} Pages    ${[...site.pages.entries()].map(([n, p]) => `${c.dim(p.route)} ${c.dim('→')} ${n}`).join(c.dim(', '))}`,
    )
    console.log(`  ${c.dim('┃')} Frags    ${c.dim([...site.fragments.keys()].join(', ') || '(none)')}`)

    // ---- Settings banner ----
    // Prints resolved configuration at startup so path / target / site
    // issues are diagnosed immediately instead of via empty API responses.
    // Opt-in via GAZETTA_QUIET=1 for scripted callers that don't want it.
    if (!process.env.GAZETTA_QUIET) {
      const relProject = relative(process.cwd(), projectRoot) || '.'
      const relSite = relative(projectRoot, siteDir) || '.'
      const relTemplates = relative(projectRoot, templatesDir) || '.'
      const sourceName = source.targetName ?? '(none)'
      const sourceCfg = targetConfigs[sourceName]
      const sourceEnv = sourceCfg ? getEnvironment(sourceCfg) : 'unknown'
      const sourceType = sourceCfg ? getType(sourceCfg) : 'unknown'
      const sourceEditable = sourceCfg ? isEditable(sourceCfg) : false
      const sourceRoot = source.contentRoot.rootPath || '.'
      const targetsCount = Object.keys(targetConfigs).length
      console.log()
      console.log(`  ${c.dim('┃')} ${c.bold('Settings')}`)
      console.log(`  ${c.dim('┃')}   Project      ${c.dim(relProject)}`)
      console.log(`  ${c.dim('┃')}   Site         ${c.dim(relSite)}`)
      console.log(`  ${c.dim('┃')}   Templates    ${c.dim(relTemplates)}`)
      console.log(
        `  ${c.dim('┃')}   Source       ${sourceName} ${c.dim(`(${sourceEnv}, ${sourceEditable ? 'editable' : 'read-only'}, ${sourceType})`)}`,
      )
      console.log(`  ${c.dim('┃')}   Content root ${c.dim(sourceRoot)}`)
      console.log(`  ${c.dim('┃')}   Targets (${targetsCount})`)
      for (const [name, cfg] of Object.entries(targetConfigs)) {
        const env = getEnvironment(cfg)
        const type = getType(cfg)
        const ed = isEditable(cfg) ? 'editable ' : 'read-only'
        console.log(
          `  ${c.dim('┃')}     ${c.dim('•')} ${name.padEnd(14)} ${c.dim(env.padEnd(11))} ${c.dim(ed)} ${c.dim(type.padEnd(8))}`,
        )
      }
    }

    if (isDevMode && cmsWebDir) {
      // While Vite is spinning up (compiling, scanning deps, attaching
      // middleware), any /admin/* request falls through to the site's 404
      // handler showing a raw page list. Intercept early and serve a loader
      // page that polls /admin/ping until ready, then reloads (#132).
      let cmsReady = false
      const httpServer = nodeServer as unknown as import('node:http').Server
      const originalListeners = httpServer.listeners('request').slice()
      httpServer.removeAllListeners('request')

      const loaderHandler = (req: import('node:http').IncomingMessage, res: import('node:http').ServerResponse) => {
        const url = req.url ?? ''
        if (url === '/admin/ping' || url.startsWith('/admin/ping?')) {
          res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' })
          res.end(JSON.stringify({ ready: cmsReady }))
          return true
        }
        if (url === '/admin' || url.startsWith('/admin/') || url.startsWith('/@')) {
          res.writeHead(503, {
            'Content-Type': 'text/html; charset=utf-8',
            'Cache-Control': 'no-store',
            'Retry-After': '2',
          })
          res.end(LOADER_HTML)
          return true
        }
        return false
      }

      // During startup: route /admin/* to the loader, everything else to Hono
      httpServer.on('request', (req, res) => {
        if (cmsReady) return // real handler installed below will run
        if (loaderHandler(req, res)) return
        for (const l of originalListeners) {
          ;(l as (req: import('node:http').IncomingMessage, res: import('node:http').ServerResponse) => void)(req, res)
        }
      })

      try {
        const { createServer: createViteServer } = await import('vite')
        const { searchForWorkspaceRoot } = await import('vite')
        // Discover entries Vite should pre-scan during dep optimization at startup.
        // Without this, Vite finds deps lazily (e.g. react/jsx-dev-runtime when
        // hero.tsx is first loaded) and triggers "optimized dependencies changed.
        // reloading" — a full page reload that wipes editor state (#122).
        //
        // Entries must include: admin SPA root (index.html), custom editors, and
        // custom fields. Vite resolves the full transitive dep graph from these.
        const optimizeEntries: string[] = [join(cmsWebDir, 'index.html')]
        if (existsSync(adminDir)) {
          const { readdir } = await import('node:fs/promises')
          for (const dir of [join(adminDir, 'editors'), join(adminDir, 'fields')]) {
            if (!existsSync(dir)) continue
            try {
              const entries = await readdir(dir, { withFileTypes: true })
              for (const e of entries) {
                if (e.isFile() && /\.(tsx?|jsx?)$/.test(e.name)) {
                  optimizeEntries.push(join(dir, e.name))
                }
              }
            } catch {
              /* ignore */
            }
          }
        }

        const vite = await createViteServer({
          configFile: join(cmsWebDir, 'vite.config.ts'),
          root: cmsWebDir,
          base: '/admin/',
          cacheDir: viteCacheDir(siteDir, projectRoot),
          resolve: {
            alias: {
              '@editors': join(adminDir, 'editors'),
              '@fields': join(adminDir, 'fields'),
            },
          },
          optimizeDeps: {
            entries: optimizeEntries,
            // JSX automatic runtime is injected by Vite's esbuild transform, not
            // written into the source, so the scanner misses it. Include it
            // explicitly to avoid a mid-session page reload when a TSX editor
            // is first loaded (#122).
            //
            // @formkit/drag-and-drop/vue is the ComponentTree's reorder lib
            // (#105). The package's main entry is CJS; the Vue subpath is
            // ESM. Vite's auto-scanner doesn't always pre-bundle subpath
            // ESM imports with mixed CJS-main packages on first load,
            // which triggers a runtime "Re-optimizing dependencies"
            // page reload mid-test on CI cold start. Explicit include
            // pins the subpath in the boot-time pre-bundle.
            include: ['react/jsx-dev-runtime', 'react/jsx-runtime', '@formkit/drag-and-drop/vue'],
          },
          server: {
            middlewareMode: true,
            hmr: { server: nodeServer as unknown as import('node:http').Server },
            fs: { allow: [searchForWorkspaceRoot(cmsWebDir), siteDir] },
          },
        })

        const honoHandler = (req: import('node:http').IncomingMessage, res: import('node:http').ServerResponse) => {
          for (const listener of originalListeners) {
            ;(listener as (req: import('node:http').IncomingMessage, res: import('node:http').ServerResponse) => void)(
              req,
              res,
            )
          }
        }

        httpServer.removeAllListeners('request')
        httpServer.on('request', (req, res) => {
          const url = req.url ?? ''
          // Keep /admin/ping live so the loader page can continue polling —
          // useful if the server hot-reloads and Vite rebinds.
          if (url === '/admin/ping' || url.startsWith('/admin/ping?')) {
            res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' })
            res.end(JSON.stringify({ ready: true }))
            return
          }
          if (
            url.startsWith('/admin/api') ||
            url.startsWith('/admin/preview') ||
            url === '/admin/theme.css' ||
            url.startsWith('/admin/theme.css?')
          ) {
            honoHandler(req, res)
          } else if (url.startsWith('/admin') || url.startsWith('/@')) {
            vite.middlewares(req, res, () => honoHandler(req, res))
          } else {
            honoHandler(req, res)
          }
        })
        // Force Vite to scan deps + complete initial optimization BEFORE we
        // mark the CMS ready. Without this, `cmsReady = true` fires the
        // moment Vite is created — loader page reloads, browser starts
        // fetching the SPA, and Vite's still building the dep bundle in the
        // background. The first round of imports arrives, Vite finds new
        // transitive deps, and fires `optimized dependencies changed.
        // reloading` mid-page-load. That reload cancels in-flight
        // `/admin/api/*` requests — silently breaking any component that
        // doesn't retry (FragmentBlastRadius, for one).
        //
        // Warm the SPA's main entry module (not index.html — Vite's
        // import-analysis plugin treats warmupRequest urls as JS modules
        // and chokes on HTML). The entry's transitive imports are exactly
        // what the browser will request on first load, so settling them
        // here means the browser gets a stable bundle. waitForRequestsIdle
        // blocks until Vite finishes processing the static-import chain,
        // which includes dep optimization.
        const ENTRY = '/src/client/main.ts'
        await vite.warmupRequest(ENTRY)
        await vite.waitForRequestsIdle(ENTRY)
        cmsReady = true
      } catch (err) {
        console.warn(`  Warning: CMS UI failed to start: ${(err as Error).message}`)
      }
    }
    console.log()
  })
  exitOnListenError(nodeServer, port)

  // ---- File watching ----
  // Watch site dir for content changes (JSON manifests + site.config.ts).
  // Swallow FSWatcher 'error' events — Node's recursive watcher throws ENOENT
  // when a watched subdir disappears (rm -rf during publish, git checkout).
  // Letting it crash would take the whole dev server down; logging a warning
  // is enough, the watcher recovers for still-existing paths.
  // Re-evaluate site.config.ts (or .js/.mjs) on save and swap the live
  // state (#1353). jiti runs with moduleCache disabled, so each load sees
  // the edited file. A config that fails to evaluate keeps the last good
  // state, per the locked acceptance on #1353.
  let configReloadRunning = false
  let configReloadQueued = false
  const reloadSiteConfig = async () => {
    // A save that lands while a reload runs is queued, not dropped: rerun
    // once the in-flight reload ends so the last edit wins (#1353 review).
    if (configReloadRunning) {
      configReloadQueued = true
      return
    }
    configReloadRunning = true
    try {
      do {
        configReloadQueued = false
        try {
          const next = await buildSourceContext({ projectSiteDir: siteDir })
          live.source = next.source
          live.manifest = next.manifest
          // Mutate targetConfigs in place rather than swapping the object:
          // the admin app captured this reference at boot (target registry,
          // lazy provider init, /api/targets), so in-place updates are how
          // the admin sees edited targets without a restart.
          for (const name of Object.keys(live.targetConfigs)) {
            if (!(name in next.targetConfigs)) delete live.targetConfigs[name]
          }
          Object.assign(live.targetConfigs, next.targetConfigs)
          console.log('  Config changed: site.config reloaded')
          invalidateAllTemplates()
          void cmsApp?.invalidateContentCache()
          notifyReload()
        } catch (err) {
          console.error(`  Config reload failed: ${(err as Error).message}`)
          console.error('  Keeping the last good config.')
        }
      } while (configReloadQueued)
    } finally {
      configReloadRunning = false
    }
  }

  const siteWatcher = watch(siteDir, { recursive: true }, (_event, filename) => {
    if (!filename) return
    const watchNorm = filename.replace(/\\/g, '/')
    const watchBase = watchNorm.split('/').pop() ?? watchNorm
    if (watchBase === 'site.config.ts' || watchBase === 'site.config.js' || watchBase === 'site.config.mjs') {
      void reloadSiteConfig()
      return
    }
    // .gazetta/ is a reserved namespace (history, source-sidecars, etc.) that
    // the runtime never reads at request time. Writes there are extremely
    // frequent (one per save/publish × per-target) — treating them as
    // content changes would flood SSE reloads and reset preview iframe
    // scroll state mid-test. Filter them out at the watcher boundary.
    const norm = filename.replace(/\\/g, '/')
    if (isStatePath(norm)) return
    if (filename.endsWith('.json') || filename.endsWith('.yaml')) {
      // "Manifest changed" is only worth logging for files under the
      // active source target's content root; JSON elsewhere in the site
      // folder (scratch files, other targets' state) is noise (#1318).
      // The invalidation below still runs for those files: the admin
      // reads every local target, so an out-of-band wipe of another
      // target's storage must drop its cached page summaries. Skipping
      // it broke the target-switch e2e (stale staging summary after the
      // fixture wipes sites/main/dist/staging). Non-filesystem storage
      // exposes no on-disk root, so the check is skipped. The paths
      // are realpathSync'd (temp dirs can sit behind symlinks, /var ->
      // /private/var on macOS) and compared with isInside: a relative-
      // based check reads case-insensitively on Windows, where a drive
      // letter's casing can differ between the two sides.
      let logChange = true
      const sourceRoot = live.source.storage.root
      if (sourceRoot) {
        try {
          logChange = isInside(realpathSync(sourceRoot), resolve(realpathSync(siteDir), filename))
        } catch {
          logChange = true
        }
      }
      if (logChange) console.log(`  Manifest changed: ${filename}`)
      invalidateAllTemplates()
      // Out-of-band manifest changes (git pull, manual edit, e2e
      // test wipes) bypass the admin-api save handler that would
      // otherwise invalidate the AdminCache. Drop content-summary
      // entries so the next /api/pages or /api/fragments rebuilds
      // from disk. Best-effort; the void promise is fire-and-forget.
      void cmsApp?.invalidateContentCache()
      notifyReload()
    }
  })
  siteWatcher.on('error', err => console.warn(`  File watcher warning (site): ${(err as Error).message}`))

  // Watch templates dir for template source changes
  if (existsSync(templatesDir)) {
    const tplWatcher = watch(templatesDir, { recursive: true }, (_event, filename) => {
      if (!filename) return
      if (filename.endsWith('.ts') || filename.endsWith('.tsx')) {
        const parts = filename.split('/')
        if (parts.length >= 1) {
          const templateName = parts[0]
          const fullPath = join(templatesDir, filename)
          // Suppress spurious events for files whose mtime predates the
          // watcher's recent window — these are kernel-delayed metadata
          // flushes for files written before the watcher began observing,
          // typical of the worker-scoped `cp -r` setup in the e2e fixture
          // (#286). Without the gate, the resulting notifyReload() closes
          // any open admin UI mid-interaction.
          void (async () => {
            if (!(await isTemplateEventRecent(fullPath, TEMPLATE_RECENT_CHANGE_WINDOW_MS))) {
              return
            }
            console.log(`  Template changed: ${templateName}`)
            invalidateTemplate(templateName)
            // Drop the admin-api's cached scan so next compare/publish
            // rehashes. Cheap (the scan is what's slow, not invalidation).
            cmsApp?.invalidateTemplatesCache()
            // Cut 6 — fire a validation rescan with the template-edit
            // cause so the scanner re-runs schema-conformance against
            // every page+fragment using this template. The ScanEvent
            // emits on the /__validation SSE channel; the admin's
            // TemplateChangedBanner consumes it to show the
            // template-developer's "did I break anything?" surface.
            // Fire-and-forget — the scan runs in the background and
            // the SSE event is the signal that it finished.
            void cmsApp?.rescanForTemplate?.(templateName)
            notifyReload()
          })()
        }
      }
    })
    tplWatcher.on('error', err => console.warn(`  File watcher warning (templates): ${(err as Error).message}`))
  }
}

// ---- Mount CMS API on the main Hono app (shared process = shared template cache) ----
/**
 * Mount a Hono route serving the user's admin/theme.css. 404 if not present.
 * Cache-Control no-cache so devs see edits immediately.
 *
 * The link tag is added at runtime by main.ts (after PrimeVue + tokens.css)
 * so user declarations win the cascade. See #134 and css-theming.md.
 */
function mountUserThemeRoute(cmsApp: Hono, adminDir: string) {
  cmsApp.get('/theme.css', c => {
    const themePath = join(adminDir, 'theme.css')
    c.header('Content-Type', 'text/css; charset=utf-8')
    c.header('Cache-Control', 'no-cache')
    // When the user hasn't authored a theme.css, return an empty 200 rather
    // than a 404. The link tag in main.ts always references this URL; a 404
    // would log a browser console error on every cold load, polluting error
    // reports and failing strict console-error checks.
    if (!existsSync(themePath)) return c.body('')
    return c.body(readFileSync(themePath, 'utf-8'))
  })
}

/**
 * Build the background validation scanner (validation Cut 2). The scanner
 * is constructed against the resolved source's storage + cache; the boot
 * path kicks off an initial full-site scan in the background so admin
 * responses don't block on it.
 *
 * Returns null when the manifest is unavailable (site lacks site.config.ts)
 * — the admin app degrades gracefully (route returns empty issues; SSE
 * channel idle).
 */
async function buildValidationScanner(opts: {
  source: import('../admin-api/source-context.js').SourceContext
  templatesDir: string
  manifest: SiteManifest | null
}): Promise<import('../validation/scanner.js').ValidationScanner | null> {
  if (!opts.manifest) return null
  const { createValidationScanner } = await import('../validation/scanner.js')
  const { defaultValidatorRegistry } = await import('../validation/default-registry.js')
  const scanner = createValidationScanner({
    storage: opts.source.storage,
    contentRoot: opts.source.contentRoot,
    registry: defaultValidatorRegistry(),
    cache: opts.source.cache,
    siteOptions: { templatesDir: opts.templatesDir, manifest: opts.manifest },
  })
  // Boot warm: kick off the initial scan in the background. Errors are
  // logged but don't block boot — broken validators surface as info-issues
  // rather than failing the admin process.
  void scanner.scanAll().catch(err => {
    console.error('[validation] initial scan failed:', err)
  })
  return scanner
}

async function setupCmsApi(
  app: Hono,
  source: import('../admin-api/source-context.js').SourceContext,
  siteDir: string,
  templatesDir: string,
  adminDir: string,
  targetConfigs: Record<string, import('../types.js').TargetConfig> | undefined,
  contributions: ReadonlyArray<import('../hooks/index.js').HookContribution> | undefined,
  manifest: SiteManifest | null,
  anyArchived: boolean,
): Promise<
  Hono & {
    invalidateTemplatesCache(): void
    invalidateContentCache(): Promise<void>
    /** Cut 6 — fired by the dev template watcher when a template's source
     *  changes. Triggers a full-site rescan with `kind: 'template'` cause
     *  so the validation scanner emits a ScanEvent that the admin's
     *  TemplateChangedBanner consumes. No-op when the scanner isn't built
     *  (production / scanner-disabled). */
    rescanForTemplate(name: string): Promise<void>
  }
> {
  // Build + seal the hook registry from `admin.hooks` factory
  // contributions before wiring the admin app. Hooks are an opt-in
  // extension surface; sites without `admin.hooks` get an empty
  // registry (no overhead).
  logDefaultedPublicTargets(targetConfigs)
  const hooks = await buildHooksRegistry({ contributions })
  const validationScanner = await buildValidationScanner({ source, templatesDir, manifest })
  // Mount SSE on the OUTER Hono app — matches `/__reload`'s placement so
  // the browser EventSource (which connects without an `/admin/` prefix)
  // bypasses Vite's middleware and reaches the route. Same in prod for
  // consistency: a save from one tab updates the badge in every other
  // tab without polling. The route streams ScanEvents (item paths +
  // validator messages), so it's gated on `read:pages` internally —
  // pass the same auth provider createAdminApp will resolve.
  const { mountValidationSse } = await import('../admin-api/routes/validation.js')
  const { resolveAuthProviderFromManifest } = await import('../auth/index.js')
  const sseAuthProvider = resolveAuthProviderFromManifest(manifest?.admin?.auth)
  mountValidationSse(app, validationScanner, sseAuthProvider)
  const cmsApp = createAdminApp({
    source,
    siteDir,
    templatesDir,
    adminDir,
    targetConfigs,
    hooks,
    validationScanner,
    anyArchived,
  })
  // Decorate cmsApp with the template-rescan hook before returning. The
  // file watcher in startServer() invokes this on `.ts/.tsx` changes
  // under `templates/{name}/`. Failure is fail-open (logged + dropped)
  // — a scan failure shouldn't break dev-mode hot reload.
  const decoratedApp = cmsApp as typeof cmsApp & {
    rescanForTemplate(name: string): Promise<void>
  }
  decoratedApp.rescanForTemplate = async (name: string) => {
    if (!validationScanner) return
    try {
      await validationScanner.rescan({ kind: 'template', name })
    } catch (err) {
      console.warn(`  Validation scanner: template rescan failed for "${name}": ${(err as Error).message}`)
    }
  }
  mountUserThemeRoute(cmsApp, adminDir)
  app.route('/admin', cmsApp)
  return decoratedApp
}

// ---- Production mode: inline CMS API + static files from admin-dist/ ----
async function setupProductionMode(
  app: Hono,
  source: import('../admin-api/source-context.js').SourceContext,
  siteDir: string,
  cmsStaticDir: string,
  templatesDir: string,
  adminDir: string,
  targetConfigs: Record<string, import('../types.js').TargetConfig> | undefined,
  contributions: ReadonlyArray<import('../hooks/index.js').HookContribution> | undefined,
  manifest: SiteManifest | null,
  anyArchived?: boolean | 'defer',
) {
  // Same shape as dev mode — `gazetta serve` reads `admin.hooks`
  // factory contributions from the same site config.
  logDefaultedPublicTargets(targetConfigs)
  const hooks = await buildHooksRegistry({ contributions })
  const validationScanner = await buildValidationScanner({ source, templatesDir, manifest })
  // SSE channel at the outer app's root; see setupCmsApi for rationale.
  // The route is gated on `read:pages` — pass the configured auth
  // provider so anonymous + missing-capability requests are rejected
  // before the stream opens.
  const { mountValidationSse } = await import('../admin-api/routes/validation.js')
  const { resolveAuthProviderFromManifest } = await import('../auth/index.js')
  const sseAuthProvider = resolveAuthProviderFromManifest(manifest?.admin?.auth)
  mountValidationSse(app, validationScanner, sseAuthProvider)
  // Mount CMS API inline at /admin (production mode — bundled editors/fields)
  const cmsApp = createAdminApp({
    source,
    siteDir,
    templatesDir,
    adminDir,
    production: true,
    targetConfigs,
    hooks,
    validationScanner,
    anyArchived,
  })
  mountUserThemeRoute(cmsApp, adminDir)
  app.route('/admin', cmsApp)

  // Serve pre-built CMS static files (includes bundled editors/fields)
  app.use(
    '/admin/*',
    serveStatic({
      root: cmsStaticDir,
      rewriteRequestPath: path => path.replace(/^\/admin/, ''),
    }),
  )

  // SPA fallback: serve index.html for /admin and unmatched /admin/* routes
  const serveIndex = (c: import('hono').Context) => {
    const indexPath = join(cmsStaticDir, 'index.html')
    if (existsSync(indexPath)) {
      return c.html(readFileSync(indexPath, 'utf-8'))
    }
    return c.text('CMS admin UI not found', 404)
  }
  app.get('/admin/*', serveIndex)
  app.get('/admin', serveIndex)
  return cmsApp
}

/** Find apps/admin source dir (monorepo dev mode) */
function findCmsDir(): string | null {
  const candidates = [
    resolve('apps/admin'),
    resolve(import.meta.dirname, '../../../../apps/admin'),
    resolve(import.meta.dirname, '../../../apps/admin'),
  ]
  for (const dir of candidates) {
    if (existsSync(join(dir, 'src/server/dev.ts'))) return dir
  }
  return null
}

/** Find pre-built CMS static files (production mode) */
function findCmsStaticDir(): string | null {
  const candidates = [
    resolve(import.meta.dirname, '../../admin-dist'),
    resolve(import.meta.dirname, '../../../admin-dist'),
  ]
  for (const dir of candidates) {
    if (existsSync(join(dir, 'index.html'))) return dir
  }
  return null
}

async function main() {
  if (!command || command === 'help' || command === '--help' || command === '-h') {
    printHelp()
    process.exit(0)
  }

  const parsed = parseArgs(args.slice(1))
  if (parsed.host !== undefined && !SERVER_COMMANDS.has(command)) {
    console.error(`\n  ${c.red('Error:')} --host only applies to dev, admin and serve\n`)
    process.exit(1)
  }

  // Commands that take [target] [site] positional args
  const targetFirstCommands = new Set(['publish', 'serve', 'deploy', 'history', 'undo'])
  // Commands that take [site] positional arg
  const siteOnlyCommands = new Set(['dev', 'validate', 'admin'])

  let siteDir: string
  let targetName: string | undefined
  // rollback: positional layout is `<rev> [target] [site]`. We stash
  // the revision id here because the shared positional parser uses
  // index 0 for target/site; rollback just consumes index 0 first.
  let rollbackRevisionId: string | undefined

  if (command === 'init') {
    await runInit(parsed.positional[0] ?? '.')
    return
  }

  // ── Resolve siteDir once (fs walk; no config eval) + load .env
  // ── BEFORE any config-eval. Storage / deploy / AI factories read
  // ── process.env synchronously at construction; resolveTarget()
  // ── triggers config-eval, so env must be in place first. Per-
  // ── command positional layouts determine which slot carries the
  // ── site path. Site-local `.env` is honored (e.g.,
  // ── sites/gazetta.studio/.env with R2 creds) per design-config.md.
  siteDir = await resolveSiteDirForCommand(command, parsed)
  loadEnvFiles(siteDir)

  if (command === 'build') {
    await runBuild(siteDir)
    return
  } else if (command === 'rollback') {
    // gazetta rollback <rev> [target] [site]
    const [rev, second] = parsed.positional
    if (!rev || !rev.startsWith('rev-')) {
      console.error(
        `\n  Error: rollback requires a revision id as the first argument (e.g. gazetta rollback rev-1776337441608 [target])\n`,
      )
      process.exit(1)
      return
    }
    rollbackRevisionId = rev
    const secondIsSite = second && (second.includes('/') || hasSiteConfig(resolve(second)))
    targetName = secondIsSite ? await resolveTarget(undefined, siteDir) : await resolveTarget(second, siteDir)
  } else if (targetFirstCommands.has(command)) {
    // gazetta publish [target] [site]
    const [first] = parsed.positional
    const firstIsSite = first && (first.includes('/') || hasSiteConfig(resolve(first)))
    targetName = firstIsSite ? await resolveTarget(undefined, siteDir) : await resolveTarget(first, siteDir)
  } else if (siteOnlyCommands.has(command)) {
    // siteDir set up front; nothing more needed.
  } else if (command === 'translate') {
    // gazetta translate <item> --to <locale> [target]
    const translatePositionals = parsed.positional.filter(p => !p.startsWith('pages/') && !p.startsWith('fragments/'))
    if (translatePositionals.length > 0) targetName = translatePositionals[0]
  } else if (command === 'assets') {
    // gazetta assets <subcommand> [args...] [target] [site]
    //   assets list [target] [site]        → subcmd, target, site
    //   assets info <name> [target] [site] → subcmd, name, target, site
    //   assets reindex [target] [site]     → subcmd, target, site
    const subcmd = parsed.positional[0]
    const targetArg = subcmd === 'info' ? parsed.positional[2] : parsed.positional[1]
    targetName = targetArg ? await resolveTarget(targetArg, siteDir) : undefined
  } else if (command === 'archive') {
    // gazetta archive <subcommand> [args...]
    //
    // Site/target resolution: positional after the subcommand's
    // required args are interpreted as [target] [site]. The archive
    // module honors `--kind=` / `--force` / `--no-keep-alias` flags
    // separately (those don't reach the parsed.positional list per
    // global parseArgs).
    //
    // Subcommand positional shapes:
    //   archive list                              → []
    //   archive purge <name>                      → [name]
    //   archive restore <name>                    → [name]
    //   archive rename <oldname> <newname>        → [oldname, newname]
    //
    // Remaining slots are [target] [site] in that order.
    const subcmd = parsed.positional[0]
    const requiredArgs = subcmd === 'rename' ? 2 : subcmd === 'purge' || subcmd === 'restore' ? 1 : 0
    const trailingStart = 1 + requiredArgs
    const targetArg = parsed.positional[trailingStart]
    targetName = targetArg ? await resolveTarget(targetArg, siteDir) : undefined
  } else if (command === 'state') {
    // gazetta state remove <target> [site]
    const [subcmd, targetArg] = parsed.positional
    if (subcmd !== 'remove' || !targetArg) {
      console.error(`  Usage: gazetta state remove <target> [site]\n`)
      printHelp()
      process.exit(1)
      return
    }
    targetName = await resolveTarget(targetArg, siteDir)
  } else {
    console.error(`  Unknown command: ${command}\n`)
    printHelp()
    process.exit(1)
    return
  }

  switch (command) {
    case 'publish':
      await runPublish(siteDir, targetName, { force: parsed.force })
      break
    case 'serve':
      await runServe(siteDir, parsed.port ?? 3000, targetName, parsed.host)
      break
    case 'deploy':
      await runDeploy(siteDir, targetName)
      break
    case 'validate':
      await runValidate(siteDir, args.slice(1))
      break
    case 'dev':
      await runDev(siteDir, parsed.port ?? 3000, parsed.host)
      break
    case 'admin':
      await runAdmin(siteDir, parsed.port ?? 3000, parsed.host)
      break
    case 'translate': {
      const itemArg = args[1]
      const localeArg = args.find(a => a.startsWith('--to='))?.slice(5) ?? args[args.indexOf('--to') + 1]
      if (!itemArg || !localeArg) {
        console.error('  Usage: gazetta translate <pages/name|fragments/name> --to <locale>')
        console.error('  Example: gazetta translate pages/about --to fr')
        process.exit(1)
      }
      const { normalizeLocale, localeFilename, isValidLocale } = await import('../locale.js')
      if (!isValidLocale(localeArg)) {
        console.error(`  Error: invalid locale code "${localeArg}". Use BCP 47 format (e.g. fr, en-gb, pt-br)`)
        process.exit(1)
      }
      const locale = normalizeLocale(localeArg)
      const isPage = itemArg.startsWith('pages/')
      const isFragment = itemArg.startsWith('fragments/')
      if (!isPage && !isFragment) {
        console.error(`  Error: item must start with pages/ or fragments/ (got "${itemArg}")`)
        process.exit(1)
      }
      // Resolve the content directory — translate operates on a target's filesystem.
      // Uses the specified target or falls back to the first editable target.
      const siteYaml = await loadSiteManifestForCli(siteDir)
      if (!siteYaml) {
        console.error(`  Error: no site config found at ${siteDir}`)
        process.exit(1)
      }
      const { isEditable } = await import('../types.js')
      const resolvedTarget =
        targetName ?? Object.entries(siteYaml.targets ?? {}).find(([, cfg]) => isEditable(cfg))?.[0]
      if (!resolvedTarget) {
        console.error('  Error: no editable target found')
        process.exit(1)
      }
      const targetConfig = siteYaml.targets![resolvedTarget]
      if (!targetConfig) {
        console.error(`  Error: target "${resolvedTarget}" not found in site config`)
        process.exit(1)
      }
      // Translate goes through the storage provider so it works on any
      // storage backend (filesystem / R2 / S3 / Azure). Path X — the storage
      // provider was constructed by the operator's factory at config-eval.
      const storage = targetConfig.storage
      const baseName = isPage ? 'page' : 'fragment'
      const sourcePath = `${itemArg}/${baseName}.json`
      const destPath = `${itemArg}/${localeFilename(baseName, locale)}`
      if (!(await storage.exists(sourcePath))) {
        console.error(`  Error: ${sourcePath} not found on target "${resolvedTarget}"`)
        process.exit(1)
      }
      if (await storage.exists(destPath)) {
        console.error(`  Error: ${destPath} already exists on target "${resolvedTarget}"`)
        process.exit(1)
      }
      const sourceContent = await storage.readFile(sourcePath)
      await storage.writeFile(destPath, sourceContent)
      console.log(`  ${c.green('✓')} Created ${destPath}`)
      console.log(`  Edit the file to translate the content.`)
      break
    }
    case 'history':
    case 'undo':
    case 'rollback': {
      const { runHistoryList, runHistoryUndo, runHistoryRollback } = await import('./history.js')
      const ctx = await resolveHistoryContext(siteDir, targetName!)
      if (command === 'history') await runHistoryList(ctx, { limit: parsed.limit })
      else if (command === 'undo') await runHistoryUndo(ctx, { yes: parsed.yes })
      else await runHistoryRollback(ctx, rollbackRevisionId!, { yes: parsed.yes })
      break
    }
    case 'assets': {
      const { runAssetsSubcommand } = await import('./assets-cli.js')
      await runAssetsSubcommand({ args: args.slice(1), siteDir, targetName })
      break
    }
    case 'archive': {
      const { runArchiveSubcommand } = await import('./archive.js')
      await runArchiveSubcommand({ args: args.slice(1), siteDir, targetName })
      break
    }
    case 'state': {
      const { runStateRemove } = await import('./state.js')
      const { config } = await resolveHistoryContext(siteDir, targetName!)
      await runStateRemove({ targetName: targetName!, config }, { yes: parsed.yes })
      break
    }
  }
}

/**
 * Resolve site + target + config into the shape HistoryCommandContext
 * expects. Lives here rather than in cli/history.ts so the target-
 * resolution logic (site config parsing, CI env handling) stays with
 * the other CLI commands that already do it the same way.
 */
async function resolveHistoryContext(siteDir: string, targetName: string) {
  // Config only: cli/history.ts initializes the named target itself, and
  // initializing the others would wait on any that can't be reached (#1459).
  const { loadSiteTargets } = await import('./bootstrap.js')
  const { targetConfigs } = await loadSiteTargets(siteDir)
  const config = targetConfigs[targetName]
  if (!config) {
    throw new Error(`Unknown target "${targetName}". Available: ${Object.keys(targetConfigs).join(', ')}`)
  }
  return { siteDir, targetName, config }
}

main().catch(err => {
  console.error(`\n  Error: ${(err as Error).message}\n`)
  process.exit(1)
})
