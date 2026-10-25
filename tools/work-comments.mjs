#!/usr/bin/env node
/**
 * tools/work-comments.mjs —— 读「作品」的评论 + 判断**我回过没有**（判据在服务端）
 * ============================================================================
 * 为什么判断要用子评论接口，而不是本地台账：
 *   台账只记"经本插件发出去的"，而实际回复可能来自 creator 后台、别的会话、手机上，
 *   台账根本看不见 —— 于是"我刚回了什么"变成每次都要重新爬。
 *   所以：**判据放在服务端** —— 子评论里只要有一条 `user.uid == 作品作者 uid`，
 *   那就是我回过了；正文也一起带回来，调用方可以直接补录台账。
 *
 * ⚠️ 2026-10-25 踩过的坑（用户实测发现）：**不能用 `reply_comment` 预筛要不要探**。
 *    抖音的 comment/list 经常把 `reply_comment` 给成 undefined / 空列表（实测两个作品
 *    全返回 undefined），于是"reply_total = 0 → 不探 → 一律判成没回过"，
 *    连已经回过的（比如"洛"下面那条"别哭，装上就有"）都被误判。
 *    ⇒ 现在：**每条都探**（并发 4），`reply_comment_*` 只当参考信息，绝不参与判据。
 *
 * 用法:
 *   node tools/work-comments.mjs --aweme <作品id>[,<作品id>] [--max 20] [--discover 0|1]
 *
 * 输出一行 JSON：
 *   { ok, author:{nick,uid,sec_uid}, discovered:[作品id…], works:[{
 *       aweme, total, n, items:[{ cid, nick, uid, text, time,
 *         answered_by_me, my_reply, my_reply_cid, my_reply_time,
 *         reply_hint, stale }] }], error?, code? }
 */
import { openPage, sleep } from '../lib/chrome.mjs'

const argv = process.argv.slice(2)
const argOf = (k, d) => { const i = argv.indexOf(k); return i >= 0 ? (argv[i + 1] ?? d) : d }
const AWEMES = String(argOf('--aweme', '')).split(',').map((s) => s.trim()).filter(Boolean)
const MAX = Math.max(1, Number(argOf('--max', '20')) || 20)
const MAX_AGE_H = Number(argOf('--max-age-hours', '48')) || 48
const DISCOVER = String(argOf('--discover', '1')) !== '0'   // 顺手列出"我全部作品"，自动跟进新作品
const MAX_WORK_AGE_DAYS = Math.max(0, Number(argOf('--max-work-age-days', '0')) || 0)  // 作品发布超过这么多天就不再回（0 = 不限）

const out = (o) => { console.log(JSON.stringify(o)); process.exitCode = o.ok ? 0 : 1 }
if (!AWEMES.length) { out({ ok: false, error: '缺 --aweme（作品 id，可逗号分隔）' }); process.exit(1) }

const COMMON = {
  device_platform: 'webapp', aid: '6383', channel: 'channel_pc_web', pc_client_type: '1',
  version_code: '190500', version_name: '19.5.0', cookie_enabled: 'true',
  screen_width: '1920', screen_height: '1080', browser_language: 'zh-CN', browser_platform: 'Win32',
  browser_name: 'Chrome', browser_version: '141.0.0.0', engine_name: 'Blink',
  engine_version: '141.0.0.0', os_name: 'Windows', os_version: '10', platform: 'PC',
}

