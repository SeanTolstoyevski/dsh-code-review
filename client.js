/**
 * dsh-code-review — Client half.
 *
 * Draws the report the Host half returns, as the renderer for the `review`
 * command row. It fetches nothing and owns no state: everything it shows
 * arrives in the command node's `outcome.text`, as a Markdown report followed by
 * one fenced JSON payload after `<!-- code-review:payload -->`. A card that
 * cannot parse the payload falls back to the raw report text.
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
    const SEVERITIES = ['blocker', 'major', 'minor', 'nit']

    const en = {
      'title': 'Code review',
      'state.running': 'Reviewing the change set…',
      'state.error': 'The review did not complete',
      'label.findings': 'Findings',
      'label.skipped': 'Left out of the review',
      'label.ignored': 'Excluded by the ignore rules',
      'label.fix': 'Fix',
      'label.impact': 'Impact',
      'label.trigger': 'How it is reached',
      'label.evidence': 'Evidence from the diff',
      'label.withheld': 'Withheld as unprovable',
      'label.reviewer': 'reviewer',
      'empty.findings': 'No proven findings — nothing in this diff stands up as a defect.',
      'stat.files': 'files',
      'stat.lines': 'lines',
      'stat.reviewed': 'reviewed',
      'stat.skipped': 'left out',
      'stat.ignored': 'ignored',
      'stat.findings': 'findings',
      'stat.withheld': 'withheld',
      'stat.reads': 'context reads',
      'severity.blocker': 'blocker',
      'severity.major': 'major',
      'severity.minor': 'minor',
      'severity.nit': 'nit',
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
      'label.fix': '修改建议',
      'label.impact': '会造成什么',
      'label.trigger': '如何被触发',
      'label.evidence': 'diff 中的证据',
      'label.withheld': '因无法证实而扣留',
      'label.reviewer': '审核模型',
      'empty.findings': '没有可证实的发现——就这段 diff 而言没有站得住的缺陷。',
      'stat.files': '个文件',
      'stat.lines': '行',
      'stat.reviewed': '已审核',
      'stat.skipped': '未纳入',
      'stat.ignored': '条被忽略',
      'stat.findings': '个问题',
      'stat.withheld': '条被扣留',
      'stat.reads': '次上下文读取',
      'severity.blocker': '阻断',
      'severity.major': '严重',
      'severity.minor': '次要',
      'severity.nit': '细节',
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
.dcr-fix { margin-top: 3px; white-space: pre-wrap; color: var(--dsw-alias-label-secondary); }
.dcr-impact { margin-top: 4px; white-space: pre-wrap; }
.dcr-trigger { margin-top: 3px; white-space: pre-wrap; color: var(--dsw-alias-label-secondary); }
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

    /** One finding as the report itself words it, so a copy pastes cleanly elsewhere. */
    function findingText(finding, index) {
      const where = whereOf(finding)
      const lines = [`### ${index + 1}. [${finding?.severity ?? '?'}] ${finding?.title ?? ''}${where === '' ? '' : ` — ${where}`}`]
      if (finding?.category) lines.push(`category: ${finding.category}`)
      if (finding?.problem) lines.push('', finding.problem)
      if (finding?.impact) lines.push('', `**Impact:** ${finding.impact}`)
      if (finding?.trigger) lines.push('', `**How it is reached:** ${finding.trigger}`)
      if (finding?.suggestion) lines.push('', `**Fix:** ${finding.suggestion}`)
      if (finding?.evidence) lines.push('', '**Evidence:**', '', '```diff', finding.evidence, '```')
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

    function severityTone(severity) {
      if (severity === 'blocker') return 'error'
      if (severity === 'major') return 'warn'
      return 'muted'
    }

    function chip(label, tone, key) {
      return h('span', { className: 'dcr-chip', 'data-tone': tone, key }, label)
    }

    function countLine(payload, t) {
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
      const bySeverity = SEVERITIES
        .map(severity => [severity, findings.filter(finding => finding.severity === severity).length])
        .filter(([, count]) => count > 0)
        .map(([severity, count]) => `${t(`severity.${severity}`)} ${count}`)
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
    function findingActions(finding, index, t) {
      return h('div', { className: 'dcr-actions', key: 'actions' }, [
        h(CopyButton, {
          key: 'copy',
          text: findingText(finding, index),
          label: 'action.copyFinding',
          t,
        }),
        h('span', { className: 'dcr-hint', key: 'hint' }, t('action.yours')),
      ])
    }

    function findingRow(finding, index, t) {
      const where = whereOf(finding)
      return h('div', { className: 'dcr-finding', key: `${finding.file ?? ''}#${index}` }, [
        h('div', { className: 'dcr-finding-head', key: 'head' }, [
          chip(t(`severity.${SEVERITIES.includes(finding.severity) ? finding.severity : 'minor'}`), severityTone(finding.severity), 'sev'),
          h('strong', { key: 'title' }, finding.title ?? ''),
          where === '' ? null : h('span', { className: 'dcr-where', key: 'where' }, where),
          finding.category ? h('span', { className: 'dcr-cat', key: 'cat' }, finding.category) : null,
        ]),
        finding.problem ? h('div', { className: 'dcr-problem', key: 'problem' }, finding.problem) : null,
        finding.impact
          ? h('div', { className: 'dcr-impact', key: 'impact' }, `${t('label.impact')}: ${finding.impact}`)
          : null,
        finding.trigger
          ? h('div', { className: 'dcr-trigger', key: 'trigger' }, `${t('label.trigger')}: ${finding.trigger}`)
          : null,
        finding.suggestion
          ? h('div', { className: 'dcr-fix', key: 'fix' }, `${t('label.fix')}: ${finding.suggestion}`)
          : null,
        finding.evidence
          ? h('div', { key: 'evidence' }, [
            h('div', { className: 'dcr-section-label dcr-evidence-label', key: 'label' }, t('label.evidence')),
            h('pre', { className: 'dcr-pre dcr-evidence', key: 'quote' }, finding.evidence),
          ])
          : null,
        findingActions(finding, index, t),
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

    function withheldList(withheld, t) {
      if (!Array.isArray(withheld) || withheld.length === 0) return null
      return h('div', { className: 'dcr-section' }, [
        h('div', { className: 'dcr-section-label', key: 'label' }, t('label.withheld')),
        h('ul', { className: 'dcr-list', key: 'list' }, withheld.map((item, index) => h(
          'li',
          { key: `${item?.file ?? ''}#${index}` },
          `[${item?.severity ?? '?'}] ${item?.title ?? '?'} — ${item?.reason ?? '?'}`,
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
      const reviewer = payload.reviewer
      const subtitle = `${countLine(payload, t)}${reviewer ? ` · ${t('label.reviewer')} ${reviewer.provider}/${reviewer.model}` : ''}`

      return h('div', { className: 'dcr-card' }, [
        h('style', { key: 'css' }, CSS),
        head(
          t('title'),
          [chip(String(payload.verdict ?? 'pass'), toneOf(payload.verdict), 'verdict')],
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
              : h('div', { key: 'list' }, findings.map((finding, index) => findingRow(finding, index, t))),
          ]),
          skippedList(payload.stats?.skipped, t),
          ignoredList(payload.stats?.ignore, t),
          withheldList(payload.withheld, t),
        ]) : null,
      ])
    }

    return {
      inject: ['slots', 'locale'],
      /** Loaded by the self-test, which imports this artifact with a stub React. */
      __test: { parsePayload, readOutcome, reportOf, findingText },
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
