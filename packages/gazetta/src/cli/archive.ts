/**
 * `gazetta archive <subcommand>` runner — Cut 13 of the soft-delete
 * implementation plan.
 *
 * Subcommands (per design-soft-delete.md Q13 L4 lock):
 *   archive list [--kind=page|fragment]
 *   archive purge <name> [--kind=page|fragment] [--force]
 *   archive restore <name> [--kind=page|fragment]
 *   archive rename <oldname> <newname> [--kind=page|fragment] [--no-keep-alias] [--force]
 *
 * Implementation strategy: the CLI invokes the same admin-api routes
 * the admin UI uses, via `app.request()` against an in-process
 * `createAdminApp`. This reuses every primitive (audit, capability,
 * cache invalidation, sidecar writes) and avoids parallel CLI-only
 * code paths that could drift from the route handlers.
 *
 * Cron-friendly output: structured per-line stdout, one line per
 * archive in `list`, single result line per item in
 * purge/restore/rename. Non-zero exit on any failure. NO_COLOR / non-
 * TTY suppresses ANSI codes via the shared sink.
 *
 * SOLID lenses:
 *   - SRP: one module per concern. Subcommand dispatch lives here;
 *     archive primitives stay in `admin-api/routes/archive.ts` +
 *     `rename.ts`. CLI only orchestrates I/O + dispatch.
 *   - OCP: adding a subcommand = new handler + entry in dispatch map.
 *   - DIP: depends on admin-api `app.request` interface, not on
 *     individual route implementations.
 */
import type { OutputSink } from './assets-cli.js'
import { consoleSink } from './assets-cli.js'

export interface ArchiveSubcommandInput {
  /** All argv after the `archive` keyword. e.g. `['list']`, `['purge', 'old-page']`. */
  args: readonly string[]
  /** Project site directory. */
  siteDir: string
  /** Optional target name override. */
  targetName?: string
  /** Sink for output. Defaults to `consoleSink`. */
  sink?: OutputSink
  /** Test hook: skip `process.exit` on bad input. */
  exitOnError?: (code: number) => void
}

const SUBCOMMANDS = ['list', 'purge', 'restore', 'rename'] as const
type Subcommand = (typeof SUBCOMMANDS)[number]
type ItemKind = 'page' | 'fragment'

export async function runArchiveSubcommand(input: ArchiveSubcommandInput): Promise<void> {
  const sink = input.sink ?? consoleSink
  const exit = input.exitOnError ?? ((code: number) => process.exit(code))

  const subcommand = input.args[0]
  if (!subcommand || !isSubcommand(subcommand)) {
    printUsage(sink)
    exit(1)
    return
  }

  const flags = parseFlags(input.args.slice(1))
  const positional = flags.positional

  switch (subcommand) {
    case 'list':
      await runList({ siteDir: input.siteDir, targetName: input.targetName, kind: flags.kind, sink })
      return
    case 'purge': {
      const name = positional[0]
      if (!name) {
        sink.error('Usage: gazetta archive purge <name> [--kind=page|fragment] [--force]')
        exit(1)
        return
      }
      await runPurge({
        siteDir: input.siteDir,
        targetName: input.targetName,
        name,
        kind: flags.kind,
        force: flags.force,
        sink,
        exit,
      })
      return
    }
    case 'restore': {
      const name = positional[0]
      if (!name) {
        sink.error('Usage: gazetta archive restore <name> [--kind=page|fragment]')
        exit(1)
        return
      }
      await runRestore({
        siteDir: input.siteDir,
        targetName: input.targetName,
        name,
        kind: flags.kind,
        sink,
        exit,
      })
      return
    }
    case 'rename': {
      const [oldName, newName] = positional
      if (!oldName || !newName) {
        sink.error(
          'Usage: gazetta archive rename <oldname> <newname> [--kind=page|fragment] [--no-keep-alias] [--force]',
        )
        exit(1)
        return
      }
      await runRename({
        siteDir: input.siteDir,
        targetName: input.targetName,
        oldName,
        newName,
        kind: flags.kind,
        keepAlias: flags.keepAlias,
        force: flags.force,
        sink,
        exit,
      })
      return
    }
  }
}

