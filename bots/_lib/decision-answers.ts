/**
 * Decision answers — find the maintainer's own answers in a Claude Code
 * session transcript, for the review-decisions skill.
 *
 * The skill approves a PR only when every decision it locks traces to an
 * answer the maintainer gave (design-decision-review.md Q2). The PR lists
 * each decision with the timestamp of that answer; this module looks each
 * one up and returns the answer together with what the maintainer was
 * shown, so the skill can compare the doc against exactly that (Q9).
 *
 * Only the maintainer's own input counts: a typed reply (`origin.kind` is
 * "human") or a picker answer whose `sourceToolAssistantUUID` points at a
 * real AskUserQuestion call. A message typed while a turn runs is a typed
 * reply too: a `queued_command` attachment whose origin is "human", backed
 * by the queue entries that record its typing and delivery. Notices, agent
 * reports, injected and compacted entries, pasted text and tool output don't.
 *
 * A transcript is tamper-evident, not tamper-proof: a shell command can
 * edit it. An answer whose links don't resolve, that was written out of
 * time order, or that shares its question with a second answer is
 * reported as broken; findTranscriptWrites and findSubagentWrites list
 * every command or file edit, the session's own or its sub-agents', that
 * may have written to a transcript.
 */

import { createReadStream, readdirSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { createInterface } from 'node:readline'
import { fileURLToPath } from 'node:url'

export type InputKind = 'typed' | 'picker'

export interface AskedOption {
  label: string
  description?: string
  preview?: string
}

export interface AskedQuestion {
  question: string
  header?: string
  multiSelect?: boolean
  options: AskedOption[]
}

export type LookupStatus = 'ok' | 'not-found' | 'not-your-input' | 'broken-link'

export interface AnswerLookup {
  at: string
  status: LookupStatus
  kind?: InputKind
  /** Typed: the reply, with pasted text replaced. Picker: question → answer. */
  answer?: string | Record<string, string>
  /** Typed: my text messages in that turn, oldest first. Picker: the questions as asked. */
  shown?: string[] | AskedQuestion[]
  /** The typed reply contained pasted text, which isn't the maintainer's own words. */
  pasted?: boolean
  reason?: string
}

export interface TranscriptWrite {
  at: string
  tool: string
  detail: string
  /** The sub-agent transcript the call is in; absent for the session's own transcript. */
  source?: string
}

export interface InputSummary {
  at: string
  kind: InputKind
  preview: string
}

interface Node {
  uuid: string
  parentUuid: string | null
  type: string
  timestamp: string
  pos: number
  originKind?: string
  isMeta: boolean
  isCompactSummary: boolean
  /** A message typed while a turn ran (a `queued_command` attachment). */
  queued: boolean
  /** The queued message's command, which its delivery entry names. */
  queueCommand?: string
  texts: string[]
  toolUseIds: Set<string>
  asks: Map<string, AskedQuestion[]>
  toolResultId?: string
  sourceToolAssistantUUID?: string
  answers?: Record<string, string>
}

interface ToolCall {
  at: string
  name: string
  input: Record<string, unknown>
}

export interface TranscriptIndex {
  nodes: Map<string, Node>
  byTimestamp: Map<string, string[]>
  order: Node[]
  toolCalls: ToolCall[]
  /** How many entries carry a result for each tool call id. */
  resultCounts: Map<string, number>
  /** When a queued message was typed, and how many entries came before that record. */
  enqueues: { timestamp: string; after: number }[]
  /** Commands of queued messages that were delivered. */
  delivered: Set<string>
}

export function emptyIndex(): TranscriptIndex {
  return {
    nodes: new Map(),
    byTimestamp: new Map(),
    order: [],
    toolCalls: [],
    resultCounts: new Map(),
    enqueues: [],
    delivered: new Set(),
  }
}

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)

function toQuestions(raw: unknown): AskedQuestion[] {
  if (!Array.isArray(raw)) return []
  const questions: AskedQuestion[] = []
  for (const q of raw) {
    if (!isRecord(q) || typeof q.question !== 'string' || !Array.isArray(q.options)) continue
    const options: AskedOption[] = []
    for (const o of q.options) {
      if (!isRecord(o) || typeof o.label !== 'string') continue
      options.push({
        label: o.label,
        ...(typeof o.description === 'string' ? { description: o.description } : {}),
        ...(typeof o.preview === 'string' ? { preview: o.preview } : {}),
      })
    }
    questions.push({
      question: q.question,
      ...(typeof q.header === 'string' ? { header: q.header } : {}),
      ...(typeof q.multiSelect === 'boolean' ? { multiSelect: q.multiSelect } : {}),
      options,
    })
  }
  return questions
}

