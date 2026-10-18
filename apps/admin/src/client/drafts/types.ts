/**
 * Draft store — where the admin keeps unsaved work across reloads.
 *
 * Unsaved drafts are the author's only copy of their work, so they don't
 * live in `AdminCache` (which may fail open and evict). Each draft is one
 * record, scoped to a site, the user who wrote it and the target it was
 * made on. See design-offline.md, "Unsaved drafts live in their own store".
 */

/** The pending-edit lanes: field content, component structure and page metadata. */
export type DraftKind = 'edit' | 'structural' | 'metadata'

/** Which site and which user a set of drafts belongs to. */
export interface DraftIdentity {
  /** Site name. IndexedDB is per origin, and one origin can serve several sites over time. */
  site: string
  /** `{trustMode}:{id}:{role}` of the user who wrote the drafts. */
  owner: string
}

/** Identity plus the target the drafts were made on. */
export interface DraftScope extends DraftIdentity {
  target: string
}

export interface DraftStore {
  /** False for the in-memory fallback: drafts are lost on reload. */
  readonly durable: boolean
  /** Every draft of one kind in a scope, as `[key, value]` pairs. */
  list<T>(scope: DraftScope, kind: DraftKind): Promise<Array<[string, T]>>
  /** Write one draft. The value must be JSON-serialisable; it is stored as a plain copy. */
  put<T>(scope: DraftScope, kind: DraftKind, key: string, value: T): Promise<void>
  /** Delete one draft. No-op if absent. */
  delete(scope: DraftScope, kind: DraftKind, key: string): Promise<void>
  /** Delete every draft of `identity.site` written by any other owner. Returns how many. */
  purgeOtherOwners(identity: DraftIdentity): Promise<number>
  /** Identity of the last online boot — what an offline boot falls back to. */
  lastIdentity(): Promise<DraftIdentity | null>
  setLastIdentity(identity: DraftIdentity): Promise<void>
}

/** `owner` string for a principal as reported by `GET /api/me`. */
export function ownerOf(me: { id: string; role: string; trustMode: string }): string {
  return `${me.trustMode}:${me.id}:${me.role}`
}

/** Strip reactive proxies and anything non-JSON before storing. */
export function plainCopy<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
}
