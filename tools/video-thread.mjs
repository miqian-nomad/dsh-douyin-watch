#!/usr/bin/env node
/**
 * tools/video-thread.mjs —— 只读：读**任意视频**（含别人发的）的评论区，可选连楼中楼一起读
 * ============================================================================
 * 为什么单独做（2026-10-27）：
 *   原来的两套读法都只管"自己"：
 *     ① tools/work-comments.mjs 走创作者后台，只能读**自己作品**的评论；
 *     ② tools/comment-thread.mjs 只按给定的顶层 cid 读楼中楼，而别人的视频下
 *        我们手上没有顶层 cid（通知不给、DOM 属性里也没有，只能从 React fiber 里挖）。
 *   于是"想在别人的视频里回楼中楼"就卡在第一步：**找不到那条顶层评论的 cid**。
 *   这里用同一个已登录页面上下文调 /comment/list/ 把顶层评论读出来（带 cid），
 *   需要的话顺手把每条的楼中楼也读了 —— 一次起浏览器，两步都做完。
 *
 * 用法:
 *   node tools/video-thread.mjs --aweme <id> [--max 20] [--replies] [--max-replies 20]
 * 输出一行 JSON:
 *   { ok, aweme, total, items: [ {cid, nick, uid, text, at, reply_count, replies:[{cid,nick,uid,text,at}]} ] }
 *
 * 注意：这是**读**接口，不涉及发布；发布仍旧走 comment-api.mjs（带 reply/reply-to-reply）。
 */
