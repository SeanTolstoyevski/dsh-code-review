/**
 * dsh-code-review — Host half: the human `/review` command audits the uncommitted
 * changes of one workspace in one of its modes. Nothing is ever written there.
 *
 * The six review tools are the protocol: no setting, mode or command line adds,
 * removes or renames one, and the report is assembled from what they stored, so a
 * run that stops early still reports what it kept. The evidence gate is the one
 * thing no mode can relax: a finding is published only if its verbatim quote
 * occurs in the diff or in what the reader tools returned.
 */
import { randomUUID } from 'node:crypto'
import { mkdirSync, readFileSync, readdirSync, realpathSync, statSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, isAbsolute, join, relative, resolve } from 'node:path'

export const name = 'code-review'

export const inject = ['commands', 'llm', 'workspaceChanges']

/** Payload contract shared with `client.js`. */
const SCHEMA = 'code-review/2'

const MARKER = '<!-- code-review:payload -->'

const DEFAULT_MODE_ID = 'cr'

/** One table per finding key, from which the store's skeleton, the accepted keys and the offered parameters are all derived. */
const FINDING_FIELDS = [
  {
    key: 'severity',
    required: true,
    blank: '',
    named: true,
    read: value => String(value).trim(),
    reject: (value, mode) => {
      const severity = typeof value === 'string' ? value.trim() : ''
      if (severity === '') return '"severity" must be a non-empty string'
      return mode.severities.some(entry => entry.id === severity)
        ? undefined
        : `"${severity}" is not a severity of mode "${mode.id}" — use one of: ${mode.severities.map(entry => entry.id).join(', ')}`
    },
    property: mode => {
      const ids = mode.severities.map(entry => entry.id)
      return { type: 'string', enum: ids, description: `the severity this finding claims — one of: ${ids.join(', ')}` }
    },
  },
  {
    key: 'category',
    required: false,
    blank: '',
    read: value => String(value).trim(),
    reject: value => (typeof value === 'string' ? undefined : '"category" must be a string'),
    property: mode => ({
      type: 'string',
      description: mode.categories.length === 0
        ? 'a short category for this finding'
        : `the category this finding belongs to — one of: ${mode.categories.join(', ')}`,
    }),
  },
  {
    key: 'file',
    required: true,
    blank: '',
    named: true,
    read: value => String(value).trim(),
    reject: value => (typeof value === 'string' ? undefined : '"file" must be a string'),
    property: () => ({ type: 'string', description: 'the path exactly as the diff names it' }),
  },
  {
    key: 'line',
    required: false,
    blank: null,
    named: true,
    read: value => (Number.isInteger(value) && value > 0 ? value : null),
    reject: value => (value === null || (Number.isInteger(value) && value > 0)
      ? undefined
      : `"line" must be a whole line number of the new file, or omitted (got ${JSON.stringify(value)})`),
    property: () => ({ type: 'integer', description: 'the line the diff shows for the new file; omit it when no single line applies' }),
  },
  {
    key: 'title',
    required: true,
    blank: '',
    named: true,
    read: value => String(value).trim(),
    reject: value => (typeof value === 'string' ? undefined : '"title" must be a string'),
    property: () => ({ type: 'string', description: 'a short, specific, imperative name for this finding' }),
  },
]

const FINDING_KEYS = FINDING_FIELDS.map(field => field.key)

/** Finding keys a mode may not declare as a field: the structure, plus the report's `summary` and the store's `id`. */
const RESERVED_FIELD_KEYS = new Set([...FINDING_KEYS, 'summary', 'id'])


const TONES = new Set(['error', 'warn', 'success', 'muted'])

const VERDICTS = new Set(['pass', 'warn', 'fail'])

const HUNK_HEADER = /^@@ -\d+(?:,(\d+))? \+\d+(?:,(\d+))? @@/

/** git's marker for a binary file, anchored at column 0 on purpose: hunk content always carries a `+`, `-` or space prefix, so no diff line can look like this. */
const BINARY_DIFF_MARKER = /^Binary files .+ differ$/m

/** The harness bounds a `notice` source summary to 120 characters. */
const NOTICE_SUMMARY_MAX_CHARS = 120

const NOTIFY_MODES = new Set(['steer', 'inject', 'off'])

/** The run settings; every key is a default a mode may override, and `modes` holds the modes themselves. Exported for the self-test. */
export const DEFAULTS = {
  mode: 'cr',
  provider: '',
  model: '',
  language: '',
  
  source: 'auto',
  
  gitRev: 'HEAD',
  /** The report is for the user: handing it to the Agent starts work nobody approved, so `steer` and `inject` are opt-in. */
  notifyAgent: 'off',
  projectAccess: true,
  maxToolCalls: 30,
  maxReadBytes: 524_288,
  toolDeadlineRatio: 0.8,
  maxSearchResults: 40,
  maxFiles: 25,
  maxDiffChars: 150_000,
  maxHintChars: 600,
  maxTokens: 50_000,
  temperature: 0.1,
  reasoningEffort: '',
  /** Covers the whole reader loop, not one model call. */
  timeoutMs: 600_000,
  ignored: [],
  ignoreDefaults: true,
  
  respectGitIgnore: true,
}


const FALLBACK_MAX_TOKENS = 8192

/**
 * The bounds of one review run, deliberately not settings: nothing a user
 * configures may shrink a review to where it cannot be recorded, or grow it into
 * one that never ends. `MAX_STORE_CALLS` bounds only the calls that change it, so
 * a run at the cap can still list, describe and close the review.
 */
const MAX_FINDINGS = 100
const MAX_STORE_CALLS = 300
const MAX_STEPS = 150
const MAX_NUDGES = 2

/**
 * Deliberately broad: the workspace may keep no `.gitignore` at all, and where one
 * exists the repository cannot be the only thing between the diff and a dependency
 * tree. Order matters exactly once — the `!.env.example` lines put back the sample
 * environment files that `.env.*` takes out.
 */
const DEFAULT_IGNORE = [
  '.git/', '.hg/', '.svn/', '.bzr/', '_darcs/', 'CVS/',
  'node_modules/', 'bower_components/', 'jspm_packages/', '.pnp.*', '.npm/', '.pnpm-store/',
  '.yarn/cache/', '.yarn/unplugged/', '.yarn/install-state.gz', '.yarn/build-state.yml',
  'vendor/', '.venv/', 'venv/', 'virtualenv/', 'site-packages/', '__pypackages__/',
  '.bundle/', 'Pods/', '.gradle/', '.m2/',
  'dist/', 'build/', 'out/', 'target/', 'obj/', '_build/', '.next/', '.nuxt/', '.output/',
  '.svelte-kit/', '.angular/', '.astro/', '.docusaurus/', '.parcel-cache/', '.turbo/', '.vite/',
  '.webpack/', 'storybook-static/', 'cmake-build-*/', 'CMakeFiles/', 'bazel-*', '_site/',
  '.jekyll-cache/', '*.class', '*.o', '*.obj', '*.a', '*.so', '*.dylib', '*.dll', '*.exe',
  '*.dSYM/', '*.gcda', '*.gcno', '*.gcov', '*.egg-info/', '.eggs/', '*.egg', '*.tsbuildinfo',
  '*.nupkg', '*.gem', '*.min.js', '*.min.css', '*.js.map', '*.css.map',
  '.cache/', '.sass-cache/', '.eslintcache', '.stylelintcache', '.nyc_output/', 'coverage/',
  'htmlcov/', '.coverage', '.pytest_cache/', '.mypy_cache/', '.ruff_cache/', '.pytype/',
  '.tox/', '.nox/', '.hypothesis/', '__pycache__/', '*.py[cod]', '*$py.class',
  '.ipynb_checkpoints/', '.terraform/', '.terragrunt-cache/', '.serverless/', '.fusebox/',
  '.dynamodb/', '.firebase/', 'mlruns/', 'wandb/', 'lightning_logs/', '.history/',
  '.node_repl_history',
  '.idea/', '.vscode/', '.vs/', '.fleet/', '.settings/', '.project', '.classpath', '*.iml',
  '*.swp', '*.swo', '*~', 'xcuserdata/', 'DerivedData/', '.build/', '.DS_Store', '._*',
  '.Spotlight-V100/', '.Trashes/', 'Thumbs.db', 'ehthumbs.db', 'desktop.ini', '$RECYCLE.BIN/',
  '*.lnk',
  '*.log', 'logs/', '*.tmp', '*.temp', '*.bak', '*.orig', '*.rej', '*.pid', '*.seed',
  '*.stackdump', '*.sqlite', '*.sqlite3', '*.db', 'local.properties',
  '.env', '.env.*', '!.env.example', '!.env.sample', '!.env.template', '!.env.dist',
]

const IGNORE_SAMPLE_MAX = 5

/** On Windows and macOS a path matches its own spelling in any case, and git follows the filesystem. */
const CASE_INSENSITIVE_MATCH = process.platform === 'win32' || process.platform === 'darwin'

const ELIDE_AFTER_BYTES = 200_000

const KEEP_RECENT_RESULTS = 2


const DEFAULT_FIELDS = [
  {
    key: 'problem',
    label: 'Problem',
    required: true,
    block: false,
    guide: 'what is wrong and why it matters, in your own words',
  },
  { key: 'evidence', label: 'Evidence', required: true, block: true, guide: '' },
]


const DEFAULT_SEVERITIES = [
  {
    id: 'blocker',
    label: 'blocker',
    tone: 'error',
    verdict: 'fail',
    meaning: 'the diff proves data corruption or loss, a security hole, or broken correctness on a path the diff shows is real.',
  },
  {
    id: 'major',
    label: 'major',
    tone: 'warn',
    verdict: 'fail',
    meaning: 'the diff proves wrong behaviour on a real path, or a crash, leak or unbounded growth under a reachable condition.',
  },
  {
    id: 'minor',
    label: 'minor',
    tone: 'muted',
    verdict: 'warn',
    meaning: 'the diff proves a real defect with low impact.',
  },
  {
    id: 'nit',
    label: 'nit',
    tone: 'muted',
    verdict: 'warn',
    meaning: 'the diff proves a cosmetic-level defect inside the changed lines, for example a comment that now describes the old behaviour. A style preference is not a nit; it is not a finding at all.',
  },
]

const DEFAULT_VERDICTS = { pass: 'PASS', warn: 'WARN', fail: 'FAIL' }

/** The part of a mode the user owns — who the reviewer is and what it will not report; everything mechanical is appended by `renderContract`. */
const CR_PERSONA = `You are a senior code reviewer auditing one change set that an AI coding agent produced in a live workspace. You receive the unified diffs of the changed files plus their change statistics, and you may read the workspace yourself with the read-only tools provided.

You are accountable for every finding you publish. A finding that turns out to be false, trivial, or unprovable is a defect in your review, and it costs the author real time and trust. A review that reports nothing is a perfectly good review. A review that pads its list with speculation is worse than no review at all. Judge the code, never what you assume the author intended, and never what you have not checked.

You look for defects in the changed lines: the change does not do what it claims, breaks a caller, loses data, races, leaks, swallows a failure, or is unusable through the interface it publishes.

## Never report — the marks of a junior reviewer

- Style, naming, formatting, import order, comment or documentation wishes, "consider extracting/renaming/simplifying".
- Reflex "add tests" or "add error handling". Tests are a finding only when the diff changes behaviour and the same diff shows the project's own test convention being skipped. Error handling is a finding only when the diff shows a concrete failure path being swallowed, ignored or left to crash.
- Restating what the diff does, or praising it.
- Anything you would have to phrase as "might", "could potentially", "ensure that", "it would be better if", "be careful that" — with no proven defect behind it.
- Duplicates: the same defect reported once per hunk or per call site.
- Guessed or invented details. Never invent a file name, line number, API, flag or behaviour that the diff does not show.`


const ARC_PERSONA = `You are a staff-level software architect auditing one change set that an AI coding agent produced in a live workspace. You receive the unified diffs of the changed files plus their change statistics, and you may read the workspace yourself with the read-only tools provided, so that a judgement about a module, a layer or a boundary rests on the project as it really is rather than on the diff alone.

You are accountable for every finding you publish. An architecture review is a conversation about a decision, not a list of preferences: a finding that turns out to be taste, or that you cannot tie to a concrete cost, costs the author real time and trust. A review that reports nothing is a perfectly good review — a change that puts the right code in the right place deserves that answer. Your summary is your verdict on the shape of this change.

## What this mode is for

You judge the shape of the change, not its defects. Wrong results, crashes, races, leaks and security holes belong to a separate defect review; do not spend your findings on them, unless the defect is itself the architectural problem — then report the architectural problem. Your questions are:

- Placement: does this code belong in this module, package or layer? Does the change reach across a boundary the rest of the project keeps?
- Responsibility: does the new function, type or module have one job, and is it the job its name and its published contract claim?
- Abstraction: is a concept missing, invented twice, or leaking — does a caller now need to know something the abstraction was supposed to hide?
- Coupling and direction: which way do the new dependencies point, does that match the project's existing direction, and what did this change make harder to move, replace or remove later?
- Interface shape: are the parameters, the return value and the failure contract of the new API the ones its callers need?
- Domain language: does the code name the concepts the way the rest of the project, and the domain, name them?
- Growth: what does this change cost the next person who has to extend it, configure it or test it?

## Never report

- Anything a defect review covers: a wrong result, a crash, a race, a leak, an unhandled failure, a missing guard.
- Style, formatting, import order, comment or documentation wishes.
- "I would have designed it differently", "consider extracting/renaming/simplifying", or any preference whose cost you cannot name concretely.
- Requirements you assume. If the right placement depends on a requirement this change set does not show, say that the decision is undecided rather than inventing the requirement.
- Restating what the diff does, or praising it.
- Duplicates: the same structural point once per file or per call site.
- Guessed or invented details. Never invent a module, a layer, an API or a behaviour the workspace does not show.`

const ARC_TASK = `Judge the architecture of this change set. Read the structural context the judgement needs — the neighbours of the changed files, the module or layer that owns the concept, the callers of the new API, the project's own conventions — and let what you find decide, not what you assume.

Every finding stays anchored to this change: the diff, or a file you read, must show the shape you are objecting to, and your alternative must be a change to this change set rather than a redesign of the project.

State the alternative you would accept — a placement, a boundary, a signature, a name — not only the objection. When the current shape is the better trade-off under a constraint the code shows, do not find against it.`

/** The modes this release ships, synced into the settings file — from then on the file decides, and deleting a key is how a default comes back. */
export const BUILT_IN_MODES = {
  cr: {
    label: 'Code review',
    aliases: ['code', 'codereview'],
    enabled: true,
    description: 'Audits the changed lines for defects: the change does not do what it claims, breaks a caller, loses data, races, leaks or swallows a failure.',
    systemPrompt: CR_PERSONA,
    task: '',
    categories: [
      'correctness', 'concurrency', 'error-handling', 'security',
      'api-misuse', 'performance', 'tests', 'consistency',
    ],
    fields: [
      {
        key: 'problem',
        label: '',
        required: true,
        block: false,
        guide: 'what is proven wrong and why it matters, in your own words',
      },
      {
        key: 'impact',
        label: 'Impact',
        required: true,
        block: false,
        guide: 'what actually goes wrong when this happens: the concrete damage, wrong behaviour or cost, in two or three sentences a reader who has not seen the code can follow. Not "this is a bug", not a restatement of the severity.',
      },
      {
        key: 'trigger',
        label: 'How it is reached',
        required: true,
        block: false,
        guide: 'the concrete scenario that reaches it: the inputs, the state and the call path, in two or three sentences. Name the real functions, files or endpoints involved, using what the diff and your reads showed you. "If the condition occurs" is not a scenario; "replaying a PGN that ends mid-move reaches this through ApplyMove, which then resets a board the caller still holds" is.',
      },
      {
        key: 'suggestion',
        label: 'Fix',
        required: false,
        block: false,
        guide: 'the concrete change to make',
      },
      { key: 'evidence', label: 'Evidence', required: true, block: true, guide: '' },
    ],
    severities: DEFAULT_SEVERITIES,
    verdicts: { ...DEFAULT_VERDICTS },
    settings: {},
  },
  arc: {
    label: 'Architecture review',
    aliases: ['architect', 'architecture'],
    enabled: true,
    description: 'Reviews the shape of the change — placement, responsibility, boundaries, coupling, naming, growth — with the project around it read for context.',
    systemPrompt: ARC_PERSONA,
    task: ARC_TASK,
    categories: [
      'module-boundary', 'responsibility', 'layering', 'coupling', 'abstraction',
      'api-shape', 'data-flow', 'naming', 'duplication', 'testability',
      'extensibility', 'consistency',
    ],
    fields: [
      {
        key: 'problem',
        label: '',
        required: true,
        block: false,
        guide: 'the architectural problem: the placement, responsibility, boundary or contract that is wrong, in your own words',
      },
      {
        key: 'consequence',
        label: 'Consequence',
        required: true,
        block: false,
        guide: 'what this shape costs: the coupling it adds, the change it makes harder, the concept it blurs or the test seam it removes, in two or three sentences a reader who has not seen the code can follow',
      },
      {
        key: 'alternative',
        label: 'Alternative',
        required: true,
        block: false,
        guide: 'the concrete restructuring you propose — where the code should live, whose job it should be, what the boundary, signature or name should be',
      },
      { key: 'evidence', label: 'Evidence', required: true, block: true, guide: '' },
    ],
    severities: [
      {
        id: 'high',
        label: 'high',
        tone: 'error',
        verdict: 'fail',
        meaning: 'the change puts a boundary, a responsibility or a contract in a place the project cannot live with, and undoing it later will be expensive.',
      },
      {
        id: 'medium',
        label: 'medium',
        tone: 'warn',
        verdict: 'warn',
        meaning: 'the shape is workable but it adds real coupling, hides a concept or makes the next change in this area harder.',
      },
      {
        id: 'low',
        label: 'low',
        tone: 'muted',
        verdict: 'warn',
        meaning: 'a real but local structural point: a name that does not match the domain, a boundary that is blurred without immediate cost.',
      },
    ],
    verdicts: { pass: 'sound', warn: 'worth discussing', fail: 'decide before merge' },
    settings: { maxToolCalls: 60 },
  },
}


