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
    // 2026-10-28 改成「一行状态 + 2×2 指标」：把最该看的四个数摆出来
    //   （今日评论额度 / 最后读取 / 签名直连 / 依赖），别让卡里空着。
    function StatusCard({ s, q }) {
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
      const color = bad ? '#c0392b' : (running ? '#2e7d32' : 'rgba(120,125,135,0.55)');
      const quota = q || {};
      const quotaTxt = quota.perHour ? `${quota.hour || 0}/${quota.perHour} 条·时　${quota.day || 0}/${quota.perDay} 条·天` : '';
      const signedTxt = s.signed ? (s.signedDeps ? '可用（走快路）' : '缺依赖，会退回页面') : '未安装（走页面）';
      const signedTone = s.signed && s.signedDeps ? '#2e7d32' : (s.signed ? '#b26a00' : 'rgba(120,125,135,0.75)');
      return h(Card, { title: '运行状态' },
        h('div', { style: { display: 'flex', alignItems: 'center', gap: 8, padding: '8px 0 10px' } },
          h('span', { style: { width: 8, height: 8, borderRadius: 4, background: color, flex: '0 0 auto' } }),
          h('span', { style: { fontSize: 13, fontWeight: 600, color: bad ? '#c0392b' : C.text } },
            bad ? '出错' : (running ? '运行中' : '已停止')),
          h('span', { style: { fontSize: 12, color: C.text3 } },
            running ? `盯 ${s.bound || 0} 个会话` : '不读消息、不唤醒'),
        ),
        h('div', { style: { display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 } },
          cell('今日评论额度', quotaTxt),
          cell('最后读取', s.lastRead ? `${s.lastRead}（${s.lastCount || 0} 条）` : '还没读过'),
          cell('签名直连', signedTxt, signedTone),
          cell('最后唤醒', s.lastWake || '无'),
        ),
        bad ? h('div', { style: { fontSize: 12, color: '#c0392b', marginTop: 8 } }, '错误：' + s.lastError) : null,
      );
    }

    function Panel() {
      const [cfg, setCfg] = useState(null);
      const [rows, setRows] = useState(null);
      const [note, setNote] = useState('');
      const [status, setStatus] = useState(null);
      const [cleaning, setCleaning] = useState(false);
      const [injecting, setInjecting] = useState(false);
      const [switching, setSwitching] = useState(false);

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

      // 左侧锚点没有位置放，就做一排「吸顶快捷跳转」：九组内容太长，靠它少滚两屏
      const SECTIONS = ['私信哨兵', '自动刷视频', '人设', '公开评论', '评论区自动回', '我的作品', '维护'];
      const jumpTo = (label) => {
        try {
          const root = document.querySelector('[data-dy-panel]') || document.body;
          const nodes = Array.prototype.slice.call(root.querySelectorAll('div,span,h3,h4,p'));
          // 卡片标题有两种写法：「公开评论（评论区专用）」「评论区自动回（可选）」，
          //   所以不能全等匹配，用「前缀相同 + 长度别差太多」来找，取最里层那个真正带标题的节点。
          const cand = nodes.filter((n) => {
            const t = String(n.innerText || '').trim();
            return t.indexOf(label) === 0 && t.length <= label.length + 14;
          });
          const hit = cand[cand.length - 1] || null;
          if (hit && hit.scrollIntoView) hit.scrollIntoView({ behavior: 'smooth', block: 'start' });
          return !!hit;
        } catch { return false; /* 跳转失败不影响使用 */ }
      };

      return h('div', { 'data-dy-panel': '1', style: { padding: '4px 0 16px' } },

        h('div', {
          style: {
            position: 'sticky', top: 0, zIndex: 5, display: 'flex', flexWrap: 'wrap',
            gap: 6, padding: '6px 0 8px', marginBottom: 2,
            background: C.card || 'transparent',
          },
        },
          ...SECTIONS.map((label) => h('button', {
            key: label, type: 'button', onClick: () => jumpTo(label),
            style: {
              fontSize: 12, padding: '4px 9px', borderRadius: 999, cursor: 'pointer',
              border: '1px solid ' + C.line, background: 'transparent', color: C.text2,
            },
          }, label)),
        ),

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

        h(StatusCard, { s: status, q: cfg.commentQuota }),

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
        h(Card, { title: '公开评论（评论区专用）' },
          h('div', { style: { padding: '0 0 4px' } },
            h('div', { style: { fontSize: 13, color: C.text } }, '公开评论语气'),
            h('div', { style: { fontSize: 12, color: C.text3, marginTop: 2 } }, '跟上面的人设分开：评论区是公开的，别把私信里的称呼（主人 / 卖萌动作）搬过去；留空 = 不加额外要求'),
            h('textarea', {
              defaultValue: cfg.personaPublic || '',
              key: 'personaPublic',
              onBlur: (e) => save({ personaPublic: e.target.value }),
              rows: 3,
              placeholder: '例如：简短、礼貌、不卖萌、不承诺任何事，最多两句',
              style: Object.assign({}, ctlBase, { width: '100%', height: 'auto', padding: 8, marginTop: 8, fontSize: 12, lineHeight: '18px', boxSizing: 'border-box' }),
            }),
          ),
          h(Row, { label: '禁止词', hint: '逗号分隔；命中就拒绝发送（这些是 AI 最容易顺嘴说的客服腔）' },
            h('input', {
              value: cfg.personaBannedWords || '',
              onChange: (e) => save({ personaBannedWords: e.target.value }),
              placeholder: '亲,客服腔,欢迎关注,家人们,已读',
              style: Object.assign({}, ctlBase, { width: 320 }),
            }),
          ),
          h(Row, { label: '字数上限', hint: '公开评论越短越安全' },
            h('input', {
              type: 'number', min: 10, max: 500,
              value: Number(cfg.commentMaxChars) || 60,
              onChange: (e) => save({ commentMaxChars: Number(e.target.value) || 60 }),
              style: Object.assign({}, ctlBase, { width: 100 }),
            }),
          ),
          h(Row, { label: '频次上限', hint: '超过就拒发（防批量刷评被判风控）；同一句评论 7 天内不许重发' },
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
        h(Card, { title: '评论区自动回（可选）' },
          h(Row, { label: '自动回评论', hint: '总开关；关掉下面两项都不跑。开了就是公开回复，自己掂量' },
            h(Switch, { checked: !!cfg.commentAutoReply, onChange: (v) => save({ commentAutoReply: v }) }),
          ),
          // 2026-10-28 按主人要求拆成两类：自己作品下（正常互动）/ 别人视频下（容易被当刷屏）
          h(Row, { label: '回自己作品下的评论', hint: '别人在我发的作品底下留言 → 我去回；这是正常互动，默认开' },
            h(Switch, {
              checked: cfg.commentAutoReplyWork !== false,
              onChange: (v) => save({ commentAutoReplyWork: v }),
            }),
          ),
          h(Row, { label: '回别人视频下的楼中楼', hint: '有人回复了我的评论（在别人作品下）→ 我去接；容易被当刷屏，默认关' },
            h(Switch, {
              checked: !!cfg.commentAutoReplyOthers,
              onChange: (v) => save({ commentAutoReplyOthers: v }),
            }),
          ),
          h(Row, { label: '扫描间隔', hint: '分钟；太短会频繁读页面' },
            h('input', {
              type: 'number', min: 5, max: 240,
              value: Number(cfg.commentScanMinutes) || 10,
              onChange: (e) => save({ commentScanMinutes: Number(e.target.value) || 10 }),
              style: Object.assign({}, ctlBase, { width: 100 }),
            }),
          ),
          h(Row, { label: '每次最多回', hint: '一次丢给我的条数，别一口气 20 条' },
            h('input', {
              type: 'number', min: 1, max: 10,
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
          h(Row, { label: '作品发布超过几天就不回', hint: '按「作品发布多久」算，不是评论时间。老视频下面冒出来的新评论也不回；0 = 不限' },
            h('input', {
              type: 'number', min: 0, max: 365,
              value: Number(cfg.commentWorkMaxAgeDays) || 0,
              onChange: (e) => save({ commentWorkMaxAgeDays: Number(e.target.value) || 0 }),
              style: Object.assign({}, ctlBase, { width: 100 }),
            }),
          ),
          h(Row, { label: '这些账号不回', hint: '逗号分隔；机器人/平台客服号。它们的评论常被折叠 —— 回了服务端也查不到（假成功）' },
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
          h(Row, { label: '我的作品', hint: '作品链接或 id，逗号分隔。填了才"按评论列表批量看自己视频下的评论"；不填也会自动记住（收到作品评论通知时）' },
            h('input', {
              value: cfg.myWorks || '',
              onChange: (e) => save({ myWorks: e.target.value }),
              placeholder: 'https://www.douyin.com/video/<作品id>',
              style: Object.assign({}, ctlBase, { width: 380 }),
            }),
          ),
          // 2026-10-28：明确显示"记住了几个作品"+ 每个作品一行，别再让人猜
          h('div', { style: { fontSize: 12, color: C.text3, paddingTop: 6, lineHeight: '20px' } },
            (() => {
              const list = String(cfg.myWorks || '').split(/[,，\s]+/).map((x) => x.trim()).filter(Boolean)
              if (!list.length) return '已记住作品：0 个（还没有——收到作品评论通知会自动记住，或手动填 id）'
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
        h(Card, { title: '维护' },
          h(Row, { label: '浏览器模式', hint: '要过验证码就点右边那个按钮——它会切成有头、并直接跳到会弹滑块的视频页；过完切回「无头」' },
            h('div', { style: { display: 'flex', alignItems: 'center', gap: 8 } },
              h('select', {
                value: cfg.browserMode || 'headless',
                onChange: (e) => {
                  const m = e.target.value
                  setNote(m === 'headed' ? '正在切到有头（重启浏览器，稍等）…' : '正在收回无头（重启浏览器）…')
                  fetch('/api/douyin-watch/browser-mode', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ mode: m }) })
                    .then((r) => r.json())
                    .then((d) => setNote(d.ok
                      ? ('已切到' + (d.mode === 'headed' ? '有头' : '无头') + (d.verify ? '｜滑块已出现，去划' : ''))
                      : ('切换失败：' + (d.error || '未知'))))
                    .catch(() => setNote('切换失败：接口没返回'))
                    .then(() => load())
                },
                style: Object.assign({}, ctlBase, { width: 132 }),
              },
                h('option', { value: 'headless' }, '无头（平时）'),
                h('option', { value: 'headed' }, '有头（过验证）'),
              ),
              h('button', {
                type: 'button',
                disabled: switching,
                onClick: () => {
                  if (switching) return
                  setSwitching(true)
                  setNote('正在切到有头并打开视频页（重启浏览器，十几秒）…')
                  fetch('/api/douyin-watch/browser-mode', {
                    method: 'POST', headers: { 'content-type': 'application/json' },
                    body: JSON.stringify({ mode: 'headed' }),
                  })
                    .then((r) => r.json())
                    .then((d) => setNote(d.ok
                      ? (d.verify ? '有头窗口已弹出，滑块就在这个页面上，去划吧' : '有头窗口已打开目标页，但这次没弹验证码（说明暂时不需要）')
                      : ('切换失败：' + (d.error || '未知'))))
                    .catch(() => setNote('切换失败：接口没返回'))
                    .then(() => { setSwitching(false); load() })
                },
                style: Object.assign({}, ctlBase, { width: 'auto', padding: '0 10px', cursor: switching ? 'default' : 'pointer', color: C.text2 }),
              }, switching ? '切换中…' : '切有头 + 触发验证'),
            ),
          ),
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

        // 结尾这张卡：真诚求个星（不弹窗、不打扰，就一个小按钮）
        h(Card, { title: '觉得好用？' },
          h('div', { style: { fontSize: 12, color: C.text2, lineHeight: '21px' } },
            '要是这条赛博小鱼帮你省了点事，去仓库给它点个星吧。星星多一点，愿意一起修问题、加功能的人也会多一点，它才能活得更久。'),
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
