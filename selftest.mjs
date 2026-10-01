/**
 * Self-test for both halves — the `/review` path against a stub Context, then the loaded Client card. Run: node selftest.mjs
 */
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, statSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, isAbsolute, join, relative, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { apply, BUILT_IN_MODES, DEFAULTS } from './index.js'

const HERE = dirname(fileURLToPath(import.meta.url))

const SESSION = 'session-under-test'
const MARKER = '<!-- code-review:payload -->'

// Hermetic: the run must never read the developer's real DSH_HOME/code-review/config.json, or this machine's settings would decide what the assertions mean.
process.env.DSH_HOME = mkdtempSync(join(tmpdir(), 'dsh-code-review-home-'))

// A real workspace, because the reader tools touch the filesystem.
const WS = mkdtempSync(join(tmpdir(), 'dsh-code-review-ws-'))
mkdirSync(join(WS, 'internal', 'chessx'), { recursive: true })
mkdirSync(join(WS, 'internal', 'play'), { recursive: true })
writeFileSync(join(WS, 'internal', 'chessx', 'board.go'), [
  'package chessx',
  '',
  '// Board is a board.',
  'type Board struct {',
  '\tsquares []int',
  '}',
  '',
  'func (b *Board) Reset() {',
  '\tb.squares = nil',
  '}',
  '',
].join('\n'))
writeFileSync(join(WS, 'internal', 'play', 'move.go'), [
  'package play',
  '',
  'func Apply(b *chessx.Board) {',
  '\tb.Reset() // MARKER_NIL_SQUARES',
  '}',
  '',
].join('\n'))
writeFileSync(
  join(WS, 'needle.go'),
  Array.from({ length: 10 }, (_, index) => `// NEEDLE_ROW_${index}`).join('\n'),
)
/** A line that exists only in a file the reviewer must read for itself. */
const READ_ONLY_LINE = 'b.Reset() // MARKER_NIL_SQUARES'
const READ_ONLY_FILE = 'internal/play/move.go'

/** A Context stub exposing only what the plugin body touches; `script` answers one model call per entry, its last repeating.
 * `failAtCall` and `abortAtCall` are 1-based, and `failAtCall` may name a list of calls to fail.
 * `toolService: false` exposes no harness tool service at all, while `toolNames` decides which of the harness's
 * `read`/`grep` it exposes. `readFails`/`grepFails` make that tool fail — a message or `true` for an error result,
 * `{ throws: message }` for a call that throws instead; `readLimit` caps the window `read` accepts, so a call asking
 * for more is refused while a call without a `limit` is served; `readMalformed`/`grepMalformed` make a call that
 * succeeds answer with a `value` the wrapper does not declare (`'lines'`/`'text'`/`'totalLines'` for `read`,
 * `'matches'`/`'row'` for `grep`, `true` meaning the first); `readPath: 'relative'` makes `read` report a relative
 * `value.path`, where the real backend reports the absolute spelling it resolved; `abortOnTool` cancels the command
 * while a tool is running, which is a cancel landing mid-read. */
function harness({
  summary,
  summaries,
  events = [7],
  diffs,
  script = [record([], 'ok')],
  hasEvent = true,
  route = { options: { provider: 'deepseek-official', model: 'deepseek-flash' } },
  steerThrows = false,
  failAtCall = 0,
  failWith = 'the stream broke',
  abortAtCall = 0,
  git = true,
  cwd = WS,
  messages = [{ role: 'user', content: [{ type: 'text', text: 'Board ı hesapla' }] }],
  toolCalls = [],
  modelInfo,
  modelInfoThrows = false,
  toolService = true,
  toolNames = ['read', 'grep'],
  readFails = false,
  grepFails = false,
  readLimit,
  readMalformed = false,
  grepMalformed = false,
  readPath = 'absolute',
  abortOnTool = false,
}) {
  const subprocess = git ? realSubprocess() : undefined
  const seen = { prompts: [], steer: [], inject: [], steerAttempts: 0, modelInfo: [] }
  const controller = new AbortController()
  const tools = fakeToolService(cwd, {
    names: toolNames,
    readFails,
    grepFails,
    readLimit,
    readMalformed,
    grepMalformed,
    readPath,
    onCall: () => { if (abortOnTool) controller.abort() },
  })
  let definition
  let call = 0
  const ctx = {
    effect(callback) { callback() },
    get(name) {
      if (name === 'subprocess') return subprocess
      return name === 'tools' && toolService ? tools : undefined
    },
    commands: { register(value) { definition = value; return () => {} } },
    workspaceChanges: {
      summary: (_id, seq) => (summaries === undefined ? summary : summaries[seq]),
      diff: async (_id, _seq, index) => diffs[index],
    },
    llm: {
      ...modelInfo === undefined && !modelInfoThrows ? {} : {
        async resolveModelInfo(provider, model) {
          seen.modelInfo.push({ provider, model })
          if (modelInfoThrows) throw new Error('no adapter for this route')
          return modelInfo
        },
      },
      stream(request) {
        // Each recorded request keeps the message list as it was sent, so an assertion about one call
        // means what that call actually saw.
        seen.prompts.push({ ...request, messages: [...request.messages] })
        const step = script[Math.min(call, script.length - 1)]
        call += 1
        const failing = Array.isArray(failAtCall) ? failAtCall.includes(call) : failAtCall === call
        const aborting = abortAtCall === call
        return (async function* generate() {
          if (aborting) {
            controller.abort()
            throw new Error('the run was aborted')
          }
          if (failing) throw new Error(failWith)
          if (Array.isArray(step.toolCalls)) {
            for (const [index, tool] of step.toolCalls.entries()) {
              const id = `call-${call}-${index}`
              yield { type: 'tool-call-delta', index, id, name: tool.name, argumentsDelta: tool.arguments }
              yield { type: 'block-end', index, block: { type: 'tool-call', id, name: tool.name, arguments: tool.arguments } }
            }
            yield { type: 'finish', reason: { kind: 'tool-calls' } }
            return
          }
          for (const chunk of String(step.text).match(/[\s\S]{1,17}/g) ?? []) {
            yield { type: 'text-delta', text: chunk }
          }
          yield { type: 'finish', reason: { kind: 'stop' } }
        })()
      },
    },
  }
  apply(ctx)
  const session = {
    id: SESSION,
    header: { cwd },
    snapshotEvents: () => [
      ...toolCalls.map((call, index) => ({
        type: 'tool/call',
        seq: 100 + index,
        data: { callId: `call-${index}`, name: call.name, arguments: JSON.stringify(call.arguments ?? {}) },
      })),
      ...(hasEvent
        ? [...events.map(seq => ({ type: 'workspace/changes', seq })), { type: 'turn/end', seq: 99 }]
        : [{ type: 'turn/end', seq: 6 }]),
    ],
    deriveMessages: () => messages,
  }
  const agent = {
    id: SESSION,
    session,
    ...route,
    steer(message) {
      seen.steerAttempts += 1
      if (steerThrows) throw new Error('inbox is closed')
      seen.steer.push(message)
    },
    inject(message) { seen.inject.push(message) },
  }
  const invoke = rawInput => definition.handler({
    commandId: 'c1', agent, rawInput, attachments: [], signal: controller.signal,
  })
  return { invoke, seen, name: definition.name, definition, tools }
}

function realSubprocess() {
  const reader = text => ({ readFrom: () => ({ text, nextOffset: text.length, lossy: false }) })
  return {
    async resolveExecutable(command) {
      const probe = spawnSync(command, ['--version'], { encoding: 'utf8' })
      if (probe.error !== undefined && probe.error !== null) throw new Error(`not found: ${command}`)
      return command
    },
    spawn(spec) {
      const [command, ...args] = spec.argv
      const result = spawnSync(command, args, { cwd: spec.cwd, encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 })
      const stdout = result.stdout ?? ''
      const stderr = result.stderr ?? result.error?.message ?? ''
      return {
        stdin: undefined,
        stdout: undefined,
        stderr: undefined,
        control: undefined,
        collected: { stdout: reader(stdout), stderr: reader(stderr) },
        done: Promise.resolve({ exitCode: result.status ?? (stderr === '' ? 0 : 1), signal: null }),
        terminate() {},
        async waitForExit() { return true },
      }
    },
  }
}

/**
 * The harness's own `read` and `grep`, over the real workspace, shaped like the
 * results the plugin's wrappers are written against: a failure is an `isError`
 * result whose first text block carries the message, a success carries the
 * `value` the wrapper reads. Faithful where it matters — the window is 1-based
 * and numbered, `totalLines` is the whole file, `read` reports the absolute path
 * it resolved, grep takes a regular expression and skips binary files, and a path
 * outside the workspace, a directory, a binary file and a missing file are
 * refused rather than read — and every call is recorded so a test can prove what
 * reached the harness and what never did. `readFails`/`grepFails` break one tool
 * (`{ throws: message }` throws instead of returning the error result), `readLimit`
 * is the window `read` accepts at most (a larger `limit` is refused; a call that
 * sends no `limit` is served the deployment's own default), `readMalformed` and
 * `grepMalformed` turn a success into a `value` the wrapper cannot read, and
 * `onCall` runs just before each call is served.
 */
function fakeToolService(workspace, { names = ['read', 'grep'], readFails = false, grepFails = false, readLimit, readMalformed = false, grepMalformed = false, readPath = 'absolute', onCall } = {}) {
  const calls = []
  let root = resolve(workspace)
  try {
    root = realpathSync(root)
  } catch {
    // A workspace that does not exist yet is still a boundary; the lexical root names it.
  }
  const failure = message => ({ isError: true, error: { message }, content: [{ type: 'text', text: `Error: ${message}` }] })
  const shown = path => relative(root, path).replace(/\\/g, '/')
  const escapes = path => {
    const lexical = relative(root, resolve(root, path))
    if (lexical !== '' && (lexical.startsWith('..') || isAbsolute(lexical))) return true
    try {
      const physical = relative(root, realpathSync(resolve(root, path)))
      return physical !== '' && (physical.startsWith('..') || isAbsolute(physical))
    } catch {
      return false
    }
  }
  function read(args) {
    const requested = String(args.file_path ?? '')
    if (requested.trim() === '') return failure('file_path must be a non-empty string')
    const target = resolve(root, requested)
    if (escapes(target)) return failure(`"${requested}" is outside the workspace`)
    let stat
    try {
      stat = statSync(target)
    } catch {
      return failure(`cannot read "${shown(target)}": not found`)
    }
    if (!stat.isFile()) return failure(`cannot read "${shown(target)}": not a regular file`)
    let content
    try {
      content = readFileSync(target, 'utf8')
    } catch (error) {
      return failure(`cannot read "${shown(target)}": ${error?.code ?? String(error)}`)
    }
    if (content.includes('\u0000')) return failure(`cannot read "${shown(target)}": binary file`)
    const raw = content.split('\n')
    const fileLines = (raw.at(-1) === '' ? raw.slice(0, -1) : raw).map(line => (line.endsWith('\r') ? line.slice(0, -1) : line))
    const offset = Number.isInteger(args.offset) && args.offset > 0 ? args.offset : 1
    // A deployment may cap the window it reads without publishing the cap among the tool's
    // parameters: asking for more is the refusal the review retries without a `limit`.
    if (readLimit !== undefined && Number.isInteger(args.limit) && args.limit > readLimit) {
      return failure(`"limit" ${args.limit} is over the ${readLimit} lines this harness reads at most`)
    }
    const asked = Number.isInteger(args.limit) && args.limit > 0 ? args.limit : (readLimit ?? 2000)
    const limit = readLimit === undefined ? asked : Math.min(asked, readLimit)
    if (offset > fileLines.length && !(fileLines.length === 0 && offset === 1)) {
      return failure(`offset ${offset} is out of range for "${shown(target)}" (${fileLines.length} lines)`)
    }
    const lines = fileLines.slice(offset - 1, offset - 1 + limit).map((text, index) => ({ number: offset + index, text }))
    // The real `read` reports the path its backend resolved, which is absolute for the absolute `file_path` the wrapper sends.
    const reported = readPath === 'relative' ? shown(target) : target
    if (readMalformed !== false) {
      const shape = readMalformed === true ? 'lines' : readMalformed
      const values = {
        lines: { path: reported, offset, lines: `${lines.length} line(s)`, totalLines: fileLines.length },
        text: { path: reported, offset, lines: lines.map(line => ({ number: line.number, text: line.number })), totalLines: fileLines.length },
        totalLines: { path: reported, offset, lines, totalLines: String(fileLines.length) },
      }
      return { isError: false, value: values[shape], content: [{ type: 'text', text: '[the harness answered with a shape it does not declare]' }] }
    }
    return {
      isError: false,
      value: { path: reported, offset, lines, totalLines: fileLines.length },
      content: [{ type: 'text', text: lines.map(line => `${line.number}: ${line.text}`).join('\n') }],
    }
  }

  function grep(args, signal) {
    let pattern
    try {
      pattern = new RegExp(String(args.pattern ?? ''))
    } catch (error) {
      return failure(`regex parse error: ${error.message}`)
    }
    const where = String(args.path ?? '')
    const base = where.trim() === '' ? root : resolve(root, where)
    if (escapes(base)) return failure(`"${where}" is outside the workspace`)
    const matches = []
    const walk = directory => {
      for (const entry of readdirSync(directory, { withFileTypes: true })) {
        signal?.throwIfAborted?.()
        const path = join(directory, entry.name)
        if (entry.isDirectory()) {
          walk(path)
          continue
        }
        if (!entry.isFile()) continue
        let content
        try {
          content = readFileSync(path, 'utf8')
        } catch {
          continue
        }
        // ripgrep searches text and leaves binary files alone.
        if (content.includes('\u0000')) continue
        for (const [index, line] of content.split('\n').entries()) {
          const text = line.endsWith('\r') ? line.slice(0, -1) : line
          if (pattern.test(text)) matches.push({ path: shown(path), lineNumber: index + 1, line: text })
        }
      }
    }
    try {
      walk(base)
    } catch (error) {
      return failure(`cannot search "${shown(base)}": ${error?.code ?? String(error)}`)
    }
    if (grepMalformed !== false) {
      const shape = grepMalformed === true ? 'matches' : grepMalformed
      const values = {
        matches: { matches: `${matches.length} match(es)` },
        row: { matches: matches.map(match => ({ path: match.path, line: match.line })) },
      }
      return { isError: false, value: values[shape], content: [{ type: 'text', text: '[the harness answered with a shape it does not declare]' }] }
    }
    return {
      isError: false,
      value: { matches },
      content: [{ type: 'text', text: matches.map(match => `${match.path}:${match.lineNumber}: ${match.line}`).join('\n') }],
    }
  }

  return {
    calls,
    get(name) {
      return names.includes(name) ? { name, description: `the harness's ${name} tool` } : undefined
    },
    async execute({ name, arguments: args, signal }) {
      calls.push({ name, arguments: args })
      onCall?.(name)
      signal?.throwIfAborted?.()
      const broken = name === 'read' ? readFails : name === 'grep' ? grepFails : false
      if (broken !== false) {
        const message = typeof broken === 'string' ? broken : `the ${name} tool failed`
        if (typeof broken === 'object' && broken !== null) throw new Error(typeof broken.throws === 'string' ? broken.throws : message)
        return failure(message)
      }
      if (name === 'read') return read(args ?? {})
      if (name === 'grep') return grep(args ?? {}, signal)
      return failure(`no tool named "${name}" is available to this run`)
    },
  }
}

function settingsPath(home) {
  return join(home, 'code-review', 'config.json')
}