const MODE_KEYS = [
  'label', 'aliases', 'enabled', 'description', 'systemPrompt', 'task',
  'categories', 'fields', 'severities', 'verdicts', 'settings',
]

function modeEntry(mode) {
  return Object.fromEntries(MODE_KEYS.filter(key => Object.hasOwn(mode, key)).map(key => [key, clone(mode[key])]))
}

const PROMPT_KEYS = ['systemPrompt', 'task', 'fields', 'severities', 'verdicts', 'categories']

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}


function clone(value) {
  return structuredClone(value)
}

function modeText(value) {
  return typeof value === 'string' ? value.trim() : ''
}

function nameList(value) {
  if (typeof value === 'string') return value.trim() === '' ? [] : [value.trim()]
  if (!Array.isArray(value)) return []
  return value.filter(entry => typeof entry === 'string' && entry.trim() !== '').map(entry => entry.trim())
}

/** `evidence` is appended and forced to required when the mode left it out — the gate is not optional. */
function normalizeFields(value, modeId, log) {
  if (value !== undefined && !Array.isArray(value)) {
    log.warn(`mode "${modeId}": "fields" is not an array; using the default fields`)
  }
  const declared = Array.isArray(value) ? value : []
  const fields = []
  const seen = new Set()
  for (const entry of declared) {
    if (!isPlainObject(entry)) {
      log.warn(`mode "${modeId}": a field entry is not a JSON object; dropped`)
      continue
    }
    const key = modeText(entry.key)
    if (key === '') {
      log.warn(`mode "${modeId}": a field entry has no "key"; dropped`)
      continue
    }
    if (RESERVED_FIELD_KEYS.has(key)) {
      log.warn(`mode "${modeId}": "${key}" is part of the finding structure and cannot be a field key; dropped`)
      continue
    }
    if (seen.has(key)) {
      log.warn(`mode "${modeId}": field "${key}" is declared twice; the first one stands`)
      continue
    }
    seen.add(key)
    fields.push({
      key,
      label: Object.hasOwn(entry, 'label') ? modeText(entry.label) : key,
      required: booleanSetting(entry.required, true) === true,
      block: booleanSetting(entry.block, false) === true,
      guide: modeText(entry.guide),
    })
  }
  if (declared.length === 0) return clone(DEFAULT_FIELDS)
  if (fields.length === 0) {
    log.warn(`mode "${modeId}": no usable field survived; using the default fields`)
    return clone(DEFAULT_FIELDS)
  }
  const evidence = fields.find(field => field.key === 'evidence')
  if (evidence === undefined) {
    fields.push(clone(DEFAULT_FIELDS[1]))
  } else if (!evidence.required || evidence.block !== true) {
    log.warn(`mode "${modeId}": "evidence" is required and shown as a block in every mode; the mode's own setting is ignored`)
    evidence.required = true
    evidence.block = true
  }
  return fields
}


function normalizeSeverities(value, modeId, log) {
  if (value !== undefined && !Array.isArray(value)) {
    log.warn(`mode "${modeId}": "severities" is not an array; using the default severities`)
  }
  const declared = Array.isArray(value) ? value : []
  const severities = []
  const seen = new Set()
  for (const entry of declared) {
    if (!isPlainObject(entry)) {
      log.warn(`mode "${modeId}": a severity entry is not a JSON object; dropped`)
      continue
    }
    const id = modeText(entry.id)
    if (id === '') {
      log.warn(`mode "${modeId}": a severity entry has no "id"; dropped`)
      continue
    }
    if (seen.has(id)) {
      log.warn(`mode "${modeId}": severity "${id}" is declared twice; the first one stands`)
      continue
    }
    seen.add(id)
    const verdict = modeText(entry.verdict)
    if (verdict !== '' && !VERDICTS.has(verdict)) {
      log.warn(`mode "${modeId}": severity "${id}" declares the verdict "${verdict}", which is not one of fail/warn/pass; treated as "warn"`)
    }
    const tone = modeText(entry.tone)
    if (tone !== '' && !TONES.has(tone)) {
      log.warn(`mode "${modeId}": severity "${id}" declares the tone "${tone}", which is not one of error/warn/success/muted; it is drawn like its verdict`)
    }
    severities.push({
      id,
      label: Object.hasOwn(entry, 'label') ? modeText(entry.label) : id,
      verdict: VERDICTS.has(verdict) ? verdict : 'warn',
      tone: TONES.has(tone) ? tone : undefined,
      meaning: modeText(entry.meaning),
    })
  }
  if (severities.length === 0) {
    if (declared.length > 0) log.warn(`mode "${modeId}": no usable severity survived; using the default severities`)
    return clone(DEFAULT_SEVERITIES)
  }
  for (const severity of severities) {
    if (severity.tone === undefined) severity.tone = severity.verdict === 'fail' ? 'error' : severity.verdict === 'warn' ? 'warn' : 'muted'
  }
  return severities
}


function normalizeVerdicts(value, modeId, log) {
  if (value !== undefined && !isPlainObject(value)) {
    log.warn(`mode "${modeId}": "verdicts" is not a JSON object; using the default labels`)
  }
  const declared = isPlainObject(value) ? value : {}
  const verdicts = {}
  for (const [key, fallback] of Object.entries(DEFAULT_VERDICTS)) {
    verdicts[key] = modeText(declared[key]) === '' ? fallback : modeText(declared[key])
  }
  return verdicts
}

/** The run settings a mode presets: they win over the file's own and lose to the command line. */
function normalizeModeSettings(value, modeId, log) {
  if (value === undefined) return {}
  if (!isPlainObject(value)) {
    log.warn(`mode "${modeId}": "settings" is not a JSON object; ignored`)
    return {}
  }
  const settings = {}
  for (const [key, entry] of Object.entries(value)) {
    if (key === 'mode' || key === 'modes') {
      log.warn(`mode "${modeId}": "settings.${key}" cannot be set by a mode; ignored`)
      continue
    }
    if (!Object.hasOwn(DEFAULTS, key)) {
      log.warn(`mode "${modeId}": "settings.${key}" is not a setting this plugin reads; ignored`)
      continue
    }
    settings[key] = entry
  }
  return settings
}


function sameJson(left, right) {
  return JSON.stringify(left ?? null) === JSON.stringify(right ?? null)
}


function promptUnchanged(entry, fallback) {
  return PROMPT_KEYS.every(key => sameJson(entry[key], fallback[key]))
}

/** Every key gets a usable value: what the user wrote where the user wrote it, the release default everywhere else. */
function normalizeMode(id, raw, fallback, log) {
  const entry = isPlainObject(raw) ? raw : {}
  if (raw !== undefined && !isPlainObject(raw)) log.warn(`mode "${id}" is not a JSON object; using its default`)
  const base = isPlainObject(fallback) ? fallback : {}
  return {
    id,
    label: modeText(entry.label) === '' ? (modeText(base.label) === '' ? id : modeText(base.label)) : modeText(entry.label),
    description: modeText(entry.description) === '' ? modeText(base.description) : modeText(entry.description),
    aliases: nameList(entry.aliases ?? base.aliases),
    enabled: booleanSetting(entry.enabled, base.enabled !== false) === true,
    systemPrompt: Object.hasOwn(entry, 'systemPrompt') ? modeText(entry.systemPrompt) : modeText(base.systemPrompt),
    task: Object.hasOwn(entry, 'task') ? modeText(entry.task) : modeText(base.task),
    categories: nameList(entry.categories ?? base.categories),
    fields: normalizeFields(Object.hasOwn(entry, 'fields') ? entry.fields : base.fields, id, log),
    severities: normalizeSeverities(Object.hasOwn(entry, 'severities') ? entry.severities : base.severities, id, log),
    verdicts: normalizeVerdicts(Object.hasOwn(entry, 'verdicts') ? entry.verdicts : base.verdicts, id, log),
    settings: normalizeModeSettings(Object.hasOwn(entry, 'settings') ? entry.settings : base.settings, id, log),

    builtIn: fallback !== undefined,

    promptFrom: fallback === undefined || (isPlainObject(raw) && !promptUnchanged(raw, fallback)) ? 'file' : 'default',
  }
}


function resolveModes(settings, log) {
  const declared = isPlainObject(settings.modes) ? settings.modes : {}
  const modes = []
  for (const [id, fallback] of Object.entries(BUILT_IN_MODES)) {
    modes.push(normalizeMode(id, Object.hasOwn(declared, id) ? declared[id] : fallback, fallback, log))
  }
  for (const [id, raw] of Object.entries(declared)) {
    if (Object.hasOwn(BUILT_IN_MODES, id)) continue
    if (!isPlainObject(raw)) {
      log.warn(`mode "${id}" is not a JSON object; the mode is not offered`)
      continue
    }
    modes.push(normalizeMode(id, raw, undefined, log))
  }
  const byId = new Map()
  const byAlias = new Map()
  for (const mode of modes) {
    const key = mode.id.toLowerCase()
    if (!byId.has(key)) byId.set(key, mode)
  }
  for (const mode of modes) {
    for (const alias of mode.aliases) {
      const key = alias.toLowerCase()
      if (key === '' || byId.has(key) || byAlias.has(key)) continue
      byAlias.set(key, mode)
    }
  }
  for (const [key, mode] of byId) byAlias.set(key, mode)
  return { modes, lookup: name => byAlias.get(name) ?? undefined }
}


function availableModes(modes) {
  const enabled = modes.filter(mode => mode.enabled)
  const list = enabled.map(mode => `${mode.id} (${mode.label})`).join(', ')
  return list === '' ? 'none are enabled' : `available: ${list}`
}

/**
 * Which mode this run uses: what was typed, else the file's `mode`, else `cr`. A
 * typed name that does not resolve is an error, because answering as another mode
 * would lie about the report; a broken default in the file only warns.
 */
function resolveMode(settings, overrides, log) {
  const { modes, lookup } = resolveModes(settings, log)
  const typed = modeText(overrides.mode)
  const configured = modeText(settings.mode)
  const requested = typed === '' ? configured : typed
  const name = requested === '' ? DEFAULT_MODE_ID : requested
  const mode = lookup(name.toLowerCase())
  if (mode !== undefined && mode.enabled === true) return { mode }
  if (typed !== '') {
    return {
      failure: mode === undefined
        ? `unknown mode "${typed}" — ${availableModes(modes)}. Add your own under "modes" in ${configPath()}, or run /review without mode= for the default.`
        : `mode "${typed}" is disabled — ${availableModes(modes)}`,
    }
  }
  if (mode !== undefined) log.warn(`the configured mode "${configured}" is disabled`)
  else if (configured !== '') log.warn(`the configured mode "${configured}" does not exist — ${availableModes(modes)}`)
  const fallback = modes.find(entry => entry.enabled === true)
  if (fallback === undefined) {
    return { failure: `no mode is enabled — every mode in ${configPath()} has "enabled": false` }
  }
  if (fallback.id.toLowerCase() !== name.toLowerCase()) log.warn(`using the mode "${fallback.id}" instead`)
  return { mode: fallback }
}

/**
 * The last word on reading when the run can read: it names exactly the tools this
 * deployment offers, so a run given two of them is never told it has three.
 */
function readingSection(names) {
  const list = names.length === 1 ? names[0] : `${names.slice(0, -1).join(', ')} and ${names.at(-1)}`
  const count = ['zero', 'one', 'two', 'three'][names.length] ?? String(names.length)
  const pronoun = names.length === 1 ? 'It is' : 'They are'
  const verb = names.length === 1 ? 'it cannot' : 'they cannot'
  const uses = names.length === 1 ? 'it' : 'them'
  return `## Reading the project

You have ${count} read-only tool${names.length === 1 ? '' : 's'}: ${list}. ${pronoun} the only way you touch the workspace, and ${verb} change anything or run anything — there is no command execution, no write, and no network. Paths the review excluded as ignored — dependency trees, build output, caches — are outside the project as far as you are concerned: they are not in the diff, the tools refuse them, and nothing found in them is a finding.

Use ${uses} to settle a specific question, not to explore:
- Before recording a finding that depends on code outside the diff — a caller's arguments, a function's contract, a type's definition, whether a guard already exists upstream — read that code and confirm it. A suspicion you did not check is not a finding.
- Also read when the diff alone is genuinely ambiguous about what the change does.
- Do not tour the repository, do not read files unrelated to the change, and do not read a file twice to look for more. The budget is small and it is shown to you as it shrinks.
- Reading is for verification, never for finding extra work to report. Anything you notice outside the change set is out of scope unless this diff makes it reachable or worse.`
}

/** The last word on reading when it cannot: it replaces every mention of the read tools in the persona above. */
const NO_READING_SECTION = `## Reading the project

This run cannot read the project: there are no read-only tools here, and this section replaces every other mention of reading the workspace, including any in your role above. Decide from the diff alone. A finding that depends on a caller, a definition, a guard or any other file you cannot see does not meet the evidence bar here — leave it out rather than assuming what it says.`

/**
 * What every mode is told, whatever its persona says: appended to the mode's own
 * prompt and not writable by it, because these are the rules the run is verified
 * against.
 */
function renderContract(mode, { readers }) {
  const fields = mode.fields
    .map(field => `- "${field.key}" (${field.label === '' ? field.key : field.label})${field.required ? ' — required' : ' — optional'}${field.guide === '' ? '' : `: ${field.guide}`}`)
    .join('\n')
  const severities = mode.severities
    .map(severity => `- ${severity.id} (${severity.label}) — ${severity.verdict === 'pass' ? 'does not move the verdict' : `forces the verdict to "${severity.verdict}" at least`}${severity.meaning === '' ? '' : `: ${severity.meaning}`}`)
    .join('\n')
  const categories = mode.categories.length === 0
    ? ''
    : `\n## Categories\n\n${mode.categories.join(', ')}\n`
  return `${readers.length === 0 ? NO_READING_SECTION : readingSection(readers)}

## Evidence bar — this is the whole job

- Every finding MUST quote, in "evidence", the exact line or lines that prove it, copied verbatim: a diff line including its leading "+", "-" or space, or a line from a file you actually read.
- Every quoted line is checked mechanically against the diff and against everything the tools returned to you — when you record the finding and again when the report is built. A quote that does not occur there is recorded as withheld and never published, so copy the line rather than typing it from memory.
- If you cannot quote such lines, you do not have a finding. Drop it completely: do not record it, do not hint at it, do not mention it in your summary, do not downgrade it into a "consider" note.
- Reachability counts. A problem that requires an input, state or call path that the code shows to be impossible is not a finding.
- Pre-existing code is not yours to review. Report a pre-existing problem only when this diff makes it reachable or worse, and say which changed line does that.

## What a finding must state

${fields}

Every field marked required must be answered in the finding's own words, at the depth its guide asks for. A finding that cannot answer one of them is recorded as withheld and never published.

## Severity

${severities}

Never inflate a severity: you will be held to it. If you hesitate between two severities, choose the lower one. A matter of taste is not the lowest severity; it is not a finding at all.
${categories}
## Recording the review

Your review is the findings you record with the review tools. Nothing you write in your own answer reaches the report: the report is built from the store the moment you call finish_review. The tools are:

- append_finding — record one finding as soon as it is settled rather than holding it until the end. A run that stops early keeps everything already recorded, and nothing else. severity is one of the ids in the table above; file, line and title name the finding; every field listed above is a string.
- update_finding — change a finding already recorded, by the id append_finding returned: a quote, a field, a severity, a title. Send only what changes.
- delete_finding — drop a finding a later look invalidated, so the report never carries a claim you no longer stand behind.
- list_findings — every finding recorded so far, with its id and whether the evidence gate can publish it.
- set_summary — record the 2-4 factual sentences that open the report: what the change set does and whether it holds up, mentioning only what you kept.
- finish_review — end the review and build the report from the store. Recording nothing and finishing is a complete, respectable review when there is nothing to report.

A call the store refuses changes nothing and answers with what was wrong with it: fix the call and make it again. A finding the gate cannot publish is still recorded — as withheld, with its reason returned to you — so nothing you record is ever lost, and a withheld finding never carries the verdict.

## Before you finish

Call list_findings and delete every finding that fails any of these: (a) it carries a verbatim quote that occurs in the diff or in something the tools returned; (b) everything it depends on has been read and confirmed, not assumed; (c) the path or the consequence it describes is reachable per what you read, and you can describe it; (d) every required field is answered in concrete terms; (e) it is the kind of problem this mode is here to find, not a matter of taste; (f) it is worth an expert author's attention. Then record the summary with set_summary, re-check that it describes only what you kept, and call finish_review.`
}

