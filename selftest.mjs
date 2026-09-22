/**
 * Self-test for both halves: drives the `/review` handler against a fake Context
 * and asserts the whole path — diff collection, the read-only project reader
 * (tools, budget, sandbox), the evidence gate, settings, the notice that reaches
 * the Agent when it is opted in, and every failure mode. It then loads the Client
 * artifact and asserts the card's copy helpers and its outcome faces.
 *
 * The reviewer model is scripted: each entry answers one model call, either with
 * text or with tool calls, so the loop is exercised without a network call.
 *
 * Run: node selftest.mjs
 */
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, realpathSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { apply } from './index.js'

const HERE = dirname(fileURLToPath(import.meta.url))

const SESSION = 'session-under-test'
const MARKER = '<!-- code-review:payload -->'

// Hermetic by construction: the run must never read the developer's real
// DSH_HOME/code-review/config.json, or the settings on this machine would decide
// what the assertions mean. `withSettings` layers a per-test file on top.
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

/**
 * A Context stub exposing only what the plugin body touches.
 * @param options.summary - what `workspaceChanges.summary` returns.
 * @param options.summaries - per-seq summaries instead, so a dropped record can be simulated.
 * @param options.events - the recorded `workspace/changes` seqs in log order (oldest first).
 * @param options.diffs - what `workspaceChanges.diff` returns, by file index.
 * @param options.script - one entry per model call: `{ text }` or `{ toolCalls }`; the last entry repeats.
 * @param options.hasEvent - whether the session recorded a `workspace/changes` event.
 * @param options.route - the agent's own route, as real Agents expose it; `{}` means no route is known.
 * @param options.steerThrows - makes `agent.steer` reject, to prove the report survives.
 * @param options.failFirstWithTools - makes the first model call throw, to prove the diff-only retry.
 * @param options.git - expose a real `ctx.subprocess`, so the git source can run.
 * @param options.cwd - the session workspace the plugin reads.
 * @param options.messages - what the session derives as its conversation.
 * @param options.toolCalls - `{ name, arguments }` entries logged as this session's tool calls.
 */
