#!/usr/bin/env node
/**
 * tools/im-send.mjs —— 私信发送器（插件调这个）
 * ============================================================================
 * 全程**无窗口**：跑的是无头 Chrome 里抖音自己的前端，连接/签名/编解码都由它完成。
 * 我们只做三件事：点开会话 → 粘正文 → 回车。
 *
 * 用法：
 *   node tools/im-send.mjs --to "示例好友" --text "你好"
 *   node tools/im-send.mjs --to "示例好友" --file <txt路径>
 *   node tools/im-send.mjs --to "示例好友" --file x.txt --dry   # 只验证不发送
 *   node tools/im-send.mjs --to "示例好友" --read               # 只读：把会话读出来（带「谁发的」）
 *
 * 输出：一行 JSON
 *   发送：{ok, sent, to, len, readback, my_msg_before, my_msg_after, newest_from, msgs_sample, …}
 *   只读：{ok, mode:'read', count, mine, them, unknown, messages:[{from,text,…}]}（messages 旧的在前）
 *
 * ⚠️ 「谁发的」判据是**头像落在列表左半边还是右半边**，不是 `isMyMessage`
 *    （`isMyMessage` 恒为 true，连对方发的也是 true —— 实测过，别再用）。
 * ============================================================================
 */
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

import { openPage, sleep } from '../lib/chrome.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))

const out = (o) => { console.log(JSON.stringify(o, null, 1)); process.exitCode = o.ok ? 0 : 1 }

const argv = process.argv.slice(2)
const argOf = (k, d) => { const i = argv.indexOf(k); return i >= 0 ? (argv[i + 1] ?? '') : d }
const TO = argOf('--to', '')
const TOID = argOf('--to-id', '')
const FILE = argOf('--file', '')
const TEXT = argOf('--text', '')
const DRY = argv.includes('--dry')
const READ = argv.includes('--read')
/** ⭐ --list：只列出会话里的人（昵称 + sec_uid），不发东西 */
const LIST = argv.includes('--list')

const bodyText = async (ev) => (await ev(`(document.body?document.body.innerText:'')||''`)) || ''

/**
 * ⭐ 回读消息列表 + 判定「这条到底是谁发的」。
 *
 * ── 判据：**头像落在列表的哪半边** ────────────────────────────────────────
 *   我的消息靠右打 ⇒ 36×36 头像的 x≈1354（列表中线 ≈860 的右边）
 *   对方的消息靠左 ⇒ 头像的 x≈320（左边）
 *
 * ── 为什么只能用这个（2026-10-21 逐条试过，别的全是死路） ────────────────
 *   ✗ `message.isMyMessage` —— **恒为 true**，连主人发的那几条也是 true
 *   ✗ 三层祖先的 class 名 —— 我发的和对方发的完全一样
 *   ✗ 消息行的几何 —— 都是整行宽（x=304 w=1102），没有左右布局之分
 *   ✗ `parsedContent` 里也没有 sender 字段（只有 type/text/aweType/createdAt/is_card）
 *   ✓ 头像的横向落点 —— 唯一稳定可用的信号；头像 URL 也固定（我方 …d7VAiREY / 对方 …yZQrf6lE）
 *
 * ── 两个坑 ────────────────────────────────────────────────────────────────
 *   1. 同一人连发几条时，**只有组里最早那条带头像**，后面几条没有
 *      ⇒ 从旧往新扫，缺的继承上一条（不是"下一条"）
 *   2. DOM 顺序是「新的在上」、视觉是「旧的在上」（容器是 column-reverse）
 *      ⇒ 必须**倒着遍历**才能让继承方向正确
 *   3. 一条都扫不到头像（比如最顶上被裁掉的那条）⇒ 给 `unknown`，**不猜**
 *
 * 输出每条：{ from: 'me'|'them'|'unknown', text, awe, item, own }
 */