function isSubcommand(s: string): s is Subcommand {
  return (SUBCOMMANDS as readonly string[]).includes(s)
}

function printUsage(sink: OutputSink): void {
  sink.error('Usage: gazetta archive <list|purge|restore|rename>')
  sink.error('  list [--kind=page|fragment]                                — list archived items')
  sink.error('  purge <name> [--kind=...] [--force]                        — permanently delete an archive')
  sink.error('  restore <name> [--kind=...]                                — unarchive (back to live)')
  sink.error(
    '  rename <oldname> <newname> [--kind=...] [--no-keep-alias] [--force]  — rename live item; keeps redirect by default',
  )
}

interface ParsedFlags {
  positional: string[]
  kind?: ItemKind
  force: boolean
  keepAlias: boolean
}

function parseFlags(args: readonly string[]): ParsedFlags {
  const positional: string[] = []
  let kind: ItemKind | undefined
  let force = false
  let keepAlias = true
  for (const arg of args) {
    if (arg === '--force') force = true
    else if (arg === '--no-keep-alias') keepAlias = false
    else if (arg === '--keep-alias') keepAlias = true
    else if (arg.startsWith('--kind=')) {
      const v = arg.slice('--kind='.length)
      if (v === 'page' || v === 'fragment') kind = v
    } else if (!arg.startsWith('--')) {
      positional.push(arg)
    }
  }
  return { positional, kind, force, keepAlias }
}

// ---------- shared admin-app construction ----------

interface AppContext {
  app: { request: (path: string, init?: RequestInit) => Response | Promise<Response> }
  source: { storage: import('../types.js').StorageProvider }
}

async function buildApp(siteDir: string, targetName?: string): Promise<AppContext> {
  const { buildSourceContext } = await import('./bootstrap.js')
  const { createAdminApp } = await import('../admin-api/index.js')
  const { isEditable } = await import('../types.js')
  const { source, targetConfigs } = await buildSourceContext({
    projectSiteDir: siteDir,
    targetName,
  })
  const editableTarget = targetName ?? Object.entries(targetConfigs).find(([, cfg]) => isEditable(cfg))?.[0]
  if (!editableTarget) throw new Error('No editable target found.')
  const app = createAdminApp({
    source,
    siteDir,
    templatesDir: `${siteDir}/templates`,
    targets: new Map([[editableTarget, source.storage]]),
    targetConfigs,
    disableCacheStatsLogger: true,
    disableAuditRetentionPruner: true,
  })
  return { app, source }
}

// ---------- subcommand handlers ----------

async function runList(opts: {
  siteDir: string
  targetName?: string
  kind?: ItemKind
  sink: OutputSink
}): Promise<void> {
  const { sink } = opts
  sink.blank()
  sink.heading('gazetta archive list')
  sink.blank()

  const { source } = await buildApp(opts.siteDir, opts.targetName)
  const archives = await collectArchives(source.storage, opts.kind)

  if (archives.length === 0) {
    sink.dim('No archived items.')
    sink.blank()
    return
  }

  // One line per archive — cron-friendly. Format:
  //   {kind}  {name}  {archivedAt}  →{aliasOf}|gone
  for (const a of archives) {
    const target = a.aliasOf ? `→${a.aliasOf}` : 'gone'
    sink.line(`${a.kind.padEnd(8)}  ${a.name.padEnd(40)}  ${a.archivedAt}  ${target}`)
  }
  sink.blank()
  sink.dim(`${archives.length} archived item(s).`)
  sink.blank()
}

