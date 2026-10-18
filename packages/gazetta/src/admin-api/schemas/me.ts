/**
 * Zod schema for `GET /api/me` — who the admin API thinks is asking.
 *
 * The browser uses it to decide whose unsaved drafts it may load
 * (design-offline.md, "Unsaved drafts live in their own store"). Only
 * the fields that identify an owner: `email` and capabilities are left
 * out on purpose — the client has no use for them here.
 */
import { z } from 'zod'

export const MeResponseSchema = z.object({
  /** Stable upstream subject; `'unknown'` in `none` trust mode. */
  id: z.string(),
  role: z.string(),
  trustMode: z.string(),
})

export type MeResponse = z.infer<typeof MeResponseSchema>
