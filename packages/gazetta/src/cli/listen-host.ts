/**
 * Which address the CLI's servers listen on (#1074).
 *
 * `gazetta dev` and `gazetta admin` mount the admin API. With the default
 * `admin.auth` (`trust: 'none'`) every request gets the admin role, so they
 * listen on loopback. `gazetta admin` with real auth configured runs behind
 * a proxy or load balancer that reaches it over the network, so it listens
 * on every interface. `gazetta dev` is a development server and stays on
 * loopback either way. `gazetta serve` serves only the site and is what
 * containers run, so it listens on every interface. `--host` overrides all.
 */

export type ServerCommand = 'dev' | 'admin' | 'serve'

export const SERVER_COMMANDS: ReadonlySet<string> = new Set<ServerCommand>(['dev', 'admin', 'serve'])

/**
 * The hostname to pass to the Node server; `undefined` means every interface.
 * `authTrust` is the site's `admin.auth.trust`, `'none'` when unset.
 */
export function resolveListenHost(command: ServerCommand, hostFlag?: string, authTrust = 'none'): string | undefined {
  if (hostFlag) return hostFlag
  if (command === 'serve') return undefined
  if (command === 'admin' && authTrust !== 'none') return undefined
  return '127.0.0.1'
}

/** Read `admin.auth.trust` from a site manifest's untyped auth block. */
export function authTrustOf(authBlock: unknown): string {
  const trust = (authBlock as { trust?: unknown } | undefined)?.trust
  return typeof trust === 'string' ? trust : 'none'
}
