# dsh-code-review

On-demand code review for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness).
`/review` audits the uncommitted changes in the workspace with a reviewer model and
renders the report as a card in the conversation.

It reviews in one of its **modes**. A mode is a role: the prompt of the reviewer,
the assignment it is given, the fields one finding must state, the severity
vocabulary that decides the verdict, and a preset of run settings. Two ship with
the plugin — `cr`, a code review, and `arc`, an architecture review — and you add
your own under `modes` in the settings file.

**The report is yours alone.** By default the agent is not told about the review:
no turn starts, nothing is read into its context and no code changes. You read the
report, decide what matters and hand the agent an instruction in your own words.
`notifyAgent` can put the agent in the loop instead; `off` is the default.

## Install

A bundle for a DeepSeek Harness profile. Nothing is built and nothing is
installed with it: the package is plain JavaScript with no dependencies.

1. Install it into your profile. In a session, ask for the bundle installer —
   `plugin_manager`, `action: install_bundle`, `target: github:SeanTolstoyevski/dsh-code-review`.
   Installing from a clone does the same thing: pass the absolute path of the
   directory you cloned into instead of the GitHub spec.  
     Or use web ui > plugin manager > paste the url and install.
2. Restart `dsh web`. A bundle installed for the first time can activate through
   the loader, but a replaced package needs a fresh module generation before its
   JavaScript is loaded again. That first start also writes
   `DSH_HOME/code-review/config.json` for you, every setting and both built-in
   modes at their defaults, so there is a file to edit on a machine that never
   had one.
3. Reload the page in the browser. The client artifact is fetched once per page,
   so a reload is what brings the card up to date.
4. Type `/review` in the session you want reviewed, or `/review mode=arc`.

## Use

```
/review [full|session] [mode=<id>] [provider=<id>] [model=<id>] [reasoningEffort=<id>] [language=<code>] [gitRev=<rev>] [source=auto|git|session] [ignored=<pattern,…>] [focus message]
```

- `/review` or `/review full` — every uncommitted change in the **repository**
  against `gitRev` (default `HEAD`), untracked files included, reviewed in the
  `cr` mode. Files this session wrote or edited are marked *primary*, the rest as
  *not by this session*;
- `mode=<id>` — the mode this run uses, by id or by alias
  (`/review mode=arc`, `/review mode=architect`, `/review mode=spell`). A name
  that does not resolve is refused before any model call, and the error lists the
  modes that do;
- `/review session` — only the files this session wrote or edited;
- `reasoningEffort=<id>` — the thinking level the reviewer runs at, as the
  provider names it (`reasoningEffort=max`, `reasoningEffort=off`). It beats what
  the config file says, per mode or globally; a level the model does not offer is
  refused before any model call, with the levels it does offer named. Leave it out
  — in the command and in the file — and the request carries no level at all, so
  the provider's own default applies;
- `ignored=<pattern>[,…]` — ignore patterns for this run, on top of the built-in
  list and the config file; repeat the key to add more, and prefix a pattern with
  `!` to put a path back (`/review ignored=fixtures/,!dist/`);
- `ignoreDefaults=false` / `respectGitIgnore=false` — drop the built-in list for
  this run, or stop honoring the repository's own ignore rules;
- everything after the arguments is a **focus message**: the only text of yours
  the reviewer ever sees (`/review session board.go satır 13`).

The reviewer never reads the conversation. Your chat messages do not reach it.

## Modes

A mode decides five things: the **prompt** it runs under, the **assignment** for
this run, the **fields** one finding states, the **severities** (and with them the
verdict), and a **preset** of the run settings. What no mode decides is the
evidence gate: every finding quotes the line that proves it, the quote is checked
mechanically against the diff and everything the reader tools returned, and a
finding that cannot state what its mode requires is withheld and named.

The two built-in modes:

