/**
 * HistoryProvider implementation on top of any StorageProvider.
 *
 * Layout per target (inside `.gazetta/history/` under the target's
 * storage root):
 *
 *   index.json                     { revisions: ['rev-0001', ...] }
 *   revisions/rev-NNNN.json        one manifest per revision — metadata +
 *                                  items map (itemPath → blob hash)
 *   objects/<hh>/<rest>            content-addressed blobs (SHA-256, sharded
 *                                  by first 2 hex chars)
 *
 * Design-decisions.md #18:
 *  - One uniform approach across all providers (no native versioning).
 *  - Content-addressed blobs → unchanged items share storage across
 *    revisions; storage scales with unique content, not revision count.
 *  - Soft undo only — every restore writes a new forward revision.
 *  - Retention default 50; oldest evicted on write.
 *
 * SRP: this module owns .gazetta/history/ layout and retention. Nothing
 * else. The write pipeline (save/publish) calls `recordRevision`; undo/
 * rollback call `readRevision` + `readBlob`. Restore happens outside —
 * this module doesn't touch the content tree.
 */

import { createHash } from 'node:crypto'
import type { StorageProvider } from './types.js'
import type { BlobContent, HistoryProvider, Revision, RevisionInput, RevisionManifest } from './history.js'
import { DEFAULT_HISTORY_RETENTION } from './types.js'

export interface CreateHistoryProviderOptions {
  /** Storage under which `.gazetta/history/` lives. Usually the target's storage. */
  storage: StorageProvider
  /**
   * Path prefix where history lives. Default: `.gazetta/history`. Callers
   * with a rooted storage (filesystem target with `path:`) pass the
   * default; anything more exotic (e.g. history under a sub-prefix)
   * overrides.
   */
  rootPath?: string
  /**
   * Maximum number of revisions to keep; older ones evicted on write.
   * Default: `DEFAULT_HISTORY_RETENTION` (50). Pass < 1 → clamped to 1
   * (zero retention would self-evict every write).
   */
  retention?: number
}

/**
 * Shape of the history index file. Kept minimal — the list is append-
 * heavy and read-cheap, so we serialize the full ordered id list
 * rather than try to be clever. Oldest first, newest last.
 *
 * IDs are timestamp-based (`rev-<unixMillis>[-<seq>]`) so retention
 * evictions stay auditable ("what happened around Jan 5?") and lex-
 * sort matches chronological order. See `formatId` for the full scheme.
 */
interface HistoryIndex {
  /** Revision ids in creation order (oldest first). */
  revisions: string[]
}

/**
 * Build a HistoryProvider backed by the given storage. No I/O happens
 * at construction time — everything is lazy on first call.
 */
