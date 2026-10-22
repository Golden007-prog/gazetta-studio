/**
 * Shared decision for whether a stored file may be served to a visitor.
 * Used by static `gazetta serve`; the worker, ESI serve, the static
 * deploy adapters and the probe reuse the same function (design:
 * .claude/rules/design-public-storage.md Q4). Free of server-specific
 * code so every surface shares one rule.
 *
 * Input is the decoded, normalised path (after `%2e%2e` has become
 * `..` and been resolved).
 *
 * A path is private when:
 * - any segment starts with `.` (covers `.gazetta/`, per-item
 *   `.{hash}.hash` / `.pub-*` sidecars, and unresolved `..` segments),
 *   except a first segment of exactly `.well-known`, which stays public
 *   (ACME challenges, security.txt, app association files) while
 *   dot-prefixed segments below it remain private;
 * - the final segment is one of Gazetta's reserved manifest names:
 *   `page.json`, `page.<anything>.json`, `fragment.json`,
 *   `fragment.<anything>.json`, `<name>.asset.json`,
 *   `<name>.asset.<anything>.json`. Any suffix matches, not only valid
 *   locales, because the site loader accepts any suffix. The match is
 *   case-insensitive: deployments on case-insensitive volumes resolve
 *   `PAGE.JSON` to the same stored file, and no public file needs a
 *   case variant of a reserved name.
 */

const MANIFEST_NAME = /^(?:page|fragment)(?:\.[^/]+)?\.json$|^[^/]+\.asset(?:\.[^/]+)?\.json$/i

export function isPublicSitePath(path: string): boolean {
  const segments = path.split('/').filter(Boolean)
  const start = segments[0] === '.well-known' ? 1 : 0
  for (let i = start; i < segments.length; i++) {
    if (segments[i].startsWith('.')) return false
  }
  const last = segments[segments.length - 1]
  if (last !== undefined && MANIFEST_NAME.test(last)) return false
  return true
}
