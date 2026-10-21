import { createHash } from 'node:crypto'
import { tmpdir } from 'node:os'
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
 */
export function viteCacheDir(siteDir: string, tempRoot: string = tmpdir()): string {
  const key = createHash('sha256').update(resolve(siteDir)).digest('hex').slice(0, 16)
  return join(tempRoot, 'gazetta-vite', key)
}