function toAnswers(raw: unknown): Record<string, string> | undefined {
  if (!isRecord(raw) || !isRecord(raw.answers)) return undefined
  const answers: Record<string, string> = {}
  for (const [question, answer] of Object.entries(raw.answers)) {
    if (typeof answer === 'string') answers[question] = answer
  }
  return answers
}

/** Claude Code records a queued message's typing (`enqueue`) and its delivery (`remove`). */
function addQueueOperation(index: TranscriptIndex, entry: Record<string, unknown>): void {
  if (typeof entry.timestamp !== 'string') return
  if (entry.operation === 'enqueue') index.enqueues.push({ timestamp: entry.timestamp, after: index.order.length })
  if (entry.operation === 'remove' && typeof entry.commandUuid === 'string') index.delivered.add(entry.commandUuid)
}

/** Add one transcript line. Unparsable lines, and repeats of an id already seen, are ignored. */
export function addLine(index: TranscriptIndex, line: string): void {
  let entry: unknown
  try {
    entry = JSON.parse(line)
  } catch {
    return
  }
  if (isRecord(entry) && entry.type === 'queue-operation') return addQueueOperation(index, entry)
  if (!isRecord(entry) || typeof entry.uuid !== 'string' || index.nodes.has(entry.uuid)) return

  const timestamp = typeof entry.timestamp === 'string' ? entry.timestamp : ''
  // A message typed while a turn runs carries its origin and text on the attachment.
  const queued =
    entry.type === 'attachment' && isRecord(entry.attachment) && entry.attachment.type === 'queued_command'
      ? entry.attachment
      : undefined
  const origin = queued ? queued.origin : entry.origin
  const node: Node = {
    uuid: entry.uuid,
    parentUuid: typeof entry.parentUuid === 'string' ? entry.parentUuid : null,
    type: typeof entry.type === 'string' ? entry.type : '',
    timestamp,
    pos: index.order.length,
    originKind: isRecord(origin) && typeof origin.kind === 'string' ? origin.kind : undefined,
    isMeta: entry.isMeta === true,
    isCompactSummary: entry.isCompactSummary === true,
    queued: queued !== undefined,
    queueCommand: typeof queued?.source_uuid === 'string' ? queued.source_uuid : undefined,
    texts: [],
    toolUseIds: new Set(),
    asks: new Map(),
    sourceToolAssistantUUID:
      typeof entry.sourceToolAssistantUUID === 'string' ? entry.sourceToolAssistantUUID : undefined,
    answers: toAnswers(entry.toolUseResult),
  }

  const content = queued ? queued.prompt : isRecord(entry.message) ? entry.message.content : undefined
  if (typeof content === 'string') node.texts.push(content)
  if (Array.isArray(content)) {
    for (const block of content) {
      if (!isRecord(block)) continue
      if (block.type === 'text' && typeof block.text === 'string') node.texts.push(block.text)
      if (block.type === 'tool_result' && typeof block.tool_use_id === 'string') {
        node.toolResultId = block.tool_use_id
        index.resultCounts.set(block.tool_use_id, (index.resultCounts.get(block.tool_use_id) ?? 0) + 1)
      }
      if (block.type === 'tool_use' && typeof block.id === 'string' && typeof block.name === 'string') {
        node.toolUseIds.add(block.id)
        const input = isRecord(block.input) ? block.input : {}
        if (block.name === 'AskUserQuestion') node.asks.set(block.id, toQuestions(input.questions))
        index.toolCalls.push({ at: timestamp, name: block.name, input })
      }
    }
  }

  index.nodes.set(node.uuid, node)
  index.order.push(node)
  const sameTime = index.byTimestamp.get(timestamp)
  if (sameTime) sameTime.push(node.uuid)
  else index.byTimestamp.set(timestamp, [node.uuid])
}

export function indexLines(lines: Iterable<string>): TranscriptIndex {
  const index = emptyIndex()
  for (const line of lines) addLine(index, line)
  return index
}

const PASTED = /<pasted_content\b[^>]*>[\s\S]*?<\/pasted_content>/g

/** Only a session's first entry has no parent; any other parent must be an earlier entry. */
function hasEarlierParent(index: TranscriptIndex, node: Node): boolean {
  if (node.parentUuid === null) return node.pos === 0
  const parent = index.nodes.get(node.parentUuid)
  return parent !== undefined && parent.pos < node.pos
}

