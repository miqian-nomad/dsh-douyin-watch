#!/usr/bin/env node
/**
 * tools/work-comments.mjs —— 读「作品」的评论 + 判断**我回过没有**（服务端为准）
 * ============================================================================
 * 为什么判断要用子评论接口，而不是本地台账：
 *   台账只记"经本插件发出去的"，而实际回复可能来自 creator 后台、别的会话、手机上，
 *   台账根本看不见 —— 于是"我刚回了什么"变成每次都要重新爬（2026-10-25 用户指出的问题）。
 *   所以：**判据放在服务端** —— 子评论列表里只要有一条 `user.uid == 作品作者 uid`，
 *   那就是我回过了；正文也一起带回来，调用方可以直接补录台账。
 *
 * 两个接口：
 *   /aweme/v1/web/aweme/detail/        拿作品作者（= 我）的 uid
 *   /aweme/v1/web/comment/list/        拿顶层评论
 *   /aweme/v1/web/comment/list/reply/  拿某条评论下的回复（只在有回复时才查，省请求）
 *
 * 用法:
 *   node tools/work-comments.mjs --aweme <作品id>[,<作品id>] [--max 20] [--reply-probe 1]
 *
 * 输出一行 JSON：
 *   { ok, author:{nick,uid}, works:[{ aweme, total, n, items:[{
 *       cid, nick, uid, text, time, reply_total,
 *       answered_by_me, my_reply, my_reply_cid, my_reply_time, stale }] }], error? }
 */
import { openPage, sleep } from '../lib/chrome.mjs'

const argv = process.argv.slice(2)
const argOf = (k, d) => { const i = argv.indexOf(k); return i >= 0 ? (argv[i + 1] ?? d) : d }
const AWEMES = String(argOf('--aweme', '')).split(',').map((s) => s.trim()).filter(Boolean)
const MAX = Math.max(1, Number(argOf('--max', '20')) || 20)
const MAX_AGE_H = Number(argOf('--max-age-hours', '48')) || 48
const PROBE = String(argOf('--reply-probe', '1')) !== '0'   // 0 = 不查子评论（更快，但判不出回没回）

const out = (o) => { console.log(JSON.stringify(o)); process.exitCode = o.ok ? 0 : 1 }
if (!AWEMES.length) { out({ ok: false, error: '缺 --aweme（作品 id，可逗号分隔）' }); process.exit(1) }

const COMMON = {
  device_platform: 'webapp', aid: '6383', channel: 'channel_pc_web', pc_client_type: '1',
  version_code: '190500', version_name: '19.5.0', cookie_enabled: 'true',
  screen_width: '1920', screen_height: '1080', browser_language: 'zh-CN', browser_platform: 'Win32',
  browser_name: 'Chrome', browser_version: '141.0.0.0', engine_name: 'Blink',
  engine_version: '141.0.0.0', os_name: 'Windows', os_version: '10', platform: 'PC',
}