import { openPage, sleep } from '../lib/chrome.mjs'
import { spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const hereDir = () => dirname(fileURLToPath(import.meta.url))

const argv = process.argv.slice(2)
const argOf = (k, d) => { const i = argv.indexOf(k); return i >= 0 ? (argv[i + 1] ?? d) : d }

const AWEME = String(argOf('--aweme', '')).trim()
const MAX = Math.min(50, Math.max(1, Number(argOf('--max', '20')) || 20))
const WITH_REPLIES = argv.includes('--replies')
const MAX_REPLIES = Math.min(50, Math.max(1, Number(argOf('--max-replies', '20')) || 20))

const out = (o) => { console.log(JSON.stringify(o, null, 1)); process.exitCode = o.ok ? 0 : 1 }

if (!AWEME) { out({ ok: false, error: '缺 --aweme' }); process.exit(1) }

// ── 签名直连优先（2026-10-28）：先自己算签名，直接 GET /comment/list/。
//    成了一次浏览器都不用开（从"开浏览器+等页面"变成一秒内）；失败才走下面的页面路。
const SIGN_PY = String(process.env.DOUYIN_SIGN_PY || 'D:\\dsh-plugins\\_deps\\python311\\cpython-3.11-windows-x86_64-none\\python.exe')
const SIGN_SCRIPT = String(process.env.DOUYIN_SIGN_SCRIPT || 'D:\\dsh-plugins\\_deps\\scripts\\douyin-signer\\signed_get.py')

function signedCommentList(aweme, max) {
  if (!existsSync(SIGN_SCRIPT) || !existsSync(SIGN_PY)) return null
  const query = `device_platform=webapp&aid=6383&channel=channel_pc_web&aweme_id=${aweme}&cursor=0&count=${max}&item_type=0&app_name=aweme`
  const r = spawnSync(SIGN_PY, [SIGN_SCRIPT, '--path', '/aweme/v1/web/comment/list/', '--query', query], { encoding: 'utf8', timeout: 40000 })
  let p = null
  try { p = JSON.parse(String(r.stdout || '').trim()) } catch { p = null }
  if (!p || !p.ok || !Array.isArray(p.items) || !p.items.length) return null
  const items = p.items.map((x) => ({
    cid: String(x.cid || ''),
    nick: String(x.nick || ''),
    uid: String(x.uid || ''),
    text: String(x.text || ''),
    at: Number(x.at) || 0,
    reply_count: Number(x.reply_count) || 0,
    replies: [],
  }))
  return { ok: true, aweme: String(aweme), total: items.length, with_replies: false, has_more: !!p.has_more, items, source: 'signed' }
}

/** 收尾：楼中楼委托给 comment-thread.mjs，然后输出。签名路和页面路都走这里 */
const finish = async (res) => {
  // ── 楼中楼：交给 comment-thread.mjs（它自己也是"先签名直连、失败再开页面"）
  //    只读"有回复的"前 3 条，免得一次拉几十个线程
  if (WITH_REPLIES && res.ok && Array.isArray(res.items)) {
    const roots = res.items.filter((x) => x && x.cid && Number(x.reply_count) > 0).slice(0, 3).map((x) => String(x.cid))
    if (roots.length) {
      const args = [join(hereDir(), 'comment-thread.mjs'), '--aweme', String(res.aweme), '--max', String(MAX_REPLIES)]
      for (const cid of roots) args.push('--cid', cid)
      const child = spawnSync(process.execPath, args, { encoding: 'utf8', timeout: 180000, env: process.env })
      let parsed = null
      try { parsed = JSON.parse(String(child.stdout || '').trim()) } catch { parsed = null }
      const threads = (parsed && parsed.threads) || []
      const byRoot = new Map(threads.map((t) => [String(t.root_cid), t.replies || []]))
      for (const it of res.items) {
        const reps = byRoot.get(String(it.cid))
        if (reps && reps.length) { it.replies = reps; it.replies_via = 'signed' }
      }
      res.with_replies = true
      res.replies = threads.reduce((a, t) => a + ((t.replies && t.replies.length) || 0), 0)
      if (!threads.length) res.replies_note = '楼中楼没读到：' + String((child.stderr || child.stdout || '').slice(0, 160))
    }
  }
  out(res)
  await sleep(200)
  process.exit(res.ok ? 0 : 1)
}

try {
  // ① 签名直连
  const sd = signedCommentList(AWEME, MAX)
  if (sd) await finish(sd)

  // ② 页面路兜底
  const c = await openPage()

  // 无头 UA 带 HeadlessChrome，读接口一般不拦；覆盖上更稳（写接口不覆盖会 200+空 body）
  try {
    const realUA = String(await c.ev('navigator.userAgent')).replace('HeadlessChrome', 'Chrome')
    await c.send('Network.enable')
    await c.send('Network.setUserAgentOverride', { userAgent: realUA, acceptLanguage: 'zh-CN,zh;q=0.9', platform: 'Win32' })
    await sleep(250)
  } catch { /* 失败也继续 */ }

  // 只要站在 douyin.com 上就行：读接口不需要先打开具体视频页（避免跳页触发滑块）
  const cur = String(await c.ev('location.href'))
  if (!cur.includes('douyin.com')) {
    await c.send('Page.navigate', { url: 'https://www.douyin.com/' })
    await sleep(5000)
  }

  const ENV = { aweme: AWEME, max: MAX, replies: WITH_REPLIES, maxReplies: MAX_REPLIES }
  const js = `(async function(){
    var ENV = ${JSON.stringify(ENV)};
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
    // 每条请求都套一层 Promise.race 超时：页面被验证/风控挡住时 fetch 会一直悬着，
    //   不设上限整个脚本就静默卡死（2026-10-27 实测踩过），宁可报超时也不挂住。
    //   ⚠️ 无头页面是"后台标签"，DOM 定时器会被降频，所以 Node 侧还留了一道总闸。
    function withTimeout(p, ms, tag){
      return Promise.race([p, new Promise(function(_, rej){
        setTimeout(function(){ rej(new Error('timeout:' + tag)) }, ms);
      })]);
    }
    async function getJSON(path, tag){
      try {
        var r = await withTimeout(fetch(path, { credentials:'include', headers:{ 'Referer':'https://www.douyin.com/' } }), 8000, tag || 'fetch');
        var t = await r.text();
        try { return { http: r.status, json: JSON.parse(t) } } catch(e) { return { http: r.status, json: null, head: t.slice(0,160) } }
      } catch (e) {
        return { http: 0, json: null, head: 'fetch_failed: ' + String((e && e.message) || e) };
      }
    }
    function pick(x){
      var u = (x && x.user) || {};
      return {
        cid: String((x && x.cid) || ''),
        nick: String(u.nickname || ''),
        uid: String(u.uid || ''),
        text: String((x && x.text) || '').replace(/\\s+/g, ' ').slice(0, 300),
        at: Number((x && x.create_time) || 0),
        reply_count: Number((x && (x.reply_comment_total || x.reply_comment_count)) || 0)
      };
    }
    var list = await getJSON('/aweme/v1/web/comment/list/?' + qs(Object.assign({}, COMMON, {
      aweme_id: ENV.aweme, cursor: '0', count: String(ENV.max), item_type: '0', app_name: 'aweme'
    })));
    var raw = (list.json && list.json.comments) || [];
    var items = [];
    for (var i = 0; i < raw.length; i++) {
      var one = pick(raw[i]);
      one.replies = [];
      // ⚠️ 楼中楼**不在这里读**：/comment/list/reply/ 不签名就挂（2026-10-28 实测），
      //    改由 Node 侧调 comment-thread.mjs 走"页面自己发请求"的路子（见文件尾部）。
      items.push(one);
    }
    return JSON.stringify({
      ok: true, aweme: ENV.aweme, total: items.length, with_replies: false,
      http: list.http, status_code: (list.json && list.json.status_code) || 0,
      has_more: !!(list.json && Number(list.json.has_more) === 1),
      items: items,
      head: list.json ? '' : String(list.head || '')
    });
  })()`

  // Node 侧先编译一遍：语法错在这里就报，不用等页面抛
  try { new Function(js) } catch (e) {
    out({ ok: false, error: '页面脚本语法错误：' + ((e && e.message) || e) })
    c.close(); process.exit(1)
  }

  // Node 侧再加一道总闸：页面脚本再卡也最多等 45 秒（读 20 条含楼中楼足够）
  const BUDGET = Math.max(20000, Math.min(120000, 15000 + MAX * 1200 + (WITH_REPLIES ? 15000 : 0)))
  const raw = await Promise.race([
    c.ev(js),
    new Promise((_, rej) => setTimeout(() => rej(new Error('页面脚本超时（' + Math.round(BUDGET / 1000) + ' 秒没返回，多半页面被拦住了）')), BUDGET)),
  ])

  const res = JSON.parse(String(raw))
  try { c.close() } catch { /* ignore */ }
  await sleep(300) // 让 CDP 连接真的关掉再交给下一步，避免两个客户端抢同一个页面
  await finish(res)
} catch (e) {
  out({ ok: false, error: String((e && e.message) || e) })
  // 失败路径也必须显式退出：CDP 的 WebSocket 没关干净会吊住事件循环，
  //   脚本"该报的错都报了却一直不结束"（2026-10-27 实测踩过）
  await sleep(200)
  process.exit(1)
}