/** The persona plus the contract it cannot change; `readers` is the list the tool offer is built from, so the two cannot describe different runs. */
function systemPromptFor(mode, options) {
  const contract = renderContract(mode, options)
  return mode.systemPrompt === '' ? contract : `${mode.systemPrompt}\n\n${contract}`
}


function expandHomePath(path) {
  if (path === '~') return homedir()
  if (path.startsWith('~/') || path.startsWith('~\\')) return join(homedir(), path.slice(2))
  return path
}

/**
 * `$DSH_HOME` when it is set and not blank, otherwise `~/.dsh` — the way the
 * harness itself resolves it; the working directory is deliberately not a
 * candidate, because `dsh web` starts from wherever the user happens to be.
 * Mirrors `resolveDshHome` from `@deepseek-ai/dsh-home-paths`, repeated because
 * this package has no dependencies.
 */
function dshHome() {
  const configured = process.env.DSH_HOME
  const selected = typeof configured === 'string' && configured.trim() !== ''
    ? configured
    : join(homedir(), '.dsh')
  return resolve(expandHomePath(selected))
}

function configPath() {
  return join(dshHome(), 'code-review', 'config.json')
}

function defaultDocument() {
  return {
    ...clone(DEFAULTS),
    modes: Object.fromEntries(Object.entries(BUILT_IN_MODES).map(([id, mode]) => [id, modeEntry(mode)])),
  }
}

/**
 * Creates the file the user is told to edit, with the defaults, when it is
 * missing. Exclusive create is the whole contract: an existing file is never
 * touched, and a concurrent boot loses the race with EEXIST rather than
 * truncating the winner's file.
 */
function ensureSettingsFile(log) {
  const file = configPath()
  try {
    mkdirSync(dirname(file), { recursive: true })
    writeFileSync(file, `${JSON.stringify(defaultDocument(), null, 2)}\n`, { encoding: 'utf8', flag: 'wx' })
    log.info(`created ${file} with the default settings and the built-in modes — edit it to tune the review; every run re-reads it`)
    return true
  } catch (error) {
    if (error?.code === 'EEXIST') return false
    log.warn(`cannot create ${file}: ${String(error)}; using the default settings`)
    return false
  }
}

/**
 * Adds what the file is missing and never replaces a value the user wrote; a
 * value of the wrong shape is reported and left as it is. Deleting a key is how
 * the release default comes back, and a built-in mode leaves the command surface
 * with `"enabled": false`.
 */
function syncDocument(parsed, log) {
  const doc = { ...parsed }
  const added = []
  for (const [key, value] of Object.entries(DEFAULTS)) {
    if (Object.hasOwn(doc, key)) continue
    doc[key] = clone(value)
    added.push(key)
  }
  if (doc.modes === undefined) {
    doc.modes = Object.fromEntries(Object.entries(BUILT_IN_MODES).map(([id, mode]) => [id, modeEntry(mode)]))
    added.push('modes')
  } else if (!isPlainObject(doc.modes)) {
    log.warn(`${configPath()}: "modes" is not a JSON object; the built-in modes are used and the file is left as it is`)
  } else {
    const modes = { ...doc.modes }
    for (const [id, fallback] of Object.entries(BUILT_IN_MODES)) {
      const current = modes[id]
      if (current === undefined) {
        modes[id] = modeEntry(fallback)
        added.push(`modes.${id}`)
        continue
      }
      if (!isPlainObject(current)) {
        log.warn(`${configPath()}: mode "${id}" is not a JSON object; its default is used and the file is left as it is`)
        continue
      }
      const filled = { ...current }
      for (const key of MODE_KEYS) {
        if (!Object.hasOwn(fallback, key) || Object.hasOwn(filled, key)) continue
        filled[key] = clone(fallback[key])
        added.push(`modes.${id}.${key}`)
      }
      modes[id] = filled
    }
    doc.modes = modes
  }
  return { doc, added }
}

function writeSynced(log, file, doc, added) {
  try {
    writeFileSync(file, `${JSON.stringify(doc, null, 2)}\n`, { encoding: 'utf8' })
    log.info(`synced ${added.join(', ')} into ${file}`)
  } catch (error) {
    log.warn(`cannot write ${file}: ${String(error)}; this run uses the values in memory`)
  }
}

/** The settings of this run, re-read on every `/review`, so tuning needs neither a restart nor a reload. */
function loadSettings(log) {
  const file = configPath()
  let raw
  try {
    raw = readFileSync(file, 'utf8')
  } catch (error) {
    if (error?.code !== 'ENOENT') {
      log.warn(`cannot read ${file}: ${String(error)}; using defaults`)
      return { ...clone(DEFAULTS) }
    }
    ensureSettingsFile(log)
    try {
      raw = readFileSync(file, 'utf8')
    } catch (again) {
      log.warn(`cannot read ${file}: ${String(again)}; using defaults`)
      return { ...clone(DEFAULTS) }
    }
  }
  let parsed
  try {
    parsed = JSON.parse(raw)
  } catch (error) {
    log.warn(`${file} is not valid JSON (${String(error)}); using defaults`)
    return { ...clone(DEFAULTS) }
  }
  if (!isPlainObject(parsed)) {
    log.warn(`${file} is not a JSON object; using defaults`)
    return { ...clone(DEFAULTS) }
  }
  const { doc, added } = syncDocument(parsed, log)
  if (added.length > 0) writeSynced(log, file, doc, added)
  return { ...clone(DEFAULTS), ...doc }
}


const ARG_KEYS = new Set([
  'mode', 'provider', 'model', 'reasoningEffort', 'language', 'gitRev', 'source',
  'ignored', 'ignore', 'ignoreDefaults', 'respectGitIgnore',
])


const ARG_TOKEN = /^([A-Za-z]+)=(?:"([^"]*)"|'([^']*)'|(\S+))(?:\s+|$)/

/** `/review [full|session] [key=value …] [focus message]`; only leading arguments are parsed, so the focus message may contain anything, including '=' and the word "session". */
function parseInvocation(rawInput) {
  let rest = String(rawInput ?? '').trim()
  const overrides = {}
  const ignored = []
  let scope
  for (;;) {
    const scopeToken = scope === undefined ? /^(full|session)(?:\s+|$)/.exec(rest) : null
    if (scopeToken !== null) {
      scope = scopeToken[1]
      rest = rest.slice(scopeToken[0].length)
      continue
    }
    const match = ARG_TOKEN.exec(rest)
    if (match === null || !ARG_KEYS.has(match[1])) break
    const key = match[1] === 'ignore' ? 'ignored' : match[1]
    const value = match[2] ?? match[3] ?? match[4]
    if (key === 'ignored') ignored.push(...ignorePatternsFrom(value))
    else overrides[key] = value
    rest = rest.slice(match[0].length)
  }
  if (ignored.length > 0) overrides.ignored = ignored
  return { scope, overrides, message: rest.trim() }
}

function positiveInt(value, fallback) {
  const n = Number(value)
  return Number.isInteger(n) && n > 0 ? n : fallback
}


function firstNonEmpty(...values) {
  for (const value of values) {
    if (typeof value === 'string' && value !== '') return value
  }
  return undefined
}

/**
 * The thinking level this run asks for: what was typed, else the mode's preset,
 * else the file's own. The layers are read apart on purpose — spreading the merged
 * settings would let an empty mode preset erase a level the file carries.
 */
function resolveReasoningEffort(mode, fileSettings, overrides) {
  return firstNonEmpty(
    modeText(overrides.reasoningEffort),
    modeText(mode.settings.reasoningEffort),
    modeText(fileSettings.reasoningEffort),
  )
}

/** A level the model does not offer is refused before any call, with the ones it does name; when the adapter cannot be asked (an unregistered route, a middleware-served one), the call is the judge. */
async function checkReasoningEffort(ctx, route, effort, signal) {
  if (effort === undefined || typeof ctx.llm.resolveModelInfo !== 'function') return undefined
  let info
  try {
    info = await ctx.llm.resolveModelInfo(route.provider, route.model, signal)
  } catch {
    return undefined
  }
  const efforts = info?.reasoning?.efforts
  if (!Array.isArray(efforts) || efforts.length === 0) {
    return `${route.provider}/${route.model} declares no reasoning levels, so reasoningEffort "${effort}" cannot be used.` +
      ` Delete "reasoningEffort" in ${configPath()} or drop reasoningEffort= from the command.`
  }
  if (efforts.some(entry => entry?.id === effort)) return undefined
  return `reasoningEffort "${effort}" is not offered by ${route.provider}/${route.model} — available: ${efforts.map(entry => entry.id).join(', ')}.` +
    ` Fix "reasoningEffort" in ${configPath()} or drop reasoningEffort= from the command.`
}

function clamp(text, max) {
  const value = typeof text === 'string' ? text.trim() : ''
  return value.length > max ? `${value.slice(0, max)}…` : value
}

