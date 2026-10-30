/**
 * Finding and removing the sensitive state a target's storage holds
 * (design-public-storage.md Q6). The `public-storage-config` validator
 * and `gazetta state remove` both go through here, so neither keeps its
 * own folder list or path logic.
 */
import { SENSITIVE_STATE_FOLDERS, type StateFolder, stateFolderPath } from './state-folders.js'
import type { StorageProvider } from './types.js'

/**
 * The sensitive folders present in `storage`, in registry order. A
 * folder counts as present when listing it returns at least one entry;
 * `exists()` alone can't tell, since object stores have no directory
 * objects. A listing that fails counts as absent only when the provider
 * also reports the path missing; any other failure propagates.
 */
export async function findSensitiveState(storage: StorageProvider): Promise<StateFolder[]> {
  const present: StateFolder[] = []
  for (const folder of SENSITIVE_STATE_FOLDERS) {
    const path = stateFolderPath(folder)
    let entries: readonly unknown[]
    try {
      entries = await storage.readDir(path)
    } catch (err) {
      if (await storage.exists(path)) throw err
      continue
    }
    if (entries.length > 0) present.push(folder)
  }
  return present
}

/** Delete the given sensitive folders, recursively. Refuses any other folder. */
export async function removeSensitiveState(storage: StorageProvider, folders: readonly StateFolder[]): Promise<void> {
  for (const folder of folders) {
    if (!(SENSITIVE_STATE_FOLDERS as readonly StateFolder[]).includes(folder)) {
      throw new Error(`"${folder}" isn't sensitive state; only ${SENSITIVE_STATE_FOLDERS.join(', ')} can be removed`)
    }
  }
  for (const folder of folders) await storage.rm(stateFolderPath(folder))
}

/** "history", "history and audit", "history, audit and review". */
export function formatFolderList(folders: readonly string[]): string {
  if (folders.length <= 1) return folders.join('')
  return `${folders.slice(0, -1).join(', ')} and ${folders[folders.length - 1]}`
}
