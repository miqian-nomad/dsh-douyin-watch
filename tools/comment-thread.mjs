#!/usr/bin/env node
/**
 * tools/comment-thread.mjs —— 读「楼中楼」（某条顶层评论下的回复），带两条路
 * ============================================================================
 * 为什么要有两条路（2026-10-28 实测结论）：
 *   ① 接口路 `/aweme/v1/web/comment/list/reply/`
 *      2026-10-28 实测：**没签名就挂**。同一个页面上下文里，
 *      `/comment/list/`（顶层）432ms 正常返回 5 条，`/comment/list/reply/`
 *      等 9 秒也不返回、也不报错；补 msToken / is_fold_comment / 换 www-hj 域名全一样。
 *      别人（cv-cat/catbus、Evil0ctal、f2）都是自己算 `a_bogus` 再发。页面里
 *      又没有可直接调用的签名对象（window._webmssdk / byted_acrawler 都是
 *      undefined），所以「借页面签名」这条路不通。
 *   ② 页面路（本文件的新主力）：让**页面自己**发那个请求 —— 点开「展开N条回复」，
 *      页面会用自己算好的签名去请求，我们只在旁边把 XHR/fetch 的响应收下来。
 *      这条路不碰签名算法、不改页面逻辑，只点按钮。
 *
 * 用法:
 *   node tools/comment-thread.mjs --aweme <id> --cid <顶层cid> [--cid <cid2>] [--max 30] [--api-only]
 * 输出一行 JSON:
 *   { ok, aweme, threads: [ { root_cid, via:'api'|'ui'|'none', replies:[ {cid,nick,uid,text,at,root_cid} ], note? } ] }
 *
 * ⚠️ 页面路需要页面静止十几秒；调用方（插件工具）会先 pauseWatcher()，否则哨兵
 *    每 30 秒把页面导航回 /chat，正在加载的评论区会被抽掉（2026-10-28 踩过）。
 */