| Mode | Aliases | What it judges |
|---|---|---|
| `cr` | `code`, `codereview` | The changed lines: the change does not do what it claims, breaks a caller, loses data, races, leaks, swallows a failure. The default. |
| `arc` | `architect`, `architecture` | The shape of the change: placement, responsibility, boundaries and dependency direction, abstraction, interface shape, domain language, coupling, growth. It reads the project around the change to decide, and it does not hunt defects — a wrong result belongs to `cr`. |

`arc` presets a larger reader budget (`maxToolCalls: 60`), because a judgement
about a module or a layer needs the neighbours read.

### Your own modes

A mode is one entry under `modes` in the settings file. The block below is the
shape of an entry — every key is optional, and this example is a working mode:

```json
{
  "label": "Spelling review",
  "aliases": ["spell"],
  "enabled": true,
  "description": "Reports misspellings in user-visible strings only.",
  "systemPrompt": "You review the spelling, grammar and copy of user-visible strings, and nothing else.",
  "task": "Report only misspellings. Do not report anything else you notice, however serious.",
  "categories": ["spelling", "copy"],
  "fields": [
    { "key": "problem", "label": "", "required": true, "block": false, "guide": "the wrong word and what it should be" },
    { "key": "evidence", "label": "Evidence", "required": true, "block": true, "guide": "" }
  ],
  "severities": [
    { "id": "typo", "label": "typo", "tone": "muted", "verdict": "warn", "meaning": "a misspelled word in text a user reads" }
  ],
  "verdicts": { "pass": "clean", "warn": "typos", "fail": "readable but wrong" },
  "settings": { "language": "tr" }
}
```

| Key | Meaning |
|---|---|
| `label` | The name on the card and in the report. Defaults to the mode's id. |
| `aliases` | Other names `mode=` accepts. An id always wins over an alias. |
| `enabled` | `false` takes the mode off the command surface. That is how a built-in mode is turned off; deleting it only makes the sync put it back. |
| `description` | One line, shown when a mode name does not resolve. |
| `systemPrompt` | The reviewer's role, what it looks for, and what it never reports. It is followed by the contract below, which it cannot change. |
| `task` | Extra instructions for this run, added to the change set as `## Mode task`. Use it to narrow the assignment; it can never widen the change set. |
| `categories` | The categories the reviewer may use, listed in the contract and shown on the card. |
| `fields` | The narrative fields of one finding, in the order the report and the card show them: `key` (required), `label` (empty renders the text bare), `required`, `block` (render as quoted code), `guide` (what the field must contain, quoted in the contract). `severity`, `category`, `file`, `line` and `title` are the finding's structure and cannot be field keys. |
| `severities` | The vocabulary the reviewer may use and the verdict each forces: `id`, `label`, `tone` (`error`, `warn`, `success`, `muted`), `verdict` (`fail`, `warn`, `pass`) and `meaning` (quoted in the contract, so an arbitrary vocabulary still defines itself). The verdict of a run is the strongest one its surviving findings force. |
| `verdicts` | What the mode calls `pass`, `warn` and `fail` — `sound`, `worth discussing`, `decide before merge`. The chip keeps the machine verdict's colour. |
| `settings` | A preset of the run settings below: the mode's values win over the file's own and lose to what you type after `/review`. `"settings": { "reasoningEffort": "max" }` is how one mode thinks harder than the rest without changing the global setting. An empty value presets nothing: the layer below stays in force. |

Two rules are not negotiable. **`evidence` is required in every mode**: leave it
out of `fields` and it is appended, set `required: false` and it is put back.
And a mode that declares no `fields` gets the minimum every mode states —
`problem` and `evidence` — never `cr`'s longer list.

A severity table is read by weight, not by position: whichever order it is
written in, a severity the reviewer names but the mode does not declare is
lowered to the one that claims least, so a substitution can never inflate a
verdict — and a run's verdict is the strongest one its surviving findings force.

Nothing is reported in silence either: a field key that is reserved, a duplicate,
a severity with an unknown `verdict` or `tone`, a setting a mode may not set —
each is warned about in `harness.log` and the usable part runs.

## Ignored paths

A review is about the code someone wrote, so the paths nobody wants reviewed are
kept out of it — before a diff is built, before a file is read, and before the
`maxFiles` budget is spent on them.

