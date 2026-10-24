/**
 * target-deploy-coverage (Cut 2 of #203).
 *
 * Per Q6 of the deploy design pass: container deploys don't ship as
 * Gazetta adapters — `gazetta serve` runs inside the container, and
 * platform CLIs (`flyctl`, `gcloud run deploy`, etc.) handle the
 * deploy step. The validator surfaces the capability gap so operators
 * see "this target has runtime constraints but no deploy adapter —
 * make sure your platform deploy is wired correctly."
 *
 * # Stage + severity
 *
 * `cli` only, info severity. The condition is informational, not an
 * error — many legitimate setups (container hosts) leave `deploy:`
 * unset on purpose. Info points operators to
 * `docs/container-deployment.md` for recipes.
 *
 * # When the validator fires
 *
 *   - target.type is 'dynamic' (or 'esi' once design-rendering.md
 *     Cut 1 widens the enum)
 *   - target has no `deploy:` configured
 *   - target's `environment` is NOT 'local'
 *
 * Local targets are skipped because they're typically `gazetta dev` /
 * `gazetta serve` self-hosted shapes that don't need a platform
 * deploy adapter at all.
 *
 * # Why environment, not storage kind
 *
 * Whether a platform deploy is expected depends on the target's role,
 * not its storage: a filesystem target can be a production site that
 * `gazetta serve` runs in a container, which is the case this info is
 * for. `environment: 'local'` is the operator-visible marker of a dev
 * target.
 *
 * # SOLID
 *
 *   - SRP: one rule — coverage check on (target.type, deploy presence,
 *     environment).
 *   - OCP: future target.type values flow through unchanged.
 *   - DIP: depends on `TargetConfig` shape, not on provider concretions.
 */
import type { TargetConfig } from '../../types.js'
import type { Issue, Validator, ValidatorInput } from '../types.js'

export const targetDeployCoverage: Validator = {
  source: 'gazetta',
  name: 'target-deploy-coverage',
  stages: ['cli'] as const,

  defaultSeverity() {
    return 'info'
  },

  async validate(input: ValidatorInput): Promise<Issue[]> {
    const { scope, site } = input
    if (scope.kind !== 'cli') return []

    const targets = (site.manifest.targets ?? {}) as Record<string, TargetConfig>
    const issues: Issue[] = []

    for (const [name, target] of Object.entries(targets)) {
      const targetType = target.type ?? 'static'
      // Only runtime-constrained targets need a deploy story.
      if (targetType !== 'dynamic') continue
      // Targets with a deploy adapter already declare their platform.
      if (target.deploy) continue
      // Local targets are dev / `gazetta serve` self-hosted — no platform deploy needed.
      if (target.environment === 'local') continue

      issues.push({
        validator: 'target-deploy-coverage',
        severity: 'info',
        message:
          `Target "${name}" has type: "${targetType}" but no \`deploy:\` configured. ` +
          `Container deployments use platform-native tooling (flyctl, gcloud, etc.) — ` +
          `see docs/container-deployment.md for recipes.`,
        itemPath: `site.config.ts:targets.${name}`,
      })
    }

    return issues
  },
}