import { openPage, sleep } from '../lib/chrome.mjs'
import { writeFileSync, existsSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { join } from 'node:path'
import { homeDir } from '../lib/paths.mjs'

/** 现场记录：页面路每一步都留痕（排查用，别在正式输出里塞噪音） */
const dbg = { steps: [] }
const dbgDump = () => {
  try { writeFileSync(join(homeDir(), 'thread-debug.json'), JSON.stringify(dbg, null, 1)) } catch { /* 写不进去不影响 */ }
}

const argv = process.argv.slice(2)
const argOf = (k, d) => { const i = argv.indexOf(k); return i >= 0 ? (argv[i + 1] ?? d) : d }
const allOf = (k) => argv.reduce((a, v, i) => (v === k ? a.concat(String(argv[i + 1] || '')) : a), [])

const AWEME = String(argOf('--aweme', '')).trim()
const CIDS = allOf('--cid').map((s) => String(s || '').trim()).filter(Boolean)
const MAX = Math.min(50, Math.max(1, Number(argOf('--max', '30')) || 30))
const API_ONLY = argv.includes('--api-only')

const out = (o) => { console.log(JSON.stringify(o, null, 1)); process.exitCode = o.ok ? 0 : 1 }

if (!AWEME) { out({ ok: false, error: '缺 --aweme' }); process.exit(1) }
if (!CIDS.length) { out({ ok: false, error: '缺 --cid（要查哪条顶层评论下的楼中楼）' }); process.exit(1) }

/** 接口路：6 秒拿不到就当不通（不签名时它是"挂住"而不是报错） */
const API_JS = (aweme, cids, max) => `(async function(){
  var ENV = ${JSON.stringify({ aweme, cids, max })};
  var COMMON = {
    device_platform:'webapp', aid:'6383', channel:'channel_pc_web',
    pc_client_type:'1', version_code:'190500', version_name:'19.5.0',
    cookie_enabled:'true', screen_width:'1920', screen_height:'1080',
    browser_language:'zh-CN', browser_platform:'Win32',
    browser_name:'Chrome', browser_version:'141.0.0.0',
    engine_name:'Blink', engine_version:'141.0.0.0',
    os_name:'Windows', os_version:'10', platform:'PC'
  };
  function qs(d){ return Object.keys(d).map(function(k){return encodeURIComponent(k)+'='+encodeURIComponent(d[k]);}).join('&'); }
  async function getJSON(path){
    try {
      var r = await Promise.race([
        fetch(path, { credentials:'include', headers:{ 'Referer':'https://www.douyin.com/' } }),
        new Promise(function(_, rej){ setTimeout(function(){ rej(new Error('hung')) }, 6000) })
      ]);
      var t = await r.text();
      try { return { http:r.status, json:JSON.parse(t) } } catch(e) { return { http:r.status, json:null } }
    } catch(e) { return { http:0, json:null, err:String((e && e.message) || e) } }
  }
  var res = [];
  for (var i = 0; i < ENV.cids.length; i++) {
    var cid = ENV.cids[i];
    var r = await getJSON('/aweme/v1/web/comment/list/reply/?' + qs(Object.assign({}, COMMON, {
      item_id: ENV.aweme, comment_id: cid, cursor:'0', count:String(ENV.max), item_type:'0', app_name:'aweme'
    })));
    var arr = (r.json && (r.json.comments || r.json.replies)) || [];
    res.push({ cid: cid, http: r.http, err: r.err || '', arr: arr });
  }
  return JSON.stringify(res);
})()`

const normReplies = (arr, rootCid) => (arr || []).map((x) => {
  const u = (x && x.user) || {}
  return {
    cid: String((x && x.cid) || ''),
    nick: String(u.nickname || ''),
    uid: String(u.uid || ''),
    text: String((x && x.text) || '').replace(/\s+/g, ' ').slice(0, 200),
    at: Number((x && x.create_time) || 0),
    root_cid: String((x && x.reply_id) || rootCid || ''),
  }
})

/** 页面路第 1 步：挂 XHR/fetch 钩子，把页面自己发出的 /comment/list/reply 响应按 comment_id 收进 window.__replyBag */
const HOOK_JS = `(function(){
  if (window.__replyBag) return 'already';
  window.__replyBag = {};
  function take(url, text){
    try {
      var m = /[?&]comment_id=([^&]+)/.exec(String(url));
      if (!m) return;
      var cid = decodeURIComponent(m[1]);
      var j = JSON.parse(text);
      var arr = (j && (j.comments || j.replies)) || [];
      if (!arr.length) return;
      var bag = window.__replyBag[cid] || (window.__replyBag[cid] = {});
      for (var i = 0; i < arr.length; i++) { var k = String(arr[i].cid || ''); if (k) bag[k] = arr[i] }
    } catch(e) {}
  }
  var oo = XMLHttpRequest.prototype.open, os = XMLHttpRequest.prototype.send;
  XMLHttpRequest.prototype.open = function(m, u){
    try { if (String(u).indexOf('/comment/list/reply/') >= 0) this.__rUrl = String(u) } catch(e) {}
    return oo.apply(this, arguments)
  };
  XMLHttpRequest.prototype.send = function(){
    if (this.__rUrl) { var u = this.__rUrl, self = this; this.addEventListener('load', function(){ take(u, self.responseText || '') }) }
    return os.apply(this, arguments)
  };
  var of = window.fetch;
  window.fetch = function(input, init){
    var u = String(input && input.url ? input.url : input);
    var p = of.apply(this, arguments);
    if (u.indexOf('/comment/list/reply/') >= 0) {
      p.then(function(r){ try { r.clone().text().then(function(t){ take(u, t) }) } catch(e){} }).catch(function(){});
    }
    return p;
  };
  return 'hooked';
})()`

/** 页面路第 2 步：找「展开N条回复」按钮（按坐标去重，只留叶子节点） */
const FIND_BTN_JS = `(function(){
  var rx = /展开\\s*\\d+\\s*条回复|查看\\s*\\d+\\s*条回复|展开更多回复|展开\\d+条/;
  var all = Array.prototype.slice.call(document.querySelectorAll('div,span,p,a'));
  var hits = [];
  for (var i = 0; i < all.length; i++) {
    var n = all[i], t = String(n.innerText || '').trim();
    if (!t || t.length > 24 || !rx.test(t)) continue;
    var r = n.getBoundingClientRect();
    if (r.width < 2 || r.height < 2) continue;
    hits.push({ area: r.width * r.height, x: r.left + r.width / 2, y: r.top + r.height / 2, label: t });
  }
  hits.sort(function(a, b){ return a.area - b.area });
  var seen = {}, uniq = [];
  for (var j = 0; j < hits.length; j++) {
    var k = Math.round(hits[j].x) + ':' + Math.round(hits[j].y);
    if (seen[k]) continue;
    seen[k] = 1; uniq.push(hits[j]);
  }
  return JSON.stringify(uniq.slice(0, 12));
})()`

/** 页面路第 2.5 步：找「评论(1166)」那个 tab（图文页默认不展开评论区） */
const FIND_TAB_JS = `(function(){
  var rx = /^评论\\s*[（(]\\s*\\d+|^评论\\s*\\d+|^评论$/;
  var all = Array.prototype.slice.call(document.querySelectorAll('div,span,p,a,button'));
  var best = null;
  for (var i = 0; i < all.length; i++) {
    var n = all[i], t = String(n.innerText || '').trim();
    if (!t || t.length > 16 || !rx.test(t)) continue;
    var r = n.getBoundingClientRect();
    if (r.width < 2 || r.height < 2) continue;
    var area = r.width * r.height;
    if (!best || area < best.area) best = { area: area, x: r.left + r.width / 2, y: r.top + r.height / 2, label: t, found: true };
  }
  return JSON.stringify(best || { found: false });
})()`

const READ_BAG_JS = `(function(){
  var bag = window.__replyBag || {};
  var out = {};
  Object.keys(bag).forEach(function(cid){ out[cid] = Object.keys(bag[cid]).map(function(k){ return bag[cid][k] }) });
  return JSON.stringify(out);
})()`

/**
 * 页面路兜底 3：**不靠网络**，直接从已渲染的评论节点里挖 cid。
 * 为什么需要：只有一两条回复时，页面**不显示「展开」按钮**、也就不发那个请求，
 *   拦截器抓不到任何东西（2026-10-28 实测：主人手机上有两条回复，脚本这边 bag 全空）。
 * 抖音的评论节点上没有 cid 属性，但 React fiber 的 memoizedProps 里带
 *   replyInfo / commentInfo / comment，字段里就有 cid、nickname、text。
 */
const DOM_SCAN_JS = `(function(){
  var found = {}, els = document.querySelectorAll('div');
  for (var i = 0; i < els.length; i++) {
    var el = els[i];
    var k = Object.keys(el).find(function(x){ return x.indexOf('__reactFiber$') === 0 });
    if (!k) continue;
    var f = el[k], d = 0;
    while (f && d < 18) {
      var p = f.memoizedProps || {};
      var cands = [p.replyInfo, p.commentInfo, p.comment, p.reply];
      for (var ci = 0; ci < cands.length; ci++) {
        var cc = cands[ci];
        if (!cc || !cc.cid) continue;
        var cid = String(cc.cid);
        if (!found[cid]) {
          var u = cc.user || {};
          found[cid] = {
            cid: cid,
            nick: String(u.nickname || ''),
            uid: String(u.uid || ''),
            text: String(cc.text || '').replace(/\\s+/g, ' ').slice(0, 200),
            at: Number(cc.create_time || 0),
            root_cid: String(cc.reply_id || '')
          };
        }
      }
      f = f.return; d++;
    }
  }
  var out = {};
  Object.keys(found).forEach(function(cid){ var r = found[cid]; if (r.text) out[cid] = r });
  return JSON.stringify(out);
})()`

async function clickAt(c, x, y) {
  await c.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y })
  await c.send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1 })
  await c.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1 })
}

