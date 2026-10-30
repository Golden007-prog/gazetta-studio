import { join } from 'node:path'
import type { StorageProvider } from './types.js'
import type { ContentRoot } from './content-root.js'
import { mapLimit } from './concurrency.js'

export interface PublishResult {
  target: string
  success: boolean
  error?: string
  copiedFiles: number
}

/**
 * Copy items from source storage to target storage.
 * Items are relative paths like "pages/home" or "fragments/header".
 * Page and fragment items copy their own files and ordinary subfolders,
 * excluding descendant directories with their own page/fragment manifest.
 * Other item kinds retain recursive copying. Fetch callers can opt into
 * including nested items to copy an entire content subtree.
 */
export async function publishItems(
  sourceRoot: ContentRoot,
  targetRoot: ContentRoot,
  items: string[],
  options: { includeNestedItems?: boolean } = {},
): Promise<{ copiedFiles: number }> {
  const { storage: sourceStorage, rootPath: sourceBase } = sourceRoot
  const { storage: targetStorage, rootPath: targetBase } = targetRoot

  // Copy items in parallel (bounded).
  const counts = await mapLimit(items, async item => {
    const sourcePath = join(sourceBase, item)
    const targetPath = join(targetBase, item)
    const skipNestedItems = !options.includeNestedItems && (item.startsWith('pages/') || item.startsWith('fragments/'))
    return copyRecursive(sourceStorage, sourcePath, targetStorage, targetPath, skipNestedItems)
  })
  const copiedFiles = counts.reduce((a, b) => a + b, 0)

  return { copiedFiles }
}

async function copyRecursive(
  source: StorageProvider,
  sourcePath: string,
  target: StorageProvider,
  targetPath: string,
  skipNestedItems: boolean,
): Promise<number> {
  // Check if sourcePath is a file
  try {
    const content = await source.readFile(sourcePath)
    await target.mkdir(dirname(targetPath))
    await target.writeFile(targetPath, content)
    return 1
  } catch {
    // Not a file — try as directory
  }

  // Try as directory
  if (!(await source.exists(sourcePath))) return 0

  const entries = await source.readDir(sourcePath)
  await target.mkdir(targetPath)

  // Bounded-parallel copy of children. Sequential would be O(n) wall time;
  // at 10k files on cloud storage that's minutes of serial I/O latency.
  const counts = await mapLimit(entries, async entry => {
    const childSource = join(sourcePath, entry.name)
    const childTarget = join(targetPath, entry.name)
    if (entry.isDirectory) {
      if (
        skipNestedItems &&
        ((await source.exists(join(childSource, 'page.json'))) ||
          (await source.exists(join(childSource, 'fragment.json'))))
      ) {
        return 0
      }
      return copyRecursive(source, childSource, target, childTarget, skipNestedItems)
    }
    const content = await source.readFile(childSource)
    await target.writeFile(childTarget, content)
    return 1
  })

  return counts.reduce((a, b) => a + b, 0)
}

function dirname(path: string): string {
  const parts = path.split('/')
  parts.pop()
  return parts.join('/')
}

/**
 * Resolve dependencies for published items.
 * Given a list of items (pages/fragments), find all referenced templates and fragments.
 */
export async function resolveDependencies(sourceRoot: ContentRoot, items: string[]): Promise<string[]> {
  const { storage, rootPath: siteBase } = sourceRoot
  const allItems = new Set(items)
  const visited = new Set<string>()

  for (const item of items) {
    await collectDependencies(storage, siteBase, item, allItems, visited)
  }

  return [...allItems]
}

async function collectDependencies(
  storage: StorageProvider,
  siteBase: string,
  item: string,
  allItems: Set<string>,
  visited: Set<string>,
): Promise<void> {
  if (visited.has(item)) return
  visited.add(item)

  const manifestNames = ['page.json', 'fragment.json']
  let manifest: Record<string, unknown> | null = null
  const itemPath = join(siteBase, item)

  for (const name of manifestNames) {
    try {
      manifest = JSON.parse(await storage.readFile(join(itemPath, name)))
      break
    } catch {
      continue
    }
  }

  if (!manifest) return

  if (typeof manifest.template === 'string') {
    allItems.add(`templates/${manifest.template}`)
  }

  if (Array.isArray(manifest.components)) {
    await collectComponentDeps(manifest.components, storage, siteBase, allItems, visited)
  }
}

async function collectComponentDeps(
  components: unknown[],
  storage: StorageProvider,
  siteBase: string,
  allItems: Set<string>,
  visited: Set<string>,
): Promise<void> {
  for (const entry of components) {
    if (typeof entry === 'string' && entry.startsWith('@')) {
      const fragName = entry.slice(1)
      allItems.add(`fragments/${fragName}`)
      await collectDependencies(storage, siteBase, `fragments/${fragName}`, allItems, visited)
    } else if (typeof entry === 'object' && entry !== null) {
      const comp = entry as Record<string, unknown>
      if (typeof comp.template === 'string') {
        allItems.add(`templates/${comp.template}`)
      }
      if (Array.isArray(comp.components)) {
        await collectComponentDeps(comp.components, storage, siteBase, allItems, visited)
      }
    }
  }
}