async function withDshHome(home, fn) {
  const previous = process.env.DSH_HOME
  process.env.DSH_HOME = home
  try {
    return await fn(home)
  } finally {
    if (previous === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = previous
  }
}

async function withSettings(settings, fn) {
  const home = mkdtempSync(join(tmpdir(), 'dsh-code-review-home-'))
  mkdirSync(join(home, 'code-review'), { recursive: true })
  writeFileSync(settingsPath(home), JSON.stringify(settings))
  return withDshHome(home, fn)
}

async function withEmptyHome(fn) {
  return withDshHome(mkdtempSync(join(tmpdir(), 'dsh-code-review-home-')), fn)
}

async function captureWarnings(fn) {
  const warnings = []
  const original = console.warn
  console.warn = message => { warnings.push(String(message)) }
  try {
    return { value: await fn(), warnings }
  } finally {
    console.warn = original
  }
}

function payloadOf(text) {
  const marker = text.indexOf(MARKER)
  assert.ok(marker >= 0, 'report carries the payload marker')
  const body = text.slice(text.indexOf('```json', marker) + '```json'.length)
  return JSON.parse(body.slice(0, body.indexOf('```')))
}

function messagesOf(request, role) {
  return request.messages.filter(message => message.role === role)
}

/** The reader tools the contract's reading section names, in its own order, or none when it says this run cannot read. */
function readersInContract(system) {
  if (system.includes('This run cannot read the project')) return []
  const match = /You have (?:one|two|three|\d+) read-only tools?: ([^.]+)\./.exec(system)
  assert.ok(match !== null, 'the contract carries a reading section')
  return match[1].replace(' and ', ', ').split(', ')
}

// A call's contract and its tool list are one decision: the tools the contract names are exactly the reader tools the request offers, so a run is never described as one it is not.
function assertOneReading(request, what) {
  const offered = request.tools.filter(tool => READER_TOOL_NAMES.includes(tool.name)).map(tool => tool.name)
  assert.deepEqual(
    readersInContract(request.system),
    offered,
    `the contract and the tool list describe one run (${what})`,
  )
  return offered.length > 0
}

const TEXT_DIFF = {
  kind: 'text', path: 'internal/chessx/board.go', display: 'internal/chessx/board.go',
  before: true, after: true, coarse: false,
  hunks: [{ oldStart: 12, oldLines: 1, newStart: 12, newLines: 2, lines: ['-old', '+new', '+extra'] }],
}
const BINARY_DIFF = { kind: 'binary', path: 'assets/logo.png', display: 'assets/logo.png' }
const SUMMARY = {
  turn: 3, cwd: WS, total: 2, added: 2, deleted: 1,
  files: [
    { path: 'internal/chessx/board.go', display: 'internal/chessx/board.go', added: 2, deleted: 1 },
    { path: 'assets/logo.png', display: 'assets/logo.png', added: 0, deleted: 0, binary: true },
  ],
}
/** A finding that quotes a line the diff really contains. */
const PROVEN = {
  severity: 'blocker', category: 'correctness', file: 'internal/chessx/board.go', line: 13,
  title: 'Guard the nil board', problem: 'board may be nil here', suggestion: 'return early',
  impact: 'The move is applied to a board that is not there, so the caller keeps a stale position.',
  trigger: 'A game replayed from a PGN whose last move is incomplete reaches ApplyMove with a nil board.',
  evidence: '+new',
}
const ARC_FINDING = {
  severity: 'high', category: 'responsibility', file: 'internal/chessx/board.go', line: 13,
  title: 'Move the reset out of Apply', problem: 'Apply resets a board it does not own',
  consequence: 'The caller holds a board it believes is unchanged.',
  alternative: 'Let the caller reset the board before Apply is called.',
  evidence: '+new',
}
const toolCall = (name, args) => ({ name, arguments: JSON.stringify(args ?? {}) })

// One model turn: record these findings, record the summary, finish the review. `summary: null`
// records none, and `finish: false` leaves the review open — how a model that stops mid-review is scripted.
const record = (findings = [], summary = 'x', { finish = true, more = [] } = {}) => ({
  toolCalls: [
    ...findings.map(finding => toolCall('append_finding', finding)),
    ...(summary === null ? [] : [toolCall('set_summary', { summary })]),
    ...more,
    ...(finish ? [toolCall('finish_review', {})] : []),
  ],
})

// The review tools every run offers, in the order it offers them: the protocol the report is built from.
const REVIEW_TOOL_NAMES = ['append_finding', 'update_finding', 'delete_finding', 'list_findings', 'set_summary', 'finish_review']
const READER_TOOL_NAMES = ['read_file', 'list_dir', 'search']

// 1 — a proven finding survives the gate and reaches both the report and the payload.
{
  const h = harness({ summary: SUMMARY, diffs: [TEXT_DIFF, BINARY_DIFF], script: [record([PROVEN], 'Nil board.')] })
  assert.equal(h.name, 'review')
  const result = await h.invoke('')
  assert.equal(result.kind, 'success')
  const prompt = h.seen.prompts[0].messages[0].content[0].text
  assert.ok(prompt.includes('+extra'), 'diff body reached the prompt')
  assert.ok(!prompt.includes('Board ı hesapla'), 'the session message is never read by the reviewer')
  assert.ok(!prompt.includes('most recent request'), 'no conversation intent section at all')
  assert.ok(prompt.includes('verbatim evidence quote') || prompt.includes('verbatim'), 'the prompt states the evidence bar')
  const system = h.seen.prompts[0].system
  assert.ok(system.includes('senior code reviewer'), 'the cr persona is the default one')
  assert.ok(system.includes('"impact"') && system.includes('"trigger"'), 'and its fields are the contract’s')
  assert.ok(system.includes('## Evidence bar'), 'and the gate no mode can change')
  assert.ok(system.includes('error-handling'), 'and its categories')
  const append = h.seen.prompts[0].tools.find(tool => tool.name === 'append_finding')
  assert.deepEqual(
    append.parameters.properties.severity.enum,
    ['blocker', 'major', 'minor', 'nit'],
    'the mode’s severity vocabulary is the enum the tool accepts',
  )
  assert.deepEqual(
    append.parameters.required,
    ['severity', 'file', 'title', 'problem', 'impact', 'trigger', 'evidence'],
    'and the fields the mode requires are the ones a call states',
  )
  const payload = payloadOf(result.text)
  assert.equal(payload.schema, 'code-review/2')
  assert.equal(payload.mode.id, 'cr')
  assert.equal(payload.verdict, 'fail')
  assert.equal(payload.findings.length, 1)
  assert.equal(payload.findings[0].evidence, '+new')
  assert.deepEqual(payload.withheld, [])
  assert.equal(payload.incomplete, null, 'a review that finished on its own terms is not partial')
  assert.equal(payload.stats.reviewed, 1)
  assert.deepEqual(payload.stats.skipped, [{ file: 'assets/logo.png', reason: 'binary' }])
  assert.deepEqual(payload.stats.store, { calls: 3, appended: 1, updated: 0, deleted: 0 }, 'the store counts what it recorded')
  assert.ok(result.text.includes('**Evidence:**'), 'the report shows the evidence')
  assert.ok(result.text.includes(`**Fix:** ${PROVEN.suggestion}`), 'and labels the fields the mode declared')
  assert.ok(result.text.includes(PROVEN.problem), 'the statement it leads with needs no label')
  assert.ok(result.text.includes('- finding store: 3 tool call(s), 1 recorded, 0 updated, 0 deleted'), 'the report names the store')
}

// 2 — the verdict is computed from the store, never declared; a finding that cannot name itself takes its title from the first field it stated.
{
  const h = harness({
    summary: SUMMARY,
    diffs: [TEXT_DIFF, BINARY_DIFF],
    script: [
      {
        toolCalls: [
          toolCall('append_finding', { ...PROVEN, severity: 'major', title: '', evidence: '+extra' }),
          toolCall('set_summary', { summary: 'fine' }),
          toolCall('finish_review', { verdict: 'pass' }),
        ],
      },
      { toolCalls: [toolCall('finish_review', {})] },
    ],
  })
  const result = await h.invoke('')
  const payload = payloadOf(result.text)
  assert.equal(payload.verdict, 'fail', 'a proven major finding forces fail whatever the model says')
  assert.equal(payload.findings[0].title, 'board may be nil here', 'a missing title falls back to the problem')
  const refusals = messagesOf(h.seen.prompts[1], 'tool').filter(message => message.isError === true)
  assert.equal(refusals.length, 1, 'the finish_review call carrying a verdict is refused')
  assert.ok(refusals[0].content[0].text.includes('takes no arguments'), refusals[0].content[0].text)
}

// 3 — a reviewer that records nothing and never finishes is an error, never a report that looks like a pass.
{
  const h = harness({ summary: SUMMARY, diffs: [TEXT_DIFF, BINARY_DIFF], script: [{ text: 'Looks fine to me!' }] })
  const result = await h.invoke('')
  assert.equal(result.kind, 'error')
  assert.ok(result.text.includes('recorded no finding'), result.text)
  assert.ok(result.text.includes('without calling finish_review'), result.text)
  assert.ok(result.text.includes('Looks fine to me!'), 'and the reviewer’s own last message is shown as the diagnosis')
  assert.equal(h.seen.prompts.length, 3, 'the model is asked to finish twice before the run gives up')
}

// 3b — recording nothing and finishing is a complete review, not a failure.
{
  const h = harness({ summary: SUMMARY, diffs: [TEXT_DIFF, BINARY_DIFF], script: [record([], 'Nothing to report.')] })
  const result = await h.invoke('')
  assert.equal(result.kind, 'success', result.text)
  const payload = payloadOf(result.text)
  assert.equal(payload.verdict, 'pass')
  assert.deepEqual(payload.findings, [])
  assert.equal(payload.incomplete, null, 'a finished review is not marked partial')
  assert.ok(result.text.includes('Nothing to report.'), 'and the summary it recorded opens the report')
}

// 4 — a session with no recorded change is refused with a reason.
{
  const h = harness({ summary: SUMMARY, diffs: [TEXT_DIFF], hasEvent: false })
  const result = await h.invoke('')
  assert.equal(result.kind, 'error')
  assert.ok(result.text.includes('nothing to review'), result.text)
  assert.ok(result.text.includes('session record: none still served'), result.text)
}

// 5 — a change record the Host does not serve is reported, not guessed.
{
  const h = harness({ summary: undefined, diffs: [] })
  const result = await h.invoke('')
  assert.equal(result.kind, 'error')
  assert.ok(result.text.includes('session record: none still served'), result.text)
  assert.ok(result.text.includes('set "gitRev"'), result.text)
}

// 6 — settings come from DSH_HOME/code-review/config.json, and inline args win.
{
  await withSettings({ provider: 'x', model: 'y', maxFiles: 1 }, async () => {
    const configured = harness({ summary: SUMMARY, diffs: [TEXT_DIFF, BINARY_DIFF] })
    const payload = payloadOf((await configured.invoke('')).text)
    assert.deepEqual(payload.reviewer, { provider: 'x', model: 'y' }, 'the config file supplies the route')
    assert.equal(payload.stats.reviewed, 1, 'maxFiles caps the review')
    assert.deepEqual(payload.stats.skipped, [{ file: 'assets/logo.png', reason: 'over-file-limit' }])
    const inline = harness({ summary: SUMMARY, diffs: [TEXT_DIFF, BINARY_DIFF] })
    assert.equal(payloadOf((await inline.invoke('model=z')).text).reviewer.model, 'z', 'an inline override wins')
  })
}

// 7 — an agent with no known route is refused before spending a reviewer call.
{
  const h = harness({ summary: SUMMARY, diffs: [TEXT_DIFF], route: {} })
  const result = await h.invoke('')
  assert.equal(result.kind, 'error')
  assert.ok(result.text.includes('no reviewer route'))
  assert.equal(h.seen.prompts.length, 0, 'no call was made')
}

// 8 — a diff over the character budget is left out, and an empty review is refused.
{
  await withSettings({ maxDiffChars: 5 }, async () => {
    const h = harness({ summary: { ...SUMMARY, files: [SUMMARY.files[0]] }, diffs: [TEXT_DIFF] })
    const result = await h.invoke('')
    assert.equal(result.kind, 'error')
    assert.ok(result.text.includes('nothing to review'))
    assert.equal(h.seen.prompts.length, 0, 'no reviewer call for an empty review')
  })
}

// 9 — the route resolves from agent.options first, with the top-level agent fields as a fallback.
{
  const configured = harness({ summary: SUMMARY, diffs: [TEXT_DIFF, BINARY_DIFF] })
  assert.deepEqual(
    payloadOf((await configured.invoke('')).text).reviewer,
    { provider: 'deepseek-official', model: 'deepseek-flash' },
    'agent.options is the default route',
  )
  const legacy = harness({
    summary: SUMMARY, diffs: [TEXT_DIFF, BINARY_DIFF],
    route: { provider: 'legacy-p', model: 'legacy-m' },
  })
  assert.deepEqual(
    payloadOf((await legacy.invoke('')).text).reviewer,
    { provider: 'legacy-p', model: 'legacy-m' },
    'top-level agent fields still resolve',
  )
  const preferred = harness({
    summary: SUMMARY, diffs: [TEXT_DIFF, BINARY_DIFF],
    route: { provider: 'legacy-p', model: 'legacy-m', options: { provider: 'opt-p', model: 'opt-m' } },
  })
  assert.deepEqual(
    payloadOf((await preferred.invoke('')).text).reviewer,
    { provider: 'opt-p', model: 'opt-m' },
    'options wins over the legacy fields',
  )
}

// 10 — evidence that the reviewer was never shown is withheld, and cannot carry a verdict.
{
  const h = harness({
    summary: SUMMARY,
    diffs: [TEXT_DIFF, BINARY_DIFF],
    script: [record([{ ...PROVEN, evidence: '+if (board == nil) { return nil }' }], 'invented')],
  })
  const result = await h.invoke('')
  const payload = payloadOf(result.text)
  assert.equal(payload.findings.length, 0, 'the unprovable finding is not published')
  assert.equal(payload.withheld.length, 1)
  assert.equal(payload.verdict, 'pass', 'a withheld claim cannot fail the review')
  assert.deepEqual(
    Object.keys(payload.withheld[0]).sort(),
    ['file', 'line', 'reason', 'severity', 'title'],
    'the withheld entry names the finding it is about, and why it was not published',
  )
  assert.ok(payload.withheld[0].reason.includes('does not occur'), payload.withheld[0].reason)
  assert.ok(result.text.includes('Withheld as unprovable'), 'the report names the withheld claim')
}

// 11 — a finding naming a file the reviewer never saw is withheld.
{
  const h = harness({
    summary: SUMMARY,
    diffs: [TEXT_DIFF, BINARY_DIFF],
    script: [record([{ ...PROVEN, file: 'internal/invisible/file.go' }])],
  })
  const payload = payloadOf((await h.invoke('')).text)
  assert.equal(payload.findings.length, 0)
  assert.ok(payload.withheld[0].reason.includes('not one the reviewer could see'))
}

// 12 — a finding with no evidence at all is withheld, even when it is plausible.
{
  const h = harness({
    summary: SUMMARY,
    diffs: [TEXT_DIFF, BINARY_DIFF],
    script: [record([{ ...PROVEN, evidence: '' }])],
  })
  const payload = payloadOf((await h.invoke('')).text)
  assert.equal(payload.findings.length, 0)
  assert.ok(payload.withheld[0].reason.includes('no evidence quoted'))
}

// 13 — by default the report is the user's alone: the Agent is never told.
{
  const h = harness({
    summary: SUMMARY,
    diffs: [TEXT_DIFF, BINARY_DIFF],
    script: [record([PROVEN], 'Nil board.')],
  })
  const result = await h.invoke('')
  assert.equal(result.kind, 'success', 'the user still gets the report')
  const payload = payloadOf(result.text)
  assert.equal(payload.verdict, 'fail', 'the report is complete')
  assert.equal(payload.findings.length, 1)
  assert.ok(result.text.includes('## Code review — FAIL'), 'and is rendered in full')
  assert.equal(h.seen.steer.length, 0, 'no review starts a turn for the agent')
  assert.equal(h.seen.inject.length, 0, 'and none is slipped into its context either')
}

// 13b — the notice still exists, but only for a user who opts into a channel.
{
  await withSettings({ notifyAgent: 'steer' }, async () => {
    const h = harness({
      summary: SUMMARY,
      diffs: [TEXT_DIFF, BINARY_DIFF],
      script: [record([PROVEN], 'Nil board.')],
    })
    await h.invoke('')
    assert.equal(h.seen.steer.length, 1, 'an opted-in steer delivers')
    assert.equal(h.seen.inject.length, 0)
    const message = h.seen.steer[0]
    assert.equal(message.role, 'user')
    assert.ok(typeof message.id === 'string' && message.id.length > 0, 'the notice carries a message id')
    assert.equal(message.source.kind, 'code-review')
    assert.equal(message.source.form, 'notice')
    assert.ok(message.source.summary.length <= 120, 'the notice summary respects the harness bound')
    assert.ok(message.source.summary.includes('fail'), message.source.summary)
    const text = message.content[0].text
    assert.ok(text.includes('do not change code unless the user asks'), 'the notice states it is not a request')
    assert.ok(text.includes('Proven findings'))
    assert.ok(text.includes('internal/chessx/board.go:13'), 'the notice names the file and line')
    assert.ok(text.includes('evidence: +new'), 'the notice carries the evidence')
  })
}

// 14 — notifyAgent "inject" delivers quietly; "off" delivers nothing; junk falls back to off.
{
  await withSettings({ notifyAgent: 'inject' }, async () => {
    const h = harness({ summary: SUMMARY, diffs: [TEXT_DIFF, BINARY_DIFF] })
    await h.invoke('')
    assert.equal(h.seen.inject.length, 1, 'inject is used when configured')
    assert.equal(h.seen.steer.length, 0)
  })
  await withSettings({ notifyAgent: 'off' }, async () => {
    const h = harness({ summary: SUMMARY, diffs: [TEXT_DIFF, BINARY_DIFF] })
    const result = await h.invoke('')
    assert.equal(result.kind, 'success', 'the user still gets the report')
    assert.equal(h.seen.steer.length + h.seen.inject.length, 0)
  })
  await withSettings({ notifyAgent: 'nonsense' }, async () => {
    const h = harness({ summary: SUMMARY, diffs: [TEXT_DIFF, BINARY_DIFF] })
    await h.invoke('')
    assert.equal(
      h.seen.steer.length + h.seen.inject.length,
      0,
      'an unknown mode falls back to off, never to starting work',
    )
  })
}

// 15 — a failing notification never costs the user the report.
{
  await withSettings({ notifyAgent: 'steer' }, async () => {
    const h = harness({ summary: SUMMARY, diffs: [TEXT_DIFF, BINARY_DIFF], steerThrows: true })
    const result = await h.invoke('')
    assert.equal(result.kind, 'success')
    assert.equal(payloadOf(result.text).verdict, 'pass')
    assert.equal(h.seen.steerAttempts, 1, 'the notice was attempted, so the failure path really ran')
    assert.equal(h.seen.steer.length, 0, 'and the rejected notice was not delivered')
  })
}

// 16 — an agent without the inbox verbs is tolerated.
{
  await withSettings({ notifyAgent: 'steer' }, async () => {
    const h = harness({ summary: SUMMARY, diffs: [TEXT_DIFF, BINARY_DIFF] })
    const stripped = {
      id: SESSION,
      options: { provider: 'deepseek-official', model: 'deepseek-flash' },
      session: {
        id: SESSION,
        header: { cwd: WS },
        snapshotEvents: () => [{ type: 'workspace/changes', seq: 7 }],
        deriveMessages: () => [],
      },
    }
    const result = await h.definition.handler({
      commandId: 'c2', agent: stripped, rawInput: '', attachments: [], signal: new AbortController().signal,
    })
    assert.equal(result.kind, 'success', 'a missing steer() only skips the notice')
  })
}

// 17 — the reviewer may read the project, and a finding grounded in what it read is published.
{
  const h = harness({
    summary: SUMMARY,
    diffs: [TEXT_DIFF, BINARY_DIFF],
    script: [
      { toolCalls: [{ name: 'read_file', arguments: JSON.stringify({ path: READ_ONLY_FILE }) }] },
      record([{
        severity: 'major', category: 'correctness', file: READ_ONLY_FILE, line: 4,
        title: 'Reset leaves the board unplayable', problem: 'the caller resets a board it just built',
        impact: 'Every game started through this path begins from an empty position.',
        trigger: 'Any caller of Apply reaches Reset first, so the first move is rejected.',
        suggestion: 'do not reset here', evidence: READ_ONLY_LINE,
      }], 'Read the caller.'),
    ],
  })
  const result = await h.invoke('')
  assert.equal(result.kind, 'success')
  assert.ok(Array.isArray(h.seen.prompts[0].tools), 'tools are offered on the first call')
  assert.deepEqual(
    h.seen.prompts[0].tools.map(tool => tool.name),
    [...REVIEW_TOOL_NAMES, ...READER_TOOL_NAMES],
    'the six review tools come first, so a tool-less answer is never the only option',
  )
  const toolMessages = messagesOf(h.seen.prompts[1], 'tool')
  assert.equal(toolMessages.length, 1, 'the read result went back to the model')
  assert.ok(toolMessages[0].content[0].text.includes('MARKER_NIL_SQUARES'), 'the file content reached the model')
  assert.ok(toolMessages[0].content[0].text.includes('[reader budget: 1/30 calls'), 'the model is told its remaining budget')
  const callBlocks = messagesOf(h.seen.prompts[1], 'assistant')[0].content
  assert.equal(callBlocks.length, 1, 'the first turn asked for one read')
  assert.equal(callBlocks[0].type, 'tool-call')
  assert.equal(callBlocks[0].name, 'read_file')
  const payload = payloadOf(result.text)
  assert.equal(payload.findings.length, 1, 'a finding verified by reading is published')
  assert.equal(payload.findings[0].file, READ_ONLY_FILE)
  assert.deepEqual(payload.stats.context.files, [READ_ONLY_FILE])
  assert.equal(payload.stats.context.calls, 1)
  assert.ok(result.text.includes('project context read: 1 tool call(s)'))
}

// 18 — search results are part of the checked corpus too.
{
  const h = harness({
    summary: SUMMARY,
    diffs: [TEXT_DIFF, BINARY_DIFF],
    script: [
      { toolCalls: [{ name: 'search', arguments: JSON.stringify({ query: 'MARKER_NIL_SQUARES' }) }] },
      record([{
        severity: 'minor', category: 'consistency', file: READ_ONLY_FILE, line: 4,
        title: 'Marker', problem: 'found by search',
        impact: 'The marker survives a reset that should have cleared it.',
        trigger: 'A search hit in move.go shows Reset running on a fresh board.',
        suggestion: 'none', evidence: READ_ONLY_LINE,
      }]),
    ],
  })
  const payload = payloadOf((await h.invoke('')).text)
  assert.equal(payload.findings.length, 1, 'a quote taken from a search hit verifies')
  assert.equal(payload.stats.context.calls, 1)
}

// 19 — the reader cannot leave the workspace, and nothing it refused can be quoted.
{
  const h = harness({
    summary: SUMMARY,
    diffs: [TEXT_DIFF, BINARY_DIFF],
    script: [
      { toolCalls: [{ name: 'read_file', arguments: JSON.stringify({ path: '../../outside.txt' }) }] },
      record([{ ...PROVEN, file: '../../outside.txt', evidence: 'OUTSIDE_SECRET' }]),
    ],
  })
  const result = await h.invoke('')
  const refusal = messagesOf(h.seen.prompts[1], 'tool')[0]
  assert.equal(refusal.isError, true, 'escaping the workspace is an error result')
  assert.ok(refusal.content[0].text.includes('outside the workspace'), refusal.content[0].text)
  const payload = payloadOf(result.text)
  assert.equal(payload.findings.length, 0, 'a quote from a refused read cannot be published')
  assert.equal(payload.withheld.length, 1)
}

// 20 — an unknown tool name is refused, never executed, and the refusal names what this run does offer — a name one letter from a reader tool included.
{
  const h = harness({
    summary: SUMMARY,
    diffs: [TEXT_DIFF, BINARY_DIFF],
    script: [
      {
        toolCalls: [
          { name: 'run_command', arguments: '{"cmd":"rm -rf /"}' },
          toolCall('read_files', { path: READ_ONLY_FILE }),
        ],
      },
      record([]),
    ],
  })
  const result = await h.invoke('')
  const refusals = messagesOf(h.seen.prompts[1], 'tool')
  assert.equal(refusals.length, 2, 'every call of the turn got exactly one result')
  assert.equal(refusals[0].isError, true)
  assert.ok(refusals[0].content[0].text.includes('unknown tool "run_command"'), refusals[0].content[0].text)
  assert.ok(refusals[0].content[0].text.includes('append_finding'), 'the review tools are named as available')
  assert.ok(refusals[0].content[0].text.includes('search'), 'and so are the reader tools')
  assert.ok(refusals[1].content[0].text.includes('unknown tool "read_files"'), refusals[1].content[0].text)
  assert.equal(payloadOf(result.text).stats.context.calls, 0, 'a near-miss name is never run as the tool it resembles')
  assert.equal(result.kind, 'success')
}

// 21 — the reader budget is enforced, the reader tools are then withdrawn, and the review tools are not.
{
  await withSettings({ maxToolCalls: 2 }, async () => {
    const h = harness({
      summary: SUMMARY,
      diffs: [TEXT_DIFF, BINARY_DIFF],
      script: [
        { toolCalls: [toolCall('list_dir', { path: 'internal' })] },
        { toolCalls: [toolCall('list_dir', { path: 'internal/play' })] },
        {
          toolCalls: [
            toolCall('read_file', { path: READ_ONLY_FILE }),
            toolCall('append_finding', PROVEN),
            toolCall('set_summary', { summary: 'looked around' }),
          ],
        },
        { toolCalls: [toolCall('finish_review', {})] },
      ],
    })
    const result = await h.invoke('')
    assert.equal(result.kind, 'success')
    assert.equal(h.seen.prompts.length, 4, 'two reading calls, one recording turn and the finish')
    assert.deepEqual(
      h.seen.prompts[2].tools.map(tool => tool.name),
      REVIEW_TOOL_NAMES,
      'the reader tools are gone once the budget is spent; the review tools stay',
    )
    const note = messagesOf(h.seen.prompts[2], 'user').at(-1).content[0].text
    assert.ok(note.includes('the reader budget is spent'), 'the model is told the reading is over')
    assert.ok(!note.includes('no further tool calls'), 'but never told to stop using the review tools')
    const tool = messagesOf(h.seen.prompts[3], 'tool')
    assert.equal(tool.length, 5, 'every call of the turn got exactly one result')
    assert.equal(tool[2].isError, true, 'a further read is refused')
    assert.ok(tool[2].content[0].text.includes('reader budget is spent'), tool[2].content[0].text)
    assert.equal(tool[3].isError, undefined, 'and the finding is recorded anyway')
    assert.ok(tool[3].content[0].text.includes('f1 [blocker]'), tool[3].content[0].text)
    assert.ok(tool[4].content[0].text.includes('summary recorded'), tool[4].content[0].text)
    const payload = payloadOf(result.text)
    assert.equal(payload.stats.context.calls, 2, 'a refused read is not counted as a read')
    assert.equal(payload.findings.length, 1, 'the finding recorded after the budget landed')
  })
}

// 22 — project access can be turned off entirely, and the review tools remain.
{
  await withSettings({ projectAccess: false }, async () => {
    const h = harness({
      summary: SUMMARY,
      diffs: [TEXT_DIFF, BINARY_DIFF],
      script: [
        {
          toolCalls: [
            toolCall('read_file', { path: READ_ONLY_FILE }),
            toolCall('list_dir', { path: 'internal' }),
            toolCall('append_finding', PROVEN),
          ],
        },
        { toolCalls: [toolCall('set_summary', { summary: 'diff only' }), toolCall('finish_review', {})] },
      ],
    })
    const result = await h.invoke('')
    assert.deepEqual(h.seen.prompts[0].tools.map(tool => tool.name), REVIEW_TOOL_NAMES, 'only the review tools are offered')
    assert.equal(assertOneReading(h.seen.prompts[0], 'project access off'), false, 'and the contract says so, not the persona')
    assert.ok(h.seen.prompts[0].system.includes('This run cannot read the project'), 'the reviewer is told what this run can do')
    const refused = messagesOf(h.seen.prompts[1], 'tool')
    assert.equal(refused.length, 3, 'every call of the turn got exactly one result')
    assert.equal(refused[0].isError, true, 'a read is refused when project access is off')
    // The run's own gate is the reason, not the harness: the harness does expose
    // `read` here, and saying otherwise would send the user to the wrong setting.
    assert.ok(
      refused[0].content[0].text.includes('read_file is not available in this run (project access is off for this run)'),
      refused[0].content[0].text,
    )
    assert.ok(refused[0].content[0].text.includes('append_finding'), 'and the refusal names the tools that are available')
    // list_dir is the plugin's own, so it reaches the run's own gate, which is the reason every reader tool refused here should carry.
    assert.equal(refused[1].isError, true, 'a listing is refused too')
    assert.ok(
      refused[1].content[0].text.includes('list_dir is not available in this run (project access is off for this run)'),
      refused[1].content[0].text,
    )
    assert.equal(refused[2].isError, undefined, 'and the finding is recorded anyway')
    assert.equal(h.tools.calls.length, 0, 'a run that cannot read consults no harness tool for one')
    const payload = payloadOf(result.text)
    assert.equal(payload.findings.length, 1, 'a finding recorded from the diff alone is still published')
  })
}

// 23 — one failed call is retried with a smaller output cap and no project access, but never without the review tools.
{
  await withSettings({ projectAccess: true }, async () => {
    const h = harness({
      summary: SUMMARY,
      diffs: [TEXT_DIFF, BINARY_DIFF],
      failAtCall: 1,
      script: [record([PROVEN], 'diff only')],
    })
    const result = await h.invoke('')
    assert.equal(result.kind, 'success', 'the review still completes')
    assert.equal(h.seen.prompts.length, 2, 'the failed call and the retry')
    assert.deepEqual(h.seen.prompts[1].tools.map(tool => tool.name), REVIEW_TOOL_NAMES, 'the retry keeps the review tools and drops the reader')
    assert.equal(assertOneReading(h.seen.prompts[1], 'the degraded retry'), false, 'and is told it cannot read')
    assert.equal(payloadOf(result.text).findings.length, 1, 'a diff-grounded finding still publishes')
    assert.equal(payloadOf(result.text).stats.context.calls, 0, 'no reader call was made')
    assert.equal(h.seen.prompts[0].maxTokens, 50000, 'the configured output cap is attempted first')
    assert.equal(h.seen.prompts[1].maxTokens, 8192, 'the retry shrinks the output cap')
    assert.equal(payloadOf(result.text).stats.reviewerFallback, true, 'the report admits the review ran degraded')
    assert.ok(result.text.includes('degraded retry (diff only, smaller output cap)'), 'and says what was degraded')
  })
}

// 24 — reading stops at the configured fraction of the timeout, not at the hard kill, and the contract does not claim the tools either.
{
  await withSettings({ timeoutMs: 1000, toolDeadlineRatio: 0.0000001 }, async () => {
    const h = harness({ summary: SUMMARY, diffs: [TEXT_DIFF, BINARY_DIFF] })
    const result = await h.invoke('')
    assert.deepEqual(h.seen.prompts[0].tools.map(tool => tool.name), REVIEW_TOOL_NAMES, 'no reader tool is offered once the reading deadline has passed')
    assert.equal(assertOneReading(h.seen.prompts[0], 'the reading deadline has passed'), false, 'nor promised by the contract, which the setting alone would have promised')
    assert.equal(result.kind, 'success', 'the report is still produced')
  })
}

// 24b — the byte budget withdraws the reader tools exactly as the call budget and the clock do, and no offer still promises a tool it would refuse.
{
  await withSettings({ maxReadBytes: 1 }, async () => {
    const h = harness({
      summary: SUMMARY,
      diffs: [TEXT_DIFF, BINARY_DIFF],
      script: [
        { toolCalls: [toolCall('read_file', { path: READ_ONLY_FILE })] },
        { toolCalls: [toolCall('read_file', { path: READ_ONLY_FILE }), toolCall('run_command', { command: 'ls' })] },
        { toolCalls: [toolCall('append_finding', PROVEN), toolCall('finish_review', {})] },
      ],
    })
    const result = await h.invoke('')
    assert.equal(result.kind, 'success', result.text)
    assert.deepEqual(
      h.seen.prompts[0].tools.map(tool => tool.name),
      [...REVIEW_TOOL_NAMES, ...READER_TOOL_NAMES],
      'the reader tools are offered while any budget is left',
    )
    assert.deepEqual(
      h.seen.prompts[1].tools.map(tool => tool.name),
      REVIEW_TOOL_NAMES,
      'the byte budget withdraws them, exactly as the call budget does',
    )
    const turn = messagesOf(h.seen.prompts[2], 'tool').slice(1)
    assert.equal(turn.length, 2, 'the second turn asked for two calls')
    assert.equal(turn[0].isError, true, 'a read past the byte budget is refused')
    assert.ok(turn[0].content[0].text.includes('the reader byte budget is spent'), turn[0].content[0].text)
    assert.ok(!turn[0].content[0].text.includes('read_file'), 'and the refusal promises no reader tool')
    assert.equal(turn[1].isError, true)
    assert.ok(turn[1].content[0].text.includes('unknown tool'), turn[1].content[0].text)
    assert.ok(turn[1].content[0].text.includes('append_finding'), 'the offer list names the review tools')
    assert.ok(!turn[1].content[0].text.includes('read_file'), 'and none of the reader tools the run has stopped offering')
    assert.equal(payloadOf(result.text).findings.length, 1, 'the review is recorded either way')
  })
}

// 25 — a big project may take more than a dozen reads, and the context stays bounded.
{
  const bigLines = 5600
  writeFileSync(
    join(WS, 'internal', 'chessx', 'big.go'),
    Array.from({ length: bigLines }, (_, index) => `// BIGFILE_LINE_${String(index).padStart(5, '0')} padding padding`).join('\n'),
  )
  const reads = Array.from({ length: 14 }, (_, index) => ({
    toolCalls: [{
      name: 'read_file',
      arguments: JSON.stringify({ path: 'internal/chessx/big.go', offset: 1 + index * 400, limit: 400 }),
    }],
  }))
  const h = harness({
    summary: SUMMARY,
    diffs: [TEXT_DIFF, BINARY_DIFF],
    script: [...reads, record([], 'read a lot')],
  })
  const result = await h.invoke('')
  assert.equal(result.kind, 'success')
  const payload = payloadOf(result.text)
  assert.equal(payload.stats.context.calls, 14, 'the 12-call ceiling is gone: 14 reads went through')
  assert.deepEqual(payload.stats.context.files, ['internal/chessx/big.go'])
  const finalTools = messagesOf(h.seen.prompts.at(-1), 'tool')
  assert.equal(finalTools.length, 14)
  assert.ok(
    finalTools.some(message => message.content[0].text.startsWith('[elided:')),
    'old reads collapse out of the model context',
  )
  assert.ok(
    finalTools.at(-1).content[0].text.includes('BIGFILE_LINE_05599'),
    'the newest read stays verbatim',
  )
  assert.ok(
    payload.stats.context.keptBytes < payload.stats.context.bytes,
    'the context kept less than the reader pulled in',
  )
}

// 26 — a finding that does not say how it is reached is withheld.
{
  const h = harness({
    summary: SUMMARY,
    diffs: [TEXT_DIFF, BINARY_DIFF],
    script: [record([{ ...PROVEN, trigger: '' }])],
  })
  const payload = payloadOf((await h.invoke('')).text)
  assert.equal(payload.findings.length, 0)
  assert.ok(payload.withheld[0].reason.includes('"trigger"'), payload.withheld[0].reason)
  assert.ok(payload.withheld[0].reason.includes('How it is reached'), payload.withheld[0].reason)
}

// 27 — a finding that does not say what it causes is withheld.
{
  const h = harness({
    summary: SUMMARY,
    diffs: [TEXT_DIFF, BINARY_DIFF],
    script: [record([{ ...PROVEN, impact: '' }])],
  })
  const payload = payloadOf((await h.invoke('')).text)
  assert.equal(payload.findings.length, 0)
  assert.ok(payload.withheld[0].reason.includes('"impact"'), payload.withheld[0].reason)
  assert.ok(payload.withheld[0].reason.includes('Impact'), payload.withheld[0].reason)
}

// 28 — impact and trigger reach the payload, the report and the opt-in notice.
{
  await withSettings({ notifyAgent: 'steer' }, async () => {
    const h = harness({ summary: SUMMARY, diffs: [TEXT_DIFF, BINARY_DIFF], script: [record([PROVEN])] })
    const result = await h.invoke('')
    const payload = payloadOf(result.text)
    assert.equal(payload.findings[0].impact, PROVEN.impact)
    assert.equal(payload.findings[0].trigger, PROVEN.trigger)
    assert.ok(result.text.includes(`**Impact:** ${PROVEN.impact}`), 'the report shows the impact')
    assert.ok(result.text.includes(`**How it is reached:** ${PROVEN.trigger}`), 'the report shows the trigger')
    const notice = h.seen.steer[0].content[0].text
    assert.ok(notice.includes(`impact: ${PROVEN.impact}`), 'the notice carries the impact')
    assert.ok(notice.includes(`how it is reached: ${PROVEN.trigger}`), 'the notice carries the trigger')
  })
}

// 29 — the output cap follows the configuration in both directions.
{
  const defaults = harness({ summary: SUMMARY, diffs: [TEXT_DIFF, BINARY_DIFF] })
  await defaults.invoke('')
  assert.equal(defaults.seen.prompts[0].maxTokens, 50000, 'the default output cap is large')
  await withSettings({ maxTokens: 12345 }, async () => {
    const h = harness({ summary: SUMMARY, diffs: [TEXT_DIFF, BINARY_DIFF] })
    await h.invoke('')
    assert.equal(h.seen.prompts[0].maxTokens, 12345, 'a configured cap wins')
  })
}

// 30 — when the newest record is not among those served, an earlier one is reviewed instead, and the report says so.
{
  const h = harness({
    summaries: { 5: SUMMARY },
    events: [5, 9],
    diffs: [TEXT_DIFF, BINARY_DIFF],
    script: [record([], 'older turn')],
  })
  const result = await h.invoke('')
  assert.equal(result.kind, 'success', 'the review falls back to a served record')
  const payload = payloadOf(result.text)
  assert.equal(payload.stats.recordBehind, 1, 'the report knows how far back it went')
  assert.equal(payload.turn, SUMMARY.turn)
  assert.ok(result.text.includes('have no comparison in this Host process'), 'the report says so')
}

function gitFixture() {
  const repo = mkdtempSync(join(tmpdir(), 'dsh-code-review-repo-'))
  const git = args => spawnSync('git', args, { cwd: repo, encoding: 'utf8' })
  git(['init', '-q'])
  writeFileSync(join(repo, 'board.go'), 'package chessx\n\nfunc Reset() {}\n')
  git(['add', '.'])
  git(['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-q', '-m', 'init'])
  writeFileSync(join(repo, 'board.go'), 'package chessx\n\nfunc Reset() { panic("x") }\n')
  writeFileSync(join(repo, 'fresh.go'), 'package chessx\n\nfunc Fresh() {}\n')
  return { repo, git }
}

const GIT_FINDING = {
  severity: 'major', category: 'correctness', file: 'board.go', line: 3,
  title: 'Reset panics instead of resetting', problem: 'the body now aborts the process',
  impact: 'Every caller of Reset dies, so no game can start.',
  trigger: 'Starting any game reaches Reset, which panics on the first call.',
  suggestion: 'restore the reset body', evidence: '+func Reset() { panic("x") }',
}

// 31 — the default source is the git working tree, tracked and untracked alike.
{
  const { repo } = gitFixture()
  const h = harness({
    cwd: repo,
    hasEvent: false,
    diffs: [],
    script: [record([GIT_FINDING], 'Reset is broken.')],
  })
  const result = await h.invoke('')
  assert.equal(result.kind, 'success', result.text)
  const payload = payloadOf(result.text)
  assert.equal(payload.source, 'git')
  assert.equal(payload.base, 'HEAD')
  assert.equal(payload.stats.reviewed, 2, 'the edited file and the new file')
  assert.deepEqual(payload.stats.skipped, [])
  const prompt = h.seen.prompts[0].messages[0].content[0].text
  assert.ok(prompt.includes('git working tree vs HEAD'), 'the prompt names the source')
  assert.ok(prompt.includes('+func Reset() { panic("x") }'), 'the tracked edit reached the prompt')
  assert.ok(prompt.includes('+func Fresh() {}'), 'the untracked file reached the prompt')
  assert.equal(payload.findings.length, 1, 'a finding quoting the git diff is published')
  assert.ok(result.text.includes('- source: git working tree vs HEAD'))
  assert.equal(h.seen.steer.length + h.seen.inject.length, 0, 'a git review stays with the user by default')
}

// 32 — with the work committed, the git source is clean and the session record takes over.
{
  const { repo, git } = gitFixture()
  git(['add', '.'])
  git(['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-q', '-m', 'work'])
  const h = harness({
    cwd: repo,
    summary: SUMMARY,
    diffs: [TEXT_DIFF, BINARY_DIFF],
    script: [record([], 'session fallback')],
  })
  const payload = payloadOf((await h.invoke('')).text)
  assert.equal(payload.source, 'session', 'a clean tree falls back to the recorded changes')
  assert.equal(payload.stats.reviewed, 1)
  // This record is this session's own work, so the prompt must present it as primary; 'not by this session' would point the reviewer at the rest of the workspace.
  const prompt = h.seen.prompts[0].messages[0].content[0].text
  assert.ok(
    prompt.includes('primary — written or edited in this session: internal/chessx/board.go'),
    `the session record is primary: ${prompt.slice(prompt.indexOf('## Scope'), prompt.indexOf('## Unified diffs'))}`,
  )
  assert.ok(
    !prompt.includes('none of the files below were written or edited by this session'),
    'the session record is not reported as nobody\'s work',
  )
  assert.ok(
    !prompt.includes('not by this session'),
    'the session record is not reported as another session\'s work',
  )
}

// 33 — gitRev reaches committed work when the working tree is clean.
{
  const { repo, git } = gitFixture()
  git(['add', '.'])
  git(['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-q', '-m', 'work'])
  await withSettings({ gitRev: 'HEAD~1' }, async () => {
    const h = harness({
      cwd: repo,
      hasEvent: false,
      diffs: [],
      script: [record([GIT_FINDING], 'committed work')],
    })
    const result = await h.invoke('')
    assert.equal(result.kind, 'success', result.text)
    const payload = payloadOf(result.text)
    assert.equal(payload.source, 'git')
    assert.equal(payload.base, 'HEAD~1')
    assert.equal(payload.stats.reviewed, 2, 'the committed edit and the committed new file')
  })
}

// 34 — source=git with a clean tree explains itself instead of falling back.
{
  const clean = mkdtempSync(join(tmpdir(), 'dsh-code-review-clean-'))
  const git = args => spawnSync('git', args, { cwd: clean, encoding: 'utf8' })
  git(['init', '-q'])
  writeFileSync(join(clean, 'a.go'), 'package a\n')
  git(['add', '.'])
  git(['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-q', '-m', 'init'])
  await withSettings({ source: 'git' }, async () => {
    const h = harness({ cwd: clean, summary: SUMMARY, diffs: [TEXT_DIFF, BINARY_DIFF] })
    const result = await h.invoke('')
    assert.equal(result.kind, 'error')
    assert.ok(result.text.includes('git: clean'), result.text)
    assert.ok(result.text.includes('gitRev'), 'the message points at committed work')
  })
}

// 35 — the reader cap holds inside one model turn, and every call still gets a result.
{
  await withSettings({ maxToolCalls: 2 }, async () => {
    const h = harness({
      summary: SUMMARY,
      diffs: [TEXT_DIFF, BINARY_DIFF],
      script: [
        {
          toolCalls: [
            { name: 'list_dir', arguments: '{"path":"internal"}' },
            { name: 'list_dir', arguments: '{"path":"internal/play"}' },
            { name: 'read_file', arguments: JSON.stringify({ path: READ_ONLY_FILE }) },
          ],
        },
        record([], 'done'),
      ],
    })
    const result = await h.invoke('')
    assert.equal(result.kind, 'success')
    assert.equal(payloadOf(result.text).stats.context.calls, 2, 'the cap holds within a single turn')
    const toolMessages = messagesOf(h.seen.prompts[1], 'tool')
    assert.equal(toolMessages.length, 3, 'every requested call still gets a result')
    assert.equal(toolMessages[2].isError, true)
    assert.ok(toolMessages[2].content[0].text.includes('reader budget is spent'), toolMessages[2].content[0].text)
    for (const message of toolMessages.slice(0, 2)) {
      assert.ok(/\[reader budget: [12]\/2 calls/.test(message.content[0].text), 'no result claims more calls than the cap')
    }
  })
}

// 36 — nothing from the conversation reaches the reviewer, not even our own notice.
{
  const h = harness({
    summary: SUMMARY,
    diffs: [TEXT_DIFF, BINARY_DIFF],
    messages: [
      { role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: 'Board ı hesapla' }] },
      { role: 'assistant', content: [{ type: 'text', text: 'tamam' }] },
      { role: 'user', source: { kind: 'code-review', form: 'notice' }, content: [{ type: 'text', text: '[code-review] previous report body' }] },
    ],
    script: [record([], 'x')],
  })
  await h.invoke('')
  const prompt = h.seen.prompts[0].messages[0].content[0].text
  assert.ok(!prompt.includes('Board ı hesapla'), 'the human message is not the intent either')
  assert.ok(!prompt.includes('previous report body'), 'the notice never leaks in')
}

