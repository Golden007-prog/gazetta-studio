/**
 * CLI argument parsing, kept out of `cli/index.ts` (which runs the CLI on
 * import) so it can be tested directly.
 */

export interface ParsedArgs {
  positional: string[]
  port?: number
  /** `--host <address>`: the address `dev`, `admin` and `serve` listen on. */
  host?: string
  force?: boolean
  yes?: boolean
  limit?: number
}

export function parseArgs(input: string[]): ParsedArgs {
  const positional: string[] = []
  let port: number | undefined
  let host: string | undefined
  let force = false
  let yes = false
  let limit: number | undefined
  for (let i = 0; i < input.length; i++) {
    if (input[i] === '--port' || input[i] === '-p') {
      port = parseInt(input[++i], 10)
    } else if (input[i] === '--host') {
      host = input[++i]
    } else if (input[i].startsWith('--host=')) {
      host = input[i].slice('--host='.length)
    } else if (input[i] === '--force' || input[i] === '-f') {
      force = true
    } else if (input[i] === '--yes' || input[i] === '-y') {
      yes = true
    } else if (input[i] === '--limit') {
      limit = parseInt(input[++i], 10)
    } else if (input[i] === '--to') {
      i++ // consume the locale value — translate command reads it from raw args
    } else if (input[i].startsWith('--to=')) {
      // consumed by translate command directly
    } else if (!input[i].startsWith('-')) {
      positional.push(input[i])
    }
  }
  return { positional, port, host, force, yes, limit }
}
