/**
 * AutoConsent — browser half (v1.1).
 *
 * The v1 surface is unchanged: a top-right pill plus an expandable panel with
 * the master switch, timed windows, role templates, per-category switches,
 * quotas, contract, rules, preview and audit. v1.1 layers the smaller
 * interaction work on top:
 *
 *   · the decision precedence is printed where it applies;
 *   · the pill shows a live countdown and turns amber when a quota runs low;
 *   · an AC PROBE chip shows the listening state (red / grey) and can be hidden;
 *   · 补充配额 and 清零重置 are two separate quota actions;
 *   · 审批日志 opens its own lightweight panel;
 *   · role templates preview their rule sheet on hover;
 *   · the version line links to the changelog, and config can be exported.
 */
window.__ModuleLoader__.load({
  id: 'dsh-autoconsent',
  factory (require) {
    const React = require('react')
    const h = React.createElement
    const { useState, useEffect, useCallback, useRef } = React

    const BASE = '/dsh-auto-consent'
    const HEADER = 'x-auto-consent'
    const DEFAULT_POLL_MS = 3000
    const ACTIVITY_MS = 4000
    const PROBE_TITLE = 'AutoConsent Probe｜权限监听已激活，正在拦截工具调用审批'

    const C = {
      fg: 'var(--dsw-alias-label-primary, #111318)',
      soft: 'var(--dsw-alias-label-secondary, #5c6070)',
      faint: 'var(--dsw-alias-label-tertiary, #8b90a0)',
      bg: 'var(--dsw-alias-bg-overlay, rgba(255,255,255,0.96))',
      card: 'var(--dsw-alias-bg-module-platform, rgba(245,246,250,0.9))',
      border: 'var(--dsw-alias-border-l1, rgba(17,19,24,0.14))',
      ok: 'var(--dsw-alias-state-success-primary, #2f9e63)',
      okBg: 'rgba(78, 203, 140, 0.16)',
      okBorder: 'rgba(78, 203, 140, 0.62)',
      warn: 'var(--dsw-alias-state-warn-primary, #b7791f)',
      warnBg: 'rgba(240, 180, 80, 0.18)',
      warnBorder: 'rgba(214, 158, 46, 0.62)',
      error: 'var(--dsw-alias-state-error-primary, #d93f3f)',
      errorBg: 'rgba(217, 63, 63, 0.12)',
      brand: 'var(--dsw-alias-brand-primary, #4d6bfe)',
    }

    const S = {
      panel: {
        marginTop: '8px',
        width: '392px',
        maxHeight: '72vh',
        overflowY: 'auto',
        borderRadius: '14px',
        border: '1px solid ' + C.border,
        background: C.bg,
        color: C.fg,
        boxShadow: '0 18px 48px rgba(0,0,0,0.22)',
        backdropFilter: 'blur(12px)',
        fontSize: '12px',
        lineHeight: '18px',
        padding: '12px 14px 14px',
        pointerEvents: 'auto',
        WebkitAppRegion: 'no-drag',
      },
      logPanel: {
        marginTop: '8px',
        width: '392px',
        maxHeight: '46vh',
        overflowY: 'auto',
        borderRadius: '14px',
        border: '1px solid ' + C.border,
        background: C.bg,
        color: C.fg,
        boxShadow: '0 18px 48px rgba(0,0,0,0.22)',
        backdropFilter: 'blur(12px)',
        fontSize: '12px',
        lineHeight: '18px',
        padding: '12px 14px',
        pointerEvents: 'auto',
        WebkitAppRegion: 'no-drag',
      },
      h1: { fontSize: '13px', fontWeight: 700, letterSpacing: '.2px' },
      h2: {
        fontSize: '11px',
        fontWeight: 700,
        color: C.faint,
        letterSpacing: '.4px',
        margin: '14px 0 6px',
      },
      row: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '8px', padding: '3px 0' },
      hint: { fontSize: '10px', lineHeight: '14px', color: C.faint },
      chip: {
        border: '1px solid ' + C.border,
        borderRadius: '999px',
        padding: '2px 8px',
        fontSize: '10px',
        lineHeight: '16px',
        background: 'transparent',
        color: C.soft,
        cursor: 'pointer',
        font: 'inherit',
      },
      btn: {
        border: '1px solid ' + C.border,
        borderRadius: '8px',
        padding: '4px 9px',
        background: C.card,
        color: C.fg,
        fontSize: '11px',
        font: 'inherit',
        cursor: 'pointer',
        lineHeight: '16px',
      },
      input: {
        width: '100%',
        boxSizing: 'border-box',
        borderRadius: '8px',
        border: '1px solid ' + C.border,
        background: C.card,
        color: C.fg,
        font: 'inherit',
        fontSize: '11px',
        lineHeight: '16px',
        padding: '6px 8px',
        resize: 'vertical',
        minHeight: '48px',
        outline: 'none',
      },
      tip: {
        position: 'absolute',
        top: '30px',
        left: 0,
        zIndex: 3,
        width: '300px',
        padding: '8px 10px',
        borderRadius: '10px',
        border: '1px solid ' + C.border,
        background: C.bg,
        boxShadow: '0 12px 30px rgba(0,0,0,0.24)',
        pointerEvents: 'none',
      },
    }

    function Switch ({ on, onClick, disabled }) {
      return h('span', {
        role: 'button',
        'aria-pressed': Boolean(on),
        onClick: disabled ? undefined : onClick,
        style: {
          position: 'relative',
          flex: '0 0 auto',
          width: '28px',
          height: '16px',
          borderRadius: '999px',
          background: on ? C.ok : 'var(--dsw-alias-interactive-bg-hover, rgba(17,19,24,0.12))',
          border: '1px solid ' + (on ? C.ok : C.border),
          cursor: disabled ? 'default' : 'pointer',
          opacity: disabled ? 0.45 : 1,
          transition: 'background .14s ease',
        },
      }, h('span', {
        style: {
          position: 'absolute',
          top: '1px',
          left: on ? '13px' : '1px',
          width: '12px',
          height: '12px',
          borderRadius: '999px',
          background: on ? '#fff' : C.soft,
          transition: 'left .14s ease',
        },
      }))
    }

    function Row ({ label, hint, children, muted }) {
      return h('div', { style: { ...S.row, opacity: muted ? 0.45 : 1 } },
        h('span', { style: { display: 'flex', flexDirection: 'column', minWidth: 0 } },
          h('span', { style: { fontSize: '11px' } }, label),
          hint ? h('span', { style: S.hint }, hint) : null),
        children)
    }

    function clockOf (ms) {
      try {
        return new Date(ms).toLocaleTimeString('zh-CN', { hour12: false })
      } catch {
        return ''
      }
    }

    /** 04:21 style countdown. */
    function countdown (ms) {
      const total = Math.max(0, Math.round(ms / 1000))
      const m = Math.floor(total / 60)
      const s = total % 60
      return String(m).padStart(2, '0') + ':' + String(s).padStart(2, '0')
    }

    function DiffView ({ diff }) {
      if (!diff || !Array.isArray(diff.lines) || diff.lines.length === 0) return null
      return h('pre', {
        style: {
          margin: '4px 0 0',
          padding: '6px 8px',
          borderRadius: '8px',
          background: C.card,
          border: '1px solid ' + C.border,
          fontSize: '10px',
          lineHeight: '14px',
          maxHeight: '132px',
          overflow: 'auto',
          whiteSpace: 'pre-wrap',
          wordBreak: 'break-all',
        },
      }, diff.lines.map((line, index) => h('div', {
        key: index,
        style: { color: line.type === 'add' ? C.ok : line.type === 'del' ? C.error : line.type === 'meta' ? C.faint : C.soft },
      }, (line.type === 'add' ? '+ ' : line.type === 'del' ? '- ' : '  ') + line.text)))
    }

    const ACTION_LABEL = {
      auto: '自动放行',
      granted: '自动同意',
      manual: '人工确认',
      deny: '已拦截',
      rejected: '已拒绝',
    }

    function actionColor (action) {
      return action === 'auto' || action === 'granted' ? C.ok : action === 'manual' ? C.warn : C.error
    }

    function AutoConsent () {
      const [snap, setSnap] = useState(null)
      const [open, setOpen] = useState(false)
      const [logOpen, setLogOpen] = useState(false)
      const [busy, setBusy] = useState(false)
      const [failure, setFailure] = useState(null)
      const [goal, setGoal] = useState('')
      const [syncAt, setSyncAt] = useState(0)
      const [nowTick, setNowTick] = useState(Date.now())
      const [hoverTemplate, setHoverTemplate] = useState(null)
      const [quotaForm, setQuotaForm] = useState({ open: false, category: 'shell', amount: 20 })
      const activityAt = useRef(0)
      const fileRef = useRef(null)
      const toggleRef = useRef(() => {})
      const snapRef = useRef(null)

      const call = useCallback(async (path, body, method) => {
        const response = await fetch(BASE + path, {
          method: method || (body === undefined ? 'GET' : 'POST'),
          headers: {
            accept: 'application/json',
            [HEADER]: '1',
            ...(body === undefined ? {} : { 'content-type': 'application/json' }),
          },
          credentials: 'same-origin',
          cache: 'no-store',
          body: body === undefined ? undefined : JSON.stringify(body),
        })
        if (!response.ok) throw new Error('HTTP ' + response.status)
        return response.json()
      }, [])

      const load = useCallback(async () => {
        try {
          const data = await call('/state')
          setSnap(data)
          setSyncAt(Date.now())
          setFailure(null)
        } catch (error) {
          setFailure(String((error && error.message) || error))
        }
      }, [call])

      const mutate = useCallback(async (path, body) => {
        setBusy(true)
        try {
          const data = await call(path, body, 'POST')
          if (data && data.ok === false && data.error) {
            setFailure(data.error)
          } else {
            setSnap(data)
            setSyncAt(Date.now())
            setFailure(null)
          }
        } catch (error) {
          setFailure(String((error && error.message) || error))
        } finally {
          setBusy(false)
        }
      }, [call])

      const pollMs = Math.max(1, Number(snap && snap.ui && snap.ui.pollSeconds) || DEFAULT_POLL_MS / 1000) * 1000

      useEffect(() => {
        let alive = true
        const tick = () => { if (alive) void load() }
        tick()
        const timer = setInterval(tick, pollMs)
        const onVisible = () => { if (!document.hidden) tick() }
        window.addEventListener('focus', tick)
        document.addEventListener('visibilitychange', onVisible)
        return () => {
          alive = false
          clearInterval(timer)
          window.removeEventListener('focus', tick)
          document.removeEventListener('visibilitychange', onVisible)
        }
      }, [load, pollMs])

      // Countdown ticker: only runs while a timed window is active.
      const timedActive = Boolean(snap && snap.enabled && snap.expiresAt)
      useEffect(() => {
        if (!timedActive) return undefined
        const timer = setInterval(() => setNowTick(Date.now()), 1000)
        return () => clearInterval(timer)
      }, [timedActive])

      // Presence heartbeat for the presence-aware downgrade.
      useEffect(() => {
        const beat = () => {
          const now = Date.now()
          if (now - activityAt.current < ACTIVITY_MS) return
          activityAt.current = now
          void fetch(BASE + '/activity', {
            method: 'POST',
            headers: { [HEADER]: '1', 'content-type': 'application/json' },
            credentials: 'same-origin',
            body: '{}',
          }).catch(() => {})
        }
        const events = ['pointerdown', 'pointermove', 'keydown', 'wheel']
        for (const name of events) window.addEventListener(name, beat, { passive: true })
        return () => {
          for (const name of events) window.removeEventListener(name, beat)
        }
      }, [])

      const toggle = useCallback((next, minutes) => {
        void mutate('/toggle', { enabled: next, minutes })
      }, [mutate])

      toggleRef.current = toggle

      // Optional global shortcut: Ctrl+Shift+A flips the master switch.
      useEffect(() => {
        const onKey = (event) => {
          if (!event.ctrlKey || !event.shiftKey) return
          if (String(event.key || '').toLowerCase() !== 'a') return
          const tag = (event.target && event.target.tagName) || ''
          if (/^(input|textarea|select)$/i.test(tag)) return
          event.preventDefault()
          const state = snapRef.current
          if (!state) return
          toggleRef.current(!state.enabled)
        }
        window.addEventListener('keydown', onKey)
        return () => window.removeEventListener('keydown', onKey)
      }, [])

      const exportAudit = useCallback(async () => {
        try {
          const bundle = await call('/audit')
          const blob = new Blob([JSON.stringify(bundle, null, 2)], { type: 'application/json' })
          const url = URL.createObjectURL(blob)
          const anchor = document.createElement('a')
          anchor.href = url
          anchor.download = 'autoconsent-audit-' + new Date().toISOString().replace(/[:.]/g, '-') + '.json'
          document.body.appendChild(anchor)
          anchor.click()
          anchor.remove()
          setTimeout(() => URL.revokeObjectURL(url), 2000)
        } catch (error) {
          setFailure(String((error && error.message) || error))
        }
      }, [call])

      const exportConfig = useCallback(() => {
        if (!snap) return
        const settings = snap.settings || {}
        const payload = {
          plugin: 'AutoConsent',
          version: snap.version,
          exportedAt: new Date().toISOString(),
          config: {
            template: settings.template,
            categories: settings.categories,
            quotas: settings.quotas,
            blacklist: settings.blacklist,
            presenceEnabled: settings.presenceEnabled,
            presenceWindowMs: settings.presenceWindowMs,
            subagentPolicy: settings.subagentPolicy,
            planCheck: settings.planCheck,
            contractEnabled: settings.contractEnabled,
            resetEachTurn: settings.resetEachTurn,
            showProbe: settings.showProbe,
          },
        }
        const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' })
        const url = URL.createObjectURL(blob)
        const anchor = document.createElement('a')
        anchor.href = url
        anchor.download = 'autoconsent-config.json'
        document.body.appendChild(anchor)
        anchor.click()
        anchor.remove()
        setTimeout(() => URL.revokeObjectURL(url), 2000)
      }, [snap])

      const importConfig = useCallback((file) => {
        if (!file) return
        const reader = new FileReader()
        reader.onload = () => {
          try {
            const parsed = JSON.parse(String(reader.result || '{}'))
            const config = parsed && parsed.config ? parsed.config : parsed
            if (!config || typeof config !== 'object') throw new Error('配置格式不正确')
            const patch = {}
            const keys = ['template', 'categories', 'quotas', 'blacklist', 'subagentPolicy', 'planCheck',
              'presenceEnabled', 'presenceWindowMs', 'contractEnabled', 'resetEachTurn', 'showProbe']
            for (const key of keys) if (config[key] !== undefined) patch[key] = config[key]
            void mutate('/settings', { patch })
          } catch (error) {
            setFailure('导入失败：' + String((error && error.message) || error))
          }
        }
        reader.readAsText(file)
      }, [mutate])

      // ---- derived state -------------------------------------------------

      const enabled = Boolean(snap && snap.enabled)
      const expired = Boolean(snap && snap.expired)
      const settings = (snap && snap.settings) || {}
      const session = snap && snap.session
      const stats = (snap && snap.stats) || { auto: 0, manual: 0, denied: 0 }
      const templates = (snap && snap.templates) || []
      const categories = (snap && snap.categories) || []
      const priority = (snap && snap.priority) || []
      const ui = (snap && snap.ui) || {}
      const top = Number(ui.top)
      const right = Number(ui.right)
      const showProbe = settings.showProbe !== false
      const repoUrl = typeof settings.repoUrl === 'string' ? settings.repoUrl : ''
      const remaining = snap && snap.expiresAt ? Math.max(0, snap.expiresAt - nowTick) : 0

      snapRef.current = snap

      const quotaAlerts = categories.filter((category) => {
        const limit = Number(settings.quotas && settings.quotas[category.id])
        if (!Number.isFinite(limit) || limit <= 0) return false
        const left = session && session.quotaLeft ? Number(session.quotaLeft[category.id]) : limit
        return Number.isFinite(left) && left <= limit * 0.1
      })
      const quotaWarn = quotaAlerts.length > 0

      const tone = enabled ? (quotaWarn ? 'warn' : 'ok') : 'off'
      const pillStyle = {
        border: '1px solid ' + (tone === 'ok' ? C.okBorder : tone === 'warn' ? C.warnBorder : C.border),
        background: tone === 'ok' ? C.okBg : tone === 'warn' ? C.warnBg : C.bg,
        color: tone === 'ok' ? C.ok : tone === 'warn' ? C.warn : C.fg,
      }

      const pillLabel = expired ? '自动放行已到期' : enabled ? '已同意 DS 一切权限' : '是否同意 DS 一切权限'
      const pillDetail = failure
        ? '连接失败 · ' + failure
        : timedActive
          ? '自动放行还剩 ' + countdown(remaining)
          : enabled
            ? '自动 ' + stats.auto + ' · 人工 ' + stats.manual + (stats.denied ? ' · 拦截 ' + stats.denied : '') + (quotaWarn ? ' · 配额告警' : '')
            : expired
              ? '点一下重新开启'
              : 'AutoConsent · 点开配置'

      // ---- panel fragments -----------------------------------------------

      const priorityStrip = h('div', {
        style: {
          marginTop: '8px',
          padding: '7px 9px',
          borderRadius: '9px',
          background: C.card,
          border: '1px solid ' + C.border,
          fontSize: '10px',
          lineHeight: '15px',
          color: C.soft,
        },
      },
      h('div', { style: { fontWeight: 700, color: C.fg, marginBottom: '2px' } }, '裁决优先级'),
      h('div', null, priority.map((item, index) => h('span', { key: item.key, title: item.note },
        index > 0 ? h('span', { style: { color: C.faint } }, ' › ') : null,
        h('span', { style: { color: index < 2 ? C.error : index < 4 ? C.warn : C.soft } }, item.label)))),
      h('div', { style: { marginTop: '2px', color: C.faint } },
        '黑名单与契约始终生效；配额耗尽、分组关闭会让该分类强制人工审批，一键开关无法绕过。'))

      const toggleRow = h('div', { style: S.row },
        h('span', null, '一键自动放行'),
        h(Switch, { on: enabled, disabled: busy, onClick: () => toggle(!enabled) }))

      const timerRow = h('div', { style: { display: 'flex', gap: '6px', marginTop: '4px', flexWrap: 'wrap' } },
        h('button', { style: S.chip, onClick: () => toggle(true) }, '常开'),
        h('button', { style: S.chip, onClick: () => toggle(true, 5) }, '5 分钟'),
        h('button', { style: S.chip, onClick: () => toggle(true, 10) }, '10 分钟'),
        h('button', { style: S.chip, onClick: () => toggle(false) }, '关闭'),
        timedActive
          ? h('span', { style: { ...S.hint, alignSelf: 'center', color: C.ok } }, '剩余 ' + countdown(remaining))
          : null)

      const hovered = hoverTemplate ? templates.find((item) => item.id === hoverTemplate) : null

      const templateButtons = h('div', { style: { position: 'relative', display: 'flex', gap: '6px', flexWrap: 'wrap' } },
        templates.map((template) => h('button', {
          key: template.id,
          title: (template.rules || []).join('\n'),
          onMouseEnter: () => setHoverTemplate(template.id),
          onMouseLeave: () => setHoverTemplate(null),
          onFocus: () => setHoverTemplate(template.id),
          onBlur: () => setHoverTemplate(null),
          onClick: () => void mutate('/settings', { patch: { template: template.id } }),
          style: {
            ...S.btn,
            background: settings.template === template.id ? C.okBg : C.card,
            borderColor: settings.template === template.id ? C.okBorder : C.border,
            color: settings.template === template.id ? C.ok : C.fg,
          },
        }, template.label)),
        hovered
          ? h('div', { style: S.tip },
              h('div', { style: { fontWeight: 700, marginBottom: '3px' } }, hovered.label + ' · 规则预览'),
              h('div', { style: { ...S.hint, marginBottom: '4px' } }, hovered.description),
              (hovered.rules || []).map((rule, index) => h('div', { key: index, style: { ...S.hint, color: C.soft } }, '· ' + rule)))
          : null)

      const categoryRows = categories.map((category) => {
        const limit = Number(settings.quotas && settings.quotas[category.id])
        const left = session && session.quotaLeft ? Number(session.quotaLeft[category.id]) : limit
        const low = Number.isFinite(limit) && limit > 0 && Number.isFinite(left) && left <= limit * 0.1
        return h(Row, {
          key: category.id,
          label: category.label,
          muted: !enabled,
          hint: session && session.usage
            ? '已用 ' + (Number(session.usage[category.id]) || 0) + ' / ' + (Number.isFinite(limit) ? limit : '∞')
              + (Number.isFinite(left) ? ' · 余 ' + left : '') + (low ? ' · 即将耗尽' : '')
            : null,
        }, h(Switch, {
          on: Boolean(settings.categories && settings.categories[category.id]),
          disabled: busy || !enabled,
          onClick: () => void mutate('/settings', {
            patch: { categories: { [category.id]: !(settings.categories && settings.categories[category.id]) } },
          }),
        }))
      })

      const quotaInputs = categories.map((category) => h('div', {
        key: category.id,
        style: { display: 'flex', alignItems: 'center', gap: '6px', marginTop: '4px', opacity: enabled ? 1 : 0.45 },
      },
      h('span', { style: { ...S.hint, width: '84px', flex: '0 0 auto' } }, category.label),
      h('input', {
        type: 'number',
        min: 0,
        disabled: !enabled || busy,
        value: Number.isFinite(Number(settings.quotas && settings.quotas[category.id]))
          ? Number(settings.quotas[category.id])
          : 0,
        onChange: (event) => {
          const value = Number(event.target.value)
          if (Number.isFinite(value)) {
            void mutate('/settings', { patch: { quotas: { [category.id]: Math.max(0, value) } } })
          }
        },
        style: { ...S.input, width: '72px', minHeight: 'unset', padding: '2px 6px', textAlign: 'right' },
      })))

      const quotaAddRow = quotaForm.open
        ? h('div', { style: { display: 'flex', gap: '6px', alignItems: 'center', marginTop: '8px', flexWrap: 'wrap' } },
            h('select', {
              value: quotaForm.category,
              onChange: (event) => setQuotaForm({ ...quotaForm, category: event.target.value }),
              style: { ...S.btn, padding: '3px 6px' },
            }, categories.map((category) => h('option', { key: category.id, value: category.id }, category.label))),
            h('input', {
              type: 'number',
              min: 1,
              value: quotaForm.amount,
              onChange: (event) => setQuotaForm({ ...quotaForm, amount: Number(event.target.value) }),
              style: { ...S.input, width: '76px', minHeight: 'unset', padding: '3px 6px', textAlign: 'right' },
            }),
            h('button', {
              style: { ...S.btn, background: C.okBg, borderColor: C.okBorder, color: C.ok },
              disabled: busy || !(quotaForm.amount > 0),
              onClick: () => {
                const key = quotaForm.category
                const base = Number(settings.quotas && settings.quotas[key]) || 0
                void mutate('/settings', { patch: { quotas: { [key]: Math.max(0, base + Number(quotaForm.amount || 0)) } } })
                setQuotaForm({ ...quotaForm, open: false })
              },
            }, '确认补充'),
            h('button', { style: S.btn, onClick: () => setQuotaForm({ ...quotaForm, open: false }) }, '取消'))
        : null

      const quotaActions = h('div', { style: { display: 'flex', gap: '6px', marginTop: '6px', flexWrap: 'wrap' } },
        h('button', {
          style: { ...S.btn, background: C.okBg, borderColor: C.okBorder, color: C.ok },
          disabled: busy,
          onClick: () => setQuotaForm({ ...quotaForm, open: !quotaForm.open }),
        }, '补充配额'),
        h('button', {
          style: S.btn,
          disabled: busy,
          onClick: () => void mutate('/reset-quotas', {}),
        }, '清零重置'))

      const contract = session && session.contract
      const contractBlock = h('div', null,
        h('textarea', {
          value: goal,
          placeholder: '这次任务只允许做什么？例如：只修改 plugins/autoconsent 下的文件，不要动其它目录',
          onChange: (event) => setGoal(event.target.value),
          style: S.input,
        }),
        h('div', { style: { display: 'flex', gap: '6px', marginTop: '6px', flexWrap: 'wrap' } },
          h('button', {
            style: { ...S.btn, background: C.okBg, borderColor: C.okBorder, color: C.ok },
            disabled: busy || !goal.trim(),
            onClick: () => { void mutate('/contract', { goal }); setGoal('') },
          }, '生成契约并启用'),
          h('button', {
            style: S.btn,
            disabled: busy || !contract,
            onClick: () => void mutate('/contract', { clear: true }),
          }, '清除契约'),
          h('span', { style: { ...S.hint, alignSelf: 'center' } },
            contract ? '契约生效中' : (settings.contractEnabled ? '契约开关已开但未绑定目标' : '未启用')),
        ),
        contract
          ? h('div', { style: { marginTop: '6px', padding: '6px 8px', borderRadius: '8px', background: C.card, border: '1px solid ' + C.border } },
              h('div', { style: { fontWeight: 600, marginBottom: '2px' } }, '目标：' + (contract.goal || '').slice(0, 120)),
              (contract.notes || []).map((note, index) => h('div', { key: index, style: S.hint }, '· ' + note)))
          : null)

      const policyRows = h('div', null,
        h(Row, { label: '子 Agent 隔离', hint: '父会话开启放行时，子 Agent 默认仍需人工确认' },
          h('select', {
            value: settings.subagentPolicy || 'isolate',
            onChange: (event) => void mutate('/settings', { patch: { subagentPolicy: event.target.value } }),
            style: { ...S.btn, padding: '3px 6px' },
          },
          h('option', { value: 'isolate' }, '隔离（默认）'),
          h('option', { value: 'inherit' }, '继承父级'),
          h('option', { value: 'deny' }, '禁止自动放行'))),
        h(Row, { label: '在场降权', hint: '你在操作电脑时，Shell / 插件类动作改人工确认' },
          h(Switch, {
            on: Boolean(settings.presenceEnabled),
            onClick: () => void mutate('/settings', { patch: { presenceEnabled: !settings.presenceEnabled } }),
          })),
        h(Row, { label: '自述与动作校验', hint: 'Agent 说只读却要写入时直接拦截' },
          h(Switch, {
            on: Boolean(settings.planCheck),
            onClick: () => void mutate('/settings', { patch: { planCheck: !settings.planCheck } }),
          })),
        h(Row, { label: '每轮重置配额', hint: '每个用户回合结束后把已用额度清零' },
          h(Switch, {
            on: Boolean(settings.resetEachTurn),
            onClick: () => void mutate('/settings', { patch: { resetEachTurn: !settings.resetEachTurn } }),
          })),
        h(Row, { label: '显示探针标记', hint: '右上角 AC PROBE 标识，红色=监听中' },
          h(Switch, {
            on: showProbe,
            onClick: () => void mutate('/settings', { patch: { showProbe: !showProbe } }),
          })))

      const previewRows = (snap && snap.snapshots) || []
      const logRows = (snap && snap.log) || []
      const logAll = (snap && snap.logAll) || logRows

      const panel = open
        ? h('div', { style: S.panel },
            h('div', { style: { display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', gap: '8px' } },
              h('span', { style: S.h1 }, 'AutoConsent'),
              h('span', { style: { display: 'flex', alignItems: 'baseline', gap: '6px' } },
                h('span', { style: S.hint }, 'v' + (snap ? snap.version : '…') + (session ? ' · ' + String(session.id).slice(-6) : '')),
                repoUrl
                  ? h('a', {
                      href: repoUrl + '/releases',
                      target: '_blank',
                      rel: 'noreferrer noopener',
                      title: '打开 GitHub 更新日志',
                      style: { fontSize: '10px', color: C.brand, textDecoration: 'none' },
                    }, '更新日志')
                  : null)),

            priorityStrip,

            h('div', { style: { marginTop: '8px', padding: '8px 10px', borderRadius: '10px', background: C.card, border: '1px solid ' + C.border } },
              toggleRow,
              timerRow,
              h('div', { style: { ...S.hint, marginTop: '4px' } },
                '契约与黑名单始终优先于这个开关；到期后自动回到未开启状态。')),

            h('div', { style: S.h2 }, '角色模板'),
            templateButtons,

            h('div', { style: { display: 'flex', alignItems: 'center', justifyContent: 'space-between' } },
              h('div', { style: S.h2 }, '分组自动放行'),
              enabled ? null : h('span', { style: { ...S.hint, color: C.warn } }, '总开关关闭时分组设置不生效')),
            categoryRows,

            h('div', { style: S.h2 }, '配额（本会话）'),
            quotaInputs,
            quotaActions,
            quotaAddRow,
            h('div', { style: { ...S.hint, marginTop: '6px' } }, '配额仅当前会话有效，新建会话自动重置'),
            h('div', { style: { ...S.hint, marginTop: '2px' } }, '已用尽的分类会自动落到人工审批'),

            h('div', { style: S.h2 }, '任务契约'),
            contractBlock,

            h('div', { style: S.h2 }, '生效规则'),
            policyRows,

            h('div', { style: S.h2 }, '权限沙盘 · 最近变更'),
            previewRows.length === 0
              ? h('div', { style: S.hint }, '本次会话还没有被自动放行的文件改动。')
              : previewRows.map((item) => h('div', {
                  key: item.id,
                  style: {
                    padding: '6px 8px',
                    marginBottom: '6px',
                    borderRadius: '8px',
                    background: C.card,
                    border: '1px solid ' + C.border,
                    opacity: item.rolledBackAt ? 0.55 : 1,
                  },
                },
                h('div', { style: { display: 'flex', justifyContent: 'space-between', gap: '8px' } },
                  h('span', { style: { fontSize: '11px', fontWeight: 600, wordBreak: 'break-all' } }, item.path),
                  h('button', {
                    style: { ...S.btn, padding: '2px 7px', fontSize: '10px' },
                    disabled: Boolean(item.rolledBackAt),
                    onClick: () => void mutate('/rollback', { id: item.id }),
                  }, item.rolledBackAt ? '已回滚' : '回滚')),
                h(DiffView, { diff: item.diff }))),

            h('div', { style: { display: 'flex', alignItems: 'center', justifyContent: 'space-between' } },
              h('div', { style: S.h2 }, '审批日志'),
              h('button', {
                style: { ...S.btn, padding: '2px 8px', fontSize: '10px' },
                onClick: () => setLogOpen(true),
              }, '打开审批日志')),
            logRows.length === 0
              ? h('div', { style: S.hint }, '还没有裁决记录。')
              : logRows.slice(0, 6).map((item, index) => h('div', {
                  key: index,
                  style: { display: 'flex', gap: '6px', padding: '2px 0', alignItems: 'baseline' },
                },
                h('span', { style: { color: actionColor(item.action), fontWeight: 700, flex: '0 0 auto' } }, ACTION_LABEL[item.action] || item.action),
                h('span', { style: { ...S.hint, flex: '1 1 auto', wordBreak: 'break-all' } },
                  (item.tool || '?') + (item.target ? ' · ' + String(item.target).slice(0, 60) : '') + ' — ' + item.reason))),

            h('div', { style: { display: 'flex', gap: '6px', marginTop: '10px', flexWrap: 'wrap' } },
              h('button', { style: S.btn, onClick: exportAudit }, '导出审计证据包'),
              h('button', { style: S.btn, onClick: exportConfig }, '导出配置'),
              h('button', { style: S.btn, onClick: () => fileRef.current && fileRef.current.click() }, '导入配置'),
              h('button', { style: S.btn, onClick: () => void mutate('/clear-log', {}) }, '清空日志'),
              h('button', { style: S.btn, onClick: () => void load() }, busy ? '同步中…' : '立即刷新'),
              h('input', {
                ref: fileRef,
                type: 'file',
                accept: 'application/json',
                style: { display: 'none' },
                onChange: (event) => {
                  const file = event.target.files && event.target.files[0]
                  importConfig(file)
                  if (event.target) event.target.value = ''
                },
              })),

            h('div', { style: { ...S.hint, marginTop: '8px' } },
              '在场状态：' + (snap && snap.presence && snap.presence.present ? '检测到你正在操作电脑' : '未检测到操作')
              + ' · 统计：自动 ' + stats.auto + ' / 人工 ' + stats.manual + ' / 拦截 ' + stats.denied),
            h('div', { style: { ...S.hint, marginTop: '2px' } }, '快捷键 Ctrl+Shift+A 可一键开 / 关自动放行'),
            failure ? h('div', { style: { ...S.hint, color: C.error, marginTop: '4px' } }, '错误：' + failure) : null)
        : null

      const logPanel = logOpen
        ? h('div', { style: S.logPanel },
            h('div', { style: { display: 'flex', alignItems: 'center', justifyContent: 'space-between' } },
              h('span', { style: S.h1 }, '审批日志'),
              h('span', { style: { display: 'flex', gap: '6px', alignItems: 'center' } },
                h('span', { style: S.hint }, '最近 ' + logAll.length + ' 条'),
                h('button', { style: { ...S.btn, padding: '2px 7px', fontSize: '10px' }, onClick: () => setLogOpen(false) }, '收起'))),
            h('div', { style: { ...S.hint, marginTop: '4px' } }, '记录每一次放行 / 拒绝：时间、工具类型、动作摘要、放行原因。'),
            logAll.length === 0
              ? h('div', { style: { ...S.hint, marginTop: '8px' } }, '还没有裁决记录。')
              : h('div', { style: { marginTop: '8px', display: 'flex', flexDirection: 'column', gap: '6px' } },
                  logAll.slice(0, 60).map((item, index) => h('div', {
                    key: index,
                    style: {
                      padding: '6px 8px',
                      borderRadius: '8px',
                      background: item.alert ? C.errorBg : C.card,
                      border: '1px solid ' + (item.alert ? 'rgba(217,63,63,0.4)' : C.border),
                    },
                  },
                  h('div', { style: { display: 'flex', justifyContent: 'space-between', gap: '8px' } },
                    h('span', { style: { color: actionColor(item.action), fontWeight: 700 } },
                      (ACTION_LABEL[item.action] || item.action) + (item.alert ? ' · 告警' : '')),
                    h('span', { style: S.hint }, clockOf(item.at))),
                  h('div', { style: { ...S.hint, color: C.soft, wordBreak: 'break-all' } },
                    (item.tool || '?') + ' · ' + (item.category || 'other') + (item.target ? ' · ' + String(item.target).slice(0, 80) : '')),
                  h('div', { style: { ...S.hint, wordBreak: 'break-all' } }, item.reason)))))
        : null

      const probe = showProbe
        ? h('span', {
            title: PROBE_TITLE,
            style: {
              pointerEvents: 'auto',
              WebkitAppRegion: 'no-drag',
              marginRight: '6px',
              padding: '2px 7px',
              borderRadius: '999px',
              fontSize: '9px',
              fontWeight: 700,
              letterSpacing: '.3px',
              lineHeight: '15px',
              color: '#fff',
              background: enabled ? '#d93f3f' : 'rgba(120,124,136,0.75)',
              border: '1px solid ' + (enabled ? 'rgba(217,63,63,0.75)' : 'rgba(120,124,136,0.6)'),
              boxShadow: '0 4px 14px rgba(0,0,0,0.12)',
              cursor: 'default',
              userSelect: 'none',
            },
          }, 'AC PROBE')
        : null

      return h('div', {
        style: {
          position: 'fixed',
          top: (Number.isFinite(top) ? top : 50) + 'px',
          right: (Number.isFinite(right) ? right : 14) + 'px',
          zIndex: 70,
          pointerEvents: 'none',
          fontFamily: 'inherit',
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'flex-end',
        },
      },
      h('div', { style: { display: 'flex', alignItems: 'center', justifyContent: 'flex-end' } },
        probe,
        h('button', {
          type: 'button',
          onClick: () => setOpen((value) => !value),
          'aria-expanded': open,
          title: enabled ? 'AutoConsent 已开启，点开配置' : 'AutoConsent，点开配置',
          style: {
            pointerEvents: 'auto',
            WebkitAppRegion: 'no-drag',
            display: 'flex',
            alignItems: 'center',
            gap: '8px',
            padding: '6px 11px 6px 9px',
            borderRadius: '999px',
            border: pillStyle.border,
            background: pillStyle.background,
            color: pillStyle.color,
            boxShadow: '0 6px 20px rgba(0,0,0,0.14)',
            backdropFilter: 'blur(8px)',
            cursor: 'pointer',
            font: 'inherit',
            fontSize: '12px',
            fontWeight: 600,
            lineHeight: '18px',
            whiteSpace: 'nowrap',
            userSelect: 'none',
          },
        },
        h(Switch, { on: enabled, onClick: (event) => { event.stopPropagation(); toggle(!enabled) } }),
        h('span', { style: { display: 'flex', flexDirection: 'column', alignItems: 'flex-start' } },
          h('span', null, pillLabel),
          h('span', {
            style: {
              fontSize: '10px',
              lineHeight: '13px',
              fontWeight: 500,
              color: failure ? C.error : tone === 'ok' ? C.ok : tone === 'warn' ? C.warn : C.soft,
              opacity: 0.92,
            },
          }, pillDetail)),
        h('span', { style: { fontSize: '10px', color: C.faint } }, open ? '▴' : '▾'))),

      panel,
      logPanel)
    }

    return {
      inject: ['slots'],
      apply (ctx) {
        ctx.slots.inject('shell.overlay', () => ctx.slots.register({
          name: 'shell.overlay',
          id: 'auto-consent',
          order: 130,
          label: () => 'AutoConsent',
        }, AutoConsent))
      },
    }
  },
})