- **The built-in standard list.** Dependency trees (`node_modules/`, `vendor/`,
  `bower_components/`, `Pods/`), build output (`dist/`, `build/`, `target/`,
  `out/`, `.next/`, `_build/`), caches and coverage (`.cache/`, `__pycache__/`,
  `coverage/`, `.pytest_cache/`, `.terraform/`), generated bundles (`*.min.js`,
  `*.js.map`, `*.tsbuildinfo`), editor and OS noise (`.idea/`, `.vscode/`,
  `.DS_Store`, `Thumbs.db`), logs and local state (`*.log`, `*.tmp`, `*.sqlite`,
  `*.db`) and the environment files nobody commits (`.env`, `.env.*` — with
  `.env.example` and friends put back). The list is `DEFAULT_IGNORE` in
  `index.js`, and `ignoreDefaults: false` turns it off;
- **`ignored` in `config.json` and `ignored=` on the command line**, adding
  patterns in gitignore syntax: `*` and `?` stop at a `/`, `**` crosses
  directories, a leading or middle `/` anchors the pattern at the root of the
  change set, a trailing `/` names a directory, `#` is a comment;
- **the repository's own ignore rules**, tracked files included: a
  `node_modules` that was committed once is still `node_modules`. Untracked
  ignored files never reach the plugin at all, because `git status` omits them.
  `respectGitIgnore: false` turns this layer off.

The last matching pattern wins, so a `!pattern` — in the config or typed after
`/review` — puts back anything an earlier rule took out:

```
/review ignored=!dist/             review dist/ after all
/review ignored=fixtures/,!dist/   keep fixtures/ out, review dist/
/review ignored=!*                 ignore nothing, review everything
/review ignoredDefaults=false      no built-in list for this run
```

Nothing is dropped in silence: the report says how many changed files the rules
excluded and names up to five of them with the rule behind each, the reviewer is
told the same, and a change set that is *entirely* ignored is reported as such
rather than as a clean tree. `session` scope counts only the session's own files —
when the rules removed one of them, the run says which file and which rule
excluded it instead of reporting that the session changed nothing. The reviewer's
read-only tools answer under the same rules, so an ignored file cannot be
searched, read back, quoted as evidence or named in a finding.

## On the card

| Control | What it does |
|---|---|
| **Copy report** | the whole Markdown report, ready to paste somewhere else |
| **Copy** (per finding) | that one finding, in the report's own wording |

The card is titled by the mode, chipped with the mode's word for the verdict, and
draws each finding from the field list that mode declared — a custom mode renders
like a built-in one, because the Host half sends the vocabulary with the report.
The card shows and copies; it has no control that sends anything: a review is a
decision aid, not a work order and the decision — with the instruction that
follows from it — is yours to give.

## How it works

1. the mode is resolved — from `mode=`, else the file's `mode`, else `cr` — and
   its settings are merged under what you typed;
2. changes are collected — git first, otherwise the session's own recorded
   changes — and everything the ignore rules cover is dropped before a diff is
   built;
3. unified diffs are built, within `maxFiles` and `maxDiffChars`;
4. the reviewer runs under the mode's prompt plus the contract no mode can
   change, and may read the workspace with read-only tools when the diff alone
   cannot settle a question;
5. every finding must pass the evidence gate, and state the fields its mode made
   required, or it is withheld;
6. the report becomes the card. It stops there unless you say otherwise.

**Sources.** `git` compares the working tree against `gitRev`; `session` reads the
newest `workspace/changes` record the Host still serves for this session; `auto`
(default) tries git and falls back to the record. The record lives in the Host
process only, so after a restart only git can still see the work.

**Evidence gate.** The reviewer must quote the line that proves each finding; a
quote that does not occur in the diff or in what the reader tools returned is
discarded and the finding with it. The fields a finding must state come from the
mode: `cr` asks for the impact and the route that reaches the defect, `arc` for
the consequence and the alternative it proposes, a mode you wrote for whatever it
declared. Anything that fails is **withheld**, never silently dropped: the count
is shown and each claim is listed with its reason. The verdict is recomputed from
the findings that survive, through the mode's own severity table.