function escapeRegExpText(text) {
  return String(text).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

const GLOB_CHARS = /[*?[\]\\]/


function globBody(pattern) {
  let out = ''
  let literal = ''
  const flush = () => {
    if (literal === '') return
    out += escapeRegExpText(literal)
    literal = ''
  }
  for (let index = 0; index < pattern.length; index += 1) {
    const char = pattern[index]
    if (char === '\\' && index + 1 < pattern.length) {
      literal += pattern[index + 1]
      index += 1
      continue
    }
    if (char === '*') {
      const start = index
      while (pattern[index + 1] === '*') index += 1
      const stars = index - start + 1
      const boundary = start === 0 || pattern[start - 1] === '/'
      flush()
      // `**/` spans zero or more directories; every other run of stars is a plain `*`, which is also how git reads `a**b`.
      if (stars > 1 && boundary && pattern[index + 1] === '/') {
        out += '(?:[^/]+/)*'
        index += 1
        continue
      }
      out += '[^/]*'
      continue
    }
    if (char === '?') {
      flush()
      out += '[^/]'
      continue
    }
    if (char === '[') {
      const end = pattern.indexOf(']', index + 1)
      if (end < 0) {
        literal += char
        continue
      }
      const body = pattern.slice(index + 1, end)
      flush()
      out += `[${
        body.startsWith('!') ? `^${body.slice(1)}` : body.startsWith('^') ? `\\^${body.slice(1)}` : body
      }]`
      index = end
      continue
    }
    literal += char
  }
  flush()
  return out
}

/**
 * One gitignore-style pattern compiled into a matcher over slash-separated paths.
 * A pattern naming a directory also covers everything under it — git's own rule —
 * expressed here as an optional `/…` tail, because every candidate offered to a
 * rule is a file path. A single plain name carries the name rather than a regular
 * expression, since "any component of the path equals it" is exactly what its
 * expression would have tested; see `createIgnore`.
 */
function compileIgnoreRule(pattern, source) {
  const label = String(pattern ?? '').trim()
  if (label === '' || label.startsWith('#')) return undefined
  const negated = label.startsWith('!')
  let text = negated ? label.slice(1).trim() : label.startsWith('\\!') ? label.slice(1) : label
  if (text.endsWith('/')) text = text.replace(/\/+$/, '')
  // `a/**` means everything under `a`, which is what a directory pattern means here.
  if (text.endsWith('/**')) text = text.slice(0, -3)
  if (text === '') return { label, negated, source, regex: /^/ }
  let anchored = false
  let anyDepth = false
  if (text.startsWith('**/')) {
    anyDepth = true
    text = text.slice(3)
  } else {
    if (text.startsWith('/')) {
      anchored = true
      text = text.slice(1)
    }
    if (text.startsWith('**/')) {
      anyDepth = true
      anchored = false
      text = text.slice(3)
    }
  }
  if (!anyDepth && text.includes('/')) anchored = true
  if (text === '') return { label, negated, source, regex: /^/ }
  if (!anchored && !text.includes('/') && !GLOB_CHARS.test(text)) {
    return { label, negated, source, name: text }
  }
  const prefix = anchored ? '^' : '(?:^|.*/)'
  const suffix = '(?:/.*)?$'
  const flags = CASE_INSENSITIVE_MATCH ? 'i' : ''
  let regex
  try {
    regex = new RegExp(`${prefix}${globBody(text)}${suffix}`, flags)
  } catch {
    regex = new RegExp(`${prefix}${escapeRegExpText(text)}${suffix}`, flags)
  }
  return { label, negated, source, regex }
}

function normalizeIgnorePath(path) {
  return String(path ?? '').replace(/\\/g, '/').replace(/^\.\/+/, '')
}


function ignorePatternsFrom(value) {
  if (typeof value === 'string') return value.split(/[\n,]/)
  if (Array.isArray(value)) return value.filter(entry => typeof entry === 'string')
  return []
}

function booleanSetting(value, fallback) {
  if (typeof value === 'boolean') return value
  if (typeof value === 'string') {
    const text = value.trim().toLowerCase()
    if (text === 'true' || text === '1' || text === 'yes' || text === 'on') return true
    if (text === 'false' || text === '0' || text === 'no' || text === 'off') return false
  }
  return fallback
}


function resolveBoolean(typed, configured, fallback, key, log) {
  const fromConfig = booleanSetting(configured, fallback)
  if (typed === undefined) return fromConfig
  const parsed = booleanSetting(typed, undefined)
  if (parsed === undefined) {
    log.warn(`/review ${key}=${typed} is not a boolean; using ${fromConfig}`)
    return fromConfig
  }
  return parsed
}

function resolveIgnoreSettings(settings, overrides, log) {
  return {
    defaults: resolveBoolean(overrides.ignoreDefaults, settings.ignoreDefaults, DEFAULTS.ignoreDefaults, 'ignoreDefaults', log),
    respectGit: resolveBoolean(overrides.respectGitIgnore, settings.respectGitIgnore, DEFAULTS.respectGitIgnore, 'respectGitIgnore', log),
    config: ignorePatternsFrom(settings.ignored),
    typed: Array.isArray(overrides.ignored) ? overrides.ignored : [],
  }
}

const GIT_IGNORE_RULE = { label: "the repository's own ignore rules", source: 'git', negated: false }

/**
 * The ignore policy of one run. Rules are evaluated in order and the LAST match
 * decides, so config and command line override the built-in list. The repository's
 * own ignored paths are a base layer rather than a rule, deciding only when no
 * pattern matched at all.
 */
function createIgnore({ defaults = true, config = [], typed = [], gitLayer = false, gitIgnored = [] }) {
  const layers = [
    ['built-in', defaults ? DEFAULT_IGNORE : []],
    ['config', config],
    ['typed', typed],
  ]
  const rules = []
  const counts = { 'built-in': 0, config: 0, typed: 0 }
  for (const [source, patterns] of layers) {
    for (const pattern of patterns) {
      const rule = compileIgnoreRule(pattern, source)
      if (rule === undefined) continue
      if (rule.name !== undefined && CASE_INSENSITIVE_MATCH) rule.name = rule.name.toLowerCase()
      rules.push(rule)
      counts[source] += 1
    }
  }
  // One pass over a path's components decides every plain-name rule at once; only the real globs reach an expression.
  const names = new Set(rules.filter(rule => rule.name !== undefined).map(rule => rule.name))
  const gitPaths = new Set()
  for (const path of gitIgnored) {
    const text = normalizeIgnorePath(path)
    if (text !== '') gitPaths.add(CASE_INSENSITIVE_MATCH ? text.toLowerCase() : text)
  }

  return {
    facts: {
      builtIn: defaults === true,
      builtInPatterns: counts['built-in'],
      configured: counts.config,
      typed: counts.typed,
      gitIgnore: gitLayer === true,
    },
    ruleFor(path) {
      const candidate = normalizeIgnorePath(path)
      if (candidate === '') return undefined
      // `named` is only built when a rule carries a name, which is the only case the loop below reads it.
      let named
      if (names.size > 0) {
        named = new Set()
        for (const part of candidate.split('/')) {
          const key = CASE_INSENSITIVE_MATCH ? part.toLowerCase() : part
          if (names.has(key)) named.add(key)
        }
      }
      let matched
      for (const rule of rules) {
        const hit = rule.name === undefined ? rule.regex.test(candidate) : named.has(rule.name)
        if (hit) matched = rule
      }
      if (matched !== undefined) return matched.negated ? undefined : matched
      if (gitPaths.size === 0) return undefined
      return gitPaths.has(CASE_INSENSITIVE_MATCH ? candidate.toLowerCase() : candidate)
        ? GIT_IGNORE_RULE
        : undefined
    },
  }
}


function partitionIgnored(ignore, entries) {
  const kept = []
  const excluded = []
  for (const entry of entries) {
    const rule = ignore.ruleFor(entry.path)
    if (rule === undefined) kept.push(entry.value)
    else excluded.push({ file: entry.name, path: entry.path, rule: rule.label })
  }
  return { kept, excluded }
}

function ignoreStats(ignore, excluded) {
  return {
    ...ignore.facts,
    count: excluded.length,
    sample: excluded.slice(0, IGNORE_SAMPLE_MAX).map(item => ({ file: item.file, rule: item.rule })),
  }
}

function ignoreRuleLine(ignore) {
  if (ignore === undefined) return ''
  const parts = []
  if (ignore.builtIn) parts.push(`built-in standard list (${ignore.builtInPatterns} patterns)`)
  if (ignore.configured > 0) parts.push(`${ignore.configured} configured`)
  if (ignore.typed > 0) parts.push(`${ignore.typed} typed`)
  if (ignore.gitIgnore) parts.push("the repository's own ignore rules")
  return parts.join(' + ')
}


function excludedText(items) {
  return items.slice(0, IGNORE_SAMPLE_MAX).map(item => `${item.file} (${item.rule})`).join(', ')
}

function ignoreSampleText(ignore) {
  return excludedText(ignore.sample)
}

/**
 * The paths this session wrote or edited, read from its own `write`/`edit` calls.
 * The session log is durable, so this survives a restart. `root` is canonicalized
 * first because `resolveInside` answers with a canonical path, which a symlinked
 * workspace would otherwise fail to match.
 */
function sessionTouchedPaths(session, root) {
  if (typeof session?.snapshotEvents !== 'function') return []
  let base = root
  try {
    base = realpathSync(root)
  } catch {
    base = root
  }
  const paths = new Set()
  for (const event of session.snapshotEvents()) {
    if (event?.type !== 'tool/call') continue
    const name = event.data?.name
    if (name !== 'write' && name !== 'edit') continue
    let args
    try {
      args = JSON.parse(event.data?.arguments ?? '')
    } catch {
      continue
    }
    const file = args?.file_path ?? args?.path
    if (typeof file !== 'string' || file.trim() === '') continue
    const target = resolveInside(base, file)
    if (target === undefined) continue
    const rel = relative(base, target).replace(/\\/g, '/')
    if (rel !== '') paths.add(rel)
  }
  return [...paths]
}

/** Recorded `workspace/changes` sequence numbers, newest first. */
function changeSeqs(session) {
  if (typeof session?.snapshotEvents !== 'function') return []
  const seqs = []
  for (const event of session.snapshotEvents()) {
    if (event?.type === 'workspace/changes') seqs.push(event.seq)
  }
  return seqs.reverse()
}

function renderUnifiedDiff(diff) {
  const from = diff.before ? `a/${diff.path}` : '/dev/null'
  const to = diff.after ? `b/${diff.path}` : '/dev/null'
  const lines = [`--- ${from}`, `+++ ${to}`]
  for (const hunk of diff.hunks) {
    lines.push(`@@ -${hunk.oldStart},${hunk.oldLines} +${hunk.newStart},${hunk.newLines} @@`)
    for (const line of hunk.lines) lines.push(line)
  }
  if (diff.coarse) lines.push('# (this comparison was too large to align line by line)')
  return lines.join('\n')
}


async function collectSessionChanges(ctx, session, seq, settings, signal) {
  const summary = ctx.workspaceChanges.summary(session.id, seq)
  if (summary === undefined) return { failure: 'unavailable' }

  const files = Array.isArray(summary.files) ? summary.files : []
  const ignore = createIgnore(settings.ignore)
  // The ignore rules decide before anything is fetched, and the index the record diffs a file by is carried along, so a filtered list stays addressable.
  const { kept, excluded } = partitionIgnored(ignore, files.map((file, index) => {
    const name = file?.display ?? file?.path ?? `#${index}`
    return { path: file?.path ?? name, name, value: { index, name } }
  }))

  const skipped = []
  const parts = []
  const paths = []
  let chars = 0
  let reviewed = 0

  for (const { index, name } of kept) {
    if (reviewed >= settings.maxFiles) {
      skipped.push({ file: name, reason: 'over-file-limit' })
      continue
    }
    let diff
    try {
      diff = await ctx.workspaceChanges.diff(session.id, seq, index, signal)
    } catch (error) {
      skipped.push({ file: name, reason: `read-failed: ${String(error)}` })
      continue
    }
    if (diff === undefined) {
      skipped.push({ file: name, reason: 'unavailable' })
      continue
    }
    if (diff.kind !== 'text') {
      skipped.push({ file: name, reason: diff.kind })
      continue
    }
    const text = renderUnifiedDiff(diff)
    if (chars + text.length > settings.maxDiffChars) {
      skipped.push({ file: name, reason: 'over-diff-budget' })
      continue
    }
    chars += text.length
    reviewed += 1
    parts.push(text)
    paths.push(diff.display ?? diff.path ?? name)
  }

  return {
    source: 'session',
    summary,
    diffs: parts.join('\n\n'),
    paths,
    reviewed,
    skipped,
    ignore: ignoreStats(ignore, excluded),
    files: kept.length,
    filesTotal: files.length,

    policy: ignore,
  }
}

/**
 * Added/deleted line counts of a unified diff, matching `git diff --numstat`. The
 * `+`, `-` and `---` prefixes cannot be classified on their own: a diff line is
 * the prefix *plus* the content, so an added `++counter;` renders as
 * `+++counter;`, byte-identical to a `+++ b/path` file header. Counting is
 * therefore bounded by the hunk structure: only what a `@@` header declares for
 * each side is counted.
 */
function countDiffLines(text) {
  let added = 0
  let deleted = 0
  let old = 0
  let newer = 0
  for (const line of text.split('\n')) {
    if (old > 0 || newer > 0) {
      // `\ No newline at end of file` annotates the line before it and counts as neither side.
      if (line.startsWith('\\')) continue
      if (line.startsWith('+')) {
        added += 1
        newer -= 1
        continue
      }
      if (line.startsWith('-')) {
        deleted += 1
        old -= 1
        continue
      }
      // A file boundary can only start at column 0 — every hunk line carries a prefix — and it ends a hunk whose counts ran out early.
      if (line.startsWith('diff --git ')) {
        old = 0
        newer = 0
        continue
      }

      old -= 1
      newer -= 1
      continue
    }
    const header = HUNK_HEADER.exec(line)
    if (header !== null) {
      old = header[1] === undefined ? 1 : Number(header[1])
      newer = header[2] === undefined ? 1 : Number(header[2])
    }
  }
  return { added, deleted }
}


function renderNewFileDiff(path, content) {
  const lines = content.split('\n')
  if (lines.at(-1) === '') lines.pop()
  return [
    '--- /dev/null',
    `+++ b/${path}`,
    `@@ -0,0 +1,${lines.length} @@`,
    ...lines.map(line => `+${line}`),
  ].join('\n')
}


function parseGitStatus(text) {
  const entries = []
  for (const record of String(text).split('\0')) {
    if (record.length < 4) continue
    const status = record.slice(0, 2)
    const path = record.slice(3)
    if (path === '') continue
    entries.push({ status, path, untracked: status === '??' })
  }
  return entries
}


async function runGit(subprocess, git, cwd, args, signal, maxBytes = 400_000) {
  const handle = subprocess.spawn({
    argv: [git, '-C', cwd, ...args],
    cwd,
    stdio: {
      stdin: 'ignore',
      stdout: { maxBytes },
      stderr: { maxBytes: 16_000 },
    },
    graceMs: 5_000,
    signal,
  })
  const outcome = await handle.done
  const stdout = handle.collected?.stdout?.readFrom(0)
  return {
    exitCode: outcome?.exitCode ?? null,
    text: stdout?.text ?? '',
    // `lossy` means the retained window lost its head: the output was longer than the cap and what came back is its tail.
    truncated: stdout?.lossy === true,
    errors: handle.collected?.stderr?.readFrom(0).text ?? '',
  }
}

/** Tracked paths the repository's own rules cover: `git status` lists them like any other file, so the ignore files have to be asked for separately; untracked ignored files never reach this plugin. */
async function ignoredByRepo(subprocess, git, root, signal, log) {
  const listed = await runGit(subprocess, git, root, ['ls-files', '-ci', '--exclude-standard', '-z'], signal, 1_000_000)
  if (listed.exitCode !== 0) {
    log.warn(`git ls-files -ci failed in ${root}: ${listed.errors.trim().slice(0, 200)}; using the pattern rules only`)
    return new Set()
  }
  if (listed.truncated) {
    log.warn(`the repository lists more ignored tracked files than one call returns; the pattern rules still apply to all of them`)
  }
  return new Set(listed.text.split('\0').filter(name => name !== ''))
}

/** Everything this workspace changed against `base`; the ignore rules run first, on paths alone, so an ignored path is never diffed, read or counted against `maxFiles`. */
async function collectGitChanges(ctx, cwd, settings, base, scope, touchedFor, signal, log) {
  const subprocess = typeof ctx.get === 'function' ? ctx.get('subprocess') : undefined
  if (subprocess === undefined) return { failure: 'no-subprocess' }

  let git
  try {
    git = await subprocess.resolveExecutable('git', undefined, signal)
  } catch {
    return { failure: 'no-git' }
  }

  // Status and diff paths are relative to the repository root, never to the session directory, so every command here resolves against the root.
  const top = await runGit(subprocess, git, cwd, ['rev-parse', '--show-toplevel'], signal)
  if (top.exitCode !== 0) {
    log.warn(`git rev-parse failed in ${cwd}: ${top.errors.trim().slice(0, 200)}`)
    return { failure: 'no-repo' }
  }
  // `--show-toplevel` prints the path and a line ending: only that line ending is stripped, because a directory name may itself end in whitespace.
  const toplevel = top.text.replace(/\r?\n+$/, '')
  const root = toplevel.trim() === '' ? cwd : toplevel

  const status = await runGit(subprocess, git, root, ['status', '--porcelain=v1', '-z', '-uall', '--no-renames'], signal)
  if (status.exitCode !== 0) {
    log.warn(`git status failed in ${root}: ${status.errors.trim().slice(0, 200)}`)
    return { failure: 'no-repo' }
  }
  const untrackedAll = parseGitStatus(status.text)
    .filter(entry => entry.untracked)
    .map(entry => entry.path)

  const named = await runGit(subprocess, git, root, ['diff', '--name-only', '-z', '--no-renames', base], signal)
  if (named.exitCode !== 0) {
    log.warn(`git diff against ${base} failed in ${root}: ${named.errors.trim().slice(0, 200)}`)
    return { failure: 'no-repo' }
  }
  // `-z` names are exact and NUL-terminated, so they are used exactly as they arrive: trimming one would name a different file.
  const changedAll = named.text.split('\0').filter(name => name !== '')
  const candidates = changedAll.length + untrackedAll.length


  const respectGit = settings.ignore.respectGit === true
  const gitIgnored = respectGit && candidates > 0
    ? await ignoredByRepo(subprocess, git, root, signal, log)
    : new Set()
  const ignore = createIgnore({ ...settings.ignore, gitLayer: respectGit, gitIgnored })
  const asCandidate = path => ({ path, name: path, value: path })
  const tracked = partitionIgnored(ignore, changedAll.map(asCandidate))
  const fresh = partitionIgnored(ignore, untrackedAll.map(asCandidate))
  const excluded = [...tracked.excluded, ...fresh.excluded]


  const touchedPaths = typeof touchedFor === 'function' ? touchedFor(root) : []
  const touched = new Set(touchedPaths.map(path => path.replace(/\\/g, '/').toLowerCase()))
  const fromSession = path => touched.has(path.replace(/\\/g, '/').toLowerCase())
  const sessionOnly = scope === 'session'
  const changed = sessionOnly ? tracked.kept.filter(fromSession) : tracked.kept
  const untracked = sessionOnly ? fresh.kept.filter(fromSession) : fresh.kept
  // A session review's change set is the session's own files, so its ignore outcome is session-relative too: a working-tree file the session never touched is neither reviewed here nor reported as excluded.
  const ignoreFacts = ignoreStats(ignore, sessionOnly ? excluded.filter(item => fromSession(item.path)) : excluded)

  if (changed.length === 0 && untracked.length === 0) {

    if (!sessionOnly && excluded.length > 0) {
      return { failure: 'all-ignored', ignore: ignoreFacts, files: excluded.length, filesTotal: candidates }
    }
    if (sessionOnly) {
      // The session's own paths decide this, not the working tree: `git status` never lists an ignored untracked file, so a path this session wrote is the only evidence its change was dropped rather than never made.
      const touchedIgnored = partitionIgnored(ignore, touchedPaths.map(asCandidate)).excluded
      if (touchedIgnored.length > 0) {
        return {
          failure: 'session-ignored',
          ignore: ignoreFacts,
          touchedIgnored,
          touched: touchedPaths,
          files: candidates,
        }
      }
      return { failure: 'session-clean', touched: touchedPaths, files: candidates, ignore: ignoreFacts }
    }
    return { failure: 'clean' }
  }

  const skipped = []
  const parts = []
  const paths = []
  let chars = 0
  let reviewed = 0
  let added = 0
  let deleted = 0

  const accept = (path, text) => {
    const counts = countDiffLines(text)
    chars += text.length
    reviewed += 1
    added += counts.added
    deleted += counts.deleted
    parts.push(text)
    paths.push(path)
  }

  for (const path of changed) {
    if (reviewed >= settings.maxFiles) {
      skipped.push({ file: path, reason: 'over-file-limit' })
      continue
    }
    // The path is literal: a name holding `*`, `?` or `[...]` would otherwise be read as a glob and match a different file.
    const diff = await runGit(subprocess, git, root, ['diff', '--no-color', '--unified=3', base, '--', `:(literal)${path}`], signal)
    if (diff.exitCode !== 0) {
      skipped.push({ file: path, reason: `git diff failed: ${diff.errors.trim().slice(0, 120)}` })
      continue
    }
    // Kept exactly as git wrote it: trimming the whole diff would rewrite the trailing whitespace of a final added line, and the reviewer would quote something that is not in the file.
    const text = diff.text
    if (text.trim() === '') {
      skipped.push({ file: path, reason: `no difference against ${base}` })
      continue
    }

    if (BINARY_DIFF_MARKER.test(text)) {
      skipped.push({ file: path, reason: 'binary' })
      continue
    }
    if (chars + text.length > settings.maxDiffChars) {
      skipped.push({ file: path, reason: 'over-diff-budget' })
      continue
    }
    accept(path, text)
  }

  for (const path of untracked) {
    if (reviewed >= settings.maxFiles) {
      skipped.push({ file: path, reason: 'over-file-limit' })
      continue
    }
    const target = resolveInside(root, path)
    let content
    try {
      if (target === undefined) throw new Error('outside the workspace')
      const stat = statSync(target)
      if (stat.size > 400_000) {
        skipped.push({ file: path, reason: 'oversized' })
        continue
      }
      content = readFileSync(target, 'utf8')
    } catch (error) {
      skipped.push({ file: path, reason: `read-failed: ${String(error).slice(0, 120)}` })
      continue
    }
    if (looksBinary(content)) {
      skipped.push({ file: path, reason: 'binary' })
      continue
    }
    const text = renderNewFileDiff(path, content)
    if (chars + text.length > settings.maxDiffChars) {
      skipped.push({ file: path, reason: 'over-diff-budget' })
      continue
    }
    accept(path, text)
  }

  const files = changed.length + untracked.length
  const filesTotal = candidates
  if (reviewed === 0) return { failure: 'all-skipped', skipped, files, filesTotal, ignore: ignoreFacts }

  return {
    source: 'git',
    base,
    scope,
    filesTotal,
    touched: touchedPaths,
    summary: { turn: null, cwd: root, added, deleted },
    diffs: parts.join('\n\n'),
    paths,
    reviewed,
    skipped,
    files,
    ignore: ignoreFacts,

    policy: ignore,
  }
}

// One table holds each reader tool once — the name offered, the definition shown,
// the arm that runs it and, in `needs`, the harness tool it cannot work without
// (`list_dir` has none: it is this plugin's own) — so a name cannot be offered
// and refused, or accepted and never run, and the set a run offers is exactly the
// set this deployment can actually execute. Reader tools answer under the same
// ignore rules as the diff.
const READER_TOOL_SPECS = [
  {
    name: 'read_file',
    description: 'Read a UTF-8 text file from the workspace. The reply starts with a header naming the path and the line range; the content follows without line-number prefixes. Read only what settles a specific question. A path the review excludes as ignored — a dependency tree, build output, a cache — is refused.',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'File path relative to the workspace root.' },
        offset: { type: 'integer', description: 'First line to return, 1-based (default 1).' },
        limit: { type: 'integer', description: 'Maximum lines to return (default 400, maximum 800).' },
      },
      required: ['path'],
      additionalProperties: false,
    },
    needs: 'read',
    run: readThrough,
  },
  {
    name: 'list_dir',
    description: 'List one workspace directory. Use it to locate a file, never to tour the repository.',
    parameters: {
      type: 'object',
      properties: { path: { type: 'string', description: 'Directory relative to the workspace root; empty or omitted means the root itself.' } },
      required: [],
      additionalProperties: false,
    },
    run: (args, { root, budget, signal, ignore }) => listDirTool(args, root, budget, signal, ignore),
  },
  {
    name: 'search',
    description: 'Case-sensitive literal search for one string across the workspace text files the repository itself searches — hidden and ignored files are not looked at, so read_file is the way to those. Returns "path:line: text" rows; use it to find a definition, a caller or a usage.',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Literal text to find, without surrounding quotes.' },
        maxResults: { type: 'integer', description: 'Maximum matching lines. Defaults to, and is capped by, the configured maxSearchResults (40 unless configured).' },
      },
      required: ['query'],
      additionalProperties: false,
    },
    needs: 'grep',
    run: searchThrough,
  },
]


const READER_TOOLS = READER_TOOL_SPECS.map(({ name, description, parameters }) => ({ name, description, parameters }))


const READER_TOOL_BY_NAME = new Map(READER_TOOL_SPECS.map(tool => [tool.name, tool]))

/**
 * The reader tools run on the harness's own tool service: `read` and `grep` are
 * the implementations the agent itself uses, so the sandbox, the path
 * resolution, the encodings and the windowing are the harness's, not a second
 * copy of them here. What this plugin keeps is the wrapper — the review's ignore
 * rules, its budgets and the shape the evidence gate reads.
 *
 * `has` is the capability answer every decision about the reader tools is built
 * from: a deployment may expose one of the pair, or neither, and the run offers
 * exactly what it can run.
 */
