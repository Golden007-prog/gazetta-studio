/**
 * Zod schemas for /api/{pages,fragments}/:name/{archive,unarchive,purge}
 * routes — single source of truth for request/response shapes per
 * MCP discipline (see feature-design-process.md non-foundational
 * disciplines + testing-plan.md Priority 3.2).
 *
 * The 409 purge-blocked response carries a structured resolution
 * body (per design-soft-delete.md Q4 H1 lock) that the admin UI
 * consumes to drive the resolve modal.
 */
import { z } from 'zod'
import { ALIAS_TARGET_MESSAGE, aliasTargetIssue } from '../../runtime/archive-marker.js'

/** An alias target, checked as the archive marker and `_redirects` will carry it. */
const AliasTargetSchema = z
  .string()
  .min(1)
  // An empty string is min(1)'s to report.
  .refine(v => v === '' || aliasTargetIssue(v) === null, { message: ALIAS_TARGET_MESSAGE })

/**
 * POST /api/{kind}/:name/archive body. `aliasOf` is optional —
 * absent means pure soft-delete (the runtime emits 410 Gone for
 * pages and the renderer throws ArchivedNoAliasError for fragments).
 */
export const ArchiveRequestSchema = z.object({
  /** Live target name to redirect to. Pages: name resolves via
   *  `deriveRoute`. Fragments: referenced as `@name` at compose time. */
  aliasOf: AliasTargetSchema.optional(),
})
export type ArchiveRequest = z.infer<typeof ArchiveRequestSchema>

/** Standard ok response with the archived item's name. */
export const ArchiveResponseSchema = z.object({
  ok: z.literal(true),
  name: z.string(),
  archivedAt: z.string(),
  aliasOf: z.string().optional(),
})
export type ArchiveResponse = z.infer<typeof ArchiveResponseSchema>

export const UnarchiveResponseSchema = z.object({
  ok: z.literal(true),
  name: z.string(),
})
export type UnarchiveResponse = z.infer<typeof UnarchiveResponseSchema>

/** Reference one alias-pointer in a 409 DELETE_BLOCKED body. */
export const AliasPointerSchema = z.object({
  kind: z.enum(['page', 'fragment']),
  name: z.string(),
  /**
   * True when this pointer is a Manual Redirect archive — restoring it
   * is refused (#1343), so clients don't offer Restore for the row.
   */
  redirect: z.boolean().optional(),
})
export type AliasPointer = z.infer<typeof AliasPointerSchema>

/** Reference one live ref in a 409 DELETE_BLOCKED body. */
export const LiveRefSchema = z.object({
  kind: z.enum(['page', 'fragment']),
  name: z.string(),
})
export type LiveRef = z.infer<typeof LiveRefSchema>

/**
 * 409 response body when purge is blocked by aliases or live refs.
 * Per design-soft-delete.md Q4 H1: refusal returns this structured
 * shape so the admin UI can drive the resolve modal (re-target
 * aliases / drop alias / cascade-purge / resolve refs / try again).
 */
export const PurgeBlockedSchema = z.object({
  code: z.literal('DELETE_BLOCKED'),
  aliases: z.array(AliasPointerSchema),
  liveRefs: z.array(LiveRefSchema),
})
export type PurgeBlocked = z.infer<typeof PurgeBlockedSchema>

export const PurgeNotArchivedSchema = z.object({
  code: z.literal('NOT_ARCHIVED'),
  // The admin client's deletePurge surfaces `error` on non-blocked
  // 409s as the refusal reason.
  error: z.string(),
})
export type PurgeNotArchived = z.infer<typeof PurgeNotArchivedSchema>

export const PurgeResponseSchema = z.object({
  ok: z.literal(true),
  name: z.string(),
})
export type PurgeResponse = z.infer<typeof PurgeResponseSchema>

/**
 * 409 body when an archive-without-aliasOf is attempted on an item
 * that still has live refs (P8 save-handler check per
 * design-soft-delete.md Q11). Refusal preserves the invariant that
 * archived-no-alias items render 410 — which would silently break
 * any live reference. Author resolves by either setting `aliasOf`
 * on the archive request OR removing live refs first. Admin
 * `?force=true` bypasses with audit metadata recording the bypass.
 */
export const ArchiveHasLiveRefsSchema = z.object({
  code: z.literal('ARCHIVE_HAS_LIVE_REFS'),
  liveRefs: z.array(LiveRefSchema),
})
export type ArchiveHasLiveRefs = z.infer<typeof ArchiveHasLiveRefsSchema>

/**
 * Body for PATCH /api/{kind}/:name/alias. Edits an existing
 * archive's `aliasOf` field — set to a string to point at a live
 * target, or `null` to drop the alias (pure soft-delete).
 *
 * Used by Cut 12's purge-blocked resolution modal: when archives
 * point at a name the author wants to purge, the modal offers
 * "Drop alias" (aliasOf: null) per design-soft-delete.md Q4 H1.
 *
 * Only valid on archived items; live items' aliasOf is meaningless
 * (the field is implicitly stripped on unarchive). Returns 409 when
 * called on a live item.
 */
export const SetAliasRequestSchema = z.object({
  /** New alias target. `null` strips the alias (pure soft-delete). */
  aliasOf: AliasTargetSchema.nullable(),
})
export type SetAliasRequest = z.infer<typeof SetAliasRequestSchema>

export const SetAliasResponseSchema = z.object({
  ok: z.literal(true),
  name: z.string(),
  aliasOf: z.string().optional(),
})
export type SetAliasResponse = z.infer<typeof SetAliasResponseSchema>