const JS = (ids, max, discover, maxWorkAgeDays) => `(async function(){
  var COMMON = ${JSON.stringify(COMMON)};
  var IDS = ${JSON.stringify(ids)};
  var MAX = ${Number(max)};
  var DISCOVER = ${discover ? 'true' : 'false'};
  var maxWorkAgeDays = ${Number(maxWorkAgeDays) || 0};
  var POOL = 4;
  function qs(d){ return Object.keys(d).map(function(k){return encodeURIComponent(k)+'='+encodeURIComponent(d[k]);}).join('&'); }
  function wait(ms){ return new Promise(function(r){ setTimeout(r, ms) }) }
  async function jget(path){
    try {
      var r = await fetch(path, { credentials:'include', headers:{ Referer:'https://www.douyin.com/' } });
      var t = await r.text();
      try { return JSON.parse(t) } catch(e) { return { __head: t.slice(0,100) } }
    } catch(e) { return { __err: String(e && e.message || e) } }
  }
  var res = { author: null, discovered: [], works: [] };
  var authorUid = '', authorSec = '';

  // ① 作者 = 我
  var d = await jget('/aweme/v1/web/aweme/detail/?' + qs(Object.assign({}, COMMON, { aweme_id: IDS[0] })));
  var a = (d.aweme_detail || {}).author || {};
  authorUid = String(a.uid || '');
  authorSec = String(a.sec_uid || '');
  if (authorUid) res.author = { nick: a.nickname || '', uid: authorUid, sec_uid: authorSec };

  // ② 顺手列出"我全部作品"（新发一条不用等通知也能被扫到）
  var workTime = {};   // aweme_id -> 发布时间（秒）
  if (DISCOVER && authorSec) {
    var p = await jget('/aweme/v1/web/aweme/post/?' + qs(Object.assign({}, COMMON, { sec_user_id: authorSec, count:'10', max_cursor:'0' })));
    var pl = (p.aweme_list || []);
    res.discovered = pl.map(function(x){ return String(x.aweme_id) }).filter(Boolean);
    for (var q = 0; q < pl.length; q++) {
      var ct = Number(pl[q].create_time || 0);
      if (ct > 0) workTime[String(pl[q].aweme_id)] = ct;
    }
    await wait(300);
  }

  // ③ 逐个作品读评论（先按"作品发布多久"筛，太老的不回 —— 别去翻旧账）
  var nowSec = Math.floor(Date.now() / 1000);
  for (var i = 0; i < IDS.length; i++) {
    var aid = IDS[i];
    var w = { aweme: aid, total: 0, n: 0, items: [] };

    // 作品发布时间：优先用作品列表里的，没有就查一次详情
    if (!workTime[aid]) {
      var dw = await jget('/aweme/v1/web/aweme/detail/?' + qs(Object.assign({}, COMMON, { aweme_id: aid })));
      var aw = (dw.aweme_detail || {});
      var ct2 = Number(aw.create_time || 0);
      if (ct2 > 0) workTime[aid] = ct2;
      await wait(250);
    }
    if (workTime[aid]) {
      w.create_time = workTime[aid];
      w.age_days = Math.floor((nowSec - workTime[aid]) / 86400);
      if (maxWorkAgeDays > 0 && w.age_days > maxWorkAgeDays) {
        w.skipped = 'work_too_old';       // 发布太久了：整条作品的评论都不再回
        res.works.push(w);
        continue;
      }
    }

    var all = [], cursor = 0, hasMore = true, pages = 0;
    while (all.length < MAX && hasMore && pages < 6) {
      var cl = await jget('/aweme/v1/web/comment/list/?' + qs(Object.assign({}, COMMON, { aweme_id: aid, cursor: String(cursor), count: '20', item_type: '0' })));
      if (!cl.comments) { w.error = cl.__head || cl.__err || 'comment/list 失败'; break }
      w.total = Number(cl.total || w.total || 0);
      all = all.concat(cl.comments);
      hasMore = Number(cl.has_more) === 1 && (cl.comments || []).length > 0;
      cursor = Number(cl.cursor || 0);
      pages++;
      if (hasMore && all.length < MAX) await wait(400);
    }
    var cs = all.slice(0, MAX);
    w.n = cs.length;

    var items = cs.map(function(c){
      var u = c.user || {};
      var rc = c.reply_comment || null;
      return {
        cid: String(c.cid || ''),
        nick: String(u.nickname || ''),
        uid: String(u.uid || ''),
        text: String(c.text || '').replace(/\\s+/g, ' ').slice(0, 160),
        time: Number(c.create_time || 0),
        // 只作参考：抖音经常给 undefined，**不拿它当"要不要探"的依据**
        reply_hint: rc ? (rc.reply_comment_total === undefined ? 'unknown' : Number(rc.reply_comment_total) || 0) : 'none',
        answered_by_me: false,
        my_reply: '',
        my_reply_cid: '',
        my_reply_time: 0,
      };
    });

    // ④ 每条顶层评论都探子评论（并发 4，翻页）
    //   收两样东西：
    //     ① 「我回过没有」——按 **reply_to_reply_id** 精确到具体那一条，而不是整条线程
    //     ② 别人的回复（带真实父节点），用来还原抖音那样的**树**
    //   ⚠️ 2026-10-25 调查结论（脚本实测）：接口每条回复都带
    //        reply_id            = 根评论
    //        reply_to_reply_id   = 它实际回复的那一条（0 表示直接回根）
    //      所以层级要用 reply_to_reply_id 算，不能一律挂到顶层 —— 挂错就会像抖音上
    //      "对，画面上的字也能认"那样，明明在潇下面，我们却记成挂在石桥伶麦下面。
    var idx = 0;
    var rawReplies = {};   // rootCid -> [reply...]
    async function worker(){
      while (idx < items.length) {
        var it = items[idx++];
        if (!it.cid) continue;
        var rcs = [], rcursor = 0, rpage = 0, rmore = true;
        while (rmore && rpage < 3) {
          var rr = await jget('/aweme/v1/web/comment/list/reply/?' + qs(Object.assign({}, COMMON, { item_id: aid, comment_id: it.cid, cursor: String(rcursor), count: '50', item_type: '0' })));
          var pageR = (rr.comments || []);
          rcs = rcs.concat(pageR);
          rmore = Number((rr && rr.has_more) || 0) === 1 && pageR.length > 0;
          rcursor = Number((rr && rr.cursor) || 0);
          rpage++;
          if (rmore) await wait(250);
        }
        rawReplies[it.cid] = rcs;
        await wait(120);
      }
    }
    var ws = [];
    for (var k = 0; k < POOL; k++) ws.push(worker());
    await Promise.all(ws);

    // ⑤ 组装成树：先建 cid → 节点 的索引，再用 reply_to_reply_id 定父节点
    var byCid = {};
    items.forEach(function(it){ byCid[it.cid] = it; });
    var replyItems = [];
    Object.keys(rawReplies).forEach(function(rootCid){
      rawReplies[rootCid].forEach(function(c){
        var u = c.user || {};
        var node = {
          cid: String(c.cid || ''),
          nick: String(u.nickname || ''),
          uid: String(u.uid || ''),
          text: String(c.text || '').replace(/\\s+/g, ' ').slice(0, 160),
          time: Number(c.create_time || 0),
          root_cid: rootCid,
          reply_id: String(c.reply_id || rootCid),
          reply_to_reply_id: String(c.reply_to_reply_id || ''),
          is_reply: true,
          answered_by_me: false,
          my_reply: '', my_reply_cid: '', my_reply_time: 0,
        };
        if (node.cid) { byCid[node.cid] = node; replyItems.push(node); }
      });
    });

    // 父节点：优先 reply_to_reply_id（且能在索引里找到），否则就是根
    function parentOf(node) {
      var p = node.reply_to_reply_id;
      if (p && p !== '0' && p !== node.cid && byCid[p]) return p;
      return node.reply_id || node.root_cid || '';
    }
    // 谁回过谁：只要某条回复的 parent 是它、且是作者发的
    function markAnswered(nodes) {
      nodes.forEach(function(n){
        for (var i = 0; i < replyItems.length; i++) {
          var r = replyItems[i];
          if (!authorUid || r.uid !== authorUid) continue;
          if (parentOf(r) === n.cid) {
            n.answered_by_me = true;
            n.my_reply = r.text.slice(0, 200);
            n.my_reply_cid = r.cid;
            n.my_reply_time = r.time;
            break;
          }
        }
      });
    }
    markAnswered(items);
    markAnswered(replyItems);
    // 每条回复补上对话上下文（父节点原文）
    replyItems.forEach(function(r){
      var p = byCid[parentOf(r)];
      r.parent_cid = p ? p.cid : '';
      r.parent_nick = p ? p.nick : '';
      r.parent_text = p ? p.text : '';
      // 它想回的那条在接口里根本看不到（比如机器人评论被折叠）→ 如实标出来
      r.to_hidden = !!(r.reply_to_reply_id && r.reply_to_reply_id !== '0'
        && r.reply_to_reply_id !== r.root_cid && !byCid[r.reply_to_reply_id]);
      r.depth = (p && p.cid && p.cid !== r.root_cid) ? 2 : 1;
    });

    // ⑥ 树形视图（和抖音一致：顶层按时间，子回复按时间缩进）
    var tree = [];
    items.slice().sort(function(a,b){ return a.time - b.time }).forEach(function(t){
      // 顶层用 answered（我回过没有），别用 mine —— 顶层是"我回过它"，不是"我发的"
      tree.push({ depth: 0, cid: t.cid, nick: t.nick, text: t.text, answered: !!t.answered_by_me });
      replyItems.filter(function(r){ return r.root_cid === t.cid })
        .sort(function(a,b){ return a.time - b.time })
        .forEach(function(r){
          tree.push({
            depth: r.depth, cid: r.cid, nick: r.nick, text: r.text,
            mine: !!(authorUid && r.uid === authorUid),
            to: r.parent_nick || '',
            to_hidden: r.to_hidden || undefined,
          });
        });
    });

    w.items = items;
    w.replies = replyItems;
    w.tree = tree;
    res.works.push(w);
    await wait(300);
  }
  res.ok = true;
  return JSON.stringify(res);
})()`