async function runPurge(opts: {
  siteDir: string
  targetName?: string
  name: string
  kind?: ItemKind
  force: boolean
  sink: OutputSink
  exit: (code: number) => void
}): Promise<void> {
  const { sink } = opts
  const kind = await resolveKind(opts)
  if (!kind) {
    sink.error(`Archive not found: ${opts.name}`)
    opts.exit(1)
    return
  }
  const { app } = await buildApp(opts.siteDir, opts.targetName)
  const path = `/api/${kind}s/${opts.name}/purge${opts.force ? '?force=true' : ''}`
  const res = await app.request(path, { method: 'DELETE' })
  if (res.status === 200) {
    sink.line(`✓ Purged ${kind} ${opts.name}`)
    return
  }
  if (res.status === 409) {
    const body = (await res.json()) as { code?: string; aliases?: unknown[]; liveRefs?: unknown[] }
    sink.error(`Purge blocked: ${kind} ${opts.name} (${body.code ?? 'unknown'})`)
    if (Array.isArray(body.aliases) && body.aliases.length > 0) {
      sink.error(`  ${body.aliases.length} archive(s) alias here. Resolve via admin UI or pass --force.`)
    }
    if (Array.isArray(body.liveRefs) && body.liveRefs.length > 0) {
      sink.error(`  ${body.liveRefs.length} live ref(s). Resolve via admin UI or pass --force.`)
    }
    opts.exit(1)
    return
  }
  sink.error(`Purge failed: ${kind} ${opts.name} (HTTP ${res.status})`)
  opts.exit(1)
}

async function runRestore(opts: {
  siteDir: string
  targetName?: string
  name: string
  kind?: ItemKind
  sink: OutputSink
  exit: (code: number) => void
}): Promise<void> {
  const { sink } = opts
  const kind = await resolveKind(opts)
  if (!kind) {
    sink.error(`Archive not found: ${opts.name}`)
    opts.exit(1)
    return
  }
  const { app } = await buildApp(opts.siteDir, opts.targetName)
  const res = await app.request(`/api/${kind}s/${opts.name}/unarchive`, { method: 'POST' })
  if (res.status === 200) {
    sink.line(`✓ Restored ${kind} ${opts.name}`)
    return
  }
  // Surface the server's reason (e.g. the Manual Redirect restore
  // refusal from #1343) instead of a bare status line.
  let detail = ''
  try {
    const body = (await res.json()) as { error?: string }
    if (body.error) detail = `: ${body.error}`
  } catch {
    // Non-JSON error body — keep the status-only message.
  }
  sink.error(`Restore failed: ${kind} ${opts.name} (HTTP ${res.status})${detail}`)
  opts.exit(1)
}

