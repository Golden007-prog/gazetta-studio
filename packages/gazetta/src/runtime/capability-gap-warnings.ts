/**
 * Boot-time capability-gap inspection — surface #1 of the four-point
 * capability-gap UX pattern.
 *
 * Per `design-soft-delete.md` Q10 lock + `feature-design-process.md`
 * non-foundational discipline: at admin boot, walk every configured
 * target and warn about runtime capability gaps. Non-blocking — admin
 * starts. The warning gives operators an early signal during deploy
 * so misconfiguration surfaces before content authors hit the gap at
 * publish time.
 *
 * Pairs with:
 *   - Surface #2 (author modal): consumes `/api/targets` extended
 *     payload with capability info (Cut 10 wires the UI)
 *   - Surface #3 (validator scanner): `archive-not-supported-on-target`
 *     P4 validator from Cut 8 reports per-archived-item gaps
 *   - Surface #4 (pre-publish gate): `/api/publish/audit` includes
 *     per-target capability info when archived items are in scope
 *
 * # SOLID
 *
 *   - SRP: this module owns ONE concern — emit warnings at boot.
 *     Doesn't inspect targets itself (delegates to runtime-capabilities);
 *     doesn't render the warnings (consumes the existing console.warn
 *     pattern).
 *   - DIP: depends on the `inspectTarget` predicate, not on target-config
 *     parsing details.
 */
import type { SiteManifest, TargetConfig } from '../types.js'
import { inspectTarget } from './runtime-capabilities.js'

/**
 * Walk the site's targets at boot; emit a warning per target that
 * has any capability gap — but only when the site has at least one
 * archived page (#1305); pass `opts.anyArchived` = false to skip the
 * walk entirely on a site with nothing archived. Logs are operator-facing — once
 * `design-logging.md`'s structured logger ships, replace `console.warn`
 * with `log.warn({ module: 'admin-api.capability-gap', ... })`.
 *
 * Idempotent: calling twice produces the same warnings. The caller
 * (admin-api boot path) calls once.
 *
 * @returns the count of targets with gaps — useful for tests.
 */
export function warnOnCapabilityGaps(manifest: SiteManifest, opts: { anyArchived?: boolean } = {}): number {
  // #1305 (decided 2026-10-24): no boot warning on a site without
  // archived pages - the gap only matters once an archive operation can
  // hit it, and the archive dialog, site health and the publish check
  // still surface it from then on. Callers that don't track archive
  // state keep the previous warn-always behavior.
  if (opts.anyArchived === false) return 0
  const targets = (manifest.targets ?? {}) as Record<string, TargetConfig>
  let count = 0
  for (const [name, target] of Object.entries(targets)) {
    const inspection = inspectTarget(target)
    if (inspection.gaps.length === 0) continue
    count++
    const reasons = inspection.gaps.map(g => `${g.capability}: ${g.reason}`).join('; ')
    console.warn(
      `  Warning: target "${name}" has runtime capability gaps. ${reasons}. ` +
        'Archive operations on this target may not emit 301/410 redirects. ' +
        'See https://gazetta.studio/docs/runtime-capabilities for resolution paths.',
    )
  }
  return count
}
