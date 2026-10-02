# code-review — reference

Everything the plugin does beyond [the README](../README.md): the modes, the
settings file, the ignore rules, how a run works, what a finding is, the card, the
limits and the package contract.

- [Modes](#modes)
- [Configuration](#configuration)
- [Ignored paths](#ignored-paths)
- [How a run works](#how-a-run-works)
- [Findings](#findings)
- [The card](#the-card)
- [Limits](#limits)
- [Package layout](#package-layout)

## Modes

A mode decides five things: the **prompt** it runs under, the **assignment** for
this run, the **fields** one finding states, the **severities** (and with them the
verdict), and a **preset** of the run settings. What no mode decides is the
evidence gate: every finding quotes the line that proves it, the quote is checked
mechanically against the diff and everything the reader tools returned, and a
finding that cannot state what its mode requires is withheld and named. What no
mode decides either is the tool set: a mode chooses the vocabulary its findings
are recorded in — its severity ids, its fields, its categories — while the six
review tools themselves are offered on every run, whatever the mode says.

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
| `fields` | The narrative fields of one finding, in the order the report and the card show them: `key` (required), `label` (empty renders the text bare), `required`, `block` (render as quoted code), `guide` (what the field must contain, quoted in the contract and used as the tool parameter's description). `severity`, `category`, `file`, `line`, `title`, `summary` and `id` are the finding's structure and cannot be field keys. |
| `severities` | The vocabulary the reviewer may use and the verdict each forces: `id`, `label`, `tone` (`error`, `warn`, `success`, `muted`), `verdict` (`fail`, `warn`, `pass`) and `meaning` (quoted in the contract, so an arbitrary vocabulary still defines itself). The verdict of a run is the strongest one its surviving findings force. |
| `verdicts` | What the mode calls `pass`, `warn` and `fail` — `sound`, `worth discussing`, `decide before merge`. The chip keeps the machine verdict's colour. |
| `settings` | A preset of the run settings below: the mode's values win over the file's own and lose to what you type after `/review`. `"settings": { "reasoningEffort": "max" }` is how one mode thinks harder than the rest without changing the global setting. An empty value presets nothing: the layer below stays in force. |

Two rules are not negotiable. **`evidence` is required in every mode**: leave it
out of `fields` and it is appended, set `required: false` and it is put back.
And a mode that declares no `fields` gets the minimum every mode states —
`problem` and `evidence` — never `cr`'s longer list.

A severity is used exactly as the mode declares it. A severity the reviewer names
that the mode does not declare is refused by name — the refusal lists the ids the
mode does carry — and the call changes nothing, so the reviewer fixes it and calls
again. Nothing is lowered, substituted or guessed: a run's verdict is the
strongest one its surviving findings force through the mode's own table.

Nothing is reported in silence either: a field key that is reserved, a duplicate,
a severity with an unknown `verdict` or `tone`, a setting a mode may not set —
each is warned about in `harness.log` and the usable part runs.

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
| `projectAccess` | Give the reviewer the read-only tools above: `read_file` and `search` run through the harness's own `read` and `grep`, `list_dir` is the plugin's. The harness attributes those reads to the agent — they can inform its instruction-file selection — though nothing about the review reaches it. The six review tools are always offered: this key never removes one. |
| `maxToolCalls`, `maxReadBytes`, `maxSearchResults`, `toolDeadlineRatio` | Reader budgets. They bound the read-only tools only — never `append_finding` or the other review tools. |
| `maxFiles`, `maxDiffChars` | Reviewed files and total diff size; the rest are listed as left out. |
| `maxHintChars` | Cap on the focus message you type. |
| `ignored` | Extra ignore patterns (an array, or one string with commas or newlines between them), on top of the built-in standard list. Prefix a pattern with `!` to put a path back. |
| `ignoreDefaults` | `true` (default): the built-in standard list applies. `false` reviews dependency trees and build output like anything else. |
| `respectGitIgnore` | `true` (default): the repository's own ignore rules are honored too, tracked files included. `false` reviews them. |
| `maxTokens`, `temperature`, `timeoutMs` | Output cap, sampling and the budget for the whole run. A first call that fails is retried once with project access dropped and the output cap lowered to 8192 or to the configured value when that is smaller — the review tools stay, because without them there is no review to record. The report says the run was degraded. |
| `reasoningEffort` | The thinking level handed to the reviewer, as the adapter names it — `off`, `low`, `high`, `max` on DeepSeek. Empty (the default) sends no level, so the provider's own default decides. A mode can preset it (`modes.cr.settings.reasoningEffort`) and `reasoningEffort=` on the command line beats them both. A level the selected model does not offer is refused before any model call, and the offered levels are listed. |

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

## How a run works

1. the mode is resolved — from `mode=`, else the file's `mode`, else `cr` — and
   its settings are merged under what you typed;
2. changes are collected — git first, otherwise the session's own recorded
   changes — and everything the ignore rules cover is dropped before a diff is
   built;
3. unified diffs are built, within `maxFiles` and `maxDiffChars`;
4. the reviewer runs under the mode's prompt plus the contract no mode can
   change, and may read the workspace with read-only tools when the diff alone
   cannot settle a question;
5. it records the review with its own tools: one `append_finding` per finding as
   soon as it is settled, `update_finding` or `delete_finding` when something
   later invalidates what it wrote, `set_summary` for the report's opening, and
   `finish_review` to end the run;
6. every recorded finding must pass the evidence gate, and state the fields its
   mode made required, or it is **withheld** — recorded, listed with its reason,
   and never carrying the verdict. The gate runs when the finding is recorded and
   again when the report is built;
7. the report is assembled from the store and becomes the card. It stops there
   unless you say otherwise.

**Sources.** `git` compares the working tree against `gitRev`; `session` reads the
newest `workspace/changes` record the Host still serves for this session; `auto`
(default) tries git and falls back to the record. The record lives in the Host
process only, so after a restart only git can still see the work.

**Review tools.** `append_finding`, `update_finding`, `delete_finding`,
`list_findings`, `set_summary` and `finish_review`, offered on every call of
every run. `append_finding` and `update_finding` take exactly the finding shape
the mode in force declares — its severity ids as an enum, its fields with their
guides as descriptions — because that shape is what the report reads. The set of
names is fixed: no setting adds, removes or renames one, and a mode's `settings`
block is a preset of run settings that cannot touch them either. A call the store
cannot use changes nothing and answers with everything that was wrong with it, so
the reviewer can fix it and call again.

**Partial runs.** A run that stops before `finish_review` — a broken stream, a
provider failure, a timeout, a cancel, a model that will not finish — hands over
every finding already recorded, marked **incomplete** with the reason, in the
card, the report and the agent notice. Nothing that was recorded is lost and
nothing is kept anywhere else. A run that recorded no finding at all is not a
report: it fails with the reason instead of showing an empty pass.

**Evidence gate.** The reviewer must quote the line that proves each finding; a
quote that does not occur in the diff or in what the reader tools returned is
withheld, and the finding with it. The fields a finding must state come from the
mode: `cr` asks for the impact and the route that reaches the defect, `arc` for
the consequence and the alternative it proposes, a mode you wrote for whatever it
declared. Anything that fails is **withheld**, never silently dropped: the count
is shown and each claim is listed with its reason. The verdict is recomputed from
the findings that survive, through the mode's own severity table.

**Reader tools.** `read_file`, `list_dir` and `search`. `read_file` and `search`
read the workspace through the harness's own `read` and `grep` tools — the same
implementations the agent uses, so the sandbox, the path resolution and the
encodings are the harness's — with the plugin wrapping every call: the run's
ignore rules are enforced before the call and again on what comes back, the
budgets are the plugin's, and only what a tool returned becomes evidence.
`list_dir` is the plugin's own, because the harness has no directory listing. No
command, no shell, no write and no network are involved in any of them.

Those reads run on the agent's behalf, so the harness counts them as the agent
touching those files (which can inform its instruction-file selection), but
nothing about the review itself reaches the agent: no session record, no tool
card and no message.

Reading is bounded by `maxToolCalls`, `maxReadBytes`, `maxSearchResults` and
`toolDeadlineRatio`; when a bound is reached the reader tools are withdrawn, the
reviewer is told, and the review tools stay — a review always has somewhere to
go. The contract the run opens with is written from the same answer as that tool
list — it names exactly the tools the run offers — so a run given two of them is
never told it has three.

One consequence of reusing the harness's search: it keeps ripgrep's traversal
defaults, so hidden files and the repository's ignored files are not searched
whatever the run's own ignore settings say. With `ignoreDefaults` or
`respectGitIgnore` turned off, `search` is therefore narrower than the change
set under review; `read_file` still reaches any path inside the workspace.

Set `projectAccess: false` for a diff-only review. A deployment that does not
expose one of the harness tools keeps what it can still run: `read_file` is
offered only where `read` exists, `search` only where `grep` does, `list_dir` is
offered either way because it is the plugin's own, and the log names each tool
the run lost. A tool the harness has withdrawn is refused by name: `this harness
exposes no "grep" tool`.

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
that matched — neither is ever silently dropped. A call the store cannot use is
refused with the reason and changes nothing; a finding the gate cannot publish is
recorded as **withheld** and named with its reason; a run that recorded nothing
before it stopped fails loudly instead of reporting a fake pass. Every run's store
activity is in the report — how many calls it took, how many findings were
recorded, updated and deleted.

## The card

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

### Where the card lands

The card is drawn in two places, never twice at once:

- **The conversation.** The `/review` row of the transcript, where every resolved
  command gets its line — the report you read back later, and the one a modified
  session still carries.
- **Above the composer.** On a session that has not started its first turn, the
  harness draws no transcript at all (a blank session shows its hero), so the card
  stands in there instead: the running face while the reviewer works, then the
  report. It yields to the transcript the moment the conversation starts.

That second seat is not a preference, it is what the blank state leaves. A command
lifecycle never opens a turn — as far as the shell is concerned the session has not
started, and its transcript rows are not rendered at all. The dock card therefore
reads the newest `/review` of that session, error or report alike: a failed review
is an answer, and it is the one that has to be visible. It is capped in height (the
composer seat's own cap) and scrolls inside itself, so a long report never pushes
the composer out of reach.

## Limits

- One run is bounded by the reader budgets, by `timeoutMs`, and by the plugin's
  own limits — 100 findings in the store, 300 finding-tool calls, 150 model turns
  and two nudges to finish. None of them is a setting: they are the bounds that
  keep a review recordable and a run finite.
- A bound never loses what was recorded; it changes what the reviewer can still
  do, and the report names the one it was. The reader tools are withdrawn when
  the reading budget is spent, and the review tools stay. Past 300 finding-tool
  calls the store takes no more changes — the reviewer can still list what it has,
  record its summary and close the review — and that review is marked incomplete
  with the cap named. A run that ran out of turns or stopped without finishing is
  marked incomplete for that reason, and a run that recorded nothing at all fails
  instead of showing an empty pass.
- The store lives in the Host process, so a restart loses the run in progress —
  what survives is every run that finished, in the card.
- The dock card is drawn only while the shell draws no transcript for that session:
  once the first turn starts, the report is read in the transcript instead. It stands
  for the newest `/review` of that session, so an older report is read back there.
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
