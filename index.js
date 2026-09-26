/**
 * dsh-code-review — Host half.
 *
 * Audits the uncommitted changes in one workspace — the session's own files when
 * the scope is `session` — in one of its **modes**, and hands the report to the
 * human who asked for it. Trigger is the human `/review` command; the report
 * comes back as the command result (a card in the Client) and is theirs alone —
 * the Agent is told about it only when `notifyAgent` is set to `steer` or
 * `inject`. Nothing is ever written to the workspace.
 *
 * A mode is a role: its persona prompt, its task, the fields one finding states,
 * the severity vocabulary that decides the verdict, and a preset of run settings.
 * Two are built in — `cr` (code review, the default) and `arc` (architecture
 * review) — and a user adds their own under `modes` in the settings file. The
 * defaults live in this module; the settings file is kept complete by an
 * additive sync, and whatever the file states wins. What a mode can never change
 * is the evidence gate: every finding quotes its proof verbatim and is checked
 * mechanically against the diff and what the reader tools returned. See
 * `BUILT_IN_MODES`, `renderContract` and `verifyFindings`.
 *
 * Settings: DSH_HOME/code-review/config.json — created with the defaults when it
 * is missing, missing keys added on load, re-read on every run.
 *
 * Ignored paths are a guarantee, not a preference: `node_modules`, build output,
 * caches and the rest of the standard list are dropped before any diff is built
 * or any file is read, so they cannot reach the reviewer's prompt, its evidence
 * check or its findings. See `DEFAULT_IGNORE` and `createIgnore`.
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

/** The mode `/review` runs when neither the command line nor the file names one. */
const DEFAULT_MODE_ID = 'cr'

/** Finding keys a mode may not declare as a narrative field: the structure, not the prose. */
const RESERVED_FIELD_KEYS = new Set(['severity', 'category', 'file', 'line', 'title', 'summary'])

/** Chip tones the Client knows how to draw. */
const TONES = new Set(['error', 'warn', 'success', 'muted'])

/**
 * How much each verdict claims. The ranking is what lets a severity table be
 * read without trusting the order the file happens to list it in: a substitution
 * or a fallback picks the entry that claims least.
 */
const VERDICT_WEIGHT = { pass: 0, warn: 1, fail: 2 }

/** Verdicts a severity may force on a run. */
const VERDICTS = new Set(Object.keys(VERDICT_WEIGHT))

/** A unified-diff hunk header, capturing its old-side and new-side line counts. */
const HUNK_HEADER = /^@@ -\d+(?:,(\d+))? \+\d+(?:,(\d+))? @@/

/**
 * git's marker for a binary file. It is anchored at column 0 on purpose: hunk
 * content always carries a `+`, `-` or space prefix, so a diff line can never
 * look like this.
 */
const BINARY_DIFF_MARKER = /^Binary files .+ differ$/m

/** The harness bounds a `notice` source summary to 120 characters. */
const NOTICE_SUMMARY_MAX_CHARS = 120

const NOTIFY_MODES = new Set(['steer', 'inject', 'off'])

/**
 * The run settings. Every key is a default a mode may override; the settings
 * file holds one of each, and `modes` (appended by the sync, documented in the
 * README) holds the modes themselves. Exported for the self-test, which asserts
 * the created file against it; not part of the plugin contract.
 */
export const DEFAULTS = {
  /** The mode `/review` runs unless `mode=` names another one. */
  mode: 'cr',
  provider: '',
  model: '',
  language: '',
  /** `auto` prefers the git working tree and falls back to the session record. */
  source: 'auto',
  /** Revision the git source compares the working tree against. */
  gitRev: 'HEAD',
  /**
   * The report is for the user. By default the Agent is not told at all: a
   * review is a decision aid, and handing it over starts work nobody approved.
   * `steer` and `inject` are opt-in for a user who wants the Agent in the loop.
   */
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
  /** Covers the whole reader loop, not one model call. */
  timeoutMs: 600_000,
  /** Extra ignore patterns, on top of the built-in standard list. */
  ignored: [],
  /** Whether the built-in standard list applies at all. */
  ignoreDefaults: true,
  /** Whether the repository's own ignore rules are honored (git source only). */
  respectGitIgnore: true,
}

/** Output cap for the one retry after a provider rejects the configured one. */
const FALLBACK_MAX_TOKENS = 8192

/**
 * What a review is never useful on: dependency trees, build output, generated
 * bundles, caches, coverage, editor and OS noise, and the local files nobody
 * commits. The list is deliberately broad, because the workspace under review
 * may keep no `.gitignore` at all — and where one exists, the repository cannot
 * be the only thing standing between the diff and a dependency tree.
 *
 * Order matters exactly once: `.env.*` takes the real environment files out and
 * the `!.env.example` lines put the committed samples back.
 */
const DEFAULT_IGNORE = [
  // Version-control metadata.
  '.git/', '.hg/', '.svn/', '.bzr/', '_darcs/', 'CVS/',
  // Dependency trees, fetched or vendored.
  'node_modules/', 'bower_components/', 'jspm_packages/', '.pnp.*', '.npm/', '.pnpm-store/',
  '.yarn/cache/', '.yarn/unplugged/', '.yarn/install-state.gz', '.yarn/build-state.yml',
  'vendor/', '.venv/', 'venv/', 'virtualenv/', 'site-packages/', '__pypackages__/',
  '.bundle/', 'Pods/', '.gradle/', '.m2/',
  // Build output, generated code and compiled artifacts.
  'dist/', 'build/', 'out/', 'target/', 'obj/', '_build/', '.next/', '.nuxt/', '.output/',
  '.svelte-kit/', '.angular/', '.astro/', '.docusaurus/', '.parcel-cache/', '.turbo/', '.vite/',
  '.webpack/', 'storybook-static/', 'cmake-build-*/', 'CMakeFiles/', 'bazel-*', '_site/',
  '.jekyll-cache/', '*.class', '*.o', '*.obj', '*.a', '*.so', '*.dylib', '*.dll', '*.exe',
  '*.dSYM/', '*.gcda', '*.gcno', '*.gcov', '*.egg-info/', '.eggs/', '*.egg', '*.tsbuildinfo',
  '*.nupkg', '*.gem', '*.min.js', '*.min.css', '*.js.map', '*.css.map',
  // Caches, coverage and tool state.
  '.cache/', '.sass-cache/', '.eslintcache', '.stylelintcache', '.nyc_output/', 'coverage/',
  'htmlcov/', '.coverage', '.pytest_cache/', '.mypy_cache/', '.ruff_cache/', '.pytype/',
  '.tox/', '.nox/', '.hypothesis/', '__pycache__/', '*.py[cod]', '*$py.class',
  '.ipynb_checkpoints/', '.terraform/', '.terragrunt-cache/', '.serverless/', '.fusebox/',
  '.dynamodb/', '.firebase/', 'mlruns/', 'wandb/', 'lightning_logs/', '.history/',
  '.node_repl_history',
  // Editor, IDE and OS noise.
  '.idea/', '.vscode/', '.vs/', '.fleet/', '.settings/', '.project', '.classpath', '*.iml',
  '*.swp', '*.swo', '*~', 'xcuserdata/', 'DerivedData/', '.build/', '.DS_Store', '._*',
  '.Spotlight-V100/', '.Trashes/', 'Thumbs.db', 'ehthumbs.db', 'desktop.ini', '$RECYCLE.BIN/',
  '*.lnk',
  // Logs, dumps, local databases and the files nobody commits.
  '*.log', 'logs/', '*.tmp', '*.temp', '*.bak', '*.orig', '*.rej', '*.pid', '*.seed',
  '*.stackdump', '*.sqlite', '*.sqlite3', '*.db', 'local.properties',
  '.env', '.env.*', '!.env.example', '!.env.sample', '!.env.template', '!.env.dist',
]

