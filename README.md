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
/review [full|session] [provider=<id>] [model=<id>] [language=<code>] [gitRev=<rev>] [source=auto|git|session] [focus message]
```

- `/review` or `/review full` — every uncommitted change in the **repository**
  against `gitRev` (default `HEAD`), untracked files included. Files this session
  wrote or edited are marked *primary*, the rest as *not by this session*;
- `/review session` — only the files this session wrote or edited;
- everything after the arguments is a **focus message**: the only text of yours
  the reviewer ever sees (`/review session board.go satır 13`).

The reviewer never reads the conversation. Your chat messages do not reach it.

### On the card

| Control | What it does |
|---|---|
| **Copy report** | the whole Markdown report, ready to paste somewhere else |
| **Copy** (per finding) | that one finding, in the report's own wording |

The card shows the report and copies it. It has no control that sends anything:
a review is a decision aid, not a work order and the decision — with the
instruction that follows from it — is yours to give.

## How it works

1. changes are collected — git first, otherwise the session's own recorded changes;
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
read outside it. Reading is bounded by `maxToolCalls`, `maxReadBytes`,
`maxSearchResults` and `toolDeadlineRatio`; when a bound is reached the reviewer is
told and must answer. Set `projectAccess: false` for a diff-only review.

## Configuration

`DSH_HOME/code-review/config.json`. Every key is optional and the file is re-read
on every run — tuning needs neither a restart nor a reload.

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
  "timeoutMs": 600000
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
| `maxTokens`, `temperature`, `timeoutMs` | Output cap, sampling and the budget for the whole run. A first call that fails is retried once without project access and with the output cap lowered to 8192 or to the configured value when that is smaller; the report says the run was degraded. |

## Findings

Categories: `correctness`, `concurrency`, `error-handling`, `security`,
`api-misuse`, `performance`, `tests`, `consistency`. Severities: `blocker`,
`major`, `minor`, `nit`. The verdict is `fail` when a blocker or major survives the
evidence gate, `warn` for minor or nit only, otherwise `pass`.

A file that is binary, oversized or over a budget is reported as **left out**,
never silently dropped. Output that cannot be parsed fails loudly with the raw
text instead of reporting a fake pass.

## Limits

- The reviewer reads the workspace but cannot run anything, so build and test
  results stay outside its reach by construction.
- Files changed by a shell command cannot be attributed to the session; they show
  up under `full`.
- A finding may cite a file outside the change set when the proof lives there (a
  caller, a definition); the reachability rule in its prompt still ties it to the
  change set.

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
