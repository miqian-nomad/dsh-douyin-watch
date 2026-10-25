#!/usr/bin/env node
/**
 * tools/media-urls.mjs —— 拿一个抖音视频页的**真实媒体直链**
 * ============================================================================
 * 为什么需要它：`douyin-video` 技能自己取流的三条路（router_data / yt-dlp / 它自带的无登录浏览器）
 * 在登录态机器上会被风控拒（2026-10-25 实测三条全挂）。
 * 但我们插件本来就在 9334 上挂着**已登录**的 Chrome，两条路都能拿到直链：
 *
 *   ① 作品详情接口 `/aweme/v1/web/aweme/detail/` —— 又快又稳，直接给 play_addr + 各档码率
 *      （首选；不依赖页面有没有自动播放）
 *   ② CDP `Network.requestWillBeSent` 截 douyinvod 的流（页面确实播放时的兜底）
 *      ⚠️ `performance.getEntriesByType('resource')` 里是**拿不到**的（MSE，实测 0 条）
 *
 * 用法:
 *   node tools/media-urls.mjs --aweme <id> [--timeout 25]
 *   node tools/media-urls.mjs --link "https://www.douyin.com/video/<id>"
 *
 * 输出一行 JSON：{ ok, aweme_id, video, audio?, title?, author?, dur_text, source, tried }
 */
import { openPage, sleep } from '../lib/chrome.mjs'

const argv = process.argv.slice(2)
const argOf = (k, d) => { const i = argv.indexOf(k); return i >= 0 ? (argv[i + 1] ?? d) : d }
const AID = String(argOf('--aweme', '')).trim()
const LINK = String(argOf('--link', '')).trim()
const TIMEOUT = Math.max(5, Number(argOf('--timeout', '25')) || 25)

const awemeOf = (s) => {
  const m = /\/video\/(\d{15,25})/.exec(String(s || ''))
  return m ? m[1] : ''
}
const AWEME = AID || awemeOf(LINK)
const out = (o) => { console.log(JSON.stringify(o)); process.exitCode = o.ok ? 0 : 1 }

if (!AWEME) { out({ ok: false, error: '缺 --aweme 或 --link（要含 /video/<id>）' }); process.exit(1) }

/** 按 mime_type 分类（CDP 兜底路用）；br 是码率档位 */
const kindOf = (u) => {
  if (!/douyinvod\.com/i.test(u)) return ''
  const mime = (/[?&]mime_type=([^&]+)/.exec(u) || [])[1] || ''
  if (mime.startsWith('video')) return 'video'
  if (mime.startsWith('audio')) return 'audio'
  return ''
}
const brOf = (u) => Number((/[?&]br=(\d+)/.exec(u) || [])[1] || 0)

const COMMON = {
  device_platform: 'webapp', aid: '6383', channel: 'channel_pc_web', pc_client_type: '1',
  version_code: '190500', version_name: '19.5.0', cookie_enabled: 'true',
  screen_width: '1920', screen_height: '1080', browser_language: 'zh-CN', browser_platform: 'Win32',
  browser_name: 'Chrome', browser_version: '141.0.0.0', engine_name: 'Blink',
  engine_version: '141.0.0.0', os_name: 'Windows', os_version: '10', platform: 'PC',
}

const DETAIL_JS = (aid) => `(async function(){
  var COMMON = ${JSON.stringify(COMMON)};
  function qs(d){ return Object.keys(d).map(function(k){return encodeURIComponent(k)+'='+encodeURIComponent(d[k]);}).join('&'); }
  var url = '/aweme/v1/web/aweme/detail/?' + qs(Object.assign({}, COMMON, { aweme_id: ${JSON.stringify(aid)} }));
  try {
    var r = await fetch(url, { credentials: 'include', headers: { Referer: 'https://www.douyin.com/' } });
    var t = await r.text();
    var j = JSON.parse(t);
    var a = j.aweme_detail || {};
    var v = a.video || {};
    var pa = v.play_addr || {};
    var rates = (v.bit_rate || []).map(function(b){ return { gear: b.gear_name, br: b.bit_rate, url: (b.play_addr && b.play_addr.url_list || [])[0] || '' } })
      .filter(function(x){ return x.url });
    return JSON.stringify({
      ok: !!(pa.url_list && pa.url_list.length),
      http: r.status,
      title: String(a.desc || '').slice(0, 120),
      author: (a.author || {}).nickname || '',
      dur_s: v.duration ? Math.round(v.duration / 1000) : 0,
      video: (pa.url_list || [])[0] || '',
      rates: rates.slice(0, 6)
    });
  } catch (e) { return JSON.stringify({ ok: false, error: String(e && e.message || e) }) }
})()`

