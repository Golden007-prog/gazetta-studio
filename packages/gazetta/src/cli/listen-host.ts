/**
 * Which address the CLI's servers listen on (#1074).
 *
 * `gazetta dev` and `gazetta admin` mount the admin API, and with the
 * default `admin.auth` (`trust: 'none'`) every request gets the admin
 * role, so they listen on loopback unless `--host` says otherwise.
 * `gazetta serve` serves only the site and is what containers run, so it
 * keeps listening on every interface.
 */

export type ServerCommand = 'dev' | 'admin' | 'serve'

/** The hostname to pass to the Node server; `undefined` means every interface. */
export function resolveListenHost(command: ServerCommand, hostFlag?: string): string | undefined {
  if (hostFlag) return hostFlag
  return command === 'serve' ? undefined : '127.0.0.1'
}
