/**
 * Item names (pages, fragments, assets) become folder paths under their
 * collection, so a name must stay inside it: no leading `/`, no
 * backslash, and no empty, `.` or `..` segment. `/` is allowed between
 * segments for nested items (`blog/post`).
 */
export function isSafeItemName(name: string): boolean {
  if (name.length === 0 || name.startsWith('/') || name.includes('\\')) return false
  return name.split('/').every(segment => segment !== '' && segment !== '.' && segment !== '..')
}

export const UNSAFE_ITEM_NAME_MESSAGE = "Names can't be empty, start with /, contain \\, or have an empty, . or .. part"