/** How many excluded paths the report names before it settles for the count. */
const IGNORE_SAMPLE_MAX = 5

/** On Windows and macOS a path matches its own spelling in any case, and git follows the filesystem. */
const CASE_INSENSITIVE_MATCH = process.platform === 'win32' || process.platform === 'darwin'

/** Once the reader pulls in more than this, the oldest tool results leave the model's context. */
const ELIDE_AFTER_BYTES = 200_000

const KEEP_RECENT_RESULTS = 2

/**
 * The narrative fields a mode that declares none works with: what is wrong, and
 * the proof. Every mode states at least these, and the evidence is never
 * optional — the gate is what makes a finding worth reading.
 */
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

/** The severity vocabulary a mode that declares none works with — the code review one. */
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

/**
 * The part of a mode the user owns: who the reviewer is, and what it will not
 * report. Everything mechanical — the tools, the evidence bar, the required
 * fields, the severity table, the JSON shape — is appended by `renderContract`
 * and cannot be switched off, so a hand-written persona still produces findings
 * the gate can check.
 */
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

/**
 * The architecture mode: the same evidence bar, a different question. It judges
 * the shape of the change — placement, responsibility, boundaries, coupling —
 * rather than its defects, and it is allowed to read the project around the
 * change to do so. What it does not change is the gate: a design opinion without
 * a quote and without a stated cost is withheld like any other unproven claim.
 */
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

/**
 * The modes this release ships. Their prompts are kept here and synced into the
 * settings file; from then on the file is what decides, and deleting a key is how
 * a default comes back. Exported for the self-test, not part of the plugin
 * contract.
 */
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

/** The keys of one mode entry, in the order the settings file lists them. */
const MODE_KEYS = [
  'label', 'aliases', 'enabled', 'description', 'systemPrompt', 'task',
  'categories', 'fields', 'severities', 'verdicts', 'settings',
]

/** One mode entry as the settings file spells it: the documented keys, in the documented order. */
function modeEntry(mode) {
  return Object.fromEntries(MODE_KEYS.filter(key => Object.hasOwn(mode, key)).map(key => [key, clone(mode[key])]))
}

/** Keys of a mode entry that carry a prompt, so `promptSource` can say who wrote it. */
const PROMPT_KEYS = ['systemPrompt', 'task', 'fields', 'severities', 'verdicts', 'categories']

/** A JSON object, not an array and not null. */
function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

/** A deep copy, so a built-in definition handed to the settings file is never shared. */
function clone(value) {
  return structuredClone(value)
}

/** A mode string setting: trimmed, and empty when it is not a string at all. */
function modeText(value) {
  return typeof value === 'string' ? value.trim() : ''
}

/** A list of names: an array of strings, or one string used as a single entry. */
function nameList(value) {
  if (typeof value === 'string') return value.trim() === '' ? [] : [value.trim()]
  if (!Array.isArray(value)) return []
  return value.filter(entry => typeof entry === 'string' && entry.trim() !== '').map(entry => entry.trim())
}

/**
 * The narrative fields of one mode, in the order the report and the card show
 * them. A field the mode did not declare keeps its shape: an empty label renders
 * the text bare, `required` defaults to true for a declared field (an
 * unanswered field is withheld, never silent), and `evidence` is appended and
 * forced to required when the mode left it out — the gate is not optional.
 */
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

/**
 * The severity vocabulary of one mode: the ids the model may use, how each is
 * drawn in the card, which verdict it forces, and what it means (the last is
 * quoted in the contract, so an arbitrary vocabulary still defines itself).
 */
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

/** The display label of each verdict, which is the mode's own wording for its answer. */
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

/** The run settings a mode presets; they win over the file's own and lose to the command line. */
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

/** Two JSON values, as a mode file spells them, are the same. */
function sameJson(left, right) {
  return JSON.stringify(left ?? null) === JSON.stringify(right ?? null)
}

/**
 * Whether a mode entry still carries the prompt this release ships. The result
 * is what the report calls the prompt's source, so a user can tell "my edit is
 * in force" from "this is the release default" without diffing the file.
 */
function promptUnchanged(entry, fallback) {
  return PROMPT_KEYS.every(key => sameJson(entry[key], fallback[key]))
}

/**
 * One mode entry, with every key a usable value: what the user wrote where the
 * user wrote it, the release default everywhere else. A mode that is not a JSON
 * object at all is reported and replaced by its default, so a hand-edited file
 * can never leave a mode half-defined.
 */
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
    /** Whether this mode ships with the plugin, which is what the sync keeps complete. */
    builtIn: fallback !== undefined,
    /** `file` when someone edited the prompt, `default` when it is still this release's. */
    promptFrom: fallback === undefined || (isPlainObject(raw) && !promptUnchanged(raw, fallback)) ? 'file' : 'default',
  }
}

/**
 * Every mode the file declares, in resolution order: the built-in ids first,
 * then the user's own. An id always beats an alias, and an alias that names
 * another mode is not an alias at all — so a user mode can never quietly take
 * over a name the file already gave to something else.
 */
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

/** The modes a run can pick, as the error message and the log name them. */
function availableModes(modes) {
  const enabled = modes.filter(mode => mode.enabled)
  const list = enabled.map(mode => `${mode.id} (${mode.label})`).join(', ')
  return list === '' ? 'none are enabled' : `available: ${list}`
}

/**
 * Which mode this run uses: what was typed, else the file's `mode`, else `cr`.
 *
 * A name typed on the command line that does not resolve — or that resolves to a
 * mode switched off — is an error, because a run that silently answered as
 * another mode would be a lie about what is in the report. A broken default in
 * the file is a warning and falls back to the first mode that is on: a typo in a
 * setting must not make `/review` unusable.
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
 * What every mode is told, whatever its persona says: the tools, the evidence
 * bar, the fields a finding must state, the severity table, the categories and
 * the exact JSON shape. Appended to the mode's own prompt and not writable by
 * it, because these are the rules the run is verified against.
 */