/** 页面状态：被验证码拦住时立刻报错，别傻等 */
const STATE_JS = `(function(){
  var frs = document.querySelectorAll('iframe[src*="verifycenter"], iframe[src*="/captcha"], [class*="captcha"]');
  var vis = false;
  Array.prototype.forEach.call(frs, function(el){ var r = el.getBoundingClientRect(); if (r.width > 40 && r.height > 40) vis = true });
  var t = String(document.title || '');
  return JSON.stringify({
    href: String(location.href), title: t,
    hasVideo: !!document.querySelector('video'),
    verifyVisible: vis,
    verify: vis || /验证码|安全验证|验证中|验证失败/.test(t),
    blank: String(location.href) === 'about:blank'
  });
})()`

const withTimeout = (p, ms, label) => Promise.race([
  p,
  new Promise((_, rej) => setTimeout(() => rej(new Error(label + ' 超时 ' + Math.round(ms / 1000) + 's')), ms)),
])

const VERIFY_HINT = '抖音弹了验证码，页面根本没加载，所以读不到评论。'
  + '去有头窗口里把滑块划一次（设置页 → 维护 →「切有头 + 触发验证」），过了再重跑。'

let done = false
for (let attempt = 1; attempt <= 3 && !done; attempt++) {
  let c
  try {
    c = await openPage()
    let st = {}
    try { st = JSON.parse(String(await withTimeout(c.ev(STATE_JS), 15000, '探页面状态'))) || {} } catch { st = {} }

    if (st.blank) {
      await c.send('Page.navigate', { url: 'https://www.douyin.com/' })
      await sleep(6000)
      try { st = JSON.parse(String(await withTimeout(c.ev(STATE_JS), 15000, '探页面状态'))) || {} } catch { st = {} }
    }
    if (st.verify) {
      out({
        ok: false, code: 'verify_required', error: VERIFY_HINT,
        page: { href: st.href, title: st.title, verify_visible: st.verifyVisible },
      })
      done = true
      continue
    }
    if (!String(st.href || '').includes('douyin.com')) {
      await c.send('Page.navigate', { url: 'https://www.douyin.com/' })
      await sleep(6000)
    }

    const raw = await withTimeout(c.ev(JS(AWEMES, MAX, DISCOVER, MAX_WORK_AGE_DAYS)), 120000, '读评论')
    const parsed = JSON.parse(String(raw)) || {}
    const now = Math.floor(Date.now() / 1000)
    for (const w of parsed.works || []) {
      for (const it of w.items || []) {
        if (it.time > 0 && (now - it.time) / 3600 > MAX_AGE_H) it.stale = true
      }
    }
    out({ ...parsed, chrome: c.status })
    done = true
  } catch (e) {
    const msg = String((e && e.message) || e)
    if (attempt === 3) out({ ok: false, error: '读评论失败（试了 3 次）：' + msg })
    else await sleep(2000)
  } finally { try { c && c.close() } catch { /* ignore */ } }
}
if (!done) process.exitCode = 1