try {
  const c = await openPage()

  // 无头 UA 带 HeadlessChrome：覆盖成普通 Chrome，免得被区别对待
  try {
    const realUA = String(await c.ev('navigator.userAgent')).replace('HeadlessChrome', 'Chrome')
    await c.send('Network.enable')
    await c.send('Network.setUserAgentOverride', { userAgent: realUA, acceptLanguage: 'zh-CN,zh;q=0.9', platform: 'Win32' })
    await sleep(250)
  } catch { /* 失败也继续 */ }

  if (!String(await c.ev('location.href')).includes('douyin.com')) {
    await c.send('Page.navigate', { url: 'https://www.douyin.com/' })
    await sleep(5000)
  }

  const threads = []
  const got = new Map() // root_cid -> replies[]

  // ── ⓪ 签名直连（2026-10-28 新增，最快最稳）：用 _deps\scripts\douyin-signer 里那套
  //    a_bogus 自己算签名，直接 GET /comment/list/reply/，一条一两秒就回来。
  //    有它就不用再"点开界面等页面自己发请求"；没装/失败才往下走页面路。
  if (!API_ONLY) {
    const SIGN_PY = String(process.env.DOUYIN_SIGN_PY || 'D:\\dsh-plugins\\_deps\\python311\\cpython-3.11-windows-x86_64-none\\python.exe')
    const SIGN_SCRIPT = String(process.env.DOUYIN_SIGN_SCRIPT || 'D:\\dsh-plugins\\_deps\\scripts\\douyin-signer\\signed_get.py')
    if (existsSync(SIGN_SCRIPT) && existsSync(SIGN_PY)) {
      for (const cid of CIDS) {
        const query = `device_platform=webapp&aid=6383&channel=channel_pc_web&item_id=${AWEME}&comment_id=${cid}&cursor=0&count=${MAX}&item_type=0&app_name=aweme`
        const sr = spawnSync(SIGN_PY, [SIGN_SCRIPT, '--path', '/aweme/v1/web/comment/list/reply/', '--query', query], { encoding: 'utf8', timeout: 40000 })
        let sp = null
        try { sp = JSON.parse(String(sr.stdout || '').trim()) } catch { sp = null }
        dbg.signed = (dbg.signed || []).concat([{ cid, ok: !!(sp && sp.ok), n: (sp && sp.n) || 0, err: (sp && sp.error) || '' }])
        if (sp && sp.ok && Array.isArray(sp.items) && sp.items.length) {
          got.set(cid, normReplies(sp.items, cid))
        }
      }
    }
    // 全拿到了就不用开页面了
    if (CIDS.every((cid) => got.has(cid))) {
      for (const cid of CIDS) {
        const replies = got.get(cid) || []
        threads.push({ root_cid: cid, via: 'signed', replies, note: '' })
      }
      try { c.close() } catch { /* ignore */ }
      out({ ok: true, aweme: AWEME, threads, total: threads.reduce((a, t) => a + t.replies.length, 0) })
      await sleep(200)
      process.exit(0)
    }
  }

  // ── ① 页面路（主力）：先让页面渲染出评论区，再点开「展开N条回复」，
  //    收页面自己带签名发出的那个请求的响应 —— 不碰签名算法。
  if (!API_ONLY) {
    if (!String(await c.ev('location.href')).includes(AWEME)) {
      await c.send('Page.navigate', { url: `https://www.douyin.com/video/${AWEME}` })
    }
    await c.ev(HOOK_JS)
    let btns = []
    let tabClicked = false
    for (let i = 0; i < 16; i++) {
      await sleep(1800)
      await c.ev(HOOK_JS)
      // 评论面板没展开时先点「评论(1166)」那个 tab（图文页默认只显示作者信息）
      if (!tabClicked) {
        let tab = { found: false }
        try { tab = JSON.parse(String(await c.ev(FIND_TAB_JS))) } catch { /* 忽略 */ }
        if (tab.found) {
          await clickAt(c, Math.round(tab.x), Math.round(tab.y))
          tabClicked = true
          dbg.tabClicked = tab.label
          await sleep(1600)
        }
      }
      try { btns = JSON.parse(String(await c.ev(FIND_BTN_JS))) } catch { btns = [] }
      const snap = await c.ev(`(function(){ var t = document.body.innerText || ''; return JSON.stringify({ href: String(location.href), len: t.length, expand: /展开\\s*\\d+\\s*条回复/.test(t), tab: /评论\\s*[（(]/.test(t) }) })()`).catch(() => '')
      dbg.steps.push({ i, btns: btns.length, snap: String(snap).slice(0, 180) })
      if (btns.length) break
    }
    dbg.clicked = []
    for (const b of btns.slice(0, 10)) {
      try {
        await c.ev(`(function(){ var el = document.elementFromPoint(${Math.round(b.x)}, ${Math.round(b.y)}); if (el && el.scrollIntoView) el.scrollIntoView({ block: 'center' }); return 1 })()`)
        await sleep(400)
        await clickAt(c, Math.round(b.x), Math.round(b.y))
        dbg.clicked.push(b.label)
        await sleep(900)
      } catch { /* 单个按钮失败继续 */ }
    }
    await sleep(1500)
    let bag = {}
    try { bag = JSON.parse(String(await c.ev(READ_BAG_JS))) } catch { bag = {} }
    dbg.bagKeys = Object.keys(bag).map((k) => k + ':' + bag[k].length)
    // 兜底：从已渲染的节点里挖（只有一两条回复时页面不发请求，拦截器抓不到）。
    //   评论区是一屏一屏加载的，所以边滚边扫，攒够为止。
    let dom = {}
    for (let si = 0; si < 8; si++) {
      let part = {}
      try { part = JSON.parse(String(await c.ev(DOM_SCAN_JS))) } catch { part = {} }
      for (const k of Object.keys(part)) dom[k] = part[k]
      await c.ev('(function(){ var el = document.querySelector("[class*=comment]") || document.scrollingElement; try { window.scrollBy(0, 900) } catch(e){} return 1 })()').catch(() => 0)
      await sleep(900)
    }
    dbg.domCids = Object.keys(dom).length
    dbg.domAll = Object.keys(dom).map((k) => k + '|' + (dom[k].nick || '') + '|' + String(dom[k].text || '').slice(0, 24))
    for (const cid of CIDS) {
      const merged = {}
      for (const r of (bag[cid] || [])) merged[String(r.cid || '')] = r
      for (const key of Object.keys(dom)) {
        const r = dom[key]
        if (!r || !r.cid) continue
        // 有的数据里 replyInfo 不带 reply_id：这时没法按 root 归属，只要不是目标本身就先收着
        if (String(r.cid) === String(cid)) continue
        const root = String(r.root_cid || '')
        if (root && root !== String(cid)) continue
        merged[String(r.cid)] = r
      }
      // 顶层自己那条（root 为空或等于自己）不算回复
      delete merged[String(cid)]
      const replies = normReplies(Object.values(merged), cid)
      if (replies.length) got.set(cid, replies)
    }
  }

  // ── ② 接口路兜底（页面路没拿到时才试；它不签名时是"挂住"，6 秒就放弃）
  const rest = CIDS.filter((cid) => !got.has(cid))
  if (rest.length) {
    const apiRaw = await Promise.race([
      c.ev(API_JS(AWEME, rest, MAX)),
      new Promise((_, rej) => setTimeout(() => rej(new Error('接口路整体超时')), 6000 * rest.length + 4000)),
    ]).catch(() => null)
    const apiRes = apiRaw ? JSON.parse(String(apiRaw)) : []
    for (const it of apiRes) {
      const replies = normReplies(it.arr, it.cid)
      if (replies.length) got.set(it.cid, replies)
      dbg.api = (dbg.api || []).concat([{ cid: it.cid, http: it.http, err: it.err, n: (it.arr || []).length }])
    }
  }
  dbgDump()

  for (const cid of CIDS) {
    const replies = got.get(cid) || []
    threads.push({
      root_cid: cid,
      via: replies.length ? 'ok' : 'none',
      replies,
      note: replies.length ? '' : '没读到：接口不签名就不返回；页面也没抓到（评论区可能没渲染出来，或这条下面没有可见回复）',
    })
  }

  // 排查用：把每条回复的 cid / 昵称 / 正文也落盘（输出里只给数量，免得刷屏）
  try {
    dbg.threads = threads.map((t) => ({ root: t.root_cid, replies: (t.replies || []).map((r) => r.cid + '|' + r.nick + '|' + r.text.slice(0, 20)) }))
    dbgDump()
  } catch { /* 忽略 */ }

  try { c.close() } catch { /* ignore */ }
  out({ ok: true, aweme: AWEME, threads, total: threads.reduce((a, t) => a + ((t.replies && t.replies.length) || 0), 0) })
  await sleep(200)
  process.exit(0)
} catch (e) {
  out({ ok: false, error: String((e && e.message) || e) })
  await sleep(200)
  process.exit(1)
}