function renderContract(mode) {
  const fields = mode.fields
    .map(field => `- "${field.key}" (${field.label === '' ? field.key : field.label})${field.required ? ' — required' : ' — optional'}${field.guide === '' ? '' : `: ${field.guide}`}`)
    .join('\n')
  const severities = mode.severities
    .map(severity => `- ${severity.id} (${severity.label}) — ${severity.verdict === 'pass' ? 'does not move the verdict' : `forces the verdict to "${severity.verdict}" at least`}${severity.meaning === '' ? '' : `: ${severity.meaning}`}`)
    .join('\n')
  const categories = mode.categories.length === 0
    ? ''
    : `\n## Categories\n\n${mode.categories.join(', ')}\n`
  return `## Reading the project

You have three read-only tools: read_file, list_dir and search. They are the only way you touch the workspace, and they cannot change anything or run anything — there is no command execution, no write, and no network. Paths the review excluded as ignored — dependency trees, build output, caches — are outside the project as far as you are concerned: they are not in the diff, the tools refuse them, and nothing found in them is a finding.

Use them to settle a specific question, not to explore:
- Before reporting a finding that depends on code outside the diff — a caller's arguments, a function's contract, a type's definition, whether a guard already exists upstream — read that code and confirm it. A suspicion you did not check is not a finding.
- Also read when the diff alone is genuinely ambiguous about what the change does.
- Do not tour the repository, do not read files unrelated to the change, and do not read a file twice to look for more. The budget is small and it is shown to you as it shrinks.
- Reading is for verification, never for finding extra work to report. Anything you notice outside the change set is out of scope unless this diff makes it reachable or worse.

## Evidence bar — this is the whole job

- Every finding MUST quote, in "evidence", the exact line or lines that prove it, copied verbatim: a diff line including its leading "+", "-" or space, or a line from a file you actually read.
- Every quoted line is checked mechanically against the diff and against everything the tools returned to you. A quote that does not occur there is discarded together with its finding.
- If you cannot quote such lines, you do not have a finding. Drop it completely: do not report it, do not hint at it, do not mention it in your summary, do not downgrade it into a "consider" note.
- Reachability counts. A problem that requires an input, state or call path that the code shows to be impossible is not a finding.
- Pre-existing code is not yours to review. Report a pre-existing problem only when this diff makes it reachable or worse, and say which changed line does that.

## What a finding must state

${fields}

Every field marked required must be answered in the finding's own words, at the depth its guide asks for. A finding that cannot answer one of them is withheld and never published.

## Severity

${severities}

Never inflate a severity: you will be held to it. If you hesitate between two severities, choose the lower one. A matter of taste is not the lowest severity; it is not a finding at all.
${categories}
## Output

Output exactly one JSON object, with no prose and no code fence:
${jsonTemplate(mode)}

The verdict is recomputed from the severities of the findings that survive, so never state a verdict the findings do not support. "summary" says what the change set does and whether it holds up, and it mentions only what you kept.

## Self-check before you answer

Re-read your own findings and delete every one that fails any of these: (a) it carries a verbatim quote that occurs in the diff or in something the tools returned; (b) everything it depends on has been read and confirmed, not assumed; (c) the path or the consequence it describes is reachable per what you read, and you can describe it; (d) every required field is answered in concrete terms; (e) it is the kind of problem this mode is here to find, not a matter of taste; (f) it is worth an expert author's attention. Then re-check that your summary describes only what you kept.`
}

/** The JSON object the mode's reviewer must return, built from the mode's own vocabulary. */
function jsonTemplate(mode) {
  const severity = mode.severities.map(entry => entry.id).join('"|"')
  const category = mode.categories.length === 0 ? '<one category>' : mode.categories.join('|')
  const members = [
    `"severity":"${severity}"`,
    `"category":"${category}"`,
    '"file":"<path exactly as the diff names it>"',
    '"line":<number the diff shows for the new file, or null>',
    '"title":"<short, specific, imperative>"',
    ...mode.fields.map(field => `"${field.key}":"${
      field.block
        ? '<verbatim line(s) proving it — from the diff or from a file you read — each on its own line>'
        : `<${field.key}>`
    }"`),
  ]
  return `{"verdict":"fail"|"warn"|"pass","summary":"<2-4 factual sentences: what the change set does and whether it holds up>","findings":[{${members.join(',')}}]}`
}

/** The system prompt of one run: the mode's own persona, then the contract it cannot change. */
function systemPromptFor(mode) {
  const contract = renderContract(mode)
  return mode.systemPrompt === '' ? contract : `${mode.systemPrompt}\n\n${contract}`
}

/** `~`, `~/…` and `~\…` expand against the operating-system home. */
function expandHomePath(path) {
  if (path === '~') return homedir()
  if (path.startsWith('~/') || path.startsWith('~\\')) return join(homedir(), path.slice(2))
  return path
}

/**
 * The harness home, resolved the way the harness itself resolves it: `$DSH_HOME`
 * when it is set and not blank, otherwise `~/.dsh`. The current working
 * directory is deliberately not a candidate — `dsh web` is started from wherever
 * the user happens to be (the harness checkout, most often), and reading a
 * config from there meant every setting silently fell back to the defaults.
 *
 * Mirrors `resolveDshHome` from `@deepseek-ai/dsh-home-paths`; this package has
 * no dependencies, so the rule is repeated rather than imported.
 */
function dshHome() {
  const configured = process.env.DSH_HOME
  const selected = typeof configured === 'string' && configured.trim() !== ''
    ? configured
    : join(homedir(), '.dsh')
  return resolve(expandHomePath(selected))
}

/** `DSH_HOME/code-review/config.json`. */
function configPath() {
  return join(dshHome(), 'code-review', 'config.json')
}

/** The whole settings file a fresh machine gets: the run settings, then the modes. */
function defaultDocument() {
  return {
    ...clone(DEFAULTS),
    modes: Object.fromEntries(Object.entries(BUILT_IN_MODES).map(([id, mode]) => [id, modeEntry(mode)])),
  }
}

/**
 * Create `DSH_HOME/code-review/config.json` with the defaults when no file is
 * there yet, so the file the user is told to edit exists on a fresh machine.
 *
 * Exclusive create is the whole contract: an existing file — hand-tuned, left by
 * an earlier release, or unparsable — is never touched, and a concurrent boot
 * loses the race with EEXIST instead of truncating the winner's file. Writing is
 * best-effort by construction: a home that cannot be written warns and leaves
 * this run on the defaults.
 *
 * @returns whether this call created the file.
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
 * Adds what the file is missing — a release setting, the `modes` block, a mode
 * this release ships, a key inside one — and never replaces a value the user
 * wrote. The file's own key order and any key of its own are kept, the additions
 * are appended, and a value that exists but is the wrong shape is reported and
 * left exactly as it is rather than repaired behind the user's back.
 *
 * The one rule worth remembering: deleting a key is how the release default
 * comes back, and a built-in mode is removed from the command surface with
 * `"enabled": false`, not by deleting it.
 *
 * @returns the document to work with, and the list of keys this call added.
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

/** Writes the synced document, best-effort: a read-only home warns and the run goes on. */
function writeSynced(log, file, doc, added) {
  try {
    writeFileSync(file, `${JSON.stringify(doc, null, 2)}\n`, { encoding: 'utf8' })
    log.info(`synced ${added.join(', ')} into ${file}`)
  } catch (error) {
    log.warn(`cannot write ${file}: ${String(error)}; this run uses the values in memory`)
  }
}

/**
 * The settings of this run, and the file the user edits.
 *
 * The file is created when it is missing and completed when it is incomplete,
 * and it is re-read on every `/review`, so tuning needs neither a restart nor a
 * reload. A file that does not parse is reported and left alone; the run uses
 * the defaults and the next release's prompts are then the ones in force.
 */
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

/** Keys accepted as leading `key=value` arguments of the command. */
const ARG_KEYS = new Set([
  'mode', 'provider', 'model', 'language', 'gitRev', 'source',
  'ignored', 'ignore', 'ignoreDefaults', 'respectGitIgnore',
])

/** `key=value`, where the value may be quoted so a pattern can hold a space. */
const ARG_TOKEN = /^([A-Za-z]+)=(?:"([^"]*)"|'([^']*)'|(\S+))(?:\s+|$)/

/**
 * `/review [full|session] [key=value …] [focus message]`.
 *
 * Only leading arguments are parsed, so the focus message may contain anything,
 * including '=' and the word "session". `ignored=` may be repeated and takes a
 * comma-separated list, so one command names as many patterns as it likes;
 * `!pattern` puts a path back that the config or the built-in list took out.
 */
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

