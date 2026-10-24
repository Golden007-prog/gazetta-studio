/**
 * Zod schemas for /api/{pages,fragments}/:name/rename — single source
 * of truth for request/response shapes per MCP discipline.
 *
 * Per `design-soft-delete.md`'s rename grilling:
 *   - C1: two distinct 409 codes (NAME_COLLISION for live, ARCHIVED_NAME_CONFLICT for archived)
 *   - H1: single composite `rename` audit event with metadata.flattenedAliases
 *   - I1: 500 RENAME_PARTIAL with structured state for idempotent retry
 */
import { z } from 'zod'
import { isSafeItemName, UNSAFE_ITEM_NAME_MESSAGE } from '../../item-name.js'

/**
 * POST /api/{kind}/:name/rename body. `to` is required; `keepAlias`
 * defaults to true (the typical rename-with-redirect intent). Setting
 * `keepAlias: false` is rare — author wants the old URL to 404
 * instead of 301 (e.g., name was sensitive and shouldn't redirect).
 */
export const RenameRequestSchema = z.object({
  /** Target name. Must not collide with a live item; archived target produces ARCHIVED_NAME_CONFLICT. */
  to: z.string().refine(isSafeItemName, UNSAFE_ITEM_NAME_MESSAGE),
  /** When true (default), the old name is archived with `aliasOf: <to>`; render emits 301 + worker marker. */
  keepAlias: z.boolean().default(true),
})
export type RenameRequest = z.infer<typeof RenameRequestSchema>

/** Standard ok response carrying the new name + flatten cascade trace. */
const RenameResponseSchema = z.object({
  ok: z.literal(true),
  /** New name (= request `to`). */
  name: z.string(),
  /** Old name (= request URL parameter). */
  fromName: z.string(),
  /** Names of archives whose aliasOf was rewritten from the old to the new name. */
  flattenedAliases: z.array(z.string()),
  /** Locales found at the renamed path (informational; for forensic queries). */
  localeVariants: z.array(z.string()),
})
export type RenameResponse = z.infer<typeof RenameResponseSchema>

/**
 * 409 body when the target name is already a live item. Author picks
 * a different name and retries.
 */
const NameCollisionSchema = z.object({
  code: z.literal('NAME_COLLISION'),
  toName: z.string(),
  /** Discriminator — `'live'` distinguishes from ARCHIVED_NAME_CONFLICT in the same client switch. */
  conflictKind: z.literal('live'),
})
export type NameCollision = z.infer<typeof NameCollisionSchema>

/**
 * 409 body when the target name is already an archived item. Cut 11's
 * prompt UX consumes this to show the three-option modal.
 *
 * Un-exported: only the inferred `ArchivedNameConflict` type below is
 * consumed externally (by `admin-api/routes/rename.ts`). The schema
 * value stays declared for the `z.infer<typeof …>` derivation.
 */
const ArchivedNameConflictSchema = z.object({
  code: z.literal('ARCHIVED_NAME_CONFLICT'),
  toName: z.string(),
  conflictKind: z.literal('archived'),
  /** Pre-resolution snapshot for the prompt UI. */
  archive: z.object({
    archivedAt: z.string().optional(),
    archivedBy: z.string().optional(),
    aliasOf: z.string().optional(),
  }),
})
export type ArchivedNameConflict = z.infer<typeof ArchivedNameConflictSchema>

/**
 * 500 body when rename partially completed. Client retries the same
 * request — each step is idempotent (create-new sees `to` exists,
 * archive-old sees old already archived, flatten skips already-rewritten
 * archives) per Q9 I1 lock.
 */
export const RenamePartialSchema = z.object({
  code: z.literal('RENAME_PARTIAL'),
  /** Steps that completed. Used by the client to surface progress. */
  completed: z.array(z.enum(['create-new', 'archive-old', 'flatten-cascade'])),
  /** Steps still to run. Idempotent retry will resume from these. */
  remaining: z.array(z.enum(['create-new', 'archive-old', 'flatten-cascade'])),
  /** Underlying error message for forensics. */
  error: z.string(),
})
export type RenamePartial = z.infer<typeof RenamePartialSchema>
