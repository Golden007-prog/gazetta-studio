/**
 * Robots.txt generation — produces a default robots.txt or copies
 * a user-authored one from the site directory.
 *
 * SRP: this module owns robots.txt content resolution. The caller
 * checks for a user file and writes the result to storage.
 *
 * Strategy:
 *   1. If the site has a `robots.txt` file, use it verbatim.
 *   2. Otherwise, generate a permissive default with a Sitemap
 *      reference (when siteUrl is available).
 */
import { trimTrailingSlashes } from './url.js'

export interface GenerateRobotsOptions {
  /** Absolute base URL — used for the Sitemap directive. Optional. */
  siteUrl?: string
}

/**
 * Generate a default robots.txt. Permissive (allow all crawlers)
 * with a Sitemap reference when siteUrl is available.
 */
export function generateRobotsTxt(opts: GenerateRobotsOptions): string {
  const lines = ['User-agent: *', 'Allow: /']
  if (opts.siteUrl) {
    const base = trimTrailingSlashes(opts.siteUrl)
    lines.push('', `Sitemap: ${base}/sitemap.xml`)
  }
  return lines.join('\n') + '\n'
}
