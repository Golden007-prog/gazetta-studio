/**
 * Zod schemas for /api/fragments routes. Pattern mirrors pages.ts —
 * single source of truth shared by server (safeParse) and client
 * (z.infer); drift caught at compile time by the client import or
 * at runtime by api-contract.test.ts.
 */
import { z } from 'zod'
import { isSafeItemName, UNSAFE_ITEM_NAME_MESSAGE } from '../../item-name.js'

/** Summary used in list responses (GET /api/fragments). */
export const FragmentSummarySchema = z.object({
  name: z.string(),
  /**
   * Template name. Optional because archived fragments may omit it
   * (per design-redirect-ui.md Q2 sub-decision A1). Live fragments
   * always set this — the persisted-manifest refinement guarantees
   * presence for non-archived rows.
   */
  template: z.string().optional(),
  locales: z.array(z.string()).optional(),
  /** Archive state per design-soft-delete.md Q1 A1. See pages schema. */
  archived: z.boolean().optional(),
  /** Alias target name when archived with aliasOf. */
  aliasOf: z.string().optional(),
})
export type FragmentSummary = z.infer<typeof FragmentSummarySchema>

/** Body for POST /api/fragments (create). */
export const CreateFragmentRequestSchema = z.object({
  /** Fragment name — used as the directory name and identity. Must be a safe item name. */
  name: z.string().refine(isSafeItemName, UNSAFE_ITEM_NAME_MESSAGE),
  /** Template name to bind. Must be non-empty. */
  template: z.string().min(1),
})
export type CreateFragmentRequest = z.infer<typeof CreateFragmentRequestSchema>

/** Response for POST /api/fragments (create). */
export const CreateFragmentResponseSchema = z.object({
  ok: z.boolean(),
  name: z.string(),
})
export type CreateFragmentResponse = z.infer<typeof CreateFragmentResponseSchema>

/**
 * Persisted shape of a fragment manifest (`fragment.json`) — what's
 * stored on disk. Distinct from `CreateFragmentRequestSchema` (the
 * create-fragment contract), which always requires a template. Same
 * rationale as `PageManifestSchema` (see pages.ts): `template` is
 * conditionally optional via `.refine` so archive-only fragments —
 * created by a rename composition (`archive + alias`) or by the
 * manual-redirect feature (per design-redirect-ui.md Q6) — round-trip
 * through the schema without a sentinel template value.
 */
export const FragmentManifestSchema = z
  .object({
    template: z.string().min(1).optional(),
    content: z.record(z.string(), z.unknown()).optional(),
    components: z.array(z.unknown()).optional(),
    // Archive fields per design-soft-delete.md Q1 A1.
    archived: z.boolean().optional(),
    archivedAt: z.string().optional(),
    archivedBy: z.string().optional(),
    aliasOf: z.string().optional(),
    // Forward-compat passthrough for review-workflow.
    reviewState: z.string().optional(),
  })
  .refine(data => data.archived === true || typeof data.template === 'string', {
    message: 'Live fragments require a template; archived fragments may omit it',
    path: ['template'],
  })
export type FragmentManifestParsed = z.infer<typeof FragmentManifestSchema>
