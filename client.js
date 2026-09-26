/**
 * dsh-code-review — Client half.
 *
 * Draws the report the Host half returns, as the renderer for the `review`
 * command row. It fetches nothing and owns no state: everything it shows
 * arrives in the command node's `outcome.text`, as a Markdown report followed by
 * one fenced JSON payload after `<!-- code-review:payload -->`. A card that
 * cannot parse the payload falls back to the raw report text.
 *
 * The card is mode-agnostic: the Host half sends the mode's label, its severity
 * vocabulary and the ordered field list of one finding, and the card draws what
 * it was sent. It knows no particular mode, so a mode a user wrote under `modes`
 * in `config.json` renders exactly like `cr` or `arc` does.
 *
 * The card is where the review is read and taken away. It renders the report and
 * offers a copy action — the whole report, or one finding — and nothing else: no
 * button sends anything to the agent, because a review is a decision aid and the
 * decision, with the instruction that follows from it, belongs to the human.
 * The report never reaches the agent by itself either; see `notifyAgent`.
 */
window.__ModuleLoader__.load({
  id: '@local/dsh-code-review',
  factory(require) {
    const React = require('react')
    const h = React.createElement

    const NS = 'code-review'
    const MARKER = '<!-- code-review:payload -->'

    /**
     * What the card draws when a payload does not describe its mode — a payload
     * from another release, or the raw fallback face. It carries the code-review
     * vocabulary the plugin shipped before modes, labels included, so the card
     * never shows a blank finding.
     */
    const DEFAULT_MODE = {
      id: 'cr',
      label: 'Code review',
      verdicts: {},
      severities: [
        { id: 'blocker', label: 'blocker', tone: 'error' },
        { id: 'major', label: 'major', tone: 'warn' },
        { id: 'minor', label: 'minor', tone: 'muted' },
        { id: 'nit', label: 'nit', tone: 'muted' },
      ],
      fields: [
        { key: 'problem', label: '', block: false },
        { key: 'impact', label: 'Impact', block: false },
        { key: 'trigger', label: 'How it is reached', block: false },
        { key: 'suggestion', label: 'Fix', block: false },
        { key: 'evidence', label: 'Evidence', block: true },
      ],
    }

    const en = {
      'title': 'Code review',
      'state.running': 'Reviewing the change set…',
      'state.error': 'The review did not complete',
      'label.findings': 'Findings',
      'label.skipped': 'Left out of the review',
      'label.ignored': 'Excluded by the ignore rules',
      'label.withheld': 'Withheld as unprovable',
      'label.reviewer': 'reviewer',
      'empty.findings': 'No proven findings — nothing here stands up as worth reporting.',
      'stat.files': 'files',
      'stat.lines': 'lines',
      'stat.reviewed': 'reviewed',
      'stat.skipped': 'left out',
      'stat.ignored': 'ignored',
      'stat.findings': 'findings',
      'stat.withheld': 'withheld',
      'stat.reads': 'context reads',
      'toggle.hide': 'Collapse',
      'toggle.show': 'Expand',
      'raw.fallback': 'Structured payload unavailable — showing the report text.',
      'action.copyReport': 'Copy report',
      'action.copyFinding': 'Copy',
      'action.copied': 'Copied',
      'action.failed': 'Copy failed',
      'action.yours': 'The report is yours; nothing has been changed.',
    }

    const zh = {
      'title': '代码审核',
      'state.running': '正在审核本次改动…',
      'state.error': '审核未能完成',
      'label.findings': '问题清单',
      'label.skipped': '未纳入审核',
      'label.ignored': '被忽略规则排除',
      'label.withheld': '因无法证实而扣留',
      'label.reviewer': '审核模型',
      'empty.findings': '没有可证实的发现——这里没有值得报告的问题。',
      'stat.files': '个文件',
      'stat.lines': '行',
      'stat.reviewed': '已审核',
      'stat.skipped': '未纳入',
      'stat.ignored': '条被忽略',
      'stat.findings': '个问题',
      'stat.withheld': '条被扣留',
      'stat.reads': '次上下文读取',
      'toggle.hide': '收起',
      'toggle.show': '展开',
      'raw.fallback': '结构化数据不可用——改为显示报告原文。',
      'action.copyReport': '复制报告',
      'action.copyFinding': '复制',
      'action.copied': '已复制',
      'action.failed': '复制失败',
      'action.yours': '报告只给你；没有任何改动发生。',
    }

    const CSS = `
.dcr-card {
  border: 1px solid var(--dsw-alias-border-l1);
  background: var(--dsw-alias-bg-layer-1);
  border-radius: 10px; padding: 10px 12px; margin: 4px 0;
  font-size: 12.5px; line-height: 1.55; color: var(--dsw-alias-label-primary);
}
.dcr-head { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.dcr-title { font-weight: 600; }
.dcr-spacer { flex: 1 1 auto; }
.dcr-toggle {
  border: 1px solid var(--dsw-alias-border-l1); background: transparent; cursor: pointer;
  color: var(--dsw-alias-label-secondary); border-radius: 6px; padding: 1px 7px; font-size: 11px;
}
.dcr-chip {
  border: 1px solid currentColor; border-radius: 999px; padding: 1px 8px;
  font-size: 11px; font-weight: 600; text-transform: lowercase; white-space: nowrap;
}
.dcr-chip[data-tone="success"] { color: var(--dsw-alias-state-success-primary); }
.dcr-chip[data-tone="warn"] { color: var(--dsw-alias-state-warn-primary); }
.dcr-chip[data-tone="error"] { color: var(--dsw-alias-state-error-primary); }
.dcr-chip[data-tone="muted"] { color: var(--dsw-alias-state-idle-primary); }
.dcr-meta { color: var(--dsw-alias-label-secondary); font-size: 11.5px; margin-top: 6px; }
.dcr-summary { margin-top: 8px; white-space: pre-wrap; }
.dcr-section { margin-top: 10px; padding-top: 8px; border-top: 1px solid var(--dsw-alias-border-l1); }
.dcr-section-label { font-size: 11px; letter-spacing: .04em; text-transform: uppercase; color: var(--dsw-alias-label-secondary); }
.dcr-finding { margin-top: 8px; }
.dcr-finding-head { display: flex; align-items: baseline; gap: 7px; flex-wrap: wrap; }
.dcr-where { font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; font-size: 11.5px; color: var(--dsw-alias-label-secondary); }
.dcr-cat { font-size: 11px; color: var(--dsw-alias-label-secondary); }
.dcr-problem { margin-top: 3px; white-space: pre-wrap; }
.dcr-field { margin-top: 4px; white-space: pre-wrap; color: var(--dsw-alias-label-secondary); }
.dcr-field-bare { margin-top: 3px; white-space: pre-wrap; }
.dcr-evidence-label { margin-top: 5px; }
.dcr-evidence { max-height: 160px; }
.dcr-list { margin: 4px 0 0; padding-left: 18px; color: var(--dsw-alias-label-secondary); }
.dcr-actions { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; margin-top: 7px; }
.dcr-action {
  border: 1px solid var(--dsw-alias-border-l1); background: transparent; cursor: pointer;
  color: var(--dsw-alias-label-secondary); border-radius: 6px; padding: 1px 8px; font-size: 11px;
}
.dcr-action:hover { color: var(--dsw-alias-label-primary); border-color: var(--dsw-alias-label-secondary); }
.dcr-action[data-done="1"] { color: var(--dsw-alias-state-success-primary); border-color: currentColor; }
.dcr-hint { color: var(--dsw-alias-label-secondary); font-size: 11px; }
.dcr-pre {
  margin: 6px 0 0; padding: 8px; overflow: auto; max-height: 320px;
  background: var(--dsw-alias-bg-layer-2); border-radius: 6px;
  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  font-size: 11.5px; white-space: pre-wrap;
}
`

    function parsePayload(text) {
      if (typeof text !== 'string') return undefined
      const marker = text.indexOf(MARKER)
      if (marker < 0) return undefined
      const rest = text.slice(marker + MARKER.length)
      const fence = rest.indexOf('```json')
      if (fence < 0) return undefined
      const body = rest.slice(fence + '```json'.length)
      // The payload is the last block of the report and its own fields may
      // contain a fence (an evidence quote from a Markdown file, for instance),
      // so the closing fence is the last one.
      const end = body.lastIndexOf('```')
      if (end < 0) return undefined
      try {
        const parsed = JSON.parse(body.slice(0, end))
        return parsed !== null && typeof parsed === 'object' ? parsed : undefined
      } catch {
        return undefined
      }
    }

    /**
     * Which face the card shows for one command outcome, and the payload behind
     * it. A command that succeeded but whose payload did not parse is `unparsed`,
     * not `error`: the review did run, and saying otherwise is a lie.
     */
    function readOutcome(outcome) {
      if (outcome === null || outcome === undefined) return { face: 'running', payload: undefined }
      if (outcome.kind !== 'success') return { face: 'error', payload: undefined }
      const payload = parsePayload(outcome.text)
      return payload === undefined
        ? { face: 'unparsed', payload: undefined }
        : { face: 'report', payload }
    }

    /** The Markdown report without the machine payload that follows it. */
    function reportOf(text) {
      if (typeof text !== 'string') return ''
      const marker = text.indexOf(MARKER)
      return (marker < 0 ? text : text.slice(0, marker)).trimEnd()
    }

    /** `file:line` of one finding, or an empty string when it names no file. */
    function whereOf(finding) {
      const file = typeof finding?.file === 'string' ? finding.file : ''
      if (file === '') return ''
      return `${file}${Number.isInteger(finding?.line) ? `:${finding.line}` : ''}`
    }

    /**
     * The mode a payload describes: the fields, their labels and the severity
     * vocabulary the Host half sent with the report. The card knows nothing about
     * any particular mode, so a mode a user wrote renders like a built-in one.
     */
    function modeOf(payload) {
      const mode = payload?.mode
      if (mode === null || typeof mode !== 'object' || !Array.isArray(mode.fields)) return DEFAULT_MODE
      return {
        id: typeof mode.id === 'string' ? mode.id : DEFAULT_MODE.id,
        label: typeof mode.label === 'string' && mode.label !== '' ? mode.label : DEFAULT_MODE.label,
        verdicts: typeof mode.verdicts === 'object' && mode.verdicts !== null ? mode.verdicts : {},
        severities: Array.isArray(mode.severities)
          ? mode.severities.filter(entry => entry !== null && typeof entry === 'object')
          : DEFAULT_MODE.severities,
        fields: mode.fields.filter(entry => entry !== null && typeof entry === 'object' && typeof entry.key === 'string'),
      }
    }

    /** How one severity is named and toned, for the chip and the withheld list. */
    function severityOf(mode, id) {
      const found = mode.severities.find(entry => entry.id === id)
      if (found !== undefined) {
        return { id, label: typeof found.label === 'string' && found.label !== '' ? found.label : id, tone: found.tone }
      }
      return { id, label: typeof id === 'string' ? id : '?', tone: 'muted' }
    }

    /**
     * One finding as the report itself words it, so a copy pastes cleanly
     * elsewhere. The body is the mode's own field list, in its order: a `block`
     * field is fenced, an empty label renders the text bare.
     */
    function findingText(finding, index, mode = DEFAULT_MODE) {
      const where = whereOf(finding)
      const severity = severityOf(mode, finding?.severity)
      const lines = [`### ${index + 1}. [${severity.label}] ${finding?.title ?? ''}${where === '' ? '' : ` — ${where}`}`]
      if (finding?.category) lines.push(`category: ${finding.category}`)
      for (const field of mode.fields) {
        const value = finding?.[field.key]
        if (typeof value !== 'string' || value === '') continue
        if (field.block) {
          lines.push('', ...(field.label === '' ? [] : [`**${field.label}:**`, '']), '```diff', value, '```')
        } else if (field.label === '') {
          lines.push('', value)
        } else {
          lines.push('', `**${field.label}:** ${value}`)
        }
      }
      return lines.join('\n')
    }

    /** Clipboard write, with the selection fallback for a context without the async API. */
    async function copyText(text) {
      try {
        if (typeof navigator !== 'undefined' && navigator.clipboard?.writeText !== undefined) {
          await navigator.clipboard.writeText(text)
          return true
        }
      } catch {
        // fall through to the selection copy
      }
      try {
        const area = document.createElement('textarea')
        area.value = text
        area.setAttribute('readonly', '')
        area.style.position = 'fixed'
        area.style.top = '-1000px'
        area.style.opacity = '0'
        document.body.appendChild(area)
        area.select()
        const ok = typeof document.execCommand === 'function' && document.execCommand('copy')
        document.body.removeChild(area)
        return ok === true
      } catch {
        return false
      }
    }

    function toneOf(verdict) {
      if (verdict === 'fail') return 'error'
      if (verdict === 'warn') return 'warn'
      if (verdict === 'pass') return 'success'
      return 'muted'
    }

    function chip(label, tone, key) {
      return h('span', { className: 'dcr-chip', 'data-tone': tone, key }, label)
    }

    function countLine(payload, t, mode) {
      const stats = payload.stats ?? {}
      const parts = [
        `${stats.files ?? 0} ${t('stat.files')}`,
        `+${stats.added ?? 0} / -${stats.deleted ?? 0} ${t('stat.lines')}`,
        `${stats.reviewed ?? 0} ${t('stat.reviewed')}`,
      ]
      const skipped = Array.isArray(stats.skipped) ? stats.skipped.length : 0
      if (skipped > 0) parts.push(`${skipped} ${t('stat.skipped')}`)
      const ignored = stats.ignore?.count ?? 0
      if (ignored > 0) parts.push(`${ignored} ${t('stat.ignored')}`)
      const findings = Array.isArray(payload.findings) ? payload.findings : []
      const bySeverity = mode.severities
        .map(severity => [severityOf(mode, severity.id).label, findings.filter(finding => finding.severity === severity.id).length])
        .filter(([, count]) => count > 0)
        .map(([label, count]) => `${label} ${count}`)
      parts.push(`${findings.length} ${t('stat.findings')}${bySeverity.length === 0 ? '' : ` (${bySeverity.join(', ')})`}`)
      const withheld = Array.isArray(payload.withheld) ? payload.withheld.length : 0
      if (withheld > 0) parts.push(`${withheld} ${t('stat.withheld')}`)
      const reads = payload.stats?.context?.calls ?? 0
      if (reads > 0) parts.push(`${reads} ${t('stat.reads')}`)
      return parts.join(' · ')
    }

    /**
     * A button that puts `text` on the clipboard and reports the outcome for a
     * moment. The timer lives in a state-initialized box so no extra hook is
     * needed, and a failed copy says so instead of silently doing nothing.
     */
    function CopyButton({ text, label, t }) {
      const [state, setState] = React.useState('idle')
      const [box] = React.useState(() => ({ timer: null }))
      const onClick = () => {
        void copyText(text).then(ok => {
          setState(ok ? 'done' : 'failed')
          if (box.timer !== null) clearTimeout(box.timer)
          box.timer = setTimeout(() => setState('idle'), 1600)
        })
      }
      const shown = state === 'done' ? 'action.copied' : state === 'failed' ? 'action.failed' : label
      return h('button', {
        className: 'dcr-action',
        type: 'button',
        onClick,
        'data-done': state === 'done' ? '1' : undefined,
      }, t(shown))
    }

    /**
     * The row under one finding. It copies and nothing else: a review is a
     * decision aid, and the decision — and the instruction that follows from it —
     * belongs to the human, who hands it to the agent in their own words.
     */
    function findingActions(finding, index, t, mode) {
      return h('div', { className: 'dcr-actions', key: 'actions' }, [
        h(CopyButton, {
          key: 'copy',
          text: findingText(finding, index, mode),
          label: 'action.copyFinding',
          t,
        }),
        h('span', { className: 'dcr-hint', key: 'hint' }, t('action.yours')),
      ])
    }

    /**
     * One finding, drawn from the field list its mode declared: the chip is the
     * mode's name for the severity, the body is the mode's fields in the mode's
     * order, and a field the mode marked `block` is quoted code.
     */
    function findingRow(finding, index, t, mode) {
      const where = whereOf(finding)
      const severity = severityOf(mode, finding.severity)
      const body = []
      for (const field of mode.fields) {
        const value = finding[field.key]
        if (typeof value !== 'string' || value === '') continue
        if (field.block) {
          body.push(h('div', { key: `field-${field.key}` }, [
            field.label === ''
              ? null
              : h('div', { className: 'dcr-section-label dcr-evidence-label', key: 'label' }, field.label),
            h('pre', { className: 'dcr-pre dcr-evidence', key: 'quote' }, value),
          ]))
          continue
        }
        if (field.label === '') {
          body.push(h('div', { className: 'dcr-field-bare', key: `field-${field.key}` }, value))
          continue
        }
        body.push(h('div', { className: 'dcr-field', key: `field-${field.key}` }, `${field.label}: ${value}`))
      }
      return h('div', { className: 'dcr-finding', key: `${finding.file ?? ''}#${index}` }, [
        h('div', { className: 'dcr-finding-head', key: 'head' }, [
          chip(severity.label, severity.tone, 'sev'),
          h('strong', { key: 'title' }, finding.title ?? ''),
          where === '' ? null : h('span', { className: 'dcr-where', key: 'where' }, where),
          finding.category ? h('span', { className: 'dcr-cat', key: 'cat' }, finding.category) : null,
        ]),
        ...body,
        findingActions(finding, index, t, mode),
      ])
    }

    function skippedList(skipped, t) {
      if (!Array.isArray(skipped) || skipped.length === 0) return null
      return h('div', { className: 'dcr-section' }, [
        h('div', { className: 'dcr-section-label', key: 'label' }, t('label.skipped')),
        h('ul', { className: 'dcr-list', key: 'list' }, skipped.map((item, index) => h(
          'li',
          { key: `${item?.file ?? index}` },
          `${item?.file ?? '?'} — ${item?.reason ?? '?'}`,
        ))),
      ])
    }

    /**
     * What the ignore rules took out of the change set, with the rule that took
     * it. The count is the truth and the list is a sample, so a report never
     * grows a dependency tree it was asked to leave out.
     */
    function ignoredList(ignore, t) {
      const sample = Array.isArray(ignore?.sample) ? ignore.sample : []
      if (sample.length === 0) return null
      return h('div', { className: 'dcr-section' }, [
        h('div', { className: 'dcr-section-label', key: 'label' }, `${t('label.ignored')} (${ignore.count ?? sample.length})`),
        h('ul', { className: 'dcr-list', key: 'list' }, sample.map((item, index) => h(
          'li',
          { key: `${item?.file ?? index}` },
          `${item?.file ?? '?'} — ${item?.rule ?? '?'}`,
        ))),
      ])
    }

    function withheldList(withheld, t, mode) {
      if (!Array.isArray(withheld) || withheld.length === 0) return null
      return h('div', { className: 'dcr-section' }, [
        h('div', { className: 'dcr-section-label', key: 'label' }, t('label.withheld')),
        h('ul', { className: 'dcr-list', key: 'list' }, withheld.map((item, index) => h(
          'li',
          { key: `${item?.file ?? ''}#${index}` },
          `[${severityOf(mode, item?.severity).label}] ${item?.title ?? '?'} — ${item?.reason ?? '?'}`,
        ))),
      ])
    }

    function head(title, chips, controls) {
      return h('div', { className: 'dcr-head' }, [
        h('span', { className: 'dcr-title', key: 'title' }, title),
        ...chips,
        h('span', { className: 'dcr-spacer', key: 'spacer' }),
        ...(Array.isArray(controls) ? controls : [controls]).filter(Boolean),
      ])
    }

    function ReviewCard({ node, t }) {
      const outcome = node?.outcome ?? null
      const [open, setOpen] = React.useState(true)
      const view = React.useMemo(() => readOutcome(outcome), [outcome])
      const { face, payload } = view

      const toggle = h('button', {
        className: 'dcr-toggle', type: 'button', onClick: () => setOpen(value => !value),
      }, t(open ? 'toggle.hide' : 'toggle.show'))

      if (face === 'running') {
        return h('div', { className: 'dcr-card' }, [
          h('style', { key: 'css' }, CSS),
          head(t('title'), [chip(t('state.running'), 'muted', 'run')], null),
        ])
      }

      if (face === 'error' || face === 'unparsed') {
        const raw = String(outcome.text ?? '')
        return h('div', { className: 'dcr-card' }, [
          h('style', { key: 'css' }, CSS),
          head(
            t('title'),
            [face === 'error'
              ? chip(t('state.error'), 'error', 'err')
              : chip(t('raw.fallback'), 'warn', 'raw')],
            [h(CopyButton, { key: 'copy', text: raw, label: 'action.copyReport', t })],
          ),
          h('pre', { className: 'dcr-pre' }, raw),
        ])
      }

      const findings = Array.isArray(payload.findings) ? payload.findings : []
      const mode = modeOf(payload)
      const reviewer = payload.reviewer
      const subtitle = `${countLine(payload, t, mode)}${reviewer ? ` · ${t('label.reviewer')} ${reviewer.provider}/${reviewer.model}` : ''}`
      // The verdict chip says the mode's own word for the answer — `fail` for a
      // code review, `decide before merge` for an architecture review — while the
      // tone stays the machine verdict, so the card reads the same at a glance.
      const verdictLabel = payload.mode?.verdict?.label ?? mode.verdicts[payload.verdict] ?? payload.verdict ?? 'pass'

      return h('div', { className: 'dcr-card' }, [
        h('style', { key: 'css' }, CSS),
        head(
          mode.label,
          [chip(String(verdictLabel), toneOf(payload.verdict), 'verdict')],
          [
            h(CopyButton, { key: 'copy', text: reportOf(outcome.text), label: 'action.copyReport', t }),
            toggle,
          ],
        ),
        h('div', { className: 'dcr-meta', key: 'meta' }, subtitle),
        open ? h('div', { key: 'body' }, [
          payload.summary
            ? h('div', { className: 'dcr-summary', key: 'summary' }, payload.summary)
            : null,
          h('div', { className: 'dcr-section', key: 'findings' }, [
            h('div', { className: 'dcr-section-label', key: 'label' }, t('label.findings')),
            findings.length === 0
              ? h('div', { className: 'dcr-meta', key: 'none' }, t('empty.findings'))
              : h('div', { key: 'list' }, findings.map((finding, index) => findingRow(finding, index, t, mode))),
          ]),
          skippedList(payload.stats?.skipped, t),
          ignoredList(payload.stats?.ignore, t),
          withheldList(payload.withheld, t, mode),
        ]) : null,
      ])
    }

    return {
      inject: ['slots', 'locale'],
      /** Loaded by the self-test, which imports this artifact with a stub React. */
      __test: { parsePayload, readOutcome, reportOf, findingText, modeOf, severityOf },
      apply(ctx) {
        ctx.effect(() => ctx.locale.register(NS, 'en', en), 'code-review: en dictionary')
        ctx.effect(() => ctx.locale.register(NS, 'zh', zh), 'code-review: zh dictionary')
        const t = ctx.locale.bind(NS)
        /** Stable component identity; the bound translate function reads the active locale per call. */
        const Card = props => h(ReviewCard, { ...props, t })
        ctx.slots.inject('conversation.chat.commandview', () => ctx.slots.register({
          name: 'conversation.chat.commandview',
          key: 'review',
          locale: NS,
        }, Card))
      },
    }
  },
})