/** Entries are written in time order, so one written at `pos` can't carry an earlier time than the entry before it. */
function isInTimeOrder(index: TranscriptIndex, pos: number, timestamp: string): boolean {
  for (let p = pos - 1; p >= 0; p--) {
    const previous = index.order[p].timestamp
    if (previous) return previous <= timestamp
  }
  return true
}

/** The checks Q9 puts on the entry itself, whatever kind of answer it is. */
function entryProblem(index: TranscriptIndex, node: Node): string | undefined {
  if (!hasEarlierParent(index, node)) return 'its parent entry is missing'
  if (!isInTimeOrder(index, node.pos, node.timestamp)) return 'it is timestamped earlier than the entry before it'
  return undefined
}

/** The queue entry and the message take their times from separate clock reads, seen 0–2 ms apart. */
const QUEUE_CLOCK_SLACK_MS = 1000

/**
 * A message typed while a turn runs is written when it's delivered, after the
 * entries from the time in between, so its own time can't follow the entry
 * before it. Its time order is checked instead at the queue entry written
 * when it was typed, and its delivery at the one naming its command. A
 * message appended later has no earlier queue entry.
 */
function queuedProblem(index: TranscriptIndex, node: Node): string | undefined {
  if (!hasEarlierParent(index, node)) return 'its parent entry is missing'
  const typedAt = Date.parse(node.timestamp)
  const typing = index.enqueues.find(
    e => e.after <= node.pos && Math.abs(Date.parse(e.timestamp) - typedAt) <= QUEUE_CLOCK_SLACK_MS,
  )
  if (!typing) return 'no earlier queue entry records it being typed'
  if (!isInTimeOrder(index, typing.after, typing.timestamp)) {
    return 'the queue entry for its typing is timestamped earlier than the entry before it'
  }
  if (!node.queueCommand || !index.delivered.has(node.queueCommand)) return 'no queue entry records its delivery'
  return undefined
}

function isPickerAnswer(index: TranscriptIndex, node: Node): boolean {
  if (!node.toolResultId || !node.answers) return false
  const source = node.sourceToolAssistantUUID ? index.nodes.get(node.sourceToolAssistantUUID) : undefined
  return source !== undefined && source.asks.has(node.toolResultId)
}

function isTypedReply(node: Node): boolean {
  return (
    (node.type === 'user' || node.queued) &&
    node.originKind === 'human' &&
    !node.isMeta &&
    !node.isCompactSummary &&
    !node.toolResultId &&
    node.texts.length > 0
  )
}

/** My text messages between the previous maintainer input and this reply, oldest first. */
function turnTexts(index: TranscriptIndex, reply: Node): string[] {
  const texts: string[] = []
  const seen = new Set<string>()
  let current = reply.parentUuid ? index.nodes.get(reply.parentUuid) : undefined
  while (current && !seen.has(current.uuid)) {
    seen.add(current.uuid)
    if (isTypedReply(current) || isPickerAnswer(index, current)) break
    if (current.type === 'assistant') texts.unshift(...current.texts)
    current = current.parentUuid ? index.nodes.get(current.parentUuid) : undefined
  }
  return texts
}

function classify(index: TranscriptIndex, node: Node): AnswerLookup {
  const at = node.timestamp
  if (node.type !== 'user' && !node.queued) {
    return { at, status: 'not-your-input', reason: `a ${node.type || 'untyped'} entry` }
  }

  if (node.toolResultId) {
    const source = node.sourceToolAssistantUUID ? index.nodes.get(node.sourceToolAssistantUUID) : undefined
    if (!source || source.pos >= node.pos) {
      return { at, status: 'broken-link', reason: 'the question it answers is not earlier in the transcript' }
    }
    if (!source.toolUseIds.has(node.toolResultId)) {
      return { at, status: 'broken-link', reason: 'the message it points to did not make that call' }
    }
    const asked = source.asks.get(node.toolResultId)
    if (!asked) return { at, status: 'not-your-input', reason: 'tool output, not a picker answer' }
    const problem = entryProblem(index, node)
    if (problem) return { at, status: 'broken-link', reason: problem }
    if ((index.resultCounts.get(node.toolResultId) ?? 0) > 1) {
      return { at, status: 'broken-link', reason: 'its question has more than one answer' }
    }
    if (!node.answers) return { at, status: 'not-your-input', reason: 'the picker recorded no answer' }
    return { at, status: 'ok', kind: 'picker', answer: node.answers, shown: asked }
  }

  if (node.isMeta) return { at, status: 'not-your-input', reason: 'injected by Claude Code (isMeta)' }
  if (node.isCompactSummary) return { at, status: 'not-your-input', reason: 'a compaction summary' }
  if (node.originKind !== 'human') {
    return { at, status: 'not-your-input', reason: `origin is ${node.originKind ?? 'missing'}, not human` }
  }
  if (node.texts.length === 0) return { at, status: 'not-your-input', reason: 'no text' }
  const problem = node.queued ? queuedProblem(index, node) : entryProblem(index, node)
  if (problem) return { at, status: 'broken-link', reason: problem }

  const text = node.texts.join('\n')
  const answer = text.replace(PASTED, '[pasted text]')
  return {
    at,
    status: 'ok',
    kind: 'typed',
    answer,
    shown: turnTexts(index, node),
    ...(answer !== text ? { pasted: true } : {}),
  }
}

