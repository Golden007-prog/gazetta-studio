/**
 * Small UI helpers for bot orchestrators — banners, section headers,
 * summaries. All output goes to stdout.
 *
 * Goals:
 *   - A maintainer scanning a workflow log should see (a) what the bot is
 *     about to do, (b) per-candidate progress, (c) what got done at the end
 *     — without reading every Claude tool call
 *   - Output is also convenient for Claude Code reading past transcripts:
 *     the JSONL transcript is the source of truth for replay/improvement;
 *     this module only shapes the live workflow log
 *   - Colors + emoji for skim-ability; respects NO_COLOR for accessibility
 *     and `colors.ts` enables the right behavior in workflow logs vs. piped
 *     output
 */
import { c } from './colors.js'

/**
 * Print a startup banner naming the bot, its job, and its input contract.
 * Called once at the top of main(). Replaces the ad-hoc one-line "X bot:
 * scanning Y" message most bots had.
 */
export function printBanner(opts: {
  name: string
  /** A short tagline shown next to the name (e.g., "producer bot · self-classifies"). */
  tagline?: string
  purpose: string
  /** Lines describing what the bot looks for. */
  inputs: string[]
  /** Lines describing what the bot produces. */
  outputs: string[]
}): void {
  const bar = '─'.repeat(72)
  const name = opts.tagline ? `${c.bold(opts.name)} ${c.dim('·')} ${c.dim(opts.tagline)}` : c.bold(opts.name)
  console.log()
  console.log(c.cyan(`╭${bar}╮`))
  console.log(`${c.cyan('│')} 🤖 ${name}`)
  console.log(c.cyan(`╰${bar}╯`))
  console.log(`   ${opts.purpose}`)
  console.log()
  console.log(c.dim('   📥 Input'))
  for (const line of opts.inputs) console.log(`     ${c.dim('•')} ${line}`)
  console.log(c.dim('   📤 Output'))
  for (const line of opts.outputs) console.log(`     ${c.dim('•')} ${line}`)
  console.log()
}

/**
 * Print a header for a single candidate being processed. Appears between
 * each Claude invocation in a multi-candidate run.
 */
export function printCandidateHeader(opts: {
  index: number
  total: number
  label: string
  /** Optional metadata lines (e.g., labels, age). */
  meta?: string[]
  /** Seconds since the run started. */
  elapsedSec: number
}): void {
  const counter = c.dim(`[${opts.index}/${opts.total}]`)
  const elapsed = c.dim(`${opts.elapsedSec}s`)
  console.log()
  console.log(`${c.blue('▶')} ${counter} ${c.bold(opts.label)} ${c.dim('·')} ${elapsed}`)
  if (opts.meta?.length) {
    for (const m of opts.meta) console.log(`  ${c.dim('└')} ${c.dim(m)}`)
  }
}

/**
 * Print the path of the transcript that's being written for this
 * candidate. Indented so it sits visually under the candidate header.
 */
export function printTranscriptPath(path: string): void {
  console.log(`  ${c.dim('└ 📝')} ${c.dim(path)}`)
}

/**
 * Print the final run summary. Called at the end of main() for every bot
 * to give a consistent "what did we actually do" report.
 */
export function printRunSummary(opts: {
  /** "Triaged", "Investigated", "Researched", etc. */
  verb: string
  processed: number
  total: number
  skipped: number
  /** Optional extra lines (e.g., "Filed 2 new issues, commented on 1"). */
  notes?: string[]
  elapsedSec: number
}): void {
  const bar = '─'.repeat(72)
  const summary = `${opts.verb} ${c.bold(`${opts.processed}/${opts.total}`)} in ${c.bold(`${opts.elapsedSec}s`)}`
  console.log()
  console.log(c.green(`╭${bar}╮`))
  console.log(`${c.green('│')} ✅ Run complete · ${summary}`)
  if (opts.skipped > 0) {
    console.log(`${c.green('│')} ${c.yellow(`⏭  ${opts.skipped} skipped`)} ${c.dim('— see above')}`)
  }
  if (opts.notes?.length) {
    for (const n of opts.notes) console.log(`${c.green('│')}    ${c.dim(n)}`)
  }
  console.log(c.green(`╰${bar}╯`))
}

/**
 * Print a short notice (one line) — useful for things like "no candidates
 * found, exiting" or "DRY_RUN — exiting before Claude."
 */
export function printNotice(message: string): void {
  console.log(`\n${c.cyan('ℹ')} ${message}`)
}

/**
 * Print a non-fatal warning. Used when one candidate failed but the run
 * continues. Stands out from regular log lines without being alarmist.
 */
export function printWarning(message: string): void {
  console.log(`${c.yellow('⚠')} ${message}`)
}

/**
 * Print the candidate-list preview after the scan but before processing
 * starts. Shows what the bot will do this run — the maintainer doesn't
 * have to wait for the per-candidate output to know the scope.
 */
export function printCandidateList(opts: {
  /** Singular noun: "candidate", "issue", "flake". */
  noun: string
  candidates: Array<{ ref: string; label: string; meta?: string }>
  /** How the list is ordered, shown in the heading. Default: "oldest first". */
  order?: string
}): void {
  if (opts.candidates.length === 0) return
  const plural = opts.candidates.length === 1 ? opts.noun : `${opts.noun}s`
  console.log(c.dim(`\n📋 ${opts.candidates.length} ${plural} (${opts.order ?? 'oldest first'}):`))
  for (const candidate of opts.candidates) {
    const meta = candidate.meta ? c.dim(` ${candidate.meta}`) : ''
    console.log(`   ${c.dim(candidate.ref)} ${candidate.label}${meta}`)
  }
}