/**
 * Reverse-dependency lookup: given a fragment name, return the pages and
 * fragments that reference it (transitively). Used by the admin UI to show
 * "publishing @header affects: home, about, blog".
 *
 * On static targets, those pages need to be republished too — fragments are
 * baked into pages at publish time. On ESI targets, republishing the fragment
 * alone suffices because the edge composer resolves @fragments per request.
 */
export async function findFragmentDependents(
  sourceRoot: ContentRoot,
  fragmentName: string,
): Promise<{ pages: string[]; fragments: string[] }> {
  return findFragmentDependentsImpl(sourceRoot.storage, sourceRoot.rootPath, fragmentName)
}

async function findFragmentDependentsImpl(
  storage: StorageProvider,
  siteBase: string,
  fragmentName: string,
): Promise<{ pages: string[]; fragments: string[] }> {
  const pages = new Set<string>()
  const fragments = new Set<string>()

  // Build an index of every manifest → direct @ references
  const manifestsToScan: { kind: 'page' | 'fragment'; name: string }[] = []
  for (const kind of ['pages', 'fragments'] as const) {
    try {
      const entries = await storage.readDir(join(siteBase, kind))
      for (const e of entries) {
        if (e.isDirectory) manifestsToScan.push({ kind: kind === 'pages' ? 'page' : 'fragment', name: e.name })
      }
    } catch {
      /* missing dir */
    }
  }

  function walkComponents(components: unknown[] | undefined, out: string[]) {
    if (!Array.isArray(components)) return
    for (const entry of components) {
      if (typeof entry === 'string' && entry.startsWith('@')) out.push(entry.slice(1))
      else if (typeof entry === 'object' && entry !== null) {
        walkComponents((entry as { components?: unknown[] }).components, out)
      }
    }
  }

  // Read every manifest in parallel (bounded) and index refs in memory.
  // Past this point the BFS is a map lookup, not storage I/O — so it stays
  // fast even at 10k items.
  const directRefs = new Map<string, string[]>()
  await mapLimit(manifestsToScan, async item => {
    const refs: string[] = []
    const manifestName = item.kind === 'page' ? 'page.json' : 'fragment.json'
    const dir = item.kind === 'page' ? 'pages' : 'fragments'
    try {
      const raw = await storage.readFile(join(siteBase, dir, item.name, manifestName))
      const manifest = JSON.parse(raw) as { components?: unknown[] }
      walkComponents(manifest.components, refs)
    } catch {
      /* skip unreadable */
    }
    directRefs.set(`${item.kind}:${item.name}`, refs)
  })

  // BFS: find everything that transitively references `fragmentName`.
  const queue = [fragmentName]
  const seen = new Set<string>([`fragment:${fragmentName}`])
  while (queue.length) {
    const current = queue.shift()!
    for (const item of manifestsToScan) {
      const key = `${item.kind}:${item.name}`
      if (seen.has(key)) continue
      const refs = directRefs.get(key) ?? []
      if (refs.includes(current)) {
        seen.add(key)
        if (item.kind === 'page') pages.add(item.name)
        else {
          fragments.add(item.name)
          queue.push(item.name)
        }
      }
    }
  }

  return { pages: [...pages].sort(), fragments: [...fragments].sort() }
}

/**
 * Fast path for finding dependents against a *published* target — or
 * any source/target carrying the fragment-deps reverse-sidecar index.
 *
 * Uses `.gazetta/fragment-deps/{fragment}/{item}` per-edge sidecars
 * (written by save handlers and the publish flow). One readDir per
 * fragment in the BFS — for "fragment used by 5 pages", that's 1
 * readDir; for transitive "X → Y → Z", BFS of 3 readDirs total.
 *
 * Compares to the legacy walk, which did one listSidecars per item
 * directory across the whole site (~N readDirs). Measurements are
 * recorded in design-media-implementation.md ("Asset refs — per-edge
 * sidecar index").
 *
 * Handles transitive fragment→fragment dependencies via BFS: if
 * @inner is referenced by @outer which is referenced by pages/home,
 * querying "@inner" returns home and @outer.
 */
export async function findDependentsFromSidecars(
  sourceRoot: ContentRoot,
  query: { fragment: string },
): Promise<{ pages: string[]; fragments: string[] }> {
  const { readDepsForFragment } = await import('./fragment-deps.js')
  const pages = new Set<string>()
  const fragments = new Set<string>()
  const queue = [query.fragment]
  const seen = new Set<string>([query.fragment])
  while (queue.length) {
    const current = queue.shift()!
    const deps = await readDepsForFragment(sourceRoot, current)
    for (const dep of deps) {
      if (dep.source === 'page') {
        pages.add(dep.name)
      } else if (!seen.has(dep.name)) {
        seen.add(dep.name)
        fragments.add(dep.name)
        queue.push(dep.name)
      }
    }
  }
  return { pages: [...pages].sort(), fragments: [...fragments].sort() }
}
