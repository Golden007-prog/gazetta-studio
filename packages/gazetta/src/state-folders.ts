/**
 * The only module that knows the names under a target's `.gazetta/`
 * namespace. Every `.gazetta/` path is built through `stateFolderPath`,
 * so an unregistered folder cannot be written; a scan test
 * (tests/state-folders-scan.test.ts) fails on any `.gazetta` path
 * literal outside this file.
 *
 * Each entry also records whether the folder may be written on a public
 * target. The gates that read `safeOnPublic` together with
 * `isPublicStorage` land with public-storage cut 4; until then the flag
 * is data only. Folders that exist only in designs are deliberately not
 * listed: the cut that first writes one adds its entry.
 *
 * The module is pure (no node imports) so the Cloudflare worker can
 * import it.
 */

export const STATE_ROOT = '.gazetta'

export const STATE_FOLDERS = {
  history: { safeOnPublic: false },
  audit: { safeOnPublic: false },
  review: { safeOnPublic: false },
  'fragment-deps': { safeOnPublic: false },
  'asset-refs': { safeOnPublic: false },
  'alias-targets': { safeOnPublic: false },
  'publish-generation': { safeOnPublic: true },
} as const

export type StateFolder = keyof typeof STATE_FOLDERS

/**
 * Folders holding sensitive state: past versions, actor identities and
 * approvers (design-public-storage.md Q6). A public target that still
 * holds any of them fails validation, and `gazetta state remove`
 * deletes exactly these. The dependency indices aren't safe on public
 * targets either, but they aren't sensitive, so they aren't listed.
 */
export const SENSITIVE_STATE_FOLDERS = ['history', 'audit', 'review'] as const satisfies readonly StateFolder[]

export type SensitiveStateFolder = (typeof SENSITIVE_STATE_FOLDERS)[number]

/**
 * Root-relative path `.gazetta/<folder>/<segments...>`, joined with
 * `/`. Callers that need a content-root-prefixed path pass the result
 * to `contentRoot.path(...)`.
 */
export function stateFolderPath(folder: StateFolder, ...segments: string[]): string {
  return [STATE_ROOT, folder, ...segments].join('/')
}

export function isStateFolderSafeOnPublic(folder: StateFolder): boolean {
  return STATE_FOLDERS[folder].safeOnPublic
}

/**
 * True when a slash-separated path sits inside the `.gazetta/`
 * namespace. Segment-exact: `.gazetta-deploy` and similar names do not
 * match. Used by call sites that test namespace membership (the CLI
 * watcher filter, asset name validation) instead of keeping their own
 * literal.
 */
export function isStatePath(path: string): boolean {
  return path === STATE_ROOT || path.startsWith(`${STATE_ROOT}/`) || path.includes(`/${STATE_ROOT}/`)
}