/** The Agent's route lives on `agent.options`; older compositions used top-level `agent.provider`/`agent.model`. */
function firstNonEmpty(...values) {
  for (const value of values) {
    if (typeof value === 'string' && value !== '') return value
  }
  return undefined
}

function clamp(text, max) {
  const value = typeof text === 'string' ? text.trim() : ''
  return value.length > max ? `${value.slice(0, max)}…` : value
}

/** A literal form of arbitrary text, for the parts of a pattern that are not globs. */
function escapeRegExpText(text) {
  return String(text).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/** The characters that make a pattern a glob rather than a plain name. */
const GLOB_CHARS = /[*?[\]\\]/

/**
 * One glob as a regular-expression body: `*` and `?` stop at a `/`, a run of
 * two stars followed by a slash spans directories, `[...]` is a class (`[!…]`
 * negates it) and `\x` is a literal. Literal stretches are escaped in one go.
 */
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
      // `**/` spans zero or more directories; every other run of stars is a
      // plain `*`, which is also how git reads `a**b`.
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
 * One gitignore-style pattern compiled into a matcher over slash-separated
 * paths, in the subset users actually write: `#` comments, `!` negation, a
 * leading or middle `/` anchoring the pattern at the root of the change set, a
 * trailing `/` naming a directory, `**` crossing directories.
 *
 * A pattern naming a directory also covers everything under it — git's own rule
 * — which is expressed here as an optional `/…` tail, because every candidate
 * offered to a rule is a file path. Blank entries and comments compile to
 * undefined, and a malformed class matches literally instead of throwing.
 *
 * A pattern that is a single plain name with no anchoring — `node_modules/`,
 * `dist/`, the bulk of the list — carries that name instead of a regular
 * expression, because "any component of the path equals it" is exactly what its
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

/** The form every rule is matched against: slash-separated, no leading `./`. */
function normalizeIgnorePath(path) {
  return String(path ?? '').replace(/\\/g, '/').replace(/^\.\/+/, '')
}

/** Config or typed patterns, however they were written: one string, a pasted .gitignore, or an array. */
function ignorePatternsFrom(value) {
  if (typeof value === 'string') return value.split(/[\n,]/)
  if (Array.isArray(value)) return value.filter(entry => typeof entry === 'string')
  return []
}

/** A boolean setting from the config or a typed argument; anything else keeps the fallback. */
function booleanSetting(value, fallback) {
  if (typeof value === 'boolean') return value
  if (typeof value === 'string') {
    const text = value.trim().toLowerCase()
    if (text === 'true' || text === '1' || text === 'yes' || text === 'on') return true
    if (text === 'false' || text === '0' || text === 'no' || text === 'off') return false
  }
  return fallback
}

/** A typed `key=…` boolean wins over the config file, and junk is reported rather than obeyed. */
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

/** The ignore rules one run works under: the built-in list, the config file, and what was typed. */
function resolveIgnoreSettings(settings, overrides, log) {
  return {
    defaults: resolveBoolean(overrides.ignoreDefaults, settings.ignoreDefaults, DEFAULTS.ignoreDefaults, 'ignoreDefaults', log),
    respectGit: resolveBoolean(overrides.respectGitIgnore, settings.respectGitIgnore, DEFAULTS.respectGitIgnore, 'respectGitIgnore', log),
    config: ignorePatternsFrom(settings.ignored),
    typed: Array.isArray(overrides.ignored) ? overrides.ignored : [],
  }
}

/** The rule a path is excluded by when only the repository's own ignore files name it. */
const GIT_IGNORE_RULE = { label: "the repository's own ignore rules", source: 'git', negated: false }

/**
 * The ignore policy of one run. Rules are evaluated in order and the LAST match
 * decides, so the config file and the command line override the built-in list
 * and each other, and a `!pattern` puts back what an earlier rule took out —
 * including what the repository itself ignores.
 *
 * The repository's own ignored paths are the base layer, not a rule: they decide
 * only when no pattern matched at all. `gitIgnored` holds tracked paths git
 * reports as ignored; untracked ignored files never reach this plugin, because
 * `git status` does not list them.
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
  // The plain names of the list, so one pass over a path's components decides
  // every literal rule at once and only the real globs reach an expression.
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
    /** The rule that excludes one path, or undefined when the path is kept. */
    ruleFor(path) {
      const candidate = normalizeIgnorePath(path)
      if (candidate === '') return undefined
      // `named` exists whenever any rule carries a name, which is the only case
      // in which the loop below asks it anything.
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

/**
 * Splits the candidate files of one change set into what the review takes and
 * what the ignore rules exclude. Each entry carries the path the rules are
 * matched against, the name the report shows, and the value the caller keeps
 * working with; nothing that comes back excluded is ever diffed or read, and the
 * excluded entry keeps its path so a caller can narrow the outcome — a session
 * review cares only about the session's own files.
 */
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

/** What one change set reports about the paths the ignore rules took out of it. */
function ignoreStats(ignore, excluded) {
  return {
    ...ignore.facts,
    count: excluded.length,
    sample: excluded.slice(0, IGNORE_SAMPLE_MAX).map(item => ({ file: item.file, rule: item.rule })),
  }
}

/** The rules a run had in force, as one line of the report. */
function ignoreRuleLine(ignore) {
  if (ignore === undefined) return ''
  const parts = []
  if (ignore.builtIn) parts.push(`built-in standard list (${ignore.builtInPatterns} patterns)`)
  if (ignore.configured > 0) parts.push(`${ignore.configured} configured`)
  if (ignore.typed > 0) parts.push(`${ignore.typed} typed`)
  if (ignore.gitIgnore) parts.push("the repository's own ignore rules")
  return parts.join(' + ')
}

/** `node_modules/a.js (node_modules/), …` — excluded files the way a report names them. */
function excludedText(items) {
  return items.slice(0, IGNORE_SAMPLE_MAX).map(item => `${item.file} (${item.rule})`).join(', ')
}

/** The same, for one run's ignore outcome. */
function ignoreSampleText(ignore) {
  return excludedText(ignore.sample)
}

/**
 * Paths this session wrote or edited, relative to `root`, read from its own
 * `write`/`edit` tool calls. The session log is durable, so this survives a
 * restart and never depends on the in-memory change recorder. Files changed by
 * a shell command are not attributable this way and show up only in `full`.
 *
 * `root` is canonicalized first, because `resolveInside` answers with a
 * canonical path: without this a symlinked or junctioned workspace would yield
 * a relative path that matches no git path.
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

/** Diffs of the newest change set, bounded by the file and character budgets; anything left out is reported. */
async function collectSessionChanges(ctx, session, seq, settings, signal) {
  const summary = ctx.workspaceChanges.summary(session.id, seq)
  if (summary === undefined) return { failure: 'unavailable' }

  const files = Array.isArray(summary.files) ? summary.files : []
  const ignore = createIgnore(settings.ignore)
  // The ignore rules decide before anything is fetched, and the index the record
  // diffs a file by is carried along, so a filtered list stays addressable.
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
    /** The policy itself, so the reader loop answers under exactly these rules. */
    policy: ignore,
  }
}

/**
 * Added/deleted line counts of a unified diff, matching `git diff --numstat`.
 *
 * The `+`, `-`, `---` and `+++` prefixes cannot be classified on their own: a
 * diff line is the prefix *plus* the content, so an added `++counter;` renders
 * as `+++counter;` and a deleted `-- drop table` renders as `--- drop table`,
 * byte-identical to the `--- a/path` and `+++ b/path` file headers. Counting is
 * therefore bounded by the hunk structure: only lines that follow a `@@` header,
 * and only as many as that header declares for each side, are counted.
 */
function countDiffLines(text) {
  let added = 0
  let deleted = 0
  let old = 0
  let newer = 0
  for (const line of text.split('\n')) {
    if (old > 0 || newer > 0) {
      // `\ No newline at end of file` annotates the line before it and counts as
      // neither side.
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
      // A file boundary can only start at column 0, because every hunk line
      // carries one of the four prefixes above; it ends a hunk whose declared
      // counts ran out early.
      if (line.startsWith('diff --git ')) {
        old = 0
        newer = 0
        continue
      }
      // A context line, including the empty string a blank source line yields.
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

/** An untracked file as a whole-file addition, the shape a diff reader expects. */
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

/** `git status --porcelain=v1 -z` records. */
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

/** One `git` invocation through the host subprocess service. */
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
    // `lossy` means the retained window lost its head: the output was longer
    // than the cap and what came back is its tail.
    truncated: stdout?.lossy === true,
    errors: handle.collected?.stderr?.readFrom(0).text ?? '',
  }
}

/**
 * Tracked paths the repository's own ignore rules cover. `git status` lists them
 * like any other tracked file and `git diff` happily diffs them — committing
 * `node_modules` once is enough — so the ignore files have to be asked for
 * separately. Untracked ignored files never reach this plugin at all, because
 * `git status` leaves them out.
 */
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

/**
 * Everything this workspace changed against `base` — committed since that
 * revision plus uncommitted — with untracked files as whole-file additions.
 *
 * The ignore rules run first, on paths alone: an ignored path is never diffed,
 * never read and never counted against `maxFiles`, so no dependency tree can
 * reach the reviewer through a budget it was allowed to spend.
 */
async function collectGitChanges(ctx, cwd, settings, base, scope, touchedFor, signal, log) {
  const subprocess = typeof ctx.get === 'function' ? ctx.get('subprocess') : undefined
  if (subprocess === undefined) return { failure: 'no-subprocess' }

  let git
  try {
    git = await subprocess.resolveExecutable('git', undefined, signal)
  } catch {
    return { failure: 'no-git' }
  }

  // Status and diff paths are relative to the repository root, never to the
  // session directory, so every command and path here resolves against the
  // root: `full` covers the whole repository, and `session` filters that list
  // down to the paths this session wrote or edited.
  const top = await runGit(subprocess, git, cwd, ['rev-parse', '--show-toplevel'], signal)
  if (top.exitCode !== 0) {
    log.warn(`git rev-parse failed in ${cwd}: ${top.errors.trim().slice(0, 200)}`)
    return { failure: 'no-repo' }
  }
  // `--show-toplevel` prints the path and a line ending: only that line ending is
  // stripped, because a directory name may itself end in whitespace.
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
  // `-z` names are exact and NUL-terminated, so they are used exactly as they
  // arrive: trimming one would name a different file, and the real change would
  // be reported as having no difference against the revision.
  const changedAll = named.text.split('\0').filter(name => name !== '')
  const candidates = changedAll.length + untrackedAll.length

  // The repository's own ignore rules are asked for once, and only when there
  // is something to filter: a clean tree pays nothing for them. They run before
  // any path is decided, so a tracked `node_modules` entry is caught by the
  // project's own rules as well as by the built-in ones.
  const respectGit = settings.ignore.respectGit === true
  const gitIgnored = respectGit && candidates > 0
    ? await ignoredByRepo(subprocess, git, root, signal, log)
    : new Set()
  const ignore = createIgnore({ ...settings.ignore, gitLayer: respectGit, gitIgnored })
  const asCandidate = path => ({ path, name: path, value: path })
  const tracked = partitionIgnored(ignore, changedAll.map(asCandidate))
  const fresh = partitionIgnored(ignore, untrackedAll.map(asCandidate))
  const excluded = [...tracked.excluded, ...fresh.excluded]

  // Attribution is asked for once the repository root is known, because git
  // paths are root-relative while the session's own paths are absolute.
  const touchedPaths = typeof touchedFor === 'function' ? touchedFor(root) : []
  const touched = new Set(touchedPaths.map(path => path.replace(/\\/g, '/').toLowerCase()))
  const fromSession = path => touched.has(path.replace(/\\/g, '/').toLowerCase())
  const sessionOnly = scope === 'session'
  const changed = sessionOnly ? tracked.kept.filter(fromSession) : tracked.kept
  const untracked = sessionOnly ? fresh.kept.filter(fromSession) : fresh.kept
  // A session review's change set is the session's own files, so its ignore
  // outcome is session-relative too: a working-tree file the session never
  // touched is neither reviewed here nor reported as excluded by this run.
  const ignoreFacts = ignoreStats(ignore, sessionOnly ? excluded.filter(item => fromSession(item.path)) : excluded)

  if (changed.length === 0 && untracked.length === 0) {
    // A change set that only holds ignored files says so: reporting it as a
    // clean tree would hide the very thing the user asked to have filtered.
    if (!sessionOnly && excluded.length > 0) {
      return { failure: 'all-ignored', ignore: ignoreFacts, files: excluded.length, filesTotal: candidates }
    }
    if (sessionOnly) {
      // The session's own paths decide this, not the working tree: `git status`
      // never lists an ignored untracked file, so a path this session wrote is
      // the only evidence that its change was dropped rather than never made.
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
    // The path is literal: a name holding `*`, `?` or `[...]` is otherwise read
    // as a glob and can match a different file.
    const diff = await runGit(subprocess, git, root, ['diff', '--no-color', '--unified=3', base, '--', `:(literal)${path}`], signal)
    if (diff.exitCode !== 0) {
      skipped.push({ file: path, reason: `git diff failed: ${diff.errors.trim().slice(0, 120)}` })
      continue
    }
    // Kept exactly as git wrote it: trimming the whole diff would rewrite the
    // trailing whitespace of a final added line, and the reviewer would then be
    // quoting something that is not in the file.
    const text = diff.text
    if (text.trim() === '') {
      skipped.push({ file: path, reason: `no difference against ${base}` })
      continue
    }
    // A tracked binary yields only its headers and git's marker, so there is no
    // content to review; it is reported like the untracked loop's binaries
    // rather than counted as reviewed.
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
    /**
     * The policy itself — the repository layer included — so the reader loop
     * answers under exactly the rules this change set was filtered by.
     */
    policy: ignore,
  }
}

// The reader tools answer under the same ignore rules as the diff: a path the
// review excluded cannot be listed, searched or read back in. `DEFAULT_IGNORE`
// holds the built-in directories that used to be listed here.
const READER_TOOLS = [
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
  },
  {
    name: 'search',
    description: 'Case-sensitive literal search for one string across workspace text files. Returns "path:line: text" rows; use it to find a definition, a caller or a usage.',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Literal text to find, without surrounding quotes.' },
        maxResults: { type: 'integer', description: 'Maximum matching lines. Defaults to, and is capped by, the configured maxSearchResults (40 unless configured).' },
      },
      required: ['query'],
      additionalProperties: false,
    },
  },
]

