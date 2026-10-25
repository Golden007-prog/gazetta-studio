/**
 * Integration test for #1184: `gazetta dev`, `gazetta admin` and
 * `gazetta serve` on a busy port exit 1 with a plain message naming the
 * port and `-p`, not a raw Node stack trace. The busy-port assertions fail
 * on code whose servers have no 'error' listener (Node rethrows the listen
 * error as an unhandled 'error' event with a node:events stack). Each
 * command is then started on the freed port to confirm a free port starts
 * unchanged.
 *
 * Slow: one held socket plus two spawned CLIs per command.
 */
import { describe, it, expect, afterEach } from 'vitest'
import { spawn, type ChildProcess } from 'node:child_process'
import { createServer, type Server } from 'node:net'
import { cp, mkdir, rm, writeFile } from 'node:fs/promises'
import { resolve, dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { tempDir } from './_helpers/temp.js'
import { resolveListenHost, type ServerCommand } from '../src/cli/listen-host.js'

const here = dirname(fileURLToPath(import.meta.url))
const repoRoot = resolve(here, '../../..')
const starterDir = resolve(repoRoot, 'examples/starter')
const cliPath = resolve(repoRoot, 'packages/gazetta/src/cli/index.ts')
const tsxBin = resolve(repoRoot, 'node_modules/.bin/tsx')

let children: ChildProcess[] = []
let holder: Server | null = null
let projectDir: string | null = null

async function stopChild(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null) return
  try {
    process.kill(-child.pid!, 'SIGTERM')
  } catch {
    child.kill('SIGTERM')
  }
  await Promise.race([new Promise(r => child.once('close', r)), new Promise(r => setTimeout(r, 5000))])
  if (child.exitCode === null) {
    try {
      process.kill(-child.pid!, 'SIGKILL')
    } catch {
      child.kill('SIGKILL')
    }
  }
}

afterEach(async () => {
  for (const child of children) await stopChild(child)
  children = []
  if (holder) {
    await new Promise(r => holder!.close(r))
    holder = null
  }
  if (projectDir) {
    await rm(projectDir, { recursive: true, force: true })
    projectDir = null
  }
})

function spawnCli(args: string[]): { child: ChildProcess; output: () => string } {
  let output = ''
  // detached: the CLI gets its own process group, so teardown can signal
  // the whole group. tsx runs the CLI in a descendant node process, and
  // killing only the wrapper leaves that server alive and holding the port.
  const child = spawn(tsxBin, [cliPath, ...args], {
    cwd: projectDir!,
    env: { ...process.env, CI: 'true' },
    stdio: ['ignore', 'pipe', 'pipe'],
    detached: true,
  })
  children.push(child)
  child.stdout?.on('data', d => (output += d.toString()))
  child.stderr?.on('data', d => (output += d.toString()))
  return { child, output: () => output }
}

/** Run the CLI to exit (expected when the port is busy). */
function runCli(args: string[]): Promise<{ code: number | null; output: string }> {
  return new Promise((resolvePromise, reject) => {
    const { child, output } = spawnCli(args)
    const timer = setTimeout(() => {
      child.kill('SIGKILL')
      reject(new Error(`timed out waiting for exit: ${args.join(' ')}\n${output()}`))
    }, 60000)
    child.once('close', code => {
      clearTimeout(timer)
      resolvePromise({ code, output: output() })
    })
  })
}

/** Start the CLI and resolve once a marker appears in its output. */
function runCliUntil(args: string[], marker: string): Promise<string> {
  return new Promise((resolvePromise, reject) => {
    const { child, output } = spawnCli(args)
    const timer = setInterval(() => {
      if (output().includes(marker)) {
        clearInterval(timer)
        clearTimeout(fail)
        resolvePromise(output())
      }
    }, 200)
    const fail = setTimeout(() => {
      clearInterval(timer)
      child.kill('SIGKILL')
      reject(new Error(`timed out waiting for "${marker}": ${args.join(' ')}\n${output()}`))
    }, 60000)
  })
}

function holdPort(port: number, host?: string): Promise<void> {
  holder = createServer()
  // Held on the same address the command under test binds, per
  // resolveListenHost: loopback for dev/admin, every interface for serve.
  // macOS allows a loopback bind next to a wildcard holder (and vice
  // versa), so one shared holder address cannot cover all commands.
  return new Promise<void>((res, rej) => {
    holder!.once('error', rej)
    if (host) holder!.listen(port, host, () => res())
    else holder!.listen(port, () => res())
  })
}

function freePort(): Promise<void> {
  return new Promise(r =>
    holder!.close(() => {
      holder = null
      r(undefined)
    }),
  )
}

describe('CLI on a busy port (#1184)', () => {
  const commands: { name: string; args: (port: number) => string[]; banner: string }[] = [
    { name: 'dev', args: p => ['dev', '-p', String(p)], banner: 'Local' },
    { name: 'admin', args: p => ['admin', '-p', String(p)], banner: 'Admin' },
    { name: 'serve', args: p => ['serve', 'local', '-p', String(p)], banner: 'Local' },
  ]

  for (const { name, args, banner } of commands) {
    it(`gazetta ${name} on a busy port prints a plain message and exits 1; a free port starts unchanged`, async () => {
      projectDir = tempDir(`busy-port-${name}-${Date.now()}`)
      await cp(starterDir, projectDir, { recursive: true })
      // The starter's dist/ is gitignored, so CI has no built admin UI and
      // `gazetta admin` would exit on that check before ever binding the
      // port. Drop the local build and stub the one file runAdmin requires;
      // the busy-port path is what is under test, not the admin UI.
      await rm(join(projectDir, 'dist'), { recursive: true, force: true })
      if (name === 'admin') {
        await mkdir(join(projectDir, 'dist/admin'), { recursive: true })
        await writeFile(join(projectDir, 'dist/admin/index.html'), '<html></html>')
      }

      const port = 4900 + Math.floor(Math.random() * 200)
      await holdPort(port, resolveListenHost(name as ServerCommand))

      const busy = await runCli(args(port))
      expect(busy.code).toBe(1)
      expect(busy.output).toContain(`Port ${port} is already in use`)
      expect(busy.output).toContain('-p')
      expect(busy.output).not.toContain('node:events')

      await freePort()
      const started = await runCliUntil(args(port), banner)
      expect(started).toContain(`http://localhost:${port}`)
    }, 180000)
  }
})
