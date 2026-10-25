/**
 * True when `file` is `root` itself or lives under it (#1318).
 *
 * Uses path.relative rather than a string prefix check: win32 compares
 * case-insensitively (a drive letter's casing can differ between the
 * APIs that produced the two paths), a lookalike sibling (`root-old`)
 * is not inside, and a file on another drive yields an absolute
 * relative path. The path module is a parameter so tests can exercise
 * win32 and posix semantics from any host.
 */
import { isAbsolute, relative } from 'node:path'

/** The slice of the path module isInside needs; `path.win32` or `path.posix` in tests. */
export interface RelativePath {
  relative(from: string, to: string): string
  isAbsolute(path: string): boolean
}

export function isInside(root: string, file: string, p: RelativePath = { relative, isAbsolute }): boolean {
  const r = p.relative(root, file)
  return r === '' || (!r.startsWith('..') && !p.isAbsolute(r))
}
