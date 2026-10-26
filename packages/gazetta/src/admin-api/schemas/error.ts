/**
 * Shared shape for admin-API error responses.
 *
 * Most error responses follow `{ code: ErrorCode, message: string }`.
 * Error classes that carry typed extras (`STALE` carries `current` +
 * `currentEtag`; `VALIDATION_FAILED` carries `issues`) declare their
 * own schema in the relevant route module — those schemas extend the
 * base shape, they don't replace it.
 *
 * # Why this exists
 *
 * Per `docs/audits/test-quality-with-ai.md` cycle 1: error-shape
 * tautology was the highest-leverage finding. Tests asserted on
 * status code only; mutation testing showed `code: 'BAD_REQUEST'`
 * survives mutation to `code: ''` because no test asserts on the
 * body's `code` field. The fix is structural — assert against the
 * schema, not the observed shape.
 *
 * # Usage
 *
 * Tests assert on error responses through `ErrorResponseSchema`:
 *
 *   const body = ErrorResponseSchema.parse(await res.json())
 *   expect(body.code).toBe('BAD_REQUEST')
 *
 * `parse` (not `safeParse`) is intentional — a malformed error body
 * is itself a regression. Failing to round-trip through the schema
 * is the assertion.
 *
 * # Extending
 *
 * Routes that emit a typed error variant declare a discriminated
 * schema in their own module (e.g. `StaleResponseSchema` in
 * `pages.ts`). The base `ErrorCodeSchema` enum lists every code
 * the admin-API may emit; extend it when new error classes ship.
 */
import { z } from 'zod'

/**
 * Closed enum of every error code the admin-API emits.
 *
 * Adding a new error class = one new entry here + a route-module
 * extension if the error carries typed extras. Keeping the enum
 * closed prevents drift: a route that returns `code: 'NEW_THING'`
 * without updating this enum fails schema validation in tests, which
 * surfaces the missing entry before it ships.
 */
export const ErrorCodeSchema = z.enum([
  'AI_ADAPTER_FAILED',
  'AI_ADAPTER_UNAVAILABLE',
  'ARCHIVED',
  'ARCHIVED_NAME_CONFLICT',
  'ASSET_MANIFEST_NOT_FOUND',
  'BAD_REQUEST',
  'FORBIDDEN',
  'HOOK_CANCELLED',
  'NOT_FOUND',
  'PUBLISH_AUDIT_FAILED',
  'STALE',
  'UNAUTHENTICATED',
  'VALIDATION_FAILED',
])
export type ErrorCode = z.infer<typeof ErrorCodeSchema>

/**
 * Base error-response shape. Every admin-API error response
 * round-trips through this OR a route-specific extension of it.
 *
 * Optional fields:
 *   - `message` — human-readable; present on every error today, but
 *     marked optional because the closed-enum `code` is the stable
 *     contract; future error classes might omit `message` if the
 *     code alone carries enough information.
 *   - `missing` — `FORBIDDEN` responses carry the missing capability
 *     list per `design-auth-rbac.md` Q3 lock; reserved at the base
 *     so test assertions don't have to discriminate by code first.
 */
export const ErrorResponseSchema = z.object({
  code: ErrorCodeSchema,
  message: z.string().optional(),
  missing: z.array(z.string()).optional(),
})
export type ErrorResponse = z.infer<typeof ErrorResponseSchema>
