#!/usr/bin/env node
/**
 * tools/comment-mention-ui.mjs —— 用**真实 UI 流程**在评论区 @ 人（唯一能保住 sec_uid 的路）
 * ============================================================================
 * 2026-10-21 实验定论：API/XHR 直发的 mention，服务端会把 sec_uid 剥掉 ⇒ 名字会蓝、
 * 但点开是空页、对方收不到通知。只有前端「点选 @ 弹层里的那一行」时，编辑器内存里有
 * 完整用户对象，服务端才信这个来源、保住 sec_uid。
 *
 * 已跑通的流程（2026-10-21 实测，主人收到通知）：
 *   ① 视频页 → #comment-input-container 滚进视口中心 → 真实鼠标点开
 *   ② 点 .public-DraftEditor-content 聚焦
 *   ③ CDP 键盘事件打「@」（execCommand 不触发弹层）
 *   ④ 等弹层，按昵称找到叶子节点（最窄那个）→ 真实鼠标点选
 *   ⑤ execCommand 补正文
 *   ⑥ 点输入容器右下角的红色箭头 svg（fill=FE2C55）发布
 *
 * 用法:
 *   node tools/comment-mention-ui.mjs --aweme <id> --name <昵称> --text "正文" [--dry]
 *
 * --dry：点选完人 + 补完正文就停，不发布；会 dump 弹层行数据和编辑器 HTML。
 */
import { openPage, sleep } from '../lib/chrome.mjs'

const argv = process.argv.slice(2)
const argOf = (k, d) => { const i = argv.indexOf(k); return i >= 0 ? (argv[i + 1] ?? '') : d }
const DRY = argv.includes('--dry')
const AWEME = String(argOf('--aweme', '')).trim()
const NAME = String(argOf('--name', '')).trim()
const TEXT = String(argOf('--text', '')).trim()
/**
 * ⭐ `--reply-cid <cid>`：回复**某一条**评论（而不是发顶层）。
 *    2026-10-22 加 —— 用户要"回评论区 @ 我的人"，那本质是"回复某条评论 + @ 他"。
 *    实现：先把那条评论滚进视口 → 点它下面的「回复」→ 再走原来的 @ 点选流程。
 *    点了「回复」之后，评论输入框的语义就是"回复那条"，前端会自动带上 reply 关系。
 */
const REPLY_CID = String(argOf('--reply-cid', '')).trim()

const out = (o) => { console.log(JSON.stringify(o, null, 1)); process.exitCode = o.ok === false ? 1 : 0 }

if (!AWEME || !NAME) { out({ ok: false, error: '用法: comment-mention-ui.mjs --aweme <id> --name <昵称> [--text 正文] [--reply-cid <cid>] [--dry]' }); process.exit(1) }

