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

    // 人设列表里那种小按钮（比输入框矮一档，跟行高对齐）
    const btnBase = {
      height: 26, borderRadius: 6, border: '1px solid ' + C.line, background: 'transparent',
      color: C.text2, padding: '0 8px', fontSize: 12, fontFamily: 'inherit',
      cursor: 'pointer', whiteSpace: 'nowrap',
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
          sorted.length > 25 ? h('option', { value: '', disabled: true }, `（只列最近 25 个，共 ${sorted.length} 个；想选更早的，先在 DSH 里打开它，它就会排上来）`) : null,
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
    function StatusCard({ s, q, sessionId }) {
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
      const quotaTxt = quota.perHour
        ? (`已回 ${quota.hour || 0} 条 · 每小时最多 ${quota.perHour} · 每天最多 ${quota.perDay}`)
        : '还没回过';
      // 「签名直连」这种词用户读不懂，只说"读得快还是慢"
      const signedTxt = s.signed
        ? (s.signedDeps ? '直接连（快）' : '用浏览器页面（慢一点的备用方式）')
        : '用浏览器页面（正常方式）';
      const signedTone = s.signed && s.signedDeps ? '#2e7d32' : (s.signed ? '#b26a00' : C.text2);
      return h(Card, { title: '运行状态' },
        h('div', { style: { display: 'flex', alignItems: 'center', gap: 8, padding: '8px 0 10px' } },
          h('span', { style: { width: 8, height: 8, borderRadius: 4, background: color, flex: '0 0 auto' } }),
          h('span', { style: { fontSize: 13, fontWeight: 600, color: bad ? '#c0392b' : C.text } },
            bad ? '出错了' : (running ? '正在监听' : '已暂停')),
          h('span', { style: { fontSize: 12, color: C.text3 } },
            running ? (s.peerSet ? '（已选定要监听的抖音聊天）' : '（还没选定抖音聊天，不会工作）') : '（暂停时不看消息）'),
        ),
        h('div', { style: { display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 } },
          cell('今天已回评论（评论区，不是私信）', quotaTxt),
          cell('最后一次看消息', s.lastRead ? `${s.lastRead}，读到 ${s.lastCount || 0} 条` : '还没看过'),
          cell('最后一次收到私信', s.lastWake || '还没有'),
          cell('回复发到哪个对话', sessionId ? '下面下拉框里选的那个' : '最近在用的那个'),
        ),
        bad ? h('div', { style: { fontSize: 12, color: '#c0392b', marginTop: 8 } }, '出错原因：' + s.lastError) : null,
      );
    }

    function Panel() {
      const [cfg, setCfg] = useState(null);
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
      // 2026-11-07：认领主人（读当前打开会话的 sec_uid，之后等对方发消息验证）
      const [claimBusy, setClaimBusy] = useState(false);
      const [claimMsg, setClaimMsg] = useState('');

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
              type: 'button', style: Object.assign({}, btnBase, { color: '#c0392b' }),
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
          setRows((Array.isArray(c.autoScrollWindows) ? c.autoScrollWindows : []).map(parseWin));
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

      // 认领当前打开的那条会话（2026-11-07）：先让用户去抖音点开聊天，再点这里
      const claimNow = () => {
        setClaimBusy(true); setClaimMsg('');
        fetch('/api/douyin-watch/claim', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })
          .then((r) => r.json())
          .then((d) => {
            setClaimBusy(false);
            if (d && d.ok) {
              setCfg(d.config || cfg);
              setClaimMsg('');
            } else {
              setClaimMsg('失败：' + ((d && d.error) || '认领没成功'));
            }
          })
          .catch(() => { setClaimBusy(false); setClaimMsg('失败：接口没回应'); });
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

      return h('div', { 'data-dy-panel': '1', style: { padding: '4px 0 16px' } },

        h('div', {
          style: {
            position: 'sticky', top: 0, zIndex: 5, display: 'flex', flexWrap: 'wrap',
            gap: 6, padding: '6px 0 8px', marginBottom: 2,
            background: C.card || 'transparent',
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
            h('div', { style: { fontSize: 13.5, fontWeight: 600, color: C.text } }, '启用插件'),
            h('div', { style: { fontSize: 12, color: C.text3 } }, '这是插件的总开关：关掉后私信不读、也不回。下面「自动刷视频」和「评论区自动回」各有自己的开关，不受这里影响'),
          ),
          h(Switch, { checked: !!cfg.enabled, onChange: (v) => save({ enabled: v }) }),
        ),

        h(StatusCard, { s: status, q: cfg.commentQuota, sessionId: cfg.sessionId }),

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
          claimMsg ? h('div', { style: { fontSize: 12, color: claimMsg.indexOf('失败') === 0 ? '#c0392b' : C.text2, padding: '0 0 8px' } }, claimMsg) : null,
          h(Row, { label: '监听哪个抖音聊天', hint: '填抖音私信列表里那个聊天的名字；点上面的按钮会自动填好，一般不用自己改' },
            h(TextField, { value: cfg.peer || '', placeholder: '例：鲜葱、', onCommit: (v) => save({ peer: v }) }),
          ),
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
          h('div', { style: { padding: '10px 0 6px' } },
            h('div', { style: { fontSize: 13, color: C.text } }, '自动跑的时间段'),
            h('div', { style: { fontSize: 12, color: C.text3, marginTop: 2 } }, '时、分分别选；跨半夜也行，比如 18:30 到第二天 09:00'),
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
          h(Row, { label: '每天最多刷几条', hint: '填 0 = 不自动刷' },
            h('input', {
              type: 'number', min: 0, max: 50, value: cfg.autoScrollPerDay,
              onChange: (e) => save({ autoScrollPerDay: Number(e.target.value) }),
              style: Object.assign({}, ctlBase, { width: 84, textAlign: 'right' }),
            }),
          ),
          h(Row, { label: '结果私信发给我' }, h(Switch, { checked: !!cfg.autoScrollDeliverDm, onChange: (v) => save({ autoScrollDeliverDm: v }) })),
        ),

        h(Card, { title: '日报（可选）' },
          h(Row, { label: '写日报文件', hint: '默认不生成；开了每天生成一份文本文件（记事本能打开）' }, h(Switch, { checked: !!cfg.autoScrollWriteReport, onChange: (v) => save({ autoScrollWriteReport: v }) })),
          h(Row, { label: '日报目录', hint: '不填就存在这个 Bot 自己的文件夹里（设置页顶部写的那个工作区）' },
            h('input', {
              value: cfg.autoScrollReportDir || '',
              onChange: (e) => save({ autoScrollReportDir: e.target.value }),
              placeholder: 'D:\\path\\to\\dir',
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
        ),
        h(Card, { title: '人设', anchor: 'persona' },
          h(Row, { label: '当前人设', hint: '选定的人设会跟着每条回复一起发出去；换完下一条消息就生效，不用重启' },
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
          pNote ? h('div', { style: { fontSize: 12, color: '#d4380d', marginBottom: 6 } }, pNote) : null,
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
          h(Row, { label: '字数上限', hint: '公开评论越短越安全' },
            h('input', {
              type: 'number', min: 10, max: 500,
              value: Number(cfg.commentMaxChars) || 60,
              onChange: (e) => save({ commentMaxChars: Number(e.target.value) || 60 }),
              style: Object.assign({}, ctlBase, { width: 100 }),
            }),
          ),
          h(Row, { label: '频次上限', hint: '每小时、每天最多发几条；超了就不发（防止被平台判成刷屏）。不填 = 用上面的默认值。同一句话 7 天内不会重复发' },
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
          h(Row, { label: '回复别人在我评论下的留言', hint: '有人在你评论下面回你时，由它去接；容易被平台当成刷屏，默认关' },
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
          h(Row, { label: '每次最多回', hint: '每次最多处理几条新评论，别一口气刷太多' },
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
          h(Row, { label: '我的作品', hint: '视频链接（抖音里点分享 → 复制链接），多个用逗号隔开。填了它才会主动去翻这些视频的评论；不填也会在收到评论通知时自己记住' },
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