async function runRename(opts: {
  siteDir: string
  targetName?: string
  oldName: string
  newName: string
  kind?: ItemKind
  keepAlias: boolean
  force: boolean
  sink: OutputSink
  exit: (code: number) => void
}): Promise<void> {
  const { sink } = opts
  // Rename targets a LIVE item (not an archive) — unlike purge/restore.
  // If --kind isn't supplied, look up which kind owns oldName among
  // live items.
  const kind = opts.kind ?? (await resolveLiveKind(opts.siteDir, opts.targetName, opts.oldName))
  if (!kind) {
    sink.error(`Live ${opts.kind ?? 'page or fragment'} not found: ${opts.oldName}`)
    opts.exit(1)
    return
  }
  const { app } = await buildApp(opts.siteDir, opts.targetName)
  const res = await app.request(`/api/${kind}s/${opts.oldName}/rename${opts.force ? '?force=true' : ''}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ to: opts.newName, keepAlias: opts.keepAlias }),
  })
  if (res.status === 200) {
    const action = opts.keepAlias ? `→${opts.newName} (alias)` : `→${opts.newName}`
    sink.line(`✓ Renamed ${kind} ${opts.oldName} ${action}`)
    return
  }
  if (res.status === 409) {
    const body = (await res.json()) as { code?: string; liveRefs?: Array<{ kind: string; name: string }> }
    sink.error(`Rename blocked: ${kind} ${opts.oldName} → ${opts.newName} (${body.code ?? 'conflict'})`)
    if (body.liveRefs && body.liveRefs.length > 0) {
      sink.error(
        `  Still used by ${body.liveRefs.map(r => `${r.kind}s/${r.name}`).join(', ')}. Keep the alias, or pass --force.`,
      )
    }
    opts.exit(1)
    return
  }
  sink.error(`Rename failed: ${kind} ${opts.oldName} → ${opts.newName} (HTTP ${res.status})`)
  opts.exit(1)
}

// ---------- helpers ----------

interface ArchiveSummary {
  kind: ItemKind
  name: string
  archivedAt: string
  aliasOf?: string
}

/**
 * Walk source manifests for archived items. Reads `pages/{name}/page.json`
 * and `fragments/{name}/fragment.json` recursively; filters where
 * `manifest.archived === true`.
 */
async function collectArchives(
  storage: import('../types.js').StorageProvider,
  kindFilter?: ItemKind,
): Promise<ArchiveSummary[]> {
  const archives: ArchiveSummary[] = []
  if (!kindFilter || kindFilter === 'page') {
    const pages = await walkManifests(storage, 'pages', 'page.json')
    for (const { name, manifest } of pages) {
      if (manifest.archived === true) {
        archives.push({
          kind: 'page',
          name,
          archivedAt: typeof manifest.archivedAt === 'string' ? manifest.archivedAt : '',
          ...(typeof manifest.aliasOf === 'string' ? { aliasOf: manifest.aliasOf } : {}),
        })
      }
    }
  }
  if (!kindFilter || kindFilter === 'fragment') {
    const frags = await walkManifests(storage, 'fragments', 'fragment.json')
    for (const { name, manifest } of frags) {
      if (manifest.archived === true) {
        archives.push({
          kind: 'fragment',
          name,
          archivedAt: typeof manifest.archivedAt === 'string' ? manifest.archivedAt : '',
          ...(typeof manifest.aliasOf === 'string' ? { aliasOf: manifest.aliasOf } : {}),
        })
      }
    }
  }
  archives.sort((a, b) => (a.archivedAt < b.archivedAt ? 1 : -1))
  return archives
}

async function walkManifests(
  storage: import('../types.js').StorageProvider,
  rootDir: string,
  filename: string,
): Promise<Array<{ name: string; manifest: Record<string, unknown> }>> {
  const found: Array<{ name: string; manifest: Record<string, unknown> }> = []
  const walk = async (dir: string, prefix: string): Promise<void> => {
    const entries = await storage.readDir(dir).catch(() => [])
    for (const entry of entries) {
      if (!entry.isDirectory) continue
      const subdir = `${dir}/${entry.name}`
      const manifestPath = `${subdir}/${filename}`
      if (await storage.exists(manifestPath)) {
        try {
          const raw = await storage.readFile(manifestPath)
          const parsed = JSON.parse(raw) as Record<string, unknown>
          found.push({ name: prefix + entry.name, manifest: parsed })
        } catch {
          // Malformed manifest — skip.
        }
      }
      // Recurse for nested names like blog/post-1.
      await walk(subdir, `${prefix}${entry.name}/`)
    }
  }
  await walk(rootDir, '')
  return found
}

/** Resolve which kind owns an archived `name` when --kind isn't supplied. */
async function resolveKind(opts: {
  siteDir: string
  targetName?: string
  name: string
  kind?: ItemKind
}): Promise<ItemKind | null> {
  if (opts.kind) return opts.kind
  const { source } = await buildApp(opts.siteDir, opts.targetName)
  const archives = await collectArchives(source.storage)
  const hit = archives.find(a => a.name === opts.name)
  return hit?.kind ?? null
}

/** Resolve which kind owns a LIVE `name` when --kind isn't supplied. */
async function resolveLiveKind(
  siteDir: string,
  targetName: string | undefined,
  name: string,
): Promise<ItemKind | null> {
  const { source } = await buildApp(siteDir, targetName)
  if (await source.storage.exists(`pages/${name}/page.json`)) return 'page'
  if (await source.storage.exists(`fragments/${name}/fragment.json`)) return 'fragment'
  return null
}
