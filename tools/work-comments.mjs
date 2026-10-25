#!/usr/bin/env node
/**
 * tools/work-comments.mjs —— 读「作品」的评论列表（**自己视频下的评论**该走这里，不是通知）
 * ============================================================================
 * 为什么单独一个脚本（2026-10-25 用户指出）：
 *   通知流只告诉你"有人评论了你的作品"，但：
 *     ① 通知有延迟、有条数上限，翻不到的就永远看不到；
 *     ② 同一条评论在通知里出现一次，在你刷新页面后可能就沉底了；
 *     ③ 而我们本来就能直接读评论列表（`/aweme/v1/web/comment/list/`，实测 200 + total 准）。
 *   ⇒ 自己作品下的评论**以评论列表为准**；通知只用来补充"别人回复了我评论"（type 31）。
 *
 * 用法:
 *   node tools/work-comments.mjs --aweme 7700523174529600831 [--max 20] [--max-age-hours 48]
 *   node tools/work-comments.mjs --aweme id1,id2
 *
 * 输出一行 JSON：
 *   { ok, works: [{ aweme, total, n, items: [{cid, nick, uid, text, time, answered}] }], error? }
 *   answered = 服务端说这条下面已经有回复（reply_comment 存在）
 */
import { openPage, sleep } from '../lib/chrome.mjs'

const argv = process.argv.slice(2)
const argOf = (k, d) => { const i = argv.indexOf(k); return i >= 0 ? (argv[i + 1] ?? d) : d }
const AWEMES = String(argOf('--aweme', '')).split(',').map((s) => s.trim()).filter(Boolean)
const MAX = Math.max(1, Number(argOf('--max', '20')) || 20)
const MAX_AGE_H = Number(argOf('--max-age-hours', '48')) || 48

const out = (o) => { console.log(JSON.stringify(o)); process.exitCode = o.ok ? 0 : 1 }
if (!AWEMES.length) { out({ ok: false, error: '缺 --aweme（作品 id，可逗号分隔）' }); process.exit(1) }

const COMMON = {
  device_platform: 'webapp', aid: '6383', channel: 'channel_pc_web', pc_client_type: '1',
  version_code: '190500', version_name: '19.5.0', cookie_enabled: 'true',
  screen_width: '1920', screen_height: '1080', browser_language: 'zh-CN', browser_platform: 'Win32',
  browser_name: 'Chrome', browser_version: '141.0.0.0', engine_name: 'Blink',
  engine_version: '141.0.0.0', os_name: 'Windows', os_version: '10', platform: 'PC',
}

const js = (ids, max) => `(async function(){
  var COMMON = ${JSON.stringify(COMMON)};
  var IDS = ${JSON.stringify(ids)};
  var MAX = ${Number(max)};
  function qs(d){ return Object.keys(d).map(function(k){return encodeURIComponent(k)+'='+encodeURIComponent(d[k]);}).join('&'); }
  var works = [];
  for (var i = 0; i < IDS.length; i++) {
    var aid = IDS[i];
    var w = { aweme: aid, total: 0, n: 0, items: [] };
    try {
      var r = await fetch('/aweme/v1/web/comment/list/?' + qs(Object.assign({}, COMMON, { aweme_id: aid, cursor: '0', count: String(MAX), item_type: '0' })), { credentials: 'include', headers: { Referer: 'https://www.douyin.com/' } });
      var t = await r.text();
      var j = JSON.parse(t);
      w.total = j.total || 0;
      var cs = j.comments || [];
      w.n = cs.length;
      w.items = cs.slice(0, MAX).map(function(c){
        var u = c.user || {};
        var rc = c.reply_comment || null;
        var replied = !!(rc && (rc.cid || (rc.reply_comment_list && rc.reply_comment_list.length)));
        return {
          cid: String(c.cid || ''),
          nick: String(u.nickname || ''),
          uid: String(u.uid || ''),
          text: String(c.text || '').replace(/\\s+/g, ' ').slice(0, 160),
          time: Number(c.create_time || 0),
          answered: replied,
          reply_count: rc && rc.reply_comment_list ? rc.reply_comment_list.length : 0,
        };
      });
    } catch (e) { w.error = String(e && e.message || e) }
    works.push(w);
    await new Promise(function(res){ setTimeout(res, 600) });
  }
  return JSON.stringify({ ok: true, works: works });
})()`

try {
  const c = await openPage()
  const chromed = c.status
  const href = String(await c.ev('location.href'))
  if (!href.includes('douyin.com')) {
    await c.send('Page.navigate', { url: 'https://www.douyin.com/' })
    await sleep(6000)
  }
  const raw = await c.ev(js(AWEMES, MAX))
  c.close()
  await sleep(200)
  const parsed = JSON.parse(String(raw)) || {}
  const now = Math.floor(Date.now() / 1000)
  // 太旧的直接标出来（调用方自己决定丢不丢；这里只做标注，不擅自删）
  for (const w of parsed.works || []) {
    for (const it of w.items || []) {
      if (it.time > 0 && (now - it.time) / 3600 > MAX_AGE_H) it.stale = true
    }
  }
  out({ ...parsed, chrome: chromed })
} catch (e) {
  out({ ok: false, error: String(e?.message ?? e) })
}