function harness({
  summary,
  summaries,
  events = [7],
  diffs,
  script = [{ text: '{"verdict":"pass","summary":"ok","findings":[]}' }],
  hasEvent = true,
  route = { options: { provider: 'deepseek-official', model: 'deepseek-flash' } },
  steerThrows = false,
  failFirstWithTools = false,
  git = true,
  cwd = WS,
  messages = [{ role: 'user', content: [{ type: 'text', text: 'Board ı hesapla' }] }],
  toolCalls = [],
}) {
  const subprocess = git ? realSubprocess() : undefined
  const seen = { prompts: [], steer: [], inject: [], steerAttempts: 0 }
  let definition
  let call = 0
  const ctx = {
    effect(callback) { callback() },
    get(name) { return name === 'subprocess' ? subprocess : undefined },
    commands: { register(value) { definition = value; return () => {} } },
    workspaceChanges: {
      summary: (_id, seq) => (summaries === undefined ? summary : summaries[seq]),
      diff: async (_id, _seq, index) => diffs[index],
    },
    llm: {
      stream(request) {
        seen.prompts.push(request)
        const step = script[Math.min(call, script.length - 1)]
        const failing = failFirstWithTools && call === 0
        call += 1
        return (async function* generate() {
          if (failing) throw new Error('this model has no tool support')
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
    commandId: 'c1', agent, rawInput, attachments: [], signal: new AbortController().signal,
  })
  return { invoke, seen, name: definition.name, definition }
}

/**
 * The `ctx.subprocess` face the plugin uses, backed by a real child process so
 * the git source is exercised against real repositories and real output.
 */
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

/** Run `fn` with `DSH_HOME` pointed at a fresh directory holding this config. */
async function withSettings(settings, fn) {
  const home = mkdtempSync(join(tmpdir(), 'dsh-code-review-home-'))
  mkdirSync(join(home, 'code-review'), { recursive: true })
  writeFileSync(join(home, 'code-review', 'config.json'), JSON.stringify(settings))
  const previous = process.env.DSH_HOME
  process.env.DSH_HOME = home
  try {
    return await fn()
  } finally {
    if (previous === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = previous
  }
}

/** The payload the Client half parses out of the report text. */
function payloadOf(text) {
  const marker = text.indexOf(MARKER)
  assert.ok(marker >= 0, 'report carries the payload marker')
  const body = text.slice(text.indexOf('```json', marker) + '```json'.length)
  return JSON.parse(body.slice(0, body.indexOf('```')))
}

/** Messages of one model call, by role. */
function messagesOf(request, role) {
  return request.messages.filter(message => message.role === role)
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
/** A model reply carrying one payload. */
const answer = (verdict, findings, summary = 'x') => ({ text: JSON.stringify({ verdict, summary, findings }) })

// 1 — a proven finding survives the gate and reaches both the report and the payload.
{
  const h = harness({ summary: SUMMARY, diffs: [TEXT_DIFF, BINARY_DIFF], script: [answer('fail', [PROVEN], 'Nil board.')] })
  assert.equal(h.name, 'review')
  const result = await h.invoke('')
  assert.equal(result.kind, 'success')
  const prompt = h.seen.prompts[0].messages[0].content[0].text
  assert.ok(prompt.includes('+extra'), 'diff body reached the prompt')
  assert.ok(!prompt.includes('Board ı hesapla'), 'the session message is never read by the reviewer')
  assert.ok(!prompt.includes('most recent request'), 'no conversation intent section at all')
  assert.ok(prompt.includes('verbatim evidence quote') || prompt.includes('verbatim'), 'the prompt states the evidence bar')
  const payload = payloadOf(result.text)
  assert.equal(payload.schema, 'code-review/1')
  assert.equal(payload.verdict, 'fail')
  assert.equal(payload.findings.length, 1)
  assert.equal(payload.findings[0].evidence, '+new')
  assert.deepEqual(payload.withheld, [])
  assert.equal(payload.stats.reviewed, 1)
  assert.deepEqual(payload.stats.skipped, [{ file: 'assets/logo.png', reason: 'binary' }])
  assert.ok(result.text.includes('**Evidence:**'), 'the report shows the evidence')
}

// 2 — a reviewer that contradicts itself is reconciled from its own findings.
{
  const h = harness({
    summary: SUMMARY,
    diffs: [TEXT_DIFF, BINARY_DIFF],
    script: [answer('pass', [{ ...PROVEN, severity: 'major', title: '', evidence: '+extra' }], 'fine')],
  })
  const payload = payloadOf((await h.invoke('')).text)
  assert.equal(payload.verdict, 'fail', 'a proven major finding forces fail')
  assert.equal(payload.findings[0].title, 'board may be nil here', 'a missing title falls back to the problem')
}

// 3 — output that is not JSON fails loudly instead of reporting a fake pass.
{
  const h = harness({ summary: SUMMARY, diffs: [TEXT_DIFF, BINARY_DIFF], script: [{ text: 'Looks fine to me!' }] })
  const result = await h.invoke('')
  assert.equal(result.kind, 'error')
  assert.ok(result.text.includes('no JSON object'))
}

// 4 — a session with no recorded change is refused with a reason.
{
  const h = harness({ summary: SUMMARY, diffs: [TEXT_DIFF], hasEvent: false })
  const result = await h.invoke('')
  assert.equal(result.kind, 'error')
  assert.ok(result.text.includes('nothing to review'), result.text)
  assert.ok(result.text.includes('session record: none still served'), result.text)
}

// 5 — a change record the Host no longer serves is reported, not guessed.
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

// 9 — the route resolves from agent.options first, with the older top-level fields as a fallback.
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
    script: [answer('fail', [{ ...PROVEN, evidence: '+if (board == nil) { return nil }' }], 'invented')],
  })
  const result = await h.invoke('')
  const payload = payloadOf(result.text)
  assert.equal(payload.findings.length, 0, 'the unprovable finding is not published')
  assert.equal(payload.withheld.length, 1)
  assert.equal(payload.verdict, 'pass', 'a withheld claim cannot fail the review')
  assert.ok(payload.withheld[0].reason.includes('does not occur'), payload.withheld[0].reason)
  assert.ok(result.text.includes('Withheld as unprovable'), 'the report names the withheld claim')
}

// 11 — a finding naming a file the reviewer never saw is withheld.
{
  const h = harness({
    summary: SUMMARY,
    diffs: [TEXT_DIFF, BINARY_DIFF],
    script: [answer('warn', [{ ...PROVEN, file: 'internal/invisible/file.go' }])],
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
    script: [answer('warn', [{ ...PROVEN, evidence: '' }])],
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
    script: [answer('fail', [PROVEN], 'Nil board.')],
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
      script: [answer('fail', [PROVEN], 'Nil board.')],
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
      answer('major', [{
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
  assert.deepEqual(h.seen.prompts[0].tools.map(tool => tool.name), ['read_file', 'list_dir', 'search'])
  const toolMessages = messagesOf(h.seen.prompts[1], 'tool')
  assert.equal(toolMessages.length, 1, 'the tool result went back to the model')
  assert.ok(toolMessages[0].content[0].text.includes('MARKER_NIL_SQUARES'), 'the file content reached the model')
  assert.ok(toolMessages[0].content[0].text.includes('[reader budget: 1/30 calls'), 'the model is told its remaining budget')
  const callBlocks = messagesOf(h.seen.prompts[1], 'assistant')[0].content
  assert.equal(callBlocks[0].type, 'tool-call')
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
      answer('minor', [{
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
      answer('fail', [{ ...PROVEN, file: '../../outside.txt', evidence: 'OUTSIDE_SECRET' }]),
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

// 20 — an unknown tool name is refused, never executed.
{
  const h = harness({
    summary: SUMMARY,
    diffs: [TEXT_DIFF, BINARY_DIFF],
    script: [
      { toolCalls: [{ name: 'run_command', arguments: '{"cmd":"rm -rf /"}' }] },
      answer('pass', []),
    ],
  })
  const result = await h.invoke('')
  const refusal = messagesOf(h.seen.prompts[1], 'tool')[0]
  assert.equal(refusal.isError, true)
  assert.ok(refusal.content[0].text.includes('unknown tool'), refusal.content[0].text)
  assert.equal(result.kind, 'success')
}

// 21 — the tool-call budget is enforced, the tools are then withdrawn, and the answer still lands.
{
  await withSettings({ maxToolCalls: 2 }, async () => {
    const h = harness({
      summary: SUMMARY,
      diffs: [TEXT_DIFF, BINARY_DIFF],
      script: [
        { toolCalls: [{ name: 'list_dir', arguments: '{"path":"internal"}' }] },
        { toolCalls: [{ name: 'list_dir', arguments: '{"path":"internal/play"}' }] },
        answer('pass', [], 'looked around'),
      ],
    })
    const result = await h.invoke('')
    assert.equal(result.kind, 'success')
    assert.equal(h.seen.prompts.length, 3, 'two reading calls and one final answer')
    assert.ok(Array.isArray(h.seen.prompts[0].tools) && Array.isArray(h.seen.prompts[1].tools))
    assert.equal(h.seen.prompts[2].tools, undefined, 'tools are withdrawn once the budget is spent')
    assert.equal(messagesOf(h.seen.prompts[2], 'tool').length, 2)
    const note = messagesOf(h.seen.prompts[2], 'user').at(-1).content[0].text
    assert.ok(note.includes('reader budget spent'), 'the model is told to answer now')
    assert.equal(payloadOf(result.text).stats.context.calls, 2)
  })
}

// 22 — project access can be turned off entirely.
{
  await withSettings({ projectAccess: false }, async () => {
    const h = harness({ summary: SUMMARY, diffs: [TEXT_DIFF, BINARY_DIFF] })
    await h.invoke('')
    assert.equal(h.seen.prompts.length, 1)
    assert.equal(h.seen.prompts[0].tools, undefined, 'no tools are offered')
  })
}

// 23 — a route that cannot take tools is retried diff-only, not abandoned.
{
  const h = harness({
    summary: SUMMARY,
    diffs: [TEXT_DIFF, BINARY_DIFF],
    failFirstWithTools: true,
    script: [answer('warn', [PROVEN], 'diff only')],
  })
  const result = await h.invoke('')
  assert.equal(result.kind, 'success', 'the review still completes')
  assert.equal(h.seen.prompts.length, 2, 'the failed call and the retry')
  assert.ok(Array.isArray(h.seen.prompts[0].tools), 'the first attempt offered tools')
  assert.equal(h.seen.prompts[1].tools, undefined, 'the retry runs without tools')
  assert.equal(payloadOf(result.text).findings.length, 1, 'a diff-grounded finding still publishes')
  assert.equal(payloadOf(result.text).stats.context.calls, 0, 'no reader call was made')
  assert.equal(h.seen.prompts[0].maxTokens, 50000, 'the configured output cap is attempted first')
  assert.equal(h.seen.prompts[1].maxTokens, 8192, 'the retry shrinks the output cap')
  assert.equal(payloadOf(result.text).stats.reviewerFallback, true, 'the report admits the review ran degraded')
}

// 24 — reading stops at the configured fraction of the timeout, not at the hard kill.
{
  await withSettings({ timeoutMs: 1000, toolDeadlineRatio: 0.0000001 }, async () => {
    const h = harness({ summary: SUMMARY, diffs: [TEXT_DIFF, BINARY_DIFF] })
    const result = await h.invoke('')
    assert.equal(h.seen.prompts[0].tools, undefined, 'no tools are offered once the reading deadline has passed')
    assert.equal(result.kind, 'success', 'the report is still produced')
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
    script: [...reads, answer('pass', [], 'read a lot')],
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
    script: [answer('major', [{ ...PROVEN, trigger: '' }])],
  })
  const payload = payloadOf((await h.invoke('')).text)
  assert.equal(payload.findings.length, 0)
  assert.ok(payload.withheld[0].reason.includes('no trigger scenario'), payload.withheld[0].reason)
}

// 27 — a finding that does not say what it causes is withheld.
{
  const h = harness({
    summary: SUMMARY,
    diffs: [TEXT_DIFF, BINARY_DIFF],
    script: [answer('major', [{ ...PROVEN, impact: '' }])],
  })
  const payload = payloadOf((await h.invoke('')).text)
  assert.equal(payload.findings.length, 0)
  assert.ok(payload.withheld[0].reason.includes('no impact stated'), payload.withheld[0].reason)
}

// 28 — impact and trigger reach the payload, the report and the opt-in notice.
{
  await withSettings({ notifyAgent: 'steer' }, async () => {
    const h = harness({ summary: SUMMARY, diffs: [TEXT_DIFF, BINARY_DIFF], script: [answer('fail', [PROVEN])] })
    const result = await h.invoke('')
    const payload = payloadOf(result.text)
    assert.equal(payload.findings[0].impact, PROVEN.impact)
    assert.equal(payload.findings[0].trigger, PROVEN.trigger)
    assert.ok(result.text.includes(`**Impact:** ${PROVEN.impact}`), 'the report shows the impact')
    assert.ok(result.text.includes(`**How it is reached:** ${PROVEN.trigger}`), 'the report shows the trigger')
    const notice = h.seen.steer[0].content[0].text
    assert.ok(notice.includes(`impact: ${PROVEN.impact}`), 'the notice carries the impact')
    assert.ok(notice.includes(`reached by: ${PROVEN.trigger}`), 'the notice carries the trigger')
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

// 30 — when the newest record is no longer served, an older one is reviewed instead, and said so.
{
  const h = harness({
    summaries: { 5: SUMMARY },
    events: [5, 9],
    diffs: [TEXT_DIFF, BINARY_DIFF],
    script: [answer('pass', [], 'older turn')],
  })
  const result = await h.invoke('')
  assert.equal(result.kind, 'success', 'the review falls back to a served record')
  const payload = payloadOf(result.text)
  assert.equal(payload.stats.recordBehind, 1, 'the report knows how far back it went')
  assert.equal(payload.turn, SUMMARY.turn)
  assert.ok(result.text.includes('have no comparison in this Host process'), 'the report says so')
}

/** A real repository with one committed file, one local edit and one new file. */
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
    script: [answer('major', [GIT_FINDING], 'Reset is broken.')],
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
    script: [answer('pass', [], 'session fallback')],
  })
  const payload = payloadOf((await h.invoke('')).text)
  assert.equal(payload.source, 'session', 'a clean tree falls back to the recorded changes')
  assert.equal(payload.stats.reviewed, 1)
  // The record this source reads is this session's own work, so the prompt must
  // present it as primary. Labelling it "not by this session" would point the
  // reviewer at the rest of the workspace instead of at the change set.
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
      script: [answer('major', [GIT_FINDING], 'committed work')],
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
        answer('pass', [], 'done'),
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
    script: [answer('pass', [], 'x')],
  })
  await h.invoke('')
  const prompt = h.seen.prompts[0].messages[0].content[0].text
  assert.ok(!prompt.includes('Board ı hesapla'), 'the human message is not the intent either')
  assert.ok(!prompt.includes('previous report body'), 'the notice never leaks in')
}

/** The React stand-in for helper tests: it never draws, so no component runs. */
const STUB_REACT = {
  createElement: () => null,
  useMemo: () => undefined,
  useState: () => [true, () => {}],
}

/**
 * A React stand-in that records the element tree instead of drawing it, so what
 * the card would show can be inspected without a browser.
 */
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

/**
 * Load the Client artifact the way the page does and return its module
 * descriptor, so a test can build it with whichever React stand-in it needs.
 * The module is imported once — a page also evaluates it once.
 */
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

/**
 * Mount the card for one command outcome and collect what it would show: the
 * visible strings and the caption of every button it draws.
 */
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
      // The stylesheet is one long child; it is not something the card shows.
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

/** Load the module API with the inert React above, for its pure helpers. */
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
    schema: 'code-review/1',
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
        answer('pass', [], 'searched'),
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
        answer('pass', [], 'x'),
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
    script: [answer('fail', [{ ...PROVEN, evidence: `+${'x'.repeat(400)}` }])],
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
    script: [answer('pass', [], 'session only')],
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
    script: [answer('pass', [], 'x')],
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
    script: [answer('pass', [], 'x')],
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

/**
 * A repository whose session works in `sub/`, with unrelated changes elsewhere.
 * The session directory is deliberately not the repository root.
 */
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
    script: [answer('pass', [], 'subdirectory session')],
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
    script: [answer('pass', [], 'x')],
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
      script: [answer('pass', [], 'via a link')],
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
    ['findingText', 'parsePayload', 'readOutcome', 'reportOf'],
    'the Client half exposes copy helpers only — there is no send path to misuse',
  )

  // The face decides what the card claims. A command that succeeded but whose
  // payload did not parse must not be reported as a review that never ran.
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
}

// 50 — end to end: the user receives the whole review, and the agent receives nothing.
{
  const { repo } = gitFixture()
  const h = harness({
    cwd: repo,
    hasEvent: false,
    diffs: [],
    script: [answer('fail', [GIT_FINDING], 'Reset panics instead of resetting.')],
  })
  const result = await h.invoke('')
  assert.equal(result.kind, 'success', result.text)
  assert.equal(h.seen.steer.length, 0, 'the review did not start a turn for the agent')
  assert.equal(h.seen.inject.length, 0, 'and did not enter its context')
  assert.ok(result.text.includes('## Code review — FAIL'), 'the user gets the report')
  assert.ok(result.text.includes('Reset panics instead of resetting'), 'with the finding in it')
  assert.ok(result.text.includes('**Evidence:**'), 'and the evidence behind it')

  // The Client half reads exactly what the Host half wrote: the two halves meet
  // on the payload marker, and the copy takes the report without it.
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
  // Every line below is chosen so that its diff line collides with a file header
  // or a hunk marker: a deleted `-- x` renders as `--- x`, an added `++ x` renders
  // as `+++ x`, an added `+++ x` as `++++ x`.
  writeFileSync(join(repo, 'tricky.txt'), ['alpha', '-- old sql comment', '--- old rule', '++ old increment', 'omega', ''].join('\n'))
  writeFileSync(join(repo, 'tail.txt'), 'first\nsecond\n')
  git(['add', '.'])
  git(['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-q', '-m', 'init'])
  writeFileSync(join(repo, 'tricky.txt'), ['alpha', '-- new sql comment', '--- new rule', '++ new increment', '+++ new triple', 'omega', ''].join('\n'))
  // No trailing newline: git appends a `\ No newline at end of file` marker that
  // must not be counted as either side.
  writeFileSync(join(repo, 'tail.txt'), 'first\nchanged')

  const totals = git(['diff', '--numstat']).stdout.trim().split('\n')
    .map(line => line.split('\t'))
    .filter(cols => /^\d+$/.test(cols[0]) && /^\d+$/.test(cols[1]))
    .reduce((sum, cols) => ({ added: sum.added + Number(cols[0]), deleted: sum.deleted + Number(cols[1]) }), { added: 0, deleted: 0 })
  // A guard that the fixture is a real change; the assertions that matter are the
  // agreement with git below and the ambiguous lines the diff is checked for.
  assert.ok(totals.added > 0 && totals.deleted > 0, `the fixture changes lines: ${JSON.stringify(totals)}`)

  const h = harness({
    cwd: repo,
    hasEvent: false,
    diffs: [],
    script: [answer('pass', [], 'tallied')],
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
  // The guarantee this test exists for: no control on the card can reach the
  // agent. A button that is neither a copy action nor the toggle fails here.
  const ALLOWED = new Set(['action.copyReport', 'action.copyFinding', 'toggle.hide', 'toggle.show'])
  assert.deepEqual(
    full.buttons.filter(caption => !ALLOWED.has(caption)),
    [],
    'nothing on the card does anything but copy or collapse',
  )
  assert.ok(full.texts.includes('a.go:3'), 'the finding names its location')
  assert.ok(full.texts.includes('label.impact: i'), 'and carries its impact')
  assert.ok(full.texts.includes('label.trigger: tr'), 'and how it is reached')
  assert.ok(full.texts.includes('label.evidence'), 'and the evidence behind it')
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

    const h = harness({ cwd: repo, hasEvent: false, diffs: [], script: [answer('pass', [], 'spaced')] })
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

  const h = harness({ cwd: repo, hasEvent: false, diffs: [], script: [answer('pass', [], 'binary')] })
  const result = await h.invoke('')
  assert.equal(result.kind, 'success', result.text)
  const payload = payloadOf(result.text)
  assert.equal(payload.stats.reviewed, 1, 'only the text file was reviewed')
  assert.deepEqual(payload.stats.skipped, [{ file: 'logo.png', reason: 'binary' }], 'the binary is listed as left out')
  assert.ok(result.text.includes('- logo.png — binary'), 'and the report says so where the README promises it')
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

  const h = harness({ cwd: repo, hasEvent: false, diffs: [], script: [answer('pass', [], 'glob')] })
  const result = await h.invoke('')
  assert.equal(result.kind, 'success', result.text)
  assert.equal(payloadOf(result.text).stats.reviewed, 2, 'both files are reviewed')
  const prompt = h.seen.prompts[0].messages[0].content[0].text
  const occurrences = needle => prompt.split(needle).length - 1
  // Read as a glob, `a[1].go` also matches `a1.go`, so one file's change would
  // be pulled into the other's diff and reported twice.
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
  // The added line is whitespace only and it is the last line, so trimming the
  // whole diff would silently rewrite it into a bare '+'.
  writeFileSync(join(repo, 'a.go'), 'package a\n\nvar A = 1\n   \n')

  const h = harness({ cwd: repo, hasEvent: false, diffs: [], script: [answer('pass', [], 'verbatim')] })
  const result = await h.invoke('')
  assert.equal(result.kind, 'success', result.text)
  const prompt = h.seen.prompts[0].messages[0].content[0].text
  assert.ok(prompt.includes('+   \n'), 'the whitespace-only added line survives verbatim')
  assert.ok(!prompt.includes('\n+\n'), 'and was not rewritten into a bare +')
}

/**
 * A repository with no ignore file of its own: a changed source file next to the
 * junk every project produces. `vendor/lib/vendored.go` is tracked — committed
 * by force, the mistake that makes `node_modules` show up in a diff — while the
 * dependency tree, the bundle and the log are untracked.
 */
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

/** The change-set junk a noisyFixture review must never have looked at. */
const NOISY_NEEDLES = ['DEPENDENCY_NEEDLE', 'BUNDLE_NEEDLE', 'LOG_NEEDLE', 'VENDOR_NEEDLE']

// 57 — the built-in list keeps dependencies, build output and logs out of the diff.
{
  const { repo } = noisyFixture()
  const h = harness({ cwd: repo, hasEvent: false, diffs: [], script: [answer('pass', [], 'source only')] })
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
    const h = harness({ cwd: repo, hasEvent: false, diffs: [], script: [answer('pass', [], 'configured')] })
    const payload = payloadOf((await h.invoke('')).text)
    assert.equal(payload.stats.ignore.configured, 2, 'the config patterns are in force')
    assert.ok(
      payload.stats.ignore.sample.some(item => item.file === 'generated/code.go' && item.rule === 'generated/'),
      'a configured pattern names itself in the report',
    )
    assert.ok(!h.seen.prompts[0].messages[0].content[0].text.includes('GEN_NEEDLE'), 'and keeps the path out')
  })

  // Typed on the command line: one pattern adds, one negation takes a built-in
  // default back, one quoted pattern holds a space, and the rest of the line is
  // still the focus message.
  mkdirSync(join(repo, 'odd dir'), { recursive: true })
  writeFileSync(join(repo, 'odd dir', 'note.md'), 'ODD_NEEDLE\n')
  const h = harness({ cwd: repo, hasEvent: false, diffs: [], script: [answer('pass', [], 'typed')] })
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

  const h = harness({ cwd: repo, hasEvent: false, diffs: [], script: [answer('pass', [], 'own rules')] })
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

  // A negation wins over the repository's own rules too: the user is the last word.
  const over = harness({ cwd: repo, hasEvent: false, diffs: [], script: [answer('pass', [], 'rescued')] })
  await over.invoke('ignored=!generated/api.go')
  assert.ok(
    over.seen.prompts[0].messages[0].content[0].text.includes('REPO_NEEDLE'),
    'an explicit `!pattern` puts back what .gitignore took out',
  )

  await withSettings({ respectGitIgnore: false }, async () => {
    const off = harness({ cwd: repo, hasEvent: false, diffs: [], script: [answer('pass', [], 'no repo rules')] })
    const offPayload = payloadOf((await off.invoke('')).text)
    assert.equal(offPayload.stats.ignore.gitIgnore, false, 'the repository rules can be turned off')
    assert.equal(offPayload.stats.reviewed, 2, 'and then the tracked file is reviewed again')
  })
}

// 60 — the built-in list can be turned off, from the config or from the command line.
{
  const { repo } = noisyFixture()
  await withSettings({ ignoreDefaults: false }, async () => {
    const h = harness({ cwd: repo, hasEvent: false, diffs: [], script: [answer('pass', [], 'all of it')] })
    const payload = payloadOf((await h.invoke('')).text)
    assert.equal(payload.stats.ignore.builtIn, false)
    assert.equal(payload.stats.ignore.count, 0, 'nothing is excluded once the list is off')
    assert.equal(payload.stats.reviewed, 5, 'so the dependency tree, the bundle and the log are reviewed')
    assert.ok(h.seen.prompts[0].messages[0].content[0].text.includes('DEPENDENCY_NEEDLE'))
  })

  // A typed argument beats the config file in both directions.
  await withSettings({ ignoreDefaults: false }, async () => {
    const h = harness({ cwd: repo, hasEvent: false, diffs: [], script: [answer('pass', [], 'defaults back')] })
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
      answer('fail', [{
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
    script: [answer('pass', [], 'session record')],
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
    script: [answer('pass', [], 'never asked')],
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

  const h = harness({ cwd: repo, hasEvent: false, diffs: [], script: [answer('pass', [], 'patterns')] })
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
  // The meta line is longer than the recorder keeps, so what proves the count
  // here is the section itself: the label carries it and each row names its rule.
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
      answer('fail', [{
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
  // The repository layer is a list of the paths git itself reports, so a
  // directory name can still be listed; what must never show up is the file.
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
  // `dsh web` is started from wherever the user is, and its process may carry no
  // DSH_HOME at all; the home is then `~/.dsh`, which is what os.homedir() reads.
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
  // The session edits the committed, ignored bundle; someone else edits src.
  writeFileSync(join(repo, 'dist', 'bundle.js'), 'var bundle = 2\n')
  writeFileSync(join(repo, 'src', 'app.js'), 'export const a = 2\n')
  const root = realpathSync(repo)

  const h = harness({
    cwd: repo,
    hasEvent: false,
    diffs: [],
    toolCalls: [{ name: 'write', arguments: { file_path: join(root, 'dist', 'bundle.js') } }],
    script: [answer('pass', [], 'never asked')],
  })
  const result = await h.invoke('session')
  assert.equal(result.kind, 'error', result.text)
  assert.ok(result.text.includes('excluded by the ignore rules'), result.text)
  assert.ok(result.text.includes('dist/bundle.js (dist/)'), 'the session file and its rule are named')
  assert.ok(!result.text.includes('none of them differs'), 'and the change is never called a no-op')
  assert.equal(h.seen.prompts.length, 0, 'no reviewer call is spent on it')

  // An ignored file the session never touched is not this run's business: a
  // session review that does have work reports no exclusion at all.
  writeFileSync(join(repo, 'src', 'app.js'), 'export const a = 3\n')
  const own = harness({
    cwd: repo,
    hasEvent: false,
    diffs: [],
    toolCalls: [{ name: 'write', arguments: { file_path: join(root, 'src', 'app.js') } }],
    script: [answer('pass', [], 'session file only')],
  })
  const second = await own.invoke('session')
  assert.equal(second.kind, 'success', second.text)
  const payload = payloadOf(second.text)
  assert.equal(payload.stats.reviewed, 1, 'the session file is reviewed')
  assert.equal(payload.stats.ignore.count, 0, "another file's exclusion is not reported as this run's")
}

console.log('selftest: all checks passed')
