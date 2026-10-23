import { randomBytes } from 'node:crypto'
import type { StorageProvider } from './types.js'

/**
 * #1125: every publish writes a value unique to that publish to
 * `.gazetta/publish-generation` on the target, after the content and
 * site files and before the cache purge. The Cloudflare worker puts
 * the generation in its Cache API key, so nothing cached before a
 * publish matches after it; a missing file gives the worker a fixed
 * key part until the target's next publish. The value is a publish
 * id only, no personal data.
 */
export const PUBLISH_GENERATION_PATH = '.gazetta/publish-generation'

export function newPublishGeneration(): string {
  return `${Date.now().toString(36)}-${randomBytes(6).toString('hex')}`
}

export async function writePublishGeneration(storage: StorageProvider): Promise<void> {
  await storage.writeFile(PUBLISH_GENERATION_PATH, newPublishGeneration())
}