/** Look up the maintainer's answer recorded at `at` (an entry timestamp, exactly as in the transcript). */
export function lookupAnswer(index: TranscriptIndex, at: string): AnswerLookup {
  const ids = index.byTimestamp.get(at)
  if (!ids) return { at, status: 'not-found', reason: 'no entry has this timestamp' }
  const nodes = ids.map(id => index.nodes.get(id)).filter((n): n is Node => n !== undefined)
  const results = nodes.map(n => classify(index, n))
  return results.find(r => r.status === 'ok') ?? results.find(r => r.status === 'broken-link') ?? results[0]
}

/** The maintainer's typed replies and picker answers, in transcript order. */
export function listInputs(index: TranscriptIndex, since = ''): InputSummary[] {
  const inputs: InputSummary[] = []
  for (const node of index.order) {
    if ((node.type !== 'user' && !node.queued) || node.timestamp < since) continue
    const result = classify(index, node)
    if (result.status !== 'ok' || !result.kind) continue
    const preview =
      typeof result.answer === 'string'
        ? result.answer
        : Object.entries(result.answer ?? {})
            .map(([q, a]) => `${q} → ${a}`)
            .join(' | ')
    inputs.push({ at: node.timestamp, kind: result.kind, preview: preview.slice(0, 160) })
  }
  return inputs
}