function relativePath(root, target) {
  const rel = relative(root, target)
  return (rel === '' ? '.' : rel).replace(/\\/g, '/')
}

/**
 * Resolve a caller-supplied path inside the workspace, or undefined when it
 * escapes. The check is both lexical and physical: `fs` follows symlinks, so a
 * link inside the workspace that points outside it would otherwise widen the
 * boundary the reviewer is promised.
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

function looksBinary(text) {
  return text.includes('\u0000')
}

function readFileTool(args, root, budget, ignore) {
  const target = resolveInside(root, args.path)
  if (target === undefined) return { text: `refused: "${args.path}" is outside the workspace`, isError: true }
  const where = relativePath(root, target)
  const rule = ignore.ruleFor(where)
  if (rule !== undefined) {
    return { text: `refused: ${where} is excluded by the review's ignore rules (${rule.label})`, isError: true }
  }
  let stat
  try {
    stat = statSync(target)
  } catch (error) {
    return { text: `cannot read ${args.path}: ${error?.code ?? String(error)}`, isError: true }
  }
  if (stat.isDirectory()) return { text: `${args.path} is a directory — use list_dir`, isError: true }
  if (!stat.isFile()) return { text: `${args.path} is not a regular file`, isError: true }
  if (stat.size > 1_000_000) return { text: `${args.path} is ${stat.size} bytes; too large to read`, isError: true }
  if (budget.bytes >= budget.maxBytes) {
    return { text: `reader budget spent (${budget.bytes}/${budget.maxBytes} bytes); answer with what you have`, isError: true }
  }
  let content
  try {
    content = readFileSync(target, 'utf8')
  } catch (error) {
    return { text: `cannot read ${args.path}: ${String(error)}`, isError: true }
  }
  if (looksBinary(content)) return { text: `${args.path} looks binary; not read`, isError: true }

  const offset = positiveInt(args.offset, 1)
  const limit = Math.min(positiveInt(args.limit, 400), 800)
  const lines = content.split('\n')
  const slice = lines.slice(offset - 1, offset - 1 + limit)
  const room = budget.maxBytes - budget.bytes
  const shown = slice.join('\n').slice(0, room)
  budget.bytes += shown.length
  return {
    text: `[${where} — lines ${offset}-${offset + slice.length - 1} of ${lines.length}]\n${shown}`,
    file: where,
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

function searchTool(args, root, budget, signal, maxSearchResults, ignore) {
  const query = typeof args.query === 'string' ? args.query : ''
  if (query === '') return { text: 'search needs a non-empty query', isError: true }
  const ceiling = positiveInt(maxSearchResults, DEFAULTS.maxSearchResults)
  const maxResults = Math.min(positiveInt(args.maxResults, ceiling), ceiling)
  const room = Math.max(0, budget.maxBytes - budget.bytes)
  const found = []
  const extraLines = []
  const files = new Set()
  const stack = [root]
  let scanned = 0
  let chars = 0

  while (stack.length > 0 && found.length < maxResults && scanned < 3000 && chars < room) {
    const dir = stack.pop()
    let entries
    try {
      entries = readdirSync(dir, { withFileTypes: true })
    } catch {
      continue
    }
    for (const entry of entries) {
      if (found.length >= maxResults || scanned >= 3000 || chars >= room) break
      const full = join(dir, entry.name)
      // An ignored path is invisible to a search as well: a dependency tree must
      // not be able to fill the reviewer's context or its evidence corpus.
      if (ignore.ruleFor(relativePath(root, full)) !== undefined) continue
      if (entry.isDirectory()) {
        if (!entry.name.startsWith('.')) stack.push(full)
        continue
      }
      if (!entry.isFile()) continue
      scanned += 1
      let stat
      try {
        stat = statSync(full)
      } catch {
        continue
      }
      if (stat.size > 400_000) continue
      let content
      try {
        content = readFileSync(full, 'utf8')
      } catch {
        continue
      }
      if (looksBinary(content) || !content.includes(query)) continue
      const lines = content.split('\n')
      for (let index = 0; index < lines.length && found.length < maxResults && chars < room; index += 1) {
        if (!lines[index].includes(query)) continue
        const trimmed = lines[index].trim()
        const row = `${relativePath(root, full)}:${index + 1}: ${trimmed.slice(0, 240)}`
        found.push(row)
        extraLines.push(trimmed)
        files.add(relativePath(root, full))
        chars += row.length + 1
      }
    }
    signal?.throwIfAborted?.()
  }

  budget.bytes += chars
  if (found.length === 0) {
    return { text: `no match for ${JSON.stringify(query)} in ${scanned} file(s) scanned`, extraLines: [] }
  }
  return {
    text: `[${found.length} match(es) for ${JSON.stringify(query)} in ${scanned} file(s)]\n${found.join('\n')}`,
    extraLines,
    files: [...files],
  }
}

function runReaderTool(call, root, budget, signal, settings, ignore) {
  let args
  try {
    args = call.arguments.trim() === '' ? {} : JSON.parse(call.arguments)
  } catch (error) {
    return { text: `cannot parse arguments for ${call.name}: ${String(error)}`, isError: true }
  }
  if (args === null || typeof args !== 'object' || Array.isArray(args)) {
    return { text: `arguments for ${call.name} must be a JSON object`, isError: true }
  }
  if (call.name === 'read_file') return readFileTool(args, root, budget, ignore)
  if (call.name === 'list_dir') return listDirTool(args, root, budget, signal, ignore)
  if (call.name === 'search') return searchTool(args, root, budget, signal, settings.maxSearchResults, ignore)
  return { text: `unknown tool "${call.name}"; read_file, list_dir and search are the only tools available`, isError: true }
}

/**
 * One model call. `system` is the mode's persona plus the contract it cannot
 * change, built once per run by `systemPromptFor`.
 */
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
  const detail = args?.path ?? args?.query ?? ''
  return detail === '' ? call.name : `${call.name} ${clamp(String(detail), 60)}`
}

