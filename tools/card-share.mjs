#!/usr/bin/env node
/**
 * tools/card-share.mjs —— 用抖音自己的「分享给朋友」把视频以**卡片**发给好友
 * ============================================================================
 * 为什么必须这么做：分享卡片（aweType 800 / MessageItemShareAweme）是前端把结构化
 * 消息交给服务端生成的，纯文本 + URL 永远做不出卡片；而且文本链接在抖音里点不开。
 *
 * 链路（全在无头 Chrome 里，屏幕上无窗口）：
 *   视频页 → 鼠标轨迹 hover 分享图标 → 面板展开 →
 *   找「<昵称>」那一行的「分享」按钮 → 点击 → 卡片发出
 *
 * ⚠️ 分享图标没有 onClick，是 onMouseEnter/onFocus 的 hover 弹窗，
 *    所以必须用**真实鼠标轨迹**移过去，`el.click()` 打不开（踩过）。
 *
 * 用法:
 *   node tools/card-share.mjs <aweme_id> <好友昵称>
 *   node tools/card-share.mjs <aweme_id> <好友昵称> --dry    # 只展开面板打印结构
 */
import { openPage, sleep } from '../lib/chrome.mjs'

const argv = process.argv.slice(2)
const argOf = (k, d = '') => { const i = argv.indexOf(k); return i >= 0 ? (argv[i + 1] ?? d) : d }
const DRY = argv.includes('--dry')
const PEEK = argv.includes('--peek')
const TOID = argOf('--to-id', '')
// 位置参数：跳过 `--to-id` 后面那个值
const pos = argv.filter((a, i) => !a.startsWith('--') && !(i > 0 && argv[i - 1] === '--to-id'))
const AID = pos[0] || ''
const WHO = pos[1] || ''
const out = (o) => { console.log(JSON.stringify(o, null, 1)); process.exitCode = o.ok ? 0 : 1 }

if (!AID || !WHO) { out({ ok: false, error: '用法: card-share.mjs <aweme_id> <好友昵称>' }); process.exit(1) }

const _c = await openPage()
const chromed = _c.status
const { send, ev } = _c

/**
 * ⚠️ 2026-10-25 实测：`Input.dispatchMouseEvent`（原生鼠标）在这个 Chrome + 抖音页面上不可靠 ——
 *   ① 分享图标**在视口外**时（窗口内容高 631、图标 top=634），坐标命不中任何元素，
 *      `elementFromPoint(x,y)` 返回 null，hover 一次都不会发生 → 面板永远不展开；
 *   ② 就算命中，原生鼠标/按键事件也不触发 React 的 onMouseEnter / onClick
 *      （私信会话点不开、回车发不出消息，都是同一类毛病）。
 *   所以这里改成**在页面里直接对元素派发事件**：不依赖坐标是否落在视口内。
 */
const hoverShareIcon = () => ev(`(function(){
  var ic = document.querySelector('[data-e2e="video-share-icon-container"]');
  if (!ic) return JSON.stringify({ ok: false, why: 'no-icon' });
  var r = ic.getBoundingClientRect();
  var x = Math.round(r.x + r.width / 2), y = Math.round(r.y + r.height / 2);
  var tgt = document.elementFromPoint(x, y) || ic;   // 视口外时 elementFromPoint 是 null → 退回图标本体
  var opt = { bubbles: true, cancelable: true, view: window, clientX: x, clientY: y };
  ['pointerover','pointerenter','mouseover','mouseenter','mousemove'].forEach(function(t){
    try {
      var E = t.indexOf('pointer') === 0 ? PointerEvent : MouseEvent;
      tgt.dispatchEvent(new E(t, opt));
      ic.dispatchEvent(new E(t, opt));
    } catch(e){}
  });
  return JSON.stringify({
    ok: true, x: x, y: y,
    inView: r.top >= 0 && r.bottom <= innerHeight,
    hitSelf: tgt === ic || ic.contains(tgt),
  });
})()`)

