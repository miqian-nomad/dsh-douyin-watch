#!/usr/bin/env node
/**
 * tools/comment-api.mjs —— 在抖音评论区发评论/回复某条评论（**一条 fetch，不点 UI**）
 * ============================================================================
 * 为什么是"页面里 fetch"这一条路（三种都实测过）：
 *   ① 点评论区 UI      → 能发，但抖音会弹**短信验证**（要主人给码）
 *   ② Python 自己签名 POST → **HTTP 403**（写接口要强签名 getBdTicketGuardHeader，外部补不齐）
 *   ③ ⭐ 在无头页面的上下文里 fetch → **HTTP 200，不弹验证**（页面自己把签名补齐）
 *
 * 屏幕上是无窗口的（headless），不发任何 UI 操作，只跑一条 fetch。
 *
 * 用法:
 *   node tools/comment-api.mjs --aweme <id> --file <txt> [--reply <cid>] [--dry]
 *   node tools/comment-api.mjs --aweme <id> --text "..." [--reply <cid>]
 *
 * 输出一行 JSON：{ ok, http, cid, reply_to, text, raw? , error? }
 */
import { readFileSync } from 'node:fs'
import { openPage, sleep } from '../lib/chrome.mjs'

const argv = process.argv.slice(2)
const argOf = (k, d) => { const i = argv.indexOf(k); return i >= 0 ? (argv[i + 1] ?? d) : d }
const DRY = argv.includes('--dry')
const AWEME = String(argOf('--aweme', '')).trim()
const REPLY = String(argOf('--reply', '')).trim()
const FILE = String(argOf('--file', '')).trim()
const TEXT = FILE ? readFileSync(FILE, 'utf8').trim() : String(argOf('--text', '')).trim()

/**
 * ⭐ 2026-10-25 更新：**真 @ 现在能做了**。
 *   之前这里写的是"API 直发会被服务端剥掉 sec_uid，只有前端点选才认" —— 那是缺 `user_id` 导致的。
 *   当天在真机上抓到前端自己发的请求体，格式是（下面的昵称/ID 已打码）：
 *     text         = "@某好友 测试"
 *     text_extra   = [{"user_id":"1234567890123456","sec_uid":"MS4wLjABAAAA…","type":0,"start":0,"end":4}]
 *   注意四个字段缺一不可：`user_id`（数字 uid，不是 sec_uid）+ `sec_uid` + `type:0` + `start/end`
 *   （start/end 是**字符下标**，`end` 含头不含尾：`@某好友` = start 0 / end 4）。
 *   所以这里不再拒绝，而是按这个格式发。uid 拿不到会自动去查（见下面 page 里的解析逻辑）。
 */
const MENTION = {
  name: String(argOf('--mention-name', '')).trim(),
  uid: String(argOf('--mention-uid', '')).trim(),
  secUid: String(argOf('--mention-secuid', '')).trim(),
}
const wantsMention = Boolean(MENTION.name || MENTION.uid || MENTION.secUid)

const out = (o) => { console.log(JSON.stringify(o, null, 1)); process.exitCode = o.ok ? 0 : 1 }

if (!AWEME) { out({ ok: false, error: '缺 --aweme' }); process.exit(1) }
if (!TEXT) { out({ ok: false, error: '正文是空的' }); process.exit(1) }
if (TEXT.length > 500) { out({ ok: false, error: `正文太长（${TEXT.length} 字），抖音评论放不下` }); process.exit(1) }
if (wantsMention && !MENTION.name && !MENTION.secUid && !MENTION.uid) {
  out({ ok: false, error: '@ 谁没给（--mention-name 或 --mention-secuid）' }); process.exit(1)
}

async function cdpReady() {
  try { return (await fetch(`${CDP}/json/version`)).ok } catch { return false }
}