/**
 * Runs the reader loop and returns the answer plus the corpus the reviewer was shown.
 *
 * `policy` is the ignore policy the change set was collected under, passed in
 * whole rather than rebuilt here: a second policy assembled from the settings
 * alone would quietly drop the repository layer, and the files this very run
 * reported as excluded would be readable, searchable and citable again.
 *
 * `system` is the mode's persona plus its contract, and it is passed on every
 * call of the loop: the two of them belong to the run, not to one message.
 */
async function reviewWithReader({ ctx, route, settings, policy, prompt, system, root, signal, deadlineAt, log }) {
  const messages = [{ role: 'user', content: [{ type: 'text', text: prompt }] }]
  const served = []
  const files = new Set()
  const budget = { bytes: 0, maxBytes: settings.maxReadBytes, calls: 0 }
  const results = []
  const ignore = policy
  let limits = settings
  let readerAvailable = settings.projectAccess === true
  let fellBack = false
  let text = ''

  /** Drops the oldest results from the model's context only; the served corpus keeps everything. */
  function elideOldResults() {
    let total = results.reduce((sum, entry) => sum + entry.bytes, 0)
    const elidable = Math.max(0, results.length - KEEP_RECENT_RESULTS)
    for (let index = 0; index < elidable && total > ELIDE_AFTER_BYTES; index += 1) {
      const entry = results[index]
      if (entry.elided) continue
      const note = `[elided: ${entry.label} — ${entry.bytes} bytes read earlier and dropped from this context; read it again if you still need it]`
      entry.message.content = [{ type: 'text', text: note }]
      total -= entry.bytes - note.length
      entry.bytes = note.length
      entry.elided = true
    }
    return total
  }

  for (let step = 0; ; step += 1) {
    const timeUp = Date.now() >= deadlineAt
    const canRead = readerAvailable && budget.calls < settings.maxToolCalls && !timeUp
    if (!canRead && budget.calls > 0 && step > 0) {
      const why = timeUp ? 'reading time is up' : 'reader budget spent'
      messages.push({
        role: 'user',
        content: [{
          type: 'text',
          text: `[${why} after ${budget.calls} call(s) — answer now with the final JSON object and no further tool calls]`,
        }],
      })
    }

    let answer
    try {
      answer = await callModel(ctx, route, limits, messages, canRead ? READER_TOOLS : undefined, signal, system)
    } catch (error) {
      // One degraded retry, so a rejected tool set or output cap still yields a report.
      if (budget.calls === 0 && !fellBack) {
        fellBack = true
        readerAvailable = false
        limits = { ...settings, maxTokens: Math.min(settings.maxTokens, FALLBACK_MAX_TOKENS) }
        log.warn(`reviewer call failed (${String(error)}); retrying without project access and maxTokens=${limits.maxTokens}`)
        answer = await callModel(ctx, route, limits, messages, undefined, signal, system)
      } else {
        throw error
      }
    }

    text = answer.text
    if (answer.calls.length === 0 || !canRead) {
      return {
        text,
        served,
        files: [...files],
        budget,
        fellBack,
        contextBytes: results.reduce((sum, entry) => sum + entry.bytes, 0),
      }
    }

    messages.push({
      id: randomUUID(),
      role: 'assistant',
      content: answer.calls.map(call => ({ type: 'tool-call', id: call.id, name: call.name, arguments: call.arguments })),
      source: { kind: 'model', provider: route.provider, model: route.model },
    })
    for (const call of answer.calls) {
      // The budget is rechecked per call: one model turn may ask for several,
      // and every one of them still needs a result so the pairing stays valid.
      const spent = budget.calls >= settings.maxToolCalls
        ? `the reader budget is spent (${budget.calls}/${settings.maxToolCalls} calls)`
        : budget.bytes >= budget.maxBytes
          ? `the reader byte budget is spent (${budget.bytes}/${budget.maxBytes} bytes)`
          : Date.now() >= deadlineAt ? 'reading time is up' : undefined
      if (spent !== undefined) {
        const refusal = `refused: ${spent} — answer now with the final JSON object and no further tool calls`
        served.push(refusal)
        messages.push({
          id: randomUUID(),
          role: 'tool',
          toolCallId: call.id,
          isError: true,
          content: [{ type: 'text', text: refusal }],
          source: { kind: 'tool', callId: call.id },
        })
        log.info(`reader ${budget.calls}/${settings.maxToolCalls}: ${summarizeCall(call)} → refused (${spent})`)
        continue
      }

      budget.calls += 1
      const result = runReaderTool(call, root, budget, signal, settings, ignore)
      if (typeof result.file === 'string') files.add(result.file)
      // Only served content makes a file visible; a directory listing shows names, not contents.
      for (const file of result.files ?? []) files.add(file)
      served.push(result.text, ...(result.extraLines ?? []))
      log.info(`reader ${budget.calls}/${settings.maxToolCalls}: ${summarizeCall(call)} → ${result.isError === true ? 'refused' : 'ok'}`)

      const footer = `\n[reader budget: ${budget.calls}/${settings.maxToolCalls} calls, ${Math.round(budget.bytes / 1024)}/${Math.round(budget.maxBytes / 1024)} KB]`
      const message = {
        id: randomUUID(),
        role: 'tool',
        toolCallId: call.id,
        ...(result.isError === true ? { isError: true } : {}),
        content: [{ type: 'text', text: `${result.text}${footer}` }],
        source: { kind: 'tool', callId: call.id },
      }
      messages.push(message)
      results.push({ message, label: summarizeCall(call), bytes: result.text.length + footer.length, elided: false })
      elideOldResults()
    }
  }
}