const TRANSCRIPT_PATH = /\.claude\/projects\/.+\.jsonl$/
const HARMLESS_REDIRECTS = /&?\d*>\s*\/dev\/null|\d*>&\d/g
// Checked on the shell part only: a `>` inside a heredoc script is code, not a redirect.
const SHELL_WRITE_SIGNS = [
  /(^|[^<])>>?/,
  /\btee\b/,
  /\bsed\s+(-\w+\s+)*-i/,
  /\bperl\s+-\w*i/,
  /\b(mv|cp|rm|truncate|dd)\b/,
]
// Checked on the whole command, heredoc scripts included.
const CODE_WRITE_SIGNS = [/\bopen\([^)]*['"][wax]\+?b?['"]/, /\b(writeFile|appendFile)(Sync)?\b/, /\bwrite_text\(/]

/** The command without its heredoc bodies. */
function shellPart(command: string): string {
  const shell: string[] = []
  let terminator: string | null = null
  for (const line of command.split('\n')) {
    if (terminator !== null) {
      if (line.trim() === terminator) terminator = null
      continue
    }
    shell.push(line)
    const start = /<<-?\s*['"]?([A-Za-z_]\w*)['"]?/.exec(line)
    if (start) terminator = start[1]
  }
  return shell.join('\n')
}

function shellWritesTranscript(command: string): boolean {
  if (!command.includes('.claude/projects') || !command.includes('.jsonl')) return false
  const shell = shellPart(command).replace(HARMLESS_REDIRECTS, '')
  if (shell.includes('.jsonl') && SHELL_WRITE_SIGNS.some(sign => sign.test(shell))) return true
  return CODE_WRITE_SIGNS.some(sign => sign.test(command))
}

const FILE_WRITE_TOOLS = new Set(['Write', 'Edit', 'MultiEdit', 'NotebookEdit'])

/** The text a file-writing tool call puts into its file. */
function writtenText(input: Record<string, unknown>): string[] {
  const texts = [input.content, input.new_string, input.new_source].filter((t): t is string => typeof t === 'string')
  if (Array.isArray(input.edits)) {
    for (const edit of input.edits)
      if (isRecord(edit) && typeof edit.new_string === 'string') texts.push(edit.new_string)
  }
  return texts
}

/** A script written to a file, then run without naming the transcript, carries the write in its own text. */
function textWritesTranscript(path: unknown, text: string): boolean {
  if (!text.includes('.claude/projects') || !text.includes('.jsonl')) return false
  if (CODE_WRITE_SIGNS.some(sign => sign.test(text))) return true
  const shellScript = (typeof path === 'string' && path.endsWith('.sh')) || text.startsWith('#!')
  return shellScript && shellWritesTranscript(text)
}

/** Every command or file edit that may have written to a transcript file. Over-reports on purpose. */
export function findTranscriptWrites(index: TranscriptIndex): TranscriptWrite[] {
  const writes: TranscriptWrite[] = []
  for (const call of index.toolCalls) {
    if (call.name === 'Bash' && typeof call.input.command === 'string') {
      if (shellWritesTranscript(call.input.command))
        writes.push({ at: call.at, tool: 'Bash', detail: call.input.command })
      continue
    }
    if (!FILE_WRITE_TOOLS.has(call.name)) continue
    const path = call.input.file_path ?? call.input.notebook_path
    if (typeof path === 'string' && TRANSCRIPT_PATH.test(path))
      writes.push({ at: call.at, tool: call.name, detail: path })
    else if (writtenText(call.input).some(text => textWritesTranscript(path, text)))
      writes.push({ at: call.at, tool: call.name, detail: typeof path === 'string' ? path : '' })
  }
  return writes
}

/** The same check over the session's sub-agents, whose transcripts sit in `<session>/subagents/`. */
export async function findSubagentWrites(projectDir: string, session: string): Promise<TranscriptWrite[]> {
  const dir = join(projectDir, session, 'subagents')
  let files: string[]
  try {
    files = readdirSync(dir)
      .filter(f => f.endsWith('.jsonl'))
      .sort()
  } catch {
    return []
  }
  const writes: TranscriptWrite[] = []
  for (const file of files) {
    for (const write of findTranscriptWrites(await readIndex(join(dir, file)))) writes.push({ ...write, source: file })
  }
  return writes
}

/** Claude Code keeps a project's transcripts in ~/.claude/projects/<cwd with non-alphanumerics as dashes>. */
export function projectDirFor(cwd: string, home: string): string {
  return join(home, '.claude', 'projects', cwd.replace(/[^A-Za-z0-9]/g, '-'))
}

// --- Script entry -------------------------------------------------------

const USAGE = `Usage:
  tsx bots/_lib/decision-answers.ts [--project-dir DIR] [--session ID] --at ISO [--at ISO ...]
  tsx bots/_lib/decision-answers.ts [--project-dir DIR] [--session ID] --list [--since ISO]`

function newestSession(projectDir: string): string {
  const sessions = readdirSync(projectDir)
    .filter(f => f.endsWith('.jsonl'))
    .map(f => ({ id: f.slice(0, -'.jsonl'.length), mtime: statSync(join(projectDir, f)).mtimeMs }))
    .sort((a, b) => b.mtime - a.mtime)
  if (sessions.length === 0) throw new Error(`no transcripts in ${projectDir}`)
  return sessions[0].id
}

async function readIndex(file: string): Promise<TranscriptIndex> {
  const index = emptyIndex()
  const lines = createInterface({ input: createReadStream(file), crlfDelay: Number.POSITIVE_INFINITY })
  for await (const line of lines) addLine(index, line)
  return index
}

async function main(argv: string[]): Promise<number> {
  let projectDir = projectDirFor(process.cwd(), homedir())
  let session: string | undefined
  let since = ''
  let list = false
  const at: string[] = []
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    const value = argv[i + 1]
    if (arg === '--project-dir' && value) projectDir = argv[++i]
    else if (arg === '--session' && value) session = argv[++i]
    else if (arg === '--at' && value) at.push(argv[++i])
    else if (arg === '--since' && value) since = argv[++i]
    else if (arg === '--list') list = true
    else {
      process.stderr.write(`${USAGE}\n`)
      return 2
    }
  }
  if (!list && at.length === 0) {
    process.stderr.write(`${USAGE}\n`)
    return 2
  }

  const id = session ?? newestSession(projectDir)
  const file = join(projectDir, `${id}.jsonl`)
  const index = await readIndex(file)
  const result = list
    ? { session: id, file, inputs: listInputs(index, since) }
    : {
        session: id,
        file,
        answers: at.map(a => lookupAnswer(index, a)),
        transcriptWrites: [...findTranscriptWrites(index), ...(await findSubagentWrites(projectDir, id))],
      }
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`)
  return 0
}

const isMain = import.meta.url === `file://${process.argv[1]}` || fileURLToPath(import.meta.url) === process.argv[1]

// process.exitCode, not process.exit(): exiting drops output a pipe hasn't taken yet.
if (isMain) {
  main(process.argv.slice(2)).then(
    code => {
      process.exitCode = code
    },
    err => {
      process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`)
      process.exitCode = 1
    },
  )
}