**Reader tools.** `read_file`, `list_dir` and `search`, implemented inside this
plugin. No command, no shell, no write, no network. Paths are resolved to their
real target and must stay inside the workspace, so a symlink cannot be used to
read outside it, and the ignore rules of the run apply to them as well. Reading is
bounded by `maxToolCalls`, `maxReadBytes`, `maxSearchResults` and
`toolDeadlineRatio`; when a bound is reached the reviewer is told and must answer.
Set `projectAccess: false` for a diff-only review.

## Configuration

`DSH_HOME/code-review/config.json` — the harness home, which is `$DSH_HOME` when
that variable is set and not blank, and `~/.dsh` otherwise. It is never the
current working directory: `dsh web` is started from wherever you happen to be,
and a config read from there would quietly be no config at all. Every key is
optional and the file is re-read on every run — tuning needs neither a restart
nor a reload, and each run logs the file it read, the mode it resolved and the
values in force.

The file is created for you and then **completed, never rewritten**. The first
time the plugin loads in a harness home that has none — and any run that finds it
gone — it writes the settings below plus both built-in modes. Any load that finds
a key missing adds it: a setting this release introduced, a mode this release
ships, a key you deleted. A value you wrote is never replaced, a mode of your own
is never extended, and a file with nothing missing is not written to at all. A
file that does not parse is reported and left exactly as it is, and that run uses
the release defaults.

That gives one rule for going back: **delete a key to get the current release's
default for it back**, and use `"enabled": false` to take a built-in mode off the
command surface.

```json
{
  "mode": "cr",
  "provider": "",
  "model": "",
  "language": "",
  "source": "auto",
  "gitRev": "HEAD",
  "notifyAgent": "off",
  "projectAccess": true,
  "maxToolCalls": 30,
  "maxReadBytes": 524288,
  "toolDeadlineRatio": 0.8,
  "maxSearchResults": 40,
  "maxFiles": 25,
  "maxDiffChars": 150000,
  "maxHintChars": 600,
  "maxTokens": 50000,
  "temperature": 0.1,
  "reasoningEffort": "",
  "timeoutMs": 600000,
  "ignored": [],
  "ignoreDefaults": true,
  "respectGitIgnore": true
}
```

| Key | Meaning |
|---|---|
| `mode` | The mode a `/review` without `mode=` runs. |
| `provider`, `model` | Reviewer route. Both empty reuses the agent's own. |
| `language` | Report language. Empty mirrors the focus message; with no focus message the report is English. |
| `source`, `gitRev` | Where the change set comes from and what git compares against. |
| `notifyAgent` | `off` (default): only you see the report. `steer` hands it to the agent as a notice, which starts a turn; `inject` puts it in the agent's context without starting one. Set one of those only if you want the agent in the loop. |
| `projectAccess` | Give the reviewer the read-only tools above. |
| `maxToolCalls`, `maxReadBytes`, `maxSearchResults`, `toolDeadlineRatio` | Reader budgets. |
| `maxFiles`, `maxDiffChars` | Reviewed files and total diff size; the rest are listed as left out. |
| `maxHintChars` | Cap on the focus message you type. |
| `ignored` | Extra ignore patterns (an array, or one string with commas or newlines between them), on top of the built-in standard list. Prefix a pattern with `!` to put a path back. |
| `ignoreDefaults` | `true` (default): the built-in standard list applies. `false` reviews dependency trees and build output like anything else. |
| `respectGitIgnore` | `true` (default): the repository's own ignore rules are honored too, tracked files included. `false` reviews them. |
| `maxTokens`, `temperature`, `timeoutMs` | Output cap, sampling and the budget for the whole run. A first call that fails is retried once without project access and with the output cap lowered to 8192 or to the configured value when that is smaller; the report says the run was degraded. |
| `reasoningEffort` | The thinking level handed to the reviewer, as the adapter names it — `off`, `low`, `high`, `max` on DeepSeek. Empty (the default) sends no level, so the provider's own default decides; that is what every run did before this key existed. A mode can preset it (`modes.cr.settings.reasoningEffort`) and `reasoningEffort=` on the command line beats them both. A level the selected model does not offer is refused before any model call, and the offered levels are listed. |

