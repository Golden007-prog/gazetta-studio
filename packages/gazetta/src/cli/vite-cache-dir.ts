import { createHash } from 'node:crypto'
import { join, resolve } from 'node:path'

/**
 * Vite dependency cache directory for one site's `gazetta dev` server.
 *
 * Vite's default cache lives under the admin source's `node_modules/.vite`,
 * shared by every dev server, and each site's config differs (its own
 * `@editors`/`@fields` aliases and `optimizeDeps.entries`). A server
 * starting for one site re-optimizes that shared cache under another
 * running server, whose next dependency request then fails with
 * `504 Outdated Optimize Dep`. Keyed by the site path, the cache survives
 * restarts of the same site and is never shared between sites.
 *
 * It sits in the project's own `node_modules`, not the OS temp folder: a
 * predictable path in a shared `/tmp` lets another account plant optimized
 * modules that run in the admin, and temp cleaners can delete it under a
 * running server.
 */
export function viteCacheDir(siteDir: string, projectRoot: string): string {
  const key = createHash('sha256').update(resolve(siteDir)).digest('hex').slice(0, 16)
  return join(projectRoot, 'node_modules', '.vite', 'gazetta', key)
}