const readMessages = async (ev) => {
  const raw = await ev(`(function(){
    var listNode = document.querySelector('[class*="messageMessageList"]')
      || document.querySelector('[class*="componentsRightPanel"]') || document.body;
    var lb = listNode.getBoundingClientRect();
    var mid = lb.left + lb.width / 2;
    // ⚠️ 一条消息在 DOM 里有 3 层 class 都含 "messageMessageBox"（outer / selectableRow / contentBox），
    //    直接 querySelectorAll 会**一条算三条** ⇒ 用 **对象引用** 去重（同一层消息被多个节点共享同一个
    //    message 对象）。别用位置去重：三层节点的 top 差几个像素，会漏掉。
    var nodes = Array.prototype.slice.call(document.querySelectorAll('[class*="messageMessageBox"]'));
    var out = [], seenObj = new WeakSet();
    nodes.forEach(function(n){
      var fk = Object.keys(n).find(function(k){ return k.indexOf('__reactFiber$') === 0 });
      if (!fk) return;
      var f = n[fk], d = 0, found = null;
      while (f && d < 24) {
        var p = f.memoizedProps;
        if (p && p.message && typeof p.message === 'object' && p.message.parsedContent) { found = p.message; break }
        f = f.return; d++;
      }
      if (!found) return;
      if (seenObj.has(found)) return;
      seenObj.add(found);
      // 这一条自己带的那枚头像落在哪边（只认 36×36 的正方形；分享卡片缩略图是 108px、已读标记是 20px，都排除）
      var r = n.getBoundingClientRect(), side = '';
      var im = Array.prototype.slice.call(n.querySelectorAll('img')).filter(function(img){
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
      out.push({ own: side, text: text, awe: pc.aweType || 0, item: pc.itemId ? String(pc.itemId) : '', sid: found.serverId ? String(found.serverId) : '', keys: Object.keys(found).slice(0, 25), pckeys: Object.keys(pc).slice(0, 15) });
    });
    return JSON.stringify(out);
  })()`)
  let list = []
  try { list = JSON.parse(raw) || [] } catch { return [] }
  // 分组继承：倒着走 = 从旧到新
  let carry = ''
  for (let i = list.length - 1; i >= 0; i--) {
    if (list[i].own) carry = list[i].own
    list[i].from = list[i].own || carry || 'unknown'
  }
  return list
}

const hasEditor = async (ev) => await ev(`(function(){
  var eds=Array.prototype.slice.call(document.querySelectorAll('[contenteditable="true"], textarea'));
  return eds.some(function(e){var r=e.getBoundingClientRect(); return r.width>80 && r.height>10;});
})()`)

/**
 * 列出会话列表里的每一项：昵称（显示用）+ **sec_uid（稳定 id）** + 点击坐标。
 * ⚠️ sec_uid 从会话项的 React fiber 里读 `conversation.toParticipantSecUserId` ——
 *    昵称会重名，这个不会（2026-10-21 用户指出「光靠昵称不安全」后改的）。
 */
const listConversations = (ev) => ev(`(function(){
  var out = [];
  var nodes = Array.prototype.slice.call(document.querySelectorAll('[data-e2e="conversation-item"]'));
  nodes.forEach(function(n){
    var fk = Object.keys(n).find(function(k){ return k.indexOf('__reactFiber$') === 0 });
    var sec = '';
    if (fk) {
      var f = n[fk], d = 0;
      while (f && d < 14) {
        var p = f.memoizedProps;
        if (p && p.conversation && p.conversation.toParticipantSecUserId) { sec = String(p.conversation.toParticipantSecUserId); break }
        f = f.return; d++;
      }
    }
    var r = n.getBoundingClientRect();
    var t = (n.innerText || '').replace(/\\s+/g, ' ').trim();
    out.push({ sec_uid: sec, text: t.slice(0, 70), x: Math.round(r.x + r.width/2), y: Math.round(r.y + r.height/2), w: Math.round(r.width), h: Math.round(r.height) });
  });
  return JSON.stringify(out);
})()`)

/** 从会话项文本里猜昵称（第一段；"示例好友 12:12 最后一句话" → "示例好友"） */
const nickOf = (text) => String(text || '').split(/\s+/)[0] || ''

/** 读「当前打开的这个会话」的对端 sec_uid —— 用来校验身份（不同层级包法不一样，多试几种） */
const currentConvId = (ev) => ev(`(function(){
  function tp(o){
    if (!o || typeof o !== 'object') return '';
    var cands = [
      o.curConversation && o.curConversation.toParticipantSecUserId,
      o.conversation && o.conversation.toParticipantSecUserId,
      o.msgConfig && o.msgConfig.conversation && o.msgConfig.conversation.toParticipantSecUserId,
      o.message && o.message.msgConfig && o.message.msgConfig.conversation && o.message.msgConfig.conversation.toParticipantSecUserId,
    ];
    for (var i = 0; i < cands.length; i++) if (cands[i]) return String(cands[i]);
    return '';
  }
  var node = document.querySelector('[class*="messageMessageBox"]') || document.querySelector('[data-e2e="msg-item-content"]');
  if (!node) return '';
  var fk = Object.keys(node).find(function(k){ return k.indexOf('__reactFiber$') === 0 });
  if (!fk) return '';
  var f = node[fk], d = 0;
  while (f && d < 30) {
    var got = tp(f.memoizedProps);
    if (got) return got;
    f = f.return; d++;
  }
  return '';
})()`)