const STUB_REACT = {
  createElement: () => null,
  useMemo: () => undefined,
  useState: () => [true, () => {}],
}

function recordingReact() {
  const h = (type, props, ...children) => ({
    type,
    props: {
      ...(props ?? {}),
      children: children.flat(Infinity).filter(child => child !== null && child !== undefined),
    },
  })
  return {
    createElement: h,
    useMemo: fn => fn(),
    useState: initial => [typeof initial === 'function' ? initial() : initial, () => {}],
  }
}

let clientModule
async function loadClientModule() {
  if (clientModule !== undefined) return clientModule
  const loaded = []
  const previousWindow = globalThis.window
  globalThis.window = { __ModuleLoader__: { load(module) { loaded.push(module) } } }
  try {
    await import(pathToFileURL(join(HERE, 'client.js')).href)
  } finally {
    if (previousWindow === undefined) delete globalThis.window
    else globalThis.window = previousWindow
  }
  assert.equal(loaded.length, 1, 'the artifact registers exactly one client module')
  assert.equal(loaded[0].id, '@local/dsh-code-review', 'under its package name')
  clientModule = loaded[0]
  return clientModule
}

async function renderCard(outcome) {
  const api = (await loadClientModule()).factory(() => recordingReact())
  let Card
  api.apply({
    effect: callback => callback(),
    locale: { register: () => () => {}, bind: () => key => key },
    slots: {
      inject: (_slot, callback) => callback(),
      register: (_options, component) => { Card = component; return () => {} },
    },
  })
  assert.equal(typeof Card, 'function', 'the card is registered on the command view')

  const seen = { texts: [], buttons: [] }
  const visit = node => {
    if (typeof node === 'string') {
      if (node.length < 80 && !node.includes('{')) seen.texts.push(node)
      return
    }
    if (Array.isArray(node)) { for (const child of node) visit(child); return }
    if (node === null || typeof node !== 'object') return
    const name = typeof node.type === 'function' ? (node.type.name ?? 'anonymous') : String(node.type)
    if (typeof node.type === 'function') visit(node.type(node.props))
    if (name === 'button') {
      seen.buttons.push(node.props.children.filter(child => typeof child === 'string').join(''))
    }
    visit(node.props.children)
  }
  visit(Card({ node: { outcome }, t: key => key }))
  return seen
}

let clientApi
async function loadClientApi() {
  if (clientApi !== undefined) return clientApi
  clientApi = (await loadClientModule()).factory(() => STUB_REACT)
  return clientApi
}

// 37 — the card parses its payload even when one of its own fields holds a code fence.
{
  const api = await loadClientApi()
  const payload = {
    schema: 'code-review/2',
    verdict: 'fail',
    findings: [{ severity: 'minor', title: 'fence', evidence: '+```json' }],
    withheld: [],
  }
  const text = `report body\n\n${MARKER}\n\`\`\`json\n${JSON.stringify(payload, null, 2)}\n\`\`\`\n`
  const parsed = api.__test.parsePayload(text)
  assert.equal(parsed?.findings?.[0]?.evidence, '+```json', 'a fence inside a field survives parsing')
  assert.equal(parsed?.verdict, 'fail')
  assert.equal(api.__test.parsePayload('no marker here'), undefined)
  assert.equal(api.__test.parsePayload(`${MARKER}\nno fence`), undefined)
}

// 38 — maxSearchResults actually bounds one search call.
{
  await withSettings({ maxSearchResults: 3 }, async () => {
    const h = harness({
      summary: SUMMARY,
      diffs: [TEXT_DIFF, BINARY_DIFF],
      script: [
        { toolCalls: [{ name: 'search', arguments: JSON.stringify({ query: 'NEEDLE_ROW_', maxResults: 60 }) }] },
        record([], 'searched'),
      ],
    })
    const result = await h.invoke('')
    assert.equal(result.kind, 'success')
    const toolText = messagesOf(h.seen.prompts[1], 'tool')[0].content[0].text
    assert.ok(toolText.includes('3 match(es)'), 'the configured bound applies, not the model request')
    assert.ok(!toolText.includes('NEEDLE_ROW_4'), 'later matches are not returned')
  })
}

// 39 — a link inside the workspace cannot be used to read outside it.
{
  const outside = mkdtempSync(join(tmpdir(), 'dsh-code-review-outside-'))
  writeFileSync(join(outside, 'secret.txt'), 'OUTSIDE_SECRET_CONTENT\n')
  const link = join(WS, 'link-out')
  let linked = true
  try {
    if (!existsSync(link)) symlinkSync(outside, link, 'junction')
  } catch {
    linked = false
  }
  if (linked) {
    const h = harness({
      summary: SUMMARY,
      diffs: [TEXT_DIFF, BINARY_DIFF],
      script: [
        { toolCalls: [{ name: 'read_file', arguments: JSON.stringify({ path: 'link-out/secret.txt' }) }] },
        record([], 'x'),
      ],
    })
    await h.invoke('')
    const refusal = messagesOf(h.seen.prompts[1], 'tool')[0]
    assert.equal(refusal.isError, true, 'reading through a link that leaves the workspace is refused')
    assert.ok(refusal.content[0].text.includes('outside the workspace'), refusal.content[0].text)
    assert.ok(!refusal.content[0].text.includes('OUTSIDE_SECRET_CONTENT'), 'outside content never reaches the model')
  } else {
    console.log('  (test 39 skipped: this system refused to create the link)')
  }
}

// 40 — a truncated string carries a language-neutral marker.
{
  const h = harness({
    summary: SUMMARY,
    diffs: [TEXT_DIFF, BINARY_DIFF],
    script: [record([{ ...PROVEN, evidence: `+${'x'.repeat(400)}` }])],
  })
  const payload = payloadOf((await h.invoke('')).text)
  assert.equal(payload.findings.length, 0)
  const reason = payload.withheld[0].reason
  assert.ok(reason.endsWith('…'), `expected an ellipsis, got: ${reason.slice(-12)}`)
  assert.ok(!/[\u3000-\u9fff\uff00-\uffef]/.test(reason), 'no CJK marker leaks into user-visible text')
}

// 41 — session scope reviews only the files this session wrote, even in a dirty tree.
{
  const { repo } = gitFixture()
  const root = realpathSync(repo)
  const h = harness({
    cwd: repo,
    hasEvent: false,
    diffs: [],
    toolCalls: [{ name: 'write', arguments: { file_path: join(root, 'fresh.go') } }],
    script: [record([], 'session only')],
  })
  const result = await h.invoke('session')
  assert.equal(result.kind, 'success', result.text)
  const payload = payloadOf(result.text)
  assert.equal(payload.scope, 'session')
  assert.equal(payload.stats.files, 1, 'only the file this session wrote')
  assert.equal(payload.stats.reviewed, 1)
  const prompt = h.seen.prompts[0].messages[0].content[0].text
  assert.ok(prompt.includes('fresh.go'), 'the session file is reviewed')
  assert.ok(!prompt.includes('board.go'), 'the unrelated working-tree change is out of scope')
  assert.ok(prompt.includes('session files only'), 'the source line says so')
}

// 42 — session scope with nothing attributable refuses, and points at full.
{
  const { repo } = gitFixture()
  const root = realpathSync(repo)
  const h = harness({
    cwd: repo,
    hasEvent: false,
    diffs: [],
    toolCalls: [{ name: 'read', arguments: { file_path: join(root, 'board.go') } }],
    script: [record([], 'x')],
  })
  const result = await h.invoke('session')
  assert.equal(result.kind, 'error')
  assert.ok(result.text.includes('session scope has nothing to review'), result.text)
  assert.ok(result.text.includes('/review full'), 'the message says what to do instead')
}

// 43 — full scope keeps everything, and tells the reviewer which files are the session's.
{
  const { repo } = gitFixture()
  const root = realpathSync(repo)
  const h = harness({
    cwd: repo,
    hasEvent: false,
    diffs: [],
    toolCalls: [{ name: 'edit', arguments: { file_path: join(root, 'board.go') } }],
    script: [record([], 'x')],
  })
  await h.invoke('full')
  const prompt = h.seen.prompts[0].messages[0].content[0].text
  assert.ok(prompt.includes('primary — written or edited in this session: board.go'), prompt)
  assert.ok(prompt.includes('not by this session: fresh.go'), 'the rest is named as not ours')
  assert.ok(!prompt.includes('session files only'), 'full scope reviews the whole working tree')
}

// 44 — the typed focus message reaches the reviewer, and nothing else does.
{
  const h = harness({ summary: SUMMARY, diffs: [TEXT_DIFF, BINARY_DIFF] })
  await h.invoke('provider=x model=y board.go satır 13 odak')
  const prompt = h.seen.prompts[0].messages[0].content[0].text
  assert.ok(prompt.includes('## Review focus'), 'the typed focus reaches the reviewer')
  assert.ok(prompt.includes('board.go satır 13 odak'), 'the whole message survives, including spaces')
  assert.ok(prompt.includes('It is not a question to answer'), 'and is framed as focus, not a question')
  assert.ok(!prompt.includes('Board ı hesapla'), 'the session message stays out')
  assert.equal(h.seen.prompts[0].provider, 'x', 'leading key=value arguments still apply')
  assert.equal(h.seen.prompts[0].model, 'y')
}

// 45 — the report language comes from the setting, else the focus message, else English.
{
  const bare = harness({ summary: SUMMARY, diffs: [TEXT_DIFF, BINARY_DIFF] })
  await bare.invoke('')
  assert.ok(bare.seen.prompts[0].messages[0].content[0].text.includes('in English.'), 'no focus → English')
  const mirrored = harness({ summary: SUMMARY, diffs: [TEXT_DIFF, BINARY_DIFF] })
  await mirrored.invoke('sadece board.go')
  assert.ok(
    mirrored.seen.prompts[0].messages[0].content[0].text.includes('same language as the review focus'),
    'a focus message sets the language',
  )
  await withSettings({ language: 'tr' }, async () => {
    const pinned = harness({ summary: SUMMARY, diffs: [TEXT_DIFF, BINARY_DIFF] })
    await pinned.invoke('')
    assert.ok(pinned.seen.prompts[0].messages[0].content[0].text.includes('in "tr".'), 'the setting pins the language')
    const overridden = harness({ summary: SUMMARY, diffs: [TEXT_DIFF, BINARY_DIFF] })
    await overridden.invoke('language=en')
    assert.ok(overridden.seen.prompts[0].messages[0].content[0].text.includes('in "en".'), 'an inline override wins')
  })
}

function subdirectoryFixture() {
  const repo = mkdtempSync(join(tmpdir(), 'dsh-code-review-subrepo-'))
  const git = args => spawnSync('git', args, { cwd: repo, encoding: 'utf8' })
  git(['init', '-q'])
  mkdirSync(join(repo, 'sub'), { recursive: true })
  mkdirSync(join(repo, 'other'), { recursive: true })
  writeFileSync(join(repo, 'sub', 'a.go'), 'package sub\n')
  writeFileSync(join(repo, 'sub', 'c.go'), 'package sub\n')
  writeFileSync(join(repo, 'other', 'b.go'), 'package other\n')
  git(['add', '.'])
  git(['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-q', '-m', 'init'])
  writeFileSync(join(repo, 'sub', 'a.go'), 'package sub\n\nfunc A() {}\n')
  writeFileSync(join(repo, 'sub', 'c.go'), 'package sub\n\nfunc C() {}\n')
  writeFileSync(join(repo, 'other', 'b.go'), 'package other\n\nfunc B() {}\n')
  return { repo, git, root: realpathSync(repo) }
}

// 46 — a session in a subdirectory still gets its own files reviewed.
{
  const { repo, root } = subdirectoryFixture()
  const h = harness({
    cwd: join(repo, 'sub'),
    hasEvent: false,
    diffs: [],
    toolCalls: [
      { name: 'write', arguments: { file_path: join(root, 'sub', 'a.go') } },
      { name: 'edit', arguments: { file_path: join(root, 'sub', 'c.go') } },
    ],
    script: [record([], 'subdirectory session')],
  })
  const result = await h.invoke('session')
  assert.equal(result.kind, 'success', result.text)
  const payload = payloadOf(result.text)
  assert.equal(payload.scope, 'session')
  assert.equal(payload.stats.reviewed, 2, 'both files this session wrote, seen from a subdirectory')
  const prompt = h.seen.prompts[0].messages[0].content[0].text
  assert.ok(prompt.includes('sub/a.go') && prompt.includes('sub/c.go'), 'repository-root-relative paths are used')
  assert.ok(!prompt.includes('other/b.go'), 'unrelated work outside the session stays out')
}

// 47 — full scope in a subdirectory still splits primary from the rest correctly.
{
  const { repo, root } = subdirectoryFixture()
  const h = harness({
    cwd: join(repo, 'sub'),
    hasEvent: false,
    diffs: [],
    toolCalls: [{ name: 'write', arguments: { file_path: join(root, 'sub', 'a.go') } }],
    script: [record([], 'x')],
  })
  await h.invoke('full')
  const prompt = h.seen.prompts[0].messages[0].content[0].text
  assert.ok(prompt.includes('primary — written or edited in this session: sub/a.go'), prompt)
  assert.ok(prompt.includes('other/b.go'), 'the unrelated change is named as not ours')
  assert.ok(prompt.includes('sub/c.go'), 'so is the session-directory file the session did not write')
}

// 48 — a path given through a link inside the repository still matches the git path.
{
  const { repo, root } = subdirectoryFixture()
  const link = join(repo, 'sub-link')
  let linked = true
  try {
    if (!existsSync(link)) symlinkSync(join(root, 'sub'), link, 'junction')
  } catch {
    linked = false
  }
  if (linked) {
    const h = harness({
      cwd: repo,
      hasEvent: false,
      diffs: [],
      toolCalls: [{ name: 'write', arguments: { file_path: join(link, 'a.go') } }],
      script: [record([], 'via a link')],
    })
    const result = await h.invoke('session')
    assert.equal(result.kind, 'success', result.text)
    assert.equal(payloadOf(result.text).stats.reviewed, 1, 'the canonical path is attributed to the session')
    assert.ok(h.seen.prompts[0].messages[0].content[0].text.includes('sub/a.go'))
  } else {
    console.log('  (test 48 skipped: this system refused to create the link)')
  }
}

