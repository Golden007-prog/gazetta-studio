/**
 * Review state sidecars — per-edge storage shape for the review
 * state machine (Cut 3 of #517).
 *
 * Each reviewable item carries:
 *
 *   {content-root}/.gazetta/review/{kind}/{name}/state.json
 *   {content-root}/.gazetta/review/{kind}/{name}/approvers/{actor-id}
 *
 * `{kind}` is the singular item kind (`page` | `fragment`), matching
 * `design-review-workflow.md`'s "Storage shape" literal. `{name}` is
 * the item name with `/` → `.` via `encodeRefName` so nested paths
 * like `blog/[slug]` are collision-free filesystem names.
 *
 * state.json carries the FSM state + submit-time snapshot of
 * `requiredApprovers` + timestamps. Per-approver sidecars are
 * zero-byte files whose filenames encode the voter's upstream
 * subject identifier (`Principal.id`), URI-encoded so arbitrary
 * subjects (emails with `@`, OIDC `provider|id` subjects, etc.) are
 * safe filesystem names.
 *
 * # Comments live in audit log, not sidecars
 *
 * `design-review-workflow.md`'s locked invariant (line 34) places
 * reject comments in audit metadata, not on the state file. The
 * approver list is who voted; the audit log is why. state.json
 * therefore carries NO comments map; the forensic record of an
 * approval or rejection — including the mandatory reject comment —
 * lives in the audit event emitted by the route handler (Cut 7)
 * alongside the sidecar write. RTBF (`gazetta audit scrub`, future)
 * reaches comments through the audit log; review sidecars carry
 * only approver IDs.
 *
 * # Why not reuse `dep-sidecars.ts` directly
 *
 * `dep-sidecars.ts` encodes a reverse-dep relationship:
 * `extract(manifest)` returns N target names per source manifest,
 * written as `.gazetta/{relation}/{target}/{source}` zero-byte
 * files. Review state is a different shape — one subject (the
 * item being reviewed) with its own FSM data (state.json carrying
 * submitter + snapshot + timestamps) plus zero or more approver
 * votes. Inverting dep-sidecars to fit would mean treating each
 * item as a one-element "target set", losing the state.json file
 * entirely, and renaming per-approver files to encode (actor →
 * item) edges. This module takes the same per-edge-granularity
 * discipline + per-instance safety story + flat filesystem layout
 * without pretending the shapes match.
 *
 * # Multi-instance correctness
 *
 * Per-approver sidecars live at distinct paths — two admin
 * instances recording concurrent approvals from Alice and Bob
 * write to `approvers/alice` and `approvers/bob`, never the same
 * file. Threshold crossing (does the Nth approver vote flip the
 * state?) is read-side: after writing your own approver sidecar,
 * `readDir` the approvers directory and count. The state.json
 * write is last-write-wins idempotent — the terminal
 * `state: approved` is the same regardless of which instance
 * wrote it last.
 */
import type { ContentRoot } from '../content-root.js'
import { encodeRefName } from '../hash.js'
import { stateFolderPath } from '../state-folders.js'
import type { ReviewSidecar } from './types.js'

export type ReviewStateKind = 'page' | 'fragment'

/** Root review-sidecar directory for one item. */
function reviewItemDir(contentRoot: ContentRoot, kind: ReviewStateKind, name: string): string {
  return contentRoot.path(stateFolderPath('review', kind, encodeRefName(name)))
}

/** Path to the state.json file for one item. */
export function reviewStatePath(contentRoot: ContentRoot, kind: ReviewStateKind, name: string): string {
  return contentRoot.path(stateFolderPath('review', kind, encodeRefName(name), 'state.json'))
}

/** Directory holding zero-byte per-approver sidecars for one item. */
export function reviewApproversDir(contentRoot: ContentRoot, kind: ReviewStateKind, name: string): string {
  return contentRoot.path(stateFolderPath('review', kind, encodeRefName(name), 'approvers'))
}

