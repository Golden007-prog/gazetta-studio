/**
 * `gazetta state remove <target> [site]` — delete history, audit and
 * review from a target's storage (design-public-storage.md Q6). It's
 * how a target that kept state moves to public storage, and how a leak
 * is cleaned up. Works on any target; the confirmation, which names
 * exactly what goes, is the guard. `CI` set without `--yes` refuses.
 */
import { createInterface } from 'node:readline/promises'
import { findSensitiveState, formatFolderList, removeSensitiveState } from '../state-remove.js'
import type { TargetConfig } from '../types.js'

export interface StateCommandContext {
  targetName: string
  config: TargetConfig
}

export interface StateRemoveOptions {
  yes?: boolean
  /** Asks the question; resolves true only for an explicit yes. */
  confirm?: (question: string) => Promise<boolean>
  log?: (line: string) => void
}

async function askYesNo(question: string): Promise<boolean> {
  const rl = createInterface({ input: process.stdin, output: process.stdout })
  try {
    const answer = (await rl.question(`  ${question} (y/N) `)).trim().toLowerCase()
    return answer === 'y' || answer === 'yes'
  } finally {
    rl.close()
  }
}

export async function runStateRemove(ctx: StateCommandContext, opts: StateRemoveOptions = {}): Promise<void> {
  const log = opts.log ?? (line => console.log(line))
  const storage = ctx.config.storage as TargetConfig['storage'] & { init?: () => Promise<void> }
  if (typeof storage.init === 'function') await storage.init()

  const folders = await findSensitiveState(storage)
  const list = formatFolderList(folders)
  if (folders.length === 0) {
    log(`\n  Nothing to remove: \`${ctx.targetName}\` holds no history, audit or review.\n`)
    return
  }

  if (!opts.yes) {
    if (process.env.CI) {
      throw new Error(`Removing ${list} from "${ctx.targetName}" in CI requires --yes`)
    }
    const question = `Delete ${list} from \`${ctx.targetName}\`'s storage? This can't be undone.`
    const confirmed = await (opts.confirm ?? askYesNo)(question)
    if (!confirmed) {
      log('  Cancelled. Nothing was removed.')
      return
    }
  }

  await removeSensitiveState(storage, folders)
  log(`\n  ✓ Removed ${list} from \`${ctx.targetName}\`.\n`)
}