function renderPrompt({ diffs, stats, focus, language, cwd, mode, primary = [], others = [] }) {
  const skipped = stats.skipped.length === 0
    ? ''
    : `\n- left out of this review: ${stats.skipped.map(item => `${item.file} (${item.reason})`).join(', ')}`
  const rules = stats.ignore === undefined ? '' : ignoreRuleLine(stats.ignore)
  // The reviewer is told what the rules took out: a change set that looks small
  // must not read as a change set that was small.
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
  // The mode's own assignment for this run: what this role is here to judge. It
  // is the mode's, so it can narrow the job — never the change set, which the
  // collection already fixed.
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
  const requiredText = required.length === 0 ? 'the fields the JSON object asks for' : required.join(', ')
  return `## Change set under review
- mode: ${mode.label} (${mode.id})
- change source: ${stats.sourceLabel}
- workspace: ${cwd}
- changed files: ${stats.files} (+${stats.added} / -${stats.deleted} lines), reviewed here: ${stats.reviewed}${skipped}${ignored}${ruleLine}${scope}

## Unified diffs
${diffs}
${focusBlock}${taskBlock}

## Language
Write every text field of the JSON object in ${target}. Keep identifiers, paths and code verbatim; "evidence" is always copied from the diff, never translated or reformatted.

## Before you answer
Delete every finding that lacks a verbatim evidence quote from the diffs above, that leaves one of ${requiredText} unanswered, that depends on code you cannot see, or that is a matter of taste. Your summary must mention only what survives. Reporting nothing is a valid outcome; reporting an unproven claim is not.

Review the change set now and reply with the JSON object only.`
}

function extractJsonObject(text) {
  const start = text.indexOf('{')
  if (start < 0) return undefined
  let depth = 0
  let inString = false
  let escaped = false
  for (let i = start; i < text.length; i += 1) {
    const ch = text[i]
    if (inString) {
      if (escaped) escaped = false
      else if (ch === '\\') escaped = true
      else if (ch === '"') inString = false
      continue
    }
    if (ch === '"') inString = true
    else if (ch === '{') depth += 1
    else if (ch === '}') {
      depth -= 1
      if (depth === 0) return text.slice(start, i + 1)
    }
  }
  return undefined
}

/**
 * One finding as the mode reads it: the structure the gate checks, and one
 * string per field the mode declared. Keys the mode did not declare are dropped
 * — the JSON contract it was given names its fields, and nothing else.
 *
 * A severity the mode does not declare is lowered to the weakest one the mode
 * has rather than guessed upward, and the substitution is logged: an inflated
 * severity would survive the gate and mislead the reader.
 */
function normalizeFinding(value, mode, log) {
  if (value === null || typeof value !== 'object') return undefined
  const text = key => (typeof value[key] === 'string' ? value[key].trim() : '')
  const declared = text('severity')
  let severity = mode.severities.find(entry => entry.id === declared)
  if (severity === undefined) {
    severity = weakestSeverity(mode)
    if (declared !== '') log.warn(`the reviewer used the severity "${declared}", which mode "${mode.id}" does not declare; treated as "${severity.id}"`)
  }
  const finding = {
    severity: severity.id,
    category: text('category') === '' ? 'general' : text('category'),
    file: text('file'),
    line: Number.isInteger(value.line) ? value.line : null,
    title: text('title'),
  }
  for (const field of mode.fields) finding[field.key] = text(field.key)
  if (finding.title === '') {
    // A finding that names no title is still a finding: the first words it did
    // write become one, so the report never shows an anonymous entry.
    const stated = mode.fields.map(field => finding[field.key]).find(entry => entry !== '')
    finding.title = stated === undefined ? '' : stated.split('\n')[0].slice(0, 120)
  }
  return finding.title === '' ? undefined : finding
}

