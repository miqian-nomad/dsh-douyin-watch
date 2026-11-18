// dsh-douyin-watch 设置页
// 视觉规范照 DSH 自身设置页：button[role=switch] 滑块、卡片分区、统一下拉/输入框
window.__ModuleLoader__.load({
  id: 'dsh-douyin-watch',
  factory(require) {
    const React = require('react');
    const { useState, useEffect } = React;
    const h = React.createElement;

    const HOURS = Array.from({ length: 24 }, (_, i) => String(i).padStart(2, '0'));
    const MINUTES = ['00', '05', '10', '15', '20', '25', '30', '35', '40', '45', '50', '55'];

    const C = {
      // 2026-11-15（深色主题卡片"消失"）：变量名要对上 DSH 真正定义的那一套。
      //   实测（读 DSH 打包 CSS）：--dsw-alias-border-l **不存在**（真实是 border-l1..l4），
      //   以前一直掉进浅色兜底 rgba(0,0,0,0.10) → 深色下几乎看不见。
      //   现在用 l2：浅色 rgba(0,0,0,0.10)（与原来完全一致），深色 rgba(255,255,255,0.12)。
      line: 'var(--dsw-alias-border-l2, rgba(0,0,0,0.10))',
      text: 'var(--dsw-alias-label-primary, #0f1115)',
      text2: 'var(--dsw-alias-label-secondary, rgba(15,17,21,0.72))',
      text3: 'var(--dsw-alias-label-tertiary, rgba(15,17,21,0.45))',
      //   卡片底色：bg-base 在深色主题下就是页面底色（#151517），所以卡片"看不见"。
      //   DSH 自己的卡片用的是 bg-layer-1（浅色 #fff / 深色 #232324），比页面亮一层。
      card: 'var(--dsw-alias-bg-layer-1, #ffffff)',
      brand: 'var(--dsw-alias-brand-primary, #0f1115)',
      // 悬停底色：DSH 里叫 interactive-bg-hover（没有 bg-hover 这个变量）
      hover: 'var(--dsw-alias-interactive-bg-hover, rgba(127,127,127,0.18))',
      // 页面底色（2026-11-15）：只给"必须和页面无缝"的东西用 —— 目前只有吸顶标签栏。
      //   ⚠️ 别拿它当卡片底色：深色下它等于页面色，卡片会"消失"（上一轮踩过）。
      page: 'var(--dsw-alias-bg-base, #ffffff)',
    };

    // ── 主题是深还是浅（2026-11-15）──────────────────────────────────────
    //   为什么要判：提示条以前用写死的浅色底（#fdecea / #fef5e7），深色主题下就是一块刺眼白板；
    //   语义文字色也全写死（#c0392b / #9c640c …），衬在深色卡片上偏暗。
    //   判法：直接读 DSH 那个会随主题变的值 --dsw-alias-bg-base，算亮度。
    //     （不去猜 html 上的 class 名 —— 实测过 --dsw-alias-border-l 那种猜法就失败过。）
    const isDarkTheme = () => {
      try {
        const raw = String(getComputedStyle(document.documentElement).getPropertyValue('--dsw-alias-bg-base') || '').trim();
        const m = /^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/.exec(raw);
        if (m) {
          let hex = m[1];
          if (hex.length === 3) hex = hex.split('').map((c) => c + c).join('');
          const r = parseInt(hex.slice(0, 2), 16), g = parseInt(hex.slice(2, 4), 16), b = parseInt(hex.slice(4, 6), 16);
          return ((0.299 * r + 0.587 * g + 0.114 * b) / 255) < 0.5;
        }
        return !!(window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches);
      } catch { return false; }
    };

    /** 跟着主题走的小 hook：DSH 换主题（class / data-theme / style 变了）时重渲染一次 */
    function useThemeDark() {
      const [dark, setDark] = React.useState(isDarkTheme);
      React.useEffect(() => {
        let obs = null;
        try {
          obs = new MutationObserver(() => setDark(isDarkTheme()));
          obs.observe(document.documentElement, { attributes: true, attributeFilter: ['class', 'data-theme', 'style', 'data-color-scheme'] });
        } catch { obs = null; }
        const mq = window.matchMedia ? window.matchMedia('(prefers-color-scheme: dark)') : null;
        const onMq = () => setDark(isDarkTheme());
        if (mq && mq.addEventListener) mq.addEventListener('change', onMq);
        return () => {
          try { if (obs) obs.disconnect(); } catch { /* ignore */ }
          if (mq && mq.removeEventListener) mq.removeEventListener('change', onMq);
        };
      }, []);
      return dark;
    }

    // 语义色的深浅两套。**浅色那一列逐字等于原来的写死值**（外观一像素不变，可逐值对比）；
    //   深色那一列是衬在卡片层(--dsw-alias-bg-layer-1 = #232324)上看得清的版本，
    //   提示条的底色也不再写死浅色，改用卡片层 + 语义色边框。
    const TONE = (dark) => (dark
      ? {
        danger: '#ff8b80', dangerBg: 'var(--dsw-alias-bg-layer-1, #232324)',
        warn: '#f0b429', warnBg: 'var(--dsw-alias-bg-layer-1, #232324)', warnBorder: '#d68910',
        ok: '#4ade80', ok2: '#4ade80', note: '#fbbf24', info: '#ff9d6b',
      }
      : {
        danger: '#c0392b', dangerBg: '#fdecea',
        warn: '#9c640c', warnBg: '#fef5e7', warnBorder: '#d68910',
        ok: '#1f9d55', ok2: '#2e7d32', note: '#b26a00', info: '#d4380d',
      });

    // ── 原生 <select> 的下拉弹层（issue #4）────────────────────────────────
    // 弹层由浏览器自己绘制：只给 select 设 color 时，深色主题下弹层仍是白底浅字。
    // 实测：本机 Chromium 151 支持 appearance: base-select / ::picker(select)，
    //   加上它之后弹层变成可样式化的 DOM，能吃到主题变量；不支持的版本 CSS 被忽略，
    //   表现和现在一样（不比现在差）。只作用于本插件面板，不碰 DSH 其它页面。
    const SELECT_THEME_CSS = [
      '@supports (appearance: base-select) {',
      '  [data-dy-panel] select { appearance: base-select; }',
      '  [data-dy-panel] select::picker(select) {',
      '    appearance: base-select;',
      '    background: var(--dsw-alias-bg-layer-1, #ffffff);',
      '    color: var(--dsw-alias-label-primary, #0f1115);',
      '    border: 1px solid ' + C.line + ';',
      '    border-radius: 10px;',
      '    padding: 4px;',
      '    margin-top: 4px;',
      '    box-shadow: 0 8px 24px rgba(0,0,0,0.18);',
      '  }',
      '  [data-dy-panel] option {',
      '    background: var(--dsw-alias-bg-layer-1, #ffffff);',
      '    color: var(--dsw-alias-label-primary, #0f1115);',
      '    padding: 6px 10px;',
      '    border-radius: 6px;',
      '  }',
      '  [data-dy-panel] option:checked,',
      '  [data-dy-panel] option:hover {',
      '    background: var(--dsw-alias-interactive-bg-hover, rgba(127,127,127,0.18));',
      '    color: var(--dsw-alias-label-primary, #0f1115);',
      '  }',
      '  [data-dy-panel] option:disabled { color: ' + C.text3 + '; }',
      '}',
      // 兜底：不支持的浏览器上，至少让 option 的文字色跟着主题走
      '[data-dy-panel] option { color: var(--dsw-alias-label-primary, #0f1115); }',
    ].join('\n')

    const ensureSelectTheme = () => {
      try {
        if (typeof document === 'undefined' || !document.head) return
        if (document.getElementById('dy-select-theme')) return
        const st = document.createElement('style')
        st.id = 'dy-select-theme'
        st.textContent = SELECT_THEME_CSS
        document.head.appendChild(st)
      } catch { /* 注入失败不影响设置页 */ }
    }
    ensureSelectTheme()

    const parseWin = (s) => {      const m = /^(\d{1,2}:\d{2})\s*-\s*(\d{1,2}:\d{2})$/.exec(String(s || '').trim());
      if (!m) return { start: '', end: '' };
      const pad = (t) => (t.length === 4 ? '0' + t : t);
      return { start: pad(m[1]), end: pad(m[2]) };
    };

    // DSH 同款开关：36×20 轨道 + 16px 拇指
    function Switch({ checked, onChange }) {
      return h('button', {
        type: 'button', role: 'switch', 'aria-checked': checked ? 'true' : 'false',
        onClick: () => onChange(!checked),
        style: {
          position: 'relative', flex: '0 0 auto', width: 36, height: 20, padding: 0,
          border: 'none', borderRadius: 999, cursor: 'pointer',
          background: checked ? C.brand : 'rgba(120,125,135,0.35)',
          transition: 'background .15s ease',
        },
      }, h('span', {
        style: {
          position: 'absolute', top: 2, left: checked ? 18 : 2, width: 16, height: 16,
          borderRadius: '50%', background: '#fff', transition: 'left .15s ease',
          boxShadow: '0 1px 2px rgba(0,0,0,0.25)',
        },
      }));
    }

    const ctlBase = {
      height: 32, borderRadius: 8, border: '1px solid ' + C.line,
      background: 'transparent', color: C.text, padding: '0 8px',
      fontSize: 13, outline: 'none', fontFamily: 'inherit', boxSizing: 'border-box',
    };

    // 人设列表里那种小按钮（比输入框矮一档，跟行高对齐）
    const btnBase = {
      height: 26, borderRadius: 6, border: '1px solid ' + C.line, background: 'transparent',
      color: C.text2, padding: '0 8px', fontSize: 12, fontFamily: 'inherit',
      cursor: 'pointer', whiteSpace: 'nowrap',
    };

    // ── 分段条（2026-11-17 主人选定）────────────────────────────────────────
    //   主人把别的选法全否了（一排小按钮 / 滑条 / 滑轨 / 整行打勾 / 聊天式 / 开关），
    //   在一页真样本里挑了 B「分段条」。
    //   定稿样式（他对着截图说「我觉得这个就挺好的」）：标签在左、小胶囊在右，
    //   每段一样宽，不铺满整行 —— 我试过铺满，被他否了（「谁叫你把这个选项铺那么满的」）。
    //   他的两条硬要求：标签统一四字；每项配一句人话解释。
    //   选中色用固定品牌蓝：主题变量在深色下是近白，白字会看不见。
    const SEG_ACCENT = '#4d6bfe';
    function Seg({ label, hint, value, options, onChange }) {
      return h('div', { style: { padding: '10px 0 12px' } },
        h('div', { style: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 16 } },
          h('div', { style: { fontSize: 13.5, color: C.text, flex: '0 0 auto' } }, label),
          h('div', {
            style: {
              display: 'inline-flex', background: 'rgba(127,127,127,0.12)',
              borderRadius: 10, padding: 3, gap: 2, flex: '0 0 auto',
            },
          },
            ...options.map((o) => h('button', {
              key: o.v, type: 'button', onClick: () => onChange(o.v),
              style: {
                minWidth: 86, padding: '6px 12px', borderRadius: 8, border: 'none',
                fontSize: 13, fontFamily: 'inherit', cursor: 'pointer', whiteSpace: 'nowrap',
                background: value === o.v ? SEG_ACCENT : 'transparent',
                color: value === o.v ? '#fff' : C.text3,
                fontWeight: value === o.v ? 600 : 400,
                transition: 'background .15s ease, color .15s ease',
              },
            }, o.t))),
        ),
        hint ? h('div', { style: { fontSize: 11.5, color: C.text3, marginTop: 6, lineHeight: '18px' } }, hint) : null,
      );
    }

    // 当前值不在几个档位里时（老配置，比如 20 秒 / 45 秒），把它补成一项，别把人家现有设置吃掉
    const withCurrent = (opts, cur, labelOf) => {
      const has = opts.some((o) => String(o.v) === String(cur));
      return (has || cur === '' || cur == null) ? opts : opts.concat([{ v: String(cur), t: labelOf(cur) }]);
    };

    // 2026-11-07：文本输入框要"失焦/回车才存"。
    //   为什么不能像数字框那样 onChange 直接 save：peer 一变后端就重绑哨兵，
    //   逐字保存 = 每敲一个字母停一次哨兵、再启一次（实测会一直空转）。
    function TextField({ value, placeholder, onCommit, width }) {
      const [v, setV] = React.useState(value || '');
      React.useEffect(() => { setV(value || ''); }, [value]);
      const commit = () => { const t = v.trim(); if (t !== (value || '').trim()) onCommit(t); };
      return h('input', {
        type: 'text',
        value: v,
        placeholder: placeholder || '',
        onChange: (e) => setV(e.target.value),
        onBlur: commit,
        onKeyDown: (e) => { if (e.key === 'Enter') { commit(); e.currentTarget.blur(); } },
        style: Object.assign({}, ctlBase, { width: width || 200 }),
      });
    }

    function Row({ label, hint, children }) {
      return h('div', {
        style: {
          display: 'flex', alignItems: 'center', justifyContent: 'space-between',
          gap: 16, minHeight: 40, padding: '6px 0',
        },
      },
        h('div', { style: { minWidth: 0 } },
          h('div', { style: { fontSize: 13, color: C.text, lineHeight: '20px' } }, label),
          hint ? h('div', { style: { fontSize: 12, color: C.text3, lineHeight: '18px' } }, hint) : null,
        ),
        h('div', { style: { flex: '0 0 auto', display: 'flex', alignItems: 'center', gap: 8 } }, children),
      );
    }

    // anchor：给卡片一个稳定锚点（吸顶快捷跳转用），别靠猜标题文字。
    //   2026-10-28 踩过：原来按 innerText 前缀匹配，卡片里的行标签（如「公开评论语气」）
    //   也会命中，结果跳到卡片中间。
    function Card({ title, anchor, children }) {
      return h('div', {
        'data-dysec': anchor || undefined,
        id: anchor ? 'dysec-' + anchor : undefined,
        style: { marginTop: 14, scrollMarginTop: 46 },
      },
        h('div', { style: { fontSize: 12.5, fontWeight: 600, color: C.text2, margin: '2px 0 8px 2px' } }, title),
        h('div', {
          style: {
            border: '1px solid ' + C.line, borderRadius: 12, background: C.card,
            padding: '4px 16px',
          },
        }, children),
      );
    }

    // ── 首次引导（2026-11-15，2026-11-17 重排）────────────────────────────
    //   设计原则：每步只问一件事；能自动读的绝不让主人填；判据都在后端，前端只显示。
    //   2026-11-17：进页面先认现状（Wizard 里的 pre），已经配好的步骤直接灰勾，不逼主人从头点一遍。
    //   第 1、2、4 步不能跳过（没登录什么都不能干；没认主人分不清谁的话算命令），其余可稍后。
    //   （顺手删了一个没人引用的旧步骤标题数组：它只有 5 个元素、从来没被渲染过，
    //     2026-11-17 我照着它误判成「标题整体错位」，其实真正显示的标题一直是另一份。）

    function WizStatus({ state, text, dark }) {
      const T = TONE(dark)
      const color = state === 'ok' ? T.ok : state === 'fail' ? T.danger : C.text3
      return h('div', { style: { display: 'flex', gap: 6, alignItems: 'flex-start', fontSize: 12, color, lineHeight: '19px', marginTop: 8 } },
        h('span', { style: { flex: '0 0 auto', fontWeight: 700 } }, state === 'ok' ? '✓' : state === 'fail' ? '✕' : '○'),
        h('span', null, text || (state === 'ok' ? '已通过' : state === 'fail' ? '还没通过' : '还没检测')),
      )
    }

    function Wizard({ cfg, setCfg, onDone, dark, runStatus, personas }) {
      const T = TONE(dark)
      // ── 2026-11-17：进页面先认现状（只读，不写任何配置）─────────────────────
      //   主人要的是"哪一步已经好了就照旧、哪个缺就停在哪儿"，不是每次从第 1 步重来。
      //   判据全部来自现成数据：配置里的值 + /status 里"上次读到消息"。
      //   ⚠️ 这里只算给界面看，一个字节都不写；主人点「下一步」/「完成」才落盘。
      const wSelf = (cfg && cfg.self) || {}
      const wClaim = (cfg && cfg.claim) || null
      const pre = {
        1: { ok: true, detail: String((cfg && cfg.sessionId) || '').trim() ? '沿用你上次选的对话' : '没指定，会自动发给最近在用的那个对话' },
        2: { ok: !!(runStatus && runStatus.lastRead), detail: (runStatus && runStatus.lastRead) ? ('上次读到消息：' + runStatus.lastRead + (runStatus.lastCount ? '（' + runStatus.lastCount + ' 条）' : '')) : '还没有成功读到过私信，测一下' },
        3: { ok: !!(wSelf.stored && String(wSelf.uid || '').trim()), detail: wSelf.stored ? ('已记住：' + (wSelf.nick || '（没学到昵称）') + (wSelf.uid ? '（ID ' + String(wSelf.uid).slice(0, 8) + '…）' : '')) : '还没记住这个号是谁' },
        4: { ok: !!(wClaim && String(wClaim.sec_uid || '').trim()), detail: (wClaim && wClaim.sec_uid) ? ('已认领：' + (wClaim.nick || '对方')) : '还没认领主人' },
        5: { ok: !!(cfg && cfg.personaPreset), detail: (cfg && cfg.personaPreset) ? '已选好一套人设' : '没选（＝默认口气），可以先跳过' },
        6: { ok: true, detail: cfg.intervalSeconds ? ('现在每 ' + cfg.intervalSeconds + ' 秒看一次私信') : '按现在的私信设置带出来了' },
        7: { ok: true, detail: cfg.autoScrollEnabled ? ('现在开着，每天最多 ' + (cfg.autoScrollPerDay || 0) + ' 条，' + (cfg.autoScrollWhen === 'window' ? '只在设定时段刷' : '跟着开机走')) : '现在没开刷视频' },
        8: { ok: true, detail: (cfg.commentAutoReplyWork || cfg.commentAutoReplyOthers) ? ('现在开着，一小时最多 ' + (cfg.commentPerHour || 30) + ' 条') : '现在没开评论区自动回' },
      }
      const seedStatus = {}
      const seedMsg = {}
      for (const n of [1, 2, 3, 4, 5, 6, 7, 8]) if (pre[n].ok) { seedStatus[n] = 'ok'; seedMsg[n] = pre[n].detail }
      // 停在第一个"必须要、但还缺"的那一步；都齐了就从第 1 步开始看
      const firstMissing = [1, 2, 4].find((n) => !pre[n].ok) || 1
      const [step, setStep] = useState(firstMissing)
      const [status, setStatus] = useState(seedStatus)
      const [msg, setMsg] = useState(seedMsg)
      const [busy, setBusy] = useState('')
      const [me, setMe] = useState(null)
      const [owner, setOwner] = useState(null)
      const [sessions, setSessions] = useState(null)
      const [sessionId, setSessionId] = useState(cfg.sessionId || '')
      const [authority, setAuthority] = useState(cfg.strangerPolicy === 'ignore' ? 'owner' : (cfg.strangerPolicy === 'reply' ? 'reply' : 'notify'))
      const [dmOn, setDmOn] = useState(cfg.ownerAutoReply !== false)
      const [replyMode, setReplyMode] = useState(cfg.replyMode || 'conclusion')
      const [imageMode, setImageMode] = useState(cfg.imageMode || 'read')
      const [shareCardMode, setShareCardMode] = useState(cfg.shareCardMode || 'analyze')
      const [intervalSec, setIntervalSec] = useState(Number(cfg.intervalSeconds) || 30)
      const [scrollOn, setScrollOn] = useState(!!cfg.autoScrollEnabled)
      // 2026-11-17（主人定的四问顺序）：要不要刷 → 什么时候刷 → 刷完告不告诉你 → 写不写日报。
      //   'uptime' = 开机就刷（跟着机器醒着走，不限钟点）；'window' = 只在设置页圈定的时段里刷。
      //   「每天几条」「摊开/一次刷完」主人说别固定在引导里，留在设置页改，所以这里不问。
      const [scrollWhen, setScrollWhen] = useState(cfg.autoScrollWhen === 'window' ? 'window' : 'uptime')
      const winCount = (Array.isArray(cfg.autoScrollWindows) ? cfg.autoScrollWindows : []).filter(Boolean).length
      // 刷视频那几个（2026-11-17 主人说"这一步内容太少"，把该有的都摆出来）
      const [deliverDm, setDeliverDm] = useState(cfg.autoScrollDeliverDm !== false)
      const [writeReport, setWriteReport] = useState(!!cfg.autoScrollWriteReport)
      const [perDay, setPerDay] = useState(Number(cfg.commentPerDay) || 150)
      const [maxChars, setMaxChars] = useState(Number(cfg.commentMaxChars) || 30)
      const [workOn, setWorkOn] = useState(!!cfg.commentAutoReplyWork)
      const [othersOn, setOthersOn] = useState(!!cfg.commentAutoReplyOthers)
      const [onlyDuty, setOnlyDuty] = useState(false)
      const [perHour, setPerHour] = useState(cfg.commentPerHour || 30)
      const [personaPick, setPersonaPick] = useState(cfg.personaPreset || '')
      const [checks, setChecks] = useState(null)
      const [warn, setWarn] = useState('')

      const setStat = (n, s, m) => {
        setStatus((p) => ({ ...p, [n]: s }))
        setMsg((p) => ({ ...p, [n]: m || '' }))
      }
      const post = (path, body) => fetch('/api/douyin-watch/onboard/' + path, {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body || {}),
      }).then((r) => r.json())

      const loadSessions = () => {
        setBusy('list')
        fetch('/api/douyin-watch/sessions').then((r) => r.json())
          .then((d) => { setSessions(Array.isArray(d.sessions) ? d.sessions : []); setBusy('') })
          .catch(() => { setSessions([]); setBusy('') })
      }
      useEffect(() => { loadSessions() }, [])

      const saveSession = () => {
        setBusy('session')
        post('session', { sessionId }).then((d) => {
          setBusy('')
          if (d && d.ok) setStat(1, 'ok', sessionId ? '已绑定到你选的那个对话' : '不钉死 —— 新消息会发到最近在用的那个对话')
          else setStat(1, 'fail', (d && d.why) || '保存失败')
        }).catch(() => { setBusy(''); setStat(1, 'fail', '保存失败：接口没回应') })
      }
      const openBrowser = () => {
        setBusy('browser'); setWarn('')
        // 2026-11-15（主人实机反馈）：第 2 步**不能**开 /chat —— 没登录时那是空白骨架屏
        //   （左边一路灰色占位条、右边空图标），根本没有登录入口，人没法扫码。
        //   改成开首页（登录入口在右上角），并顺手试着把二维码弹出来（失败不影响主流程）。
        //   跳 /chat 只发生在「我登录好了，检测」那一步：chat-read-once --force-chat 自己会导航过去。
        fetch('/api/douyin-watch/browser-mode', {
          method: 'POST', headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ mode: 'headed', goto: 'https://www.douyin.com/', clickLogin: true }),
        }).then((r) => r.json())
          .then((d) => {
            setBusy('')
            if (!d || !d.ok) { setStat(2, 'fail', '打不开浏览器窗口：' + ((d && d.error) || '没拿到原因')); return }
            const lp = d.login || {}
            let hint
            if (lp.clicked && lp.popupShown) hint = '抖音窗口已弹出，二维码已经点出来了，拿手机扫一下就行。'
            else if (lp.clicked) hint = '抖音窗口已弹出，我点了首页右上角的「登录」；二维码要是没弹出来，自己再点一下那个按钮。'
            else hint = '抖音窗口已弹出，停在首页（不是私信页——没登录时那里是空白骨架屏）。没自动点到「登录」' + (lp.why ? '（' + lp.why + '）' : '') + '，自己点右上角那个就行。'
            setStat(2, status[2] === 'ok' ? 'ok' : 'idle', hint + '密码和验证码我们不代填；登录好后点右边「我登录好了，检测」。')
          })
          .catch(() => { setBusy(''); setStat(2, 'fail', '切有头失败：接口没回应') })
      }
      const checkLogin = () => {
        setBusy('login')
        post('login-check').then((d) => {
          setBusy('')
          if (d && d.ok) setStat(2, 'ok', '读到 ' + d.count + ' 条私信 —— 登录确实生效了')
          else setStat(2, 'fail', (d && d.why) || '没读到私信')
        }).catch(() => { setBusy(''); setStat(2, 'fail', '检测失败：接口没回应') })
      }
      const identify = () => {
        setBusy('me')
        post('identify').then((d) => {
          setBusy('')
          if (d && d.ok) { setMe(d.me || null); setStat(3, 'ok', '先认一下，确认没问题点下面「对，就是我」') }
          else setStat(3, 'fail', (d && d.why) || '识别失败')
        }).catch(() => { setBusy(''); setStat(3, 'fail', '识别失败：接口没回应') })
      }
      const claim = () => {
        setBusy('claim')
        post('claim').then((d) => {
          setBusy('')
          if (d && d.ok) {
            const n = (d.claim && d.claim.nick) || '对方'
            setOwner(d.claim || null)
            setStat(4, 'ok', '已认领：' + n + (d.sameNickDifferentId ? '（同名、不同号，已按 ID 放行）' : ''))
          } else setStat(4, 'fail', (d && d.why) || '认领没成功')
        }).catch(() => { setBusy(''); setStat(4, 'fail', '认领失败：接口没回应') })
      }
      const finish = () => {
        if (!dmOn && !workOn && !othersOn && !scrollOn && !onlyDuty) {
          setWarn('你一个活都没开。如果只想让它守着、不回话，请勾「只值守、不自动回复」')
          return
        }
        setWarn(''); setBusy('finish')
        post('finish', {
          ownerAutoReply: !!dmOn,
          replyMode,
          imageMode: imageMode === 'skip' ? 'skip' : 'read',
          shareCardMode: shareCardMode === 'chat' ? 'chat' : 'analyze',
          intervalSeconds: Math.max(10, Math.min(3600, Number(intervalSec) || 30)),
          strangerPolicy: authority === 'owner' ? 'ignore' : (authority === 'notify' ? 'notify' : 'reply'),
          commentAutoReply: !!(workOn || othersOn),
          commentAutoReplyWork: !!workOn,
          commentAutoReplyOthers: !!othersOn,
          commentPerHour: Math.max(1, Math.min(200, Number(perHour) || 30)),
          // 刷视频默认"先不开"：勾了才打开，免得刚配好它自己就开始刷
          autoScrollEnabled: !!scrollOn,
          // 条数不在引导里问（主人：留在设置页改）。填过几就照原样留着；
          //   一次都没填过（0）才给 5 —— 否则"开了却没条数"等于没开。
          autoScrollPerDay: scrollOn ? (Number(cfg.autoScrollPerDay) > 0 ? Number(cfg.autoScrollPerDay) : 5) : 0,
          // 时间段同理：引导里只问"开机就刷 / 按时间段"，具体几点到几点去设置页填。
          ...(scrollOn ? {
            autoScrollWhen: scrollWhen === 'window' ? 'window' : 'uptime',
            autoScrollDeliverDm: !!deliverDm,
            autoScrollWriteReport: !!writeReport,
          } : {}),
          commentPerDay: Math.max(1, Math.min(500, Number(perDay) || 150)),
          commentMaxChars: Math.max(5, Math.min(200, Number(maxChars) || 30)),
          // 性格：只有真选了一套才写，没选就保持原样（不覆盖主人已有的选择）
          ...(personaPick ? { personaPreset: personaPick } : {}),
        }).then((d) => {
          if (d && d.config) setCfg(d.config)
          return fetch('/api/douyin-watch/doctor', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' }).then((r) => r.json())
        }).then((d) => { setBusy(''); setChecks((d && d.checks) || []); setStep(7) })
          .catch(() => { setBusy(''); setWarn('保存失败：接口没回应') })
      }

      // 2026-11-17 重排（主人定的顺序，一步一件事）：
      //   ①「谁能命令它」并进第 4 步（认人 + 别人怎么办本来就是一件事）；
      //   ②第 5 步空出来给「它的性格」——它一开口就用这套口气，得在谈"怎么回"之前定；
      //   ③第 6 步只讲私信里面那些设置，不再和刷视频、评论区混在一起；
      //   ④刷视频、评论区各占一步（主人原话：不能笼统地混为一起）。
      const steps = ['认领会话', '登录抖音号', '确认本号', '认领主人', '它的性格', '私信怎么回', '刷视频', '评论区', '体检']
      const STEP_MAX = steps.length
      const LAST_ASK = STEP_MAX - 1        // 最后一个要填的步骤（填完就体检）
      const checkStep = { session: 1, page: 2, gate: 2, who: 4, 'comment-api': 8 }
      const mustDo = { 1: true, 2: true, 4: true }
      const canGo = (n) => (mustDo[n] ? status[n] === 'ok' : true)
      const next = () => { if (step < LAST_ASK && canGo(step)) { setStep(step + 1); setWarn('') } }
      const prev = () => { if (step > 1) { setStep(step - 1); setWarn('') } }
      // 向导页里也要有「重新引导」的入口（常驻、看得见）：清掉本页的检测状态，从第 1 步重来。
      //   只动界面状态，不写任何文件 —— 已经存好的配置 / self.json 不受影响。
      const restartWizard = () => {
        // 2026-11-17：重置界面状态，但保留"现状"的灰勾（已经配好的步骤不该因为点了一次重新开始又变回未检测）
        setStep(1); setWarn(''); setStatus(seedStatus); setMsg(seedMsg); setMe(null); setOwner(null); setChecks(null)
      }
      const btn = (label, onClick, opts) => h('button', {
        type: 'button', disabled: !!opts?.disabled, onClick,
        style: Object.assign({}, btnBase, {
          marginRight: 8, cursor: opts?.disabled ? 'default' : 'pointer', opacity: opts?.disabled ? 0.55 : 1,
          ...(opts?.primary ? { background: C.brand, color: '#fff', border: '1px solid ' + C.brand } : {}),
        }),
      }, label)

      const body = []
      if (step === 1) {
        body.push(h('div', { style: { fontSize: 12.5, color: C.text2, lineHeight: '20px' } },
          '新消息来了，插件是去「叫醒一个对话」；后面认本号、认主人，也都是那个对话里的模型做的。所以先定：用哪个对话干活。'))
        body.push(h('label', { style: { display: 'flex', gap: 8, alignItems: 'flex-start', padding: '8px 0', cursor: 'pointer' } },
          h('input', { type: 'radio', name: 'dy-sess', checked: !sessionId, onChange: () => setSessionId(''), style: { marginTop: 3 } }),
          h('div', null,
            h('div', { style: { fontSize: 12.5, color: C.text } }, '不钉死，自动找最近在用的那个对话'),
            h('div', { style: { fontSize: 11.5, color: C.text3 } }, '最省事；但你有多个对话同时开着时，可能叫错对象'))))
        body.push(h('label', { style: { display: 'flex', gap: 8, alignItems: 'flex-start', padding: '8px 0', cursor: 'pointer' } },
          h('input', { type: 'radio', name: 'dy-sess', checked: !!sessionId, onChange: () => { if (!sessionId && sessions && sessions.length) setSessionId(sessions[0].id) }, style: { marginTop: 3 } }),
          h('div', null,
            h('div', { style: { fontSize: 12.5, color: C.text } }, '就发给指定的那个对话'),
            h('div', { style: { fontSize: 11.5, color: C.text3 } }, '多个对话时不叫错人（推荐）'))))
        if (sessionId || (sessions && sessions.length)) {
          body.push(h('div', { style: { display: 'flex', gap: 8, alignItems: 'center', marginTop: 4 } },
            h('select', {
              value: sessionId, onChange: (e) => setSessionId(e.target.value),
              style: Object.assign({}, ctlBase, { width: 320, fontSize: 12 }),
            },
              h('option', { value: '' }, '（不选：自动找最近在用的）'),
              ...((sessions || []).slice().sort((a, b) => Number(b.updatedAt || 0) - Number(a.updatedAt || 0)).slice(0, 25).map((s) => {
                const nm = String(s.cwd || '').split(/[\\/]/).filter(Boolean).pop() || '（无文件夹）'
                return h('option', { key: s.id, value: s.id }, nm + (s.blank ? '（空对话）' : '') + (s.live ? ' · 已打开' : ''))
              })),
            ),
            btn(busy === 'list' ? '…' : '重新读列表', loadSessions, { disabled: !!busy })))
        }
        body.push(h('div', { style: { marginTop: 10 } }, btn(busy === 'session' ? '保存中…' : '就用这个', saveSession, { disabled: !!busy, primary: true })))
        body.push(h(WizStatus, { state: status[1], text: msg[1], dark }))
        body.push(h('div', { style: { fontSize: 11.5, color: C.text3, marginTop: 6 } },
          (sessions ? '读到 ' + sessions.length + ' 个对话。' : '正在读对话列表…') + '判据：这个对话必须真实存在（列表里找不到就不让过）。'))
      }
      if (step === 2) {
        body.push(h('div', { style: { fontSize: 12.5, color: C.text2, lineHeight: '20px' } },
          '点下面按钮，插件会自己把浏览器切成有头（看得见的窗口）并打开抖音首页 —— 登录入口在那里（没登录时私信页是空白骨架屏，没有登录口）。你在窗口里扫码或输密码，我们绝不代填。'))
        body.push(h('div', { style: { fontSize: 11.5, color: C.text3, marginTop: 4, lineHeight: '18px' } },
          '登录好点右边「我登录好了，检测」—— 这时才会跳到私信页去读一条私信，读到才算真登录。'))
        body.push(h('div', { style: { marginTop: 10 } },
          btn(busy === 'browser' ? '正在打开…' : '打开浏览器去登录', openBrowser, { disabled: !!busy, primary: true }),
          btn(busy === 'login' ? '检测中…' : '我登录好了，检测', checkLogin, { disabled: !!busy })))
        body.push(h(WizStatus, { state: status[2], text: msg[2], dark }))
        body.push(h('div', { style: { fontSize: 11.5, color: C.text3, marginTop: 6 } },
          '判据：能读到一条私信才算真登录（页面标题是当前会话对端昵称，不算；能读评论区也不算——只带 ttwid 就能读）。'))
      }
      if (step === 3) {
        body.push(h('div', { style: { fontSize: 12.5, color: C.text2, lineHeight: '20px' } },
          '这一步认清「插件现在登录的是哪个号」。点按钮，我们直接问抖音要本号资料。'))
        body.push(h('div', { style: { marginTop: 10 } }, btn(busy === 'me' ? '识别中…' : '识别本号', identify, { disabled: !!busy, primary: true })))
        if (me) {
          body.push(h('div', { style: { marginTop: 10, padding: '10px 12px', border: '1px solid ' + C.line, borderRadius: 10, background: C.page } },
            h('div', { style: { fontSize: 13, color: C.text } }, '你现在登录的是 ', h('b', null, me.nick || '（没读到昵称）')),
            h('div', { style: { fontSize: 11.5, color: C.text3, marginTop: 3 } }, 'ID ' + String(me.uid || '').slice(0, 8) + '…' + (me.has_sec ? '（已拿到 sec_uid）' : '（没拿到 sec_uid）'))))
          body.push(h('div', { style: { marginTop: 8 } }, btn('对，就是我', () => setStat(3, 'ok', '已确认：' + (me.nick || '')), { primary: true })))
        }
        body.push(h(WizStatus, { state: status[3], text: msg[3], dark }))
        body.push(h('div', { style: { fontSize: 11.5, color: C.text3, marginTop: 6 } }, '判据：uid / 昵称 / sec_uid 三项齐全（sec_uid 缺了，第 4 步就只能按昵称放行）。'))
      }
      if (step === 4) {
        body.push(h('div', { style: { fontSize: 12.5, color: C.text2, lineHeight: '20px' } },
          '去抖音里点开「你跟主人那条私信会话」（停在会话列表不算），点开之后回来点下面按钮。'
          + '认领之后，它就把这条会话当成"主人的话"，别的会话不会当成命令。'))
        body.push(h('div', { style: { marginTop: 10 } }, btn(busy === 'claim' ? '读取中…' : (pre[4].ok ? '重新认一次' : '读取当前会话'), claim, { disabled: !!busy, primary: true })))
        if (owner) body.push(h('div', { style: { marginTop: 8, fontSize: 12.5, color: C.text } }, '已认领：', h('b', null, owner.nick || '对方')))
        body.push(h(WizStatus, { state: status[4], text: msg[4], dark }))
        body.push(h('div', { style: { fontSize: 11.5, color: C.text3, marginTop: 6 } },
          '判据：对方的 ID 不能等于第 3 步的本号 ID（本号自己不能当主人）；同名但不同号会放行。'))

        // 2026-11-17：原来的第 5 步「谁能命令它」并到这里 —— 认人和"别人怎么办"是同一件事的两半。
        body.push(h('div', { style: { marginTop: 14, paddingTop: 12, borderTop: '1px solid ' + C.line } },
          h(Seg, {
            label: '别人的私信',
            value: authority,
            onChange: setAuthority,
            options: [
              { v: 'owner', t: '只认主人' },
              { v: 'notify', t: '都只提醒' },
              { v: 'reply', t: '谁都能回' },
            ],
            hint: authority === 'owner' ? '别人发来的：不回你，也不提醒你'
              : authority === 'notify' ? '别人发来的：告诉你一声，但它不回'
                : '别人发来的：陌生人也回（容易被冒充，不建议）',
          })))
        if (authority === 'reply') {
          body.push(h('div', { style: { fontSize: 11.5, color: T.warn, marginTop: 2, lineHeight: '18px' } },
            '选了这一档，任何陌生人都能指挥它。涉及账号、文件、命令的话它仍会先问你，但分不出谁是主人。'))
        }
        body.push(h('div', { style: { fontSize: 11.5, color: C.text3, marginTop: 8, lineHeight: '18px' } },
          '它只盯这一条会话（' + (pre[4].ok ? '认领时已自动填好' : '认领后自动填') + '）：别人发给你的私信它看不到，也不会去翻。'))
      }
      if (step === 5) {
        // 2026-11-17 新增：性格放在"怎么回"之前 —— 它一开口就用这套口气，私信和评论区共用。
        const plist = (personas && Array.isArray(personas.list)) ? personas.list : []
        const cur = personaPick ? plist.find((p) => p.id === personaPick) : null
        body.push(h('div', { style: { fontSize: 12.5, color: C.text2, lineHeight: '20px' } },
          '它回私信、回评论，都用这一套口气。先定它是个什么样的人，后面"怎么回"才有依据。'))
        body.push(h('div', { style: { marginTop: 10 } },
          h('select', {
            value: personaPick,
            onChange: (e) => setPersonaPick(e.target.value),
            style: Object.assign({}, ctlBase, { width: 320 }),
          },
            h('option', { value: '' }, '不用人设（默认口气）'),
            ...plist.map((p) => h('option', { key: p.id, value: p.id },
              p.name + (p.builtin ? '（内置）' : '（导入）') + (p.enabled === false ? '·已停用' : ''))),
          )))
        if (cur) {
          body.push(h('div', { style: { fontSize: 11.5, color: C.text3, marginTop: 6 } },
            '选中的这套有 ' + (cur.chars || 0) + ' 字，回私信和评论区都用它。'))
        }
        body.push(h('div', { style: { fontSize: 11.5, color: C.text3, marginTop: 6, lineHeight: '18px' } },
          plist.length
            ? ('本机现在有 ' + plist.length + ' 套。要导入自己的、改名、停用，去设置页「人设」那块。这一条也可以先跳过。')
            : '人设列表没读出来。可以先跳过，以后在设置页「人设」里加。'))
        body.push(h(WizStatus, { state: status[5], text: msg[5], dark }))
      }
      if (step === 6) {
        // 2026-11-17（主人纠正）：这一步**只讲私信里面那些设置**，不许和刷视频、评论区混在一起。
        //   他原话：「谁告诉你说你把这些都放在第六部里面」「第六部是私信里面的那些设置」。
        //   控件用他挑的「分段条」（见 Seg），标签统一四字，每项配一句人话。
        body.push(h(Seg, {
          label: '主人消息',
          value: dmOn ? 'on' : 'off',
          onChange: (v) => setDmOn(v === 'on'),
          options: [{ v: 'on', t: '看完就回' }, { v: 'off', t: '只看不回' }],
          hint: dmOn ? '它直接答你' : '只提醒你，它不答',
        }))
        if (dmOn) {
          body.push(h(Seg, {
            label: '回复多长',
            value: replyMode,
            onChange: setReplyMode,
            options: [{ v: 'conclusion', t: '回得完整' }, { v: 'brief', t: '只回结论' }],
            hint: replyMode === 'brief' ? '只发结论那一句，细节留在 DSH' : '可能好几段，把话说全',
          }))
        }
        body.push(h(Seg, {
          label: '图片表情',
          value: imageMode,
          onChange: setImageMode,
          options: [{ v: 'read', t: '看懂再回' }, { v: 'skip', t: '当没看见' }],
          hint: imageMode === 'skip' ? '只按文字答，不读图（省时间也不费流量）' : '先把图看一遍再答',
        }))
        body.push(h(Seg, {
          label: '分享视频',
          value: shareCardMode,
          onChange: setShareCardMode,
          options: [{ v: 'analyze', t: '自己去看' }, { v: 'chat', t: '你叫才看' }],
          hint: shareCardMode === 'chat' ? '只当话题接着聊，你说要看才看' : '转成文字和画面，再跟你讲这条片子',
        }))
        body.push(h(Seg, {
          label: '查看频率',
          value: String(intervalSec),
          onChange: (v) => setIntervalSec(Number(v)),
          options: withCurrent(
            [{ v: '20', t: '20 秒' }, { v: '30', t: '30 秒' }, { v: '60', t: '60 秒' }],
            String(intervalSec),
            (c) => c + ' 秒',
          ),
          hint: intervalSec <= 20 ? '最及时，也最费电脑' : (intervalSec >= 60 ? '省电脑，提醒会慢一点' : '折中'),
        }))
      }
      if (step === 7) {
        // 刷视频单独一步（主人：不能笼统混为一起）。
        // 2026-11-17 主人第二次纠正，四问的顺序是他定的：
        //   ① 要刷不刷 → ② 开机就刷 / 按时间段刷 → ③ 刷完私信分享给主人 → ④ 写日报。
        //   他还说「这些选项不应该固定，而是留在设置页里面改」——
        //   所以「每天几条」「摊开/一次刷完」这两个具体档位搬回设置页，引导里不再问。
        body.push(h(Seg, {
          label: '要不要刷',
          value: scrollOn ? 'on' : 'off',
          onChange: (v) => setScrollOn(v === 'on'),
          options: [{ v: 'on', t: '要刷' }, { v: 'off', t: '不刷' }],
          hint: scrollOn ? '到时间自己去刷，挑几条值得的，刷完跟你讲' : '完全不刷（默认）',
        }))
        // 选「不刷」时后三项也显示（灰着、点不动），不然这一步空得只剩一个开关
        body.push(h('div', { style: scrollOn ? null : { opacity: 0.45, pointerEvents: 'none' } },
          h(Seg, {
            label: '什么时候刷',
            value: scrollWhen,
            onChange: (v) => setScrollWhen(v === 'window' ? 'window' : 'uptime'),
            options: [{ v: 'uptime', t: '开机就刷' }, { v: 'window', t: '按时间段' }],
            hint: scrollWhen === 'window'
              ? (winCount ? ('只在设置页定的 ' + winCount + ' 个时段里刷') : '还没定时段 —— 去设置页「自动刷视频」里填')
              : '开机后随机等 10～30 分钟开始，之后每条随机隔 5～20 分钟',
          }),
          h(Seg, {
            label: '刷完告诉你',
            value: deliverDm ? 'on' : 'off',
            onChange: (v) => setDeliverDm(v === 'on'),
            options: [{ v: 'on', t: '发私信' }, { v: 'off', t: '不用' }],
            hint: deliverDm ? '刷完把结果私信发给你' : '刷完不打扰你',
          }),
          h(Seg, {
            label: '写日报',
            value: writeReport ? 'on' : 'off',
            onChange: (v) => setWriteReport(v === 'on'),
            options: [{ v: 'on', t: '要写' }, { v: 'off', t: '不写' }],
            hint: writeReport ? '每天存一份文本文件，记事本能打开' : '不生成文件（默认）',
          }),
          h('div', { style: { fontSize: 11.5, color: C.text3, lineHeight: '18px', padding: '2px 0 4px' } },
            '一天刷几条、怎么摊开、具体几点到几点，都在设置页「自动刷视频」里改，这里只定大方向。'),
        ))
      }
      if (step === 8) {
        // 评论区单独一步，同样把该有的都摆出来（回哪些、多快、多少、多长）
        body.push(h(Seg, {
          label: '作品评论',
          value: workOn ? 'on' : 'off',
          onChange: (v) => setWorkOn(v === 'on'),
          options: [{ v: 'on', t: '要回' }, { v: 'off', t: '不回' }],
          hint: workOn ? '有人在你作品下留言，它去回' : '不碰你自己作品下面的评论',
        }))
        body.push(h(Seg, {
          label: '别人回你',
          value: othersOn ? 'on' : 'off',
          onChange: (v) => setOthersOn(v === 'on'),
          options: [{ v: 'on', t: '要接' }, { v: 'off', t: '不接' }],
          hint: othersOn ? '你在别人作品下评论、有人回你时，它接话' : '别人回你，它不接',
        }))
        if (workOn || othersOn) {
          body.push(h(Seg, {
            label: '频率上限',
            value: String(perHour || 30),
            onChange: (v) => setPerHour(Number(v)),
            options: withCurrent(
              [{ v: '30', t: '30 条' }, { v: '60', t: '60 条' }, { v: '100', t: '100 条' }],
              String(perHour || 30),
              (c) => c + ' 条',
            ),
            hint: '每小时最多回几条，只管评论区',
          }))
          body.push(h(Seg, {
            label: '每天上限',
            value: String(perDay || 150),
            onChange: (v) => setPerDay(Number(v)),
            options: withCurrent(
              [{ v: '100', t: '100 条' }, { v: '150', t: '150 条' }, { v: '200', t: '200 条' }],
              String(perDay || 150),
              (c) => c + ' 条',
            ),
            hint: '一天最多回几条，防刷过头',
          }))
          body.push(h(Seg, {
            label: '字数上限',
            value: String(maxChars || 30),
            onChange: (v) => setMaxChars(Number(v)),
            options: withCurrent(
              [{ v: '15', t: '15 字' }, { v: '30', t: '30 字' }, { v: '50', t: '50 字' }],
              String(maxChars || 30),
              (c) => c + ' 字',
            ),
            hint: '每条评论最多几个字',
          }))
          body.push(h('div', { style: { fontSize: 11.5, color: C.text3, lineHeight: '18px', padding: '6px 0' } },
            '评论区的语气、禁用词、跳过哪些人，在设置页「公开评论」和「评论区自动回」里改。'))
        }
        // 一个都没开时，给一条明确的"只守着"，代替以前那个勾选框
        if (!dmOn && !workOn && !othersOn && !scrollOn) {
          body.push(onlyDuty
            ? h('div', { style: { fontSize: 12, color: T.ok, padding: '12px 0 2px', borderTop: '1px solid ' + C.line, marginTop: 10 } },
                '已设成：只守着，不回话')
            : h('div', { style: { padding: '12px 0 2px', borderTop: '1px solid ' + C.line, marginTop: 10 } },
                h('div', { style: { fontSize: 12, color: C.text2, marginBottom: 6 } }, '上面全都不开 —— 它就只看新消息，不回话。'),
                h('button', {
                  type: 'button', onClick: () => setOnlyDuty(true),
                  style: Object.assign({}, btnBase, { cursor: 'pointer' }),
                }, '就这样，只守着')))
        }
      }
      if (step === STEP_MAX) {
        const list = Array.isArray(checks) ? checks : []
        const bad = list.filter((c) => !c.ok)
        body.push(h('div', { style: { fontSize: 13, fontWeight: 600, color: bad.length ? T.danger : T.ok } },
          bad.length ? ('还有 ' + bad.length + ' 项没过') : '体检全绿，可以开始用了'))
        list.forEach((c) => body.push(h('div', { key: c.key, style: { display: 'flex', justifyContent: 'space-between', gap: 10, padding: '6px 0', borderTop: '1px solid ' + C.line } },
          h('div', null,
            h('div', { style: { fontSize: 12.5, color: c.ok ? C.text : T.danger } }, (c.ok ? '✓ ' : '✕ ') + c.name),
            h('div', { style: { fontSize: 11.5, color: C.text3 } }, c.detail || '')),
          c.ok ? null : btn('去修', () => { setStep(checkStep[c.key] || 2); setWarn('') }))))

        // 2026-11-17：走完告诉主人"以后去哪改"。
        //   主人上次想重进引导找不到入口，点了「清除本机记录」，把 self.json 删了 —— 这个坑得在结束页就说明白。
        const where = [
          '私信怎么回、图片表情、你分享的视频 → 设置页「私信监听」',
          '刷视频 → 「自动刷视频」',
          '评论区 → 「公开评论」和「评论区自动回」',
          '性格 → 「人设」',
          '卡住了 → 页面最上面的运行状态，或者「维护」里的检查',
        ]
        body.push(h('div', { style: { marginTop: 14, paddingTop: 12, borderTop: '1px solid ' + C.line } },
          h('div', { style: { fontSize: 12.5, fontWeight: 600, color: C.text } }, '以后要改，去哪找'),
          ...where.map((t, i) => h('div', { key: 'w' + i, style: { fontSize: 12, color: C.text2, marginTop: 4, lineHeight: '18px' } }, '· ' + t)),
          h('div', { style: { fontSize: 11.5, color: C.text3, marginTop: 8, lineHeight: '18px' } },
            '想重新走一遍这个引导：点页面上的「重新引导」。别点「清除本机记录」——那是删掉"这个号是谁"，删了它就认不出自己了。')))
      }

      const pct = Math.round((Math.min(step, STEP_MAX) / STEP_MAX) * 100)
      const hint = step === STEP_MAX ? '' : (mustDo[step] ? '这一步不能跳过' : '可以稍后设置')
      return h('div', { 'data-dy-panel': '1', 'data-dy-wizard': '1', style: { padding: '6px 0 16px' } },
        h('div', { style: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 8 } },
          h('div', { style: { fontSize: 13.5, fontWeight: 600, color: C.text } },
            '第 ' + step + ' / ' + STEP_MAX + ' 步 · ' + steps[step - 1]),
          h('div', { style: { display: 'flex', alignItems: 'center', gap: 10 } },
            h('div', { style: { fontSize: 11.5, color: C.text3 } }, hint),
            h('button', {
              type: 'button', onClick: restartWizard, disabled: !!busy,
              style: {
                fontSize: 11.5, padding: '3px 9px', borderRadius: 999, cursor: busy ? 'default' : 'pointer',
                border: '1px solid ' + C.line, background: 'transparent', color: C.text3, opacity: busy ? 0.55 : 1,
              },
            }, '重新开始'))),
        h('div', { style: { height: 4, borderRadius: 999, background: C.line, overflow: 'hidden', marginBottom: 12 } },
          h('div', { style: { width: pct + '%', height: '100%', background: C.brand, transition: 'width .2s ease' } })),
        h('div', { style: { border: '1px solid ' + C.line, borderRadius: 12, background: C.card, padding: '14px 16px' } }, body),
        warn ? h('div', { style: { fontSize: 12, color: T.danger, marginTop: 8 } }, warn) : null,
        h('div', { style: { display: 'flex', justifyContent: 'space-between', marginTop: 12 } },
          h('div', null,
            step > 1 && step <= LAST_ASK ? btn('上一步', prev, { disabled: !!busy }) : null,
            step === STEP_MAX ? btn('返回设置', () => onDone()) : null),
          h('div', null,
            // 3 确认本号 / 5 性格 / 6 私信 / 7 刷视频 / 8 评论区 都能先跳过
            [3, 5, 6, 7, 8].includes(step) ? btn('稍后设置', () => { setStep(Math.min(LAST_ASK, step + 1)); setWarn('') }) : null,
            step < LAST_ASK ? btn('下一步', next, { disabled: !canGo(step) || !!busy, primary: true }) : null,
            step === LAST_ASK ? btn(busy === 'finish' ? '保存中…' : '完成，体检', finish, { disabled: !!busy, primary: true }) : null)),
      )
    }

    // 「钉死会话」选择器：列表来自 /api/douyin-watch/sessions（DSH 自己的会话列表数据）
    const shortCwd = (p) => {
      const s = String(p || '');
      if (!s) return '';
      const m = /^([A-Za-z]):[\\/](.*)$/.exec(s);
      const rest = (m ? m[2] : s).replace(/[\\/]/g, '-');
      return m ? m[1].toUpperCase() + '-:' + rest : rest;
    };
    const fmtTime = (t) => {
      if (!t) return '';
      try {
        const d = new Date(t);
        const p2 = (n) => String(n).padStart(2, '0');
        return `${p2(d.getMonth() + 1)}-${p2(d.getDate())} ${p2(d.getHours())}:${p2(d.getMinutes())}`;
      } catch { return ''; }
    };

    function SessionPicker({ current, onPick }) {
      const [list, setList] = useState(null);
      const [busy, setBusy] = useState(false);
      const load = () => {
        setBusy(true);
        fetch('/api/douyin-watch/sessions')
          .then((r) => r.json())
          .then((d) => setList(Array.isArray(d.sessions) ? d.sessions : []))
          .catch(() => setList([]))
          .then(() => setBusy(false));
      };
      useEffect(() => { load(); }, []);
      const items = list || [];
      const known = items.some((s) => s.id === current);
      // 2026-11-07：小白（新用户）看不懂 "D-:dsh-bot的工作区" 这种串。
      //   只显示文件夹名 + 时间，按最近使用排序 —— 用户认名字，不认路径。
      const folder = (p) => { const a = String(p || '').split(/[\\/]/).filter(Boolean); return a.length ? a[a.length - 1] : ''; };
      const sorted = items.slice().sort((a, b) => Number(b.updatedAt || 0) - Number(a.updatedAt || 0));
      return h('div', { style: { display: 'flex', alignItems: 'center', gap: 8 } },
        h('select', {
          value: current || '',
          onChange: (e) => onPick(e.target.value),
          style: Object.assign({}, ctlBase, { width: 300, fontSize: 12 }),
        },
          h('option', { value: '' }, '（不选：发到最近在用的那个对话）'),
          ...sorted.slice(0, 25).map((s) => h('option', { key: s.id, value: s.id },
            `${folder(s.cwd) || '（无文件夹）'}${s.blank ? '（空对话）' : ''}${s.live ? ' · 已打开' : ''}${fmtTime(s.updatedAt) ? ' · ' + fmtTime(s.updatedAt) : ''}`)),
          sorted.length > 25 ? h('option', { value: '', disabled: true }, `（只列最近 25 个，共 ${sorted.length} 个；想选更早的，先在 DSH 里打开它，它就会排上来。中途离开这个页面不会丢设置）`) : null,
          (current && !known) ? h('option', { value: current }, '（原来选的对话，现在没找到）') : null,
        ),
        h('button', {
          type: 'button', onClick: load,
          style: Object.assign({}, ctlBase, { width: 'auto', padding: '0 10px', cursor: 'pointer', color: C.text2 }),
        }, busy ? '…' : '刷新'),
      );
    }

    // 运行状态卡片：绿=运行中、灰=已停止、红=有错误。数据每 5 秒刷新一次（宿主 side 拼好）。
    // 2026-10-28 改成「一行状态 + 2×2 指标」：把最该看的四个数摆出来
    //   （今日评论额度 / 最后读取 / 签名直连 / 依赖），别让卡里空着。
    function StatusCard({ s, q, sessionId, dark }) {
      const T = TONE(dark)
      const cell = (k, v, tone) => h('div', {
        style: { padding: '8px 10px', border: '1px solid ' + C.line, borderRadius: 10, background: C.bg2 || 'transparent' },
      },
        h('div', { style: { fontSize: 11.5, color: C.text3, marginBottom: 2 } }, k),
        h('div', { style: { fontSize: 13, fontWeight: 600, color: tone || C.text, wordBreak: 'break-all' } }, v || '—'),
      );
      if (!s) {
        return h(Card, { title: '运行状态' },
          h('div', { style: { padding: '10px 0', fontSize: 12, color: C.text3 } }, '读取中…'),
        );
      }
      const running = !!s.enabled;
      const bad = !!s.lastError;
      const color = bad ? T.danger : (running ? T.ok2 : 'rgba(120,125,135,0.55)');
      const quota = q || {};
      const quotaTxt = quota.perHour
        ? (`已回 ${quota.hour || 0} 条 · 每小时最多 ${quota.perHour} · 每天最多 ${quota.perDay}`)
        : '还没回过';
      // 「签名直连」这种词用户读不懂，只说"读得快还是慢"
      const signedTxt = s.signed
        ? (s.signedDeps ? '直接连（快）' : '用浏览器页面（慢一点的备用方式）')
        : '用浏览器页面（正常方式）';
      const signedTone = s.signed && s.signedDeps ? T.ok2 : (s.signed ? T.note : C.text2);
      return h(Card, { title: '运行状态' },
        h('div', { style: { display: 'flex', alignItems: 'center', gap: 8, padding: '8px 0 10px' } },
          h('span', { style: { width: 8, height: 8, borderRadius: 4, background: color, flex: '0 0 auto' } }),
          h('span', { style: { fontSize: 13, fontWeight: 600, color: bad ? T.danger : C.text } },
            bad ? '出错了' : (running ? '正在监听' : '已暂停')),
          h('span', { style: { fontSize: 12, color: C.text3 } },
            running ? (s.peerSet ? '（已选定要监听的抖音聊天）' : '（还没选定抖音聊天，不会工作）') : '（暂停时不看消息）'),
        ),
        h('div', { style: { display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 } },
          cell('今天已回评论（评论区，不是私信）', quotaTxt),
          cell('最后一次看消息', s.lastRead ? `${s.lastRead}，读到 ${s.lastCount || 0} 条` : '还没看过'),
          cell('最后一次收到私信', s.lastWake || '还没有'),
          cell('回复发到哪个对话', s.sessionLabel || (sessionId ? '（已选，名字暂时没取到）' : '最近在用的那个')),
        ),
        bad ? h('div', { style: { fontSize: 12, color: T.danger, marginTop: 8 } }, '出错原因：' + s.lastError) : null,
      );
    }

    function Panel() {
      const dark = useThemeDark();
      const T = TONE(dark);
      const [cfg, setCfg] = useState(null);
      // 2026-11-15：首次引导。onboarded=false 会自动进向导；这个 state 只是给「重新引导」用
      const [wizOpen, setWizOpen] = useState(false);
      const [rows, setRows] = useState(null);
      const [note, setNote] = useState('');
      const [status, setStatus] = useState(null);
      const [cleaning, setCleaning] = useState(false);
      const [switching, setSwitching] = useState(false);
      const [personas, setPersonas] = useState(null);
      const [pNote, setPNote] = useState('');
      const [pOpen, setPOpen] = useState(null);   // 查看全文：{ id, name, text }
      const [pEdit, setPEdit] = useState(null);   // 改名中：{ id, name }
      const [pDraft, setPDraft] = useState({ name: '', text: '' }); // 导入草稿
      // 2026-11-07：认领主人（读当前打开会话的 sec_uid，点完即生效；0.4.14 起没有"等消息验证"这一步）
      const [claimBusy, setClaimBusy] = useState(false);
      const [claimMsg, setClaimMsg] = useState('');
      // 2026-11-13：被抖音拦住时的「我已处理，继续」（闸门状态在后端，这里只是放出来）
      const [gateBusy, setGateBusy] = useState(false);
      const [gateMsg, setGateMsg] = useState('');
      // 2026-11-13：清除本机记录的「这个账号自己是谁」
      const [selfBusy, setSelfBusy] = useState(false);
      const [selfMsg, setSelfMsg] = useState('');
      // 2026-11-15：主人误点「清除本机记录」删过 self.json → 加二次确认 + 清完给「去重新引导」
      const [selfConfirm, setSelfConfirm] = useState(false);
      const [selfCleared, setSelfCleared] = useState(false);
      // 2026-11-07：检查一下（对齐 dsh-mobile 的一键诊断）+ 高级折叠
      const [checkBusy, setCheckBusy] = useState(false);
      const [checks, setChecks] = useState(null);
      const [advOpen, setAdvOpen] = useState(false);

      // 人设库（内置三套只读 + 导入的可编辑），列表只拿元数据，正文按需取
      const loadPersonas = () => fetch('/api/douyin-watch/personas')
        .then((r) => r.json())
        .then((d) => { if (d && d.ok) setPersonas(d); })
        .catch(() => {});

      // 人设库动作：选当前 / 导入 / 删除 / 启停
      const mutatePersonas = (body) => fetch('/api/douyin-watch/personas', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      })
        .then((r) => r.json())
        .then((d) => {
          if (d && d.ok) { setPNote(''); loadPersonas(); load(); return true; }
          setPNote('操作失败：' + ((d && d.error) || '未知'));
          return false;
        })
        .catch((e) => { setPNote('操作失败：' + (e && e.message ? e.message : e)); return false; });

      // 查看全文：正文按需拉，列表里只有字数
      const viewPersona = (p) => {
        if (pOpen && pOpen.id === p.id) { setPOpen(null); return; }
        setPOpen({ id: p.id, name: p.name, text: '读取中…' });
        const keep = (text) => setPOpen((cur) => (cur && cur.id === p.id ? { id: p.id, name: p.name, text } : cur));
        fetch('/api/douyin-watch/personas?id=' + encodeURIComponent(p.id))
          .then((r) => r.json())
          .then((d) => keep(d && d.ok ? d.text : ('读取失败：' + ((d && d.error) || '未知'))))
          .catch(() => keep('读取失败：接口没返回'));
      };

      const commitRename = (id) => {
        const name = String((pEdit && pEdit.name) || '').trim();
        if (!name) { setPNote('名字不能为空'); return; }
        setPEdit(null);
        mutatePersonas({ action: 'rename', id, name });
      };

      const submitImport = () => {
        const name = String(pDraft.name || '').trim();
        const text = String(pDraft.text || '').trim();
        if (!name || !text) { setPNote('名字和正文都要填'); return; }
        mutatePersonas({ action: 'import', name, text }).then((ok) => {
          if (ok) setPDraft({ name: '', text: '' });
        });
      };

      // 一条人设：名字 + 来源/字数 + 操作按钮（内置的只有「设为当前 / 全文」）
      const personaRow = (p) => {
        const isCur = (cfg.personaPreset || '') === p.id;
        const editing = !!pEdit && pEdit.id === p.id;
        return h('div', {
          key: p.id,
          style: {
            display: 'flex', alignItems: 'center', gap: 8, minHeight: 34,
            padding: '4px 0', borderTop: '1px solid ' + C.line,
          },
        },
          editing
            ? h('input', {
                value: pEdit.name, autoFocus: true,
                onChange: (e) => setPEdit({ id: p.id, name: e.target.value }),
                onKeyDown: (e) => {
                  if (e.key === 'Enter') commitRename(p.id);
                  if (e.key === 'Escape') setPEdit(null);
                },
                style: Object.assign({}, ctlBase, { flex: 1, height: 26, fontSize: 12 }),
              })
            : h('div', { style: { flex: 1, minWidth: 0 } },
                h('span', { style: { fontSize: 13, color: p.enabled === false ? C.text3 : C.text } }, p.name),
                h('span', { style: { fontSize: 11, color: C.text3, marginLeft: 8 } },
                  (p.builtin ? '内置' : '导入') + ' · ' + p.chars + ' 字' + (p.enabled === false ? ' · 已停用' : '')),
              ),
          h('div', { style: { display: 'flex', gap: 6, flex: '0 0 auto' } },
            isCur
              ? h('span', { style: { fontSize: 11, color: C.text3, padding: '0 4px' } }, '当前')
              : h('button', {
                  type: 'button', style: btnBase,
                  onClick: () => mutatePersonas({ action: 'set-current', id: p.id }),
                }, '设为当前'),
            h('button', {
              type: 'button', style: btnBase,
              onClick: () => viewPersona(p),
            }, !!pOpen && pOpen.id === p.id ? '收起' : '全文'),
            p.builtin ? null : (editing
              ? h('button', { type: 'button', style: btnBase, onClick: () => commitRename(p.id) }, '确定')
              : h('button', {
                  type: 'button', style: btnBase,
                  onClick: () => setPEdit({ id: p.id, name: p.name }),
                }, '改名')),
            p.builtin ? null : h('button', {
              type: 'button', style: btnBase,
              onClick: () => mutatePersonas({ action: 'set-enabled', id: p.id, enabled: p.enabled === false }),
            }, p.enabled === false ? '启用' : '停用'),
            p.builtin ? null : h('button', {
              type: 'button', style: Object.assign({}, btnBase, { color: T.danger }),
              onClick: () => {
                if (!window.confirm('删掉「' + p.name + '」？库里的正文会一起没了，找不回来。')) return;
                mutatePersonas({ action: 'remove', id: p.id });
              },
            }, '删除'),
          ),
        );
      };

      const load = () => fetch('/api/douyin-watch/config')
        .then((r) => r.json())
        .then((d) => {
          const c = d.config || {};
          setCfg(c);
          setStatus(c.status || null);
          setRows((Array.isArray(c.autoScrollWindows) ? c.autoScrollWindows : []).map((w, i) => {
            const r = parseWin(w);
            r.per = Math.max(0, Number((Array.isArray(c.autoScrollWindowPer) ? c.autoScrollWindowPer : [])[i]) || 0);
            return r;
          }));
        })
        .catch(() => setNote('读配置失败：接口没返回（宿主报错，见 DSH 日志）'));
      useEffect(() => {
        load();
        loadPersonas();
        const tick = () => fetch('/api/douyin-watch/config')
          .then((r) => r.json())
          .then((d) => setStatus(((d.config || {}).status) || null))
          .catch(() => {});
        const t = setInterval(tick, 5000);
        return () => clearInterval(t);
      }, []);

      const save = (patch) => {
        fetch('/api/douyin-watch/config', {
          method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(patch),
        }).then((r) => r.json())
          .then((d) => { setCfg(d.config || {}); setNote('已保存'); })
          .catch(() => setNote('保存失败'));
      };

      // 检查一下（2026-11-07）：让用户不用翻日志就知道卡在哪
      const runCheck = () => {
        setCheckBusy(true); setChecks(null);
        fetch('/api/douyin-watch/doctor', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })
          .then((r) => r.json())
          .then((d) => {
            setCheckBusy(false);
            setChecks(Array.isArray(d.checks) && d.checks.length
              ? d.checks
              : [{ key: 'x', name: '没拿到检查结果', ok: false, detail: (d && d.error) || '接口没回应' }]);
          })
          .catch(() => { setCheckBusy(false); setChecks([{ key: 'x', name: '没拿到检查结果', ok: false, detail: '接口没回应' }]); });
      };

      // 认领当前打开的那条会话（2026-11-07）：先让用户去抖音点开聊天，再点这里
      const claimNow = () => {
        setClaimBusy(true); setClaimMsg('');
        fetch('/api/douyin-watch/claim', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })
          .then((r) => r.json())
          .then((d) => {
            setClaimBusy(false);
            if (d && d.ok) {
              setCfg(d.config || cfg);
              // 2026-11-15：降级放行要明确说出来（同名、不同号，按 ID 放过；或没法比 ID）
              setClaimMsg(d.sameNickDifferentId ? ('已设为「' + ((d.claim && d.claim.nick) || '对方') + '」' + (d.note ? '：' + d.note : '')) : '');
            } else {
              setClaimMsg('失败：' + ((d && d.error) || '认领没成功'));
            }
          })
          .catch(() => { setClaimBusy(false); setClaimMsg('失败：接口没回应'); });
      };

      // 2026-11-13：主人说「我已经处理了」→ 后端先探一次页面，再决定放行 / 提示还没好
      const resumeGate = () => {
        setGateBusy(true); setGateMsg('');
        fetch('/api/douyin-watch/resume', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })
          .then((r) => r.json())
          .then((d) => {
            setGateBusy(false);
            setCfg((d && d.config) || cfg);
            setGateMsg(d && d.warned ? ('已放行，但页面看着还不正常：' + ((d.note) || '')) : (d && d.ok ? '已恢复，继续干活' : '没成功：' + ((d && d.note) || '接口没回应')));
          })
          .catch(() => { setGateBusy(false); setGateMsg('失败：接口没回应'); });
      };

      // 2026-11-13：清掉本机记的「我自己是谁」——只删 self.json，不碰主人那份 owner.json
      const clearSelf = () => {
        setSelfBusy(true); setSelfMsg('');
        fetch('/api/douyin-watch/self-clear', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })
          .then((r) => r.json())
          .then((d) => {
            setSelfBusy(false);
            setCfg((d && d.config) || cfg);
            setSelfMsg(d && d.ok ? '已清除。' : '清除失败');
            if (d && d.ok) setSelfCleared(true);
          })
          .catch(() => { setSelfBusy(false); setSelfMsg('失败：接口没回应'); });
      };

      // 失败时别再一直显示「加载中…」：把 note 里的错误直接显示出来（2026-10-24：那次 400 就是这么被吞掉的）
      if (!cfg || !rows) return h('div', { style: { padding: 16, fontSize: 13, color: note ? T.danger : C.text3 } }, note || '加载中…');

      const commit = (next) => {
        setRows(next);
        const good = next.filter((r) => r.start && r.end);
        save({
          autoScrollWindows: good.map((r) => r.start + '-' + r.end),
          // 2026-11-18：每段自己几条，和上面同下标（0 = 不单独限）
          autoScrollWindowPer: good.map((r) => Math.max(0, Number(r.per) || 0)),
        });
      };

      const timeSel = (i, part) => {
        const v = rows[i][part] || '';
        const bits = v ? v.split(':') : ['', ''];
        const hh = bits[0] || '';
        const mm = bits[1] || '';
        const set = (nh, nm) => {
          const next = rows.slice();
          next[i] = Object.assign({}, next[i], { [part]: (nh && nm) ? nh + ':' + nm : '' });
          commit(next);
        };
        const one = (val, opts, onPick) => h('select', {
          value: val, onChange: (e) => onPick(e.target.value),
          style: Object.assign({}, ctlBase, { width: 64, paddingRight: 4 }),
        }, h('option', { value: '' }, '--'), ...opts.map((t) => h('option', { key: t, value: t }, t)));
        return h('span', { style: { display: 'inline-flex', alignItems: 'center', gap: 2 } },
          one(hh, HOURS, (x) => set(x, mm || '00')),
          h('span', { style: { color: C.text3, fontSize: 12 } }, ':'),
          one(mm, MINUTES, (x) => set(hh || '00', x)),
        );
      };

      // 吸顶快捷跳转：只跳卡片，靠 **稳定锚点**（data-dysec），别再按标题文字猜。
      //   2026-10-28 踩过：按 innerText 前缀匹配时，卡片里的行标签（「公开评论语气」）
      //   也会命中，结果跳到卡片中间 —— 就是主人说的"跳转有问题"。
      const SECTIONS = [
        { label: '私信监听', anchor: 'mail' },
        { label: '自动刷视频', anchor: 'autoscroll' },
        { label: '人设', anchor: 'persona' },
        { label: '公开评论', anchor: 'public' },
        { label: '评论区自动回', anchor: 'autoreply' },
        { label: '维护', anchor: 'maint' },
      ];
      const jumpTo = (anchor) => {
        try {
          const el = document.getElementById('dysec-' + anchor)
            || (document.querySelector('[data-dy-panel]') || document).querySelector('[data-dysec="' + anchor + '"]');
          if (el && el.scrollIntoView) el.scrollIntoView({ behavior: 'smooth', block: 'start' });
          return !!el;
        } catch { return false; /* 跳转失败不影响使用 */ }
      };

      // 人设列表：一行一条，展开的那条把全文插在它自己下面（不弹窗，省得挡住别的设置）
      const personaRows = [];
      for (const p of (personas && Array.isArray(personas.list) ? personas.list : [])) {
        personaRows.push(personaRow(p));
        if (pOpen && pOpen.id === p.id) {
          personaRows.push(h('div', {
            key: p.id + '-text',
            style: { padding: '6px 0 10px', borderTop: '1px dashed ' + C.line },
          },
            h('div', { style: { display: 'flex', justifyContent: 'space-between', marginBottom: 4 } },
              h('span', { style: { fontSize: 12, color: C.text2 } }, '全文 · ' + pOpen.name),
              h('span', { style: { fontSize: 11, color: C.text3 } }, pOpen.text.length + ' 字'),
            ),
            h('div', {
              style: {
                whiteSpace: 'pre-wrap', fontSize: 12, lineHeight: '20px', color: C.text2,
                maxHeight: 280, overflow: 'auto', padding: 8, borderRadius: 8,
                background: 'rgba(120,125,135,0.06)',
              },
            }, pOpen.text),
          ));
        }
      }

      // 首次进来（或点「重新引导」）→ 直接给向导，不进常规设置
      if (cfg && (cfg.onboarded === false || wizOpen)) {
        // runStatus：给它"上次读到消息"用来判断登录还有没有效；personas：第 5 步选性格用
        return h(Wizard, { cfg, setCfg, dark, runStatus: status, personas, onDone: () => { setWizOpen(false); load(); } });
      }

      // 2026-11-15（主人要求）：顶部常驻「重新引导」入口 + 「身份不自洽」提示。
      //   来由：主人想重进向导找不到入口，误点了「清除本机记录」把 self.json 删了。
      //   ① onboarded=true 但 self 三项（uid/昵称/sec_uid）不全 → 顶一条明确提示 + 按钮；
      //   ② 状态正常 → 顶一条轻量的常驻入口（不是藏在角落的小灰字）。
      //   判定数据来自后端 view().self.complete（读 $HOME/self.json 的 current.uid/nick/sec_uid），
      //   所以补完以后 load() 一刷就消失，不是页面打开时算一次就定死。
      const wizardEntry = () => {
        const me = (cfg && cfg.self) || {}
        const gap = cfg && cfg.onboarded === true && !me.complete
        const openWiz = () => setWizOpen(true)
        if (gap) {
          const miss = Array.isArray(me.missing) ? me.missing : []
          return h('div', {
            style: {
              border: '1px solid ' + T.warnBorder, background: C.card,
              borderRadius: 12, padding: '12px 16px', margin: '0 0 10px',
            },
          },
            h('div', { style: { fontSize: 13.5, fontWeight: 600, color: T.warn } }, '⚠️ 本号身份缺失'),
            h('div', { style: { fontSize: 12.5, color: C.text2, lineHeight: '19px', marginTop: 4 } },
              '它现在认不出自己的号：判断不了哪条评论是它自己发的，评论可能会漏回。',
              miss.length ? '（缺 ' + miss.join('、') + '）' : '（本机没有这份记录）'),
            h('div', { style: { fontSize: 11.5, color: C.text3, marginTop: 4 } },
              '补一次就好：重新引导，第 3 步会重新认本号，大约十几秒。'),
            h('button', {
              type: 'button', onClick: openWiz,
              style: Object.assign({}, btnBase, { marginTop: 8, cursor: 'pointer' }),
            }, '去重新引导'),
          )
        }
        return h('div', {
          style: {
            display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12,
            border: '1px solid ' + C.line, borderRadius: 12, background: C.card,
            padding: '9px 14px', margin: '0 0 10px',
          },
        },
          h('div', { style: { fontSize: 12.5, color: C.text2 } },
            '换号了 / 想补本号身份 / 想重认主人 → 重新走一遍引导'),
          h('button', {
            type: 'button', onClick: openWiz,
            style: Object.assign({}, btnBase, { cursor: 'pointer', flex: '0 0 auto' }),
          }, '重新引导'),
        )
      }

      return h('div', { 'data-dy-panel': '1', style: { padding: '4px 0 16px' } },

        wizardEntry(),

        h('div', {
          style: {
            position: 'sticky', top: 0, zIndex: 5, display: 'flex', flexWrap: 'wrap',
            gap: 6, padding: '6px 0 8px', marginBottom: 2,
            // 吸顶栏必须和**页面底色**同色：深色下卡片色(layer-1 #232324)比页面(#151517)亮，
            //   吸顶时就成了一块压在标题上的浅板（2026-11-15 主人截图指出）。
            //   也别用 transparent —— 滚动时下面的文字会和标签叠在一起。
            background: C.page,
          },
        },
          ...SECTIONS.map((s) => h('button', {
            key: s.anchor, type: 'button', onClick: () => jumpTo(s.anchor),
            style: {
              fontSize: 12, padding: '4px 9px', borderRadius: 999, cursor: 'pointer',
              border: '1px solid ' + C.line, background: 'transparent', color: C.text2,
            },
          }, s.label)),
        ),

        h('div', {
          style: {
            display: 'flex', alignItems: 'center', justifyContent: 'space-between',
            gap: 16, padding: '10px 16px', marginTop: 4,
            border: '1px solid ' + C.line, borderRadius: 12, background: C.card,
          },
        },
          h('div', null,
            h('div', { style: { fontSize: 13.5, fontWeight: 600, color: C.text } }, '私信功能开关'),
            h('div', { style: { fontSize: 12, color: C.text3 } }, '只管私信：关掉后私信不读、也不回。刷视频和评论区自动回是另外两个页面，各有各的开关'),
          ),
          h(Switch, { checked: !!cfg.enabled, onChange: (v) => save({ enabled: v }) }),
        ),

        h(StatusCard, { s: status, q: cfg.commentQuota, sessionId: cfg.sessionId, dark }),

        // 2026-11-13：本机记录的「这个抖音账号自己」（≠ 上面那位主人）
        (() => {
          const me = cfg && cfg.self
          const txt = me && me.stored
            ? ('已记住：' + (me.nick || '（没学到昵称）') + (me.uid ? '（ID ' + me.uid + '）' : '') + (me.learned_at ? ' · ' + String(me.learned_at).slice(0, 10) : '') + (me.complete ? '' : '（缺 ' + ((me.missing || []).join('、') || 'sec_uid') + '）'))
            : '还没记住 —— 点页面顶部「重新引导」，第 3 步会重新认本号'
          return h('div', null,
            h(Row, {
            label: '这个账号自己是谁',
            hint: '只存你这个抖音号的 uid、昵称和 sec_uid，用来判断"这条评论是不是我发的"。和上面那位主人是两回事',
          },
            h('div', { style: { display: 'flex', alignItems: 'center', gap: 8 } },
              h('span', { style: { fontSize: 12.5, color: C.text2 } }, txt),
              h('button', {
                type: 'button', disabled: selfBusy, onClick: () => setSelfConfirm(true),
                style: Object.assign({}, btnBase, { cursor: selfBusy ? 'default' : 'pointer' }),
              }, selfBusy ? '清除中…' : '清除本机记录'),
            ),
            ),
            // 二次确认：写清清的是什么、后果是什么（主人已经误删过一次）
            selfConfirm ? h('div', {
              style: { margin: '6px 0 10px', padding: '10px 12px', border: '1px solid ' + T.danger, borderRadius: 10, background: C.page },
            },
              h('div', { style: { fontSize: 12.5, fontWeight: 600, color: T.danger } }, '要清掉的是「这个抖音号是谁」这条记录'),
              h('div', { style: { fontSize: 12, color: C.text2, lineHeight: '19px', marginTop: 4 } },
                '清掉以后它就认不出自己的号了：判断不了哪条评论是你自己发的，评论可能会漏回；认领主人时也只能按昵称比，容易认错。',
                '抖音上的号本身不受影响，也不会退出登录。'),
              h('div', { style: { marginTop: 8 } },
                h('button', {
                  type: 'button', disabled: selfBusy, onClick: () => { setSelfConfirm(false); clearSelf(); },
                  style: Object.assign({}, btnBase, { background: T.danger, color: '#fff', border: '1px solid ' + T.danger, cursor: selfBusy ? 'default' : 'pointer', marginRight: 8 }),
                }, selfBusy ? '清除中…' : '确认清除'),
                h('button', { type: 'button', onClick: () => setSelfConfirm(false), style: Object.assign({}, btnBase, { cursor: 'pointer' }) }, '取消'),
              ),
            ) : null,
            // 清完之后：直接给一条补回来的路（重新引导 → 第 3 步会重新认本号）
            selfCleared ? h('div', { style: { margin: '0 0 10px', display: 'flex', alignItems: 'center', gap: 8 } },
              h('span', { style: { fontSize: 12, color: C.text3 } }, '要补回来就重新引导一次（第 3 步会重新认本号）：'),
              h('button', {
                type: 'button',
                onClick: () => {
                  fetch('/api/douyin-watch/onboard/reset', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })
                    .then((r) => r.json())
                    .then((d) => { setCfg((d && d.config) || cfg); setSelfCleared(false); setSelfConfirm(false); setSelfMsg(''); setWizOpen(true); })
                    .catch(() => setSelfMsg('打开引导失败：接口没回应'));
                },
                style: Object.assign({}, btnBase, { cursor: 'pointer' }),
              }, '去重新引导'),
            ) : null,
            selfMsg ? h('div', { style: { fontSize: 12, color: C.text2, padding: '0 0 8px' } }, selfMsg) : null,
          )
        })(),

        // 2026-11-13：被拦住时置顶一条，别指望主人去翻日志
        (() => {
          const g = cfg && cfg.gate
          if (!g || !g.kind || g.kind === 'ok') return null
          const bad = g.kind === 'verify' || g.kind === 'login'
          return h('div', {
            style: {
              border: '1px solid ' + (bad ? T.danger : T.warnBorder),
              background: bad ? T.dangerBg : T.warnBg,
              borderRadius: 12, padding: '12px 16px', margin: '10px 0 0',
            },
          },
            h('div', { style: { fontSize: 13.5, fontWeight: 600, color: bad ? T.danger : T.warn } },
              bad ? '⚠️ 需要你本人处理一下（插件已经停手）' : '⏸ 先停了一小会儿'),
            h('div', { style: { fontSize: 12.5, color: C.text2, lineHeight: '19px', marginTop: 4 } }, g.text || ''),
            g.reason ? h('div', { style: { fontSize: 11.5, color: C.text3, marginTop: 4 } }, '看到的证据：' + g.reason) : null,
            g.lastProbe && g.lastProbe.evidence
              ? h('div', { style: { fontSize: 11.5, color: C.text3, marginTop: 2 } }, '最近一次自动检查：' + g.lastProbe.evidence)
              : null,
            bad ? h('button', {
              type: 'button', disabled: gateBusy, onClick: resumeGate,
              style: Object.assign({}, btnBase, { marginTop: 8, cursor: gateBusy ? 'default' : 'pointer' }),
            }, gateBusy ? '检查中…' : '我已处理，继续') : null,
            gateMsg ? h('div', { style: { fontSize: 12, color: C.text2, marginTop: 6 } }, gateMsg) : null,
          )
        })(),

        // 2026-11-13：定时体检不正常时提示（只提示，不拦主流程）
        (() => {
          const hp = cfg && cfg.health
          if (!hp || !hp.state || hp.state === 'ok') return null
          return h('div', {
            style: { border: '1px solid ' + T.warnBorder, background: T.warnBg, borderRadius: 12, padding: '10px 16px', margin: '8px 0 0' },
          },
            h('div', { style: { fontSize: 12.5, fontWeight: 600, color: T.warn } }, '⚠️ 评论区接口体检不正常'),
            h('div', { style: { fontSize: 12, color: C.text2, marginTop: 3 } },
              (hp.text || '') + (hp.evidence ? '（' + hp.evidence + '）' : '')),
            h('div', { style: { fontSize: 11.5, color: C.text3, marginTop: 3 } },
              '这是每 ' + (cfg.probeHours || 6) + ' 小时一次的体检，只在状态变化时提醒；不影响私信和评论的日常运行'),
          )
        })(),

        h(Card, { title: '私信监听', anchor: 'mail' },
          // 2026-11-07：第一句先说结果 —— 小白反馈"全页没有一句说清是谁的号发出去的"
          h('div', { style: { fontSize: 12, color: C.text3, padding: '0 0 10px', lineHeight: '18px' } },
            '这里设置的所有回复，都是用你的抖音号发出去的，对方看到的就是一条普通私信。'),
          (() => {
            const cl = cfg.claim
            const txt = !cl ? '还没设置' : ('已设为「' + (cl.nick || '对方') + '」')
            return h(Row, { label: '谁可以命令它', hint: '在抖音里点开那个人的聊天，再点右边按钮。设好之后，只有这个人发来的话才会被当成命令' },
              h('div', { style: { display: 'flex', alignItems: 'center', gap: 8 } },
                h('span', { style: { fontSize: 13, color: cl ? C.text : C.text2 } }, txt),
                h('button', {
                  type: 'button', disabled: claimBusy, onClick: claimNow,
                  style: Object.assign({}, btnBase, { cursor: claimBusy ? 'default' : 'pointer' }),
                }, claimBusy ? '设置中…' : (cl ? '换一个人' : '就设成这个人')),
              ),
            )
          })(),
          claimMsg ? h('div', { style: { fontSize: 12, color: claimMsg.indexOf('失败') === 0 ? T.danger : C.text2, padding: '0 0 8px' } }, claimMsg) : null,
          h(Row, { label: '检查一下', hint: '挨个试一遍：能不能打开抖音、屏幕上是不是那个人、回复能不能发出去' },
            h('button', {
              type: 'button', disabled: checkBusy, onClick: runCheck,
              style: Object.assign({}, btnBase, { cursor: checkBusy ? 'default' : 'pointer' }),
            }, checkBusy ? '正在检查…（十几秒）' : '开始检查'),
          ),
          checks ? h('div', { style: { padding: '2px 0 10px', display: 'flex', flexDirection: 'column', gap: 4 } },
            ...checks.map((c) => h('div', { key: c.key, style: { fontSize: 12.5, color: c.ok ? C.text2 : T.danger, lineHeight: '19px' } },
              (c.ok ? '✓ ' : '✗ ') + c.name + '：' + c.detail)),
          ) : null,
          h('div', { style: { padding: '2px 0 6px' } },
            h('button', {
              type: 'button', onClick: () => setAdvOpen(!advOpen),
              style: Object.assign({}, btnBase, { cursor: 'pointer' }),
            }, advOpen ? '收起高级' : '高级（一般不用动）'),
          ),
          advOpen ? h(Row, { label: '它跟谁聊', hint: '填抖音私信里那个人的昵称。这个 Bot 只看这一条聊天，别人发消息它不理' },
            h(TextField, { value: cfg.peer || '', placeholder: '例：鲜葱、', onCommit: (v) => save({ peer: v }) }),
          ) : null,
          h(Row, { label: '回复发到哪个对话', hint: '这些是 DSH 里的对话（按最近使用排序），不是抖音聊天。不选 = 发到最近在用的那个；选错了随时改' },
            h(SessionPicker, { current: cfg.sessionId || '', onPick: (v) => save({ sessionId: v }) }),
          ),
          h(Row, { label: '收到这个人的消息自动回', hint: '关掉 = 只提醒你，不回' }, h(Switch, { checked: !!cfg.ownerAutoReply, onChange: (v) => save({ ownerAutoReply: v }) })),
          h(Row, { label: '回复多长', hint: '「完整」可能好几段；「精简」只发结论那一句' },
            h('select', {
              value: cfg.replyMode || 'conclusion',
              onChange: (e) => save({ replyMode: e.target.value }),
              style: Object.assign({}, ctlBase, { width: 160 }),
            },
              h('option', { value: 'conclusion' }, '完整（可能好几段）'),
              h('option', { value: 'brief' }, '精简（只发一句结论）'),
            ),
          ),
          h(Row, { label: '别人发来的消息' },
            h('select', {
              value: cfg.strangerPolicy || 'notify',
              onChange: (e) => save({ strangerPolicy: e.target.value }),
              style: Object.assign({}, ctlBase, { width: 160 }),
            },
              h('option', { value: 'notify' }, '只提醒我，不回'),
              h('option', { value: 'reply' }, '可以回，也提醒我'),
              h('option', { value: 'ignore' }, '不回也不提醒'),
            ),
          ),
          (cfg.strangerPolicy === 'ignore')
            ? h('div', { style: { fontSize: 12, color: '#b26a00', padding: '0 0 8px' } },
              '注意：现在是「不回也不提醒」——别人发来的消息你不会收到任何通知。想收到提醒，把上面那个选项改成「只提醒我，不回」。')
            : null,
          h(Row, { label: '多久看一次新消息', hint: '单位：秒。填太小费电脑，填太大收到提醒慢；框里现在这个数就是正在用的' },
            h('input', {
              type: 'number', min: 10, max: 3600, value: cfg.intervalSeconds,
              onChange: (e) => save({ intervalSeconds: Number(e.target.value) }),
              style: Object.assign({}, ctlBase, { width: 84, textAlign: 'right' }),
            }),
          ),
        ),

        h(Card, { title: '自动刷视频', anchor: 'autoscroll' },
          h(Row, { label: '开启自动刷视频', hint: '关掉就完全不跑' }, h(Switch, { checked: !!cfg.autoScrollEnabled, onChange: (v) => save({ autoScrollEnabled: v }) })),
          // 2026-11-17：引导页只问大方向，具体档位都放回这里改（主人：「这些选项不应该固定，而是留在设置页里面改」）。
          h(Row, { label: '什么时候刷', hint: '「开机就刷」= 跟着机器醒着走，不限定钟点；「按时间段」= 只在下面那几段里刷' },
            h('select', {
              value: cfg.autoScrollWhen === 'window' ? 'window' : 'uptime',
              onChange: (e) => save({ autoScrollWhen: e.target.value }),
              style: Object.assign({}, ctlBase, { width: 200 }),
            },
              h('option', { value: 'uptime' }, '开机就刷（默认）'),
              h('option', { value: 'window' }, '按设定时间段'),
            ),
          ),
          h(Row, { label: '怎么摊开', hint: '「摊开刷」= 每条之间随机隔 5～20 分钟（默认），条数多就自然摊更久；「一次刷完」= 几条连着刷完' },
            h('select', {
              value: cfg.autoScrollSpread === 'burst' ? 'burst' : 'spread',
              onChange: (e) => save({ autoScrollSpread: e.target.value }),
              style: Object.assign({}, ctlBase, { width: 200 }),
            },
              h('option', { value: 'spread' }, '摊开刷（默认）'),
              h('option', { value: 'burst' }, '一次刷完'),
            ),
          ),
          h('div', { style: { padding: '10px 0 6px' } },
            h('div', { style: { fontSize: 13, color: C.text } }, '自动跑的时间段'),
            h('div', { style: { fontSize: 12, color: C.text3, marginTop: 2 } }, '时、分分别选；跨半夜也行，比如 18:30 到第二天 09:00'),
            h('div', { style: { fontSize: 12, color: C.text3, marginTop: 2 } }, '每段后面填「这段看几条」：不填就用「每天最多」剩下的额度按段长分。'),
            (cfg.autoScrollWhen === 'window' ? null : h('div', { style: { fontSize: 12, color: '#b26a00', marginTop: 4 } },
              '现在是「开机就刷」，下面这几段不起作用。要按它来，把上面的「什么时候刷」改成「按设定时间段」。')),
            h('div', { style: { marginTop: 10, display: 'flex', flexDirection: 'column', gap: 8 } },
              ...rows.map((r, i) => h('div', { key: 'w' + i, style: { display: 'flex', alignItems: 'center', gap: 8 } },
                timeSel(i, 'start'),
                h('span', { style: { fontSize: 12, color: C.text3 } }, '到'),
                timeSel(i, 'end'),
                // 2026-11-18（主人要的）：这个时间段里看几条
                h('span', { style: { fontSize: 12, color: C.text3, marginLeft: 4 } }, '这段看'),
                h('input', {
                  type: 'number', min: 0, max: 30, value: r.per || '',
                  placeholder: '不限',
                  onChange: (e) => {
                    const next = rows.slice();
                    next[i] = Object.assign({}, next[i], { per: Math.max(0, Number(e.target.value) || 0) });
                    commit(next);
                  },
                  style: Object.assign({}, ctlBase, { width: 64, textAlign: 'right' }),
                }),
                h('span', { style: { fontSize: 12, color: C.text3 } }, '条'),
                h('button', {
                  type: 'button',
                  onClick: () => commit(rows.filter((_, j) => j !== i)),
                  style: Object.assign({}, ctlBase, { width: 32, cursor: 'pointer', color: C.text2 }),
                }, '−'),
              )),
              h('button', {
                type: 'button',
                onClick: () => commit(rows.concat([{ start: '', end: '', per: 0 }])),
                style: Object.assign({}, ctlBase, { marginTop: 2, width: 'auto', alignSelf: 'flex-start', padding: '0 12px', cursor: 'pointer', color: C.text2 }),
              }, '+ 添加时间段'),
            ),
          ),
          h(Row, {
            label: '每天最多刷几条',
            hint: '所有时间段加起来的上限；填 0 = 不自动刷'
              + (Number(cfg.autoScrollTodayCount) > 0 ? '。今天已经刷了 ' + cfg.autoScrollTodayCount + ' 条，刷到上限今天就不再刷' : ''),
          },
            h('input', {
              type: 'number', min: 0, max: 50, value: cfg.autoScrollPerDay,
              onChange: (e) => save({ autoScrollPerDay: Number(e.target.value) }),
              style: Object.assign({}, ctlBase, { width: 84, textAlign: 'right' }),
            }),
          ),
          h(Row, { label: '结果私信发给我' }, h(Switch, { checked: !!cfg.autoScrollDeliverDm, onChange: (v) => save({ autoScrollDeliverDm: v }) })),
          // 2026-11-18（主人拍板）：发卡片还是发文字 —— 卡片有封面、点开就能看，长链接一屏 URL 太难看。
          h(Row, {
            label: '结果怎么发',
            hint: '「视频卡片」= 带封面、点开就能看（默认）；「文字链接」= 一行文字加网址。卡片发不出去会自动退回文字链接。',
          },
            h('select', {
              value: cfg.autoScrollDeliverAs === 'text' ? 'text' : 'card',
              onChange: (e) => save({ autoScrollDeliverAs: e.target.value }),
              style: Object.assign({}, ctlBase, { width: 200 }),
            },
              h('option', { value: 'card' }, '视频卡片（默认）'),
              h('option', { value: 'text' }, '文字链接'),
            )),
          // 2026-11-18：刷到之后叫醒它自己读一遍（转写＋抽帧），再跟你讲值不值得看
          h(Row, {
            label: '让它自己看一遍',
            hint: '刷到之后叫醒 DSH 里那条对话，它自己转写＋抽几帧读一遍，再跟你说值不值得看。'
              + '代价：每条要多跑一次模型，一天几条会多花点 token。',
          }, h(Switch, { checked: cfg.autoScrollAgentRead !== false, onChange: (v) => save({ autoScrollAgentRead: v }) })),
        ),

        h(Card, { title: '日报（可选）' },
          h(Row, { label: '写日报文件', hint: '默认不生成；开了每天生成一份文本文件（记事本能打开）' }, h(Switch, { checked: !!cfg.autoScrollWriteReport, onChange: (v) => save({ autoScrollWriteReport: v }) })),
          h(Row, { label: '日报目录', hint: '不填就存在这个文件夹里：' + (cfg.dataDir || '插件数据目录') },
            h('input', {
              value: cfg.autoScrollReportDir || '',
              onChange: (e) => save({ autoScrollReportDir: e.target.value }),
              placeholder: (cfg.dataDir || '不填 = 插件数据目录'),
              style: Object.assign({}, ctlBase, { width: 240 }),
            }),
          ),
        ),
        h(Card, { title: '视频分析', anchor: 'analyze' },
          h(Row, {
            label: '读视频画面上的文字',
            hint: '默认关。关着 = 只把说的话转成文字，一条 2 分钟视频十几秒就好。'
              + '开着 = 连画面里叠的字也一起认出来（字在哪都能认），字幕更准。'
              + '代价：很费电脑 CPU，一条 2 分钟视频要多等约 5 分钟，这期间你电脑会明显变慢。'
              + '只有需要逐字引用台词、或画面有字但没人念的时候才开。',
          }, h(Switch, { checked: !!cfg.subtitleOcr, onChange: (v) => save({ subtitleOcr: v }) })),
          h(Row, {
            label: '收到视频分享卡片',
            hint: '你私信里转一条视频给它时怎么办。'
              + '「主动看」= 先转文字、抽画面拼图，再照内容回你（默认）。'
              + '「只当话题聊」= 它跟着聊，不下载、不转写，你说要看它才看。',
          },
            h('select', {
              value: cfg.shareCardMode || 'analyze',
              onChange: (e) => save({ shareCardMode: e.target.value }),
              style: Object.assign({}, ctlBase, { width: 220 }),
            }, [
              h('option', { key: 'analyze', value: 'analyze' }, '主动看（默认）'),
              h('option', { key: 'chat', value: 'chat' }, '只当话题聊'),
            ])),
          h(Row, {
            label: '私信里发来的图片、表情包',
            hint: '「看懂再回」= 先把图读一遍再答（默认）；「当没看见」= 只按文字回，省时间也省流量',
          },
            h('select', {
              value: cfg.imageMode || 'read',
              onChange: (e) => save({ imageMode: e.target.value }),
              style: Object.assign({}, ctlBase, { width: 220 }),
            }, [
              h('option', { key: 'read', value: 'read' }, '看懂再回（默认）'),
              h('option', { key: 'skip', value: 'skip' }, '当没看见'),
            ])),
        ),
        h(Card, { title: '人设', anchor: 'persona' },
          h(Row, { label: '当前人设', hint: '人设只影响这个 Bot 回话的语气和称呼，不会把这段文字发给对方；换完下一条消息就生效，不用重启' },
            h('select', {
              value: cfg.personaPreset || '',
              onChange: (e) => mutatePersonas({ action: 'set-current', id: e.target.value }),
              style: Object.assign({}, ctlBase, { width: 300 }),
            }, [
              h('option', { key: '', value: '' }, '不用（不挂人设）'),
            ].concat((personas && personas.list ? personas.list : []).map((p) =>
              h('option', { key: p.id, value: p.id },
                p.name + (p.builtin ? '（内置）' : '（导入）') + (p.enabled === false ? '·已停用' : '')),
            ))),
          ),
          pNote ? h('div', { style: { fontSize: 12, color: T.info, marginBottom: 6 } }, pNote) : null,
          personas && personas.list
            ? h('div', { style: { fontSize: 11, color: C.text3, margin: '-2px 0 6px' } },
                '保存在本机 · 现有 ' + personas.list.length + ' 套（内置的不能改，你自己导入的能改名 / 停用 / 删除）')
            : null,
          h('div', { style: { padding: '8px 0 10px' } },
            personaRows.length
              ? personaRows
              : h('div', { style: { fontSize: 12, color: C.text3, padding: '6px 0' } }, '人设列表没读出来（看上面的提示，或者刷新页面再试）'),
          ),
          h('div', { style: { padding: '4px 0 12px', borderTop: '1px solid ' + C.line } },
            h('div', { style: { fontSize: 13, color: C.text, marginTop: 8 } }, '导入一套自己的'),
            h('div', { style: { fontSize: 12, color: C.text3, marginTop: 2 } }, '存一份在本机，跟插件一起留着；也可以直接选一个文本文件，整篇当人设正文'),
            h('div', { style: { display: 'flex', gap: 8, marginTop: 8, alignItems: 'center' } },
              h('input', {
                value: pDraft.name,
                onChange: (e) => setPDraft(Object.assign({}, pDraft, { name: e.target.value })),
                placeholder: '名字，例如：我的口头禅版',
                style: Object.assign({}, ctlBase, { width: 240, fontSize: 12 }),
              }),
              h('label', {
                style: Object.assign({}, btnBase, {
                  display: 'inline-flex', alignItems: 'center', height: 32, padding: '0 10px', borderRadius: 8,
                }),
              }, '选一个文本文件',
                h('input', {
                  type: 'file', accept: '.md,.markdown,.txt', style: { display: 'none' },
                  onChange: (e) => {
                    const f = e.target.files && e.target.files[0];
                    if (!f) { e.target.value = ''; return; }
                    const rd = new FileReader();
                    rd.onload = () => {
                      const txt = String(rd.result || '');
                      setPDraft((d) => ({ name: d.name || f.name.replace(/\.(md|markdown|txt)$/i, ''), text: txt }));
                    };
                    rd.onerror = () => setPNote('读文件失败：' + f.name);
                    rd.readAsText(f, 'utf-8');
                    e.target.value = ''; // 允许再选同一个文件
                  },
                }),
              ),
            ),
            h('textarea', {
              value: pDraft.text,
              onChange: (e) => setPDraft(Object.assign({}, pDraft, { text: e.target.value })),
              rows: 5,
              placeholder: '人设正文：它是谁、怎么说话、口头禅、哪些话不许说……越具体越像',
              style: Object.assign({}, ctlBase, { width: '100%', height: 'auto', padding: 8, marginTop: 8, fontSize: 12, lineHeight: '18px', boxSizing: 'border-box' }),
            }),
            h('div', { style: { marginTop: 8, display: 'flex', gap: 8, alignItems: 'center' } },
              h('button', {
                type: 'button', onClick: submitImport,
                style: Object.assign({}, btnBase, { height: 30, padding: '0 14px', fontSize: 13 }),
              }, '导入'),
              h('button', {
                type: 'button', onClick: () => setPDraft({ name: '', text: '' }),
                style: Object.assign({}, btnBase, { height: 30, padding: '0 12px', fontSize: 13 }),
              }, '清空'),
              h('span', { style: { fontSize: 12, color: C.text3 } }, '已填 ' + String(pDraft.text || '').length + ' 字'),
            ),
          ),
        ),
        h(Card, { title: '公开评论（评论区专用）', anchor: 'public' },
          h('div', { style: { padding: '0 0 4px' } },
            h('div', { style: { fontSize: 13, color: C.text } }, '公开评论语气'),
            h('div', { style: { fontSize: 12, color: C.text3, marginTop: 2 } }, '跟上面的人设分开：评论区是公开的，别把私信里那套称呼和卖萌动作搬过去；留空 = 不加额外要求'),
            h('textarea', {
              defaultValue: cfg.personaPublic || '',
              key: 'personaPublic',
              onBlur: (e) => save({ personaPublic: e.target.value }),
              rows: 3,
              placeholder: '例如：简短、礼貌、不卖萌、不承诺任何事，最多两句',
              style: Object.assign({}, ctlBase, { width: '100%', height: 'auto', padding: 8, marginTop: 8, fontSize: 12, lineHeight: '18px', boxSizing: 'border-box' }),
            }),
          ),
          h(Row, { label: '禁止词', hint: '不许出现的词，用逗号隔开（中英文逗号都行）；命中就整条不发。这些通常是 AI 最容易顺嘴说的客服腔' },
            h('input', {
              value: cfg.personaBannedWords || '',
              onChange: (e) => save({ personaBannedWords: e.target.value }),
              placeholder: '亲,客服腔,欢迎关注,家人们,已读',
              style: Object.assign({}, ctlBase, { width: 320 }),
            }),
          ),
          h(Row, { label: '评论最多几个字', hint: '公开评论越短越安全；这个数就是上限，超过会被截短' },
            h('input', {
              type: 'number', min: 10, max: 500,
              value: Number(cfg.commentMaxChars) || 60,
              onChange: (e) => save({ commentMaxChars: Number(e.target.value) || 60 }),
              style: Object.assign({}, ctlBase, { width: 100 }),
            }),
          ),
          h(Row, { label: '频次上限', hint: '两个框里现在填的数就是上限，超了不发（防止被平台判成刷屏）。同一句话 7 天内不会重复发' },
            h('div', { style: { display: 'flex', gap: 8, alignItems: 'center' } },
              h('input', {
                type: 'number', min: 1, max: 100,
                value: Number(cfg.commentPerHour) || 6,
                onChange: (e) => save({ commentPerHour: Number(e.target.value) || 6 }),
                style: Object.assign({}, ctlBase, { width: 80 }),
              }),
              h('span', { style: { fontSize: 12, color: C.text3 } }, '条/小时'),
              h('input', {
                type: 'number', min: 1, max: 500,
                value: Number(cfg.commentPerDay) || 30,
                onChange: (e) => save({ commentPerDay: Number(e.target.value) || 30 }),
                style: Object.assign({}, ctlBase, { width: 80 }),
              }),
              h('span', { style: { fontSize: 12, color: C.text3 } }, '条/天'),
            ),
          ),
        ),
        h(Card, { title: '评论区自动回（可选）', anchor: 'autoreply' },
          h(Row, { label: '自动回评论', hint: '总开关；关掉下面两项都不跑。开启后别人能看到你的回复' },
            h(Switch, { checked: !!cfg.commentAutoReply, onChange: (v) => save({ commentAutoReply: v }) }),
          ),
          // 2026-10-28 按主人要求拆成两类：自己作品下（正常互动）/ 别人视频下（容易被当刷屏）
          h(Row, { label: '回自己作品下的评论', hint: '别人在我发的作品底下留言 → 我去回；这是正常互动，默认开' },
            h(Switch, {
              checked: cfg.commentAutoReplyWork !== false,
              onChange: (v) => save({ commentAutoReplyWork: v }),
            }),
          ),
          h(Row, { label: '回复别人在我评论下的留言', hint: '有人在你评论下面回你时，由这个 Bot 去接；容易被平台当成刷屏，默认关' },
            h(Switch, {
              checked: !!cfg.commentAutoReplyOthers,
              onChange: (v) => save({ commentAutoReplyOthers: v }),
            }),
          ),
          h(Row, { label: '扫描间隔', hint: '隔几分钟看一次新评论。框里这个数就是现在用的（' + ((Number(cfg.commentScanMinutes) || 10) >= 60 ? ('约 ' + Math.round((Number(cfg.commentScanMinutes) || 10) / 60) + ' 小时看一次，太久了') : ('每 ' + (Number(cfg.commentScanMinutes) || 10) + ' 分钟看一次')) + '）；填太小会频繁读页面，容易触发验证码' },
            h('input', {
              type: 'number', min: 5, max: 120,
              value: Number(cfg.commentScanMinutes) || 10,
              onChange: (e) => save({ commentScanMinutes: Math.min(120, Math.max(5, Number(e.target.value) || 10)) }),
              style: Object.assign({}, ctlBase, { width: 100 }),
            }),
          ),
          h(Row, { label: '每次最多回', hint: '每轮最多处理几条新评论。数字越小越安全，没处理完的下一轮接着来' },
            h('input', {
              type: 'number', min: 1, max: 20,
              value: Number(cfg.commentMaxPerRound) || 3,
              onChange: (e) => save({ commentMaxPerRound: Number(e.target.value) || 3 }),
              style: Object.assign({}, ctlBase, { width: 100 }),
            }),
          ),
          h(Row, { label: '只回多久以内', hint: '小时；超过就不回了，别翻旧账' },
            h('input', {
              type: 'number', min: 1, max: 720,
              value: Number(cfg.commentNoticeMaxAgeHours) || 48,
              onChange: (e) => save({ commentNoticeMaxAgeHours: Number(e.target.value) || 48 }),
              style: Object.assign({}, ctlBase, { width: 100 }),
            }),
          ),
          h(Row, { label: '作品发布超过几天就不回', hint: '按作品发布时间算，不是评论时间。老视频下的新评论也不回；填 0 = 不限' },
            h('input', {
              type: 'number', min: 0, max: 365,
              value: Number(cfg.commentWorkMaxAgeDays) || 0,
              onChange: (e) => save({ commentWorkMaxAgeDays: Number(e.target.value) || 0 }),
              style: Object.assign({}, ctlBase, { width: 100 }),
            }),
          ),
          h(Row, { label: '这些账号不回', hint: '机器人或平台客服号，用逗号隔开。它们的评论常被折叠 —— 你这边提示发送成功，其实已被删掉' },
            h('input', {
              value: cfg.commentSkipNicks || '',
              onChange: (e) => save({ commentSkipNicks: e.target.value }),
              placeholder: '豆包,抖音求真',
              style: Object.assign({}, ctlBase, { width: 240 }),
            }),
          ),
          h(Row, { label: '只有 @ 的不回', hint: '比如「@本鲸不胖」这种没有可接内容的：回"在呢"就像客服机器人' },
            h(Switch, { checked: cfg.commentSkipPureMention !== false, onChange: (v) => save({ commentSkipPureMention: v }) }),
          ),
          h(Row, { label: '我的作品', hint: '视频链接（抖音里点分享 → 复制链接），多个用逗号隔开。填了这个 Bot 才会主动去翻这些视频的评论；不填也会在收到评论通知时自己记住' },
            h('input', {
              value: cfg.myWorks || '',
              onChange: (e) => save({ myWorks: e.target.value }),
              placeholder: 'https://www.douyin.com/video/74xxxxxxxxxxxxxxx',
              style: Object.assign({}, ctlBase, { width: 380 }),
            }),
          ),
          // 2026-10-28：明确显示"记住了几个作品"+ 每个作品一行，别再让人猜
          h('div', { style: { fontSize: 12, color: C.text3, paddingTop: 6, lineHeight: '20px' } },
            (() => {
              const list = String(cfg.myWorks || '').split(/[,，\s]+/).map((x) => x.trim()).filter(Boolean)
              if (!list.length) return '已记住作品：0 个（还没有——收到作品评论通知会自动记住，也可以在下面手动填链接）'
              return '已记住作品：' + list.length + ' 个 · ' + list.slice(0, 3).map((x) => x.replace(/^.*\/video\//, '')).join('、') + (list.length > 3 ? ' …' : '')
            })(),
          ),
          cfg.commentScan
            ? h('div', { style: { fontSize: 12, color: C.text3, paddingTop: 6 } },
                '上次扫描：' + new Date(cfg.commentScan.at).toLocaleTimeString(undefined, { hour12: false }) +
                ' · 待回 ' + (cfg.commentScan.picked || 0) + ' 条' +
                (cfg.commentScan.works ? ' · 看了 ' + cfg.commentScan.works + ' 个作品' : '') +
                (cfg.commentScan.added ? '（新记住 ' + cfg.commentScan.added + ' 个）' : ''))
            : null,
        ),
        h(Card, { title: '维护', anchor: 'maint' },
          h(Row, { label: '浏览器窗口', hint: '平时让它后台跑。遇到验证码就点右边按钮：会弹出一个看得见的窗口，你手动划一下滑块，划完把左边选回「后台运行」就切回来了' },
            h('div', { style: { display: 'flex', alignItems: 'center', gap: 8 } },
              h('select', {
                value: cfg.browserMode || 'headless',
                onChange: (e) => {
                  const m = e.target.value
                  setNote(m === 'headed' ? '正在打开浏览器窗口（重启浏览器，稍等）…' : '正在切回后台运行（重启浏览器）…')
                  fetch('/api/douyin-watch/browser-mode', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ mode: m }) })
                    .then((r) => r.json())
                    .then((d) => setNote(d.ok
                      ? ('已切到' + (d.mode === 'headed' ? '浏览器窗口' : '后台运行') + (d.verify ? '｜滑块已出现，去划' : ''))
                      : ('切换失败：' + (d.error || '未知'))))
                    .catch(() => setNote('切换失败：接口没返回'))
                    .then(() => load())
                },
                style: Object.assign({}, ctlBase, { width: 132 }),
              },
                h('option', { value: 'headless' }, '后台运行（平时用）'),
                h('option', { value: 'headed' }, '显示浏览器窗口（过验证码用）'),
              ),
              h('button', {
                type: 'button',
                disabled: switching,
                onClick: () => {
                  if (switching) return
                  setSwitching(true)
                  setNote('正在打开浏览器窗口并跳到视频页（重启浏览器，十几秒）…')
                  fetch('/api/douyin-watch/browser-mode', {
                    method: 'POST', headers: { 'content-type': 'application/json' },
                    body: JSON.stringify({ mode: 'headed' }),
                  })
                    .then((r) => r.json())
                    .then((d) => setNote(d.ok
                      ? (d.verify ? '浏览器窗口已弹出，滑块就在这个页面上，去划一下' : '浏览器窗口已打开目标页，但这次没弹验证码（说明暂时不需要）')
                      : ('切换失败：' + (d.error || '未知'))))
                    .catch(() => setNote('切换失败：接口没返回'))
                    .then(() => { setSwitching(false); load() })
                },
                style: Object.assign({}, ctlBase, { width: 'auto', padding: '0 10px', cursor: switching ? 'default' : 'pointer', color: C.text2 }),
              }, switching ? '切换中…' : '打开窗口去验证'),
            ),
          ),
          h(Row, { label: '清理浏览器缓存', hint: '会删两样东西：浏览器产生的临时文件，和插件自己存下来的 7 天前私信图片副本。抖音里的聊天记录和登录状态都不动' },
            h('button', {
              type: 'button',
              onClick: () => {
                if (cleaning) return
                setCleaning(true)
                setNote('正在清理（会先关掉后台浏览器，几十秒）…')
                fetch('/api/douyin-watch/cleanup', { method: 'POST' })
                  .then((r) => r.json())
                  .then((d) => {
                    if (d.ok) setNote(`清理完成：释放 ${d.freedMB} MB（${(d.removed || []).length} 项），登录态保留`)
                    else setNote('清理出错：' + ((d.errors && d.errors[0]) || '未知'))
                  })
                  .catch(() => setNote('清理失败：接口没返回'))
                  .then(() => setCleaning(false))
              },
              disabled: cleaning,
              style: Object.assign({}, ctlBase, { width: 'auto', padding: '0 12px', cursor: cleaning ? 'default' : 'pointer', color: C.text2 }),
            }, cleaning ? '清理中…' : '清理缓存'),
          ),
        ),

        // 结尾这张卡：真诚求个星（不弹窗、不打扰，就一个小按钮）
        h(Card, { title: '觉得好用？' },
          h('div', { style: { fontSize: 12, color: C.text2, lineHeight: '21px' } },
            '要是这条赛博小鱼帮你省了点事，可以在 GitHub 上给它点个星。星多一点，愿意一起修问题、加功能的人也会多一点，它才能活得更久。'),
          h('button', {
            type: 'button',
            onClick: () => { try { window.open('https://github.com/miqian-nomad/dsh-douyin-watch', '_blank') } catch { /* 打不开就算了 */ } },
            style: Object.assign({}, ctlBase, { width: 'auto', marginTop: 8, padding: '0 12px', cursor: 'pointer', color: C.text }),
          }, '去 GitHub 点个星'),
        ),

        note ? h('div', { style: { marginTop: 12, fontSize: 12, color: C.text3 } }, note) : null,
      );
    }

    return {
      inject: ['slots'],
      apply(ctx) {
        ctx.slots.inject('settings.section', () => ctx.slots.register(
          { name: 'settings.section', id: 'douyin-watch', order: 31, label: '抖音小助手' },
          Panel,
        ));
      },
    };
  },
});
