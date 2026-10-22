import { createReadStream } from 'node:fs'
import { access, mkdir, readdir, readFile, rm, stat } from 'node:fs/promises'
import { join } from 'node:path'
import type { ByteRange, DirEntry, StorageProvider } from '../types.js'
import { atomicWriteBytes, atomicWriteStream, atomicWriteString } from './_atomic-write.js'
import { nodeReadableToWeb } from './_stream-interop.js'

/**
 * Filesystem storage provider. A thin adapter over `node:fs` — all atomicity
 * and stream-interop concerns are delegated to sibling modules.
 */
export function createFilesystemProvider(basePath?: string): StorageProvider {
  function resolvePath(path: string): string {
    return basePath ? join(basePath, path) : path
  }

  return {
    async readFile(path: string): Promise<string> {
      const fullPath = resolvePath(path)
      try {
        return await readFile(fullPath, 'utf-8')
      } catch (err) {
        const code = (err as NodeJS.ErrnoException).code
        if (code === 'ENOENT') throw new Error(`File not found: ${fullPath}`)
        throw new Error(`Cannot read ${fullPath}: ${(err as Error).message}`)
      }
    },

    async readDir(path: string): Promise<DirEntry[]> {
      const fullPath = resolvePath(path)
      try {
        const entries = await readdir(fullPath, { withFileTypes: true })
        return entries.map(e => ({ name: e.name, isDirectory: e.isDirectory() }))
      } catch (err) {
        const code = (err as NodeJS.ErrnoException).code
        if (code === 'ENOENT') throw new Error(`Directory not found: ${fullPath}`)
        throw new Error(`Cannot read directory ${fullPath}: ${(err as Error).message}`)
      }
    },

    async exists(path: string): Promise<boolean> {
      try {
        await access(resolvePath(path))
        return true
      } catch (err) {
        // "Path cannot exist" answers from the filesystem map to false:
        // ENOENT (genuinely missing), ENOTDIR (an ancestor is a file,
        // so the path cannot exist), ENAMETOOLONG (unrepresentable).
        // Anything else - typically EACCES from an unsearchable
        // ancestor directory - means "cannot tell", and must surface:
        // callers probing absence (the history baseline scan,
        // rm-ignore-missing) would otherwise mistake a permission
        // error for a missing path and record or restore over real
        // content (#1105 review, #1106).
        const code = (err as NodeJS.ErrnoException).code
        if (code === 'ENOENT' || code === 'ENOTDIR' || code === 'ENAMETOOLONG') return false
        throw err
      }
    },

    async writeFile(path: string, content: string): Promise<void> {
      const fullPath = resolvePath(path)
      try {
        await atomicWriteString(fullPath, content)
      } catch (err) {
        throw new Error(`Cannot write ${fullPath}: ${(err as Error).message}`)
      }
    },

    async readBytes(path: string): Promise<Uint8Array> {
      const fullPath = resolvePath(path)
      try {
        // node:fs/promises readFile without encoding returns a Buffer (which
        // extends Uint8Array). Return as-is — callers see a Uint8Array view.
        return await readFile(fullPath)
      } catch (err) {
        const code = (err as NodeJS.ErrnoException).code
        if (code === 'ENOENT') throw new Error(`File not found: ${fullPath}`)
        throw new Error(`Cannot read ${fullPath}: ${(err as Error).message}`)
      }
    },

    async writeBytes(path: string, content: Uint8Array): Promise<void> {
      const fullPath = resolvePath(path)
      try {
        await atomicWriteBytes(fullPath, content)
      } catch (err) {
        throw new Error(`Cannot write ${fullPath}: ${(err as Error).message}`)
      }
    },

    async mkdir(path: string): Promise<void> {
      const fullPath = resolvePath(path)
      try {
        await mkdir(fullPath, { recursive: true })
      } catch (err) {
        throw new Error(`Cannot create directory ${fullPath}: ${(err as Error).message}`)
      }
    },

    async rm(path: string): Promise<void> {
      const fullPath = resolvePath(path)
      try {
        await rm(fullPath, { recursive: true })
      } catch (err) {
        throw new Error(`Cannot delete ${fullPath}: ${(err as Error).message}`)
      }
    },

    async readStream(path: string, range?: ByteRange): Promise<ReadableStream<Uint8Array>> {
      const fullPath = resolvePath(path)
      let size: number
      try {
        size = (await stat(fullPath)).size
      } catch (err) {
        const code = (err as NodeJS.ErrnoException).code
        if (code === 'ENOENT') throw new Error(`File not found: ${fullPath}`)
        throw new Error(`Cannot stat ${fullPath}: ${(err as Error).message}`)
      }

      if (range && (range.start < 0 || range.end < range.start || range.start >= size)) {
        throw new Error(`Invalid range for ${fullPath}: start=${range.start}, end=${range.end}, size=${size}`)
      }

      // Node's createReadStream honors inclusive start/end — matches our ByteRange
      // contract and HTTP Range semantics (RFC 9110 §14.1.2).
      const nodeStream = range
        ? createReadStream(fullPath, { start: range.start, end: range.end })
        : createReadStream(fullPath)

      return nodeReadableToWeb(nodeStream)
    },

    async writeStream(path: string, stream: ReadableStream<Uint8Array>): Promise<void> {
      const fullPath = resolvePath(path)
      try {
        await atomicWriteStream(fullPath, stream)
      } catch (err) {
        throw new Error(`Cannot write stream to ${fullPath}: ${(err as Error).message}`)
      }
    },
  }
}
