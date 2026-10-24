/**
 * IP / CIDR membership testing for header-spoofing protection.
 *
 * # Why a custom matcher and not a library
 *
 * Three reasons:
 *   - Zero-dep: `net.isIP` ships with Node 22; we only need
 *     equality + CIDR-prefix checks. A library adds 50KB to a
 *     small concern.
 *   - IPv4 + IPv6 mixing: industrial libs (e.g. `ipaddr.js`) handle
 *     edge cases we don't have (IPv4-mapped IPv6 addresses, etc.).
 *     For the auth use case the operator-supplied list is small and
 *     well-understood — they wrote each entry by hand.
 *   - Multi-instance discipline: the matcher is a pure function over
 *     `(ip, ruleList)`. No state, no async, no shared mutable cache.
 *
 * # Supported syntax
 *
 *   - `1.2.3.4` — exact IPv4 match
 *   - `10.0.0.0/8` — IPv4 CIDR
 *   - `fe80::1` — exact IPv6 match
 *   - `fd00::/8` — IPv6 CIDR
 *
 * Mixed-family rules are fine; an IPv4 source is checked only
 * against IPv4 rules, IPv6 against IPv6.
 *
 * # SOLID lenses
 *
 *   - SRP: this module owns IP-vs-rule comparison; doesn't read
 *     headers, doesn't construct providers.
 *   - LSP: future provider-specific source-IP needs (e.g.,
 *     `cloudflare-access` reads `Cf-Connecting-IP`) consume the
 *     same matcher.
 */
import { isIP } from 'node:net'

/**
 * Parsed CIDR rule. Exposed for tests and reuse by other providers
 * that may want to validate operator-supplied rule strings.
 */
export interface ParsedRule {
  /** Original rule string (for diagnostics). */
  raw: string
  /** Address family — 4 (IPv4) or 6 (IPv6). */
  family: 4 | 6
  /** Network address as bigint (left-aligned for IPv4 to fit IPv6). */
  network: bigint
  /** Number of leading bits that must match. 32 for IPv4-exact; 128 for IPv6-exact. */
  prefixBits: number
}

/**
 * Parse a single rule. Throws on malformed input. Operator's
 * `trustedProxies` array passes through this once at boot; rules
 * are validated then cached as `ParsedRule[]` for fast per-request
 * checks.
 */
export function parseRule(raw: string): ParsedRule {
  const slash = raw.indexOf('/')
  let addr: string
  let prefix: number
  if (slash >= 0) {
    addr = raw.slice(0, slash)
    const prefixStr = raw.slice(slash + 1)
    prefix = Number.parseInt(prefixStr, 10)
    if (!Number.isInteger(prefix) || prefix < 0) {
      throw new Error(`Invalid CIDR prefix in "${raw}": "${prefixStr}" must be a non-negative integer`)
    }
  } else {
    addr = raw
    prefix = -1 // sentinel: exact match — set per-family below
  }
  const family = isIP(addr)
  if (family === 0) {
    throw new Error(`Invalid IP address in "${raw}": "${addr}" is not a valid IPv4 or IPv6 address`)
  }
  const maxPrefix = family === 4 ? 32 : 128
  if (prefix === -1) prefix = maxPrefix
  if (prefix > maxPrefix) {
    throw new Error(`Invalid CIDR prefix in "${raw}": ${prefix} exceeds max ${maxPrefix} for IPv${family}`)
  }
  const fullBits = family === 4 ? ipv4ToBigInt(addr) : ipv6ToBigInt(addr)
  // Mask off non-prefix bits so the network is canonical (operator
  // can write 10.1.2.3/8 and we treat it the same as 10.0.0.0/8).
  const totalBits = family === 4 ? 32 : 128
  const network = fullBits & cidrMask(prefix, totalBits)
  return { raw, family: family as 4 | 6, network, prefixBits: prefix }
}

/** Build all rules; throws on the first malformed entry with rule context. */
export function parseRules(rawRules: readonly string[]): ParsedRule[] {
  return rawRules.map(parseRule)
}

/**
 * Test whether an IP matches any rule. Returns false for unknown
 * input (empty string, malformed) — fail-closed.
 */
export function ipMatchesAny(ip: string | undefined, rules: readonly ParsedRule[]): boolean {
  if (!ip) return false
  const family = isIP(ip)
  if (family === 0) return false
  let value: bigint
  try {
    value = family === 4 ? ipv4ToBigInt(ip) : ipv6ToBigInt(ip)
  } catch {
    return false
  }
  const totalBits = family === 4 ? 32 : 128
  for (const rule of rules) {
    if (rule.family !== family) continue
    const masked = value & cidrMask(rule.prefixBits, totalBits)
    if (masked === rule.network) return true
  }
  return false
}

/** `::ffff:10.0.0.5` (how a dual-stack server reports an IPv4 client) becomes `10.0.0.5`. */
export function unmapIPv4(ip: string): string {
  const mapped = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/i.exec(ip)
  return mapped?.[1] ?? ip
}

const LOOPBACK_RULES = parseRules(['127.0.0.0/8', '::1/128'])

/** True for 127.0.0.0/8 and ::1, including IPv4-mapped forms. False for unknown input. */
export function isLoopbackAddress(ip: string | undefined): boolean {
  return ip !== undefined && ipMatchesAny(unmapIPv4(ip), LOOPBACK_RULES)
}

// --- Internals ---

function ipv4ToBigInt(ip: string): bigint {
  const parts = ip.split('.')
  if (parts.length !== 4) throw new Error(`Invalid IPv4: ${ip}`)
  let n = 0n
  for (const part of parts) {
    const octet = Number.parseInt(part, 10)
    if (!Number.isInteger(octet) || octet < 0 || octet > 255) {
      throw new Error(`Invalid IPv4 octet: ${part}`)
    }
    n = (n << 8n) | BigInt(octet)
  }
  return n
}

function ipv6ToBigInt(ip: string): bigint {
  // Handle :: shorthand by expanding to the right number of zero
  // groups. Doesn't handle IPv4-mapped IPv6 addresses
  // (e.g. ::ffff:1.2.3.4) — operators with hybrid stacks list
  // both representations explicitly.
  const doubleColon = ip.indexOf('::')
  let groups: string[]
  if (doubleColon >= 0) {
    const left = ip.slice(0, doubleColon).split(':').filter(Boolean)
    const right = ip
      .slice(doubleColon + 2)
      .split(':')
      .filter(Boolean)
    const fillCount = 8 - left.length - right.length
    if (fillCount < 0) throw new Error(`Invalid IPv6: too many groups in ${ip}`)
    groups = [...left, ...new Array(fillCount).fill('0'), ...right]
  } else {
    groups = ip.split(':')
  }
  if (groups.length !== 8) throw new Error(`Invalid IPv6: expected 8 groups, got ${groups.length} in ${ip}`)
  let n = 0n
  for (const group of groups) {
    const value = Number.parseInt(group, 16)
    if (!Number.isInteger(value) || value < 0 || value > 0xffff) {
      throw new Error(`Invalid IPv6 group: ${group}`)
    }
    n = (n << 16n) | BigInt(value)
  }
  return n
}

function cidrMask(prefixBits: number, totalBits: number): bigint {
  if (prefixBits === 0) return 0n
  if (prefixBits === totalBits) return (1n << BigInt(totalBits)) - 1n
  const ones = (1n << BigInt(prefixBits)) - 1n
  return ones << BigInt(totalBits - prefixBits)
}