/**
 * Path to one per-approver sidecar. Actor IDs are URI-encoded so
 * emails (`alice@example.com` → `alice%40example.com`) and OIDC
 * `provider|id` subjects (`cloudflare|abc` → `cloudflare%7Cabc`)
 * are safe cross-platform filenames.
 */
export function reviewApproverPath(
  contentRoot: ContentRoot,
  kind: ReviewStateKind,
  name: string,
  actorId: string,
): string {
  return contentRoot.path(
    stateFolderPath('review', kind, encodeRefName(name), 'approvers', encodeURIComponent(actorId)),
  )
}

/**
 * Read the state.json for one item. Returns `null` when the item
 * has no review-sidecar directory (fresh content; no review
 * activity recorded).
 */
export async function readReviewSidecar(
  contentRoot: ContentRoot,
  kind: ReviewStateKind,
  name: string,
): Promise<ReviewSidecar | null> {
  const path = reviewStatePath(contentRoot, kind, name)
  let raw: string
  try {
    raw = await contentRoot.storage.readFile(path)
  } catch {
    return null
  }
  return JSON.parse(raw) as ReviewSidecar
}

/**
 * Write state.json for one item. Creates the item directory on
 * first write; subsequent writes are last-write-wins idempotent.
 */
export async function writeReviewSidecar(
  contentRoot: ContentRoot,
  kind: ReviewStateKind,
  name: string,
  sidecar: ReviewSidecar,
): Promise<void> {
  await contentRoot.storage.mkdir(reviewItemDir(contentRoot, kind, name)).catch(() => {
    // Dir already exists on second+ write — fine.
  })
  await contentRoot.storage.writeFile(reviewStatePath(contentRoot, kind, name), JSON.stringify(sidecar))
}

/**
 * Record one approver's vote by writing a zero-byte sidecar at
 * `approvers/{encoded-actor-id}`. Multiple approvers vote at
 * distinct paths — concurrent writes from different instances
 * don't race. A duplicate vote from the same actor is a no-op
 * (last-write-wins on the same zero-byte path).
 */
export async function writeApproverSidecar(
  contentRoot: ContentRoot,
  kind: ReviewStateKind,
  name: string,
  actorId: string,
): Promise<void> {
  await contentRoot.storage.mkdir(reviewApproversDir(contentRoot, kind, name)).catch(() => {
    // Dir already exists — fine.
  })
  await contentRoot.storage.writeFile(reviewApproverPath(contentRoot, kind, name, actorId), '')
}

/**
 * Read every actor ID that has voted on this item. Returns `[]`
 * when the approvers directory does not exist (nothing has been
 * submitted yet, or the item was never approved).
 */
export async function readApprovers(contentRoot: ContentRoot, kind: ReviewStateKind, name: string): Promise<string[]> {
  const dir = reviewApproversDir(contentRoot, kind, name)
  let entries: { name: string; isDirectory: boolean }[]
  try {
    entries = await contentRoot.storage.readDir(dir)
  } catch {
    return []
  }
  const actors: string[] = []
  for (const entry of entries) {
    if (entry.isDirectory) continue
    actors.push(decodeURIComponent(entry.name))
  }
  return actors
}

/**
 * Remove one actor's vote. No-op when the sidecar does not exist
 * (idempotent — matches the `rm`-already-gone-is-fine semantics
 * in `dep-sidecars.ts`).
 */
export async function removeApproverSidecar(
  contentRoot: ContentRoot,
  kind: ReviewStateKind,
  name: string,
  actorId: string,
): Promise<void> {
  await contentRoot.storage.rm(reviewApproverPath(contentRoot, kind, name, actorId)).catch(() => {
    // Already gone — fine.
  })
}

/**
 * Tear down the entire review sidecar tree for one item — state
 * file + all approver sidecars + the item directory. Used when
 * review state resets to `draft` and no history of the submission
 * is retained in sidecars (audit log carries the forensic record).
 */
export async function clearReviewSidecar(contentRoot: ContentRoot, kind: ReviewStateKind, name: string): Promise<void> {
  await contentRoot.storage.rm(reviewItemDir(contentRoot, kind, name)).catch(() => {
    // Nothing to remove — fine.
  })
}
