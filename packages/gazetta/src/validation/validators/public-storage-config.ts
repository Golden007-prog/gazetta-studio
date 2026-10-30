/**
 * public-storage-config — design-public-storage.md Q6.
 *
 * A target whose storage visitors can reach keeps no history, audit or
 * review state there, so config that contradicts the resolved
 * `isPublicStorage(target)` is an error rather than a silent override:
 *   - public storage with `history: { enabled: true }` set explicitly
 *   - public storage with `editable: true` set explicitly (an editing
 *     target must keep its own history)
 *   - public storage that still holds history, audit or review, which
 *     `gazetta state remove` clears. Only public targets' storage is read.
 *
 * A target that resolves public only because `publicStorage` is unset
 * gets one info line, so the assumption is visible without blocking a
 * valid setup.
 */
import { findSensitiveState, formatFolderList } from '../../state-remove.js'
import { isPublicStorage, type TargetConfig } from '../../types.js'
import type { Issue, Validator, ValidatorInput } from '../types.js'

/** The info line for a target assumed public. Shared with the admin boot log. */
export function defaultedPublicMessage(name: string): string {
  return (
    `\`${name}\`: storage assumed public, so history and audit aren't kept. ` +
    `Set \`publicStorage: false\` if visitors can't reach it.`
  )
}

/** Names of targets that resolve public only because `publicStorage` is unset. */
export function defaultedPublicTargets(targets: Record<string, TargetConfig>): string[] {
  return Object.entries(targets)
    .filter(([, target]) => target.publicStorage === undefined && isPublicStorage(target))
    .map(([name]) => name)
}

/**
 * Admin boot: one structured info line per target assumed public, the same
 * line `gazetta validate` reports. `sink` defaults to stdout as JSON
 * (design-logging.md).
 */
export function logDefaultedPublicTargets(
  targets: Record<string, TargetConfig> | undefined,
  sink: (entry: Record<string, unknown>) => void = entry => console.log(JSON.stringify(entry)),
): void {
  for (const name of defaultedPublicTargets(targets ?? {})) {
    sink({
      timestamp: new Date().toISOString(),
      level: 'info',
      module: 'admin-api.public-storage',
      target: name,
      message: defaultedPublicMessage(name),
    })
  }
}

/** Validators don't throw, so a storage failure comes back as a message for the issue. */
async function sensitiveStateOf(target: TargetConfig): Promise<{ folders: string[]; error?: string }> {
  try {
    const storage = target.storage as TargetConfig['storage'] & { init?: () => Promise<void> }
    if (typeof storage.init === 'function') await storage.init()
    return { folders: await findSensitiveState(storage) }
  } catch (err) {
    return { folders: [], error: (err as Error).message }
  }
}

export const publicStorageConfig: Validator = {
  source: 'gazetta',
  name: 'public-storage-config',
  stages: ['cli'] as const,

  defaultSeverity() {
    return 'error'
  },

  async validate(input: ValidatorInput): Promise<Issue[]> {
    const { scope, site } = input
    if (scope.kind !== 'cli') return []

    const targets = (site.manifest.targets ?? {}) as Record<string, TargetConfig>
    const issues: Issue[] = []
    const issue = (name: string, severity: Issue['severity'], message: string): Issue => ({
      validator: 'public-storage-config',
      severity,
      message,
      itemPath: `site.config.ts:targets.${name}`,
    })

    for (const [name, target] of Object.entries(targets)) {
      if (!isPublicStorage(target)) continue
      if (target.history?.enabled === true) {
        issues.push(
          issue(
            name,
            'error',
            `\`${name}\` keeps history, but its storage is public, so the history would be downloadable. ` +
              `Remove \`history: { enabled: true }\` or set \`publicStorage: false\`.`,
          ),
        )
      }
      if (target.editable === true) {
        issues.push(
          issue(name, 'error', `\`${name}\` is editable, so its storage must be private (\`publicStorage: false\`).`),
        )
      }
      const held = await sensitiveStateOf(target)
      if (held.error) {
        issues.push(
          issue(name, 'error', `Couldn't check \`${name}\`'s storage for history, audit or review: ${held.error}`),
        )
      } else if (held.folders.length > 0) {
        issues.push(
          issue(
            name,
            'error',
            `\`${name}\` is public but still holds ${formatFolderList(held.folders)}; ` +
              `run \`gazetta state remove ${name}\`.`,
          ),
        )
      }
    }

    for (const name of defaultedPublicTargets(targets)) {
      issues.push(issue(name, 'info', defaultedPublicMessage(name)))
    }

    return issues
  },
}
