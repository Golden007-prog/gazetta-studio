/**
 * Source-IP recording — opt-in per design-audit.md "Source IP
 * recording" section. Trust-mode-driven extraction with optional
 * pseudonymization / truncation.
 *
 * # Modes
 *
 *   - `'none'` (default) — IP not recorded; field absent from event
 *   - `'raw'` — full IP. GDPR-personal-data; operator declares
 *     processing
 *   - `'hashed'` — `sha256(ip + GAZETTA_AUDIT_SOURCEIP_SALT).slice(0, 16)`
 *     for "same source across events?" correlation without
 *     identification. Different salt from actor (so rotating one
 *     doesn't break the other)
 *   - `'truncated'` — `/24` for IPv4, `/48` for IPv6. Geographic /
 *     network-segment forensics without device identification
 *
 * # Trust-mode-driven extraction
 *
 * Per design's "Trust-mode-driven header extraction" — leftmost-XFF
 * naive read is an OWASP Trust Boundary Violation. The IP source
 * differs per trust mode:
 *
 *   - `none`              — the connection's address (no proxy assumed)
 *   - `forwarded-user`    — X-Forwarded-For with trustedProxyCount
 *   - `cloudflare-access` — Cf-Connecting-IP (signed/trusted)
 *   - `azure-easy-auth`   — X-Forwarded-For (Azure appends one entry)
 *   - `aws-cognito`       — X-Forwarded-For (ALB appends one entry)
 *   - `tailscale`         — the connection's address
 *
 * A missing header, or fewer X-Forwarded-For entries than
 * trustedProxyCount, leaves the field out.
 *
 * # SOLID lenses
 *
 *   - SRP: extraction + truncation/hashing only. Doesn't dispatch,
 *     doesn't extract actor identity. Pure functions over
 *     `(headers, mode, salt?)`.
 */
import { createHash } from 'node:crypto'

export type SourceIpMode = 'none' | 'raw' | 'hashed' | 'truncated'

export interface SourceIpExtractionContext {
  /** Trust mode determines which header carries the client IP. */
  trustMode: string
  /** Address of the connection the request arrived on, when the server exposes it. */
  peerIp?: string
  /** All request headers (for X-Forwarded-For / Cf-Connecting-IP / X-Real-IP lookup). */
  headers: ReadonlyMap<string, string>
  /**
   * For trust modes that read X-Forwarded-For, how many trusted
   * proxies are in front of Gazetta. Each appends the address it
   * received the request from, so the client is the Nth entry from
   * the right; entries further left came from the client.
   *
   * Defaults to 1 (single proxy in front of Gazetta — most common).
   */
  trustedProxyCount?: number
}

/**
 * Extract the client IP per the trust mode's header convention.
 * Returns null when the configured header is missing — the caller
 * should omit the `sourceIp` field from the event (per design:
 * "Explicitly absent is more honest" than fake values).
 */
export function extractSourceIp(ctx: SourceIpExtractionContext): string | null {
  const { trustMode, headers } = ctx
  switch (trustMode) {
    case 'none':
    case 'tailscale':
      return ctx.peerIp ?? null
    case 'cloudflare-access':
      return headers.get('cf-connecting-ip') || null
    case 'forwarded-user':
    case 'azure-easy-auth':
    case 'aws-cognito': {
      const entries = (headers.get('x-forwarded-for') ?? '')
        .split(',')
        .map(s => s.trim())
        .filter(Boolean)
      // The Nth entry from the right was appended by the outermost
      // trusted proxy; anything further left is client-supplied. With no
      // trusted proxy, the client is the connection itself.
      const trustedCount = ctx.trustedProxyCount ?? 1
      if (trustedCount === 0) return ctx.peerIp ?? null
      return entries[entries.length - trustedCount] ?? null
    }
    default:
      // Unknown trust mode (plugin-supplied future) — fall back to
      // peer IP. Plugin authors override via custom extraction.
      return ctx.peerIp ?? null
  }
}

/**
 * Apply the configured source-IP mode. Returns null when the mode
 * is `'none'` OR when the extracted IP is null/empty/malformed —
 * the caller omits the field.
 */
export function processSourceIp(rawIp: string | null, mode: SourceIpMode, salt?: string): string | null {
  if (mode === 'none') return null
  if (!rawIp || rawIp.length === 0) return null

  if (mode === 'raw') return rawIp
  if (mode === 'hashed') {
    if (!salt || salt.length === 0) {
      throw new Error(
        'recordSourceIp: hashed requires a non-empty salt (set GAZETTA_AUDIT_SOURCEIP_SALT environment variable)',
      )
    }
    return createHash('sha256')
      .update(rawIp + salt)
      .digest('hex')
      .slice(0, 16)
  }
  // mode === 'truncated'
  return truncateIp(rawIp)
}

/**
 * Truncate an IP to /24 (IPv4) or /48 (IPv6). Returns null for
 * malformed input — the caller treats this as "missing" and omits
 * the field.
 */
function truncateIp(ip: string): string | null {
  // IPv4: 1.2.3.4 → 1.2.3.0/24
  if (ip.includes('.') && !ip.includes(':')) {
    const parts = ip.split('.')
    if (parts.length !== 4) return null
    for (const p of parts) {
      const n = Number.parseInt(p, 10)
      if (!Number.isInteger(n) || n < 0 || n > 255) return null
    }
    return `${parts[0]}.${parts[1]}.${parts[2]}.0/24`
  }
  // IPv6: fe80::1234 → fe80::/48 (first 3 groups of 16 bits)
  if (ip.includes(':')) {
    // Expand :: shorthand if present.
    const groups = expandIpv6Groups(ip)
    if (!groups) return null
    return `${groups.slice(0, 3).join(':')}::/48`
  }
  return null
}

function expandIpv6Groups(ip: string): string[] | null {
  const doubleColon = ip.indexOf('::')
  let groups: string[]
  if (doubleColon >= 0) {
    const left = ip.slice(0, doubleColon).split(':').filter(Boolean)
    const right = ip
      .slice(doubleColon + 2)
      .split(':')
      .filter(Boolean)
    const fillCount = 8 - left.length - right.length
    if (fillCount < 0) return null
    groups = [...left, ...new Array(fillCount).fill('0'), ...right]
  } else {
    groups = ip.split(':')
  }
  if (groups.length !== 8) return null
  for (const g of groups) {
    const n = Number.parseInt(g, 16)
    if (!Number.isInteger(n) || n < 0 || n > 0xffff) return null
  }
  return groups
}