/**
 * 打开会话。返回 { status, matched }
 *   status: 'already-open' | 'clicked' | 'not-found' | 'ambiguous' | 'no-list'
 *   ⚠️ 只在「昵称唯一」或「给了稳定 id」时才点 —— 重名一律 ambiguous，不猜。
 *   ⚠️ 已经打开着也不轻信：给了 whoId 就必须核对当前会话的对端 id，不然会「发给错的人还报成功」。
 */
async function openConversation(ev, send, who, whoId) {
  if (await hasEditor(ev)) {
    const curId = String(await currentConvId(ev) || '')
    const t = await bodyText(ev)
    if (whoId) {
      if (curId && curId === whoId) return { status: 'already-open', matched: { sec_uid: curId, nick: who } }
      if (!curId) return { status: 'unverifiable', matched: null, hint: '会话开着但读不到对端 id，不敢确认发给谁 —— 请关掉会话重试，或改用昵称' }
      // 当前开着的是别人 ⇒ 继续往下走，去列表里点对的那个
    } else if (who && t.includes(who)) {
      return { status: 'already-open', matched: { sec_uid: curId, nick: who } }
    }
  }
  const raw = await listConversations(ev)
  let list = []
  try { list = JSON.parse(raw) || [] } catch { list = [] }
  if (!list.length) return { status: 'no-list', matched: null }

  let hits = []
  if (whoId) {
    hits = list.filter((c) => c.sec_uid === whoId)
  } else if (who) {
    hits = list.filter((c) => c.text.includes(who))
  } else {
    return { status: 'not-found', matched: null }
  }

  if (!hits.length) return { status: 'not-found', matched: null, candidates: list.map((c) => ({ sec_uid: c.sec_uid, nick: nickOf(c.text) })) }
  if (hits.length > 1) {
    // 同名多个 ⇒ 绝不猜（猜错就是把私信发给陌生人）
    return {
      status: 'ambiguous',
      matched: null,
      candidates: hits.map((c) => ({ sec_uid: c.sec_uid, nick: nickOf(c.text) })),
      hint: '会话列表里有多个同名的人 —— 请改用 --to-id <sec_uid> 指定',
    }
  }
  const b = hits[0]
  await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: b.x, y: b.y, button: 'none', buttons: 0 })
  await sleep(80)
  await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: b.x, y: b.y, button: 'left', buttons: 1, clickCount: 1 })
  await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: b.x, y: b.y, button: 'left', buttons: 0, clickCount: 1 })
  await sleep(2200)
  // 点完再核对一次：开着的是不是真的是他
  const after = String(await currentConvId(ev) || '')
  if (whoId && after && after !== whoId) {
    return { status: 'mismatch', matched: null, want: whoId, got: after, hint: '点开的会话对端不是要发的那个人，已中止' }
  }
  return { status: 'clicked', matched: { sec_uid: after || b.sec_uid, nick: nickOf(b.text) } }
}

