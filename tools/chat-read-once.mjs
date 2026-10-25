#!/usr/bin/env node
/**
 * tools/chat-read-once.mjs —— 读一次抖音私信会话，输出一行 JSON
 * ============================================================================
 * 供插件 watcher 每 N 秒调用一次（短生命周期：连 Chrome → 读 DOM → 退出）。
 * 和 chat-watch.mjs（长驻、写 chat-inbox.jsonl）不同，这个只读一轮、打印就走。
 *
 * 用法:
 *   node tools/chat-read-once.mjs [--to "示例好友"] [--to-id "MS4wLjABAAAA…"] [--force-chat]
 *
 *   --force-chat  当前页面不在 /chat 时**强制**导航到私信页（哨兵用）。
 *                 不加时保留老规矩：只在「不属于抖音」的页面上导航，
 *                 抖音视频页/别的抖音页面绝不抢（留给 @ / 分享用）。
 *                 ⚠️ 2026-10-24 踩过：不加这个参数时，页面停在首页或
 *                 「验证码中间页」——它算 douyin.com，于是永远不导航、
 *                 永远读到 0 条、永远静默返回空，看起来跟「没有新消息」一模一样。
 *
 * 输出一行 JSON：{ ok, messages: [{ own, text, img, sid, read, from }], url?, note? }
 *   note 非空 = 这轮没读到东西的**原因**（真被验证码拦 / 需要登录 / 不在私信页 /
 *   会话点不开），调用方要把它记进日志和设置页，别当成「没有新消息」。
 *   ⚠️ note 必须"只在真发生"时出现：2026-10-25 就是误报「验证码中间页」把用户骗去重新登录的。
 *   ⚠️ 打开会话靠**页面内派发事件**（见 OPEN_PEER 的注释），原生鼠标事件在这行上不生效。
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import { openPage, sleep } from '../lib/chrome.mjs'
import { homeDir } from '../lib/paths.mjs'

const argv = process.argv.slice(2)
const argOf = (k, d) => { const i = argv.indexOf(k); return i >= 0 ? (argv[i + 1] ?? d) : d }
// 会话对端：**不硬编码任何账号**（公开仓库不带个人标识）。
// 优先级：--to/--to-id 参数 > 环境变量 DOUYIN_PEER / DOUYIN_PEER_ID > $HOME/peer.json
// peer.json 由本机自己维护（已 gitignore），形如 {"nick":"示例好友","sec_uid":"MS4wLjABAAAA…"}
const peerCfg = (() => {
  try { return JSON.parse(readFileSync(join(homeDir({ create: false }), 'peer.json'), 'utf8')) || {} } catch { return {} }
})()
const TO = String(argOf('--to', process.env.DOUYIN_PEER || peerCfg.nick || '')).trim()
const TOID = String(argOf('--to-id', process.env.DOUYIN_PEER_ID || peerCfg.sec_uid || '')).trim()
const FORCE_CHAT = argv.includes('--force-chat')
const CHAT_URL = String(argOf('--chat-url', 'https://www.douyin.com/chat')).trim() || 'https://www.douyin.com/chat'

const out = (o) => { console.log(JSON.stringify(o)); process.exitCode = o.ok ? 0 : 1 }

const READ_SCRIPT = `(function () {
  var listNode = document.querySelector('[class*="messageMessageList"]')
    || document.querySelector('[class*="componentsRightPanel"]') || document.body;
  var lb = listNode.getBoundingClientRect();
  var mid = lb.left + lb.width / 2;
  var nodes = Array.prototype.slice.call(document.querySelectorAll('[class*="messageMessageBox"]'));
  var out = [], seen = new WeakSet();
  nodes.forEach(function (n) {
    var fk = Object.keys(n).find(function (k) { return k.indexOf('__reactFiber$') === 0 });
    if (!fk) return;
    var f = n[fk], d = 0, found = null;
    while (f && d < 24) {
      var p = f.memoizedProps;
      if (p && p.message && typeof p.message === 'object' && p.message.parsedContent) { found = p.message; break }
      f = f.return; d++;
    }
    if (!found || seen.has(found)) return;
    seen.add(found);
    var r = n.getBoundingClientRect(), side = '';
    var im = Array.prototype.slice.call(n.querySelectorAll('img')).filter(function (img) {
      var b = img.getBoundingClientRect();
      if (b.width < 28 || b.width > 48) return false;
      if (Math.abs(b.width - b.height) > 6) return false;
      var cy = b.top + b.height / 2;
      return cy >= r.top - 2 && cy <= r.bottom + 2;
    })[0];
    if (im) {
      var ib = im.getBoundingClientRect();
      side = ((ib.left + ib.width / 2) < mid) ? 'them' : 'me';
    }
    var pc = found.parsedContent || {};
    var text = String(pc.text || pc.content_title || '').replace(/\\s+/g, ' ').trim();
    var img = '';
    try {
      var cands = [];
      if (Array.isArray(pc.url_list) && pc.url_list.length) cands = pc.url_list;
      else if (Array.isArray(pc.image_list) && pc.image_list.length) {
        pc.image_list.forEach(function (x) {
          if (x && Array.isArray(x.url_list) && x.url_list.length) cands.push(x.url_list[0]);
          else if (x && typeof x.url === 'string') cands.push(x.url);
        });
      }
      if (!cands.length && pc.sticker && typeof pc.sticker === 'object') {
        if (pc.sticker.url) cands.push(pc.sticker.url);
        if (pc.sticker.static_url) cands.push(pc.sticker.static_url);
      }
      if (!cands.length && typeof pc.uri === 'string' && /^https?:/.test(pc.uri)) cands.push(pc.uri);
      img = cands.filter(function (u) { return typeof u === 'string' && /^https?:/.test(u) })[0] || '';
      if (!img) {
        var bigs = Array.prototype.slice.call(n.querySelectorAll('img')).filter(function (x) {
          var b = x.getBoundingClientRect();
          return b.width > 56 && b.height > 56;
        });
        bigs.sort(function (a, b) { return b.getBoundingClientRect().width - a.getBoundingClientRect().width });
        var bsrc = bigs.length ? (bigs[0].currentSrc || bigs[0].src || '') : '';
        if (/^https?:/.test(bsrc)) img = bsrc;
        else if (/^(data|blob):/.test(bsrc)) img = bsrc;
      }
    } catch (e) {}
    out.push({ own: side, text: text, img: img, keys: Object.keys(pc).slice(0, 12), sid: found.serverId ? String(found.serverId) : '', read: /已读/.test(n.innerText || '') });
  });
  var carry = '';
  for (var i = out.length - 1; i >= 0; i--) {
    if (out[i].own) carry = out[i].own;
    out[i].from = out[i].own || carry || 'unknown';
  }
  return JSON.stringify(out);
})()`

// 右栏到底「点开没有」：只认**可见**的消息节点。
// ⚠️ 2026-10-25 用户指出的关键事实：停在右栏那块底图（一个圆圈 logo）时，
//    messageMessageBox 这些节点**依然挂在 DOM 里**，只是不可见 / 滚到视口外，
//    所以"节点存在"不能当成"会话已打开"。用户实测：得点左边那行的头像或名字才会跳出来。
const PANEL_STATE = `(function () {
  var vis = 0, total = 0;
  Array.prototype.forEach.call(document.querySelectorAll('[class*="messageMessageBox"]'), function (n) {
    total++;
    var r = n.getBoundingClientRect();
    if (r.width > 10 && r.height > 10 && r.bottom > 0 && r.top < innerHeight) vis++;
  });
  var h = document.querySelector('[class*="RightPanelHeadertitle"]');
  return JSON.stringify({ visible: vis, total: total, header: h ? String(h.innerText || '').trim() : '' });
})()`

// 点开「peer」会话：在页面内直接派发事件，别用坐标点击。
// ⚠️ 2026-10-25 同一页面反复对照实验（每次先 Page.navigate 回到"底图"状态）：
//   ① 什么都不点 → 右栏 20 秒也不会自己跳出来；
//   ② Input.dispatchMouseEvent 点这行（昵称 / 头像 / 整行中心都试过）→ 右栏照样不动；
//   ③ 页面内 dispatchEvent（同样坐标、同样的事件序列）→ 1 秒内就跳出来了。
//   所以走页面内派发（React 不看 isTrusted），返回 'ok:<方式>' / 'none' / 'err'。
const OPEN_PEER = (nick, sec) => `(function(){
  var NICK = ${JSON.stringify(nick)}, SEC = ${JSON.stringify(sec)};
  var secOf = function (n) {
    var fk = Object.keys(n).find(function (k) { return k.indexOf('__reactFiber$') === 0 });
    if (!fk) return '';
    var f = n[fk], d = 0;
    while (f && d < 14) {
      var p = f.memoizedProps;
      if (p && p.conversation && p.conversation.toParticipantSecUserId) return String(p.conversation.toParticipantSecUserId);
      f = f.return; d++;
    }
    return '';
  };
  var pick = null, how = '';
  Array.prototype.forEach.call(document.querySelectorAll('[data-e2e="conversation-item"]'), function (n) {
    if (pick) return;
    var got = secOf(n);
    var txt = (n.innerText || '').replace(/\\s+/g, ' ').trim();
    var hit = (SEC && got === SEC) || (!SEC && NICK && txt.indexOf(NICK) === 0);
    if (hit) { pick = n; how = 'item'; }
  });
  if (!pick && NICK) {          // 兜底：页面结构变了就按昵称文字找（限左栏）
    Array.prototype.forEach.call(document.querySelectorAll('div,span,p'), function (el) {
      if (pick || el.children.length) return;
      if ((el.textContent || '').trim() !== NICK) return;
      var r = el.getBoundingClientRect();
      if (r.width < 4 || r.height < 4 || r.left > 420) return;
      pick = el; how = 'nick-leaf';
    });
  }
  if (!pick) return 'none';
  var r = pick.getBoundingClientRect();
  var cx = Math.round(r.x + r.width / 2), cy = Math.round(r.y + r.height / 2);
  var tgt = document.elementFromPoint(cx, cy) || pick;   // 点最上层子元素，事件冒泡回整行
  var opt = { bubbles: true, cancelable: true, view: window, clientX: cx, clientY: cy, button: 0 };
  ['pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click'].forEach(function (t) {
    try {
      tgt.dispatchEvent(new (t.indexOf('pointer') === 0 ? PointerEvent : MouseEvent)(t, opt));
    } catch (e) {}
  });
  return 'ok:' + how;
})()`

/**
 * 点开「peer」会话，返回是否真点开了（右栏出现可见消息）。
 *   老版本固定 sleep 2200 就 return true —— 抖音有时不自动跳到聊天界面，
 *   右栏停在底图，这一拍读到 0 条，看起来像"没有新消息"。
 *   实测消息节点是**成批**出现的（0 条 → 33 条是一瞬间），所以给 12 秒等待窗口。
 */