try {
  const c = await openPage()
  const chromed = c.status
  let result = { source: '' }

  // ── ① 先确保站在 douyin.com 上（相对路径 fetch 才带 cookie / 页面签名器）──
  const cur = String(await c.ev('location.href'))
  if (!cur.includes('douyin.com')) {
    await c.send('Page.navigate', { url: 'https://www.douyin.com/' })
    await sleep(5000)
  }

  // ── ② 首选：作品详情接口 ──
  try {
    const d = JSON.parse(String(await c.ev(DETAIL_JS(AWEME))) || '{}')
    if (d && d.ok && d.video) {
      // 挑码率接近 600k 的那档（够看清画面，又不用下 1080p）
      const sorted = (d.rates || []).slice().sort((a, b) => Math.abs(a.br - 600000) - Math.abs(b.br - 600000))
      const pick = sorted[0] || null
      result = {
        ok: true,
        source: 'detail_api',
        video: pick && pick.url ? pick.url : d.video,
        title: d.title || '',
        author: d.author || '',
        dur_text: d.dur_s ? String(d.dur_s) : '',
        video_br: pick ? Math.round(pick.br / 1000) : undefined,
      }
    }
  } catch { /* 接口挂了就走兜底 */ }

  // ── ③ 兜底：CDP 截流（需要页面真的在播）──
  if (!result.ok) {
    const found = { video: [], audio: [] }
    await c.send('Network.enable')
    c.on('Network.requestWillBeSent', (p) => {
      const u = String((p && p.request && p.request.url) || '')
      const k = kindOf(u)
      if (k && !found[k].includes(u)) found[k].push(u)
    })
    await c.send('Page.navigate', { url: `https://www.douyin.com/video/${AWEME}` })
    for (let i = 0; i < TIMEOUT * 2; i++) {
      await sleep(500)
      if (found.video.length) break
    }
    await sleep(1200)
    // 页面没自己播就催一下（不播放就没有媒体请求）
    try { await c.ev(`(function(){ var v=document.querySelector('video'); if(v && v.paused){ v.muted=true; v.play && v.play().catch(function(){}) } return 1 })()`) } catch { /* ignore */ }
    for (let i = 0; i < 10 && !found.video.length; i++) await sleep(500)

    const pickOne = (arr) => (arr.length ? arr.slice().sort((a, b) => Math.abs(brOf(a) - 600) - Math.abs(brOf(b) - 600))[0] : '')
    const video = pickOne(found.video)
    const dur = String(await c.ev(`(function(){ var v=document.querySelector('video'); return v ? Math.round(v.duration||0) : 0 })()`))
    if (video) {
      result = { ok: true, source: 'cdp_capture', video, audio: pickOne(found.audio) || undefined, dur_text: dur || '', video_br: brOf(video) || undefined }
    }
  }

  c.close()
  await sleep(200)

  if (!result.ok) {
    out({
      ok: false, aweme_id: AWEME, chrome: chromed,
      error: '详情接口和页面截流都没拿到直链（可能被验证码拦住，或这条视频已删/私密）',
      hint: '在有头窗口里把那条视频点开播一下再重跑',
    })
  } else {
    out({ ok: true, aweme_id: AWEME, chrome: chromed, ...result })
  }
} catch (e) {
  out({ ok: false, error: String(e?.message ?? e) })
}