// 49 — the card copies and nothing else: no control can reach the agent.
{
  const api = await loadClientApi()
  assert.deepEqual(
    Object.keys(api.__test).sort(),
    ['findingText', 'modeOf', 'parsePayload', 'readOutcome', 'reportOf', 'severityOf'],
    'the Client half exposes copy helpers and the mode reader only — there is no send path to misuse',
  )

  assert.equal(api.__test.readOutcome(null).face, 'running')
  assert.equal(api.__test.readOutcome({ kind: 'error', text: 'boom' }).face, 'error')
  assert.equal(
    api.__test.readOutcome({ kind: 'success', text: 'no payload here' }).face,
    'unparsed',
    'an unreadable payload is its own face, not an error',
  )
  const ok = api.__test.readOutcome({
    kind: 'success',
    text: `${MARKER}\n\`\`\`json\n{"verdict":"warn"}\n\`\`\``,
  })
  assert.equal(ok.face, 'report')
  assert.equal(ok.payload.verdict, 'warn', 'the parsed payload rides along with the face')

  const text = `## Code review — FAIL\n\nbody\n\n${MARKER}\n\`\`\`json\n{"verdict":"fail"}\n\`\`\`\n`
  assert.equal(api.__test.reportOf(text), '## Code review — FAIL\n\nbody', 'a copy takes the report, not the payload')
  assert.equal(api.__test.reportOf('no marker'), 'no marker', 'a raw fallback is copyable as it stands')

  const pasted = api.__test.findingText({ severity: 'major', title: 'T', file: 'a.go', line: 3, problem: 'p', evidence: '+x' }, 0)
  assert.ok(pasted.startsWith('### 1. [major] T — a.go:3'), pasted)
  assert.ok(pasted.includes('```diff'), 'the evidence keeps the report-fenced shape')
  assert.equal(
    api.__test.findingText({ severity: 'nit', title: 'No file' }, 0),
    '### 1. [nit] No file',
    'a finding that names no file stays clean',
  )

  const arcMode = api.__test.modeOf({
    mode: {
      id: 'arc',
      label: 'Architecture review',
      severities: [{ id: 'high', label: 'high', tone: 'error' }],
      fields: [
        { key: 'problem', label: '', block: false },
        { key: 'consequence', label: 'Consequence', block: false },
        { key: 'evidence', label: 'Evidence', block: true },
      ],
    },
  })
  const arcPaste = api.__test.findingText(
    { severity: 'high', title: 'Split it', file: 'a.go', problem: 'p', consequence: 'c', impact: 'not declared', evidence: '+x' },
    0,
    arcMode,
  )
  assert.ok(arcPaste.startsWith('### 1. [high] Split it — a.go'), arcPaste)
  assert.ok(arcPaste.includes('**Consequence:** c'), arcPaste)
  assert.ok(!arcPaste.includes('not declared'), 'a field the mode does not declare is not part of the finding')
}

// 50 — end to end: the user receives the whole review, and the agent receives nothing.
{
  const { repo } = gitFixture()
  const h = harness({
    cwd: repo,
    hasEvent: false,
    diffs: [],
    script: [record([GIT_FINDING], 'Reset panics instead of resetting.')],
  })
  const result = await h.invoke('')
  assert.equal(result.kind, 'success', result.text)
  assert.equal(h.seen.steer.length, 0, 'the review did not start a turn for the agent')
  assert.equal(h.seen.inject.length, 0, 'and did not enter its context')
  assert.ok(result.text.includes('## Code review — FAIL'), 'the user gets the report')
  assert.ok(result.text.includes('Reset panics instead of resetting'), 'with the finding in it')
  assert.ok(result.text.includes('**Evidence:**'), 'and the evidence behind it')

  const api = await loadClientApi()
  const payload = api.__test.parsePayload(result.text)
  assert.equal(payload?.findings?.length, 1, 'the card parses the host report')
  assert.equal(payload.findings[0].file, 'board.go')
  assert.equal(payload.verdict, 'fail')
  const copyable = api.__test.reportOf(result.text)
  assert.ok(copyable.includes('Reset panics instead of resetting'), 'the copy holds the whole report')
  assert.ok(!copyable.includes(MARKER), 'without the machine payload')
}

// 51 — the line totals agree with git itself, even when content looks like a header.
{
  const repo = mkdtempSync(join(tmpdir(), 'dsh-code-review-numstat-'))
  const git = args => spawnSync('git', args, { cwd: repo, encoding: 'utf8' })
  git(['init', '-q'])
  // Each line collides with a file header or a hunk marker: a deleted '-- x' renders as '--- x', an added '++ x' as '+++ x'.
  writeFileSync(join(repo, 'tricky.txt'), ['alpha', '-- old sql comment', '--- old rule', '++ old increment', 'omega', ''].join('\n'))
  writeFileSync(join(repo, 'tail.txt'), 'first\nsecond\n')
  git(['add', '.'])
  git(['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-q', '-m', 'init'])
  writeFileSync(join(repo, 'tricky.txt'), ['alpha', '-- new sql comment', '--- new rule', '++ new increment', '+++ new triple', 'omega', ''].join('\n'))
  // No trailing newline: the '\ No newline at end of file' marker git appends must not be counted as either side.
  writeFileSync(join(repo, 'tail.txt'), 'first\nchanged')

  const totals = git(['diff', '--numstat']).stdout.trim().split('\n')
    .map(line => line.split('\t'))
    .filter(cols => /^\d+$/.test(cols[0]) && /^\d+$/.test(cols[1]))
    .reduce((sum, cols) => ({ added: sum.added + Number(cols[0]), deleted: sum.deleted + Number(cols[1]) }), { added: 0, deleted: 0 })
  assert.ok(totals.added > 0 && totals.deleted > 0, `the fixture changes lines: ${JSON.stringify(totals)}`)

  const h = harness({
    cwd: repo,
    hasEvent: false,
    diffs: [],
    script: [record([], 'tallied')],
  })
  const result = await h.invoke('')
  assert.equal(result.kind, 'success', result.text)
  const payload = payloadOf(result.text)
  assert.equal(payload.stats.reviewed, 2, 'both files are reviewed')
  assert.equal(payload.stats.added, totals.added, `added matches git --numstat (${totals.added})`)
  assert.equal(payload.stats.deleted, totals.deleted, `deleted matches git --numstat (${totals.deleted})`)

  const diff = h.seen.prompts[0].messages[0].content[0].text
  assert.ok(diff.includes('--- old sql comment'), 'the diff really carries a deletion that looks like a header')
  assert.ok(diff.includes('++++ new triple'), 'and an addition that looks like one too')
  assert.ok(diff.includes('\\ No newline at end of file'), 'and the no-newline marker')
}

// 52 — what the card draws, and that nothing on it can send anything.
{
  const report = {
    verdict: 'warn',
    summary: 'A summary.',
    findings: [{
      severity: 'minor', title: 'T', file: 'a.go', line: 3,
      problem: 'p', impact: 'i', trigger: 'tr', suggestion: 's', evidence: '+x',
    }],
    withheld: [],
    stats: { files: 1, added: 2, deleted: 1, reviewed: 1, skipped: [] },
    reviewer: { provider: 'p', model: 'm' },
  }
  const text = `## Code review — WARN\n\nA summary.\n\n${MARKER}\n\`\`\`json\n${JSON.stringify(report)}\n\`\`\`\n`

  const running = await renderCard(null)
  assert.deepEqual(running.buttons, [], 'a running review offers no control')
  assert.ok(running.texts.includes('state.running'), 'and says it is running')

  const failed = await renderCard({ kind: 'error', text: 'boom' })
  assert.ok(failed.texts.includes('state.error'), 'a failed command is reported as one')
  assert.deepEqual(failed.buttons, ['action.copyReport'], 'with the raw text copyable')

  const unparsed = await renderCard({ kind: 'success', text: 'no payload at all' })
  assert.ok(unparsed.texts.includes('raw.fallback'), 'an unreadable payload is its own message')
  assert.ok(!unparsed.texts.includes('state.error'), 'and is never called a failed review')

  const full = await renderCard({ kind: 'success', text })
  assert.deepEqual(
    full.buttons,
    ['action.copyReport', 'toggle.hide', 'action.copyFinding'],
    'the card draws the two copy actions and the collapse toggle, in that order',
  )
  const ALLOWED = new Set(['action.copyReport', 'action.copyFinding', 'toggle.hide', 'toggle.show'])
  assert.deepEqual(
    full.buttons.filter(caption => !ALLOWED.has(caption)),
    [],
    'nothing on the card does anything but copy or collapse',
  )
  assert.ok(full.texts.includes('a.go:3'), 'the finding names its location')
  assert.ok(full.texts.includes('Impact: i'), 'and carries its impact')
  assert.ok(full.texts.includes('How it is reached: tr'), 'and how it is reached')
  assert.ok(full.texts.includes('Evidence'), 'and the evidence behind it')
  assert.ok(full.texts.includes('action.yours'), 'and says the report is the reader\'s')
}

// 53 — a tracked file whose name carries whitespace is reviewed, not lost.
{
  let usable = true
  const repo = mkdtempSync(join(tmpdir(), 'dsh-code-review-space-'))
  const name = ' spaced.go'
  try {
    writeFileSync(join(repo, name), 'package spaced\n\nvar A = 1\n')
  } catch {
    usable = false
  }
  if (!usable) {
    console.log('  (test 53 skipped: this system refused a name with a leading space)')
  } else {
    const git = args => spawnSync('git', args, { cwd: repo, encoding: 'utf8' })
    git(['init', '-q'])
    writeFileSync(join(repo, 'plain.go'), 'package plain\n\nvar B = 1\n')
    git(['add', '.'])
    git(['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-q', '-m', 'init'])
    writeFileSync(join(repo, name), 'package spaced\n\nvar A = 2\n')

    const h = harness({ cwd: repo, hasEvent: false, diffs: [], script: [record([], 'spaced')] })
    const result = await h.invoke('')
    assert.equal(result.kind, 'success', result.text)
    const payload = payloadOf(result.text)
    assert.deepEqual(payload.stats.skipped, [], 'the name was not mangled into a path that does not exist')
    assert.equal(payload.stats.reviewed, 1, 'the whitespace-named file was reviewed')
    assert.ok(
      h.seen.prompts[0].messages[0].content[0].text.includes('+var A = 2'),
      'and its change reached the reviewer',
    )
  }
}

