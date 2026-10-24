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
      line: 'var(--dsw-alias-border-l, rgba(0,0,0,0.10))',
      text: 'var(--dsw-alias-label-primary, #0f1115)',
      text2: 'var(--dsw-alias-label-secondary, rgba(15,17,21,0.72))',
      text3: 'var(--dsw-alias-label-tertiary, rgba(15,17,21,0.45))',
      card: 'var(--dsw-alias-bg-base, #ffffff)',
      brand: 'var(--dsw-alias-brand-primary, #0f1115)',
    };

    const parseWin = (s) => {
      const m = /^(\d{1,2}:\d{2})\s*-\s*(\d{1,2}:\d{2})$/.exec(String(s || '').trim());
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

    function Card({ title, children }) {
      return h('div', { style: { marginTop: 14 } },
        h('div', { style: { fontSize: 12.5, fontWeight: 600, color: C.text2, margin: '2px 0 8px 2px' } }, title),
        h('div', {
          style: {
            border: '1px solid ' + C.line, borderRadius: 12, background: C.card,
            padding: '4px 16px',
          },
        }, children),
      );
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
      return h('div', { style: { display: 'flex', alignItems: 'center', gap: 8 } },
        h('select', {
          value: current || '',
          onChange: (e) => onPick(e.target.value),
          style: Object.assign({}, ctlBase, { width: 330, fontSize: 12 }),
        },
          h('option', { value: '' }, '（不钉死：按工作目录找）'),
          ...items.map((s) => h('option', { key: s.id, value: s.id },
            `${shortCwd(s.cwd) || s.id.slice(0, 14)}${s.live ? ' · 运行中' : ''}${s.blank ? ' · 空白' : ''}${fmtTime(s.updatedAt) ? ' · ' + fmtTime(s.updatedAt) : ''}`)),
          (current && !known) ? h('option', { value: current }, '当前：' + current.slice(0, 20) + '…') : null,
        ),
        h('button', {
          type: 'button', onClick: load,
          style: Object.assign({}, ctlBase, { width: 'auto', padding: '0 10px', cursor: 'pointer', color: C.text2 }),
        }, busy ? '…' : '刷新'),
      );
    }

    // 运行状态卡片：绿=运行中、灰=已停止、红=有错误。数据每 5 秒刷新一次（宿主 side 拼好）。
    function StatusCard({ s }) {
      const row = (k, v) => h('div', {
        style: { display: 'flex', gap: 10, fontSize: 12, color: C.text2, lineHeight: '20px' },
      },
        h('span', { style: { color: C.text3, flex: '0 0 auto', minWidth: 56 } }, k),
        h('span', { style: { minWidth: 0, wordBreak: 'break-all' } }, v || '—'),
      );
      if (!s) {
        return h(Card, { title: '运行状态' },
          h('div', { style: { padding: '10px 0', fontSize: 12, color: C.text3 } }, '读取中…'),
        );
      }
      const running = !!s.enabled;
      const bad = !!s.lastError;
      const color = bad ? '#c0392b' : (running ? '#2e7d32' : 'rgba(120,125,135,0.55)');
      return h(Card, { title: '运行状态' },
        h('div', { style: { display: 'flex', alignItems: 'center', gap: 8, padding: '8px 0 6px' } },
          h('span', { style: { width: 8, height: 8, borderRadius: 4, background: color, flex: '0 0 auto' } }),
          h('span', { style: { fontSize: 13, fontWeight: 600, color: bad ? '#c0392b' : C.text } },
            bad ? '出错' : (running ? '运行中' : '已停止')),
          h('span', { style: { fontSize: 12, color: C.text3 } },
            running ? `盯 ${s.bound || 0} 个会话` : '不读消息、不唤醒'),
        ),
        row('最后读取', s.lastRead ? `${s.lastRead}（${s.lastCount || 0} 条）` : ''),
        row('最后唤醒', s.lastWake || '无'),
        bad ? row('错误', s.lastError) : null,
      );
    }

    function Panel() {
      const [cfg, setCfg] = useState(null);
      const [rows, setRows] = useState(null);
      const [note, setNote] = useState('');
      const [status, setStatus] = useState(null);
      const [cleaning, setCleaning] = useState(false);
      const [injecting, setInjecting] = useState(false);

      const load = () => fetch('/api/douyin-watch/config')
        .then((r) => r.json())
        .then((d) => {
          const c = d.config || {};
          setCfg(c);
          setStatus(c.status || null);
          setRows((Array.isArray(c.autoScrollWindows) ? c.autoScrollWindows : []).map(parseWin));
        })
        .catch(() => setNote('读配置失败：接口没返回（宿主报错，见 DSH 日志）'));
      useEffect(() => {
        load();
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

      // 失败时别再一直显示「加载中…」：把 note 里的错误直接显示出来（2026-10-24：那次 400 就是这么被吞掉的）
      if (!cfg || !rows) return h('div', { style: { padding: 16, fontSize: 13, color: note ? '#c0392b' : C.text3 } }, note || '加载中…');

      const commit = (next) => {
        setRows(next);
        save({ autoScrollWindows: next.filter((r) => r.start && r.end).map((r) => r.start + '-' + r.end) });
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

      return h('div', { style: { padding: '4px 0 16px' } },

        h('div', {
          style: {
            display: 'flex', alignItems: 'center', justifyContent: 'space-between',
            gap: 16, padding: '10px 16px', marginTop: 4,
            border: '1px solid ' + C.line, borderRadius: 12, background: C.card,
          },
        },
          h('div', null,
            h('div', { style: { fontSize: 13.5, fontWeight: 600, color: C.text } }, '启用插件'),
            h('div', { style: { fontSize: 12, color: C.text3 } }, '总开关：关掉后不读私信、不自动回复'),
          ),
          h(Switch, { checked: !!cfg.enabled, onChange: (v) => save({ enabled: v }) }),
        ),

        h(StatusCard, { s: status }),

        h(Card, { title: '私信哨兵' },
          h(Row, { label: '主人' },
            h('span', { style: { fontSize: 13, color: C.text2 } }, cfg.peer || '（未配置）'),
          ),
          h(Row, { label: '钉死会话', hint: '只往这条会话投递；它没开着会自动恢复（resume）。新建的会话点「刷新」就出现' },
            h(SessionPicker, { current: cfg.sessionId || '', onPick: (v) => save({ sessionId: v }) }),
          ),
          h(Row, { label: '主人消息自动回复', hint: '关 = 只提醒，不自动回' }, h(Switch, { checked: !!cfg.ownerAutoReply, onChange: (v) => save({ ownerAutoReply: v }) })),
          h(Row, { label: '私信发什么', hint: '「完整结论」= 手机上看到的就是结论本身；「简版」= DSH 写详细、私信只发一段' },
            h('select', {
              value: cfg.replyMode || 'conclusion',
              onChange: (e) => save({ replyMode: e.target.value }),
              style: Object.assign({}, ctlBase, { width: 132 }),
            },
              h('option', { value: 'conclusion' }, '完整结论'),
              h('option', { value: 'brief' }, '简版'),
            ),
          ),
          h(Row, { label: '非主人消息' },
            h('select', {
              value: cfg.strangerPolicy || 'notify',
              onChange: (e) => save({ strangerPolicy: e.target.value }),
              style: Object.assign({}, ctlBase, { width: 132 }),
            },
              h('option', { value: 'notify' }, '只提醒，不回'),
              h('option', { value: 'reply' }, '可以回，也提醒'),
              h('option', { value: 'ignore' }, '不回也不提醒'),
            ),
          ),
          h(Row, { label: '轮询间隔', hint: '单位：秒' },
            h('input', {
              type: 'number', min: 10, max: 3600, value: cfg.intervalSeconds,
              onChange: (e) => save({ intervalSeconds: Number(e.target.value) }),
              style: Object.assign({}, ctlBase, { width: 84, textAlign: 'right' }),
            }),
          ),
        ),

        h(Card, { title: '自动刷视频' },
          h(Row, { label: '开启自动刷视频', hint: '关掉就完全不跑' }, h(Switch, { checked: !!cfg.autoScrollEnabled, onChange: (v) => save({ autoScrollEnabled: v }) })),
          h('div', { style: { padding: '10px 0 6px' } },
            h('div', { style: { fontSize: 13, color: C.text } }, '自动跑的时间段'),
            h('div', { style: { fontSize: 12, color: C.text3, marginTop: 2 } }, '时、分分别选；跨零点直接选（18:30 → 09:00）'),
            h('div', { style: { marginTop: 10, display: 'flex', flexDirection: 'column', gap: 8 } },
              ...rows.map((r, i) => h('div', { key: 'w' + i, style: { display: 'flex', alignItems: 'center', gap: 8 } },
                timeSel(i, 'start'),
                h('span', { style: { fontSize: 12, color: C.text3 } }, '到'),
                timeSel(i, 'end'),
                h('button', {
                  type: 'button',
                  onClick: () => commit(rows.filter((_, j) => j !== i)),
                  style: Object.assign({}, ctlBase, { width: 32, cursor: 'pointer', color: C.text2 }),
                }, '−'),
              )),
              h('button', {
                type: 'button',
                onClick: () => commit(rows.concat([{ start: '', end: '' }])),
                style: Object.assign({}, ctlBase, { marginTop: 2, width: 'auto', alignSelf: 'flex-start', padding: '0 12px', cursor: 'pointer', color: C.text2 }),
              }, '+ 添加时间段'),
            ),
          ),
          h(Row, { label: '每天最多刷几条', hint: '0 = 不自动跑' },
            h('input', {
              type: 'number', min: 0, max: 50, value: cfg.autoScrollPerDay,
              onChange: (e) => save({ autoScrollPerDay: Number(e.target.value) }),
              style: Object.assign({}, ctlBase, { width: 84, textAlign: 'right' }),
            }),
          ),
          h(Row, { label: '结果私信发给我' }, h(Switch, { checked: !!cfg.autoScrollDeliverDm, onChange: (v) => save({ autoScrollDeliverDm: v }) })),
        ),

        h(Card, { title: '日报（可选）' },
          h(Row, { label: '写日报文件', hint: '默认关；开了才落 .md' }, h(Switch, { checked: !!cfg.autoScrollWriteReport, onChange: (v) => save({ autoScrollWriteReport: v }) })),
          h(Row, { label: '日报目录', hint: '留空 = 当前工作区' },
            h('input', {
              value: cfg.autoScrollReportDir || '',
              onChange: (e) => save({ autoScrollReportDir: e.target.value }),
              placeholder: 'D:\\path\\to\\dir',
              style: Object.assign({}, ctlBase, { width: 240 }),
            }),
          ),
        ),
        h(Card, { title: '人设' },
          h(Row, { label: '一行短人设', hint: '跟着每次唤醒走，建议 ≤60 字（每轮都带，别写长）' },
            h('input', {
              value: cfg.personaShort || '',
              onChange: (e) => save({ personaShort: e.target.value }),
              placeholder: '例如：说话简短、带点调侃，别用敬语',
              style: Object.assign({}, ctlBase, { width: 320 }),
            }),
          ),
          h('div', { style: { padding: '10px 0 6px' } },
            h('div', { style: { fontSize: 13, color: C.text } }, '完整人设（建议 ≤300 字）'),
            h('div', { style: { fontSize: 12, color: C.text3, marginTop: 2 } }, '不会每轮发；点下面按钮才注入当前会话，之后靠会话记忆生效'),
            h('textarea', {
              defaultValue: cfg.personaFull || '',
              key: 'personaFull',
              onBlur: (e) => save({ personaFull: e.target.value }),
              rows: 4,
              placeholder: '性格、口头禅、回答习惯、禁忌……',
              style: Object.assign({}, ctlBase, { width: '100%', height: 'auto', padding: 8, marginTop: 8, fontSize: 12, lineHeight: '18px', boxSizing: 'border-box' }),
            }),
            h('div', { style: { marginTop: 8, display: 'flex', gap: 8, alignItems: 'center' } },
              h('button', {
                type: 'button',
                onClick: () => {
                  if (injecting) return
                  setInjecting(true)
                  setNote('正在注入人设…')
                  fetch('/api/douyin-watch/persona/inject', { method: 'POST' })
                    .then((r) => r.json())
                    .then((d) => setNote(d.ok ? ('人设已注入（' + d.via + '，' + d.chars + ' 字）') : ('注入失败：' + (d.error || '未知'))))
                    .catch(() => setNote('注入失败：接口没返回'))
                    .then(() => setInjecting(false))
                },
                disabled: injecting,
                style: Object.assign({}, ctlBase, { width: 'auto', padding: '0 12px', cursor: injecting ? 'default' : 'pointer', color: C.text2 }),
              }, injecting ? '注入中…' : '注入到当前会话'),
              h('span', { style: { fontSize: 12, color: C.text3 } }, '已填 ' + (cfg.personaFull || '').length + ' 字'),
            ),
          ),
        ),
        h(Card, { title: '维护' },
          h(Row, { label: '清理浏览器缓存', hint: '只删 Cache / Code Cache 等可重建目录 + 7 天前的收件箱图片；Cookies 与本地存储一个字节不动' },
            h('button', {
              type: 'button',
              onClick: () => {
                if (cleaning) return
                setCleaning(true)
                setNote('正在清理（会先关掉那个无头浏览器，几十秒）…')
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
