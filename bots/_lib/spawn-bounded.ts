/**
 * spawnSync with a time limit, for child processes the orchestrators wait
 * on. spawnSync blocks the whole bot, and feature-bot checks its per-cut
 * budget only between attempts, so a stalled child would otherwise run
 * until the job's own timeout, with no PR and no record.
 */
import { spawnSync } from 'node:child_process'

export type BoundedRun = { ok: true; stdout: string } | { ok: false; error: string }

export function spawnBounded(
  cmd: string,
  args: readonly string[],
  o: { timeoutMs: number; cwd?: string; captureStdout?: boolean; maxBuffer?: number },
): BoundedRun {
  const r = spawnSync(cmd, [...args], {
    cwd: o.cwd,
    stdio: ['ignore', o.captureStdout ? 'pipe' : 'ignore', 'pipe'],
    encoding: 'utf-8',
    maxBuffer: o.maxBuffer,
    timeout: o.timeoutMs,
    killSignal: 'SIGKILL',
  })
  if (r.status === 0) return { ok: true, stdout: r.stdout ?? '' }
  if ((r.error as NodeJS.ErrnoException | undefined)?.code === 'ETIMEDOUT') {
    return { ok: false, error: `${cmd} timed out after ${Math.round(o.timeoutMs / 1000)} s` }
  }
  return { ok: false, error: r.stderr?.trim() || r.error?.message || `${cmd} exited ${r.status}` }
}
