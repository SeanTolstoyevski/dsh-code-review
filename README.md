# dsh-code-review

On-demand code review for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness).
`/review` audits the uncommitted changes in the workspace with a reviewer model and
renders the report as a card in the conversation.

It does one thing: it reviews code changes. It does not review chat answers, does
not run commands and never edits the workspace on its own.

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
   JavaScript is loaded again.
3. Reload the page in the browser. The client artifact is fetched once per page,
   so a reload is what brings the card up to date.
4. Type `/review` in the session you want reviewed.

## Use

```
/review [full|session] [provider=<id>] [model=<id>] [language=<code>] [gitRev=<rev>] [source=auto|git|session] [ignored=<pattern,…>] [focus message]
```

- `/review` or `/review full` — every uncommitted change in the **repository**
  against `gitRev` (default `HEAD`), untracked files included. Files this session
  wrote or edited are marked *primary*, the rest as *not by this session*;
- `/review session` — only the files this session wrote or edited;
- `ignored=<pattern>[,…]` — ignore patterns for this run, on top of the built-in
  list and the config file; repeat the key to add more, and prefix a pattern with
  `!` to put a path back (`/review ignored=fixtures/,!dist/`);
- `ignoreDefaults=false` / `respectGitIgnore=false` — drop the built-in list for
  this run, or stop honoring the repository's own ignore rules;
- everything after the arguments is a **focus message**: the only text of yours
  the reviewer ever sees (`/review session board.go satır 13`).

The reviewer never reads the conversation. Your chat messages do not reach it.

### Ignored paths

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

### On the card

| Control | What it does |
|---|---|
| **Copy report** | the whole Markdown report, ready to paste somewhere else |
| **Copy** (per finding) | that one finding, in the report's own wording |

The card shows the report and copies it. It has no control that sends anything:
a review is a decision aid, not a work order and the decision — with the
instruction that follows from it — is yours to give.

## How it works

1. changes are collected — git first, otherwise the session's own recorded
   changes — and everything the ignore rules cover is dropped before a diff is
   built;
2. unified diffs are built, within `maxFiles` and `maxDiffChars`;
3. the reviewer may read the workspace with read-only tools when the diff alone
   cannot settle a question;
4. every finding must pass the evidence gate or it is withheld;
5. the report becomes the card. It stops there unless you say otherwise.

**Sources.** `git` compares the working tree against `gitRev`; `session` reads the
newest `workspace/changes` record the Host still serves for this session; `auto`
(default) tries git and falls back to the record. The record lives in the Host
process only, so after a restart only git can still see the work.

**Evidence gate.** The reviewer must quote the line that proves each finding, say
what it causes (`impact`) and how it is reached (`trigger`). A quote that does not
occur in the diff or in what the reader tools returned is discarded and the
finding with it. Anything that fails is **withheld**, never silently dropped: the
count is shown and each claim is listed with its reason. The verdict is recomputed
from the findings that survive.

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
nor a reload, and each run logs the file it read and the values in force.

```json
{
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
  "timeoutMs": 600000,
  "ignored": [],
  "ignoreDefaults": true,
  "respectGitIgnore": true
}
```

| Key | Meaning |
|---|---|
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

## Findings

Categories: `correctness`, `concurrency`, `error-handling`, `security`,
`api-misuse`, `performance`, `tests`, `consistency`. Severities: `blocker`,
`major`, `minor`, `nit`. The verdict is `fail` when a blocker or major survives the
evidence gate, `warn` for minor or nit only, otherwise `pass`.

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

## Package layout

| File | Role |
|---|---|
| `index.js` | Host half: the `/review` command, change collection, reviewer call. |
| `client.js` | Client half: the report card and its copy actions. |
| `cordis.patch.yml` | Bundle patch: inserts the `code-review` plugin row. |
| `selftest.mjs` | `node selftest.mjs` drives both halves and asserts every path. |

The Host half appends a machine-readable payload to the report after
`<!-- code-review:payload -->` as one fenced JSON block (`schema: code-review/1`);
the card parses it and falls back to the raw report text when it cannot.

## License

MIT