export function createHistoryProvider(opts: CreateHistoryProviderOptions): HistoryProvider {
  const { storage } = opts
  const root = opts.rootPath ?? '.gazetta/history'
  const retention = Math.max(1, opts.retention ?? DEFAULT_HISTORY_RETENTION)
  const indexPath = join(root, 'index.json')

  /** Read the index or return an empty one if it doesn't exist yet. */
  async function readIndex(): Promise<HistoryIndex> {
    if (!(await storage.exists(indexPath))) {
      return { revisions: [] }
    }
    const parsed = JSON.parse(await storage.readFile(indexPath)) as HistoryIndex & { nextId?: number }
    // Forward-compat: tolerate legacy `nextId` by ignoring it. Old indexes
    // (from the numeric-id era) continue to read cleanly, new writes use
    // the timestamp scheme. No migration pass needed — retention naturally
    // evicts the legacy ids over time.
    return { revisions: parsed.revisions ?? [] }
  }

  /**
   * Ensure the parent directory exists before writing. Object-store
   * providers (R2, S3) ignore mkdir. Filesystem requires it because
   * `writeFile` fails on missing parents, and our sharded blob paths
   * (objects/<hh>/<rest>) plus revisions/rev-NNNN.json live in dirs
   * that don't exist until the first write.
   */
  async function writeWithParents(path: string, content: string): Promise<void> {
    const parent = path.substring(0, path.lastIndexOf('/'))
    if (parent) await storage.mkdir(parent)
    await storage.writeFile(path, content)
  }

  async function writeIndex(idx: HistoryIndex): Promise<void> {
    await writeWithParents(indexPath, JSON.stringify(idx, null, 2) + '\n')
  }

  function blobPath(hash: string): string {
    // Shard by first two hex chars — keeps any one `objects/` subdirectory
    // from ballooning past a few thousand entries on large sites.
    return join(root, 'objects', hash.slice(0, 2), hash.slice(2))
  }

  function revisionPath(id: string): string {
    return join(root, 'revisions', `${id}.json`)
  }

  /**
   * SHA-256 hex of the content. Strong enough that collisions can be
   * ignored for practical purposes (blob identity), cheap enough at
   * our scale (tens of KB per item, hundreds of items per revision).
   *
   * Accepts both text and bytes per Q9 lock. Text encodes UTF-8 first
   * — matches the bytes that would be written through `writeFile`,
   * so a string blob and a `Uint8Array` of its UTF-8 encoding hash
   * to the same value (and dedupe correctly).
   */
  function hashContent(content: BlobContent): string {
    const bytes = content instanceof Uint8Array ? content : Buffer.from(content, 'utf-8')
    return createHash('sha256').update(bytes).digest('hex')
  }

  /**
   * Allocate a fresh revision id. Scheme: `rev-<unixMillis>`, with a
   * `-<seq>` suffix on same-millisecond collisions ("rev-1760...050",
   * "rev-1760...050-2", ...). Collision tracking uses the current
   * index's revisions list — assumes no concurrent writers against
   * the same target (already true: Gazetta never has two admins
   * writing the same target's history simultaneously).
   *
   * Why millis + suffix rather than a monotonic counter:
   *   - Retention evictions leave you with a window of revisions you
   *     can date-read from the filename alone.
   *   - No counter to overflow or reset when history is disabled then
   *     re-enabled.
   *   - Lex-sort = chrono sort (13-digit ms are fixed-width through
   *     year 5138 AD).
   *
   * `_clock` is injectable for deterministic tests — production uses
   * Date.now(). Stays private to createHistoryProvider.
   */
  function formatId(existing: readonly string[], now: number): string {
    const base = `rev-${now}`
    if (!existing.some(id => id === base || id.startsWith(`${base}-`))) return base
    // Same-millisecond collision: bump the suffix. Start from 2 so the
    // first duplicate gets `-2` (matches the mental model "base, then
    // the second, then the third").
    let seq = 2
    while (existing.includes(`${base}-${seq}`)) seq += 1
    return `${base}-${seq}`
  }

  /**
   * Write any blob that's not already stored. Returns the hash. Dedup
   * check is a single `exists()` — cheaper than reading the existing
   * blob to confirm equal content (hashes collide vanishingly).
   *
   * Always goes through `writeBytes` — text content is encoded UTF-8
   * first. Uniform bytes-in / bytes-out means binary blobs (asset
   * bytes, variants, fonts) round-trip without a string detour, and
   * text blobs round-trip through their UTF-8 encoding (same bytes
   * `writeFile` would have stored).
   */
  async function writeBlob(content: BlobContent): Promise<string> {
    const hash = hashContent(content)
    const path = blobPath(hash)
    if (await storage.exists(path)) return hash
    const parent = path.substring(0, path.lastIndexOf('/'))
    if (parent) await storage.mkdir(parent)
    const bytes = content instanceof Uint8Array ? content : Buffer.from(content, 'utf-8')
    await storage.writeBytes(path, bytes)
    return hash
  }

  async function recordRevision(input: RevisionInput): Promise<Revision> {
    const idx = await readIndex()
    const id = formatId(idx.revisions, Date.now())

    // Write blobs (dedup via content-addressing) and build the
    // path → hash snapshot.
    const snapshot: Record<string, string> = {}
    // Deterministic order so rev manifests diff cleanly on inspection.
    const sortedEntries = [...input.items.entries()].sort((a, b) => a[0].localeCompare(b[0]))
    for (const [path, content] of sortedEntries) {
      snapshot[path] = await writeBlob(content)
    }

    const manifest: RevisionManifest = {
      id,
      timestamp: new Date().toISOString(),
      operation: input.operation,
      author: input.author,
      source: input.source,
      items: [...input.items.keys()].sort(),
      message: input.message,
      restoredFrom: input.restoredFrom,
      snapshot,
    }
    await writeWithParents(revisionPath(id), JSON.stringify(manifest, null, 2) + '\n')

    // Update the index (append) then apply retention. Do the index
    // write last so a mid-write failure leaves orphan blobs and an
    // orphan manifest (both harmless) rather than a dangling index
    // entry pointing at a missing manifest.
    idx.revisions.push(id)
    await writeIndex(idx)
    await applyRetention(idx)

    // Return the public Revision shape (no snapshot).
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    const { snapshot: _snapshot, ...revision } = manifest
    return revision
  }

  /**
   * Evict oldest revisions to fit `retention`. Deletes manifests; blobs
   * become eligible for GC if no remaining revision references them.
   * GC is lazy — blob files stay until an explicit GC pass, which is
   * fine for v1 (disk is cheap; a future `gazetta gc` command can walk
   * all manifests and prune orphans).
   */
  async function applyRetention(idx: HistoryIndex): Promise<void> {
    const excess = idx.revisions.length - retention
    if (excess <= 0) return
    const toEvict = idx.revisions.slice(0, excess)
    idx.revisions = idx.revisions.slice(excess)
    for (const id of toEvict) {
      const path = revisionPath(id)
      if (await storage.exists(path)) await storage.rm(path)
    }
    await writeIndex(idx)
  }

  async function listRevisions(limit?: number): Promise<Revision[]> {
    const idx = await readIndex()
    const ids = [...idx.revisions].reverse() // newest first
    const sliced = typeof limit === 'number' ? ids.slice(0, limit) : ids
    // Read manifests in parallel; strip snapshot for the summary list.
    return Promise.all(
      sliced.map(async id => {
        const m = await readManifest(id)
        // eslint-disable-next-line @typescript-eslint/no-unused-vars
        const { snapshot: _snapshot, ...rev } = m
        return rev
      }),
    )
  }

  async function readManifest(id: string): Promise<RevisionManifest> {
    return JSON.parse(await storage.readFile(revisionPath(id))) as RevisionManifest
  }

  async function readRevision(id: string): Promise<RevisionManifest> {
    return readManifest(id)
  }

  async function readBlob(hash: string): Promise<Uint8Array> {
    // Bytes-in / bytes-out — binary blobs (asset bytes, variants,
    // fonts) round-trip without a string-decode detour; text blobs
    // (manifests, YAML, etc.) come back as their UTF-8 byte form
    // and callers that expect text decode at the boundary.
    return storage.readBytes(blobPath(hash))
  }

  async function deleteRevision(id: string): Promise<void> {
    const idx = await readIndex()
    const at = idx.revisions.indexOf(id)
    if (at === -1) return
    idx.revisions.splice(at, 1)
    await writeIndex(idx)
    const path = revisionPath(id)
    if (await storage.exists(path)) await storage.rm(path)
    // Orphan blobs left for lazy GC — see applyRetention rationale.
  }

  return {
    recordRevision,
    listRevisions,
    readRevision,
    readBlob,
    deleteRevision,
  }
}

/**
 * `posix.join` behavior without importing it — keeps the module self-
 * contained and works identically across platforms. Storage providers
 * normalize separators internally, but our stored paths are POSIX.
 */
function join(...parts: string[]): string {
  return parts.filter(Boolean).join('/').replace(/\/+/g, '/')
}