async function main() {
  /**
   * ⭐ `--list`：把**会话列表里的人**列出来（昵称 + sec_uid + 头像）。
   *    为什么要有：设置页原来让人手填「私信发给谁」和「稳定 ID」——
   *    新手根本不知道 sec_uid 是什么，更找不到。现在直接点选。
   *    只读，不发任何东西。
   */
  if (LIST) {
    const c = await openPage({ url: 'https://www.douyin.com/chat' })
    try {
      const url = String(await c.ev('location.href'))
      if (!url.includes('/chat')) {
        await c.send('Page.navigate', { url: 'https://www.douyin.com/chat' })
        await sleep(5000)
      }
      await sleep(2500)
      const raw = await listConversations(c.ev)
      let list = []
      try { list = JSON.parse(raw) || [] } catch { list = [] }
      const people = list.map((x) => {
        const nick = nickOf(x.text)
        // 会话项文本是「昵称 时间 最后一句话」，去掉昵称和时间，剩下的是预览
        const preview = String(x.text || '').slice(nick.length).trim()
          .replace(/^\d{1,2}:\d{2}\s*/, '')
          .replace(/^(昨天|前天|\d+月\d+日)\s*/, '')
          .slice(0, 50)
        return { nick, sec_uid: x.sec_uid || '', preview, has_id: Boolean(x.sec_uid) }
      }).filter((p) => p.nick)
      // 同名的人标出来（这种必须用 sec_uid 区分）
      const counts = {}
      for (const p of people) counts[p.nick] = (counts[p.nick] || 0) + 1
      for (const p of people) p.duplicate = counts[p.nick] > 1
      return out({
        ok: true, mode: 'list', read_only: true,
        count: people.length,
        people,
        no_id_count: people.filter((p) => !p.has_id).length,
        hint: people.length
          ? (people.some((p) => p.duplicate)
            ? '有同名的人 —— 选的时候看「最近一条消息」区分，别选错'
            : '这些都是你最近聊过的人，直接选一个就行')
          : '会话列表是空的 —— 先在抖音里跟要发的人聊一句，再回来这里选',
      })
    } finally { c.close() }
  }

  const text = FILE ? readFileSync(FILE, 'utf8').trim() : String(TEXT || '').trim()
  if (!READ) {
    if (!text) return out({ ok: false, error: '没有正文（用 --text 或 --file）' })
    if (text.length > 1800) return out({ ok: false, error: `正文太长（${text.length} 字），抖音私信放不下，拆开发` })
  }

  const c = await openPage({ url: 'https://www.douyin.com/chat' })
  const chromed = c.status
  try {
    // 确保停在 /chat
    const url = await c.ev('location.href')
    if (!String(url).includes('/chat')) {
      await c.send('Page.navigate', { url: 'https://www.douyin.com/chat' })
      await sleep(5000)
    }
    const opened = await openConversation(c.ev, c.send, TO, TOID)
    if (opened.status === 'ambiguous') {
      return out({
        ok: false, error: '会话列表里有多个同名的人，不敢猜（猜错就是把私信发给陌生人）',
        nick: TO, candidates: opened.candidates, hint: opened.hint,
      })
    }
    if (opened.status === 'no-list') return out({ ok: false, error: '会话列表没加载出来（可能还没登录）', chrome: chromed })
    if (opened.status === 'unverifiable' || opened.status === 'mismatch') {
      return out({ ok: false, error: opened.hint || '核对会话身份失败，已中止', detail: opened })
    }
    if (opened.status === 'not-found') {
      return out({ ok: false, error: TOID ? `会话列表里没有 sec_uid=${TOID} 这个人` : `在会话列表里没找到「${TO}」`, candidates: opened.candidates || [], chrome: chromed })
    }
    if (!(await hasEditor(c.ev))) return out({ ok: false, error: '会话没打开（找不到输入框）', opened, chrome: chromed })
    const target = opened.matched || { sec_uid: TOID || '', nick: TO }

    // ── 只读模式：把会话读出来（带「谁发的」）──
    if (READ) {
      const msgs = await readMessages(c.ev)
      const ordered = msgs.slice().reverse()          // DOM 是新的在上 ⇒ 翻过来 = 旧→新
      const cnt = (k) => msgs.filter((m) => m.from === k).length
      return out({
        ok: true, mode: 'read', read_only: true,
        to: target.nick, to_sec_uid: target.sec_uid || undefined,
        matched_by: TOID ? 'sec_uid' : 'nickname(唯一)',
        count: msgs.length, mine: cnt('me'), them: cnt('them'), unknown: cnt('unknown'),
        sender_attribution: 'avatar-side（36px 头像落在列表左/右半边；unknown = 该组没有头像可继承）',
        // 最新的在最后一条
        messages: ordered.slice(-60).map((m) => ({
          from: m.from,
          text: String(m.text || '').slice(0, 160),
          awe: m.awe || undefined,
          item: m.item || undefined,
        })),
      })
    }

    const before = (await bodyText(c.ev)).length
    const beforeMsgs = await readMessages(c.ev)
    if (DRY) return out({ ok: true, sent: false, dry: true, to: target.nick, to_sec_uid: target.sec_uid || undefined, len: text.length, matched_by: TOID ? 'sec_uid' : 'nickname(唯一)', msgs_in_view: beforeMsgs.length, chrome: chromed })

    // 点输入框
    const pos = JSON.parse(await c.ev(`(function(){
      var eds=Array.prototype.slice.call(document.querySelectorAll('[contenteditable="true"], textarea'));
      for (var i=0;i<eds.length;i++){var e=eds[i];var r=e.getBoundingClientRect();if(r.width>80&&r.height>10)return JSON.stringify({x:Math.round(r.x+r.width/2),y:Math.round(r.y+r.height/2)});}
      return '{}';
    })()`))
    await c.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: pos.x, y: pos.y, button: 'left', clickCount: 1 })
    await c.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: pos.x, y: pos.y, button: 'left', clickCount: 1 })
    await sleep(400)
    await c.send('Input.insertText', { text })
    await sleep(800)

    const typed = await c.ev(`(function(){
      var e=document.querySelector('[contenteditable="true"], textarea');
      return e ? String(e.innerText||e.value||'').replace(/[\\u200b\\r]/g,'') : '';
    })()`)
    if (!String(typed).trim()) return out({ ok: false, error: '正文没进输入框（可能被风控拦截）', chrome: chromed })

    await c.send('Input.dispatchKeyEvent', { type: 'rawKeyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13 })
    await c.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13 })
    await sleep(2600)

    const bodyNow = await bodyText(c.ev)
    const leftInBox = await c.ev(`(function(){
      var e=document.querySelector('[contenteditable="true"], textarea');
      return (e?String(e.innerText||e.value||''):'').replace(/[\\u200b\\s]/g,'').length;
    })()`)
    // ⭐ 第 ③ 步：**回读消息列表**，而且只数 `from === 'me'` 的
    //
    // 2026-10-21 上半场还以为"读不出谁发的"，当时是错用了 `isMyMessage`（恒 true）。
    // 后来挖到头像左右这个判据，回读才算真的完整：
    //   「这段正文在**我发的**消息里从 N 条变成 N+1 条」—— 这才叫发成功了。
    // 如果光数总数，别人刚好发了同样的话就会假阳性。
    const afterMsgs = await readMessages(c.ev)
    const norm = (s) => String(s || '').replace(/\s+/g, ' ').trim()
    const sentText = norm(text)
    const head = sentText.slice(0, 20)
    const isMine = (m) => m.from === 'me' && m.text
      && (norm(m.text) === sentText || norm(m.text).startsWith(head))
    const beforeCnt = beforeMsgs.filter(isMine).length
    const afterCnt = afterMsgs.filter(isMine).length
    const readback = afterCnt > beforeCnt
    // 列表里最新那条是谁发的（我发完，这里应该翻成 'me'）
    const newest = afterMsgs[0] || null
    // 页面上出现过（弱证据，留作参考）
    const appeared = String(bodyNow).replace(/\s+/g, ' ').includes(text.replace(/\s+/g, ' ').slice(0, 24))
    const ok = Number(leftInBox) === 0 && readback
    return out({
      ok, sent: ok, to: target.nick, to_sec_uid: target.sec_uid || undefined, len: text.length,
      matched_by: TOID ? 'sec_uid' : 'nickname(唯一)',
      from: before, to_len: String(bodyNow).length, clicked: opened.status, chrome: chromed,
      // ⭐ 回读证据（只数我发的）
      readback,
      my_msg_before: beforeCnt, my_msg_after: afterCnt,
      sender_attribution: 'avatar-side（36px 头像落在列表左/右半边）',
      newest_from: newest ? newest.from : undefined,
      newest_text: newest ? String(newest.text || '').slice(0, 40) : undefined,
      msgs_in_view_before: beforeMsgs.length, msgs_in_view_after: afterMsgs.length,
      // DOM 顺序是「新的在上」，所以前 3 条就是最新的 3 条
      msgs_sample: afterMsgs.slice(0, 3).map((m) => `${m.from}: ${String(m.text || '').slice(0, 36)}`),
      appeared, box_left: Number(leftInBox),
      error: ok ? undefined
        : (!readback ? '回读没在「我发的」消息里找到这条（可能没发出去）' : '输入框没清空'),
    })
  } finally { c.close() }
}

main().catch((e) => out({ ok: false, error: String(e?.message ?? e) }))
