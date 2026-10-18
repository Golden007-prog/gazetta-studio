/**
 * Move one item of the array at `path` inside `data`, returning a new object
 * (copied along the path only). `path` is rjsf's `fieldPathId.path` — the
 * field's keys and indexes from the form root, e.g. `['groups', 0, 'tags']`.
 *
 * Returns `null` when nothing would change: no array at `path`, an index out
 * of range, or `from === to`. Callers use that to skip the update and its
 * undo entry.
 */
export function reorderAtPath<T>(data: T, path: readonly (string | number)[], from: number, to: number): T | null {
  if (from === to) return null
  return update(data, path, 0, from, to) as T | null
}

function update(node: unknown, path: readonly (string | number)[], depth: number, from: number, to: number): unknown {
  if (depth === path.length) {
    if (!Array.isArray(node)) return null
    if (from < 0 || to < 0 || from >= node.length || to >= node.length) return null
    const next = [...node]
    const [moved] = next.splice(from, 1)
    next.splice(to, 0, moved)
    return next
  }
  if (node === null || typeof node !== 'object') return null
  const key = path[depth]
  const child = update((node as Record<string | number, unknown>)[key], path, depth + 1, from, to)
  if (child === null) return null
  if (Array.isArray(node)) {
    const copy = [...node]
    copy[key as number] = child
    return copy
  }
  return { ...(node as Record<string, unknown>), [key]: child }
}
