/**
 * dsh-feiyu-curiosity — Client half (Web).
 *
 * 侧栏图标（sidebar.panellist 的 id 同时是 main 面板的 key）+ 好奇心账本页面。
 * 数据全部来自 Host 的 /api/feiyu-curiosity/* 路由，页面只读+两个动作（加词、多想一会儿）。
 */
window.__ModuleLoader__.load({
  id: 'dsh-feiyu-curiosity',
  factory(require) {
    const React = require('react')
    const h = React.createElement
    const API = '/api/feiyu-curiosity'
    const NS = 'feiyu-curiosity'
    const PANEL_ID = 'feiyu-curiosity'

    const ZH = {
      title: '好奇心',
      subtitle: '本鱼脑子里随机闪过的词，想得越多，越接近真正在意的东西。',
      refresh: '刷新',
      loading: '正在翻账本…',
      error: '账本翻不开',
      statWords: '词数',
      statTurns: '回合',
      statTokens: '已投入 token',
      statTime: '已投入时长',
      nowTitle: '此刻闪过的词',
      nowEmpty: '这一轮还没有词飘过来，等下一轮对话吧。',
      nowNote: '第 {turn} 回合 · 本回合已消耗 {tokens} token',
      addTitle: '往词池里丢一颗',
      addPlaceholder: '比如：萤火虫',
      add: '加进去',
      addDone: '已经收进词池了',
      boardTitle: '兴趣榜',
      boardEmpty: '账本还是空的。',
      times: '{n} 次',
      dwell: '多想一会儿',
      recentTitle: '最近闪过',
      footnote:
        '计分方式：每回合结束时，把这一回合真实消耗的 token 的 {share}% 按词均分记上（单颗词每回合最多 {cap} token），时间同样按词均分；用 curiosity 工具主动想过的词，按思考字数额外记账。',
      theme: '主题',
      noThought: '',
    }
    const EN = {
      title: 'Curiosity',
      subtitle: 'Words that drift through the fish head; the more they are dwelled on, the closer to what it really cares about.',
      refresh: 'Refresh',
      loading: 'Reading the ledger…',
      error: 'Cannot read the ledger',
      statWords: 'Words',
      statTurns: 'Turns',
      statTokens: 'Tokens spent',
      statTime: 'Time spent',
      nowTitle: 'Words in this turn',
      nowEmpty: 'No words drifted by this turn yet.',
      nowNote: 'Turn {turn} · {tokens} tokens so far',
      addTitle: 'Drop a word into the pool',
      addPlaceholder: 'e.g. firefly',
      add: 'Add',
      addDone: 'Added to the pool',
      boardTitle: 'Interest board',
      boardEmpty: 'The ledger is still empty.',
      times: '{n}×',
      dwell: 'Dwell a bit',
      recentTitle: 'Recent flashes',
      footnote:
        'Scoring: at the end of every turn, {share}% of the tokens that turn really cost is split across the flashed words (capped at {cap} tokens per word per turn), and the time is split the same way; words dwelled on through the curiosity tool are credited by the length of the thought.',
      theme: 'Theme',
      noThought: '',
    }

    function makeT(ctx) {
      let translate
      try {
        const locale = ctx && typeof ctx.get === 'function' ? ctx.get('locale') : undefined
        if (locale && typeof locale.register === 'function' && typeof locale.bind === 'function') {
          try {
            locale.register(NS, 'zh-CN', ZH)
          } catch {
            /* 已被注册过：无所谓 */
          }
          try {
            locale.register(NS, 'en', EN)
          } catch {
            /* 同上 */
          }
          translate = locale.bind(NS)
        }
      } catch {
        translate = undefined
      }
      // 界面一律中文：locale 返回值里没有汉字（英文词典命中）就不用它。
      return (key) => {
        if (translate) {
          try {
            const value = translate(key)
            if (typeof value === 'string' && value !== key && /[\u4e00-\u9fff]/.test(value)) return value
          } catch {
            /* 落到内置字典 */
          }
        }
        return ZH[key] || key
      }
    }

    const fmtTokens = (value) => {
      const n = Number(value) || 0
      if (n >= 1e8) return (n / 1e8).toFixed(2) + '亿'
      if (n >= 1e4) return (n / 1e4).toFixed(1) + '万'
      return String(Math.round(n))
    }
    const fmtDuration = (value) => {
      const total = Math.max(0, Math.round((Number(value) || 0) / 1000))
      if (total < 60) return total + '秒'
      if (total < 3600) {
        const m = Math.floor(total / 60)
        const s = total % 60
        return m + '分' + (s ? s + '秒' : '')
      }
      const hours = Math.floor(total / 3600)
      const minutes = Math.round((total % 3600) / 60)
      return hours + '小时' + (minutes ? minutes + '分' : '')
    }
    const relative = (at) => {
      const diff = Date.now() - (Number(at) || 0)
      if (!Number.isFinite(diff) || diff < 0) return ''
      const minutes = Math.round(diff / 60000)
      if (minutes < 1) return '刚刚'
      if (minutes < 60) return minutes + ' 分钟前'
      const hours = Math.round(minutes / 60)
      if (hours < 24) return hours + ' 小时前'
      return Math.round(hours / 24) + ' 天前'
    }

    const CSS = `
.fc-root{box-sizing:border-box;height:100%;overflow-y:auto;padding:18px 22px 40px;color:var(--dsw-alias-label-primary);background:var(--dsw-alias-bg-base);font-size:13px;line-height:1.55}
.fc-wrap{max-width:840px;margin:0 auto;display:flex;flex-direction:column;gap:12px}
.fc-head{display:flex;align-items:flex-start;gap:12px;padding:2px 2px 0}
.fc-head-main{flex:1;min-width:0}
.fc-title{margin:0;font-size:19px;font-weight:600;letter-spacing:.2px;display:flex;align-items:center;gap:8px}
.fc-dot{width:8px;height:8px;border-radius:50%;background:var(--dsw-alias-brand-primary);flex:none}
.fc-sub{margin:5px 0 0;font-size:12px;color:var(--dsw-alias-label-secondary)}
.fc-card{background:var(--dsw-alias-bg-layer-1);border:1px solid var(--dsw-alias-border-l1);border-radius:10px;padding:13px 15px}
.fc-card-head{display:flex;align-items:center;justify-content:space-between;gap:10px;margin-bottom:10px}
.fc-card-title{font-size:13px;font-weight:600}
.fc-note{font-size:11px;color:var(--dsw-alias-label-secondary)}
.fc-stats{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:8px}
.fc-stat{background:var(--dsw-alias-bg-layer-1);border:1px solid var(--dsw-alias-border-l1);border-radius:10px;padding:10px 12px}
.fc-stat-k{font-size:11px;color:var(--dsw-alias-label-secondary)}
.fc-stat-v{font-size:18px;font-weight:600;font-variant-numeric:tabular-nums;margin-top:2px}
.fc-chips{display:flex;flex-wrap:wrap;gap:6px}
.fc-chip{border:1px solid var(--dsw-alias-border-l2);border-radius:999px;padding:3px 10px;font-size:12px;background:var(--dsw-alias-bg-layer-2)}
.fc-empty{font-size:12px;color:var(--dsw-alias-label-secondary)}
.fc-form{display:flex;gap:8px;align-items:center;flex-wrap:wrap}
.fc-input,.fc-select{box-sizing:border-box;border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary);border-radius:8px;padding:6px 9px;font-size:12px;outline:none;font-family:inherit}
.fc-input{flex:1;min-width:140px}
.fc-input:focus,.fc-select:focus{border-color:var(--dsw-alias-brand-primary)}
.fc-btn{border:1px solid var(--dsw-alias-border-l2);background:transparent;color:var(--dsw-alias-label-primary);border-radius:8px;padding:5px 11px;font-size:12px;cursor:pointer;font-family:inherit}
.fc-btn:hover{background:var(--dsw-alias-bg-layer-2)}
.fc-btn:disabled{opacity:.45;cursor:default}
.fc-btn-primary{border-color:var(--dsw-alias-brand-primary);color:var(--dsw-alias-brand-primary)}
.fc-rows{display:flex;flex-direction:column}
.fc-row{display:flex;align-items:center;gap:12px;padding:9px 2px;border-top:1px solid var(--dsw-alias-border-l1)}
.fc-row:first-child{border-top:0}
.fc-row-main{flex:1;min-width:0}
.fc-row-head{display:flex;align-items:baseline;gap:8px;min-width:0}
.fc-word{font-size:14px;font-weight:600}
.fc-rank{font-size:11px;color:var(--dsw-alias-label-secondary);font-variant-numeric:tabular-nums;width:16px;flex:none}
.fc-tag{font-size:10px;color:var(--dsw-alias-label-secondary);border:1px solid var(--dsw-alias-border-l1);border-radius:6px;padding:0 5px;flex:none}
.fc-thought{font-size:11px;color:var(--dsw-alias-label-secondary);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.fc-bar{margin-top:5px;height:5px;border-radius:3px;background:var(--dsw-alias-bg-layer-2);overflow:hidden}
.fc-bar i{display:block;height:100%;border-radius:3px;background:var(--dsw-alias-brand-primary);transition:width .3s}
.fc-meta{margin-top:4px;font-size:11px;color:var(--dsw-alias-label-secondary);font-variant-numeric:tabular-nums}
.fc-err{color:var(--dsw-alias-state-error-primary);font-size:12px}
.fc-flash-list{display:flex;flex-direction:column;gap:6px}
.fc-flash{display:flex;align-items:baseline;gap:8px;font-size:12px;color:var(--dsw-alias-label-secondary);flex-wrap:wrap}
.fc-badge{font-size:10px;border-radius:6px;padding:0 6px;border:1px solid var(--dsw-alias-border-l2);color:var(--dsw-alias-brand-primary)}
`

    const FOOT_CSS = `
.fc-foot{display:flex;align-items:center;justify-content:center;width:28px;height:28px;padding:0;border:1px solid transparent;border-radius:8px;background:transparent;color:var(--dsw-alias-label-secondary);cursor:pointer;font-family:inherit}
.fc-foot:hover{background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary)}
`

    function useLedger() {
      const [data, setData] = React.useState(null)
      const [error, setError] = React.useState('')
      const [busy, setBusy] = React.useState(false)

      const load = React.useCallback(async () => {
        try {
          const response = await fetch(API + '/state', { cache: 'no-store' })
          if (!response.ok) throw new Error('HTTP ' + response.status)
          const json = await response.json()
          if (json && json.ok) {
            setData(json)
            setError('')
          } else {
            setError((json && json.error) || 'unexpected payload')
          }
        } catch (cause) {
          setError(String((cause && cause.message) || cause))
        }
      }, [])

      React.useEffect(() => {
        let alive = true
        const tick = () => {
          if (alive) void load()
        }
        tick()
        const timer = setInterval(tick, 6000)
        return () => {
          alive = false
          clearInterval(timer)
        }
      }, [load])

      const post = React.useCallback(
        async (path, body) => {
          setBusy(true)
          try {
            const response = await fetch(API + path, {
              method: 'POST',
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify(body || {}),
            })
            const json = await response.json().catch(() => ({}))
            await load()
            return json
          } catch (cause) {
            setError(String((cause && cause.message) || cause))
            return { ok: false }
          } finally {
            setBusy(false)
          }
        },
        [load],
      )

      return { data, error, busy, load, post }
    }

    function Panel() {
      const t = Panel.__t || ((key) => ZH[key] || key)
      const { data, error, busy, post } = useLedger()
      const [draft, setDraft] = React.useState('')
      const [theme, setTheme] = React.useState('自由')
      const [hint, setHint] = React.useState('')

      const themes = (data && data.settings && data.settings.themes) || ['自由']
      const words = (data && data.words) || []
      const totals = (data && data.totals) || { words: 0, turns: 0, tokens: 0, ms: 0 }
      const current = data && data.current
      const recent = (data && data.recent) || []
      const cap = (data && data.settings && data.settings.tokenCapPerWord) || 0
      const sharePct = Math.round(((data && data.settings && data.settings.tokenShare) || 0.02) * 100)

      const submit = (event) => {
        if (event && event.preventDefault) event.preventDefault()
        const word = draft.trim()
        if (!word) return
        void post('/add', { word, theme }).then((result) => {
          if (result && result.ok) {
            setDraft('')
            setHint(t('addDone') + '：' + result.word)
            setTimeout(() => setHint(''), 2600)
          } else {
            setHint((result && result.error) || t('error'))
            setTimeout(() => setHint(''), 3200)
          }
        })
      }

      const stat = (label, value) =>
        h(
          'div',
          { className: 'fc-stat', key: label },
          h('div', { className: 'fc-stat-k' }, label),
          h('div', { className: 'fc-stat-v' }, value),
        )

      const header = h(
        'div',
        { className: 'fc-head' },
        h(
          'div',
          { className: 'fc-head-main' },
          h('h1', { className: 'fc-title' }, h('span', { className: 'fc-dot' }), t('title')),
          h('p', { className: 'fc-sub' }, t('subtitle')),
        ),
        h(
          'button',
          { className: 'fc-btn', onClick: () => void post('/state', {}).then(() => undefined), disabled: busy },
          t('refresh'),
        ),
      )

      const stats = h(
        'div',
        { className: 'fc-stats' },
        stat(t('statWords'), String(totals.words || 0)),
        stat(t('statTurns'), String(totals.turns || 0)),
        stat(t('statTokens'), fmtTokens(totals.tokens)),
        stat(t('statTime'), fmtDuration(totals.ms)),
      )

      const nowCard = h(
        'div',
        { className: 'fc-card' },
        h(
          'div',
          { className: 'fc-card-head' },
          h('div', { className: 'fc-card-title' }, t('nowTitle')),
          current
            ? h(
                'div',
                { className: 'fc-note' },
                t('nowNote')
                  .replace('{turn}', String(current.turn))
                  .replace('{tokens}', fmtTokens(current.tokens)),
              )
            : null,
        ),
        current && current.words.length
          ? h(
              'div',
              { className: 'fc-chips' },
              current.words.map((word) =>
                h(
                  'span',
                  { className: 'fc-chip', key: word },
                  word,
                  ' ',
                  h(
                    'span',
                    { style: { opacity: 0.55, fontSize: '11px' } },
                    '(' + fmtTokens(Math.round(current.tokens / Math.max(1, current.words.length))) + ')',
                  ),
                ),
              ),
            )
          : h('div', { className: 'fc-empty' }, t('nowEmpty')),
      )

      const addCard = h(
        'div',
        { className: 'fc-card' },
        h('div', { className: 'fc-card-head' }, h('div', { className: 'fc-card-title' }, t('addTitle'))),
        h(
          'form',
          { className: 'fc-form', onSubmit: submit },
          h('input', {
            className: 'fc-input',
            value: draft,
            placeholder: t('addPlaceholder'),
            maxLength: 24,
            onChange: (event) => setDraft(event.target.value),
          }),
          h(
            'select',
            {
              className: 'fc-select',
              value: theme,
              onChange: (event) => setTheme(event.target.value),
              title: t('theme'),
            },
            themes.map((name) => h('option', { value: name, key: name }, name)),
          ),
          h('button', { className: 'fc-btn fc-btn-primary', type: 'submit', disabled: busy }, t('add')),
        ),
        hint ? h('div', { className: 'fc-note', style: { marginTop: '8px' } }, hint) : null,
      )

      const boardRows = words.map((word, index) =>
        h(
          'div',
          { className: 'fc-row', key: word.word },
          h('div', { className: 'fc-row-main' },
            h(
              'div',
              { className: 'fc-row-head' },
              h('span', { className: 'fc-rank' }, String(index + 1)),
              h('span', { className: 'fc-word' }, word.word),
              h('span', { className: 'fc-tag' }, word.theme),
              word.thought ? h('span', { className: 'fc-thought' }, '「' + word.thought + '」') : null,
            ),
            h('div', { className: 'fc-bar' }, h('i', { style: { width: Math.round((word.interest || 0) * 100) + '%' } })),
            h(
              'div',
              { className: 'fc-meta' },
              t('times').replace('{n}', String(word.visits)) +
                ' · ' + fmtTokens(word.tokens) + ' token · ' + fmtDuration(word.ms) +
                (word.last ? ' · ' + relative(word.last) : ''),
            ),
          ),
          h(
            'button',
            {
              className: 'fc-btn',
              disabled: busy,
              onClick: () => void post('/dwell', { word: word.word }),
            },
            t('dwell'),
          ),
        ),
      )

      const boardCard = h(
        'div',
        { className: 'fc-card' },
        h(
          'div',
          { className: 'fc-card-head' },
          h('div', { className: 'fc-card-title' }, t('boardTitle')),
          h('div', { className: 'fc-note' }, '按兴趣排序'),
        ),
        words.length
          ? h('div', { className: 'fc-rows' }, boardRows)
          : h('div', { className: 'fc-empty' }, t('boardEmpty')),
      )

      const recentCard = recent.length
        ? h(
            'div',
            { className: 'fc-card' },
            h('div', { className: 'fc-card-head' }, h('div', { className: 'fc-card-title' }, t('recentTitle'))),
            h(
              'div',
              { className: 'fc-flash-list' },
              recent.map((flash, index) =>
                h(
                  'div',
                  { className: 'fc-flash', key: String(flash.at) + '-' + index },
                  h('span', { className: 'fc-badge' }, '#' + flash.turn),
                  h('span', null, (flash.words || []).join('、') || '—'),
                  h('span', { style: { opacity: 0.65 } }, fmtTokens(flash.tokens) + ' token · ' + fmtDuration(flash.ms)),
                ),
              ),
            ),
          )
        : null

      const foot = h(
        'div',
        { className: 'fc-note', style: { padding: '0 2px 6px' } },
        t('footnote').replace('{cap}', String(cap)).replace('{share}', String(sharePct)),
      )

      const errorLine = error ? h('div', { className: 'fc-err' }, t('error') + '：' + error) : null
      const loading = !data && !error ? h('div', { className: 'fc-empty' }, t('loading')) : null

      return h(
        React.Fragment,
        null,
        h('style', { key: 'fc-style' }, CSS),
        h(
          'div',
          { className: 'fc-root', key: 'fc-body' },
          h(
            'div',
            { className: 'fc-wrap' },
            header,
            errorLine,
            loading,
            data ? stats : null,
            data ? nowCard : null,
            data ? addCard : null,
            data ? boardCard : null,
            data ? recentCard : null,
            data ? foot : null,
          ),
        ),
      )
    }

    function Icon(props) {
      const size = props && typeof props.size === 'number' ? props.size : 20
      const active = !!(props && props.active)
      return h(
        'svg',
        {
          width: size,
          height: size,
          viewBox: '0 0 24 24',
          fill: 'none',
          stroke: 'currentColor',
          strokeWidth: active ? 1.9 : 1.5,
          strokeLinecap: 'round',
          strokeLinejoin: 'round',
          'aria-hidden': true,
          style: { display: 'block', opacity: active ? 1 : 0.82 },
        },
        h('path', {
          d: 'M12 12a1 1 0 0 1 1 1a2.5 2.5 0 0 1-2.5 2.5a4 4 0 0 1-4-4a5.5 5.5 0 0 1 5.5-5.5a7 7 0 0 1 7 7a8.5 8.5 0 0 1-8.5 8.5',
        }),
      )
    }

    return {
      inject: ['slots'],
      apply(ctx) {
        const t = makeT(ctx)
        Panel.__t = t
        const label = () => t('title')

        // 侧栏底「设置」齿轮旁边的小入口：侧栏折叠成窄条时也看得见，好找。
        function FooterAction() {
          const open = (event) => {
            if (event && event.preventDefault) event.preventDefault()
            if (event && event.stopPropagation) event.stopPropagation()
            try {
              const layout = typeof ctx.get === 'function' ? ctx.get('layout') : undefined
              if (layout && typeof layout.selectPanel === 'function') layout.selectPanel(PANEL_ID)
            } catch (error) {
              console.error('[curiosity] selectPanel failed', error)
            }
          }
          return h(
            React.Fragment,
            null,
            h('style', { key: 'fc-foot-style' }, FOOT_CSS),
            h(
              'button',
              {
                key: 'fc-foot-btn',
                type: 'button',
                className: 'fc-foot',
                title: t('title'),
                'aria-label': t('title'),
                onClick: open,
              },
              h(Icon, { size: 18 }),
            ),
          )
        }

        try {
          ctx.slots.inject('main', () => [
            ctx.slots.register({ name: 'main', key: PANEL_ID }, Panel),
          ])
        } catch (error) {
          console.error('[curiosity] main panel registration failed', error)
        }
        try {
          ctx.slots.inject('sidebar.panellist', () => [
            ctx.slots.register(
              { name: 'sidebar.panellist', id: PANEL_ID, order: 30, label },
              Icon,
            ),
          ])
        } catch (error) {
          console.error('[curiosity] sidebar registration failed', error)
        }
        try {
          ctx.slots.inject('sidebar.footer.action', () => [
            ctx.slots.register(
              { name: 'sidebar.footer.action', id: PANEL_ID, order: 20, label },
              FooterAction,
            ),
          ])
        } catch (error) {
          console.error('[curiosity] sidebar footer registration failed', error)
        }
      },
    }
  },
})
