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
 * 🔴 2026-10-22：这里以前**静默忽略** `--mention-*`（根本不读这几个参数）。
 *    调用方以为传了就能真 @，实际发出去的是普通评论：名字不变蓝、对方收不到通知，
 *    工具却报成功 —— 最坏的一种错（不是失败，是"看起来成功"）。
 *
 * ⭐ 但**这个脚本做不了真 @**（原因见 tools/comment-mention-ui.mjs 顶部：
 *    API 直发时服务端会把 mention 的 sec_uid 剥掉，只有前端点选才认）。
 *    ⇒ 现在选择**明确拒绝**，不再静默降级。要真 @ 请用 comment-mention-ui.mjs。
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
if (wantsMention) {
  out({
    ok: false,
    unsupported: 'mention',
    error: '这个脚本做不了真 @（API 直发会被服务端剥掉 sec_uid：名字变蓝但点开是空页、对方收不到通知）',
    use_instead: 'tools/comment-mention-ui.mjs --aweme <id> --name <昵称> --text <正文>',
    hint: '想发"@ 只是文字"的普通评论：去掉 --mention-* 三个参数再调',
  })
  process.exit(1)
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
      var f = !!document.querySelector('iframe[src*="rc-verifycenter"], iframe[src*="verifycenter"], iframe[src*="/captcha"]');
      return JSON.stringify({ title: t, verify: f || /验证码|安全验证/.test(t), href: String(location.href) });
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
    var url = '/aweme/v1/web/comment/publish/?' + qs(Object.assign({}, COMMON, { app_name:'aweme' }));
    var body = Object.assign({}, COMMON, {
      aweme_id: AWEME, text: TEXT, text_extra: '[]',
      aweme_type: '0', channel_id: '0', city: '', sticker_id: '', is_fold: '0'
    });
    if (REPLY) { body.reply_id = REPLY; body.reply_to_reply_id = REPLY; }
    var o = { http: 0, cid: '', status_code: null, head: '' };
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

  out({
    ok,
    http: res.http,
    cid: cid || undefined,
    reply_to: REPLY || '(顶层评论)',
    aweme_id: AWEME,
    len: TEXT.length,
    chrome: chromed,
    status_code: res.status_code === null ? undefined : res.status_code,
    error: ok ? undefined : (res.error || `没拿到 cid（status_code=${res.status_code}）`),
    head: ok ? undefined : String(res.head || '').slice(0, 300),
  })
} catch (e) {
  if (!(e && e.__done)) out({ ok: false, error: String(e?.message ?? e) })
}
