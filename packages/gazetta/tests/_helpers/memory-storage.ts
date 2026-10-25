/**
 * In-memory `StorageProvider` for tests — single source of truth.
 *
 * Stores raw bytes internally; the text I/O methods (`readFile` /
 * `writeFile`) encode/decode UTF-8 at the boundary so binary blobs
 * (history-stored asset bytes) round-trip cleanly while text content
 * is identical to what a string-only mock would have stored.
 *
 * Why one shared helper instead of inline mocks:
 *   - The `StorageProvider` interface has six methods (text, bytes,
 *     stream pairs). Duplicating across N tests means every interface
 *     change touches N mocks. One helper, one update.
 *   - Tests that exercise different I/O patterns (history blobs,
 *     manifest reads, rare stream usage) all need the same surface
 *     even if they don't call every method. Stub-then-fail at the
 *     surface that's actually called keeps test failures honest.
 *
 * # Test contract
 *
 * - `readFile` / `writeFile`: text round-trip via UTF-8.
 * - `readBytes` / `writeBytes`: bytes-in / bytes-out, no encoding.
 * - `readStream` / `writeStream`: implemented for completeness;
 *    callers that exercise streaming get correct behavior. Single-
 *    chunk streams — fine for bounded test inputs.
 * - `readDir`: returns a flat-derived directory listing (mock has no
 *   real directories; segments inferred from key prefixes).
 * - `mkdir`: no-op (flat key-value store).
 * - `rm`: deletes one path or every path under the prefix (dir-like).
 *
 * `dump()` and `seed()` are test-only escape hatches for inspecting
 * and pre-populating storage state.
 */
import type { ByteRange, DirEntry, StorageProvider } from '../../src/types.js'

export interface MemoryStorage extends StorageProvider {
  /** Inspect the entire storage map. Bytes are the canonical form. */
  dump(): Map<string, Uint8Array>
  /** Pre-populate with text entries (encoded UTF-8 internally). */
  seed(entries: Record<string, string>): void
  /** Pre-populate with byte entries. */
  seedBytes(entries: Record<string, Uint8Array>): void
}

/**
 * Construct a fresh in-memory storage. Each call returns an independent
 * map so tests don't share state. Backed by `Map<string, Uint8Array>`
 * — bytes are the canonical form; text reads/writes encode UTF-8.
 */
export function memoryStorage(): MemoryStorage {
  const files = new Map<string, Uint8Array>()
  const enc = new TextEncoder()
  const dec = new TextDecoder()

  return {
    async readFile(path: string): Promise<string> {
      const v = files.get(path)
      if (v === undefined) throw new Error(`ENOENT: ${path}`)
      return dec.decode(v)
    },
    async writeFile(path: string, content: string): Promise<void> {
      files.set(path, enc.encode(content))
    },
    async readBytes(path: string): Promise<Uint8Array> {
      const v = files.get(path)
      if (v === undefined) throw new Error(`ENOENT: ${path}`)
      return v
    },
    async writeBytes(path: string, content: Uint8Array): Promise<void> {
      files.set(path, content)
    },
    async readStream(path: string, range?: ByteRange): Promise<ReadableStream<Uint8Array>> {
      const v = files.get(path)
      if (v === undefined) throw new Error(`ENOENT: ${path}`)
      // Same contract as the filesystem provider: reject ranges that
      // can't be served, clamp an over-long end to the stored length.
      if (range && (range.start < 0 || range.end < range.start || range.start >= v.length)) {
        throw new Error(`Invalid range for ${path}: start=${range.start}, end=${range.end}, size=${v.length}`)
      }
      const bytes = range ? v.slice(range.start, Math.min(range.end + 1, v.length)) : v
      return new ReadableStream({
        start(controller) {
          controller.enqueue(bytes)
          controller.close()
        },
      })
    },
    async writeStream(path: string, stream: ReadableStream<Uint8Array>): Promise<void> {
      const reader = stream.getReader()
      const chunks: Uint8Array[] = []
      let total = 0
      // eslint-disable-next-line no-constant-condition
      while (true) {
        const { done, value } = await reader.read()
        if (done) break
        chunks.push(value)
        total += value.byteLength
      }
      const buf = new Uint8Array(total)
      let offset = 0
      for (const c of chunks) {
        buf.set(c, offset)
        offset += c.byteLength
      }
      files.set(path, buf)
    },
    async exists(path: string): Promise<boolean> {
      if (files.has(path)) return true
      // Treat as directory if any entry sits under the prefix.
      const prefix = path.endsWith('/') ? path : path + '/'
      for (const p of files.keys()) {
        if (p.startsWith(prefix)) return true
      }
      return false
    },
    async readDir(path: string): Promise<DirEntry[]> {
      const prefix = path.endsWith('/') ? path : path + '/'
      // Collect both immediate children and pseudo-directories (from
      // entries deeper in the tree). A name is a directory iff anything
      // exists beneath it.
      const dirs = new Set<string>()
      const fileNames = new Set<string>()
      for (const p of files.keys()) {
        if (!p.startsWith(prefix)) continue
        const rest = p.slice(prefix.length)
        const seg = rest.split('/')[0]
        if (!seg) continue
        if (rest.includes('/')) dirs.add(seg)
        else fileNames.add(seg)
      }
      return [
        ...[...dirs].map(name => ({ name, isDirectory: true })),
        ...[...fileNames].filter(n => !dirs.has(n)).map(name => ({ name, isDirectory: false })),
      ]
    },
    async mkdir(): Promise<void> {
      // Flat store; nothing to do.
    },
    async rm(path: string): Promise<void> {
      files.delete(path)
      const prefix = path.endsWith('/') ? path : path + '/'
      for (const p of [...files.keys()]) {
        if (p.startsWith(prefix)) files.delete(p)
      }
    },
    dump() {
      return files
    },
    seed(entries) {
      for (const [k, v] of Object.entries(entries)) files.set(k, enc.encode(v))
    },
    seedBytes(entries) {
      for (const [k, v] of Object.entries(entries)) files.set(k, v)
    },
  }
}