function parseVerdict(raw, mode, log) {
  const json = extractJsonObject(raw)
  if (json === undefined) return { failure: 'the reviewer returned no JSON object' }
  let parsed
  try {
    parsed = JSON.parse(json)
  } catch (error) {
    return { failure: `the reviewer's JSON did not parse: ${String(error)}` }
  }
  return {
    declared: parsed.verdict === 'fail' || parsed.verdict === 'warn' ? parsed.verdict : 'pass',
    summary: typeof parsed.summary === 'string' ? parsed.summary.trim() : '',
    findings: Array.isArray(parsed.findings)
      ? parsed.findings.map(finding => normalizeFinding(finding, mode, log)).filter(Boolean)
      : [],
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

/**
 * The severity a mode falls back to when the reviewer names one the mode does
 * not declare: the entry that claims least, so the substitution can never
 * inflate the verdict. The order the file lists the table in decides nothing —
 * a mode is free to write its severities strongest-last — and among entries that
 * claim the same, the last one is the answer, which is the weakest end of a
 * table written the usual way round.
 */
function weakestSeverity(mode) {
  let weakest = mode.severities[mode.severities.length - 1]
  for (const entry of mode.severities) {
    if (VERDICT_WEIGHT[entry.verdict] <= VERDICT_WEIGHT[weakest.verdict]) weakest = entry
  }
  return weakest
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

/**
 * Keeps only findings that name a visible file, quote their proof, and answer
 * every field their mode made required.
 *
 * The first two checks are the plugin's own and no mode can relax them. The
 * third is the mode's: `cr` requires the impact and the route that reaches the
 * defect, `arc` requires the consequence and the alternative it proposes, and a
 * mode the user wrote requires whatever it declared. Anything that fails is
 * withheld and named, never dropped in silence.
 */
function verifyFindings(findings, servedText, visiblePaths, mode) {
  const forms = diffQuoteForms(servedText)
  const paths = new Set(visiblePaths.map(canonicalPath))
  const kept = []
  const withheld = []

  for (const finding of findings) {
    const claim = {
      file: finding.file,
      line: finding.line,
      severity: finding.severity,
      title: finding.title,
    }
    if (finding.file === '' || !paths.has(canonicalPath(finding.file))) {
      withheld.push({ ...claim, reason: 'the named file is not one the reviewer could see' })
      continue
    }
    const quoted = finding.evidence.split('\n').map(line => line.trim()).filter(line => line !== '')
    if (quoted.length === 0) {
      withheld.push({ ...claim, reason: 'no evidence quoted' })
      continue
    }
    const missing = quoted.find(line => !forms.has(line))
    if (missing !== undefined) {
      withheld.push({ ...claim, reason: `quoted evidence does not occur in the diff or the reads: ${clamp(missing, 120)}` })
      continue
    }
    const unanswered = mode.fields.find(field => field.required && finding[field.key] === '')
    if (unanswered !== undefined) {
      withheld.push({ ...claim, reason: `missing required field "${unanswered.key}" (${unanswered.label === '' ? unanswered.key : unanswered.label}) — a finding that cannot state it is not published` })
      continue
    }
    kept.push(finding)
  }

  return { kept, withheld }
}

/** The verdict the surviving findings force, through the severity table of their mode. */
function verdictFromFindings(findings, mode) {
  let verdict = 'pass'
  for (const finding of findings) {
    const weight = mode.severities.find(entry => entry.id === finding.severity)?.verdict ?? 'warn'
    if (weight === 'fail') return 'fail'
    if (weight === 'warn') verdict = 'warn'
  }
  return verdict
}

function renderReport({ verdict, summary, findings, withheld, stats, route, mode }) {
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
    ...(stats.context === undefined || stats.context.calls === 0
      ? []
      : [`- project context read: ${stats.context.calls} tool call(s), ${stats.context.files.length} file(s)`]),
    `- reviewer: ${route.provider}/${route.model}` +
      (stats.reviewerFallback === true ? ' · degraded retry (no project access, smaller output cap)' : ''),
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

function noticeSummary({ verdict, findings, withheld, stats, mode }) {
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
  const summary = parts.join(' · ')
  return summary.length <= NOTICE_SUMMARY_MAX_CHARS
    ? summary
    : `${summary.slice(0, NOTICE_SUMMARY_MAX_CHARS - 1)}…`
}

/** The report as the Agent reads it: no payload, and plainly a notice rather than a request. */
function renderAgentNotice({ verdict, summary, findings, withheld, stats, route, mode }) {
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
    `reviewer: ${route.provider}/${route.model}`,
    ...(stats.recordBehind > 0
      ? [`note: this reviews turn ${stats.turn}; ${stats.recordBehind} newer recorded turn(s) have no comparison in this Host process`]
      : []),
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
    input: { hint: '[full|session] [mode=<id>] [provider=<id>] [model=<id>] [ignored=<pattern,…>] [focus message]' },
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
      const system = systemPromptFor(mode)

      const route = { provider: reviewerProvider, model: reviewerModel }
      const readerOn = settings.projectAccess === true
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
        (readerOn ? ` with read-only project access (up to ${maxToolCalls} reads)` : '') +
        (focus === '' ? '' : ` · focus: ${clamp(focus, 80)}`),
      )
      if ((stats.ignore?.count ?? 0) > 0) {
        log.info(`${stats.ignore.count} changed file(s) excluded by the ignore rules — ${ignoreSampleText(stats.ignore)}`)
      }
      const combined = AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)])

      let review
      try {
        review = await reviewWithReader({
          ctx,
          route,
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
          system,
          root: collected.summary.cwd,
          signal: combined,
          deadlineAt,
          log,
        })
      } catch (error) {
        if (signal.aborted) return { kind: 'error', text: 'code-review: review cancelled.' }
        log.warn(`reviewer call failed: ${String(error)}`)
        return { kind: 'error', text: `code-review: the reviewer call failed — ${String(error)}` }
      }

      const raw = review.text
      stats.context = {
        calls: review.budget.calls,
        files: review.files,
        bytes: review.budget.bytes,
        keptBytes: review.contextBytes,
      }
      stats.reviewerFallback = review.fellBack === true
      const parsed = parseVerdict(raw, mode, log)
      if (parsed.failure !== undefined) {
        log.warn(`unusable reviewer output: ${parsed.failure}`)
        return { kind: 'error', text: `code-review: ${parsed.failure}. Raw output:\n\n${clamp(raw, 4000)}` }
      }

      const haystack = [collected.diffs, ...review.served].join('\n')
      const { kept, withheld } = verifyFindings(
        parsed.findings,
        haystack,
        [...collected.paths, ...review.files],
        mode,
      )
      const verdict = verdictFromFindings(kept, mode)
      const noticeMode = NOTIFY_MODES.has(settings.notifyAgent) ? settings.notifyAgent : DEFAULTS.notifyAgent
      const reportInput = {
        verdict,
        summary: parsed.summary,
        findings: kept,
        withheld,
        stats,
        route,
        mode,
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
        summary: parsed.summary,
        findings: kept,
        withheld,
        stats,
        reviewer: route,
        turn: stats.turn,
        cwd: stats.cwd,
        time: Date.now(),
      }

      log.info(
        `review done: ${mode.id} ${verdict} (reviewer declared ${parsed.declared}), ` +
        `${kept.length} proven finding(s), ${withheld.length} withheld`,
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
