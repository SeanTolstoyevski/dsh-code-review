# dsh-code-review

On-demand code review for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness).
`/review` audits the uncommitted changes of the workspace with a reviewer model and
renders the report as a card in the conversation.

- **Modes** 
  `cr` reviews the changed lines, `arc` reviews the shape of the change.
  You add your own under `modes` in the settings file: a role, the fields a finding
  must state, its severity vocabulary, and a preset of run settings.
- **A review that survives a bad run**
  The reviewer records each finding the
  moment it is settled, so a broken stream, a timeout, a cancel or a model that
  never finishes still hands you everything recorded before it stopped — marked
  incomplete, never lost.
- **Yours alone**
  By default the agent is not told about the review, nothing is
  read into its context and no code changes. You read the report and decide what
  to do with it. One exception, and a small one: with `projectAccess` on, the
  reviewer reads through the harness's own tools, and the harness counts that as
  the agent touching those files — which can inform the instruction files the
  agent later sees. Nothing about the review itself reaches it.

## Install

A bundle for a DeepSeek Harness profile. Nothing is built and nothing is installed
with it: the package is plain JavaScript with no dependencies.

1. Install it into your profile. In a session, ask for the bundle installer —
   `plugin_manager`, `action: install_bundle`,
   `target: github:SeanTolstoyevski/dsh-code-review`
    Or use **web ui → plugin
    manager**, paste the URL and install. Installing from a clone does the same
   thing: pass the absolute path of the directory you cloned instead.
2. Restart `dsh web`. A replaced package needs a fresh module generation before
   its JavaScript is loaded again. That first start also writes
   `DSH_HOME/code-review/config.json`, every setting and both built-in modes at
   their defaults, so there is a file to edit on a machine that never had one.
3. Reload the page: the client half is fetched once per page.
4. Type `/review` in the session you want reviewed.

## Use

```text
/review [full|session] [mode=<id>] [provider=<id>] [model=<id>] [reasoningEffort=<id>]
        [language=<code>] [gitRev=<rev>] [source=auto|git|session] [ignored=<pattern,…>]
        [ignoreDefaults=<bool>] [respectGitIgnore=<bool>] [focus message]
```

| Example | What it does |
|---|---|
| `/review` | every uncommitted change in the repository against `HEAD`, in the `cr` mode |
| `/review mode=arc` | the same change set judged as architecture (`mode=` takes an id or an alias) |
| `/review session` | only the files this session wrote or edited |
| `/review ignored=fixtures/,!dist/` | keep `fixtures/` out and review `dist/` anyway |
| `/review reasoningEffort=max` | run the reviewer at the provider's highest thinking level |
| `/review session Thoroughly review the a/b/c.go file.` | everything after the arguments is a **focus message** — the only text of yours the reviewer ever sees |

A name that does not resolve — `mode=`, `reasoningEffort=` — is refused before any
model call, with the names that do resolve listed. The reviewer never reads the
conversation.

## What you get

A card in the conversation: titled by the mode, chipped with the mode's own word
for the verdict, opened by the summary the reviewer recorded, then one block per
finding in the fields that mode declared. **Copy report** takes the whole Markdown
report, **Copy** takes one finding. Every finding quotes the line that proves it,
and the quote is checked against the diff and the files the reviewer actually read
— a claim that does not hold up is listed as *withheld* with its reason instead of
being published. The card shows and copies; it has no control that sends anything.

## Documentation

| Document | Covers |
|---|---|
| [Modes](docs/reference.md#modes) | the two built-in modes, writing your own, the mode key table |
| [Configuration](docs/reference.md#configuration) | the settings file, every key, which layer wins |
| [Ignored paths](docs/reference.md#ignored-paths) | the built-in list, your own patterns, the repository's rules |
| [How a run works](docs/reference.md#how-a-run-works) | change collection, the review tools, partial runs, the evidence gate, the reader tools |
| [Findings](docs/reference.md#findings) | categories, severities, and what *left out* and *withheld* mean |
| [The card](docs/reference.md#the-card) | what the card draws, and what it deliberately cannot do |
| [Limits](docs/reference.md#limits) | the bounds of a run and the known edges |
| [Package layout](docs/reference.md#package-layout) | the files, the payload contract, the self-test |

## License

MIT

