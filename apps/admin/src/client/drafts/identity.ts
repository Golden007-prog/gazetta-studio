/**
 * Whose drafts may this boot load? Two steps, kept apart so each can be
 * tested on its own:
 *
 *   askIdentity()          — ask the server who and where we are
 *   resolveDraftIdentity() — apply the answer to the draft store
 *
 * Rules (design-offline.md, "Unsaved drafts live in their own store"):
 *   - known   → delete other owners' drafts of this site, remember us, load ours
 *   - offline → load the last online identity's drafts (inherent to offline);
 *               only when the request failed and the browser reports offline
 *   - unknown → load nothing, delete nothing (e.g. the auth proxy answered
 *               with its login page, or the server failed or was slow while
 *               the browser is online; the user reloads)
 */
import { MeResponseSchema, SiteManifestSchema } from 'gazetta/admin-api/schemas'
import { API_BASE } from '../api/_request.js'
import { type DraftIdentity, type DraftStore, ownerOf } from './types.js'

export type IdentityAnswer = { kind: 'known'; identity: DraftIdentity } | { kind: 'offline' } | { kind: 'unknown' }

const DEFAULT_TIMEOUT_MS = 3000

/** Thrown inside askIdentity when a response can't identify us. */
class Unidentified extends Error {}

async function getJson(fetchFn: typeof fetch, url: string, signal: AbortSignal): Promise<unknown> {
  // A fetch rejection (network down, timeout) propagates as-is; anything
  // the server did answer but that isn't usable JSON is Unidentified.
  const res = await fetchFn(url, { signal, headers: { Accept: 'application/json' } })
  if (!res.ok) throw new Unidentified(`${url}: ${res.status}`)
  try {
    return await res.json()
  } catch {
    throw new Unidentified(`${url}: not JSON`)
  }
}

/**
 * Whether the browser reports a network. False is reliable; true only
 * means "maybe" — enough to refuse treating a slow server as offline.
 */
const browserOnline = () => typeof navigator === 'undefined' || navigator.onLine !== false

export async function askIdentity(
  opts: { fetch?: typeof fetch; base?: string; timeoutMs?: number; online?: () => boolean } = {},
): Promise<IdentityAnswer> {
  const fetchFn = opts.fetch ?? fetch
  const base = opts.base ?? API_BASE
  const signal = AbortSignal.timeout(opts.timeoutMs ?? DEFAULT_TIMEOUT_MS)
  try {
    const [me, site] = await Promise.all([
      getJson(fetchFn, `${base}/me`, signal),
      getJson(fetchFn, `${base}/site`, signal),
    ])
    const meParsed = MeResponseSchema.safeParse(me)
    const siteParsed = SiteManifestSchema.safeParse(site)
    if (!meParsed.success || !siteParsed.success) return { kind: 'unknown' }
    return { kind: 'known', identity: { site: siteParsed.data.name, owner: ownerOf(meParsed.data) } }
  } catch (err) {
    if (err instanceof Unidentified) return { kind: 'unknown' }
    // A failed or slow answer counts as offline only when the browser says
    // so: online, it may be another user's boot against a slow server, and
    // offline would load the last user's drafts.
    return (opts.online ?? browserOnline)() ? { kind: 'unknown' } : { kind: 'offline' }
  }
}

/** Apply an answer to the store. Returns the identity to load drafts for, or null for none. */
export async function resolveDraftIdentity(store: DraftStore, answer: IdentityAnswer): Promise<DraftIdentity | null> {
  switch (answer.kind) {
    case 'known':
      // Every known boot purges, not only on a change: an old tab of another
      // user may have written drafts since the last boot.
      await store.purgeOtherOwners(answer.identity)
      await store.setLastIdentity(answer.identity)
      return answer.identity
    case 'offline':
      return store.lastIdentity()
    case 'unknown':
      return null
  }
}