`modes` is the one key the file holds that the table above does not list: an
object of mode entries, documented under [Modes](#modes), with the built-in modes
written into it so they are editable like any other.

**What wins.** What you type after `/review` beats the mode's `settings`, which
beat this file, which beats the release default. A mode is a preset: `arc`'s
`maxToolCalls: 60` applies even if you set a global `maxToolCalls`, and changing
it means editing `modes.arc.settings.maxToolCalls` — or deleting the mode's
`maxToolCalls` and setting the global one, since a mode without it inherits.
The same holds for `reasoningEffort`: `modes.cr.settings.reasoningEffort: "max"`
makes every code review think at `max` while `arc` keeps whatever the file says,
and `reasoningEffort=low` on one command overrides both.
An empty value is not a value: it presets nothing and never erases the layer
below it, so a mode that writes `reasoningEffort: ""` inherits the file's.

## Findings

The categories, the severities and the words the report uses come from the mode
that ran; `cr`'s are `correctness`, `concurrency`, `error-handling`, `security`,
`api-misuse`, `performance`, `tests`, `consistency`, and `blocker`, `major`,
`minor`, `nit`, where a blocker or a major makes the verdict `fail`. `arc` judges
`module-boundary`, `responsibility`, `layering`, `coupling`, `abstraction`,
`api-shape`, `data-flow`, `naming`, `duplication`, `testability`,
`extensibility`, `consistency` on a `high` / `medium` / `low` scale.

A file that is binary, oversized or over a budget is reported as **left out**, and
a file the ignore rules cover is reported as **excluded as ignored** with the rule
that matched — neither is ever silently dropped. Output that cannot be parsed
fails loudly with the raw text instead of reporting a fake pass.

## Limits

- The reviewer reads the workspace but cannot run anything, so build and test
  results stay outside its reach by construction.
- Files changed by a shell command cannot be attributed to the session; they show
  up under `full`.
- A finding may cite a file outside the change set when the proof lives there (a
  caller, a definition); the reachability rule in its prompt still ties it to the
  change set.
- Ignore patterns are matched against paths, and a pattern naming a directory
  takes everything under it with it; a *file* named exactly like such a pattern
  (`build/`) is therefore treated as the directory of that name.
- `respectGitIgnore` consults the repository's rules for the **git** source; the
  session-record source is filtered by the built-in list, the config file and what
  you typed.
- A mode's prompt is synced into the file once, and from then on the file decides.
  A prompt improved by a later release therefore reaches a mode you never edited
  only after you delete that mode's `systemPrompt` (or `task`, `fields`,
  `severities`, `verdicts`, `categories`) and let the next load put it back.
- The mode's own labels — its name, its severity names, its field labels — are
  content, not chrome: the card prints them exactly as the settings file spells
  them, translated neither by the locale dictionaries nor by the report language.
- A mode cannot turn the evidence gate off, and it cannot leave `evidence`
  optional; that is the one thing this plugin promises about every report it
  renders.

## Package layout

| File | Role |
|---|---|
| `index.js` | Host half: the `/review` command, the modes and the settings sync, change collection, the reviewer call, the gate. |
| `client.js` | Client half: the report card, drawn from the mode the payload describes. |
| `cordis.patch.yml` | Bundle patch: inserts the `code-review` plugin row. |
| `selftest.mjs` | `node selftest.mjs` drives both halves and asserts every path. |

The Host half appends a machine-readable payload to the report after
`<!-- code-review:payload -->` as one fenced JSON block (`schema: code-review/2`),
carrying the mode's vocabulary so the card needs to know no mode; the card parses
it and falls back to the raw report text when it cannot.

## License

MIT
