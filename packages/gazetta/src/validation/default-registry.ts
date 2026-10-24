import { accessibility } from './validators/accessibility.js'
import { aliasOfPointsToArchived } from './validators/aliasof-points-to-archived.js'
import { altRequired } from './validators/alt-required.js'
import { archiveNotSupportedOnTarget } from './validators/archive-not-supported-on-target.js'
import { brokenLinks } from './validators/broken-links.js'
import { circularAlias } from './validators/circular-alias.js'
import { circularFragment } from './validators/circular-fragment.js'
import { danglingAlias } from './validators/dangling-alias.js'
import { deployTargetTypeSupported } from './validators/deploy-target-type-supported.js'
import { dynamicRouteConflict } from './validators/dynamic-route-conflict.js'
import { htmlValidity } from './validators/html-validity.js'
import { publicStorageConfig } from './validators/public-storage-config.js'
import { orphanedLocaleFile } from './validators/orphaned-locale-file.js'
import { referencedArchivedWithoutAlias } from './validators/referenced-archived-without-alias.js'
import { referencedAssetExists } from './validators/referenced-asset-exists.js'
import { referencedFragmentExists } from './validators/referenced-fragment-exists.js'
import { referencedTemplateExists } from './validators/referenced-template-exists.js'
import { schemaConformance } from './validators/schema-conformance.js'
import { targetDeployCoverage } from './validators/target-deploy-coverage.js'
import { unusedFragment } from './validators/unused-fragment.js'
import { createValidatorRegistry, type ValidatorRegistry } from './registry.js'

/**
 * Default validator registry — Cut 1 (ref-existence) + Cut 2 (background-
 * only) + Cut 3 (quality: a11y, html-validity, altRequired) + Cut 4
 * (broken-links).
 *
 * Each validator declares its own stage support, so adding entries here is
 * safe: validators that don't apply to a given stage are filtered out by
 * `registry.forStage(stage)`.
 */
export function defaultValidatorRegistry(): ValidatorRegistry {
  return createValidatorRegistry([
    referencedAssetExists,
    referencedFragmentExists,
    referencedTemplateExists,
    circularFragment,
    dynamicRouteConflict,
    schemaConformance,
    orphanedLocaleFile,
    unusedFragment,
    altRequired,
    htmlValidity,
    accessibility,
    brokenLinks,
    // Soft-delete validators per design-soft-delete.md Q11 (P1-P5).
    referencedArchivedWithoutAlias,
    danglingAlias,
    circularAlias,
    archiveNotSupportedOnTarget,
    aliasOfPointsToArchived,
    // Deploy validators per design-deploy.md Cut 2.
    deployTargetTypeSupported,
    targetDeployCoverage,
    // Public storage config per design-public-storage.md Q6.
    publicStorageConfig,
  ])
}
