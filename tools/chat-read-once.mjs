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
 *   note 非空 = 这轮没读到东西的**原因**（验证码中间页 / 需要登录 / 不在私信页），
 *   调用方要把它记进日志和设置页，别当成「没有新消息」。
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

// 点开「peer」会话（会话列表左侧那一行），返回是否点开
const openConversation = async (ev, send) => {
  const found = await ev(`(function(){
    var NICK = ${JSON.stringify(TO)}, SEC = ${JSON.stringify(TOID)};
    var nodes = Array.prototype.slice.call(document.querySelectorAll('[data-e2e="conversation-item"]'));
    for (var i = 0; i < nodes.length; i++) {
      var n = nodes[i];
      var fk = Object.keys(n).find(function(k){ return k.indexOf('__reactFiber$') === 0 });
      var got = '';
      if (fk) {
        var f = n[fk], d = 0;
        while (f && d < 14) {
          var p = f.memoizedProps;
          if (p && p.conversation && p.conversation.toParticipantSecUserId) { got = String(p.conversation.toParticipantSecUserId); break }
          f = f.return; d++;
        }
      }
      var txt = (n.innerText || '').replace(/\\s+/g, ' ').trim();
      var hit = (SEC && got === SEC) || (!SEC && txt.indexOf(NICK) === 0);
      if (!hit) continue;
      var r = n.getBoundingClientRect();
      return JSON.stringify({ x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) });
    }
    return '';
  })()`)
  if (!found) return false
  const b = JSON.parse(found)
  await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: b.x, y: b.y, button: 'none', buttons: 0 })
  await sleep(120)
  await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: b.x, y: b.y, button: 'left', buttons: 1, clickCount: 1 })
  await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: b.x, y: b.y, button: 'left', buttons: 0, clickCount: 1 })
  await sleep(2200)
  return true
}

// 页面现在到底是什么：私信页？验证码中间页？要登录？
const PAGE_STATE = `(function () {
  var t = String(document.title || '');
  var body = (document.body && document.body.innerText) || '';
  var vf = !!document.querySelector('iframe[src*="verifycenter"], iframe[src*="/captcha"], iframe[src*="verify.zijieapi"], #captcha_container, [class*="captcha"]');
  var needsLogin = /扫码登录|验证码登录|密码登录|登录后查看|立即登录/.test(body.slice(0, 600));
  return JSON.stringify({
    href: String(location.href),
    title: t,
    verify: vf || /验证码|安全验证|验证中/.test(t),
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
  if (st && st.verify) return '页面停在「验证码中间页」，需要人工在有头窗口里过验证码（切 --headless=off 让用户手动过）'
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
  await openConversation(c.ev, c.send)
  const raw = await c.ev(READ_SCRIPT)
  let list = []
  try { list = JSON.parse(raw) || [] } catch { /* 页面没准备好 */ }
  let note = ''
  if (!list.length) {
    // 一条都没有时多看一眼：可能验证码盖在 /chat 上也读不到（别报成「没有新消息」）
    const st = await pageState(c)
    if (st.verify) note = whyStuck(st, href)
  }
  c.close()
  await sleep(200)
  out(note
    ? { ok: true, messages: Array.isArray(list) ? list : [], url: href, note }
    : { ok: true, messages: Array.isArray(list) ? list : [] })
} catch (e) {
  if (!(e && e.__done)) out({ ok: false, error: String(e?.message ?? e) })
}