const openConversation = async (ev, send) => {
  const readPanel = async () => {
    try { return JSON.parse(String(await ev(PANEL_STATE))) || {} } catch { return {} }
  }
  const waitOpen = async (ticks) => {                 // ticks × 500ms
    for (let i = 0; i < ticks; i++) {
      await sleep(500)
      if (Number((await readPanel()).visible) > 0) return true
    }
    return false
  }
  if (Number((await readPanel()).visible) > 0) return true   // 已经打开了就别乱点
  for (let round = 0; round < 3; round++) {
    let res = 'err'
    try { res = String(await ev(OPEN_PEER(TO, TOID))) } catch { res = 'err' }
    if (process.env.DOUYIN_DEBUG) process.stderr.write(`[dbg] round${round} open=${res}\n`)
    if (res.indexOf('ok') === 0) {
      if (await waitOpen(24)) return true                // 等 12 秒看它跳没跳出来
      return false                                       // 点了但没跳出来 → 交给外层报原因
    }
    await sleep(1500)                                    // 左栏还没渲染出来 → 等一拍再找
  }
  return false
}

// 页面现在到底是什么：私信页？验证码中间页？要登录？
// ⚠️ 2026-10-25 踩过的坑（这条最坑，会造成"明明没拦也报验证码"）：
//    抖音**常驻**一个 display:none / 0×0 的 rmc-nocaptcha iframe（没拦人也挂在 DOM 里），
//    老代码 `!!querySelector(...)` 只看"存在" → 每一轮都判成「验证码中间页」，
//    于是读 0 条时永远报错、设置页永远劝用户"去有头窗口过验证码"，
//    用户看到的却是好端端的私信页 —— 看起来就像登录态掉了。
//    现在只认"真可见"（面积够大 + 不是 none/hidden），标题变成验证码页也算。
//    comment-api.mjs 早就是这个写法了，这里当时漏了。
const PAGE_STATE = `(function () {
  var t = String(document.title || '');
  var body = (document.body && document.body.innerText) || '';
  var hasChat = !!document.querySelector('[class*="messageMessageBox"]');
  var vis = false;
  var frs = document.querySelectorAll('iframe[src*="verifycenter"], iframe[src*="/captcha"], iframe[src*="verify.zijieapi"], #captcha_container, [class*="captcha"]');
  for (var i = 0; i < frs.length; i++) {
    var el = frs[i], r = el.getBoundingClientRect(), cs = getComputedStyle(el);
    if (r.width > 40 && r.height > 40 && cs.display !== 'none' && cs.visibility !== 'hidden' && Number(cs.opacity || 1) > 0.05) { vis = true; break }
  }
  // 登录判断别拿正文硬匹配：聊天记录里出现"立即登录"这类字样会误报。
  //   真登录弹窗时页面上没有消息节点，所以加一个 hasChat 保护。
  var needsLogin = !hasChat && /扫码登录|验证码登录|密码登录|登录后查看|立即登录/.test(body.slice(0, 600));
  return JSON.stringify({
    href: String(location.href),
    title: t,
    verify: vis || /验证码|安全验证|验证中/.test(t),
    iframeVisible: vis,
    hasChat: hasChat,
    needsLogin: needsLogin
  });
})()`