try {
  const c = await openPage()
  const chromed = c.status

  const mv = (x, y) => c.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y, button: 'none', buttons: 0 })
  const click = async (x, y) => {
    await mv(x, y); await sleep(150)
    await c.send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', buttons: 1, clickCount: 1 })
    await c.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', buttons: 0, clickCount: 1 })
  }

  await c.send('Page.navigate', { url: `https://www.douyin.com/video/${AWEME}` })
  await sleep(8000)
  // 先把视口调高（无头下默认窗口小，评论区/编辑器会落在视口外，点不中）
  await c.send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 2200, deviceScaleFactor: 1, mobile: false })
  await sleep(600)

  /**
   * ⭐ 如果要"回复某条评论"：先把那条评论滚进视口，点它下面的「回复」。
   *    点了之后输入框的语义就变成"回复这条"，前端会自己带 reply 关系。
   *    ⚠️ 找不到就**中止**，别默默改成发顶层（用户要的是回复）。
   */
  let replyInfo = null
  if (REPLY_CID) {
    // 先把评论区滚出来
    try {
      await c.ev(`(function(){
        var el = document.querySelector('#comment-input-container');
        if (el) el.scrollIntoView({block:'center'});
      })()`)
      await sleep(1500)
    } catch { /* 滚不动就继续 */ }

    let found = ''
    for (let i = 0; i < 10 && !found; i++) {
      found = String(await c.ev(`(function(){
        var CID = ${JSON.stringify(REPLY_CID)};
        // 评论节点通常带 data-e2e="comment-item" 或 cid 在 fiber 里
        var nodes = Array.prototype.slice.call(document.querySelectorAll('[data-e2e="comment-item"], [class*="commentItem"], [class*="comment-item"]'));
        for (var i = 0; i < nodes.length; i++) {
          var n = nodes[i];
          var fk = Object.keys(n).find(function(k){ return k.indexOf('__reactFiber$') === 0 });
          var hit = false;
          if (fk) {
            var f = n[fk], d = 0;
            while (f && d < 16) {
              var p = f.memoizedProps;
              if (p && typeof p === 'object') {
                var s = JSON.stringify(p).slice(0, 4000);
                if (s.indexOf(CID) >= 0) { hit = true; break }
              }
              f = f.return; d++;
            }
          }
          // 兜底：节点自身或父级文本里带 cid（少见，但有些版本会渲染到属性）
          if (!hit && (n.getAttribute && String(n.getAttribute('data-cid') || '') === CID)) hit = true;
          if (!hit) continue;
          n.scrollIntoView({ block: 'center' });
          var r = n.getBoundingClientRect();
          return JSON.stringify({ x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2), w: Math.round(r.width), h: Math.round(r.height) });
        }
        return '';
      })()`))
      if (!found) {
        // 往下滚一屏再找
        await c.ev(`(function(){ var l=document.querySelector('[class*="commentList"], [class*="comment-list"]'); if(l){ l.scrollTop += 900 } else { window.scrollBy(0,900) } })()`)
        await sleep(1500)
      }
    }
    if (!found) {
      c.close()
      out({ ok: false, error: `评论区里找不到 cid=${REPLY_CID} 这条评论（可能被删了 / 或者滚得不够深）`, code: 'reply_target_not_found' })
      process.exit(1)
    }

    // 在那条评论里找「回复」按钮并点它
    const replyBtn = String(await c.ev(`(function(){
      var CID = ${JSON.stringify(REPLY_CID)};
      var nodes = Array.prototype.slice.call(document.querySelectorAll('[data-e2e="comment-item"], [class*="commentItem"], [class*="comment-item"]'));
      for (var i = 0; i < nodes.length; i++) {
        var n = nodes[i];
        var fk = Object.keys(n).find(function(k){ return k.indexOf('__reactFiber$') === 0 });
        var hit = false;
        if (fk) {
          var f = n[fk], d = 0;
          while (f && d < 16) {
            var p = f.memoizedProps;
            if (p && typeof p === 'object') {
              var s = JSON.stringify(p).slice(0, 4000);
              if (s.indexOf(CID) >= 0) { hit = true; break }
            }
            f = f.return; d++;
          }
        }
        if (!hit) continue;
        // 在该节点范围内找文字是「回复」的可点元素
        var cands = Array.prototype.slice.call(n.querySelectorAll('span,div,button,a'));
        for (var j = 0; j < cands.length; j++) {
          var e = cands[j];
          if (e.children.length) continue;
          if ((e.innerText || '').trim() !== '回复') continue;
          var r = e.getBoundingClientRect();
          if (!(r.width > 4 && r.height > 8)) continue;
          return JSON.stringify({ x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) });
        }
      }
      return '';
    })()`))
    if (!replyBtn) {
      c.close()
      out({ ok: false, error: '找到了那条评论，但没找到「回复」按钮', code: 'reply_button_not_found' })
      process.exit(1)
    }
    const rb = JSON.parse(replyBtn)
    await click(rb.x, rb.y)
    await sleep(1800)
    replyInfo = { reply_to_cid: REPLY_CID, reply_button: rb }
  }

  // ① 点开输入区：要点**内部容器** comment-input-inner-container（点外层 #comment-input-container 不会展开编辑器，2026-10-24 实测）
  const boxOk = await c.ev(`(function(){
    var e = document.querySelector('[class*="comment-input-inner-container"]') || document.getElementById('comment-input-container');
    if (!e) return 'no-box';
    e.scrollIntoView({ block: 'center' });
    if (e.click) e.click();
    if (e.focus) e.focus();
    return 'ok';
  })()`)
  if (boxOk !== 'ok') { out({ ok: false, error: '找不到评论输入区' }); process.exit(1) }
  await sleep(1500)

  // ② 聚焦编辑器（用 JS focus；Draft.js 的 contenteditable 用 CDP 鼠标点反而可能失焦）
  const edOk = await c.ev(`(function(){
    var e=document.querySelector('.public-DraftEditor-content');
    if (!e) return 'no';
    e.focus();
    return 'ok';
  })()`)
  if (edOk !== 'ok') { out({ ok: false, error: '评论编辑器没展开（.public-DraftEditor-content 不存在）' }); process.exit(1) }
  await sleep(400)

  // ③ 打 @（可靠版：聚焦 + 重试；编辑器焦点偶尔会飘）
  let typedAt = false
  for (let attempt = 0; attempt < 5 && !typedAt; attempt++) {
    await c.ev(`(function(){ var e=document.querySelector('.public-DraftEditor-content'); if(e){ e.focus(); } })()`)
    await sleep(300)
    await c.send('Input.dispatchKeyEvent', { type: 'rawKeyDown', key: '@', code: 'Digit2', windowsVirtualKeyCode: 50, nativeVirtualKeyCode: 50 })
    await c.send('Input.dispatchKeyEvent', { type: 'char', text: '@', key: '@', code: 'Digit2', windowsVirtualKeyCode: 50, nativeVirtualKeyCode: 50 })
    await c.send('Input.dispatchKeyEvent', { type: 'keyUp', key: '@', code: 'Digit2', windowsVirtualKeyCode: 50, nativeVirtualKeyCode: 50 })
    await sleep(2200)
    const txt = await c.ev(`(function(){ var e=document.querySelector('.public-DraftEditor-content'); return e ? (e.innerText||'') : ''; })()`)
    if (String(txt).indexOf('@') >= 0) typedAt = true
  }
  if (!typedAt) { out({ ok: false, error: '@ 没打进编辑器' }); process.exit(1) }

  // ④ 找弹层里昵称那一行（叶子节点、最窄的），带重试（弹层可能渲染慢）
  let row = {}
  for (let attempt = 0; attempt < 5 && !row.x; attempt++) {
    if (attempt > 0) await sleep(1000)
    row = JSON.parse(await c.ev(`(function(){
    var NAME=${JSON.stringify(NAME)}; var rows=[];
    document.querySelectorAll('div,span,li,p').forEach(function(e){
      if (e.children.length) return;
      if ((e.innerText||'').trim()!==NAME) return;
      var r=e.getBoundingClientRect();
      if (!(r.width>4 && r.height>8)) return;
      var fk=Object.keys(e).find(function(k){return k.indexOf('__reactFiber$')===0});
      var ids=[];
      if (fk){ var f=e[fk],d=0;
        while(f&&d<14){ var p=f.memoizedProps;
          if(p&&typeof p==='object'){
            for(var k in p){ var v=p[k];
              if(typeof v==='string'&&/^\\d{10,20}$/.test(v)) ids.push(k+'='+v);
              else if(typeof v==='string'&&/^(MS4wLjABAA|11-\\d{6,})/.test(v)) ids.push(k+'='+String(v).slice(0,34));
              else if(v&&typeof v==='object'){ if(v.uid)ids.push('obj.uid='+v.uid); if(v.sec_uid)ids.push('obj.sec_uid='+String(v.sec_uid).slice(0,30)); }
            }
          }
          f=f.return; d++;
        }
      }
      var uniq=[]; ids.forEach(function(x){ if(uniq.indexOf(x)<0) uniq.push(x); });
      rows.push({x:Math.round(r.x+r.width/2),y:Math.round(r.y+r.height/2),w:Math.round(r.width),ids:uniq.slice(0,8)});
    });
    rows.sort(function(a,b){ return a.w-b.w; });
    return JSON.stringify(rows[0]||{});
  })()`))
  }
  if (!row.x) { out({ ok: false, error: '@ 弹层里没找到这个名字（可能没互关 / 昵称不对）' }); process.exit(1) }

  // 真实鼠标点选那一行
  await click(row.x, row.y)
  await sleep(1000)

  /**
   * ⑤ 补正文。
   * 🔴 2026-10-22 实测 bug：点选 mention 后，编辑器里**已经有** `@昵称` 这个 token 了。
   *    如果 TEXT 本身又以 `@昵称` 开头（调用方要求"正文里必须原样出现 @昵称"），
   *    直接插入整段 TEXT 就会变成 `@示例好友 @示例好友 正文` —— **重复一次**。
   *    ⇒ 先看编辑器现在是什么，把 TEXT 开头那个 `@昵称` 去掉再插。
   */
  if (TEXT) {
    let body = String(TEXT)
    // 去掉开头的 @昵称（含可能跟着的空格）
    const lead = '@' + NAME
    if (body.startsWith(lead)) body = body.slice(lead.length).replace(/^[\s\u3000]+/, '')
    // 再看编辑器里到底有没有 @昵称（不同版本可能不自动插入，保险起见按实际判断）
    const hasToken = await c.ev(`(function(){
      var e=document.querySelector('.public-DraftEditor-content');
      return e ? String(e.innerText||'').indexOf(${JSON.stringify(lead)}) >= 0 : false;
    })()`)
    if (body) {
      await c.ev(`document.execCommand('insertText', false, ${JSON.stringify(' ' + body)})`)
      await sleep(600)
    }
    // 如果真的没自动插入 mention，就把 @昵称 补回去（否则名字不会蓝）
    if (!hasToken) {
      await c.ev(`document.execCommand('insertText', false, ${JSON.stringify(lead + ' ')})`)
      await sleep(400)
    }
  }

  let editorHtml = await c.ev(`(function(){
    var e=document.querySelector('.public-DraftEditor-content');
    return e ? String(e.innerHTML||'').slice(0,900) : '';
  })()`)

  // ⭐ 发布前自检：确认 @ 真的变成了 mention chip（span.douyin_mention_word）。
  // 弹层坐标经常跑到屏幕外（headless 下 y 是负数）→ 点不中人 → 只剩一个光秃秃的 "@"。
  // 兜底：直接按 Enter 选第一个候选（不依赖坐标）；仍然失败就**中止，不发布**。
  let chipOk = /douyin_mention_word/.test(editorHtml)
  if (!chipOk) {
    await c.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13 })
    await c.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13 })
    await sleep(700)
    editorHtml = await c.ev(`(function(){
      var e=document.querySelector('.public-DraftEditor-content');
      return e ? String(e.innerHTML||'').slice(0,900) : '';
    })()`)
    chipOk = /douyin_mention_word/.test(editorHtml)
  }
  if (!chipOk) {
    out({ ok: false, refused: true, error: '@ 没选中（mention chip 不存在），已中止，未发布', popup_row: row, editor_html: editorHtml, chrome: chromed })
    c.close(); await sleep(200)
    throw { __done: true }
  }

  if (DRY) {
    out({ ok: true, dry: true, popup_row: row, editor_html: editorHtml, chrome: chromed })
    c.close(); await sleep(200)
    throw { __done: true }
  }

  // ⑥ 点右下角红色箭头发布（svg 里 fill=FE2C55，往上找到 ≥24px 的可点容器）
  const btn = JSON.parse(await c.ev(`(function(){
    var root=document.getElementById('comment-input-container');
    if(!root) return '{}';
    var svgs=root.querySelectorAll('svg');
    for (var i=0;i<svgs.length;i++){
      if (String(svgs[i].innerHTML||'').indexOf('FE2C55')<0) continue;
      var e=svgs[i];
      for (var up=0; up<4 && e; up++){
        var r=e.getBoundingClientRect();
        if (r.width>24 && r.height>24) return JSON.stringify({x:Math.round(r.x+r.width/2),y:Math.round(r.y+r.height/2)});
        e=e.parentElement;
      }
    }
    return '{}';
  })()`))
  if (!btn.x) { out({ ok: false, error: '找不到发布箭头', editor_html: editorHtml }); process.exit(1) }
  await click(btn.x, btn.y)
  await sleep(4000)

  const editorAfter = await c.ev(`(function(){ var e=document.querySelector('.public-DraftEditor-content'); return e ? String(e.innerText||'').slice(0,60) : '(gone)'; })()`)
  c.close()
  await sleep(200)   // 等 WebSocket 真正关掉再退出（别的工具踩过 libuv 断言）
  out({ ok: true, published: true, aweme_id: AWEME, mention: NAME, ...(replyInfo || {}), popup_row: row, editor_html: editorHtml, editor_after: editorAfter, chrome: chromed })
} catch (e) {
  if (!(e && e.__done)) out({ ok: false, error: String(e?.message ?? e) })
}
