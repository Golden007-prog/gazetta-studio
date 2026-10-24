/**
 * ContentRoot — the pair (storage, rootPath) that locates content on a
 * storage provider. Isolates the "where content lives" concern from the
 * "how to access bytes" concern, so callers can construct paths uniformly
 * without knowing whether the storage is cwd-rooted (with a prefix) or
 * target-rooted (with an empty root).
 *
 * Today: rootPath is typically the site directory (cwd-rooted storage).
 * Tomorrow: rootPath becomes `''` when storage is rooted at a target's
 * content. Callers that use ContentRoot don't change when that switch happens.
 */

import { join } from 'node:path'
import type { StorageProvider } from './types.js'

export interface ContentRoot {
  /** Storage provider used to read/write content. */
  readonly storage: StorageProvider
  /**
   * Path prefix applied to every content operation.
   * `''` means storage is already rooted at the content root (target-rooted).
   * A non-empty path means storage is rooted elsewhere and content lives at
   * this prefix (e.g. cwd-rooted storage with a siteDir prefix).
   */
  readonly rootPath: string
  /** Build a content-relative path, joining the root prefix with the given segments. */
  path(...segments: string[]): string
  /**
   * Inverse of `path(...)` — strip the root prefix from an absolute
   * storage path, yielding the content-relative form. Useful when a
   * caller has a fully-qualified path (e.g. from a site scan result)
   * and needs the canonical "pages/home/page.json" shape for a
   * snapshot key. Paths that don't live under `rootPath` pass through
   * unchanged — callers should treat that as a programmer error rather
   * than a runtime concern.
   */
  relative(path: string): string
}

/** Build a ContentRoot from a storage provider and an optional root prefix. */
export function createContentRoot(storage: StorageProvider, rootPath = ''): ContentRoot {
  return {
    storage,
    rootPath,
    path(...segments) {
      // A segment with `..` must not climb out of the content root;
      // routes reject such names first, this is the backstop.
      const relativePath = join(...segments)
      if (/^\.\.(?:[\\/]|$)/.test(relativePath)) {
        throw new Error(`Content path leaves the content root: ${segments.join('/')}`)
      }
      return rootPath ? join(rootPath, relativePath) : relativePath
    },
    relative(path) {
      if (!rootPath) return path
      const prefix = rootPath.endsWith('/') ? rootPath : rootPath + '/'
      return path.startsWith(prefix) ? path.slice(prefix.length) : path
    },
  }
}