/** 面板是否真的展开了：容器本身 h/w 常是 0，真正有尺寸的是它的子元素，别只看高度。 */
const panelState = () => ev(`(function(){
  var sc = document.querySelector('[data-e2e="video-share-container"]');
  if (!sc) return JSON.stringify({ exists: false, open: false, text: '' });
  var c = sc.firstElementChild;
  var cr = c ? c.getBoundingClientRect() : null;
  var text = (sc.innerText || '').replace(/\\s+/g, ' ').trim();
  return JSON.stringify({
    exists: true,
    open: !!text || !!(cr && cr.width > 10 && cr.height > 10),
    childW: cr ? Math.round(cr.width) : 0,
    childH: cr ? Math.round(cr.height) : 0,
    text: text.slice(0, 400),
  });
})()`)

try {
  await send('Page.navigate', { url: `https://www.douyin.com/video/${AID}` })
  // 别死等 7 秒：从私信页跳视频页时是整页重载，经常超过 7 秒
  //   （2026-10-25 实测：同一脚本有时 7 秒够，有时直接撞「视频页没加载好」）
  let pos = {}
  for (let i = 0; i < 40; i++) {
    await sleep(500)
    pos = JSON.parse(await ev(`(function(){
      var ic=document.querySelector('[data-e2e="video-share-icon-container"]');
      if(!ic) return '{}';
      var r=ic.getBoundingClientRect();
      if (r.width < 4 || r.height < 4) return '{}';
      return JSON.stringify({x:Math.round(r.x+r.width/2),y:Math.round(r.y+r.height/2)});
    })()`))
    if (pos.x) break
  }
  if (!pos.x) { out({ ok: false, error: '找不到分享图标（视频页 20 秒内没加载好）' }); process.exit(1) }

  // 页面内派发 hover（原生鼠标事件不生效；图标还常在视口外，坐标 hover 根本无从谈起）
  const hv = JSON.parse(await hoverShareIcon())
  if (!hv.ok) { out({ ok: false, error: '分享图标 hover 失败', detail: hv }); process.exit(1) }
  // 面板是异步渲染的，而且分两截：外壳（"复制链接"）先出现，"分享给朋友 + 好友列表"后到。
  //   2026-10-25 实测：只等"有文字"会读到半截面板（只有"复制链接"），于是误报"找不到该好友那一行"。
  //   所以等到**好友那一行**出现为止。
  let ps = JSON.parse(await panelState())
  for (let i = 0; i < 24 && (!ps.text || ps.text.indexOf(WHO) < 0); i++) {
    await sleep(500)
    ps = JSON.parse(await panelState())
  }
  if (!ps.text) { out({ ok: false, error: '分享面板没展开（或有壳没内容）', hover: hv, panel: ps }); process.exit(1) }
  const panel = ps.text
  if (panel.indexOf(WHO) < 0) {
    out({ ok: false, error: '分享面板里没出现该好友（好友列表没加载出来，可能没登录/被风控）', panel })
    process.exit(1)
  }

  // --peek：把面板里每一行连同它 fiber 里的 id 都打出来（排查重名用）
  if (PEEK) {
    const rows = await ev(`(function(){
      var sc = document.querySelector('[data-e2e="video-share-container"]');
      if (!sc) return '[]';
      var out = [];
      sc.querySelectorAll('div').forEach(function(e){
        var t = (e.innerText||'').replace(/\\s+/g,' ').trim();
        if (!t || t.length > 40 || t === '分享') return;
        var fk = Object.keys(e).find(function(k){ return k.indexOf('__reactFiber$')===0 });
        var ids = [];
        if (fk) {
          var f = e[fk], d = 0;
          while (f && d < 12) {
            var p = f.memoizedProps;
            if (p && typeof p === 'object') {
              for (var k in p) {
                if (typeof p[k] === 'string' && /^(MS4wLjABAA|11-)\\S{6,}$/.test(p[k])) ids.push(k + '=' + p[k]);
                else if (p[k] && typeof p[k] === 'object' && p[k].sec_uid) ids.push('obj.sec_uid=' + p[k].sec_uid);
                else if (p[k] && typeof p[k] === 'object' && p[k].uid) ids.push('obj.uid=' + p[k].uid);
              }
            }
            f = f.return; d++;
          }
        }
        var uniq = []; ids.forEach(function(x){ if (uniq.indexOf(x)<0) uniq.push(x) });
        if (uniq.length) out.push({ text: t.slice(0,30), ids: uniq.slice(0,4) });
      });
      var seen={},u=[]; out.forEach(function(o){var k=o.text; if(!seen[k]){seen[k]=1;u.push(o);}});
      return JSON.stringify(u.slice(0,12));
    })()`)
    out({ ok: true, peek: true, panel, rows: JSON.parse(rows || '[]') })
    _c.close(); process.exit(0)
  }

  // 找「WHO」那一行：同时拿到 昵称 + **sec_uid** + 「分享」按钮坐标 —— 昵称会重名，sec_uid 不会
  const found = await ev(`(function(){
    var who = ${JSON.stringify(WHO)};
    var sc = document.querySelector('[data-e2e="video-share-container"]');
    if(!sc) return JSON.stringify({err:'no-panel'});
    function secOf(node){
      var fk = Object.keys(node).find(function(k){ return k.indexOf('__reactFiber$')===0 });
      if(!fk) return '';
      var f = node[fk], d = 0;
      while (f && d < 14) {
        var p = f.memoizedProps;
        if (p && typeof p === 'object') {
          for (var k in p) { var v = p[k]; if (v && typeof v === 'object' && v.sec_uid) return String(v.sec_uid); }
        }
        f = f.return; d++;
      }
      return '';
    }
    var nodes = Array.prototype.slice.call(sc.querySelectorAll('div,span,p')).filter(function(e){
      return (e.innerText||'').trim() === who;
    }).sort(function(a,b){ return a.getBoundingClientRect().width - b.getBoundingClientRect().width });
    if(!nodes.length) return JSON.stringify({err:'no-name', text:(sc.innerText||'').replace(/\\s+/g,' ').slice(0,160)});
    var out = [];
    nodes.forEach(function(nameNode){
      var row = nameNode;
      for (var i=0;i<6 && row;i++){
        var btns = Array.prototype.slice.call(row.querySelectorAll('div,span,button')).filter(function(e){
          return (e.innerText||'').trim()==='分享';
        });
        if (btns.length){
          var b = btns[0], r = b.getBoundingClientRect();
          if (r.width>16 && r.height>12){
            out.push({ nick: who, sec_uid: secOf(row) || secOf(nameNode),
              btn: {x:Math.round(r.x+r.width/2), y:Math.round(r.y+r.height/2), w:Math.round(r.width), h:Math.round(r.height)} });
          }
          break;
        }
        row = row.parentElement;
      }
    });
    var seen={}, uniq=[];
    out.forEach(function(o){ var k=o.sec_uid||(o.btn.x+','+o.btn.y); if(!seen[k]){seen[k]=1;uniq.push(o)} });
    return JSON.stringify({candidates: uniq});
  })()`)

  let f = {}
  try { f = JSON.parse(found) } catch { f = { err: 'bad-json' } }
  if (f.err) { out({ ok: false, error: '找不到该好友那一行', detail: f, panel }); process.exit(1) }

  let cands = f.candidates || []
  if (TOID) {
    cands = cands.filter((c) => c.sec_uid === TOID)
    if (!cands.length) { out({ ok: false, error: `分享面板里没有 sec_uid=${TOID} 这个人（面板只列最近分享过的人）`, panel }); process.exit(1) }
  }
  if (cands.length > 1) {
    out({
      ok: false,
      error: '分享面板里有多个同名的人，不敢猜（猜错就是把视频发给陌生人）',
      nick: WHO,
      candidates: cands.map((c) => ({ sec_uid: c.sec_uid })),
      hint: '请改用 --to-id <sec_uid> 指定',
    })
    process.exit(1)
  }
  const b = cands[0].btn
  const target = { nick: WHO, sec_uid: cands[0].sec_uid || TOID || '' }
  if (DRY) { out({ ok: true, dry: true, panel, btn: b, target, chrome: chromed, matched_by: TOID ? 'sec_uid' : 'nickname(唯一)' }); _c.close(); process.exit(0) }

  // 点「分享」：同样必须页面内派发（原生点击不触发 React），
  //   而且按「那一行」找按钮本体，不靠坐标 —— 面板比视口高时，底下几行是点不到的。
  const clicked = JSON.parse(await ev(`(function(){
    var who = ${JSON.stringify(WHO)}, wantId = ${JSON.stringify(cands[0].sec_uid || TOID || '')};
    var sc = document.querySelector('[data-e2e="video-share-container"]');
    if (!sc) return JSON.stringify({ ok: false, why: 'no-panel' });
    function secOf(node){
      var fk = Object.keys(node).find(function(k){ return k.indexOf('__reactFiber$')===0 });
      if (!fk) return '';
      var f = node[fk], d = 0;
      while (f && d < 14) {
        var p = f.memoizedProps;
        if (p && typeof p === 'object') { for (var k in p) { var v = p[k]; if (v && typeof v === 'object' && v.sec_uid) return String(v.sec_uid) } }
        f = f.return; d++;
      }
      return '';
    }
    var names = Array.prototype.slice.call(sc.querySelectorAll('div,span,p')).filter(function(e){
      return (e.innerText||'').trim() === who;
    }).sort(function(a,b){ return a.getBoundingClientRect().width - b.getBoundingClientRect().width });
    for (var i = 0; i < names.length; i++) {
      var row = names[i];
      for (var up = 0; up < 6 && row; up++) {
        var sid = secOf(row);
        if (wantId && sid && sid !== wantId) break;          // 同名但不是这个人 → 换下一个
        var btns = Array.prototype.slice.call(row.querySelectorAll('div,span,button')).filter(function(e){
          return (e.innerText||'').trim() === '分享';
        });
        if (btns.length) {
          var btn = btns[0], r = btn.getBoundingClientRect();
          if (r.width > 16 && r.height > 12) {
            var x = Math.round(r.x + r.width / 2), y = Math.round(r.y + r.height / 2);
            var tgt = document.elementFromPoint(x, y) || btn;
            var opt = { bubbles: true, cancelable: true, view: window, clientX: x, clientY: y, button: 0 };
            ['pointerdown','mousedown','pointerup','mouseup','click'].forEach(function(t){
              try { tgt.dispatchEvent(new (t.indexOf('pointer')===0?PointerEvent:MouseEvent)(t, opt)) } catch(e){}
            });
            return JSON.stringify({ ok: true, sec_uid: sid, inView: y > 0 && y < innerHeight });
          }
          break;
        }
        row = row.parentElement;
      }
    }
    return JSON.stringify({ ok: false, why: 'no-button' });
  })()`))
  if (!clicked.ok) { out({ ok: false, sent: false, error: '没能点到那一行的「分享」按钮', detail: clicked, panel }); process.exit(1) }
  // 点完「分享」抖音会**立刻**把卡片发出去，然后那一行变成「捎句话」（可选附言）。
  //   2026-10-25 实测：卡片确实到了（私信里多了一条带封面的 aweType 800 消息），
  //   但老版本在这一刻看到"面板还开着"就判失败 —— 判据错了，不是发送失败。
  //   所以改成轮询三种成功信号：toast / 那一行变成「捎句话」/ 面板整个关掉。
  let a = {}
  let evidence = 'none'
  for (let i = 0; i < 8; i++) {
    await sleep(500)
    a = JSON.parse(await ev(`(function(){
      var sc = document.querySelector('[data-e2e="video-share-container"]');
      var c = sc && sc.firstElementChild;
      var cr = c ? c.getBoundingClientRect() : null;
      var text = sc ? (sc.innerText || '').replace(/\\s+/g, ' ').trim() : '';
      return JSON.stringify({
        // 容器本身 h/w 常是 0，真正有尺寸的是子元素 —— 老版本按容器高度判断，恒为 false
        panelStillOpen: !!(text || (cr && cr.width > 10 && cr.height > 10)),
        panelText: text.slice(0, 200),
        toast: (document.body.innerText || '').indexOf('已发送') >= 0 || (document.body.innerText || '').indexOf('发送成功') >= 0
      });
    })()`))
    if (a.toast) { evidence = 'toast'; break }
    if (String(a.panelText || '').indexOf('捎句话') >= 0) { evidence = 'row-switched'; break }
    if (!a.panelStillOpen) { evidence = 'panel-closed'; break }
  }
  const sent = evidence !== 'none'
  out({ ok: sent, sent, aweme_id: AID, to: WHO, target, evidence, panel, clicked, chrome: chromed, after: a })
} catch (e) {
  out({ ok: false, error: String(e?.message ?? e) })
} finally {
  _c.close()
}
process.exit(process.exitCode || 0)
