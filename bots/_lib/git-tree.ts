/**
 * Git working-tree helpers for the dead-code-watcher generator-critic
 * loop.
 *
 * Between Agent A attempts, the orchestrator needs to discard Agent A's
 * work-in-progress (uncommitted changes + the local branch with its
 * commits) and start over from a clean main. Without this, attempt 2's
 * Agent A would see attempt 1's changes still in the working tree —
 * not a fresh re-investigation.
 */
import { execFileSync } from 'node:child_process'

export interface GitExecOptions {
  cwd: string
  /** When true, log the command before running. Useful for orchestrator UI. */
  verbose?: boolean
}

/**
 * Reset to clean main: drop all uncommitted changes, switch to main,
 * delete the in-flight branch if it exists.
 *
 * Idempotent — calling on an already-clean main is a no-op (the
 * `branch -D` is best-effort).
 */
export function resetToMain(branchName: string, opts: GitExecOptions): void {
  // Discard unstaged changes + untracked files
  run(['git', 'reset', '--hard', 'HEAD'], opts)
  run(['git', 'clean', '-fd'], opts)
  // Switch to main (no-op if already there, but tolerates being on
  // any branch including a detached HEAD)
  run(['git', 'checkout', 'main'], opts)
  // Delete the in-flight branch if it exists. `-D` is hard-delete
  // (we explicitly DON'T want git complaining about unmerged commits
  // here — that's exactly the point of resetting).
  //
  // Use captured stdio: the branch usually doesn't exist on the
  // first attempt of a finding, and `git branch -D` prints
  // "error: branch 'X' not found" to stderr in that case. The
  // failure is harmless (we catch it) but the stderr line looks
  // alarming in workflow logs. Suppress it.
  try {
    execFileSync('git', ['branch', '-D', branchName], {
      cwd: opts.cwd,
      stdio: ['ignore', 'ignore', 'ignore'],
    })
  } catch {
    // Branch didn't exist locally — fine.
  }
}

/**
 * Capture the unified diff between a branch and main.
 * Used as input to the reviewer agent.
 *
 * Returns empty string when there are no changes (Agent A's attempt
 * produced no diff — usually means it picked a SKIP path).
 */
export function captureDiff(branchName: string, opts: GitExecOptions): string {
  try {
    return execFileSync('git', ['diff', `main...${branchName}`], {
      cwd: opts.cwd,
      encoding: 'utf-8',
      maxBuffer: 16 * 1024 * 1024,
      stdio: ['ignore', 'pipe', 'inherit'],
    })
  } catch {
    return ''
  }
}

/**
 * Capture commit messages from a branch (relative to main).
 * Used to surface Agent A's intent to the reviewer without exposing
 * Agent A's full transcript.
 */
export function captureCommitMessages(branchName: string, opts: GitExecOptions): string {
  try {
    return execFileSync('git', ['log', `main..${branchName}`, '--format=%B%n---'], {
      cwd: opts.cwd,
      encoding: 'utf-8',
      maxBuffer: 1 * 1024 * 1024,
      stdio: ['ignore', 'pipe', 'inherit'],
    }).trim()
  } catch {
    return ''
  }
}

/**
 * Repo-relative paths the branch changes relative to main. `[]` on git
 * failure, which callers treat as "nothing to check".
 */
export function captureChangedFiles(branchName: string, opts: GitExecOptions): string[] {
  try {
    return execFileSync('git', ['diff', '--name-only', `main...${branchName}`], {
      cwd: opts.cwd,
      encoding: 'utf-8',
      maxBuffer: 4 * 1024 * 1024,
      stdio: ['ignore', 'pipe', 'ignore'],
    })
      .split('\n')
      .map(l => l.trim())
      .filter(Boolean)
  } catch {
    return []
  }
}

/**
 * True when the given branch has commits beyond main.
 * Used to detect "Agent A committed nothing" vs "Agent A made changes."
 */
export function branchHasCommits(branchName: string, opts: GitExecOptions): boolean {
  try {
    const out = execFileSync('git', ['rev-list', '--count', `main..${branchName}`], {
      cwd: opts.cwd,
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim()
    return Number.parseInt(out, 10) > 0
  } catch {
    return false
  }
}

function run(args: string[], opts: GitExecOptions): void {
  if (opts.verbose) console.log(`$ ${args.join(' ')}`)
  execFileSync(args[0], args.slice(1), { cwd: opts.cwd, stdio: 'inherit' })
}