// 54 — a tracked binary is reported as left out, never counted as reviewed.
{
  const repo = mkdtempSync(join(tmpdir(), 'dsh-code-review-bin-'))
  const git = args => spawnSync('git', args, { cwd: repo, encoding: 'utf8' })
  git(['init', '-q'])
  // A NUL byte in the first block is what makes git call a file binary.
  writeFileSync(join(repo, 'logo.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0x01, 0x02, 0x03]))
  writeFileSync(join(repo, 'plain.go'), 'package plain\n\nvar B = 1\n')
  git(['add', '.'])
  git(['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-q', '-m', 'init'])
  writeFileSync(join(repo, 'logo.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0xff, 0xfe, 0xfd]))
  writeFileSync(join(repo, 'plain.go'), 'package plain\n\nvar B = 2\n')

  const h = harness({ cwd: repo, hasEvent: false, diffs: [], script: [record([], 'binary')] })
  const result = await h.invoke('')
  assert.equal(result.kind, 'success', result.text)
  const payload = payloadOf(result.text)
  assert.equal(payload.stats.reviewed, 1, 'only the text file was reviewed')
  assert.deepEqual(payload.stats.skipped, [{ file: 'logo.png', reason: 'binary' }], 'the binary is listed as left out')
  assert.ok(result.text.includes('- logo.png — binary'), 'and the report says why it was left out')
  const prompt = h.seen.prompts[0].messages[0].content[0].text
  assert.ok(!prompt.includes('Binary files'), 'no hunk-less stub was sent to the reviewer')
  assert.ok(prompt.includes('+var B = 2'), 'while the text change still was')
}

// 55 — a name that looks like a pathspec pattern is read literally.
{
  const repo = mkdtempSync(join(tmpdir(), 'dsh-code-review-glob-'))
  const git = args => spawnSync('git', args, { cwd: repo, encoding: 'utf8' })
  git(['init', '-q'])
  writeFileSync(join(repo, 'a1.go'), 'package a\n\nvar ONE = 1\n')
  writeFileSync(join(repo, 'a[1].go'), 'package a\n\nvar TWO = 1\n')
  git(['add', '.'])
  git(['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-q', '-m', 'init'])
  writeFileSync(join(repo, 'a1.go'), 'package a\n\nvar ONE = 2\n')
  writeFileSync(join(repo, 'a[1].go'), 'package a\n\nvar TWO = 2\n')

  const h = harness({ cwd: repo, hasEvent: false, diffs: [], script: [record([], 'glob')] })
  const result = await h.invoke('')
  assert.equal(result.kind, 'success', result.text)
  assert.equal(payloadOf(result.text).stats.reviewed, 2, 'both files are reviewed')
  const prompt = h.seen.prompts[0].messages[0].content[0].text
  const occurrences = needle => prompt.split(needle).length - 1
  // Read as a glob, 'a[1].go' also matches 'a1.go', so one file's change would be pulled into the other's diff and reported twice.
  assert.equal(occurrences('+var ONE = 2'), 1, 'each file is diffed once')
  assert.equal(occurrences('+var TWO = 2'), 1, 'and the pattern-like name pulled in no other file')
}

// 56 — the diff reaches the reviewer exactly as git wrote it.
{
  const repo = mkdtempSync(join(tmpdir(), 'dsh-code-review-verbatim-'))
  const git = args => spawnSync('git', args, { cwd: repo, encoding: 'utf8' })
  git(['init', '-q'])
  writeFileSync(join(repo, 'a.go'), 'package a\n\nvar A = 1\n')
  git(['add', '.'])
  git(['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-q', '-m', 'init'])
  // The added line is whitespace only and last, so trimming the whole diff would rewrite it into a bare '+'.
  writeFileSync(join(repo, 'a.go'), 'package a\n\nvar A = 1\n   \n')

  const h = harness({ cwd: repo, hasEvent: false, diffs: [], script: [record([], 'verbatim')] })
  const result = await h.invoke('')
  assert.equal(result.kind, 'success', result.text)
  const prompt = h.seen.prompts[0].messages[0].content[0].text
  assert.ok(prompt.includes('+   \n'), 'the whitespace-only added line survives verbatim')
  assert.ok(!prompt.includes('\n+\n'), 'and was not rewritten into a bare +')
}

function noisyFixture() {
  const repo = mkdtempSync(join(tmpdir(), 'dsh-code-review-noisy-'))
  const git = args => spawnSync('git', args, { cwd: repo, encoding: 'utf8' })
  git(['init', '-q'])
  writeFileSync(join(repo, 'app.go'), 'package app\n\nvar A = 1\n')
  mkdirSync(join(repo, 'vendor', 'lib'), { recursive: true })
  writeFileSync(join(repo, 'vendor', 'lib', 'vendored.go'), 'package vendored\n\nvar VENDOR_NEEDLE = 1\n')
  git(['add', '.'])
  git(['add', '-f', 'vendor/lib/vendored.go'])
  git(['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-q', '-m', 'init'])
  writeFileSync(join(repo, 'app.go'), 'package app\n\nvar A = 2\n')
  writeFileSync(join(repo, 'vendor', 'lib', 'vendored.go'), 'package vendored\n\nvar VENDOR_NEEDLE = 2\n')
  mkdirSync(join(repo, 'node_modules', 'dep'), { recursive: true })
  writeFileSync(join(repo, 'node_modules', 'dep', 'index.js'), 'module.exports = "DEPENDENCY_NEEDLE"\n')
  mkdirSync(join(repo, 'dist'), { recursive: true })
  writeFileSync(join(repo, 'dist', 'bundle.js'), 'var BUNDLE_NEEDLE = 1\n')
  writeFileSync(join(repo, 'debug.log'), 'LOG_NEEDLE\n')
  return { repo, git }
}

const NOISY_NEEDLES = ['DEPENDENCY_NEEDLE', 'BUNDLE_NEEDLE', 'LOG_NEEDLE', 'VENDOR_NEEDLE']

// 57 — the built-in list keeps dependencies, build output and logs out of the diff.
{
  const { repo } = noisyFixture()
  const h = harness({ cwd: repo, hasEvent: false, diffs: [], script: [record([], 'source only')] })
  const result = await h.invoke('')
  assert.equal(result.kind, 'success', result.text)
  const payload = payloadOf(result.text)
  const ignore = payload.stats.ignore
  assert.equal(payload.stats.reviewed, 1, 'only the source file is reviewed')
  assert.equal(payload.stats.files, 1, 'the ignored files are not part of the change set')
  assert.deepEqual(payload.stats.skipped, [], 'an ignored file is not also reported as left out')
  assert.equal(ignore.count, 4, 'the tracked vendored file and the three untracked ones')
  assert.equal(ignore.builtIn, true)
  assert.ok(ignore.builtInPatterns > 50, 'the built-in standard list is in force')
  assert.deepEqual(
    ignore.sample.map(item => item.file).sort(),
    ['debug.log', 'dist/bundle.js', 'node_modules/dep/index.js', 'vendor/lib/vendored.go'],
    'every excluded path is named',
  )
  assert.deepEqual(
    Object.fromEntries(ignore.sample.map(item => [item.file, item.rule])),
    {
      'debug.log': '*.log',
      'dist/bundle.js': 'dist/',
      'node_modules/dep/index.js': 'node_modules/',
      'vendor/lib/vendored.go': 'vendor/',
    },
    'each one is excluded by the rule the user can override',
  )
  const prompt = h.seen.prompts[0].messages[0].content[0].text
  assert.ok(prompt.includes('+var A = 2'), 'the source change reached the reviewer')
  for (const needle of NOISY_NEEDLES) {
    assert.ok(!prompt.includes(needle), `nothing under an ignored path reached the prompt (${needle})`)
  }
  assert.ok(prompt.includes('- already excluded by the ignore rules'), 'the reviewer is told what was taken out')
  assert.ok(result.text.includes('- excluded as ignored: 4 file(s)'), 'the report names them instead of hiding them')
  assert.ok(result.text.includes('- ignore rules: built-in standard list'), 'and says which rules were in force')
}

// 58 — config patterns and typed ones add to the list, and `!` puts a path back.
{
  const { repo } = noisyFixture()
  mkdirSync(join(repo, 'generated'), { recursive: true })
  writeFileSync(join(repo, 'generated', 'code.go'), 'package generated\n\nvar GEN_NEEDLE = 1\n')

  await withSettings({ ignored: ['generated/', '*.log'] }, async () => {
    const h = harness({ cwd: repo, hasEvent: false, diffs: [], script: [record([], 'configured')] })
    const payload = payloadOf((await h.invoke('')).text)
    assert.equal(payload.stats.ignore.configured, 2, 'the config patterns are in force')
    assert.ok(
      payload.stats.ignore.sample.some(item => item.file === 'generated/code.go' && item.rule === 'generated/'),
      'a configured pattern names itself in the report',
    )
    assert.ok(!h.seen.prompts[0].messages[0].content[0].text.includes('GEN_NEEDLE'), 'and keeps the path out')
  })

  mkdirSync(join(repo, 'odd dir'), { recursive: true })
  writeFileSync(join(repo, 'odd dir', 'note.md'), 'ODD_NEEDLE\n')
  const h = harness({ cwd: repo, hasEvent: false, diffs: [], script: [record([], 'typed')] })
  const result = await h.invoke('ignored=!dist/,generated/ ignored="odd dir/" kalan odak')
  const payload = payloadOf(result.text)
  assert.equal(payload.focus, 'kalan odak', 'the focus message survives the ignore arguments')
  assert.equal(payload.stats.ignore.typed, 3, 'all three typed patterns are in force')
  assert.equal(payload.stats.reviewed, 2, 'the source file and the bundle the negation put back')
  const prompt = h.seen.prompts[0].messages[0].content[0].text
  assert.ok(prompt.includes('BUNDLE_NEEDLE'), '`!dist/` brings the build output back into the review')
  assert.ok(!prompt.includes('DEPENDENCY_NEEDLE'), 'while the dependency tree stays out')
  assert.ok(!prompt.includes('GEN_NEEDLE'), 'and the typed `generated/` keeps its path out too')
  assert.ok(!prompt.includes('ODD_NEEDLE'), 'a quoted pattern with a space in it is one pattern, not two')
}

// 59 — the repository's own ignore rules are honored, tracked files included.
{
  const repo = mkdtempSync(join(tmpdir(), 'dsh-code-review-repoignore-'))
  const git = args => spawnSync('git', args, { cwd: repo, encoding: 'utf8' })
  git(['init', '-q'])
  writeFileSync(join(repo, '.gitignore'), 'generated/\n*.secret\n')
  writeFileSync(join(repo, 'app.go'), 'package app\n\nvar A = 1\n')
  mkdirSync(join(repo, 'generated'), { recursive: true })
  writeFileSync(join(repo, 'generated', 'api.go'), 'package generated\n\nvar REPO_NEEDLE = 1\n')
  git(['add', '.gitignore', 'app.go'])
  git(['add', '-f', 'generated/api.go'])
  git(['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-q', '-m', 'init'])
  writeFileSync(join(repo, 'app.go'), 'package app\n\nvar A = 2\n')
  writeFileSync(join(repo, 'generated', 'api.go'), 'package generated\n\nvar REPO_NEEDLE = 2\n')

  const h = harness({ cwd: repo, hasEvent: false, diffs: [], script: [record([], 'own rules')] })
  const result = await h.invoke('')
  const payload = payloadOf(result.text)
  assert.equal(payload.stats.reviewed, 1, 'the tracked file the project itself ignores is out')
  assert.equal(payload.stats.ignore.gitIgnore, true, 'the report says the repository rules were consulted')
  assert.ok(
    payload.stats.ignore.sample.some(item => item.file === 'generated/api.go'
      && item.rule === "the repository's own ignore rules"),
    'and names the reason',
  )
  assert.ok(!h.seen.prompts[0].messages[0].content[0].text.includes('REPO_NEEDLE'))

  const over = harness({ cwd: repo, hasEvent: false, diffs: [], script: [record([], 'rescued')] })
  await over.invoke('ignored=!generated/api.go')
  assert.ok(
    over.seen.prompts[0].messages[0].content[0].text.includes('REPO_NEEDLE'),
    'an explicit `!pattern` puts back what .gitignore took out',
  )

  await withSettings({ respectGitIgnore: false }, async () => {
    const off = harness({ cwd: repo, hasEvent: false, diffs: [], script: [record([], 'no repo rules')] })
    const offPayload = payloadOf((await off.invoke('')).text)
    assert.equal(offPayload.stats.ignore.gitIgnore, false, 'the repository rules can be turned off')
    assert.equal(offPayload.stats.reviewed, 2, 'and then the tracked file is reviewed again')
  })
}

// 60 — the built-in list can be turned off, from the config or from the command line.
{
  const { repo } = noisyFixture()
  await withSettings({ ignoreDefaults: false }, async () => {
    const h = harness({ cwd: repo, hasEvent: false, diffs: [], script: [record([], 'all of it')] })
    const payload = payloadOf((await h.invoke('')).text)
    assert.equal(payload.stats.ignore.builtIn, false)
    assert.equal(payload.stats.ignore.count, 0, 'nothing is excluded once the list is off')
    assert.equal(payload.stats.reviewed, 5, 'so the dependency tree, the bundle and the log are reviewed')
    assert.ok(h.seen.prompts[0].messages[0].content[0].text.includes('DEPENDENCY_NEEDLE'))
  })

  await withSettings({ ignoreDefaults: false }, async () => {
    const h = harness({ cwd: repo, hasEvent: false, diffs: [], script: [record([], 'defaults back')] })
    const result = await h.invoke('ignoreDefaults=true')
    assert.equal(payloadOf(result.text).stats.ignore.builtIn, true, '`ignoreDefaults=true` wins over the config')
    assert.equal(payloadOf(result.text).stats.reviewed, 1)
  })
}

// 61 — what the ignore rules take out of the diff, the reader cannot put back.
{
  const { repo } = noisyFixture()
  const hidden = 'node_modules/dep/index.js'
  const h = harness({
    cwd: repo,
    hasEvent: false,
    diffs: [],
    script: [
      {
        toolCalls: [
          { name: 'read_file', arguments: JSON.stringify({ path: hidden }) },
          { name: 'search', arguments: JSON.stringify({ query: 'NEEDLE' }) },
          { name: 'list_dir', arguments: '{"path":"."}' },
        ],
      },
      record([{
        severity: 'major', category: 'correctness', file: hidden, line: 1,
        title: 'Dependency defect', problem: 'a claim about code the review excluded',
        impact: 'The reviewer would report on a dependency tree nobody asked about.',
        trigger: 'A review that reads node_modules reaches this by ignoring the rules.',
        suggestion: 'none', evidence: 'module.exports = "DEPENDENCY_NEEDLE"',
      }], 'read the tree'),
    ],
  })
  const result = await h.invoke('')
  const tool = messagesOf(h.seen.prompts[1], 'tool')
  assert.equal(tool[0].isError, true, 'reading an ignored path is refused')
  assert.ok(tool[0].content[0].text.includes("excluded by the review's ignore rules"), tool[0].content[0].text)
  assert.ok(tool[0].content[0].text.includes('node_modules/'), 'and says which rule excluded it')
  assert.ok(!tool[0].content[0].text.includes('DEPENDENCY_NEEDLE'), 'the file is never read at all')
  assert.ok(tool[1].content[0].text.includes('no match for "NEEDLE"'), 'a search cannot see into an ignored path')
  for (const needle of NOISY_NEEDLES) {
    assert.ok(!tool[1].content[0].text.includes(needle), `no ignored content reaches the search result (${needle})`)
  }
  assert.ok(!tool[2].content[0].text.includes('node_modules'), 'list_dir hides an ignored directory')
  assert.ok(!tool[2].content[0].text.includes('bundle.js'), 'and ignored files with it')
  assert.ok(tool[2].content[0].text.includes('app.go'), 'while the source file is still listed')
  const payload = payloadOf(result.text)
  assert.equal(payload.findings.length, 0, 'a finding about an ignored path cannot be published')
  assert.equal(payload.withheld.length, 1)
  assert.ok(payload.withheld[0].reason.includes('not one the reviewer could see'), payload.withheld[0].reason)
}

// 62 — the session record is filtered by the same rules, before any diff is fetched.
{
  const files = [
    { path: 'internal/chessx/board.go', display: 'internal/chessx/board.go', added: 2, deleted: 1 },
    { path: 'node_modules/dep/index.js', display: 'node_modules/dep/index.js', added: 1, deleted: 0 },
  ]
  const h = harness({
    summary: { turn: 3, cwd: WS, total: 2, added: 3, deleted: 1, files },
    diffs: [TEXT_DIFF],
    script: [record([], 'session record')],
  })
  const result = await h.invoke('session')
  assert.equal(result.kind, 'success', result.text)
  const payload = payloadOf(result.text)
  assert.equal(payload.stats.reviewed, 1)
  assert.deepEqual(payload.stats.skipped, [], 'the ignored file was never asked for')
  assert.equal(payload.stats.files, 1, 'and never counted as part of the change set')
  assert.deepEqual(payload.stats.ignore.sample, [{ file: 'node_modules/dep/index.js', rule: 'node_modules/' }])
  const prompt = h.seen.prompts[0].messages[0].content[0].text
  const diffs = prompt.slice(prompt.indexOf('## Unified diffs'), prompt.indexOf('## Language'))
  assert.ok(prompt.includes('already excluded by the ignore rules'), 'the exclusion is reported to the reviewer')
  assert.ok(!diffs.includes('node_modules'), 'and the ignored file never entered the diffs')
}

// 63 — a change set that is entirely ignored says so, and is never called clean.
{
  const repo = mkdtempSync(join(tmpdir(), 'dsh-code-review-onlyignored-'))
  const git = args => spawnSync('git', args, { cwd: repo, encoding: 'utf8' })
  git(['init', '-q'])
  writeFileSync(join(repo, 'seed.go'), 'package seed\n\nvar S = 1\n')
  git(['add', '.'])
  git(['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-q', '-m', 'init'])
  mkdirSync(join(repo, 'node_modules', 'dep'), { recursive: true })
  writeFileSync(join(repo, 'node_modules', 'dep', 'index.js'), 'module.exports = 1\n')

  const h = harness({
    cwd: repo,
    summary: SUMMARY,
    diffs: [TEXT_DIFF, BINARY_DIFF],
    script: [record([], 'never asked')],
  })
  const result = await h.invoke('')
  assert.equal(result.kind, 'error')
  assert.ok(result.text.includes('every one is excluded by the ignore rules'), result.text)
  assert.ok(result.text.includes('node_modules/dep/index.js'), 'the message names what it left out')
  assert.ok(result.text.includes('ignoreDefaults'), 'and how to put it back')
  assert.equal(h.seen.prompts.length, 0, 'no reviewer call is spent on an empty change set')
}

// 64 — the pattern syntax: anchoring, `**`, classes and directory patterns.
{
  const repo = mkdtempSync(join(tmpdir(), 'dsh-code-review-patterns-'))
  const git = args => spawnSync('git', args, { cwd: repo, encoding: 'utf8' })
  git(['init', '-q'])
  const paths = [
    'keep.go', 'gen/a.go', 'sub/gen/b.go', 'docs/one.md', 'docs/deep/two.md', 'tmp/file1.go',
  ]
  for (const path of paths) {
    mkdirSync(dirname(join(repo, path)), { recursive: true })
    writeFileSync(join(repo, path), `package p\n\nvar ${path.replace(/\W/g, '_')} = 1\n`)
  }
  git(['add', '.'])
  git(['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-q', '-m', 'init'])
  for (const path of paths) {
    writeFileSync(join(repo, path), `package p\n\nvar ${path.replace(/\W/g, '_')} = 2\n`)
  }

  const h = harness({ cwd: repo, hasEvent: false, diffs: [], script: [record([], 'patterns')] })
  const result = await h.invoke('ignored=/gen/,file[0-9].go,docs/**/*.md,sub/gen/,!sub/gen/b.go')
  const payload = payloadOf(result.text)
  const byFile = Object.fromEntries(payload.stats.ignore.sample.map(item => [item.file, item.rule]))
  assert.deepEqual(byFile, {
    'docs/deep/two.md': 'docs/**/*.md',
    'docs/one.md': 'docs/**/*.md',
    'gen/a.go': '/gen/',
    'tmp/file1.go': 'file[0-9].go',
  }, 'a leading slash anchors, `**/` spans directories, a class matches one character')
  assert.equal(payload.stats.reviewed, 2, 'keep.go and the file a later `!` put back')
  const prompt = h.seen.prompts[0].messages[0].content[0].text
  assert.ok(prompt.includes('sub/gen/b.go'), 'the negation overrides the directory pattern before it')
  assert.ok(!prompt.includes('sub/gen/a.go') && prompt.includes('gen/a.go'), 'the root-anchored pattern spared sub/gen')
}

// 65 — the card reports the count and the rule, and still cannot send anything.
{
  const report = {
    verdict: 'pass',
    summary: 'A summary.',
    findings: [],
    withheld: [],
    stats: {
      files: 1,
      added: 1,
      deleted: 0,
      reviewed: 1,
      skipped: [],
      ignore: {
        count: 2,
        sample: [
          { file: 'node_modules/a.js', rule: 'node_modules/' },
          { file: 'dist/b.js', rule: 'dist/' },
        ],
      },
    },
    reviewer: { provider: 'p', model: 'm' },
  }
  const text = `## Code review — PASS\n\nA summary.\n\n${MARKER}\n\`\`\`json\n${JSON.stringify(report)}\n\`\`\`\n`
  const card = await renderCard({ kind: 'success', text })
  // The recorder truncates the meta line, so the section's own label and rows are what prove the count.
  assert.ok(card.texts.includes('label.ignored (2)'), 'the section names the count')
  assert.ok(card.texts.includes('node_modules/a.js — node_modules/'), 'and shows the rule behind each file')
  assert.ok(card.texts.includes('dist/b.js — dist/'))
  assert.deepEqual(
    card.buttons,
    ['action.copyReport', 'toggle.hide'],
    'the ignored section adds no control that could send anything',
  )
}

// 66 — the reader answers under the repository rules the change set was filtered by.
{
  const repo = mkdtempSync(join(tmpdir(), 'dsh-code-review-readerignore-'))
  const git = args => spawnSync('git', args, { cwd: repo, encoding: 'utf8' })
  git(['init', '-q'])
  writeFileSync(join(repo, '.gitignore'), 'generated/\n')
  writeFileSync(join(repo, 'app.go'), 'package app\n\nvar A = 1\n')
  mkdirSync(join(repo, 'generated'), { recursive: true })
  writeFileSync(join(repo, 'generated', 'api.go'), 'package generated\n\nvar REPO_NEEDLE = 1\n')
  git(['add', '.gitignore', 'app.go'])
  git(['add', '-f', 'generated/api.go'])
  git(['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-q', '-m', 'init'])
  writeFileSync(join(repo, 'app.go'), 'package app\n\nvar A = 2\n')
  writeFileSync(join(repo, 'generated', 'api.go'), 'package generated\n\nvar REPO_NEEDLE = 2\n')

  const hidden = 'generated/api.go'
  const h = harness({
    cwd: repo,
    hasEvent: false,
    diffs: [],
    script: [
      {
        toolCalls: [
          { name: 'read_file', arguments: JSON.stringify({ path: hidden }) },
          { name: 'search', arguments: JSON.stringify({ query: 'REPO_NEEDLE' }) },
          { name: 'list_dir', arguments: '{"path":"."}' },
          { name: 'list_dir', arguments: '{"path":"generated"}' },
        ],
      },
      record([{
        severity: 'major', category: 'correctness', file: hidden, line: 3,
        title: 'Ignored file still readable', problem: 'a claim about a file the change set excluded',
        impact: 'A file the review took out of the diff comes back in through a read.',
        trigger: 'Asking the reader for a path the repository ignores reaches this.',
        suggestion: 'none', evidence: 'var REPO_NEEDLE = 2',
      }], 'read it'),
    ],
  })
  const result = await h.invoke('')
  const tool = messagesOf(h.seen.prompts[1], 'tool')
  assert.equal(tool[0].isError, true, 'reading a path only the repository ignores is refused')
  assert.ok(tool[0].content[0].text.includes("excluded by the review's ignore rules"), tool[0].content[0].text)
  assert.ok(tool[0].content[0].text.includes("the repository's own ignore rules"), 'and names that layer')
  assert.ok(!tool[0].content[0].text.includes('REPO_NEEDLE'), 'the file is never read at all')
  assert.ok(tool[1].content[0].text.includes('no match for "REPO_NEEDLE"'), 'and a search cannot find it')
  assert.ok(!tool[2].content[0].text.includes('api.go'), 'the ignored file is in no listing')
  assert.ok(tool[3].content[0].text.includes('0 entries'), 'and its own directory lists empty')
  const payload = payloadOf(result.text)
  assert.equal(payload.findings.length, 0, 'so no finding can be built on it')
  assert.equal(payload.withheld.length, 1)
  assert.ok(payload.withheld[0].reason.includes('not one the reviewer could see'), payload.withheld[0].reason)
}

// 67 — the config file is found under the harness home, never under the cwd.
{
  const home = mkdtempSync(join(tmpdir(), 'dsh-code-review-default-home-'))
  mkdirSync(join(home, '.dsh', 'code-review'), { recursive: true })
  writeFileSync(join(home, '.dsh', 'code-review', 'config.json'), JSON.stringify({ maxFiles: 1 }))
  const previous = { DSH_HOME: process.env.DSH_HOME, HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE }
  // 'dsh web' may run with no DSH_HOME at all; the home is then '~/.dsh', which is what os.homedir() reads.
  delete process.env.DSH_HOME
  process.env.HOME = home
  process.env.USERPROFILE = home
  try {
    const h = harness({ summary: SUMMARY, diffs: [TEXT_DIFF, BINARY_DIFF], git: false })
    const payload = payloadOf((await h.invoke('')).text)
    assert.equal(payload.stats.reviewed, 1, 'the config under ~/.dsh was read')
    assert.deepEqual(
      payload.stats.skipped,
      [{ file: 'assets/logo.png', reason: 'over-file-limit' }],
      'and its maxFiles decided the review',
    )
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
  }
}

// 68 — session scope reports the session's own ignored file, not "nothing differs".
{
  const repo = mkdtempSync(join(tmpdir(), 'dsh-code-review-sessionignored-'))
  const git = args => spawnSync('git', args, { cwd: repo, encoding: 'utf8' })
  git(['init', '-q'])
  writeFileSync(join(repo, '.gitignore'), 'dist/\n')
  mkdirSync(join(repo, 'src'), { recursive: true })
  mkdirSync(join(repo, 'dist'), { recursive: true })
  writeFileSync(join(repo, 'src', 'app.js'), 'export const a = 1\n')
  writeFileSync(join(repo, 'dist', 'bundle.js'), 'var bundle = 1\n')
  git(['add', '.gitignore', 'src/app.js'])
  git(['add', '-f', 'dist/bundle.js'])
  git(['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-q', '-m', 'init'])
  writeFileSync(join(repo, 'dist', 'bundle.js'), 'var bundle = 2\n')
  writeFileSync(join(repo, 'src', 'app.js'), 'export const a = 2\n')
  const root = realpathSync(repo)

  const h = harness({
    cwd: repo,
    hasEvent: false,
    diffs: [],
    toolCalls: [{ name: 'write', arguments: { file_path: join(root, 'dist', 'bundle.js') } }],
    script: [record([], 'never asked')],
  })
  const result = await h.invoke('session')
  assert.equal(result.kind, 'error', result.text)
  assert.ok(result.text.includes('excluded by the ignore rules'), result.text)
  assert.ok(result.text.includes('dist/bundle.js (dist/)'), 'the session file and its rule are named')
  assert.ok(!result.text.includes('none of them differs'), 'and the change is never called a no-op')
  assert.equal(h.seen.prompts.length, 0, 'no reviewer call is spent on it')

  writeFileSync(join(repo, 'src', 'app.js'), 'export const a = 3\n')
  const own = harness({
    cwd: repo,
    hasEvent: false,
    diffs: [],
    toolCalls: [{ name: 'write', arguments: { file_path: join(root, 'src', 'app.js') } }],
    script: [record([], 'session file only')],
  })
  const second = await own.invoke('session')
  assert.equal(second.kind, 'success', second.text)
  const payload = payloadOf(second.text)
  assert.equal(payload.stats.reviewed, 1, 'the session file is reviewed')
  assert.equal(payload.stats.ignore.count, 0, "another file's exclusion is not reported as this run's")
}

// 69 — a home that has never held a settings file gets one, written by the plugin itself, and that file decides the run that created it.
{
  await withEmptyHome(async home => {
    const h = harness({ summary: SUMMARY, diffs: [TEXT_DIFF, BINARY_DIFF], git: false })
    const file = settingsPath(home)
    assert.ok(existsSync(file), 'the plugin creates the file a new machine never had')
    const created = JSON.parse(readFileSync(file, 'utf8'))
    const { modes, ...documented } = created
    assert.deepEqual(documented, DEFAULTS, 'the file holds exactly the settings this release declares')
    assert.deepEqual(Object.keys(documented), Object.keys(DEFAULTS), 'in the order it declares them')
    assert.deepEqual(
      Object.keys(created),
      [...Object.keys(DEFAULTS), 'modes'],
      'with the modes last, so the settings block a reader knows is unchanged',
    )
    assert.deepEqual(modes, BUILT_IN_MODES, 'and the modes this release ships, prompts and all')
    for (const [id, mode] of Object.entries(BUILT_IN_MODES)) {
      assert.deepEqual(Object.keys(modes[id]), Object.keys(mode), `the written entry of "${id}" carries every key the mode declares`)
    }
    assert.deepEqual(Object.keys(modes.cr.fields[0]), Object.keys(BUILT_IN_MODES.cr.fields[0]), 'and so does a field')
    assert.deepEqual(Object.keys(modes.cr.severities[0]), Object.keys(BUILT_IN_MODES.cr.severities[0]), 'and a severity')
    const payload = payloadOf((await h.invoke('')).text)
    assert.deepEqual(
      payload.reviewer,
      { provider: 'deepseek-official', model: 'deepseek-flash' },
      'empty provider/model reuse the agent route',
    )
    assert.equal(payload.mode.id, 'cr', 'the default mode is the code review')
    assert.equal(payload.mode.promptFrom, 'default', 'and its prompt is still the one this release ships')
    assert.deepEqual(
      payload.stats.skipped,
      [{ file: 'assets/logo.png', reason: 'binary' }],
      'the written defaults decided the run',
    )
  })
}

// 70 — a settings file removed while the harness is up is created again by the run that needs it.
{
  await withEmptyHome(async home => {
    const h = harness({ summary: SUMMARY, diffs: [TEXT_DIFF, BINARY_DIFF], git: false })
    const file = settingsPath(home)
    assert.ok(existsSync(file), 'the plugin load created it')
    unlinkSync(file)
    const payload = payloadOf((await h.invoke('')).text)
    assert.ok(existsSync(file), 'the run put it back')
    const created = JSON.parse(readFileSync(file, 'utf8'))
    const { modes, ...settings } = created
    assert.deepEqual(settings, DEFAULTS, 'with the defaults again')
    assert.deepEqual(modes, BUILT_IN_MODES, 'and the built-in modes')
    assert.equal(payload.stats.reviewed, 1, 'and the run itself succeeded')
  })
}

// 71 — a hand-written file is completed, never overwritten: the user's keys and order stand, and a second load writes no byte.
{
  await withEmptyHome(async home => {
    const file = settingsPath(home)
    mkdirSync(dirname(file), { recursive: true })
    const handwritten = `${JSON.stringify({ maxFiles: 1, keepMe: 'mine' }, null, 2)}\n`
    writeFileSync(file, handwritten)
    const h = harness({ summary: SUMMARY, diffs: [TEXT_DIFF, BINARY_DIFF], git: false })
    const payload = payloadOf((await h.invoke('')).text)
    assert.deepEqual(
      payload.stats.skipped,
      [{ file: 'assets/logo.png', reason: 'over-file-limit' }],
      'the hand-written value decided the run',
    )
    const completed = JSON.parse(readFileSync(file, 'utf8'))
    assert.equal(completed.maxFiles, 1, 'and it is still there after the sync')
    assert.equal(completed.keepMe, 'mine', 'a key of the user\'s own survives the sync')
    assert.deepEqual(Object.keys(completed).slice(0, 2), ['maxFiles', 'keepMe'], 'the file keeps its own order')
    assert.deepEqual(Object.keys(completed.modes), ['cr', 'arc'], 'and gains the modes it never had')
    const after = readFileSync(file, 'utf8')
    harness({ summary: SUMMARY, diffs: [TEXT_DIFF, BINARY_DIFF], git: false })
    assert.equal(readFileSync(file, 'utf8'), after, 'a file with nothing missing is not rewritten at all')
  })
}

// 72 — a file that does not parse is reported and left exactly as it is: the plugin never repairs a user's file behind their back.
{
  await withEmptyHome(async home => {
    const file = settingsPath(home)
    mkdirSync(dirname(file), { recursive: true })
    writeFileSync(file, '{ oops')
    const { value, warnings } = await captureWarnings(async () => {
      const h = harness({ summary: SUMMARY, diffs: [TEXT_DIFF, BINARY_DIFF], git: false })
      return payloadOf((await h.invoke('')).text)
    })
    assert.equal(readFileSync(file, 'utf8'), '{ oops', 'the broken file is untouched')
    assert.ok(warnings.some(line => line.includes('is not valid JSON')), warnings.join('\n'))
    assert.deepEqual(
      value.stats.skipped,
      [{ file: 'assets/logo.png', reason: 'binary' }],
      'the run fell back to the defaults',
    )
    assert.equal(value.mode.id, 'cr', 'and the default mode is still there')
  })
}

// 73 — a home the plugin cannot write to is a warning, never a failed review.
{
  const blocker = join(mkdtempSync(join(tmpdir(), 'dsh-code-review-blocked-')), 'not-a-directory')
  writeFileSync(blocker, 'a file where the directory of the settings file would go\n')
  await withDshHome(join(blocker, 'home'), async () => {
    const { value, warnings } = await captureWarnings(async () => {
      const h = harness({ summary: SUMMARY, diffs: [TEXT_DIFF, BINARY_DIFF], git: false })
      return payloadOf((await h.invoke('')).text)
    })
    assert.ok(warnings.some(line => line.includes('cannot create')), warnings.join('\n'))
    assert.deepEqual(
      value.stats.skipped,
      [{ file: 'assets/logo.png', reason: 'binary' }],
      'the defaults still reviewed the change set',
    )
  })
}

// 74 — mode=arc runs the architecture role: its persona, its vocabulary, its own word for the verdict, and the same contract no mode can change.
{
  const h = harness({
    summary: SUMMARY,
    diffs: [TEXT_DIFF, BINARY_DIFF],
    script: [record([ARC_FINDING], 'The reset belongs to the caller.')],
  })
  const result = await h.invoke('mode=arc')
  assert.equal(result.kind, 'success', result.text)
  const request = h.seen.prompts[0]
  assert.ok(request.system.includes('staff-level software architect'), 'the arc persona is sent')
  assert.ok(!request.system.includes('senior code reviewer'), 'and not the code review one')
  assert.ok(request.system.includes('## Evidence bar'), 'the contract rides along with every persona')
  assert.ok(request.system.includes('"consequence"'), 'the contract asks for the fields arc declares')
  assert.ok(request.system.includes('module-boundary'), 'and lists the categories it declared')
  const prompt = request.messages[0].content[0].text
  assert.ok(prompt.includes('- mode: Architecture review (arc)'), 'the change set names the mode')
  assert.ok(prompt.includes('## Mode task (Architecture review)'), 'and carries the mode task')
  assert.ok(prompt.includes('Judge the architecture of this change set'), 'which is arc\'s own assignment')

  const payload = payloadOf(result.text)
  assert.equal(payload.mode.id, 'arc')
  assert.equal(payload.mode.label, 'Architecture review')
  assert.equal(payload.mode.promptFrom, 'default', 'the arc prompt is still the one this release ships')
  assert.deepEqual(payload.mode.fields.map(field => field.key), ['problem', 'consequence', 'alternative', 'evidence'])
  assert.deepEqual(payload.mode.severities.map(severity => severity.id), ['high', 'medium', 'low'])
  assert.deepEqual(payload.mode.severities.map(severity => severity.tone), ['error', 'warn', 'muted'])
  assert.equal(payload.findings.length, 1, 'the architecture finding survives its own gate')
  assert.equal(payload.findings[0].consequence, ARC_FINDING.consequence)
  assert.equal(payload.findings[0].alternative, ARC_FINDING.alternative)
  assert.ok(result.text.includes('## Architecture review — decide before merge'), 'the report is headed by the mode')
  assert.ok(result.text.includes(`**Consequence:** ${ARC_FINDING.consequence}`), 'and labelled by it')
  assert.ok(result.text.includes(`**Alternative:** ${ARC_FINDING.alternative}`))
  assert.ok(result.text.includes('(high 1)'), 'the severity counts use the mode\'s names')
}

// 75 — the fields a mode requires are what the gate enforces: arc asks for the consequence and the alternative, not for a code review's impact.
{
  const h = harness({
    summary: SUMMARY,
    diffs: [TEXT_DIFF, BINARY_DIFF],
    script: [record([{ ...ARC_FINDING, alternative: '' }])],
  })
  const payload = payloadOf((await h.invoke('mode=arc')).text)
  assert.equal(payload.findings.length, 0)
  assert.ok(payload.withheld[0].reason.includes('"alternative"'), payload.withheld[0].reason)
  assert.ok(payload.withheld[0].reason.includes('Alternative'), payload.withheld[0].reason)
  assert.equal(payload.verdict, 'pass', 'a withheld finding never carries a verdict')

  const other = harness({
    summary: SUMMARY,
    diffs: [TEXT_DIFF, BINARY_DIFF],
    script: [
      { toolCalls: [toolCall('append_finding', { ...ARC_FINDING, consequence: '', impact: 'a real impact' })] },
      record([{ ...ARC_FINDING, consequence: '' }]),
    ],
  })
  const otherPayload = payloadOf((await other.invoke('mode=arc')).text)
  const refusal = messagesOf(other.seen.prompts[1], 'tool')[0]
  assert.equal(refusal.isError, true, 'a field the mode does not declare is refused')
  assert.ok(refusal.content[0].text.includes('"impact" is not a finding field'), refusal.content[0].text)
  assert.ok(refusal.content[0].text.includes('consequence'), 'and the refusal names what arc does accept')
  assert.equal(otherPayload.findings.length, 0)
  assert.ok(otherPayload.withheld[0].reason.includes('"consequence"'), otherPayload.withheld[0].reason)
}

// 76 — evidence is required in every mode, even one that leaves it out of its own field list.
{
  await withSettings({
    modes: {
      spell: {
        label: 'Spelling review',
        systemPrompt: 'You review spelling and nothing else.',
        fields: [{ key: 'correction', label: 'Correction' }],
        severities: [{ id: 'typo', label: 'typo', tone: 'muted', verdict: 'warn' }],
      },
    },
  }, async () => {
    const h = harness({
      summary: SUMMARY,
      diffs: [TEXT_DIFF, BINARY_DIFF],
      script: [record([{
        severity: 'typo', category: 'spelling', file: 'internal/chessx/board.go',
        title: 'Misspelled word', correction: 'boardu → board', evidence: '',
      }])],
    })
    const result = await h.invoke('mode=spell')
    const payload = payloadOf(result.text)
    assert.deepEqual(
      payload.mode.fields.map(field => field.key),
      ['correction', 'evidence'],
      'the declared field stands, and evidence is appended because it was left out',
    )
    assert.deepEqual(
      h.seen.prompts[0].tools.find(tool => tool.name === 'append_finding').parameters.required,
      ['severity', 'file', 'title', 'correction', 'evidence'],
      'the tool asks for the quote the mode could not leave out',
    )
    assert.equal(payload.findings.length, 0, 'a claim with no quote is not published')
    assert.equal(payload.withheld[0].reason, 'no evidence quoted')
    assert.ok(h.seen.prompts[0].system.includes('"evidence"'), 'and the contract asks for the quote')
  })
}

// 77 — a mode that does not exist is refused, with the modes that do, and no model call is spent finding out.
{
  const h = harness({ summary: SUMMARY, diffs: [TEXT_DIFF, BINARY_DIFF] })
  const result = await h.invoke('mode=nope')
  assert.equal(result.kind, 'error')
  assert.ok(result.text.includes('unknown mode "nope"'), result.text)
  assert.ok(result.text.includes('cr (Code review)'), 'the available modes are named')
  assert.ok(result.text.includes('arc (Architecture review)'))
  assert.equal(h.seen.prompts.length, 0, 'no reviewer call is made for a mode that does not resolve')
}

// 78 — a mode answers to its aliases, in any case.
{
  for (const typed of ['mode=architect', 'mode=architecture', 'mode=ARC', 'mode=Arc']) {
    const h = harness({ summary: SUMMARY, diffs: [TEXT_DIFF, BINARY_DIFF], script: [record([], 'ok')] })
    const payload = payloadOf((await h.invoke(typed)).text)
    assert.equal(payload.mode.id, 'arc', `${typed} resolves to arc`)
  }
  const aliased = harness({ summary: SUMMARY, diffs: [TEXT_DIFF, BINARY_DIFF], script: [record([], 'ok')] })
  assert.equal(payloadOf((await aliased.invoke('mode=codereview')).text).mode.id, 'cr', 'and cr has aliases too')
}

// 79 — a mode the user wrote: its prompt, its fields, its severities and its own settings, with no other focus area in the contract.
{
  await withSettings({
    modes: {
      misspell: {
        label: 'Spelling review',
        aliases: ['spell'],
        description: 'Reports misspellings in user-visible strings only.',
        systemPrompt: 'You review the spelling, grammar and copy of user-visible strings, and nothing else.',
        task: 'Report only misspellings. Do not report anything else you notice, however serious.',
        categories: ['spelling', 'copy'],
        fields: [
          { key: 'problem', label: '', required: true, block: false, guide: 'the wrong word and what it should be' },
          { key: 'correction', label: 'Correction', required: true, block: false, guide: 'the corrected text verbatim' },
        ],
        severities: [{ id: 'typo', label: 'typo', tone: 'muted', verdict: 'warn', meaning: 'a misspelled word in text a user reads' }],
        verdicts: { pass: 'clean', warn: 'typos', fail: 'readable but wrong' },
        settings: { language: 'tr', maxToolCalls: 7 },
      },
    },
  }, async () => {
    const h = harness({
      summary: SUMMARY,
      diffs: [TEXT_DIFF, BINARY_DIFF],
      script: [
        { toolCalls: [{ name: 'read_file', arguments: JSON.stringify({ path: READ_ONLY_FILE }) }] },
        record([{
          severity: 'typo', category: 'spelling', file: 'internal/chessx/board.go', line: 13,
          title: 'boardu yazılmış', problem: 'boardu bir sözcük değil', correction: 'boardu → board', evidence: '+new',
        }], 'Bir yazım hatası.'),
      ],
    })
    const result = await h.invoke('mode=spell')
    assert.equal(result.kind, 'success', result.text)
    const request = h.seen.prompts[0]
    assert.ok(request.system.startsWith('You review the spelling'), 'the mode persona leads the system prompt')
    assert.ok(request.system.includes('"correction"'), 'its field is in the contract')
    assert.ok(!request.system.includes('"impact"'), 'and no field it did not declare is')
    assert.ok(request.system.includes('a misspelled word in text a user reads'), 'its severity defines itself')
    assert.ok(request.system.includes('spelling, copy'), 'its categories are listed')
    const prompt = request.messages[0].content[0].text
    assert.ok(prompt.includes('## Mode task (Spelling review)'), 'the mode task is in the run prompt')
    assert.ok(prompt.includes('Do not report anything else'), 'including what not to report')
    assert.ok(prompt.includes('in "tr".'), 'the mode\'s own language setting decides the report language')
    const footer = messagesOf(h.seen.prompts[1], 'tool')[0].content[0].text
    assert.ok(footer.includes('1/7 calls'), 'and its own reader budget is in force')

    const payload = payloadOf(result.text)
    assert.equal(payload.mode.id, 'misspell', 'the alias resolved to the mode id')
    assert.equal(payload.mode.label, 'Spelling review')
    assert.equal(payload.mode.promptFrom, 'file')
    assert.deepEqual(payload.mode.severities.map(severity => severity.id), ['typo'], 'one severity, no room to inflate')
    assert.equal(payload.findings.length, 1)
    assert.equal(payload.findings[0].correction, 'boardu → board')
    assert.ok(result.text.includes('## Spelling review — typos'), 'the report uses the mode\'s verdict word')
    assert.ok(result.text.includes('(typo 1)'), 'and its severity label')
    assert.ok(!result.text.includes('**Impact:**'), 'a field the mode does not declare is not rendered')
  })
}

// 80 — what the file states wins over what this release ships, and the contract is appended to it either way.
{
  await withSettings({ modes: { cr: { systemPrompt: 'You are the hand-written reviewer.' } } }, async () => {
    const h = harness({ summary: SUMMARY, diffs: [TEXT_DIFF, BINARY_DIFF], script: [record([], 'ok')] })
    const result = await h.invoke('')
    const system = h.seen.prompts[0].system
    assert.ok(system.startsWith('You are the hand-written reviewer.'), 'the file\'s persona is the one sent')
    assert.ok(!system.includes('senior code reviewer'), 'the release persona is not sent as well')
    assert.ok(system.includes('## Evidence bar'), 'and the contract still follows it')
    const payload = payloadOf(result.text)
    assert.equal(payload.mode.promptFrom, 'file', 'the report says where the prompt came from')
    assert.ok(result.text.includes('prompt: config.json'), 'so a user can tell their edit is in force')
    assert.deepEqual(
      payload.mode.fields.map(field => field.key),
      ['problem', 'impact', 'trigger', 'suggestion', 'evidence'],
      'the keys the file left alone still come from the release',
    )
  })
}

// 81 — the file is completed, never rewritten: a release mode comes back whole and a mode of the user's own is left as it is.
{
  await withEmptyHome(async home => {
    const file = settingsPath(home)
    mkdirSync(dirname(file), { recursive: true })
    writeFileSync(file, `${JSON.stringify({ modes: { cr: { label: 'My review' }, mine: { label: 'Mine' } } }, null, 2)}\n`)
    const h = harness({ summary: SUMMARY, diffs: [TEXT_DIFF, BINARY_DIFF], git: false, script: [record([], 'ok')] })
    const payload = payloadOf((await h.invoke('')).text)
    assert.equal(payload.mode.label, 'My review', 'the label the file states wins')
    const doc = JSON.parse(readFileSync(file, 'utf8'))
    assert.ok(doc.modes.cr.systemPrompt.includes('senior code reviewer'), 'a deleted key comes back with its default')
    assert.equal(doc.mode, 'cr', 'a setting the file never had is added')
    assert.equal(doc.provider, '', 'with the release default')
    assert.deepEqual(Object.keys(doc.modes.mine), ['label'], 'a mode of the user\'s own is never extended')
    assert.equal(doc.modes.arc.settings.maxToolCalls, 60, 'the architecture preset is in the file, where it can be changed')
    const after = readFileSync(file, 'utf8')
    const again = harness({ summary: SUMMARY, diffs: [TEXT_DIFF, BINARY_DIFF], git: false, script: [record([], 'ok')] })
    await again.invoke('')
    assert.equal(readFileSync(file, 'utf8'), after, 'a file with nothing missing is not written to at all')
  })
}

// 82 — a disabled mode is not offered, and a disabled default falls back loudly rather than leaving /review unusable.
{
  await withSettings({ modes: { arc: { enabled: false } } }, async () => {
    const refused = harness({ summary: SUMMARY, diffs: [TEXT_DIFF, BINARY_DIFF] })
    const result = await refused.invoke('mode=arc')
    assert.equal(result.kind, 'error')
    assert.ok(result.text.includes('mode "arc" is disabled'), result.text)
    assert.ok(!result.text.includes('arc (Architecture review)'), 'a disabled mode is not listed as available')
    assert.equal(refused.seen.prompts.length, 0, 'and no reviewer call is made')
  })

  const { value, warnings } = await withSettings({ mode: 'arc', modes: { arc: { enabled: false } } }, async () => {
    return captureWarnings(async () => {
      const h = harness({ summary: SUMMARY, diffs: [TEXT_DIFF, BINARY_DIFF], script: [record([], 'ok')] })
      return payloadOf((await h.invoke('')).text)
    })
  })
  assert.equal(value.mode.id, 'cr', 'a bare /review still runs the default mode')
  assert.ok(warnings.some(line => line.includes('is disabled')), warnings.join('\n'))

  await withSettings({ modes: { cr: { enabled: false }, arc: { enabled: false } } }, async () => {
    const h = harness({ summary: SUMMARY, diffs: [TEXT_DIFF, BINARY_DIFF] })
    const result = await h.invoke('')
    assert.equal(result.kind, 'error')
    assert.ok(result.text.includes('no mode is enabled'), result.text)
    assert.equal(h.seen.prompts.length, 0)
  })
}

// 83 — a mode's settings are a preset: they win over the file's own, and what is typed after /review wins over both.
{
  await withSettings({
    language: 'en',
    maxToolCalls: 4,
    modes: { cr: { settings: { language: 'tr' } } },
  }, async () => {
    const h = harness({
      summary: SUMMARY,
      diffs: [TEXT_DIFF, BINARY_DIFF],
      script: [
        { toolCalls: [{ name: 'read_file', arguments: JSON.stringify({ path: READ_ONLY_FILE }) }] },
        record([], 'ok'),
      ],
    })
    await h.invoke('')
    const prompt = h.seen.prompts[0].messages[0].content[0].text
    assert.ok(prompt.includes('in "tr".'), 'the mode\'s setting beats the file\'s')
    const footer = messagesOf(h.seen.prompts[1], 'tool')[0].content[0].text
    assert.ok(footer.includes('1/4 calls'), 'and a setting the mode does not preset is the file\'s')

    const typed = harness({ summary: SUMMARY, diffs: [TEXT_DIFF, BINARY_DIFF], script: [record([], 'ok')] })
    await typed.invoke('language=en')
    assert.ok(
      typed.seen.prompts[0].messages[0].content[0].text.includes('in "en".'),
      'and the command line beats them both',
    )
  })
}

// 84 — a mode written wrong is reported and run with what is usable: junk keys, reserved field names and forbidden settings are named, never obeyed.
{
  await withSettings({
    modes: {
      junk: {
        label: 42,
        aliases: 'junkish',
        enabled: 'yes',
        fields: [{ key: 'file' }, { key: 'problem', label: 'Problem' }, 'nope', {}, { key: 'problem' }],
        severities: [{ id: 'weird', verdict: 'whatever', tone: 'rainbow' }, { id: '' }],
        verdicts: 'nope',
        settings: { notASetting: 1, mode: 'arc', ignored: ['vendor/'] },
      },
    },
  }, async () => {
    const { value, warnings } = await captureWarnings(async () => {
      const h = harness({
        summary: SUMMARY,
        diffs: [TEXT_DIFF, BINARY_DIFF],
        script: [record([{
          severity: 'weird', category: 'general', file: 'internal/chessx/board.go',
          title: 'T', problem: 'p', evidence: '+new',
        }])],
      })
      return { payload: payloadOf((await h.invoke('mode=junkish')).text), system: h.seen.prompts[0].system }
    })
    assert.equal(value.payload.mode.id, 'junk')
    assert.equal(value.payload.mode.label, 'junk', 'a label that is not a string falls back to the id')
    assert.deepEqual(
      value.payload.mode.fields.map(field => field.key),
      ['problem', 'evidence'],
      'a reserved key, a duplicate and the junk entries are dropped',
    )
    assert.deepEqual(value.payload.mode.severities, [{ id: 'weird', label: 'weird', tone: 'warn' }], 'unknown values fall back safely')
    assert.equal(value.payload.findings.length, 1, 'and the run still produces a checked finding')
    assert.ok(value.system.includes('"problem"'), 'the contract lists what survived')
    assert.ok(warnings.some(line => line.includes('part of the finding structure')), warnings.join('\n'))
    assert.ok(warnings.some(line => line.includes('is not a setting this plugin reads')), warnings.join('\n'))
    assert.ok(warnings.some(line => line.includes('cannot be set by a mode')), warnings.join('\n'))
    assert.ok(warnings.some(line => line.includes('declared twice')), warnings.join('\n'))
    assert.ok(warnings.some(line => line.includes('verdict "whatever"')), warnings.join('\n'))
    assert.ok(warnings.some(line => line.includes('tone "rainbow"')), warnings.join('\n'))
  })
}

// 85 — the card draws whatever mode the payload describes, and still cannot send anything.
{
  const h = harness({
    summary: SUMMARY,
    diffs: [TEXT_DIFF, BINARY_DIFF],
    script: [record([ARC_FINDING], 'The reset belongs to the caller.')],
  })
  const result = await h.invoke('mode=arc')
  const card = await renderCard({ kind: 'success', text: result.text })
  assert.ok(card.texts.includes('Architecture review'), 'the card is titled by the mode')
  assert.ok(card.texts.includes('decide before merge'), 'the chip is the mode\'s word for the verdict')
  assert.ok(card.texts.includes('high'), 'the severity chip is the mode\'s severity')
  assert.ok(card.texts.includes(`Consequence: ${ARC_FINDING.consequence}`), 'its fields are labelled by it')
  assert.ok(card.texts.includes(`Alternative: ${ARC_FINDING.alternative}`))
  assert.ok(card.texts.includes('Evidence'), 'and the evidence is quoted')
  assert.ok(!card.texts.includes('Impact'), 'a field arc does not declare is not drawn')
  assert.deepEqual(
    card.buttons,
    ['action.copyReport', 'toggle.hide', 'action.copyFinding'],
    'a mode changes what the card says, never what it can do',
  )

  const cr = harness({ summary: SUMMARY, diffs: [TEXT_DIFF, BINARY_DIFF], script: [record([PROVEN], 'Nil board.')] })
  const crText = (await cr.invoke('')).text
  const crCard = await renderCard({ kind: 'success', text: crText })
  assert.ok(crCard.texts.includes('Code review'), 'the default mode titles its card from the payload')
  assert.ok(crCard.texts.includes('blocker'), 'with the severity the mode named')
  assert.ok(crCard.texts.includes('Guard the nil board'), 'and the finding it produced')
  assert.ok(crCard.texts.includes('Fix: return early'), 'and its own field labels')
  const api = await loadClientApi()
  const crPayload = api.__test.parsePayload(crText)
  const pasted = api.__test.findingText(crPayload.findings[0], 0, api.__test.modeOf(crPayload))
  assert.ok(pasted.includes(`**How it is reached:** ${PROVEN.trigger}`), 'and the copy carries every field it declared')
  assert.ok(pasted.includes(`**Impact:** ${PROVEN.impact}`), 'in the mode\'s own order and wording')
}

// 86 — the file decides which mode a bare /review runs, and the command line still overrides it.
{
  await withSettings({ mode: 'arc' }, async () => {
    const bare = harness({ summary: SUMMARY, diffs: [TEXT_DIFF, BINARY_DIFF], script: [record([], 'ok')] })
    assert.equal(payloadOf((await bare.invoke('')).text).mode.id, 'arc', 'the configured mode runs')
    const typed = harness({ summary: SUMMARY, diffs: [TEXT_DIFF, BINARY_DIFF], script: [record([], 'ok')] })
    assert.equal(payloadOf((await typed.invoke('mode=cr')).text).mode.id, 'cr', 'and a typed mode wins')
  })
}

// 87 — a mode with no persona is still a working mode: the contract alone is the system prompt.
{
  await withSettings({ modes: { bare: { systemPrompt: '', task: '', fields: [] } } }, async () => {
    const h = harness({ summary: SUMMARY, diffs: [TEXT_DIFF, BINARY_DIFF], script: [record([], 'ok')] })
    const result = await h.invoke('mode=bare')
    const system = h.seen.prompts[0].system
    assert.ok(system.startsWith('## Reading the project'), 'the contract is the whole system prompt')
    assert.ok(system.includes('## Evidence bar'), 'with the gate in it')
    assert.ok(system.includes('"evidence"'), 'and the quote the gate checks')
    assert.ok(!system.includes('senior code reviewer'), 'and no other mode\'s persona')
    const payload = payloadOf(result.text)
    assert.deepEqual(
      payload.mode.fields.map(field => field.key),
      ['problem', 'evidence'],
      'a mode that declares no field gets the minimum every mode states',
    )
    assert.equal(payload.mode.promptFrom, 'file')
  })
}

// 88 — a severity the mode does not declare is refused by name, never lowered or substituted, and the verdict follows the mode's table whatever order it is written in.
{
  await withSettings({
    modes: {
      upside: {
        label: 'Upside down',
        systemPrompt: 'You review one change set.',
        fields: [{ key: 'problem', label: '' }, { key: 'evidence', label: 'Evidence', block: true }],
        severities: [
          { id: 'low', label: 'low', tone: 'muted', verdict: 'pass' },
          { id: 'high', label: 'high', tone: 'error', verdict: 'fail' },
        ],
      },
    },
  }, async () => {
    const h = harness({
      summary: SUMMARY,
      diffs: [TEXT_DIFF, BINARY_DIFF],
      script: [
        {
          toolCalls: [toolCall('append_finding', {
            severity: 'catastrophic', category: 'general', file: 'internal/chessx/board.go',
            title: 'Nothing declares this', problem: 'p', evidence: '+new',
          })],
        },
        record([{
          severity: 'high', category: 'general', file: 'internal/chessx/board.go',
          title: 'Nothing declares this', problem: 'p', evidence: '+new',
        }]),
      ],
    })
    const payload = payloadOf((await h.invoke('mode=upside')).text)
    const refusal = messagesOf(h.seen.prompts[1], 'tool')[0]
    assert.equal(refusal.isError, true, 'an undeclared severity is refused, not lowered')
    assert.ok(refusal.content[0].text.includes('"catastrophic" is not a severity of mode "upside"'), refusal.content[0].text)
    assert.ok(refusal.content[0].text.includes('low, high'), 'and the refusal names the table it does declare')
    assert.deepEqual(
      h.seen.prompts[0].tools.find(tool => tool.name === 'append_finding').parameters.properties.severity.enum,
      ['low', 'high'],
      'the table is the tool’s enum, in the order the file wrote it',
    )
    assert.equal(payload.findings.length, 1, 'the corrected call is gated on its own merits')
    assert.equal(payload.findings[0].severity, 'high', 'and the severity the mode declares is the one recorded')
    assert.equal(payload.verdict, 'fail', 'the verdict follows the table, not the position the entry is listed in')
    assert.equal(messagesOf(h.seen.prompts[1], 'tool').filter(message => message.isError === true).length, 1, 'the refused call changed nothing')
  })

  const h = harness({
    summary: SUMMARY,
    diffs: [TEXT_DIFF, BINARY_DIFF],
    script: [
      { toolCalls: [toolCall('append_finding', { ...PROVEN, severity: 'severe' })] },
      record([{ ...PROVEN, severity: 'nit' }]),
    ],
  })
  const payload = payloadOf((await h.invoke('')).text)
  const refusal = messagesOf(h.seen.prompts[1], 'tool')[0]
  assert.ok(refusal.content[0].text.includes('"severe" is not a severity of mode "cr"'), refusal.content[0].text)
  assert.ok(refusal.content[0].text.includes('blocker, major, minor, nit'), 'the cr table is named in full')
  assert.equal(payload.findings[0].severity, 'nit', 'the call the reviewer fixed is the one that lands')
  assert.equal(payload.verdict, 'warn', 'and a nit is a warning, never a failure')
}

// 89 — the thinking level comes from the config file and the mode preset, the command line overrides both, and a level the model does not offer costs no call.
{
  await withEmptyHome(async home => {
    const h = harness({ summary: SUMMARY, diffs: [TEXT_DIFF, BINARY_DIFF] })
    const created = JSON.parse(readFileSync(settingsPath(home), 'utf8'))
    assert.equal(created.reasoningEffort, '', 'the created config carries the key')
    const text = (await h.invoke('')).text
    assert.equal(h.seen.prompts[0].reasoningEffort, undefined, 'an empty setting sends no level')
    assert.equal(payloadOf(text).reviewer.reasoningEffort, undefined, 'and the payload claims none')
    assert.ok(!text.includes('thinking:'), 'nor does the report name a level nobody chose')
  })

  await withSettings({
    reasoningEffort: 'low',
    modes: { cr: { settings: { reasoningEffort: 'max' } } },
  }, async () => {
    const h = harness({ summary: SUMMARY, diffs: [TEXT_DIFF, BINARY_DIFF] })
    const text = (await h.invoke('')).text
    assert.equal(h.seen.prompts[0].reasoningEffort, 'max', "the mode's preset beats the file's value")
    assert.equal(payloadOf(text).reviewer.reasoningEffort, 'max', 'and reaches the payload the card draws')
    assert.ok(text.includes('thinking: max'), 'and the report the user copies')

    const typed = harness({ summary: SUMMARY, diffs: [TEXT_DIFF, BINARY_DIFF] })
    await typed.invoke('reasoningEffort=off')
    assert.equal(typed.seen.prompts[0].reasoningEffort, 'off', 'and what is typed beats them both')
  })

  await withSettings({
    reasoningEffort: 'low',
    modes: { cr: { settings: { reasoningEffort: '' } } },
  }, async () => {
    const h = harness({ summary: SUMMARY, diffs: [TEXT_DIFF, BINARY_DIFF] })
    await h.invoke('')
    assert.equal(h.seen.prompts[0].reasoningEffort, 'low', 'an empty preset leaves the file in force')
  })

  await withSettings({ reasoningEffort: 'ultra' }, async () => {
    const offered = harness({
      summary: SUMMARY,
      diffs: [TEXT_DIFF, BINARY_DIFF],
      modelInfo: { reasoning: { efforts: [{ id: 'off', name: 'Off' }, { id: 'high', name: 'High' }] } },
    })
    const refused = await offered.invoke('')
    assert.equal(refused.kind, 'error', refused.text)
    assert.ok(refused.text.includes('off, high'), 'the levels it does offer are named')
    assert.ok(refused.text.includes('deepseek-official/deepseek-flash'), 'and the route the refusal is about')
    assert.equal(offered.seen.prompts.length, 0, 'and nothing is spent on a call that cannot work')

    const bare = harness({ summary: SUMMARY, diffs: [TEXT_DIFF, BINARY_DIFF], modelInfo: {} })
    const bareResult = await bare.invoke('')
    assert.equal(bareResult.kind, 'error', 'a model with no reasoning levels at all is refused too')
    assert.ok(bareResult.text.includes('declares no reasoning levels'), bareResult.text)
    assert.equal(bare.seen.prompts.length, 0)

    const unknown = harness({
      summary: SUMMARY,
      diffs: [TEXT_DIFF, BINARY_DIFF],
      modelInfoThrows: true,
    })
    const result = await unknown.invoke('')
    assert.equal(result.kind, 'success', result.text)
    assert.equal(unknown.seen.prompts[0].reasoningEffort, 'ultra', 'an undescribable route is not second-guessed')
  })
}

// 90 — the six review tools are the protocol: the same names in the same order under every setting, mode and command line.
{
  await withSettings({}, async () => {
    for (const [what, args] of [['a bare run', ''], ['an alias', 'mode=codereview']]) {
      const h = harness({ summary: SUMMARY, diffs: [TEXT_DIFF, BINARY_DIFF] })
      await h.invoke(args)
      assert.deepEqual(
        h.seen.prompts[0].tools.map(tool => tool.name),
        [...REVIEW_TOOL_NAMES, ...READER_TOOL_NAMES],
        `every tool is offered: ${what}`,
      )
      assert.equal(assertOneReading(h.seen.prompts[0], what), true, 'and the contract of the run claims them')
    }
  })

  await withSettings({ projectAccess: false, maxToolCalls: 1, timeoutMs: 1000, toolDeadlineRatio: 0.0000001 }, async () => {
    const h = harness({ summary: SUMMARY, diffs: [TEXT_DIFF, BINARY_DIFF] })
    await h.invoke('')
    assert.deepEqual(
      h.seen.prompts[0].tools.map(tool => tool.name),
      REVIEW_TOOL_NAMES,
      'the review tools survive every setting that narrows the reader',
    )
    assert.equal(assertOneReading(h.seen.prompts[0], 'every reader bound is closed'), false, 'and the contract claims no reading')
  })

  await withSettings({
    modes: { cr: { settings: { tools: [], append_finding: false, reviewTools: ['nothing'], finish_review: 'off' } } },
  }, async () => {
    const { value: payload, warnings } = await captureWarnings(async () => {
      const h = harness({
        summary: SUMMARY,
        diffs: [TEXT_DIFF, BINARY_DIFF],
        script: [record([PROVEN], 'nothing was switched off')],
      })
      return { payload: payloadOf((await h.invoke('')).text), prompts: h.seen.prompts }
    })
    assert.deepEqual(
      payload.prompts[0].tools.map(tool => tool.name),
      [...REVIEW_TOOL_NAMES, ...READER_TOOL_NAMES],
      'the tools a mode tried to configure are still the ones offered',
    )
    assert.equal(payload.payload.findings.length, 1, 'and the review is recorded as usual')
    const ignored = warnings.filter(line => line.includes('is not a setting this plugin reads'))
    assert.equal(ignored.length, 4, `every tool-setting key is reported and ignored: ${warnings.join(' | ')}`)
  })
}

// 91 — a call the store cannot use is refused with everything that was wrong with it, changes nothing, and the run carries on.
{
  const h = harness({
    summary: SUMMARY,
    diffs: [TEXT_DIFF, BINARY_DIFF],
    script: [
      { toolCalls: [toolCall('append_finding', PROVEN)] },
      {
        toolCalls: [
          { name: 'append_finding', arguments: '{"severity":' },
          { name: 'append_finding', arguments: '["blocker"]' },
          toolCall('append_finding', { ...PROVEN, impactt: 'a typo of the field name' }),
          toolCall('append_finding', { ...PROVEN, line: '13' }),
          toolCall('update_finding', { title: 'no id' }),
          toolCall('update_finding', { id: 'f9', title: 'gone' }),
          toolCall('update_finding', { id: 'f1' }),
          toolCall('delete_finding', { id: 'f9' }),
          toolCall('list_findings', { limit: 5 }),
          toolCall('set_summary', { summary: '   ' }),
          toolCall('finish_review', { summary: 'wrong tool for this' }),
        ],
      },
      { toolCalls: [toolCall('finish_review', {})] },
    ],
  })
  const result = await h.invoke('')
  assert.equal(result.kind, 'success', result.text)
  const tool = messagesOf(h.seen.prompts[2], 'tool')
  assert.equal(tool.length, 12, 'the recorded finding and every refused call got exactly one result')
  const refused = tool.slice(1)
  assert.deepEqual(refused.map(message => message.isError), Array.from({ length: 11 }, () => true), 'all eleven are refusals')
  const expected = [
    'cannot parse arguments for append_finding',
    'must be a JSON object',
    '"impactt" is not a finding field',
    '"line" must be a whole line number',
    'needs the "id"',
    'no finding "f9"',
    'at least one field to change',
    'no finding "f9"',
    'takes no arguments',
    'non-empty "summary"',
    'takes no arguments',
  ]
  refused.forEach((message, index) => {
    assert.ok(message.content[0].text.includes(expected[index]), `refusal ${index}: ${message.content[0].text}`)
  })
  assert.ok(refused[2].content[0].text.includes('problem, impact, trigger'), 'an unknown key answers with the keys that exist')
  assert.ok(refused[5].content[0].text.includes('recorded: f1 (Guard the nil board)'), 'an unknown id answers with the ids that exist')
  assert.ok(refused[10].content[0].text.includes('set_summary'), 'and the finish refusal says where the summary belongs')
  const payload = payloadOf(result.text)
  assert.equal(payload.findings.length, 1, 'nothing the refusals carried reached the store')
  assert.equal(payload.findings[0].title, 'Guard the nil board')
  assert.deepEqual(payload.stats.store, { calls: 11, appended: 1, updated: 0, deleted: 0 }, 'the refused calls that reached the store are counted, and changed nothing')
}

// 92 — the evidence corpus only grows: a finding recorded before the file behind it was read is published once the read has happened.
{
  const h = harness({
    summary: SUMMARY,
    diffs: [TEXT_DIFF, BINARY_DIFF],
    script: [
      {
        toolCalls: [toolCall('append_finding', {
          severity: 'major', category: 'correctness', file: READ_ONLY_FILE, line: 4,
          title: 'Reset from the caller', problem: 'the caller resets a board it just built',
          impact: 'Every game started through this path begins from an empty position.',
          trigger: 'Any caller of Apply reaches Reset first, so the first move is rejected.',
          suggestion: 'do not reset here', evidence: READ_ONLY_LINE,
        })],
      },
      { toolCalls: [toolCall('read_file', { path: READ_ONLY_FILE })] },
      record([], 'read after recording'),
    ],
  })
  const result = await h.invoke('')
  const recorded = messagesOf(h.seen.prompts[1], 'tool')[0]
  assert.equal(recorded.isError, undefined, 'a finding the gate cannot publish is still recorded')
  assert.ok(recorded.content[0].text.includes('recorded, withheld:'), recorded.content[0].text)
  assert.ok(recorded.content[0].text.includes('not one the reviewer could see'), recorded.content[0].text)
  assert.ok(recorded.content[0].text.includes('update_finding on f1'), 'and the reviewer is told how to fix it')
  const payload = payloadOf(result.text)
  assert.equal(payload.findings.length, 1, 'the read that followed made it provable')
  assert.deepEqual(payload.withheld, [])
  assert.equal(payload.stats.store.appended, 1)
}

// 93 — update and delete are how a finding a later look invalidated leaves the review: the id addresses it and the order never moves.
{
  const second = { ...PROVEN, severity: 'minor', title: 'A second finding', evidence: '+extra' }
  const h = harness({
    summary: SUMMARY,
    diffs: [TEXT_DIFF, BINARY_DIFF],
    script: [
      { toolCalls: [toolCall('append_finding', PROVEN), toolCall('append_finding', second)] },
      {
        toolCalls: [
          toolCall('update_finding', { id: 'f1', severity: 'nit', title: 'Guard the board' }),
          toolCall('delete_finding', { id: 'f2' }),
          toolCall('list_findings', {}),
        ],
      },
      record([], 'one finding left'),
    ],
  })
  const result = await h.invoke('')
  const tool = messagesOf(h.seen.prompts[2], 'tool')
  assert.equal(tool.length, 5, 'two records, then the update, the delete and the listing, each with a result')
  assert.ok(tool[2].content[0].text.includes('f1 [nit]'), tool[2].content[0].text)
  assert.ok(tool[2].content[0].text.includes('updated (severity, title)'), tool[2].content[0].text)
  assert.ok(tool[3].content[0].text.includes('f2 [minor]'), tool[3].content[0].text)
  assert.ok(tool[3].content[0].text.includes('deleted'), tool[3].content[0].text)
  const listed = tool[4].content[0].text
  assert.ok(listed.includes('f1 [nit] internal/chessx/board.go:13 — Guard the board · provable'), listed)
  assert.ok(!listed.includes('f2'), 'the deleted finding is gone from the listing')
  assert.ok(listed.includes('[finding store: 1 of 100 recorded'), listed)
  const payload = payloadOf(result.text)
  assert.equal(payload.findings.length, 1, 'the report holds what the store holds')
  assert.equal(payload.findings[0].title, 'Guard the board')
  assert.equal(payload.findings[0].severity, 'nit')
  assert.equal(payload.verdict, 'warn', 'and the corrected severity is what the verdict follows')
  assert.deepEqual(payload.stats.store, { calls: 7, appended: 2, updated: 1, deleted: 1 })
}

// 94 — a run the stream cut off keeps every finding already recorded and hands them over as a partial report that says so.
{
  await withSettings({ notifyAgent: 'steer' }, async () => {
    const h = harness({
      summary: SUMMARY,
      diffs: [TEXT_DIFF, BINARY_DIFF],
      failAtCall: 3,
      failWith: 'socket hang up',
      script: [
        { toolCalls: [toolCall('append_finding', PROVEN), toolCall('set_summary', { summary: 'Two findings so far.' })] },
        { toolCalls: [toolCall('append_finding', { ...PROVEN, severity: 'minor', title: 'Second', evidence: '+extra' })] },
      ],
    })
    const result = await h.invoke('')
    assert.equal(result.kind, 'success', result.text)
    assert.equal(h.seen.prompts.length, 3, 'the run stopped where the stream did, and did not retry on top of a recorded finding')
    const payload = payloadOf(result.text)
    assert.equal(payload.findings.length, 2, 'both findings recorded before the failure survived it')
    assert.ok(payload.incomplete.includes('socket hang up'), payload.incomplete)
    assert.ok(result.text.includes('- incomplete: the reviewer call failed'), 'the report leads with what happened')
    assert.ok(result.text.includes('Two findings so far.'), 'and keeps the summary that was recorded')
    assert.equal(payload.verdict, 'fail', 'the verdict is still computed from what survived')
    const notice = h.seen.steer[0].content[0].text
    assert.ok(notice.includes('this review is incomplete'), notice)
    assert.ok(notice.includes('socket hang up'), notice)
    assert.ok(h.seen.steer[0].source.summary.includes('incomplete'), 'and the inbox line says so too')
  })
}

// 95 — a failure that leaves nothing recorded is an error, and a run gets one retry, never a second one on top of a stored finding.
{
  const h = harness({
    summary: SUMMARY,
    diffs: [TEXT_DIFF, BINARY_DIFF],
    failAtCall: [1, 2],
    failWith: 'provider unreachable',
    script: [record([PROVEN], 'never reached')],
  })
  const result = await h.invoke('')
  assert.equal(result.kind, 'error', result.text)
  assert.ok(result.text.includes('recorded no finding'), result.text)
  assert.ok(result.text.includes('provider unreachable'), result.text)
  assert.ok(result.text.includes('can call tools'), 'and points at what the review needs from a route')
  assert.equal(h.seen.prompts.length, 2, 'the failed call and one retry, nothing more')
}

// 95b — a stream that breaks after a fruitless turn is an error too: there is no conclusion and no partial report to make.
{
  const h = harness({
    summary: SUMMARY,
    diffs: [TEXT_DIFF, BINARY_DIFF],
    failAtCall: 2,
    failWith: 'socket closed',
    script: [{ toolCalls: [toolCall('list_findings', {})] }],
  })
  const result = await h.invoke('')
  assert.equal(result.kind, 'error', result.text)
  assert.ok(result.text.includes('socket closed'), result.text)
}

// 96 — a model that stops without finishing is asked to finish, and when it will not, the report is built from the store and marked incomplete.
{
  const h = harness({
    summary: SUMMARY,
    diffs: [TEXT_DIFF, BINARY_DIFF],
    script: [
      { toolCalls: [toolCall('append_finding', PROVEN), toolCall('set_summary', { summary: 'partly done' })] },
      { text: 'I think that is everything.' },
    ],
  })
  const result = await h.invoke('')
  assert.equal(result.kind, 'success', result.text)
  assert.equal(h.seen.prompts.length, 4, 'the recording turn, then two nudges before the run gives up')
  const nudges = messagesOf(h.seen.prompts[3], 'user').filter(message => message.content[0].text.includes('not finished'))
  assert.equal(nudges.length, 2, 'the model is asked to finish every time it stops')
  const payload = payloadOf(result.text)
  assert.equal(payload.findings.length, 1)
  assert.equal(payload.incomplete, 'the reviewer stopped without calling finish_review')
  assert.ok(result.text.includes('- incomplete: the reviewer stopped without calling finish_review'), result.text)
}

// 97 — a cancelled run keeps what it recorded and says it was cancelled; a cancel before anything was recorded still refuses.
{
  const cancelled = harness({
    summary: SUMMARY,
    diffs: [TEXT_DIFF, BINARY_DIFF],
    abortAtCall: 2,
    script: [{ toolCalls: [toolCall('append_finding', PROVEN)] }],
  })
  const result = await cancelled.invoke('')
  assert.equal(result.kind, 'success', result.text)
  const payload = payloadOf(result.text)
  assert.equal(payload.findings.length, 1, 'the finding recorded before the cancel survived')
  assert.equal(payload.incomplete, 'the review was cancelled')

  const empty = harness({
    summary: SUMMARY,
    diffs: [TEXT_DIFF, BINARY_DIFF],
    abortAtCall: 1,
    script: [record([PROVEN], 'never reached')],
  })
  const refused = await empty.invoke('')
  assert.equal(refused.kind, 'error', refused.text)
  assert.ok(refused.text.includes('review cancelled'), refused.text)
}

// 98 — the loop always ends: a model that keeps calling tools without finishing meets the run's own turn limit.
{
  const h = harness({
    summary: SUMMARY,
    diffs: [TEXT_DIFF, BINARY_DIFF],
    script: [
      { toolCalls: [toolCall('append_finding', PROVEN)] },
      { toolCalls: [toolCall('list_findings', {})] },
    ],
  })
  const result = await h.invoke('')
  assert.equal(result.kind, 'success', result.text)
  assert.equal(h.seen.prompts.length, 150, 'the run stops at its own turn limit')
  const payload = payloadOf(result.text)
  assert.equal(payload.findings.length, 1, 'the finding recorded on the way is still the review')
  assert.ok(payload.incomplete.includes("kept working past this run's 150 model turns"), payload.incomplete)
  assert.equal(payload.stats.store.calls, 150, 'one call per turn, every one of them answered')
}

// 99 — the store has a ceiling, and reaching it changes nothing already recorded.
{
  const appends = Array.from({ length: 101 }, (_, index) => toolCall('append_finding', {
    ...PROVEN, title: `Finding ${index + 1}`,
  }))
  const h = harness({
    summary: SUMMARY,
    diffs: [TEXT_DIFF, BINARY_DIFF],
    script: [
      { toolCalls: appends },
      { toolCalls: [toolCall('finish_review', {})] },
    ],
  })
  const result = await h.invoke('')
  assert.equal(result.kind, 'success', result.text)
  const refusals = messagesOf(h.seen.prompts[1], 'tool').filter(message => message.isError === true)
  assert.equal(refusals.length, 1, 'only the call over the ceiling is refused')
  assert.ok(refusals[0].content[0].text.includes('already holds 100 findings, the maximum'), refusals[0].content[0].text)
  assert.ok(refusals[0].content[0].text.includes('delete_finding'), 'and it says how to make room')
  const payload = payloadOf(result.text)
  assert.equal(payload.findings.length, 100, 'the store holds its hundred')
  assert.equal(payload.findings[0].title, 'Finding 1')
  assert.equal(payload.findings.at(-1).title, 'Finding 100')
}

// 99b — the finding-tool call cap closes the store without closing the review: the calls that inspect, describe and end it still work, and the report names the cap.
{
  const lists = Array.from({ length: 300 }, () => toolCall('list_findings', {}))
  const h = harness({
    summary: SUMMARY,
    diffs: [TEXT_DIFF, BINARY_DIFF],
    script: [
      { toolCalls: [toolCall('append_finding', PROVEN), ...lists] },
      {
        toolCalls: [
          toolCall('append_finding', { ...PROVEN, title: 'Too late' }),
          toolCall('update_finding', { id: 'f1', severity: 'nit' }),
          toolCall('list_findings', {}),
          toolCall('set_summary', { summary: 'one finding, then the cap' }),
        ],
      },
      { toolCalls: [toolCall('finish_review', {})] },
    ],
  })
  const result = await h.invoke('')
  assert.equal(result.kind, 'success', result.text)
  assert.equal(h.seen.prompts.length, 3, 'the run closed on the reviewer’s own terms')
  const over = messagesOf(h.seen.prompts[2], 'tool').slice(301)
  assert.equal(over.length, 4, 'the calls past the cap each got one result')
  assert.deepEqual(over.slice(0, 2).map(message => message.isError), [true, true], 'a change to the review is refused')
  assert.ok(over[0].content[0].text.includes('300 finding-tool calls'), over[0].content[0].text)
  assert.ok(over[0].content[0].text.includes('list_findings'), 'and the refusal points at the calls that still work')
  assert.equal(over[2].isError, undefined, 'listing what is recorded still works')
  assert.ok(over[2].content[0].text.includes('f1 [blocker]'), over[2].content[0].text)
  assert.equal(over[3].isError, undefined, 'and so does recording the summary')
  assert.ok(over[3].content[0].text.includes('summary recorded'), over[3].content[0].text)
  const payload = payloadOf(result.text)
  assert.equal(payload.findings.length, 1, 'what was recorded before the cap is the review')
  assert.equal(payload.summary, 'one finding, then the cap', 'the summary recorded past the cap opens the report')
  assert.equal(payload.incomplete, 'the reviewer used its 300 finding-tool calls before it closed the review')
  assert.ok(result.text.includes('- incomplete: the reviewer used its 300 finding-tool calls'), result.text)
}

// 99c — a capped run that never finishes still names the cap, and a capped run that recorded nothing is an error that does not blame the route.
{
  const lists = Array.from({ length: 300 }, () => toolCall('list_findings', {}))
  const h = harness({
    summary: SUMMARY,
    diffs: [TEXT_DIFF, BINARY_DIFF],
    script: [
      { toolCalls: [toolCall('append_finding', PROVEN), ...lists] },
      { toolCalls: [toolCall('append_finding', { ...PROVEN, title: 'Too late' })] },
      { text: 'that is all' },
    ],
  })
  const result = await h.invoke('')
  assert.equal(result.kind, 'success', result.text)
  const payload = payloadOf(result.text)
  assert.equal(payload.findings.length, 1, 'the finding recorded before the cap survives')
  assert.ok(payload.incomplete.startsWith('the reviewer stopped without calling finish_review'), payload.incomplete)
  assert.ok(payload.incomplete.includes('the store had already taken its 300 finding-tool calls'), payload.incomplete)

  const empty = harness({
    summary: SUMMARY,
    diffs: [TEXT_DIFF, BINARY_DIFF],
    script: [
      { toolCalls: lists },
      { toolCalls: [toolCall('append_finding', PROVEN)] },
      { text: 'nothing to report' },
    ],
  })
  const refused = await empty.invoke('')
  assert.equal(refused.kind, 'error', refused.text)
  assert.ok(refused.text.includes('300 finding-tool calls'), refused.text)
  assert.ok(!refused.text.includes('can call tools'), 'the route is not blamed for a cap the model reached')
}

// 100 — finish_review ends the review: a call after it in the same turn is refused, and the report is what was recorded before it.
{
  const h = harness({
    summary: SUMMARY,
    diffs: [TEXT_DIFF, BINARY_DIFF],
    script: [
      {
        toolCalls: [
          toolCall('append_finding', PROVEN),
          toolCall('finish_review', {}),
          toolCall('append_finding', { ...PROVEN, title: 'Too late' }),
        ],
      },
      { text: 'done' },
    ],
  })
  const result = await h.invoke('')
  assert.equal(h.seen.prompts.length, 1, 'the loop ended with the finished review')
  const payload = payloadOf(result.text)
  assert.equal(payload.findings.length, 1)
  assert.equal(payload.findings[0].title, 'Guard the nil board', 'the call after the finish did not land')
  assert.deepEqual(payload.stats.store, { calls: 3, appended: 1, updated: 0, deleted: 0 }, 'and it is counted as a refusal')
}

// 101 — set_summary opens the report, the last one wins, and a review that records none says so instead of inventing one.
{
  const h = harness({
    summary: SUMMARY,
    diffs: [TEXT_DIFF, BINARY_DIFF],
    script: [
      {
        toolCalls: [
          toolCall('set_summary', { summary: 'first' }),
          toolCall('set_summary', { summary: 'second' }),
          toolCall('set_summary', { summary: 'third' }),
        ],
      },
      { toolCalls: [toolCall('finish_review', {})] },
    ],
  })
  const result = await h.invoke('')
  assert.equal(payloadOf(result.text).summary, 'third', 'the last summary is the one kept')
  const tool = messagesOf(h.seen.prompts[1], 'tool')
  assert.ok(tool[0].content[0].text.includes('summary recorded'), tool[0].content[0].text)
  assert.ok(tool[1].content[0].text.includes('summary replaced'), tool[1].content[0].text)

  const bare = harness({ summary: SUMMARY, diffs: [TEXT_DIFF, BINARY_DIFF], script: [record([], null)] })
  const bareResult = await bare.invoke('')
  assert.equal(payloadOf(bareResult.text).summary, '', 'no summary was recorded, and none was invented')
  assert.ok(bareResult.text.includes('(no summary returned)'), bareResult.text)
}

// 102 — the card shows that a review stopped early, and still offers nothing but the copy actions.
{
  const h = harness({
    summary: SUMMARY,
    diffs: [TEXT_DIFF, BINARY_DIFF],
    failAtCall: 2,
    failWith: 'socket hang up',
    script: [{ toolCalls: [toolCall('append_finding', PROVEN)] }],
  })
  const text = (await h.invoke('')).text
  const card = await renderCard({ kind: 'success', text })
  assert.ok(card.texts.includes('state.partial'), 'the card marks the review incomplete')
  assert.ok(
    card.texts.some(entry => entry.includes('socket hang up')),
    `and names the reason: ${card.texts.join(' | ')}`,
  )
  assert.ok(card.texts.includes('Guard the nil board'), 'while still drawing the finding that was recorded')
  assert.deepEqual(
    card.buttons,
    ['action.copyReport', 'toggle.hide', 'action.copyFinding'],
    'a review that stopped early adds no control that could send anything',
  )
}

// 103 — the tool a mode gets carries that mode's own vocabulary: its severity ids, its fields in its order, its guides as the parameter descriptions.
{
  await withSettings({
    modes: {
      misspell: {
        label: 'Spelling review',
        fields: [
          { key: 'problem', label: '', required: true, guide: 'the wrong word and what it should be' },
          { key: 'correction', label: 'Correction', required: true, guide: 'the corrected text verbatim' },
        ],
        severities: [{ id: 'typo', label: 'typo', tone: 'muted', verdict: 'warn', meaning: 'a misspelled word' }],
      },
    },
  }, async () => {
    const h = harness({ summary: SUMMARY, diffs: [TEXT_DIFF, BINARY_DIFF] })
    const result = await h.invoke('mode=misspell')
    assert.equal(result.kind, 'success', result.text)
    const append = h.seen.prompts[0].tools.find(tool => tool.name === 'append_finding')
    assert.deepEqual(
      Object.keys(append.parameters.properties),
      ['severity', 'category', 'file', 'line', 'title', 'problem', 'correction', 'evidence'],
      'the finding shape is the structure plus the mode’s fields, in the mode’s order',
    )
    assert.deepEqual(append.parameters.properties.severity.enum, ['typo'], 'one severity, no room to inflate')
    assert.deepEqual(append.parameters.required, ['severity', 'file', 'title', 'problem', 'correction', 'evidence'])
    assert.ok(
      append.parameters.properties.correction.description.includes('the corrected text verbatim'),
      'the field’s guide is the parameter’s description',
    )
    const update = h.seen.prompts[0].tools.find(tool => tool.name === 'update_finding')
    assert.deepEqual(update.parameters.required, ['id'], 'update takes an id and whatever changes')
    assert.ok(Object.hasOwn(update.parameters.properties, 'correction'), 'and the mode’s fields too')
    assert.deepEqual(
      h.seen.prompts[0].tools.filter(tool => ['list_findings', 'finish_review'].includes(tool.name)).map(tool => Object.keys(tool.parameters.properties)),
      [[], []],
      'the two tools that take nothing declare nothing',
    )
  })
}

// 104 — the finding structure is closed to the modes: a mode that declares a structural key is told so, and the store's meaning for that key stands.
{
  const reserved = ['severity', 'category', 'file', 'line', 'title', 'summary', 'id']
  const fields = [...reserved.map(key => ({ key, label: `Mine: ${key}` })), { key: 'problem' }]
  await withSettings({ modes: { odd: { fields } } }, async () => {
    const { value: payload, warnings } = await captureWarnings(async () => {
      const h = harness({ summary: SUMMARY, diffs: [TEXT_DIFF, BINARY_DIFF] })
      return payloadOf((await h.invoke('mode=odd')).text)
    })
    assert.deepEqual(payload.mode.fields.map(field => field.key), ['problem', 'evidence'], 'no structural key becomes a field')
    for (const key of reserved) {
      assert.ok(
        warnings.some(line => line.includes(`"${key}" is part of the finding structure`)),
        `"${key}" is refused as a field key: ${warnings.join(' | ')}`,
      )
    }
  })
}

// 105 — evidence is only what a tool returned: neither a refusal nor the review's own traffic is a line of code.
{
  const h = harness({
    summary: SUMMARY,
    diffs: [TEXT_DIFF, BINARY_DIFF],
    script: [
      {
        toolCalls: [
          toolCall('read_file', { path: '../../outside.txt' }),
          toolCall('append_finding', { ...PROVEN, title: 'Quoting a refusal', evidence: 'refused: "../../outside.txt" is outside the workspace' }),
        ],
      },
      { toolCalls: [toolCall('append_finding', { ...PROVEN, title: 'Echo', evidence: 'f1 [blocker] internal/chessx/board.go:13 — Quoting a refusal' })] },
      record([], 'nothing proven'),
    ],
  })
  const result = await h.invoke('')
  const payload = payloadOf(result.text)
  assert.equal(payload.findings.length, 0, 'neither quote is evidence')
  assert.equal(payload.withheld.length, 2)
  for (const item of payload.withheld) {
    assert.ok(item.reason.includes('does not occur'), item.reason)
  }
}

// 106 — one policy bounds the model's context for both tool families, and the figure the run reports counts all of it, not the reader half.
{
  const findings = Array.from({ length: 100 }, (_, index) => ({ ...PROVEN, title: `Finding ${index + 1}` }))
  const lists = Array.from({ length: 40 }, () => toolCall('list_findings', {}))
  const h = harness({
    summary: SUMMARY,
    diffs: [TEXT_DIFF, BINARY_DIFF],
    script: [
      { toolCalls: findings.map(finding => toolCall('append_finding', finding)) },
      { toolCalls: lists },
      { toolCalls: [toolCall('finish_review', {})] },
    ],
  })
  const result = await h.invoke('')
  assert.equal(result.kind, 'success', result.text)
  const tool = messagesOf(h.seen.prompts[2], 'tool')
  assert.equal(tool.length, 140, 'the hundred records and the forty listings each got a result')
  const elided = tool.filter(message => message.content[0].text.startsWith('[elided:'))
  assert.ok(elided.length > 0, 'the store traffic is elided like any other tool output')
  assert.ok(
    elided.some(message => message.content[0].text.includes('list_findings')),
    `the listings the contract asks for are part of that policy: ${elided[0].content[0].text}`,
  )
  const payload = payloadOf(result.text)
  assert.equal(payload.findings.length, 100)
  assert.ok(
    payload.stats.context.keptBytes > payload.stats.context.bytes,
    'the kept figure counts the store output the reader budget never saw',
  )
}

// 107 — the cap is a fact about the store, not a sentence the end-of-run bookkeeping compares: whatever stopped the run, the report says the store had already closed when that is why it is short.
{
  const lists = Array.from({ length: 301 }, () => toolCall('list_findings', {}))
  const h = harness({
    summary: SUMMARY,
    diffs: [TEXT_DIFF, BINARY_DIFF],
    abortAtCall: 3,
    script: [
      { toolCalls: [toolCall('append_finding', PROVEN), ...lists] },
      { toolCalls: [toolCall('append_finding', { ...PROVEN, title: 'Too late' })] },
      { text: 'never reached' },
    ],
  })
  const result = await h.invoke('')
  assert.equal(result.kind, 'success', result.text)
  const payload = payloadOf(result.text)
  assert.equal(payload.findings.length, 1, 'the finding recorded before the cap survives the cancel too')
  assert.equal(
    payload.incomplete,
    'the review was cancelled — the store had already taken its 300 finding-tool calls',
    'a cancelled run still names the cap that had closed the store',
  )
  assert.equal(payload.stats.store.calls, 303)
}

// 108 — the finding structure is one table: the keys the model is offered, the store records and a refusal names are one set.
{
  const h = harness({
    summary: SUMMARY,
    diffs: [TEXT_DIFF, BINARY_DIFF],
    script: [
      { toolCalls: [toolCall('append_finding', PROVEN)] },
      { toolCalls: [toolCall('append_finding', { ...PROVEN, title: 'A key of my own', impactt: 'typo' })] },
      record([], 'done'),
    ],
  })
  const result = await h.invoke('')
  assert.equal(result.kind, 'success', result.text)
  const append = h.seen.prompts[0].tools.find(tool => tool.name === 'append_finding')
  const offered = Object.keys(append.parameters.properties)
  const refusal = messagesOf(h.seen.prompts[2], 'tool')[1]
  assert.equal(refusal.isError, true, 'the key outside the structure is refused')
  const named = refusal.content[0].text.slice(refusal.content[0].text.indexOf('takes: ') + 'takes: '.length)
  assert.deepEqual(named.split(', '), offered, 'and the refusal names exactly the keys the schema offered')
  const [finding] = payloadOf(result.text).findings
  assert.deepEqual(Object.keys(finding).filter(key => key !== 'id'), offered, 'every offered key is one the store records')
}

// 109 — read_file is the harness's read: the path and window the wrapper resolved are what reaches the tool, an ignored path never reaches it, and the file the report names is the workspace's own however the backend spells it.
{
  const script = [
    {
      toolCalls: [
        toolCall('read_file', { path: READ_ONLY_FILE, offset: 3, limit: 2 }),
        toolCall('read_file', { path: 'node_modules/dep/index.js' }),
      ],
    },
    record([], 'windowed'),
  ]
  const h = harness({ summary: SUMMARY, diffs: [TEXT_DIFF, BINARY_DIFF], script })
  const result = await h.invoke('')
  assert.equal(result.kind, 'success', result.text)
  assert.deepEqual(
    h.tools.calls,
    [{ name: 'read', arguments: { file_path: join(WS, 'internal', 'play', 'move.go'), offset: 3, limit: 2 } }],
    'exactly one read reached the harness: the absolute path and the resolved window, and never the ignored one',
  )
  const tool = messagesOf(h.seen.prompts[1], 'tool')
  assert.equal(tool[0].isError, undefined, tool[0].content[0].text)
  assert.ok(tool[0].content[0].text.includes(`[${READ_ONLY_FILE} — lines 3-4 of 5]`), tool[0].content[0].text)
  assert.ok(tool[0].content[0].text.includes('func Apply(b *chessx.Board) {'), 'the window holds the lines asked for')
  assert.ok(!tool[0].content[0].text.includes('package play'), 'and none before them')
  assert.equal(tool[1].isError, true, 'an ignored path is refused without the harness being asked')
  assert.ok(tool[1].content[0].text.includes("excluded by the review's ignore rules"), tool[1].content[0].text)
  assert.deepEqual(
    payloadOf(result.text).stats.context.files,
    [READ_ONLY_FILE],
    'an absolute value.path is not what the report names the file',
  )

  const relative = harness({ summary: SUMMARY, diffs: [TEXT_DIFF, BINARY_DIFF], readPath: 'relative', script })
  await relative.invoke('')
  assert.ok(
    messagesOf(relative.seen.prompts[1], 'tool')[0].content[0].text.includes(`[${READ_ONLY_FILE} — lines 3-4 of 5]`),
    'and a backend that reports a relative path is believed as it stands',
  )
}

// 110 — search is the harness's grep: the query arrives as the escaped literal ripgrep needs, at the workspace root, and the rows are the review's own "path:line: text".
{
  writeFileSync(join(WS, 'internal', 'chessx', 'marks.txt'), [
    'var size = board.squares',
    'var sizeTypo = boardXsquares',
    '',
  ].join('\n'))
  const h = harness({
    summary: SUMMARY,
    diffs: [TEXT_DIFF, BINARY_DIFF],
    script: [
      { toolCalls: [toolCall('search', { query: 'board.squares' })] },
      record([], 'searched'),
    ],
  })
  await h.invoke('')
  assert.deepEqual(
    h.tools.calls,
    [{ name: 'grep', arguments: { pattern: 'board\\.squares', path: WS } }],
    'the escaped literal, not the query, is what the regular-expression tool is asked for',
  )
  const tool = messagesOf(h.seen.prompts[1], 'tool')[0]
  assert.ok(tool.content[0].text.includes('[1 match(es) for "board.squares"]'), tool.content[0].text)
  assert.ok(
    tool.content[0].text.includes('internal/chessx/marks.txt:1: var size = board.squares'),
    'a row is path:line: text',
  )
  assert.ok(!tool.content[0].text.includes('boardXsquares'), 'and a dot the query meant literally matched no other character')
}

// 111 — the ignore rules gate what comes back too: a match the harness returned from an ignored path is dropped by the wrapper, and cannot become a finding.
{
  mkdirSync(join(WS, 'node_modules', 'dep'), { recursive: true })
  writeFileSync(join(WS, 'node_modules', 'dep', 'hidden.js'), 'module.exports = "SHARED_NEEDLE"\n')
  writeFileSync(join(WS, 'internal', 'play', 'visible.go'), 'var Visible = "SHARED_NEEDLE"\n')
  const found = await fakeToolService(WS).execute({
    name: 'grep',
    arguments: { pattern: 'SHARED_NEEDLE', path: WS },
    signal: new AbortController().signal,
  })
  assert.deepEqual(
    found.value.matches.map(match => match.path).sort(),
    ['internal/play/visible.go', 'node_modules/dep/hidden.js'],
    'the harness really did return both matches, the ignored one included',
  )

  const h = harness({
    summary: SUMMARY,
    diffs: [TEXT_DIFF, BINARY_DIFF],
    script: [
      { toolCalls: [toolCall('search', { query: 'SHARED_NEEDLE' })] },
      record([{
        severity: 'major', category: 'correctness', file: 'node_modules/dep/hidden.js', line: 1,
        title: 'A dependency nobody asked about', problem: 'a claim built on a path the review excluded',
        impact: 'The reviewer reports on code that was never part of the review.',
        trigger: 'A search hit under an ignored path reaches this.',
        suggestion: 'none', evidence: 'module.exports = "SHARED_NEEDLE"',
      }], 'searched'),
    ],
  })
  const result = await h.invoke('')
  const tool = messagesOf(h.seen.prompts[1], 'tool')[0]
  assert.ok(tool.content[0].text.includes('[1 match(es) for "SHARED_NEEDLE"]'), tool.content[0].text)
  assert.ok(tool.content[0].text.includes('internal/play/visible.go:1: var Visible = "SHARED_NEEDLE"'), tool.content[0].text)
  assert.ok(!tool.content[0].text.includes('node_modules'), 'the ignored row never becomes context')
  const payload = payloadOf(result.text)
  assert.deepEqual(payload.stats.context.files, ['internal/play/visible.go'], 'nor part of the evidence corpus')
  assert.equal(payload.findings.length, 0)
  assert.equal(payload.withheld.length, 1)
  assert.ok(payload.withheld[0].reason.includes('not one the reviewer could see'), payload.withheld[0].reason)
}

// 112 — a harness that exposes neither read nor grep still offers the plugin's own list_dir, and each missing capability costs exactly the tool that needs it.
{
  const { value, warnings } = await captureWarnings(async () => {
    const h = harness({
      summary: SUMMARY,
      diffs: [TEXT_DIFF, BINARY_DIFF],
      toolService: false,
      script: [
        {
          toolCalls: [
            toolCall('read_file', { path: READ_ONLY_FILE }),
            toolCall('search', { query: 'MARKER' }),
            toolCall('list_dir', { path: 'internal' }),
          ],
        },
        record([PROVEN], 'diff and a listing'),
      ],
    })
    return { h, result: await h.invoke('') }
  })
  const h = value.h
  assert.equal(value.result.kind, 'success', value.result.text)
  const request = h.seen.prompts[0]
  assert.deepEqual(
    request.tools.map(tool => tool.name),
    [...REVIEW_TOOL_NAMES, 'list_dir'],
    'the review tools, plus the one reader tool that needs no harness tool',
  )
  assert.equal(assertOneReading(request, 'no tool service at all'), true, 'and the contract claims exactly that one')
  assert.ok(request.system.includes('You have one read-only tool: list_dir.'), 'naming it, and it alone')
  assert.ok(!request.system.includes('This run cannot read the project'), 'so the run is not told it cannot read')
  const refused = messagesOf(h.seen.prompts[1], 'tool')
  assert.equal(refused.length, 3, 'every call still gets exactly one result')
  assert.deepEqual(refused.slice(0, 2).map(message => message.isError), [true, true], 'the two tools that need the harness are refused')
  assert.ok(refused[0].content[0].text.includes('this harness exposes no "read" tool'), refused[0].content[0].text)
  assert.ok(refused[1].content[0].text.includes('this harness exposes no "grep" tool'), refused[1].content[0].text)
  assert.ok(refused[1].content[0].text.includes('list_dir'), 'and a refusal names the reader tools this run does still offer')
  assert.equal(refused[2].isError, undefined, 'while list_dir runs on the plugin itself')
  assert.ok(refused[2].content[0].text.includes('dir  chessx'), refused[2].content[0].text)
  assert.equal(h.tools.calls.length, 0, 'no tool the harness does not have was ever consulted')
  assert.equal(payloadOf(value.result.text).stats.context.calls, 1, 'only the listing is a reader call')
  assert.equal(payloadOf(value.result.text).findings.length, 1, 'a finding grounded in the diff alone still publishes')
  assert.deepEqual(
    warnings.filter(line => line.includes('will not be offered')),
    [
      '[code-review] this harness exposes no "read" tool to the run; read_file will not be offered',
      '[code-review] this harness exposes no "grep" tool to the run; search will not be offered',
    ],
    `each missing capability is reported once, and list_dir is never one of them: ${warnings.join(' | ')}`,
  )

  const half = harness({
    summary: SUMMARY,
    diffs: [TEXT_DIFF, BINARY_DIFF],
    toolNames: ['read'],
    script: [
      { toolCalls: [toolCall('read_file', { path: READ_ONLY_FILE }), toolCall('search', { query: 'MARKER' })] },
      record([], 'half a service'),
    ],
  })
  const partial = await half.invoke('')
  assert.equal(partial.kind, 'success', partial.text)
  const halfRequest = half.seen.prompts[0]
  assert.deepEqual(
    halfRequest.tools.map(tool => tool.name),
    [...REVIEW_TOOL_NAMES, 'read_file', 'list_dir'],
    'a harness with only read keeps read_file and list_dir, and drops search',
  )
  // The count is written as a numeral from two on, so the word is accepted too: what the test pins is the sentence and the tools it names.
  assert.ok(/You have (?:two|2) read-only tools: read_file and list_dir\./.test(halfRequest.system), halfRequest.system.slice(halfRequest.system.indexOf('## Reading')))
  assert.equal(assertOneReading(halfRequest, 'a service exposing only read'), true)
  const halfRefused = messagesOf(half.seen.prompts[1], 'tool')
  assert.equal(halfRefused[0].isError, undefined, halfRefused[0].content[0].text)
  assert.ok(halfRefused[0].content[0].text.includes('MARKER_NIL_SQUARES'), 'the read ran on the harness tool it has')
  assert.equal(halfRefused[1].isError, true, 'and the search is refused for the capability it lacks')
  assert.ok(halfRefused[1].content[0].text.includes('this harness exposes no "grep" tool'), halfRefused[1].content[0].text)
  assert.ok(halfRefused[1].content[0].text.includes('read_file'), 'the refusal names the reader tools this run still offers')
  assert.deepEqual(half.tools.calls.map(call => call.name), ['read'], 'only the tool the harness has was consulted')
}

// 113 — the harness's own refusals and failures are the reader's refusal reasons: a directory, a binary, a missing file and a broken tool are refused reads, never the end of the review.
{
  writeFileSync(join(WS, 'internal', 'chessx', 'logo.bin'), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0x01, 0x02, 0x03]))
  const h = harness({
    summary: SUMMARY,
    diffs: [TEXT_DIFF, BINARY_DIFF],
    script: [
      {
        toolCalls: [
          toolCall('read_file', { path: 'internal' }),
          toolCall('read_file', { path: 'internal/chessx/logo.bin' }),
          toolCall('read_file', { path: 'internal/chessx/gone.go' }),
        ],
      },
      record([], 'nothing readable'),
    ],
  })
  const result = await h.invoke('')
  const tool = messagesOf(h.seen.prompts[1], 'tool')
  assert.equal(h.tools.calls.length, 6, 'each refusal is the harness\'s, observed twice: once for the window and once for its own default')
  assert.deepEqual(
    h.tools.calls.map(call => Object.hasOwn(call.arguments, 'limit')),
    [true, false, true, false, true, false],
    'the retry drops the limit the deployment refused, and nothing else',
  )
  for (const [index, reason] of ['not a regular file', 'binary file', 'not found'].entries()) {
    assert.equal(tool[index].isError, true, tool[index].content[0].text)
    assert.ok(tool[index].content[0].text.startsWith('cannot read '), tool[index].content[0].text)
    assert.ok(tool[index].content[0].text.includes(reason), tool[index].content[0].text)
  }
  assert.equal(payloadOf(result.text).stats.context.calls, 3, 'two harness calls are one refused read, and a refused read is still a call against the budget')

  const broken = harness({
    summary: SUMMARY,
    diffs: [TEXT_DIFF, BINARY_DIFF],
    readFails: 'the file store is offline',
    grepFails: { throws: 'the search backend is unreachable' },
    script: [
      { toolCalls: [toolCall('read_file', { path: READ_ONLY_FILE })] },
      { toolCalls: [toolCall('search', { query: 'MARKER_NIL_SQUARES' })] },
      record([{ ...PROVEN, file: READ_ONLY_FILE, evidence: READ_ONLY_LINE }], 'nothing was read'),
    ],
  })
  const brokenResult = await broken.invoke('')
  assert.equal(brokenResult.kind, 'success', brokenResult.text)
  const brokenTool = messagesOf(broken.seen.prompts[2], 'tool')
  assert.ok(
    brokenTool[0].content[0].text.includes(`cannot read ${READ_ONLY_FILE}: Error: the file store is offline`),
    brokenTool[0].content[0].text,
  )
  assert.ok(
    brokenTool[1].content[0].text.includes('search failed: Error: the search backend is unreachable'),
    brokenTool[1].content[0].text,
  )
  assert.deepEqual(
    brokenTool.map(message => message.isError),
    [true, true],
    'a tool that answers with a failure and a tool that throws are both refused calls',
  )
  const brokenPayload = payloadOf(brokenResult.text)
  assert.equal(brokenPayload.findings.length, 0, 'what no tool returned is not evidence')
  assert.equal(brokenPayload.withheld.length, 1)
  assert.ok(brokenPayload.withheld[0].reason.includes('not one the reviewer could see'), brokenPayload.withheld[0].reason)
}

// 114 — a cancel landing while a read is running stops the run, instead of being reported as a tool that failed.
{
  const h = harness({
    summary: SUMMARY,
    diffs: [TEXT_DIFF, BINARY_DIFF],
    abortOnTool: true,
    script: [{ toolCalls: [toolCall('read_file', { path: READ_ONLY_FILE })] }, record([], 'never reached')],
  })
  const result = await h.invoke('')
  assert.equal(result.kind, 'error', result.text)
  assert.ok(result.text.includes('cancelled'), result.text)
  assert.equal(h.tools.calls.length, 1, 'the call had already reached the harness when the cancel landed')
  assert.equal(h.seen.prompts.length, 1, 'and the run stopped there')
}

// 115 — a harness that exposes only grep keeps search and list_dir, and a read_file call is refused by the capability it lacks, not by the family.
{
  const { value, warnings } = await captureWarnings(async () => {
    const h = harness({
      summary: SUMMARY,
      diffs: [TEXT_DIFF, BINARY_DIFF],
      toolNames: ['grep'],
      script: [
        {
          toolCalls: [
            toolCall('read_file', { path: READ_ONLY_FILE }),
            toolCall('search', { query: 'MARKER_NIL_SQUARES' }),
            toolCall('list_dir', { path: 'internal' }),
          ],
        },
        record([], 'half a service'),
      ],
    })
    return { h, result: await h.invoke('') }
  })
  const h = value.h
  assert.equal(value.result.kind, 'success', value.result.text)
  const request = h.seen.prompts[0]
  assert.deepEqual(
    request.tools.map(tool => tool.name),
    [...REVIEW_TOOL_NAMES, 'list_dir', 'search'],
    'the tools this deployment can run, in the order the plugin declares them',
  )
  assert.ok(/You have (?:two|2) read-only tools: list_dir and search\./.test(request.system), 'and the contract names exactly those two')
  assert.equal(assertOneReading(request, 'a service exposing only grep'), true)
  const tool = messagesOf(h.seen.prompts[1], 'tool')
  assert.equal(tool.length, 3, 'every call of the turn got exactly one result')
  assert.equal(tool[0].isError, true, 'the read is refused')
  assert.ok(tool[0].content[0].text.includes('this harness exposes no "read" tool'), tool[0].content[0].text)
  assert.ok(
    tool[0].content[0].text.includes('list_dir') && tool[0].content[0].text.includes('search'),
    'and the refusal names the reader tools this run does offer',
  )
  assert.equal(tool[1].isError, undefined, tool[1].content[0].text)
  assert.ok(tool[1].content[0].text.includes('[1 match(es) for "MARKER_NIL_SQUARES"]'), 'search ran on the harness grep')
  assert.equal(tool[2].isError, undefined)
  assert.ok(tool[2].content[0].text.includes('dir  chessx'), 'and list_dir needs no harness tool at all')
  assert.deepEqual(h.tools.calls.map(call => call.name), ['grep'], 'only the tool this deployment has was consulted')
  assert.equal(payloadOf(value.result.text).stats.context.calls, 2, 'a refused read is not a call')
  assert.deepEqual(
    warnings.filter(line => line.includes('will not be offered')),
    ['[code-review] this harness exposes no "read" tool to the run; read_file will not be offered'],
    `the one capability this harness lacks is the one reported: ${warnings.join(' | ')}`,
  )
}

// 116 — a deployment whose read window is capped below the review's 400 is answered by the retry: two harness calls, the second without a limit, and the read lands.
{
  const h = harness({
    summary: SUMMARY,
    diffs: [TEXT_DIFF, BINARY_DIFF],
    readLimit: 200,
    script: [
      { toolCalls: [toolCall('read_file', { path: READ_ONLY_FILE })] },
      record([{ ...PROVEN, file: READ_ONLY_FILE, line: 4, evidence: READ_ONLY_LINE }], 'read it'),
    ],
  })
  const result = await h.invoke('')
  assert.equal(result.kind, 'success', result.text)
  assert.deepEqual(
    h.tools.calls.map(call => call.arguments),
    [
      { file_path: join(WS, 'internal', 'play', 'move.go'), offset: 1, limit: 400 },
      { file_path: join(WS, 'internal', 'play', 'move.go'), offset: 1 },
    ],
    'the capped window is asked for once, and the retry asks for no window at all',
  )
  const tool = messagesOf(h.seen.prompts[1], 'tool')[0]
  assert.equal(tool.isError, undefined, tool.content[0].text)
  assert.ok(tool.content[0].text.includes(`[${READ_ONLY_FILE} — lines 1-5 of 5]`), tool.content[0].text)
  assert.ok(tool.content[0].text.includes('MARKER_NIL_SQUARES'), 'the retried read returned the file')
  const payload = payloadOf(result.text)
  assert.equal(payload.stats.context.calls, 1, 'two harness calls are still one reader call')
  assert.equal(payload.findings.length, 1, 'and the finding the read grounds is published')

  const within = harness({
    summary: SUMMARY,
    diffs: [TEXT_DIFF, BINARY_DIFF],
    readLimit: 200,
    script: [
      { toolCalls: [toolCall('read_file', { path: READ_ONLY_FILE, offset: 3, limit: 2 })] },
      record([], 'windowed'),
    ],
  })
  await within.invoke('')
  assert.deepEqual(
    within.tools.calls.map(call => call.arguments),
    [{ file_path: join(WS, 'internal', 'play', 'move.go'), offset: 3, limit: 2 }],
    'a window the deployment accepts is never retried',
  )
  assert.equal(messagesOf(within.seen.prompts[1], 'tool')[0].isError, undefined)
}

// 117 — a read that succeeds with a value the wrapper does not declare is refused, never reported as an empty file.
{
  for (const [readMalformed, what] of [[true, 'the lines are not a list'], ['text', 'a line carries no text'], ['totalLines', 'the total is not a whole number']]) {
    const h = harness({
      summary: SUMMARY,
      diffs: [TEXT_DIFF, BINARY_DIFF],
      readMalformed,
      script: [
        { toolCalls: [toolCall('read_file', { path: READ_ONLY_FILE })] },
        record([{ ...PROVEN, file: READ_ONLY_FILE, line: 4, evidence: READ_ONLY_LINE }], 'read it'),
      ],
    })
    const result = await h.invoke('')
    assert.equal(result.kind, 'success', result.text)
    const tool = messagesOf(h.seen.prompts[1], 'tool')[0]
    assert.equal(tool.isError, true, `${what}: ${tool.content[0].text}`)
    assert.ok(
      tool.content[0].text.startsWith(`cannot read ${READ_ONLY_FILE}: the harness's read returned an unexpected shape`),
      `${what}: ${tool.content[0].text}`,
    )
    assert.ok(!tool.content[0].text.includes('lines 1-'), `${what}: no window is claimed for a file the run never saw`)
    assert.equal(h.tools.calls.length, 1, `${what}: a malformed success is not a window refusal, so it is not retried`)
    const payload = payloadOf(result.text)
    assert.equal(payload.findings.length, 0, `${what}: nothing is evidenced by a result the wrapper cannot read`)
    assert.equal(payload.withheld.length, 1)
    assert.ok(
      payload.withheld[0].reason.includes('not one the reviewer could see'),
      `${what}: reading it as an empty file would have made the file visible — ${payload.withheld[0].reason}`,
    )
    assert.deepEqual(payload.stats.context.files, [], `${what}: and the file never entered the run's corpus`)
  }
}

// 118 — a search that succeeds with a value the wrapper does not declare is a refusal, never "no match": the project was not searched to a conclusion.
{
  for (const [grepMalformed, what] of [[true, 'the matches are not a list'], ['row', 'a row carries no line number']]) {
    const h = harness({
      summary: SUMMARY,
      diffs: [TEXT_DIFF, BINARY_DIFF],
      grepMalformed,
      script: [
        { toolCalls: [toolCall('search', { query: 'MARKER_NIL_SQUARES' })] },
        record([], 'searched'),
      ],
    })
    const result = await h.invoke('')
    assert.equal(result.kind, 'success', result.text)
    const tool = messagesOf(h.seen.prompts[1], 'tool')[0]
    assert.equal(tool.isError, true, `${what}: ${tool.content[0].text}`)
    assert.ok(
      tool.content[0].text.startsWith("search failed: the harness's grep returned an unexpected shape"),
      `${what}: ${tool.content[0].text}`,
    )
    assert.ok(!tool.content[0].text.includes('no match'), `${what}: an unreadable result is not a claim that the project holds nothing`)
    assert.equal(h.tools.calls.length, 1, `${what}: the harness was asked exactly once`)
    assert.equal(payloadOf(result.text).stats.context.calls, 1, `${what}: the refused search is still a call against the budget`)
  }
}

console.log('selftest: all checks passed')
