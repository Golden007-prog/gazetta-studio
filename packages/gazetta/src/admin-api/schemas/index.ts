/**
 * Barrel for Zod schemas shared between the admin API server and its
 * clients. Importing from `gazetta/admin-api/schemas` avoids pulling
 * in Hono + storage-provider code that live under `gazetta/admin-api`.
 *
 * Migrated endpoints so far:
 *   - POST /api/pages (create + list summary)
 *   - POST /api/fragments (create + list summary)
 *   - GET  /api/templates (list)
 *   - GET  /api/fields (list)
 *   - GET  /api/targets (list)
 *   - GET  /api/site (manifest)
 *   - GET  /api/dependents (reverse-dep lookup)
 *   - GET  /api/compare (logical diff result)
 *   - POST /api/publish + /api/publish/stream (result + SSE progress union)
 *   - GET  /api/history + POST /api/history/{undo,restore} (revisions + restore)
 *   - POST /api/fetch (cross-target copy)
 *   - DELETE /api/assets/:name (AssetRef + 409 AssetInUseResponse)
 *   - GET  /api/system/cache/stats (CacheStats snapshot)
 *   - GET  /api/me (requesting principal)
 *   - GET  /api/audit (forensic event query + external-sink links)
 *   - 409 VALIDATION_FAILED on save handlers + GET /api/validation/issues
 *
 * Add new endpoint modules here as they move to schema-validated contracts.
 */
export * from './error.js'
export * from './pages.js'
export * from './fragments.js'
export * from './archive.js'
export * from './templates.js'
export * from './fields.js'
export * from './targets.js'
export * from './site.js'
export * from './dependents.js'
export * from './compare.js'
export * from './publish.js'
export * from './history.js'
export * from './fetch.js'
export * from './assets.js'
export * from './system.js'
export * from './audit.js'
export * from './validation.js'
export * from './redirects.js'
export * from './me.js'