const pageState = async (c) => {
  try { return JSON.parse(String(await c.ev(PAGE_STATE))) || {} } catch { return {} }
}
const isChat = (u) => String(u || '').includes('/chat')

/** 导航到私信页并等它落地；被验证码/登录拦住就早点放弃，别空耗 20 秒。 */
const navToChat = async (c, maxSec = 20) => {
  try { await c.send('Page.navigate', { url: CHAT_URL }) } catch { return false }
  for (let i = 0; i < maxSec; i++) {
    await sleep(1000)
    if (isChat(String(await c.ev('location.href')))) return true
    const st = await pageState(c)
    if (st.verify || st.needsLogin) return false
  }
  return isChat(String(await c.ev('location.href')))
}

/** 这轮没读到的原因（给日志/设置页看，别静默） */
const whyStuck = (st, href) => {
  if (st && st.verify) return '页面停在「验证码中间页」，需要人工在有头窗口里过验证码（设置页 → 维护 →「切有头 + 触发验证」）'
  if (st && st.needsLogin) return '页面要求登录（登录态已失效），需要人工在有头窗口里登录一次'
  return `当前不在私信页（${(st && st.title) || ''} ${href || ''}）`.replace(/\s+/g, ' ').trim()
}

try {
  const c = await openPage({ url: FORCE_CHAT ? CHAT_URL : 'https://www.douyin.com/' })
  let href = String(await c.ev('location.href'))
  if (!href.includes('douyin.com')) {
    // 不属于抖音的页面（空白页 / 被导航走的停靠页）→ 导航去 /chat
    await navToChat(c)
  } else if (FORCE_CHAT && !isChat(href)) {
    // --force-chat（哨兵）：页面停在首页/验证码中间页/视频页时主动导航回私信页。
    //   工具跑的时候 watcher 是暂停的（pauseWatcher），所以不会抢 @/分享用的视频页。
    await navToChat(c)
  }
  href = String(await c.ev('location.href'))
  if (!isChat(href)) {
    // 还是没落到私信页 → 这一轮不读，但**必须说清楚为什么**（老版本这里静默返回空）
    const st = await pageState(c)
    c.close()
    await sleep(200)
    out({ ok: true, messages: [], url: href, note: whyStuck(st, href) })
    throw { __done: true }
  }
  await sleep(1500)
  // 空读重试：会话面板（右侧消息、左侧列表）常常比页面本体晚好几拍才渲染好。
  //   2026-10-25 实测：点开会话后消息节点要 ~6s 才成批出现；老版本一拍 0 条就下结论，
  //   还配上误报的"验证码"，看起来像登录态掉了。
  const readNow = async () => {
    const raw = await c.ev(READ_SCRIPT)
    try { return JSON.parse(raw) || [] } catch { return [] }   // 页面没准备好
  }
  const opened = await openConversation(c.ev, c.send)   // 里面已经把等待算好了
  let list = await readNow()
  if (!list.length && opened) {       // 面板确实开着、但这一拍没解析出来 → 再等一拍重读
    await sleep(1500)
    list = await readNow()
  }
  let note = ''
  if (!list.length) {
    // 真的一条都没有 → 必须说清原因，别报成「没有新消息」（调用方会写日志+设置页）
    const st = await pageState(c)
    if (st.verify || st.needsLogin) note = whyStuck(st, href)
    else if (!opened) note = `没能打开「${TO || TOID || '对端'}」的会话（点昵称/头像都没跳出来：左栏没加载，或登录态已掉）`
    else note = '会话面板里读不到消息（打开后重读两次都空），下一轮再试'
  }
  c.close()
  await sleep(200)
  out(note
    ? { ok: true, messages: Array.isArray(list) ? list : [], url: href, note }
    : { ok: true, messages: Array.isArray(list) ? list : [] })
} catch (e) {
  if (!(e && e.__done)) out({ ok: false, error: String(e?.message ?? e) })
}