function readerToolbox(ctx, agent) {
  const tools = ctx.get('tools')
  if (typeof tools?.get !== 'function' || typeof tools?.execute !== 'function') return undefined
  const has = name => {
    try {
      return tools.get(name, agent) !== undefined
    } catch {
      return false
    }
  }
  return {
    has,
    call: (name, args, signal) => tools.execute({ callId: randomUUID(), name, arguments: args, signal, agent }),
  }
}

/** Whether this deployment can run one reader tool: its own, or the harness tool it needs. */
function readerUsable(spec, toolbox) {
  return spec.needs === undefined || toolbox?.has(spec.needs) === true
}

/** The reader definitions this deployment can run, in the order they are offered. */
function readerToolsFor(toolbox) {
  const usable = new Set(READER_TOOL_SPECS.filter(spec => readerUsable(spec, toolbox)).map(spec => spec.name))
  return READER_TOOLS.filter(tool => usable.has(tool.name))
}

/** The first text block of a tool result, as the reviewer will read it. */
function toolFailureText(result) {
  const block = Array.isArray(result?.content)
    ? result.content.find(entry => entry?.type === 'text' && typeof entry.text === 'string')
    : undefined
  return clamp(block?.text ?? 'the tool failed', 400)
}

/** One literal string as the regular expression the harness's search expects. */
function literalPattern(query) {
  return query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function relativePath(root, target) {
  const rel = relative(root, target)
  return (rel === '' ? '.' : rel).replace(/\\/g, '/')
}

/** A NUL byte is what makes a file binary for this plugin's purposes. */
function looksBinary(text) {
  return text.includes('\u0000')
}

/**
 * Resolve a caller-supplied path inside the workspace, or undefined when it
 * escapes. The check is both lexical and physical: `fs` follows symlinks, so a
 * link inside the workspace pointing outside would widen the promised boundary.
 */
function resolveInside(root, path) {
  const absolute = resolve(root, typeof path === 'string' && path.trim() !== '' ? path : '.')
  const lexical = relative(root, absolute)
  if (lexical !== '' && (lexical.startsWith('..') || isAbsolute(lexical))) return undefined

  let realRoot
  try {
    realRoot = realpathSync(root)
  } catch {
    realRoot = root
  }
  let real
  try {
    real = realpathSync(absolute)
  } catch {
    return absolute
  }
  const inside = relative(realRoot, real)
  if (inside === '') return real
  return inside.startsWith('..') || isAbsolute(inside) ? undefined : real
}

/**
 * `read_file`: the review's wrapper over the harness's `read`. The ignore rule,
 * the workspace boundary and the byte budget are checked here; the harness does
 * the reading, so a directory, a binary file or a path outside its sandbox comes
 * back as its refusal instead of a second implementation of those rules.
 */
async function readThrough(args, { root, budget, ignore, signal, toolbox }) {
  const target = resolveInside(root, args.path)
  if (target === undefined) return { text: `refused: "${args.path}" is outside the workspace`, isError: true }
  const where = relativePath(root, target)
  const rule = ignore.ruleFor(where)
  if (rule !== undefined) {
    return { text: `refused: ${where} is excluded by the review's ignore rules (${rule.label})`, isError: true }
  }
  const offset = positiveInt(args.offset, 1)
  const limit = Math.min(positiveInt(args.limit, 400), 800)
  /** One `read` call, with a thrown tool or a failure result reported as the refusal reason. */
  const callRead = async payload => {
    try {
      const result = await toolbox.call('read', payload, signal)
      return result?.isError === true ? { failure: toolFailureText(result) } : result
    } catch (error) {
      // A tool that throws — the deployment refusing the call, a backend error, a
      // cancel — is a refused read, not the end of the review.
      if (signal?.aborted === true) throw error
      return { failure: String(error) }
    }
  }
  let outcome = await callRead({ file_path: target, offset, limit })
  if (outcome.failure !== undefined) {
    // A deployment caps the window `read` accepts, and the cap is not part of the
    // tool's published parameters, so a refused window is answered by asking for
    // the deployment's own default rather than by reading its refusal prose. Any
    // other refusal fails the same way twice and is reported once.
    outcome = await callRead({ file_path: target, offset })
  }
  if (outcome.failure !== undefined) return { text: `cannot read ${where}: ${outcome.failure}`, isError: true }

  const value = outcome?.value
  const lines = Array.isArray(value?.lines) && value.lines.every(line => typeof line?.text === 'string')
    ? value.lines.map(line => line.text)
    : undefined
  if (lines === undefined || !Number.isInteger(value?.totalLines)) {
    // A result this wrapper does not understand is refused by name: reporting an
    // empty file instead would let the reviewer reason from a file it never saw.
    return { text: `cannot read ${where}: the harness's read returned an unexpected shape`, isError: true }
  }
  const shown = lines.join('\n').slice(0, Math.max(0, budget.maxBytes - budget.bytes))
  budget.bytes += shown.length
  const first = Number.isInteger(value.offset) ? value.offset : offset
  // The reviewer names files the way the diff does, so a path the backend
  // reports as absolute is replaced by the workspace-relative one.
  const returned = typeof value.path === 'string' ? value.path.replace(/\\/g, '/') : ''
  const file = returned !== '' && !isAbsolute(returned) ? returned : where
  return {
    text: `[${file} — lines ${first}-${first + lines.length - 1} of ${value.totalLines}]\n${shown}`,
    file,
    extraLines: lines,
  }
}

function listDirTool(args, root, budget, signal, ignore) {
  const target = resolveInside(root, args.path)
  if (target === undefined) return { text: `refused: "${args.path}" is outside the workspace`, isError: true }
  let entries
  try {
    entries = readdirSync(target, { withFileTypes: true })
  } catch (error) {
    return { text: `cannot list ${args.path ?? '.'}: ${error?.code ?? String(error)}`, isError: true }
  }
  signal?.throwIfAborted?.()
  const base = relativePath(root, target)
  const visible = entries.filter(entry => ignore.ruleFor(base === '.' ? entry.name : `${base}/${entry.name}`) === undefined)
  const rows = visible.slice(0, 200).map(entry => `${entry.isDirectory() ? 'dir  ' : 'file '}${entry.name}`)
  const shown = rows.join('\n').slice(0, Math.max(0, budget.maxBytes - budget.bytes))
  budget.bytes += shown.length
  return {
    text: `[${base} — ${visible.length} entries${visible.length > rows.length ? ', truncated' : ''}]\n${shown}`,
    extraLines: visible.map(entry => entry.name),
  }
}

/**
 * `search`: the review's wrapper over the harness's `grep`, so ripgrep does the
 * walking. The query stays literal — the harness takes a regular expression, so
 * it is escaped — ignored paths are dropped from what comes back, and the rows,
 * the cap and the corpus remain the review's.
 */
async function searchThrough(args, { root, budget, settings, signal, ignore, toolbox }) {
  const query = typeof args.query === 'string' ? args.query : ''
  if (query === '') return { text: 'search needs a non-empty query', isError: true }
  const ceiling = positiveInt(settings.maxSearchResults, DEFAULTS.maxSearchResults)
  const maxResults = Math.min(positiveInt(args.maxResults, ceiling), ceiling)
  let outcome
  try {
    outcome = await toolbox.call('grep', { pattern: literalPattern(query), path: root }, signal)
  } catch (error) {
    if (signal?.aborted === true) throw error
    return { text: `search failed: ${String(error)}`, isError: true }
  }
  if (outcome?.isError === true) return { text: `search failed: ${toolFailureText(outcome)}`, isError: true }

  const matches = outcome?.value?.matches
  if (!Array.isArray(matches) || !matches.every(match => typeof match?.path === 'string' && typeof match?.line === 'string' && Number.isInteger(match?.lineNumber))) {
    // "No matches" is a claim about the project; an unreadable result is not one.
    return { text: `search failed: the harness's grep returned an unexpected shape`, isError: true }
  }

  const room = Math.max(0, budget.maxBytes - budget.bytes)
  const found = []
  const extraLines = []
  const files = new Set()
  let chars = 0
  for (const match of matches) {
    if (found.length >= maxResults || chars >= room) break
    const where = match.path.replace(/\\/g, '/')
    // An ignored path is invisible to a search too: a dependency tree must not fill the reviewer's context or its evidence corpus.
    if (where === '' || ignore.ruleFor(where) !== undefined) continue
    const text = match.line.trim()
    const row = `${where}:${match.lineNumber}: ${text.slice(0, 240)}`
    found.push(row)
    extraLines.push(text)
    files.add(where)
    chars += row.length + 1
  }
  budget.bytes += chars
  if (found.length === 0) {
    return { text: `no match for ${JSON.stringify(query)} in the workspace`, extraLines: [] }
  }
  return {
    text: `[${found.length} match(es) for ${JSON.stringify(query)}]\n${found.join('\n')}`,
    extraLines,
    files: [...files],
  }
}


function parseToolArguments(call) {
  if (call.arguments.trim() === '') return { value: {} }
  let parsed
  try {
    parsed = JSON.parse(call.arguments)
  } catch (error) {
    return { failure: `refused: cannot parse arguments for ${call.name}: ${String(error)} — send one JSON object` }
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { failure: `refused: arguments for ${call.name} must be a JSON object` }
  }
  return { value: parsed }
}


async function callModel(ctx, route, settings, messages, tools, signal, system) {
  const request = {
    provider: route.provider,
    model: route.model,
    system,
    messages,
    maxTokens: settings.maxTokens,
    temperature: settings.temperature,
    signal,
  }
  if (tools !== undefined) request.tools = tools

  if (route.reasoningEffort !== undefined) request.reasoningEffort = route.reasoningEffort


  let text = ''
  const calls = new Map()
  for await (const chunk of ctx.llm.stream(request)) {
    signal.throwIfAborted()
    if (chunk?.type === 'text-delta' && typeof chunk.text === 'string') {
      text += chunk.text
    } else if (chunk?.type === 'tool-call-delta') {
      const current = calls.get(chunk.id) ?? { id: chunk.id, name: '', arguments: '' }
      if (typeof chunk.name === 'string' && chunk.name !== '') current.name = chunk.name
      if (typeof chunk.argumentsDelta === 'string') current.arguments += chunk.argumentsDelta
      calls.set(chunk.id, current)
    } else if (chunk?.type === 'block-end' && chunk.block?.type === 'tool-call') {
      calls.set(chunk.block.id, { id: chunk.block.id, name: chunk.block.name, arguments: chunk.block.arguments })
    } else if (chunk?.type === 'finish') {
      const kind = chunk.reason?.kind
      if (kind === 'error' || kind === 'aborted') {
        throw new Error(`reviewer call failed: ${kind}: ${chunk.reason.failure?.message ?? 'unknown'}`)
      }
    }
  }
  return { text, calls: [...calls.values()].filter(call => call.name !== '') }
}

function ratio(value, fallback) {
  const n = Number(value)
  return Number.isFinite(n) && n > 0 && n < 1 ? n : fallback
}

function summarizeCall(call) {
  let args = {}
  try {
    args = JSON.parse(call.arguments === '' ? '{}' : call.arguments)
  } catch {
    args = {}
  }
  const detail = args?.path ?? args?.query ?? args?.id ?? ''
  return detail === '' ? call.name : `${call.name} ${clamp(String(detail), 60)}`
}

/** Why the read-only tools are not available, or undefined when they are: the tool list, the dispatcher and the refusal all read this one answer. */
function readerStop({ readerAvailable, budget, settings, deadlineAt }) {
  if (!readerAvailable) return 'project access is off for this run'
  if (budget.calls >= settings.maxToolCalls) {
    return `the reader budget is spent (${budget.calls}/${settings.maxToolCalls} calls)`
  }
  if (budget.bytes >= budget.maxBytes) {
    return `the reader byte budget is spent (${budget.bytes}/${budget.maxBytes} bytes)`
  }
  return Date.now() >= deadlineAt ? 'reading time is up' : undefined
}


const STOP_SENTENCES = {
  cancelled: () => 'the review was cancelled',
  timeout: () => 'the review ran out of time',
  'call-failed': stop => `the reviewer call failed: ${stop.detail}`,
  'tool-failed': stop => `the review stopped: ${stop.detail}`,
  'not-finished': () => 'the reviewer stopped without calling finish_review',
  'out-of-turns': () => `the reviewer kept working past this run's ${MAX_STEPS} model turns`,
  'no-record': () => 'the reviewer stopped without recording anything',
}


function stopSentence(stop) {
  return STOP_SENTENCES[stop.code](stop)
}


function incompleteNote(stop, store) {
  const cap = `the store had already taken its ${MAX_STORE_CALLS} finding-tool calls`
  if (stop.code === undefined) {
    return store.capped === true
      ? `the reviewer used its ${MAX_STORE_CALLS} finding-tool calls before it closed the review`
      : undefined
  }
  const sentence = stopSentence(stop)
  return store.capped === true ? `${sentence} — ${cap}` : sentence
}


function offeredToolNames(tools, stop, readers) {
  return [
    ...tools.map(tool => tool.name),
    ...(stop === undefined ? readers.map(tool => tool.name) : []),
  ]
}

/** Executes one tool call: a review tool always runs, while a reader tool runs only while `readerStop` says the run may read. */
async function runTool(call, state) {
  const { tools, store, root, budget, signal, settings, ignore, deadlineAt, readerAvailable, readers, toolbox, corpus, files, log } = state
  const parsed = parseToolArguments(call)
  if (parsed.failure !== undefined) return { kind: 'refused', result: { text: parsed.failure, isError: true } }
  if (REVIEW_TOOL_NAMES.has(call.name)) {
    return { kind: 'review', result: store.run(call.name, parsed.value) }
  }
  const reader = READER_TOOL_BY_NAME.get(call.name)
  const stop = readerStop(state)
  if (reader === undefined) {
    // A name this run does not have, whatever it resembles: refused with the list of the ones it does.
    return {
      kind: 'refused',
      result: {
        text: `refused: unknown tool "${call.name}" — this run offers: ${offeredToolNames(tools, stop, readers).join(', ')}`,
        isError: true,
      },
    }
  }
  if (stop !== undefined) {
    log.info(`${summarizeCall(call)} → refused (${stop})`)
    return {
      kind: 'refused',
      result: {
        text: readerAvailable
          ? `refused: ${stop} — the read-only tools are not available; record your findings with the review tools and call finish_review`
          : `refused: ${call.name} is not available in this run (${stop}) — this run offers: ${offeredToolNames(tools, stop, readers).join(', ')}`,
        isError: true,
      },
    }
  }
  if (!readerUsable(reader, toolbox)) {
    // The tool exists in the protocol, but this deployment cannot run the harness
    // tool behind it: the refusal names the missing half, not the whole family.
    log.info(`${summarizeCall(call)} → refused (no ${reader.needs} tool)`)
    return {
      kind: 'refused',
      result: {
        text: `refused: this harness exposes no "${reader.needs}" tool — this run offers: ${offeredToolNames(tools, stop, readers).join(', ')}`,
        isError: true,
      },
    }
  }

  budget.calls += 1
  const result = await reader.run(parsed.value, { root, budget, signal, settings, ignore, toolbox })
  // Only what a tool actually returned is evidence: a refusal is not a line of code, and a directory listing shows names, not contents.
  if (result.isError !== true && (call.name === 'read_file' || call.name === 'search')) {
    corpus.addText(result.text)
    corpus.addLines(result.extraLines ?? [])
  }
  if (typeof result.file === 'string') {
    files.add(result.file)
    corpus.addPaths([result.file])
  }
  for (const file of result.files ?? []) files.add(file)
  corpus.addPaths(result.files ?? [])
  log.info(`reader ${budget.calls}/${settings.maxToolCalls}: ${summarizeCall(call)} → ${result.isError === true ? 'refused' : 'ok'}`)
  return { kind: 'reader', result }
}

/**
 * Runs one review to its end. The report is assembled from what the store holds,
 * never from the model's text, so a failed call, a spent budget or a cancel still
 * reports what was recorded.
 *
 * `policy` is passed in whole rather than rebuilt from the settings: a second
 * policy would quietly drop the repository layer, and the files this run reported
 * as excluded would be readable and citable again.
 */
async function runReview({ ctx, route, mode, settings, policy, prompt, diffs, paths, root, signal, userSignal, deadlineAt, toolbox, log }) {
  const messages = [{ role: 'user', content: [{ type: 'text', text: prompt }] }]
  const files = new Set()
  const budget = { bytes: 0, maxBytes: settings.maxReadBytes, calls: 0 }
  const results = []
  const ignore = policy
  const corpus = createEvidenceCorpus()
  corpus.addText(diffs)
  corpus.addPaths(paths)
  const store = createFindingStore({ mode, corpus, log })
  const tools = reviewToolsFor(mode)
  // What this deployment can actually run, decided once: the offer, the contract
  // and every refusal are built from this one list.
  const readerTools = readerToolsFor(toolbox)
  let limits = settings
  let activeSystem = ''
  let contractBuilt = false
  let readerAvailable = settings.projectAccess === true
  let fellBack = false
  let modelCalls = 0
  let nudges = 0
  let readerNoteSent = false
  let toolCallsSeen = 0
  let lastText = ''

  /** Drops the oldest tool results from the model's context; the corpus keeps everything. */
  function elideOldResults() {
    let total = results.reduce((sum, entry) => sum + entry.bytes, 0)
    const elidable = Math.max(0, results.length - KEEP_RECENT_RESULTS)
    for (let index = 0; index < elidable && total > ELIDE_AFTER_BYTES; index += 1) {
      const entry = results[index]
      if (entry.elided) continue
      const note = `[elided: ${entry.label} — ${entry.bytes} bytes of tool output dropped from this context; ask again if you still need it]`
      entry.message.content = [{ type: 'text', text: note }]
      total -= entry.bytes - note.length
      entry.bytes = note.length
      entry.elided = true
    }
  }

  /** Every tool result passes through here, reader and store alike, so one policy bounds the context and one figure describes it; a dropped store result is shown again by list_findings. */
  function recordResult(call, message, bytes) {
    results.push({ message, label: summarizeCall(call), bytes, elided: false })
    elideOldResults()
  }

  /** What stopped the run, as a code rather than the sentence about it: the sentence is derived from this in one place. */
  const stop = { code: undefined, detail: '' }
  function stopWith(code, error) {
    if (userSignal?.aborted === true) {
      stop.code = 'cancelled'
      return
    }
    if (signal.aborted === true || error?.name === 'AbortError') {
      stop.code = 'timeout'
      return
    }
    stop.code = code
    stop.detail = String(error)
  }

  let step = 0
  for (; step < MAX_STEPS; step += 1) {
    const readerNow = readerStop({ readerAvailable, budget, settings, deadlineAt })
    const canRead = readerNow === undefined
    if (!contractBuilt) {
      // The contract is written once, from the answer this turn's tool list is built from: a run whose reading bound is already spent is told it cannot read, rather than handed a section about tools it will not get. A later withdrawal is announced in the conversation.
      activeSystem = systemPromptFor(mode, { readers: canRead ? readerTools.map(tool => tool.name) : [] })
      contractBuilt = true
    }
    if (!canRead && !readerNoteSent && budget.calls > 0) {
      readerNoteSent = true
      messages.push({
        role: 'user',
        content: [{
          type: 'text',
          text: `[${readerNow} after ${budget.calls} call(s) — the read-only tools are no longer available. Record your findings with the review tools and call finish_review when you are done.]`,
        }],
      })
    }

    let answer
    try {
      answer = await callModel(
        ctx, route, limits, messages,
        canRead ? [...tools, ...readerTools] : tools,
        signal, activeSystem,
      )
    } catch (error) {
      // One degraded retry, so a rejected output cap still yields a report; the review tools stay, because without them there is no review to record.
      if (modelCalls === 0 && !fellBack) {
        fellBack = true
        readerAvailable = false
        limits = { ...settings, maxTokens: Math.min(settings.maxTokens, FALLBACK_MAX_TOKENS) }
        activeSystem = systemPromptFor(mode, { readers: [] })
        messages.push({
          role: 'user',
          content: [{ type: 'text', text: '[project access is off for this run — decide from the diffs above, record your findings with the review tools and call finish_review]' }],
        })
        log.warn(`reviewer call failed (${String(error)}); retrying without project access and maxTokens=${limits.maxTokens}`)
        continue
      }
      stopWith('call-failed', error)
      break
    }
    modelCalls += 1
    lastText = answer.text

    if (answer.calls.length > 0) {
      toolCallsSeen += answer.calls.length
      messages.push({
        id: randomUUID(),
        role: 'assistant',
        content: answer.calls.map(call => ({ type: 'tool-call', id: call.id, name: call.name, arguments: call.arguments })),
        source: { kind: 'model', provider: route.provider, model: route.model },
      })
      const state = { tools, store, root, budget, signal, settings, ignore, deadlineAt, readerAvailable, readers: readerTools, toolbox, corpus, files, log }
      let ending
      for (const call of answer.calls) {
        // Every requested call gets exactly one result, so the assistant tool-call blocks stay paired with their results.
        let outcome
        if (ending === undefined) {
          try {
            outcome = await runTool(call, state)
          } catch (error) {
            // A tool that threw — a cancel or the clock running out mid-read — ends the run here, and everything already recorded still reports.
            stopWith('tool-failed', error)
            ending = stopSentence(stop)
            outcome = { kind: 'refused', result: { text: `refused: ${ending}`, isError: true } }
          }
        } else {
          outcome = { kind: 'refused', result: { text: `refused: ${ending}`, isError: true } }
        }
        const { kind, result } = outcome
        const footer = kind === 'reader'
          ? `\n[reader budget: ${budget.calls}/${settings.maxToolCalls} calls, ${Math.round(budget.bytes / 1024)}/${Math.round(budget.maxBytes / 1024)} KB]`
          : ''
        const message = {
          id: randomUUID(),
          role: 'tool',
          toolCallId: call.id,
          ...(result.isError === true ? { isError: true } : {}),
          content: [{ type: 'text', text: `${result.text}${footer}` }],
          source: { kind: 'tool', callId: call.id },
        }
        messages.push(message)
        recordResult(call, message, result.text.length + footer.length)
      }
      if (ending !== undefined) break
    }

    if (store.finished === true) break
    if (answer.calls.length > 0) continue

    // The model stopped without finishing the review: ask it to finish, and build the report from the store when it will not.
    nudges += 1
    if (nudges > MAX_NUDGES) {
      stop.code = 'not-finished'
      break
    }
    messages.push({
      role: 'user',
      content: [{ type: 'text', text: '[the review is not finished — record anything you still stand behind with append_finding, then call finish_review; if it is complete as it stands, call it now]' }],
    })
  }
  if (store.finished === true) {
    // A review that closed is not stopped by anything — but one that closed after the store's cap could not record more than it did, and says so.
    stop.code = undefined
    stop.detail = ''
  } else if (stop.code === undefined) {
    stop.code = step >= MAX_STEPS ? 'out-of-turns' : 'no-record'
  }
  const incomplete = incompleteNote(stop, store)

  const { kept, withheld } = gateFindings(store, corpus, mode)
  const verdict = verdictFromFindings(kept, mode)
  // A run cut short before recording anything has no report to make: an empty pass would be a lie about what the reviewer concluded.
  if (kept.length + withheld.length === 0 && incomplete !== undefined) {
    return { failure: incomplete, lastText, cancelled: stop.code === 'cancelled', toolsUsed: toolCallsSeen > 0 }
  }
  return {
    findings: kept,
    withheld,
    verdict,
    summary: store.summaryText(),
    incomplete,
    store: store.stats(),
    files: [...files],
    budget,
    fellBack,
    contextBytes: results.reduce((sum, entry) => sum + entry.bytes, 0),
  }
}

function renderPrompt({ diffs, stats, focus, language, cwd, mode, primary = [], others = [] }) {
  const skipped = stats.skipped.length === 0
    ? ''
    : `\n- left out of this review: ${stats.skipped.map(item => `${item.file} (${item.reason})`).join(', ')}`
  const rules = stats.ignore === undefined ? '' : ignoreRuleLine(stats.ignore)
  // The reviewer is told what the rules took out: a change set that looks small must not read as one that was small.
  const ignored = stats.ignore === undefined || stats.ignore.count === 0
    ? ''
    : `\n- already excluded by the ignore rules, and not yours to review or to read: ${stats.ignore.count} file(s) — ${ignoreSampleText(stats.ignore)}`
  const ruleLine = rules === '' ? '' : `\n- ignore rules in force: ${rules}`
  const scope = primary.length === 0 && others.length === 0
    ? ''
    : `\n\n## Scope\n${
      primary.length === 0
        ? '- none of the files below were written or edited by this session'
        : `- primary — written or edited in this session: ${primary.join(', ')}`
    }${
      others.length === 0
        ? ''
        : `\n- also changed in this workspace, not by this session: ${others.join(', ')}`
    }\nGive the primary files your attention first: that is what this review is for. The rest are in scope when the session's change reaches them; do not spend the reading budget touring them.`
  // The mode's own assignment: it can narrow the job, never the change set, which the collection already fixed.
  const taskBlock = mode.task === ''
    ? ''
    : `\n## Mode task (${mode.label})\n${mode.task}`
  const focusBlock = focus === ''
    ? ''
    : `\n## Review focus (typed on the command line)\n${focus}\n\nTreat this as the subject to concentrate on. It is not a question to answer, and it never widens the change set.`
  const target = language !== ''
    ? `"${language}"`
    : focus === '' ? 'English' : 'the same language as the review focus above'
  const required = mode.fields.filter(field => field.required).map(field => field.label === '' ? field.key : `"${field.key}"`)
  const requiredText = required.length === 0 ? 'the fields your mode asks for' : required.join(', ')
  return `## Change set under review
- mode: ${mode.label} (${mode.id})
- change source: ${stats.sourceLabel}
- workspace: ${cwd}
- changed files: ${stats.files} (+${stats.added} / -${stats.deleted} lines), reviewed here: ${stats.reviewed}${skipped}${ignored}${ruleLine}${scope}

## Unified diffs
${diffs}
${focusBlock}${taskBlock}

## Language
Write every text field you record with the review tools in ${target}. Keep identifiers, paths and code verbatim; "evidence" is always copied from the diff, never translated or reformatted.

## Before you finish
Delete every finding in the store that lacks a verbatim evidence quote from the diffs above or from a file you read, that leaves one of ${requiredText} unanswered, that depends on code you cannot see, or that is a matter of taste. Your summary must mention only what survives. Recording nothing is a valid outcome; recording an unproven claim is not.

Review the change set now: record each finding with append_finding as soon as it is settled, record the summary with set_summary, and call finish_review when you are done.`
}


function findingKeys(mode) {
  return [...FINDING_KEYS, ...mode.fields.map(field => field.key)]
}

/**
 * The review tools — the protocol, fixed for every run whatever the mode, the
 * settings file or the command line say. One table holds each tool once: its
 * name, whether the call changes the review (those are what the store's cap
 * bounds), what it is for, and how its parameters are built from the mode in
 * force. The model is offered exactly these names, the dispatcher classifies a
 * call by them and the store answers for every one of them, so a name cannot
 * exist in one place and be missing from another.
 */
const REVIEW_TOOL_SPECS = [
  {
    name: 'append_finding',
    changes: true,
    description: 'Record one finding in this review as soon as it is settled. Nothing written in your own answer reaches the report: the findings recorded with this tool are the review, and a run that stops early keeps everything already recorded. A required field left unanswered is recorded as withheld, and the result says so. "evidence" must quote verbatim a line from the diff or from a file one of your tools returned; the quote is checked when the finding is recorded and again when the report is built, and a quote that does not occur there is recorded as withheld rather than published. The result names the id the finding was recorded under and whether the gate can publish it.',
    parameters: ({ properties, required }) => ({ type: 'object', properties, required, additionalProperties: false }),
  },
  {
    name: 'update_finding',
    changes: true,
    description: 'Change a finding already recorded, by the id append_finding returned (list_findings shows every id). Send only the fields that change; everything else stays as it was. Use it when a later finding invalidates an earlier one, or when a quote, a field or a severity was wrong. The same checks run again and the result says whether the finding can now be published.',
    parameters: ({ properties, id }) => ({ type: 'object', properties: { id, ...properties }, required: ['id'], additionalProperties: false }),
  },
  {
    name: 'delete_finding',
    changes: true,
    description: 'Drop one finding from the store, by id. Use it for a finding a later look invalidated, so the report never carries a claim you no longer stand behind. The result names what was removed.',
    parameters: ({ id }) => ({ type: 'object', properties: { id }, required: ['id'], additionalProperties: false }),
  },
  {
    name: 'list_findings',
    changes: false,
    description: 'Every finding recorded so far, in the order it was recorded: its id, severity, file:line, title, and whether the evidence gate can publish it (a withheld one carries its reason). Takes no arguments. Call it before you finish.',
    parameters: () => ({ type: 'object', properties: {}, required: [], additionalProperties: false }),
  },
  {
    name: 'set_summary',
    changes: false,
    description: 'Record the 2-4 factual sentences that open the report: what the change set does and whether it holds up, mentioning only the findings you kept. Calling it again replaces the summary. Record it before you call finish_review.',
    parameters: () => ({
      type: 'object',
      properties: { summary: { type: 'string', description: 'the summary the report opens with' } },
      required: ['summary'],
      additionalProperties: false,
    }),
  },
  {
    name: 'finish_review',
    changes: false,
    description: 'End the review. The report is built from everything recorded at that moment — the findings and the summary — so record what you stand behind first. Call it once, when the review is complete: recording nothing and finishing is a complete review when there is nothing to report. Takes no arguments.',
    parameters: () => ({ type: 'object', properties: {}, required: [], additionalProperties: false }),
  },
]


const REVIEW_TOOL_NAMES = new Set(REVIEW_TOOL_SPECS.map(tool => tool.name))


const STORE_CHANGING_NAMES = new Set(REVIEW_TOOL_SPECS.filter(tool => tool.changes).map(tool => tool.name))


function findingLine(mode, finding) {
  const where = finding.file === '' ? '' : ` ${finding.file}${finding.line === null ? '' : `:${finding.line}`}`
  return `${finding.id} [${severityLabel(mode, finding.severity)}]${where} — ${finding.title === '' ? '(unnamed)' : finding.title}`
}

/**
 * The tools as the model is offered them: the table's names and descriptions,
 * with the parameters each builds from the mode in force. What `append_finding`
 * and `update_finding` accept is exactly the finding shape that mode declares,
 * which is the whole of what a mode decides about the tools.
 */
function reviewToolsFor(mode) {
  const properties = {}
  for (const field of FINDING_FIELDS) properties[field.key] = field.property(mode)
  for (const field of mode.fields) {
    properties[field.key] = {
      type: 'string',
      description: field.guide === '' ? (field.label === '' ? field.key : field.label) : field.guide,
    }
  }
  const shapeFor = {
    properties,
    id: { type: 'string', description: 'the id append_finding returned, for example "f2"' },
    required: [
      ...FINDING_FIELDS.filter(field => field.required).map(field => field.key),
      ...mode.fields.filter(field => field.required).map(field => field.key),
    ],
  }
  return REVIEW_TOOL_SPECS.map(tool => ({
    name: tool.name,
    description: tool.description,
    parameters: tool.parameters(shapeFor),
  }))
}

/**
 * The evidence one run may quote: the diff it was shown, everything the reader
 * tools returned, and the files those results made visible. It only ever grows,
 * so a finding that holds up when it is recorded cannot fail later — while one
 * that was withheld can become provable once the file behind it has been read.
 * Nothing else belongs here: a refusal is not a line of code and a directory
 * listing is not content.
 */
function createEvidenceCorpus() {
  const forms = new Set()
  const paths = new Set()
  const absorb = text => {
    for (const form of diffQuoteForms(text)) forms.add(form)
  }
  return {
    addText(text) { absorb(text) },
    addLines(lines) { for (const line of lines) absorb(line) },
    addPaths(list) { for (const path of list) paths.add(canonicalPath(path)) },

    proof(finding) {
      if (finding.file === '') return 'no file named — a finding says which file it is about'
      if (!paths.has(canonicalPath(finding.file))) return 'the named file is not one the reviewer could see'
      const quoted = finding.evidence.split('\n').map(line => line.trim()).filter(line => line !== '')
      if (quoted.length === 0) return 'no evidence quoted'
      const missing = quoted.find(line => !forms.has(line))
      return missing === undefined ? undefined : `quoted evidence does not occur in the diff or the reads: ${clamp(missing, 120)}`
    },
  }
}

/**
 * Why one finding cannot be published, or undefined when it can. The proof check
 * is the plugin's own and no mode can relax it; the required fields are the
 * mode's. The title comes first because that is what the report and the withheld
 * list call the finding.
 */
function gateReason(finding, corpus, mode) {
  if (finding.title === '') {
    return 'nothing to name it by — a finding needs a title, or one answered field to take one from'
  }
  const proof = corpus.proof(finding)
  if (proof !== undefined) return proof
  const unanswered = mode.fields.find(field => field.required && finding[field.key] === '')
  if (unanswered === undefined) return undefined
  return `missing required field "${unanswered.key}" (${unanswered.label === '' ? unanswered.key : unanswered.label}) — a finding that cannot state it is not published`
}


function gateFindings(store, corpus, mode) {
  const kept = []
  const withheld = []
  for (const finding of store.all()) {
    const reason = gateReason(finding, corpus, mode)
    if (reason === undefined) kept.push(finding)
    else {
      // The keys a withheld finding is named by, taken from the structure table so a structural key cannot be missing here.
      const claim = {}
      for (const field of FINDING_FIELDS) {
        if (field.named === true) claim[field.key] = finding[field.key]
      }
      withheld.push({ ...claim, reason })
    }
  }
  return { kept, withheld }
}

/**
 * The findings one run records, in the order it records them.
 *
 * The store is the review: the report is assembled from it, so a call that
 * fails, a budget that runs out or a cancel loses nothing already recorded.
 * Every write is checked before it lands — a call the store does not understand
 * changes nothing and answers with what was wrong with it, so the reviewer can
 * fix the call and make it again. A finding that only fails the evidence gate is
 * still recorded, as withheld, and stays visible in the report.
 */
function createFindingStore({ mode, corpus, log }) {
  const findings = []
  const byId = new Map()
  const counts = { calls: 0, appended: 0, updated: 0, deleted: 0 }
  let summary = ''
  let finished = false
  let capped = false
  let lastId = 0

  const text = (args, key) => (typeof args[key] === 'string' ? args[key].trim() : '')

  /** The findings recorded so far, for a refusal to be actionable. */
  function knownIds() {
    return findings.length === 0
      ? 'nothing is recorded yet — use append_finding first'
      : `recorded: ${findings.map(finding => `${finding.id} (${finding.title === '' ? 'unnamed' : finding.title})`).join(', ')}`
  }

  /** The findings the gate cannot publish right now — the corpus only grows. */
  function withheldCount() {
    return findings.reduce((sum, finding) => sum + (gateReason(finding, corpus, mode) === undefined ? 0 : 1), 0)
  }

  /** What every result ends with, so the reviewer always knows what the store holds. */
  function footer() {
    return `\n[finding store: ${findings.length} of ${MAX_FINDINGS} recorded, ${withheldCount()} withheld${summary === '' ? ', no summary yet' : ''}]`
  }

  /** The refusal one call gets, as the reviewer will read it. */
  function refusal(lines) {
    return { text: `refused: ${lines.join('; ')}`, isError: true }
  }

  /** One finding with nothing filled in, over the structure and the mode's fields. */
  function blank() {
    const finding = {}
    for (const field of FINDING_FIELDS) finding[field.key] = field.blank
    for (const field of mode.fields) finding[field.key] = ''
    return finding
  }

  /** The problems that make one call unusable — all of them, so one retry fixes everything. */
  function problems(args, tool) {
    const found = []
    const keys = findingKeys(mode)
    for (const key of Object.keys(args)) {
      if (!keys.includes(key)) found.push(`"${key}" is not a finding field; ${tool} takes: ${keys.join(', ')}`)
    }
    for (const key of keys) {
      if (!Object.hasOwn(args, key)) continue
      const field = FINDING_FIELDS.find(entry => entry.key === key)
      // A mode's own field is prose and must be a string; a structural key says
      // for itself what it accepts.
      const why = field === undefined
        ? (typeof args[key] === 'string' ? undefined : `"${key}" must be a string`)
        : field.reject(args[key], mode)
      if (why !== undefined) found.push(why)
    }
    return found
  }

  /** The finding a call describes, over the shape the mode declares. */
  function shape(args, base) {
    const finding = {}
    for (const field of FINDING_FIELDS) finding[field.key] = base[field.key]
    for (const field of mode.fields) finding[field.key] = base[field.key]
    for (const field of FINDING_FIELDS) {
      if (Object.hasOwn(args, field.key)) finding[field.key] = field.read(args[field.key])
    }
    for (const field of mode.fields) {
      if (Object.hasOwn(args, field.key)) finding[field.key] = String(args[field.key]).trim()
    }
    if (finding.category === '') finding.category = 'general'
    if (finding.title === '') {
      // A finding that names no title is still a finding: the first words it did
      // write become one, so the report never shows an anonymous entry.
      const stated = mode.fields.map(field => finding[field.key]).find(entry => entry !== '')
      finding.title = stated === undefined ? '' : stated.split('\n')[0].slice(0, 120)
    }
    return finding
  }

  function append(args) {
    const found = problems(args, 'append_finding')
    if (found.length > 0) return refusal(found)
    if (text(args, 'severity') === '') {
      return refusal([`"severity" is required — use one of: ${mode.severities.map(entry => entry.id).join(', ')}`])
    }
    if (findings.length >= MAX_FINDINGS) {
      return refusal([`the review already holds ${MAX_FINDINGS} findings, the maximum; delete the ones you no longer stand behind with delete_finding, or call finish_review`])
    }
    lastId += 1
    const finding = { id: `f${lastId}`, ...shape(args, blank()) }
    findings.push(finding)
    byId.set(finding.id, finding)
    counts.appended += 1
    const reason = gateReason(finding, corpus, mode)
    log.info(`store ${counts.calls}: append_finding → ${findingLine(mode, finding)} · ${reason === undefined ? 'provable' : `withheld (${clamp(reason, 80)})`}`)
    return {
      text: reason === undefined
        ? `${findingLine(mode, finding)} — recorded, and the gate can publish it.${footer()}`
        : `${findingLine(mode, finding)} — recorded, withheld: ${reason}\nFix it with update_finding on ${finding.id}, or drop it with delete_finding.${footer()}`,
    }
  }

  function update(args) {
    const id = text(args, 'id')
    if (id === '') return refusal(['update_finding needs the "id" of the finding to change — list_findings shows them'])
    const finding = byId.get(id)
    if (finding === undefined) return refusal([`no finding "${id}" in the store — ${knownIds()}`])
    const changes = { ...args }
    delete changes.id
    const changed = Object.keys(changes)
    if (changed.length === 0) return refusal([`update_finding needs at least one field to change — list_findings shows what ${id} holds`])
    const found = problems(changes, 'update_finding')
    if (found.length > 0) return refusal(found)
    Object.assign(finding, shape(changes, finding))
    counts.updated += 1
    const reason = gateReason(finding, corpus, mode)
    log.info(`store ${counts.calls}: update_finding ${id} (${changed.join(', ')}) → ${reason === undefined ? 'provable' : `withheld (${clamp(reason, 80)})`}`)
    return {
      text: reason === undefined
        ? `${findingLine(mode, finding)} — updated (${changed.join(', ')}), and the gate can publish it.${footer()}`
        : `${findingLine(mode, finding)} — updated (${changed.join(', ')}), still withheld: ${reason}${footer()}`,
    }
  }

  function remove(args) {
    const id = text(args, 'id')
    if (id === '') return refusal(['delete_finding needs the "id" of the finding to drop — list_findings shows them'])
    const index = findings.findIndex(entry => entry.id === id)
    if (index < 0) return refusal([`no finding "${id}" in the store — ${knownIds()}`])
    const [removed] = findings.splice(index, 1)
    byId.delete(id)
    counts.deleted += 1
    log.info(`store ${counts.calls}: delete_finding → ${findingLine(mode, removed)}`)
    return { text: `${findingLine(mode, removed)} — deleted.${footer()}` }
  }

  function list(args) {
    const extra = Object.keys(args)
    if (extra.length > 0) return refusal([`list_findings takes no arguments (got ${extra.map(key => `"${key}"`).join(', ')})`])
    if (findings.length === 0) {
      return { text: `nothing recorded yet — call finish_review if this review has no findings.${footer()}` }
    }
    const rows = findings.map(finding => {
      const reason = gateReason(finding, corpus, mode)
      return `${findingLine(mode, finding)} · ${reason === undefined ? 'provable' : `withheld: ${reason}`}`
    })
    return { text: `${rows.join('\n')}${footer()}` }
  }

  function setSummary(args) {
    const extra = Object.keys(args).filter(key => key !== 'summary')
    if (extra.length > 0) {
      return refusal([`set_summary takes only "summary" (got ${extra.map(key => `"${key}"`).join(', ')}) — finish_review is the tool that ends the review`])
    }
    if (typeof args.summary !== 'string' || args.summary.trim() === '') {
      return refusal(['set_summary needs a non-empty "summary" string — the 2-4 sentences the report opens with'])
    }
    const replaced = summary !== ''
    summary = args.summary.trim()
    log.info(`store ${counts.calls}: set_summary → ${summary.length} characters`)
    return { text: `${replaced ? 'summary replaced' : 'summary recorded'} (${summary.length} characters).${footer()}` }
  }

  function finish(args) {
    const extra = Object.keys(args)
    if (extra.length > 0) {
      return refusal([`finish_review takes no arguments (got ${extra.map(key => `"${key}"`).join(', ')}) — record the summary with set_summary and call it again`])
    }
    finished = true
    log.info(`store ${counts.calls}: finish_review → ${findings.length} recorded, ${withheldCount()} withheld`)
    return { text: `review finished: ${findings.length} finding(s) recorded, ${withheldCount()} withheld${summary === '' ? ', no summary recorded' : ''}.` }
  }

  /**
   * The handlers, keyed by the protocol's own names. `run` dispatches on this
   * map and nothing else: a call it does not know is refused instead of falling
   * through to the arm that ends the review, and the check below makes a tool
   * the table declares but the store cannot answer a loud failure here rather
   * than a silent one at run time.
   */
  const handlers = {
    append_finding: append,
    update_finding: update,
    delete_finding: remove,
    list_findings: list,
    set_summary: setSummary,
    finish_review: finish,
  }
  for (const tool of REVIEW_TOOL_SPECS) {
    if (typeof handlers[tool.name] !== 'function') {
      throw new Error(`code-review: no store handler for the review tool "${tool.name}"`)
    }
  }

  /**
   * One call against the store: it either changes something or answers why it
   * did not.
   *
   * The call cap bounds what the review can change. It never refuses the calls
   * that inspect the store, describe it or end the run, so a reviewer that
   * reached it can still list what it has, record its summary and close the
   * review — which is then marked as short by `capped`.
   */
  function run(name, args) {
    counts.calls += 1
    const handler = handlers[name]
    if (typeof handler !== 'function') {
      return refusal([`the store has no review tool "${name}" — it takes: ${Object.keys(handlers).join(', ')}`])
    }
    if (STORE_CHANGING_NAMES.has(name) && counts.calls > MAX_STORE_CALLS) {
      capped = true
      return refusal([`this run has used its ${MAX_STORE_CALLS} finding-tool calls and the store records nothing more; list what you have with list_findings, record the summary with set_summary and call finish_review`])
    }
    if (finished) return refusal(['the review is already finished'])
    return handler(args)
  }

  return {
    run,
    all: () => [...findings],
    summaryText: () => summary,
    stats: () => ({ ...counts }),
    get finished() { return finished },
    get capped() { return capped },
  }
}

/** Findings per severity id of this mode, so a report counts in the mode's own words. */
function countBySeverity(findings, mode) {
  const counts = {}
  for (const severity of mode.severities) counts[severity.id] = 0
  for (const finding of findings) counts[finding.severity] = (counts[finding.severity] ?? 0) + 1
  return counts
}

/** How the mode names one severity, for a report line or a notice. */
function severityLabel(mode, id) {
  return mode.severities.find(entry => entry.id === id)?.label ?? id
}

function canonicalPath(path) {
  return String(path ?? '')
    .trim()
    .replace(/\\/g, '/')
    .replace(/^\.\//, '')
    .replace(/^[ab]\//, '')
    .toLowerCase()
}

/** Quotable lines: as the diff writes them, and without the +/-/space marker. */
function diffQuoteForms(diffText) {
  const forms = new Set()
  for (const line of String(diffText ?? '').split('\n')) {
    const trimmed = line.trim()
    if (trimmed === '') continue
    forms.add(trimmed)
    if (trimmed.length > 1 && (trimmed[0] === '+' || trimmed[0] === '-' || trimmed[0] === ' ')) {
      const bare = trimmed.slice(1).trim()
      if (bare !== '') forms.add(bare)
    }
  }
  return forms
}

/** The verdict the surviving findings force, through the severity table of their mode. */
function verdictFromFindings(findings, mode) {
  let verdict = 'pass'
  for (const finding of findings) {
    // Every recorded severity is one the mode declares: the store refuses any
    // other, so this can only fall back for a table the run itself changed.
    const forced = mode.severities.find(entry => entry.id === finding.severity)?.verdict ?? 'pass'
    if (forced === 'fail') return 'fail'
    if (forced === 'warn') verdict = 'warn'
  }
  return verdict
}

/**
 * The thinking level, when one was asked for, as both the report and the notice
 * write it. A run that asked for nothing says nothing: the level in force is the
 * provider's own default, and naming it here would claim a choice nobody made.
 */
function effortNote(route) {
  return route.reasoningEffort === undefined ? '' : ` · thinking: ${route.reasoningEffort}`
}

function renderReport({ verdict, summary, findings, withheld, stats, route, mode, incomplete }) {
  const counts = countBySeverity(findings, mode)
  const head = mode.verdicts[verdict] ?? verdict.toUpperCase()
  const detail = mode.severities
    .filter(severity => counts[severity.id] > 0)
    .map(severity => `${severity.label} ${counts[severity.id]}`)
    .join(', ')
  const ignoreRules = stats.ignore === undefined ? '' : ignoreRuleLine(stats.ignore)
  const lines = [
    `## ${mode.label} — ${head}`,
    '',
    summary === '' ? '(no summary returned)' : summary,
    '',
    `- verdict: **${head}** (${verdict}) · proven findings: ${findings.length}` +
      ` (${detail === '' ? 'none' : detail})` +
      (withheld.length === 0 ? '' : ` · withheld as unprovable: ${withheld.length}`),
    `- mode: ${mode.label} (${mode.id}) · prompt: ${mode.promptFrom === 'file' ? 'config.json' : "this release's default"}`,
    `- source: ${stats.sourceLabel}`,
    `- change set: ${stats.files} file(s), +${stats.added} / -${stats.deleted}, reviewed ${stats.reviewed}` +
      (stats.skipped.length === 0 ? '' : `, left out ${stats.skipped.length}`),
    // Ignoring is reported, never silent: a change the rules removed is a change
    // the reader is being told about, with the rule that removed it.
    ...(stats.ignore === undefined || stats.ignore.count === 0
      ? []
      : [`- excluded as ignored: ${stats.ignore.count} file(s) — ${ignoreSampleText(stats.ignore)}`]),
    ...(stats.ignore === undefined || ignoreRules === '' ? [] : [`- ignore rules: ${ignoreRules}`]),
    ...(stats.recordBehind > 0
      ? [`- note: ${stats.recordBehind} newer recorded turn(s) have no comparison in this Host process; this review covers turn ${stats.turn}`]
      : []),
    // A run that stopped early still hands over what it recorded — and says so
    // where the verdict is read, never in a footnote.
    ...(incomplete === undefined
      ? []
      : [`- incomplete: ${incomplete} — the findings below are the ones the reviewer recorded before it stopped.`]),
    ...(stats.context === undefined || stats.context.calls === 0
      ? []
      : [`- project context read: ${stats.context.calls} tool call(s), ${stats.context.files.length} file(s)`]),
    ...(stats.store === undefined
      ? []
      : [`- finding store: ${stats.store.calls} tool call(s), ${stats.store.appended} recorded, ${stats.store.updated} updated, ${stats.store.deleted} deleted`]),
    `- reviewer: ${route.provider}/${route.model}${effortNote(route)}` +
      (stats.reviewerFallback === true ? ' · degraded retry (diff only, smaller output cap)' : ''),
  ]
  if (withheld.length > 0) {
    lines.push('', '_The reviewer also raised claims it could not prove from the diff. They are listed at the end and carry no verdict._')
  }
  // The finding body is the mode's field list, in the mode's order, labelled the
  // way the mode labels it: an empty label renders the text bare, a `block` field
  // is quoted code. The evidence is one of those fields, so it is gated wherever
  // it sits in the list.
  findings.forEach((finding, index) => {
    const where = finding.file === '' ? '' : ` — ${finding.file}${finding.line === null ? '' : `:${finding.line}`}`
    lines.push('', `### ${index + 1}. [${severityLabel(mode, finding.severity)}] ${finding.title}${where}`, `category: ${finding.category}`, '')
    for (const field of mode.fields) {
      const value = finding[field.key]
      if (typeof value !== 'string' || value === '') continue
      if (field.block) lines.push('', ...(field.label === '' ? [] : [`**${field.label}:**`, '']), '```diff', value, '```')
      else if (field.label === '') lines.push(value)
      else lines.push('', `**${field.label}:** ${value}`)
    }
  })
  if (withheld.length > 0) {
    lines.push('', '### Withheld as unprovable', '')
    for (const item of withheld) lines.push(`- [${severityLabel(mode, item.severity)}] ${item.title} — ${item.reason}`)
  }
  if (stats.skipped.length > 0) {
    lines.push('', '### Left out', '')
    for (const item of stats.skipped) lines.push(`- ${item.file} — ${item.reason}`)
  }
  return lines.join('\n')
}

function noticeSummary({ verdict, findings, withheld, stats, mode, incomplete }) {
  const counts = countBySeverity(findings, mode)
  const detail = mode.severities
    .filter(severity => counts[severity.id] > 0)
    .map(severity => `${counts[severity.id]} ${severity.label}`)
    .join(', ')
  const parts = [
    `code review [${mode.id}]: ${verdict}`,
    `${findings.length} proven finding(s)${detail === '' ? '' : ` (${detail})`}`,
    `${stats.reviewed}/${stats.files} file(s)`,
  ]
  if (withheld.length > 0) parts.push(`${withheld.length} withheld as unprovable`)
  if ((stats.ignore?.count ?? 0) > 0) parts.push(`${stats.ignore.count} ignored`)
  if (incomplete !== undefined) parts.push('incomplete')
  const summary = parts.join(' · ')
  return summary.length <= NOTICE_SUMMARY_MAX_CHARS
    ? summary
    : `${summary.slice(0, NOTICE_SUMMARY_MAX_CHARS - 1)}…`
}

/** The report as the Agent reads it: no payload, and plainly a notice rather than a request. */
function renderAgentNotice({ verdict, summary, findings, withheld, stats, route, mode, incomplete }) {
  const lines = [
    `[code-review] The user ran /review mode=${mode.id} (${mode.label}) on the code changes of this workspace. The same report is rendered to them as a card. This is a notice, not a request: do not change code unless the user asks you to.`,
    '',
    `mode: ${mode.label} (${mode.id}) · verdict: ${verdict}`,
    `source: ${stats.sourceLabel}`,
    `${stats.files} file(s), +${stats.added} / -${stats.deleted}, reviewed ${stats.reviewed}` +
      ` · proven findings: ${findings.length} · withheld as unprovable: ${withheld.length}`,
    ...(stats.ignore === undefined || stats.ignore.count === 0
      ? []
      : [`excluded by the ignore rules before the review: ${stats.ignore.count} file(s) — ${ignoreSampleText(stats.ignore)}`]),
    `reviewer: ${route.provider}/${route.model}${effortNote(route)}`,
    ...(stats.recordBehind > 0
      ? [`note: this reviews turn ${stats.turn}; ${stats.recordBehind} newer recorded turn(s) have no comparison in this Host process`]
      : []),
    ...(incomplete === undefined
      ? []
      : [`note: this review is incomplete — ${incomplete}; the findings below are the ones recorded before it stopped`]),
    ...(stats.context === undefined || stats.context.calls === 0
      ? []
      : [`project context read: ${stats.context.calls} tool call(s)${stats.context.files.length === 0 ? '' : ` — ${stats.context.files.join(', ')}`}`]),
    '',
    'Summary',
    summary === '' ? '(none returned)' : summary,
  ]
  if (findings.length === 0) {
    lines.push('', 'No proven findings.')
  } else {
    lines.push('', 'Proven findings')
    findings.forEach((finding, index) => {
      const where = finding.file === '' ? '' : ` — ${finding.file}${finding.line === null ? '' : `:${finding.line}`}`
      lines.push(`${index + 1}. [${severityLabel(mode, finding.severity)}] ${finding.category} — ${finding.title}${where}`)
      for (const field of mode.fields) {
        const value = finding[field.key]
        if (typeof value !== 'string' || value === '') continue
        const label = field.label === '' ? field.key : field.label.toLowerCase()
        lines.push(`   ${label}: ${field.block ? value.split('\n').join(' | ') : value}`)
      }
    })
  }
  if (withheld.length > 0) {
    lines.push('', 'Raised but withheld as unprovable (not part of the verdict)')
    for (const item of withheld) lines.push(`- [${severityLabel(mode, item.severity)}] ${item.title} — ${item.reason}`)
  }
  return lines.join('\n')
}

/** Hands the report to the Agent; a failure here is logged and never breaks the report. */
function notifyAgent(agent, mode, message, log) {
  if (mode === 'off') return
  const verb = mode === 'inject' ? 'inject' : 'steer'
  if (typeof agent?.[verb] !== 'function') {
    log.warn(`agent.${verb}() is unavailable; the report stays with the user`)
    return
  }
  try {
    agent[verb](message)
    log.info(`report handed to the agent via agent.${verb}()`)
  } catch (error) {
    log.warn(`agent.${verb}() rejected the report: ${String(error)}`)
  }
}

function renderPayload(report, payload) {
  return `${report}\n\n${MARKER}\n\`\`\`json\n${JSON.stringify(payload, null, 2)}\n\`\`\`\n`
}

export function apply(ctx) {
  // stdout keeps runs visible in harness.log; ctx.logger only buffers.
  const log = {
    info: message => console.log(`[code-review] ${message}`),
    warn: message => console.warn(`[code-review] ${message}`),
  }

  // A fresh harness home has no settings file at all, and the file a user is
  // told to edit has to exist before the first `/review` asks them to edit it.
  ensureSettingsFile(log)

  ctx.effect(() => ctx.commands.register({
    name: 'review',
    description: 'Review the changes of this workspace in one of its modes and show a report card.',
    input: { hint: '[full|session] [mode=<id>] [provider=<id>] [model=<id>] [reasoningEffort=<id>] [ignored=<pattern,…>] [focus message]' },
    handler: async ({ agent, rawInput, signal }) => {
      const invocation = parseInvocation(rawInput)
      const overrides = invocation.overrides
      const scope = invocation.scope === 'session' ? 'session' : 'full'
      // The file is read, completed and then read again per run: a mode the user
      // just wrote is available on the next command, with no restart.
      const fileSettings = loadSettings(log)
      const resolvedMode = resolveMode(fileSettings, overrides, log)
      if (resolvedMode.failure !== undefined) {
        return { kind: 'error', text: `code-review: ${resolvedMode.failure}` }
      }
      const mode = resolvedMode.mode
      // A mode is a preset: its settings win over the file's own and lose to
      // what was typed after `/review`.
      const settings = { ...fileSettings, ...mode.settings }
      const focus = clamp(invocation.message, positiveInt(settings.maxHintChars, DEFAULTS.maxHintChars))
      const provider = overrides.provider ?? settings.provider
      const model = overrides.model ?? settings.model
      const reviewerProvider = firstNonEmpty(provider, agent?.options?.provider, agent?.provider)
      const reviewerModel = firstNonEmpty(model, agent?.options?.model, agent?.model)
      const session = agent?.session

      if (session === undefined || typeof session.snapshotEvents !== 'function') {
        return { kind: 'error', text: 'code-review: this session has no readable change record.' }
      }
      if (reviewerProvider === undefined || reviewerModel === undefined) {
        return { kind: 'error', text: `code-review: no reviewer route — set "provider"/"model" in ${configPath()} or pass provider=… model=… .` }
      }

      // The route is the whole model selection — who reviews, and how hard it
      // thinks — so everything downstream reads one object.
      const reasoningEffort = resolveReasoningEffort(mode, fileSettings, overrides)
      const route = {
        provider: reviewerProvider,
        model: reviewerModel,
        ...reasoningEffort === undefined ? {} : { reasoningEffort },
      }
      const effortFailure = await checkReasoningEffort(ctx, route, reasoningEffort, signal)
      if (effortFailure !== undefined) return { kind: 'error', text: `code-review: ${effortFailure}` }

      const limits = {
        maxFiles: positiveInt(settings.maxFiles, DEFAULTS.maxFiles),
        maxDiffChars: positiveInt(settings.maxDiffChars, DEFAULTS.maxDiffChars),
        ignore: resolveIgnoreSettings(settings, overrides, log),
      }
      const source = overrides.source ?? settings.source
      const sourceMode = source === 'git' || source === 'session' ? source : 'auto'
      const gitRev = firstNonEmpty(overrides.gitRev, settings.gitRev, DEFAULTS.gitRev)
      const cwd = firstNonEmpty(session.header?.cwd, session.cwd, process.cwd())
      const notes = []
      let collected

      if (sourceMode !== 'session') {
        collected = await collectGitChanges(
          ctx, cwd, limits, gitRev, scope, root => sessionTouchedPaths(session, root), signal, log,
        )
        if (collected.failure !== undefined) {
          notes.push(`git: ${collected.failure}`)
          if (collected.failure === 'all-skipped') {
            const ignored = collected.ignore?.count ?? 0
            return {
              kind: 'error',
              text: `code-review: ${collected.files} changed file(s) against ${gitRev}, but every one was skipped (binary, oversized, or over the diff budget)` +
                `${ignored === 0 ? '' : `, and ${ignored} more were excluded by the ignore rules`} — raise maxFiles/maxDiffChars and run /review again.`,
            }
          }
          if (collected.failure === 'all-ignored') {
            return {
              kind: 'error',
              text: `code-review: ${collected.files} changed file(s) against ${gitRev}, but every one is excluded by the ignore rules (${ignoreSampleText(collected.ignore)}) — nothing is left to review.` +
                ` Rules in force: ${ignoreRuleLine(collected.ignore)}.` +
                ' Set "ignoreDefaults": false or add patterns to "ignored" in DSH_HOME/code-review/config.json,' +
                ' or type /review ignored=!<pattern> to put one path back.',
            }
          }
          if (collected.failure === 'session-ignored') {
            const dropped = collected.touchedIgnored
            return {
              kind: 'error',
              text: `code-review: session scope has nothing to review — ${dropped.length} of the ${collected.touched.length} file(s) this session wrote or edited ${dropped.length === 1 ? 'is' : 'are'} excluded by the ignore rules: ${excludedText(dropped)}.` +
                ` Rules in force: ${ignoreRuleLine(collected.ignore)}.` +
                ' Run /review full to review the whole working tree, or put one path back with /review ignored=!<pattern>.',
            }
          }
          if (collected.failure === 'session-clean') {
            return {
              kind: 'error',
              text: `code-review: session scope has nothing to review — this session wrote or edited ${collected.touched.length} file(s), and none of them differs from ${gitRev} (${collected.files} other file(s) in the working tree were not touched by this session). Run /review full to review the whole working tree.`,
            }
          }
          collected = undefined
        }
      }

      if (collected === undefined && sourceMode !== 'git') {
        // The recorded events are durable, but the summary and the file snapshots
        // behind each one live in this Host process only, so walk back to the
        // newest record that is still served rather than giving up.
        let behind = 0
        for (const seq of changeSeqs(session)) {
          const candidate = await collectSessionChanges(ctx, session, seq, limits, signal)
          if (candidate.failure !== 'unavailable') {
            collected = candidate
            collected.recordBehind = behind
            break
          }
          behind += 1
        }
        if (collected === undefined) notes.push('session record: none still served')
      }

      if (collected === undefined) {
        return {
          kind: 'error',
          text: `code-review: nothing to review — ${notes.join('; ')}. Change a file and run /review again; if the work is already committed, set "gitRev" (for example "HEAD~1") in DSH_HOME/code-review/config.json.`,
        }
      }
      if (collected.reviewed === 0) {
        const ignored = collected.ignore?.count ?? 0
        const why = collected.files === 0
          ? ignored > 0
            ? `every one of the ${ignored} changed file(s) is excluded by the ignore rules (${ignoreSampleText(collected.ignore)})`
            : 'no file changed'
          : 'every changed file was skipped (binary, oversized, or over the diff budget)'
        return { kind: 'error', text: `code-review: nothing to review — ${why}.` }
      }

      // The session-record source *is* this session's own work, so the whole
      // reviewed set is primary. Only the git source has a wider change set,
      // where `touched` decides which of the working-tree changes are ours.
      const touched = collected.source === 'session' ? collected.paths : collected.touched ?? []
      const touchedSet = new Set(touched.map(path => path.replace(/\\/g, '/').toLowerCase()))
      const primary = collected.paths.filter(path => touchedSet.has(path.replace(/\\/g, '/').toLowerCase()))
      const others = collected.paths.filter(path => !touchedSet.has(path.replace(/\\/g, '/').toLowerCase()))
      const turn = collected.summary.turn
      const stats = {
        source: collected.source,
        base: collected.base,
        cwd,
        sourceLabel: collected.source === 'git'
          ? `git working tree vs ${collected.base} in ${collected.summary.cwd}${scope === 'session' ? ' — session files only' : ''}`
          : `session turn ${turn} in ${collected.summary.cwd}`,
        scope: collected.source === 'git' ? scope : 'session',
        turn,
        files: collected.files,
        filesTotal: collected.filesTotal ?? collected.files,
        added: Number.isInteger(collected.summary.added) ? collected.summary.added : 0,
        deleted: Number.isInteger(collected.summary.deleted) ? collected.summary.deleted : 0,
        reviewed: collected.reviewed,
        skipped: collected.skipped,
        ignore: collected.ignore,
        recordBehind: collected.recordBehind ?? 0,
      }
      const prompt = renderPrompt({
        diffs: collected.diffs,
        stats,
        focus,
        language: firstNonEmpty(overrides.language, settings.language) ?? '',
        cwd,
        mode,
        primary,
        others,
      })
      const readerOn = settings.projectAccess === true
      // What the harness can run is a property of the deployment, not of this
      // run, so the toolbox is built either way and `readerStop` decides whether
      // this run may use it — a run with project access off is told that, not
      // that the harness lacks the tool.
      const toolbox = readerToolbox(ctx, agent)
      if (readerOn) {
        for (const spec of READER_TOOL_SPECS) {
          if (spec.needs !== undefined && toolbox?.has(spec.needs) !== true) {
            log.warn(`this harness exposes no "${spec.needs}" tool to the run; ${spec.name} will not be offered`)
          }
        }
      }

      const maxToolCalls = positiveInt(settings.maxToolCalls, DEFAULTS.maxToolCalls)
      const timeoutMs = positiveInt(settings.timeoutMs, DEFAULTS.timeoutMs)
      const deadlineAt = Date.now() + Math.round(timeoutMs * ratio(settings.toolDeadlineRatio, DEFAULTS.toolDeadlineRatio))
      // The file the numbers came from, and the numbers: "my setting was ignored"
      // is otherwise indistinguishable from "the file was never read at all".
      log.info(
        `settings from ${configPath()}: maxFiles=${limits.maxFiles}, maxDiffChars=${limits.maxDiffChars},` +
        ` maxToolCalls=${maxToolCalls}, timeoutMs=${timeoutMs}, projectAccess=${readerOn}`,
      )
      log.info(
        `mode=${mode.id} (${mode.label}, prompt: ${mode.promptFrom === 'file' ? 'config.json' : "this release's default"},` +
        ` ${mode.fields.length} field(s), ${mode.severities.map(severity => severity.id).join('/')})`,
      )
      log.info(
        `reviewing ${stats.reviewed}/${stats.files} file(s) (${stats.scope} scope) via ${route.provider}/${route.model}` +
        (route.reasoningEffort === undefined ? '' : ` (thinking: ${route.reasoningEffort})`) +
        (readerOn ? ` with read-only project access (up to ${maxToolCalls} reads)` : '') +
        (focus === '' ? '' : ` · focus: ${clamp(focus, 80)}`),
      )
      if ((stats.ignore?.count ?? 0) > 0) {
        log.info(`${stats.ignore.count} changed file(s) excluded by the ignore rules — ${ignoreSampleText(stats.ignore)}`)
      }
      const combined = AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)])

      let review
      try {
        review = await runReview({
          ctx,
          route,
          mode,
          settings: {
            maxTokens: positiveInt(settings.maxTokens, DEFAULTS.maxTokens),
            temperature: typeof settings.temperature === 'number' ? settings.temperature : DEFAULTS.temperature,
            projectAccess: readerOn,
            maxToolCalls,
            maxReadBytes: positiveInt(settings.maxReadBytes, DEFAULTS.maxReadBytes),
            maxSearchResults: positiveInt(settings.maxSearchResults, DEFAULTS.maxSearchResults),
          },
          policy: collected.policy,
          prompt,
          toolbox,
          diffs: collected.diffs,
          paths: collected.paths,
          root: collected.summary.cwd,
          signal: combined,
          userSignal: signal,
          deadlineAt,
          log,
        })
      } catch (error) {
        if (signal.aborted) return { kind: 'error', text: 'code-review: review cancelled.' }
        log.warn(`reviewer call failed: ${String(error)}`)
        return { kind: 'error', text: `code-review: the reviewer call failed — ${String(error)}` }
      }

      if (review.failure !== undefined) {
        if (review.cancelled === true) return { kind: 'error', text: 'code-review: review cancelled.' }
        log.warn(`unusable reviewer output: ${review.failure}`)
        const last = review.lastText === undefined || review.lastText.trim() === ''
          ? ''
          : `\n\nIts last message was:\n\n${clamp(review.lastText, 2000)}`
        // The route hint is for the one failure it explains — a model that never
        // called a tool at all; a run that did and still ended empty says why.
        const hint = review.toolsUsed === true
          ? ''
          : ' This review needs a route whose model can call tools.'
        return {
          kind: 'error',
          text: `code-review: the reviewer recorded no finding — ${review.failure}.${hint} Run /review again.` + last,
        }
      }

      const { findings: kept, withheld, verdict, summary, incomplete } = review
      stats.context = {
        calls: review.budget.calls,
        files: review.files,
        bytes: review.budget.bytes,
        keptBytes: review.contextBytes,
      }
      stats.store = review.store
      stats.reviewerFallback = review.fellBack === true
      const noticeMode = NOTIFY_MODES.has(settings.notifyAgent) ? settings.notifyAgent : DEFAULTS.notifyAgent
      const reportInput = {
        verdict,
        summary,
        findings: kept,
        withheld,
        stats,
        route,
        mode,
        incomplete,
      }
      const payload = {
        schema: SCHEMA,
        mode: {
          id: mode.id,
          label: mode.label,
          promptFrom: mode.promptFrom,
          verdict: { id: verdict, label: mode.verdicts[verdict] ?? verdict },
          severities: mode.severities.map(severity => ({ id: severity.id, label: severity.label, tone: severity.tone })),
          fields: mode.fields.map(field => ({ key: field.key, label: field.label, block: field.block })),
        },
        source: stats.source,
        base: stats.base,
        scope: stats.scope,
        focus,
        verdict,
        summary,
        findings: kept,
        withheld,
        incomplete: incomplete ?? null,
        stats,
        reviewer: route,
        turn: stats.turn,
        cwd: stats.cwd,
        time: Date.now(),
      }

      log.info(
        `review done: ${mode.id} ${verdict}${incomplete === undefined ? '' : ' (incomplete)'}, ` +
        `${kept.length} proven finding(s), ${withheld.length} withheld, ` +
        `${review.store.calls} store call(s) (${review.store.appended} recorded, ${review.store.updated} updated, ${review.store.deleted} deleted)`,
      )
      notifyAgent(agent, noticeMode, {
        id: randomUUID(),
        role: 'user',
        content: [{ type: 'text', text: renderAgentNotice(reportInput) }],
        source: { kind: 'code-review', form: 'notice', summary: noticeSummary(reportInput) },
      }, log)
      return { kind: 'success', text: renderPayload(renderReport(reportInput), payload) }
    },
  }), 'code-review: /review command')

  log.info('code-review ready: /review audits the uncommitted changes of this workspace in the mode you name')
}