try {
  const c = await openPage()
  const chromed = c.status

  // 🔴 无头 Chrome 的 UA 带 `HeadlessChrome`：抖音的**写接口**对它回 `200 + 空 body`
  //    （看起来成功、其实没发出去）。2026-10-24 实测：@ 了 UA 之后同一个请求就正常返回 cid。
  try {
    const realUA = String(await c.ev('navigator.userAgent')).replace('HeadlessChrome', 'Chrome')
    await c.send('Network.enable')
    await c.send('Network.setUserAgentOverride', { userAgent: realUA, acceptLanguage: 'zh-CN,zh;q=0.9', platform: 'Win32' })
    await sleep(300)
  } catch { /* 覆盖失败也照旧尝试 */ }

  // 必须站在 douyin.com 上，相对路径 fetch 才带得上 cookie / 页面签名器
  const cur = String(await c.ev('location.href'))
  if (!cur.includes('douyin.com')) {
    await c.send('Page.navigate', { url: 'https://www.douyin.com/' })
    await sleep(6000)
  }

  if (DRY) {
    out({ ok: true, dry: true, aweme_id: AWEME, reply_to: REPLY || '(顶层评论)', len: TEXT.length, chrome: chromed })
    c.close()
    await sleep(200)
    process.exitCode = 0
    // 走到这里自然结束，别用 process.exit（会触发 libuv 断言）
    throw { __done: true }
  }

  // ⚠️ 先导航到目标视频页再发（写接口在视频页上下文里才稳）。
  //    但**别把成功归因于"页面上下文"** —— 2026-10-24 的真实链路是：
  //      /chat → /video/<aweme> 这一跳**会触发验证码滑块**（rc-verifycenter / 验证码中间页）；
  //      人手工划过了，导航才真的落地，写接口才返回 cid；
  //      没人过 = 页面被拦在验证页，发布接口回 `200 + 空 body` 或 403。
  //    所以下面要**检测是否被验证拦住**并如实报错，不许再静默重试五次。
  if (!String(await c.ev('location.href')).includes(`/video/${AWEME}`)) {
    await c.send('Page.navigate', { url: `https://www.douyin.com/video/${AWEME}` })
    await sleep(6000)
  }
  try {
    const st = JSON.parse(String(await c.ev(`(function(){
      var t = String(document.title || '');
      var vf = document.querySelector('iframe[src*="rc-verifycenter"], iframe[src*="verifycenter"], iframe[src*="/captcha"]');
      // ⚠️ 那个 iframe 是**页面常驻**的（没拦人也挂在 DOM 里），只看"存在"会误报。
      //    只有它真的可见、或者标题变成验证码页，才算被拦。
      var vis = !!(vf && vf.offsetWidth > 2 && vf.offsetHeight > 2 && getComputedStyle(vf).visibility !== 'hidden');
      var hasVideo = !!document.querySelector('video');
      var verify = /验证码|安全验证/.test(t) || (vis && !hasVideo);
      return JSON.stringify({ title: t, verify: verify, hasVideo: hasVideo, iframeVisible: vis, href: String(location.href) });
    })()`)) || {})
    if (st.verify) {
      c.close()
      await sleep(200)
      out({
        ok: false,
        verify_required: true,
        error: '被验证码拦住：从私信页跳到视频页会触发滑块，需要人工在**有头窗口**里划一次',
        hint: '切有头：杀掉占 9334 的进程，再用同一个 user-data-dir 加 --headless=off 启动，人工过验证后重跑本脚本',
        href: st.href,
      })
      throw { __done: true }
    }
  } catch (e) {
    if (e && e.__done) throw e
    // 检测本身失败就继续（别因为探测失败就不发）
  }

  const js = `(async function(){
    var AWEME = ${JSON.stringify(AWEME)};
    var REPLY = ${JSON.stringify(REPLY)};
    var TEXT = ${JSON.stringify(TEXT)};
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
      var r = await fetch(path, { credentials: 'include', headers: { 'Referer': 'https://www.douyin.com/' } });
      var t = await r.text();
      try { return { http: r.status, json: JSON.parse(t) } } catch (e) { return { http: r.status, json: null, head: t.slice(0, 160) } }
    }
    var o = { http: 0, cid: '', status_code: null, head: '', mention: null };

    // ── ① 把要 @ 的人的 uid + sec_uid 凑齐（请求体里两个都要，缺一个服务端就把 mention 剥掉）
    var AT = { name: ${JSON.stringify(MENTION.name)}, uid: ${JSON.stringify(MENTION.uid)}, sec: ${JSON.stringify(MENTION.secUid)} };
    if (AT.name || AT.uid || AT.sec) {
      if (!AT.uid || !AT.sec) {
        if (AT.name) {   // 先在评论区里按昵称找（@ 评论过的人 / 作者最常见的场景）
          var lr = await getJSON('/aweme/v1/web/comment/list/?' + qs(Object.assign({}, COMMON, { aweme_id: AWEME, cursor: '0', count: '50', item_type: '0' })));
          var cs = (lr.json && lr.json.comments) || [];
          for (var i = 0; i < cs.length; i++) {
            var u = cs[i].user || {};
            if (u.nickname !== AT.name) continue;
            if (AT.sec && u.sec_uid && u.sec_uid !== AT.sec) continue;
            AT.uid = String(u.uid || ''); AT.sec = String(u.sec_uid || '');
            break;
          }
        }
        if ((!AT.uid || !AT.sec) && AT.sec) {   // 评论区里没有 → 用 sec_uid 查主页补 uid
          var pr = await getJSON('/aweme/v1/web/user/profile/other/?' + qs(Object.assign({}, COMMON, { sec_user_id: AT.sec })));
          var pu = (pr.json && pr.json.user) || {};
          if (pu.uid) { AT.uid = String(pu.uid); if (!AT.name && pu.nickname) AT.name = String(pu.nickname) }
        }
      }
      if (!AT.uid || !AT.sec || !AT.name) {
        o.error = 'mention_target_not_found';
        o.mention = AT;
        return JSON.stringify(o);
      }
      o.mention = AT;
    }

    // ── ② 拼 finalText + text_extra（start/end 是字符下标，end 含头不含尾）
    var finalText = TEXT;
    var extra = [];
    if (AT.name && AT.uid && AT.sec) {
      var lead = '@' + AT.name;
      if (finalText.indexOf(lead) !== 0) finalText = lead + ' ' + finalText;
      extra.push({ user_id: AT.uid, sec_uid: AT.sec, type: 0, start: 0, end: lead.length });
    }
    o.text = finalText;

    var url = '/aweme/v1/web/comment/publish/?' + qs(Object.assign({}, COMMON, { app_name:'aweme' }));
    var body = Object.assign({}, COMMON, {
      aweme_id: AWEME, text: finalText, text_extra: JSON.stringify(extra),
      aweme_type: '0', channel_id: '0', city: '', sticker_id: '', is_fold: '0'
    });
    if (REPLY) { body.reply_id = REPLY; body.reply_to_reply_id = REPLY; }
    try {
      var r = await fetch(url, {
        method: 'POST', credentials: 'include',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Referer': 'https://www.douyin.com/' },
        body: new URLSearchParams(body).toString()
      });
      var txt = await r.text();
      o.http = r.status;
      o.head = txt.slice(0, 240);
      // ⚠️ 必须在页面里就解析：整包可能好几 KB，截断后 Node 那边 JSON.parse 会失败（踩过）
      try {
        var j = JSON.parse(txt);
        o.status_code = (j.status_code === undefined ? null : j.status_code);
        o.cid = (j.comment && j.comment.cid) ? String(j.comment.cid) : '';
      } catch (e2) { o.parse_error = String(e2 && e2.message || e2); }
    } catch (e) { o.error = String((e && e.message) || e); }
    return JSON.stringify(o);
  })()`

  const raw = await c.ev(js)
  c.close()
  await sleep(200)   // 等 WebSocket 真正关掉再退出，否则 libuv 会断言

  let res
  try { res = JSON.parse(raw) } catch { out({ ok: false, error: '页面没返回可解析结果', raw: String(raw).slice(0, 400), chrome: chromed }); process.exit(1) }

  const cid = String(res.cid || '')
  const ok = res.http === 200 && !!cid
  const mentionNote = res.mention
    ? (res.mention.uid && res.mention.sec ? `@${res.mention.name}(uid=${res.mention.uid})` : `@${res.mention.name || '?'}（没凑齐 uid/sec_uid）`)
    : ''

  out({
    ok,
    http: res.http,
    cid: cid || undefined,
    reply_to: REPLY || '(顶层评论)',
    aweme_id: AWEME,
    len: TEXT.length,
    text_sent: res.text,
    mention: res.mention || undefined,
    mention_note: mentionNote || undefined,
    chrome: chromed,
    status_code: res.status_code === null ? undefined : res.status_code,
    error: ok ? undefined
      : (res.error === 'mention_target_not_found'
        ? `要 @ 的那个人没找到（评论区前 50 条里没有「${MENTION.name || MENTION.secUid}」；可显式传 --mention-uid 和 --mention-secuid）`
        : (res.error || `没拿到 cid（status_code=${res.status_code}）`)),
    head: ok ? undefined : String(res.head || '').slice(0, 300),
  })
} catch (e) {
  if (!(e && e.__done)) out({ ok: false, error: String(e?.message ?? e) })
}