const JS = (ids, max, probe) => `(async function(){
  var COMMON = ${JSON.stringify(COMMON)};
  var IDS = ${JSON.stringify(ids)};
  var MAX = ${Number(max)};
  var PROBE = ${probe ? 'true' : 'false'};
  function qs(d){ return Object.keys(d).map(function(k){return encodeURIComponent(k)+'='+encodeURIComponent(d[k]);}).join('&'); }
  function wait(ms){ return new Promise(function(r){ setTimeout(r, ms) }) }
  async function jget(path){
    try {
      var r = await fetch(path, { credentials:'include', headers:{ Referer:'https://www.douyin.com/' } });
      var t = await r.text();
      try { return { http: r.status, json: JSON.parse(t) } } catch(e) { return { http: r.status, head: t.slice(0,100) } }
    } catch(e) { return { error: String(e && e.message || e) } }
  }
  var res = { author: null, works: [] };
  for (var i = 0; i < IDS.length; i++) {
    var aid = IDS[i];
    var w = { aweme: aid, total: 0, n: 0, items: [] };
    // ① 作者 = 我
    var d = await jget('/aweme/v1/web/aweme/detail/?' + qs(Object.assign({}, COMMON, { aweme_id: aid })));
    var a = (d.json && d.json.aweme_detail) || {};
    var authorUid = String(((a.author || {}).uid) || '');
    if (!res.author && authorUid) res.author = { nick: (a.author||{}).nickname || '', uid: authorUid };
    // ② 顶层评论（**分页**：抖音一页最多给 20 条，作品评论多的时候必须翻页）
    var all = [], cursor = 0, hasMore = true, pages = 0;
    while (all.length < MAX && hasMore && pages < 6) {
      var cl = await jget('/aweme/v1/web/comment/list/?' + qs(Object.assign({}, COMMON, { aweme_id: aid, cursor: String(cursor), count: '20', item_type: '0' })));
      if (!cl.json) { w.error = cl.head || cl.error || 'comment/list 失败'; break }
      w.total = Number(cl.json.total || w.total || 0);
      var page = cl.json.comments || [];
      all = all.concat(page);
      hasMore = Number(cl.json.has_more) === 1 && page.length > 0;
      cursor = Number(cl.json.cursor || 0);
      pages++;
      if (hasMore && all.length < MAX) await wait(400);
    }
    var cs = all.slice(0, MAX);
    w.n = cs.length;
    for (var k = 0; k < cs.length; k++) {
      var c = cs[k];
      var u = c.user || {};
      var rc = c.reply_comment || null;
      var replyTotal = 0;
      if (rc) replyTotal = Number(rc.reply_comment_total || (rc.reply_comment_list ? rc.reply_comment_list.length : 1)) || 1;
      var item = {
        cid: String(c.cid || ''),
        nick: String(u.nickname || ''),
        uid: String(u.uid || ''),
        text: String(c.text || '').replace(/\\s+/g, ' ').slice(0, 160),
        time: Number(c.create_time || 0),
        reply_total: replyTotal,
        answered_by_me: false,
        my_reply: '',
        my_reply_cid: '',
        my_reply_time: 0,
      };
      // ③ 有回复才去查子评论，判断"我回过没有"
      //    2026-10-25 用户指出：不能只看 reply_comment 预览，那是"有人回过"，不一定是"我"。
      if (PROBE && replyTotal > 0 && item.cid) {
        var rr = await jget('/aweme/v1/web/comment/list/reply/?' + qs(Object.assign({}, COMMON, { item_id: aid, comment_id: item.cid, cursor:'0', count:'20', item_type:'0' })));
        var rcs = (rr.json && rr.json.comments) || [];
        for (var m = 0; m < rcs.length; m++) {
          var ru = rcs[m].user || {};
          if (authorUid && String(ru.uid || '') === authorUid) {
            item.answered_by_me = true;
            item.my_reply = String(rcs[m].text || '').slice(0, 200);
            item.my_reply_cid = String(rcs[m].cid || '');
            item.my_reply_time = Number(rcs[m].create_time || 0);
            break;
          }
        }
        await wait(450);
      }
      w.items.push(item);
    }
    res.works.push(w);
    await wait(400);
  }
  res.ok = true;
  return JSON.stringify(res);
})()`

/**
 * 页面现在到底是什么状态？
 * ⚠️ 2026-10-25 踩过的坑：抖音弹了验证码时页面根本没加载，接口 fetch 全部落空，
 *    脚本只会"读半天没结果"，看起来像卡死 —— 于是有人去怀疑脚本请求量大、怀疑 about:blank。
 *    其实**只要先看一眼页面状态就能立刻说清楚**。所以现在先探状态，被拦就立刻报错、不重试。
 */
const STATE_JS = `(function(){
  var frs = document.querySelectorAll('iframe[src*="verifycenter"], iframe[src*="/captcha"], [class*="captcha"]');
  var vis = false;
  Array.prototype.forEach.call(frs, function(el){
    var r = el.getBoundingClientRect();
    if (r.width > 40 && r.height > 40) vis = true;
  });
  var t = String(document.title || '');
  return JSON.stringify({
    href: String(location.href),
    title: t,
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
    // ① 先看状态：被验证码拦住就**立刻**报错，别傻等、别重试
    let st = {}
    try { st = JSON.parse(String(await withTimeout(c.ev(STATE_JS), 15000, '探页面状态'))) || {} } catch { st = {} }

    if (st.blank) {
      await c.send('Page.navigate', { url: 'https://www.douyin.com/' })
      await sleep(6000)
      try { st = JSON.parse(String(await withTimeout(c.ev(STATE_JS), 15000, '探页面状态'))) || {} } catch { st = {} }
    }
    if (st.verify) {
      out({
        ok: false, code: 'verify_required',
        error: VERIFY_HINT,
        page: { href: st.href, title: st.title, verify_visible: st.verifyVisible },
      })
      done = true
      continue
    }
    if (!String(st.href || '').includes('douyin.com')) {
      await c.send('Page.navigate', { url: 'https://www.douyin.com/' })
      await sleep(6000)
    }

    // ② 真正读数据（整体加超时：页面被别的进程导航走时 ev 可能永远不返回）
    const raw = await withTimeout(c.ev(JS(AWEMES, MAX, PROBE)), 60000, '读评论')
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
    // CDP 层面的临时冲突（页面正被导航）重试几次；其它错误直接抛真相
    const msg = String((e && e.message) || e)
    if (attempt === 3) out({ ok: false, error: '读评论失败（试了 3 次）：' + msg })
    else await sleep(2000)
  } finally { try { c && c.close() } catch { /* ignore */ } }
}
if (!done) process.exitCode = 1