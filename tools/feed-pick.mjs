#!/usr/bin/env node
/**
 * tools/feed-pick.mjs —— 刷一轮：拉候选 → 打分 → 生成「转发给我」的清单
 * ============================================================================
 * 为什么从 Python 搬过来（2026-10-24）：
 *   forward-pick.py 依赖 `curl_cffi` 才能伪造 chrome 的 TLS 指纹，否则被拦。
 *   但**页面内的 fetch 天生就是真指纹**（真浏览器、真 cookie、真签名），
 *   所以这里只做：打开一个 douyin 页面 → 上下文里 fetch 四个同源只读接口 → 解析。
 *   结果：对外**不再需要 Python / pip / venv / PATH**，装好 Chrome 就能跑。
 *
 * 契约（不许改，index.js 的 runPicker 按这个正则解析）：
 *   ` 1. [216.6万] 标题`
 *   `    作者 · 18.0s · 赞… 评… 藏… 转… · 336小时前`
 *   `    https://…`（官方分享链接，带 share_sign）
 *
 * 用法:
 *   node tools/feed-pick.mjs --limit 4
 *   node tools/feed-pick.mjs --dump        # 额外把原始结构打到 stderr
 *
 * 只读：不碰写接口、不签名、不看画面、不做 ASR/OCR。
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { homedir } from 'node:os'

import { openPage, sleep } from '../lib/chrome.mjs'

const HOME = String(process.env.DOUYIN_HOME || '').trim() || join(homedir(), '.dsh', 'douyin-duty')
const OUT_JSON = join(HOME, 'forward-pick.json')

const argv = process.argv.slice(2)
const argOf = (k, d) => { const i = argv.indexOf(k); return i >= 0 ? (argv[i + 1] ?? d) : d }
const LIMIT = Math.max(1, Number(argOf('--limit', '10')) || 10)
const DUMP = argv.includes('--dump')

// 参数串照抄 forward-pick.py（服务端认得这套，别乱改）
const COMMON = 'device_platform=webapp&aid=6383&channel=channel_pc_web&pc_client_type=1'
  + '&version_code=190500&version_name=19.5.0&cookie_enabled=true'
  + '&screen_width=1920&screen_height=1080&browser_language=zh-CN'
  + '&browser_platform=Win32&browser_name=Chrome&browser_version=141.0.0.0'
  + '&engine_name=Blink&engine_version=141.0.0.0&os_name=Windows&os_version=10'
  + '&platform=PC&downlink=10&effective_type=4g&round_trip_time=50'

const BASE = 'https://www.douyin.com'

/** 设置页那两个旋钮（collector.json，由 index.js 写） */
function loadCollector() {
  try {
    const j = JSON.parse(readFileSync(join(HOME, 'collector.json'), 'utf8')) || {}
    return { minDescLen: Number(j.minDescLen || 0), minComments: Number(j.minComments || 0) }
  } catch {
    return { minDescLen: 0, minComments: 0 }
  }
}

/** 递归收集所有长得像 aweme 的对象（有 aweme_id + desc/statistics） */
function walkAwemes(obj, bag) {
  if (Array.isArray(obj)) {
    for (const v of obj) walkAwemes(v, bag)
    return
  }
  if (!obj || typeof obj !== 'object') return
  if (obj.aweme_id && (('desc' in obj) || ('statistics' in obj))) {
    bag.set(String(obj.aweme_id), obj)
    return
  }
  for (const v of Object.values(obj)) walkAwemes(v, bag)
}

const stat = (a, k) => {
  const s = a.statistics || {}
  const n = Number(s[k] || 0)
  return Number.isFinite(n) ? Math.trunc(n) : 0
}

const fmts = (n) => {
  if (n >= 100000000) return (n / 100000000).toFixed(1) + '亿'
  if (n >= 10000) return (n / 10000).toFixed(1) + '万'
  return String(n)
}

const err = (s) => process.stderr.write(String(s) + '\n')

/** 在页面上下文里串行打这几个同源只读接口，返回 [{path, http, text|error}] */
async function fetchAllInPage(paths) {
  const c = await openPage({ url: BASE + '/' })
  try {
    const href = String(await c.ev('location.href'))
    if (!href.includes('douyin.com')) {
      await c.send('Page.navigate', { url: BASE + '/' })
      await sleep(5000)
    }
    // 🔴 2026-10-24 实测：无头 Chrome 的 UA 里带 `HeadlessChrome/151`，
    //    抖音的 /tab/feed 对这种 UA 直接 **HTTP 200 + 空 body**（看起来成功、其实啥也没有）。
    //    把标记去掉（版本号保持浏览器真实的，别硬写 141）之后，同一个请求立刻返回 ~107 KB 正常 JSON。
    //    这类 UA 覆盖只作用于当前 CDP 会话，脚本退出即失效，不影响别的脚本。
    const realUA = String(await c.ev('navigator.userAgent')).replace('HeadlessChrome', 'Chrome')
    await c.send('Network.enable')
    await c.send('Network.setUserAgentOverride', {
      userAgent: realUA,
      acceptLanguage: 'zh-CN,zh;q=0.9',
      platform: 'Win32',
    })
    await sleep(300)
    // ⚠️ 必须带超时（2026-10-24 踩过）：哨兵每几秒会把页面导航回 /chat，
    //    一旦导航发生，页面里的执行上下文就没了 —— 没有 abort 的 fetch 会永远挂着，
    //    整个脚本看起来像"卡死"。所以每条 fetch 都上 AbortController(20s)，
    //    并且在每条之前检查一次还在不在 douyin 上。
    const raw = await c.ev(`(async function(){
      var paths = ${JSON.stringify(paths)};
      var out = [];
      function sleep(ms) { return new Promise(function (z) { setTimeout(z, ms) }); }
      for (var i = 0; i < paths.length; i++) {
        if (String(location.href).indexOf('douyin.com') === -1) {
          out.push({ path: paths[i], http: 0, error: 'left-douyin-origin' });
          continue;
        }
        var ctl = new AbortController();
        var to = setTimeout(function () { try { ctl.abort() } catch (e) {} }, 20000);
        try {
          var r = await fetch(paths[i], {
            credentials: 'include',
            signal: ctl.signal,
            headers: { 'Accept': 'application/json, text/plain, */*' }
          });
          var t = await r.text();
          out.push({ path: paths[i], http: r.status, text: t });
        } catch (e) {
          out.push({ path: paths[i], http: 0, error: String((e && e.name) || (e && e.message) || e) });
        } finally {
          clearTimeout(to);
        }
        await sleep(1200);
      }
      return JSON.stringify(out);
    })()`)
    return JSON.parse(raw) || []
  } finally {
    c.close()
    await sleep(200) // 等 WS 真关掉，否则 libuv 断言
  }
}

async function main() {
  const limits = loadCollector()
  const dropped = { no_desc: 0, too_short_video: 0, short_and_quiet: 0 }

  const paths = []
  for (let i = 1; i <= 3; i++) {
    paths.push(`${BASE}/aweme/v1/web/tab/feed/?${COMMON}&count=20&refresh_index=${i}`)
  }
  paths.push(`${BASE}/aweme/v1/web/hot/search/list/?${COMMON}&detail_list=1`)

  const responses = await fetchAllInPage(paths)

  const bag = new Map()
  const meta = []
  responses.forEach((r, idx) => {
    const label = idx < 3 ? `feed#${idx + 1}` : 'hot-search'
    let j = null
    if (r.text) {
      try { j = JSON.parse(r.text) } catch { j = null }
    }
    if (!j) {
      meta.push({ src: label, new: 0, status: null, http: r.http, error: (r.error || 'not-json').slice(0, 120) })
      return
    }
    const before = bag.size
    walkAwemes(j, bag)
    meta.push({ src: label, new: bag.size - before, status: j.status_code === undefined ? null : j.status_code })
    if (DUMP && idx === 0) err('[feed#1 top-level keys] ' + Object.keys(j).join(','))
  })

  const now = Date.now() / 1000
  const rows = []
  for (const [aid, a] of bag) {
    const desc = String(a.desc || '').trim()
    if (!desc) { dropped.no_desc++; continue }
    const dur = Number(a.duration || (a.video || {}).duration || 0)
    if (dur && dur < 12000) { dropped.too_short_video++; continue }
    const d = stat(a, 'digg_count')
    const cm = stat(a, 'comment_count')
    const col = stat(a, 'collect_count')
    const sh = stat(a, 'share_count')
    if (limits.minDescLen && desc.length < limits.minDescLen && cm < limits.minComments) {
      dropped.short_and_quiet++
      continue
    }
    const ct = Number(a.create_time || 0)
    const ageH = ct ? (now - ct) / 3600 : 999
    const inter = d + cm * 2 + col * 3 + sh * 2
    const ratio = d ? cm / d : 0
    let score = inter
    if (ratio >= 0.02 && ratio <= 0.25) score *= 1.25
    if (ageH <= 72) score *= 1.15
    const si = a.share_info || {}
    const official = si.share_url || a.share_url || ''
    rows.push({
      aweme_id: aid,
      desc,
      author: (a.author || {}).nickname || '',
      sec_uid: (a.author || {}).sec_uid || '',
      duration_s: dur ? Math.round((dur / 1000) * 10) / 10 : null,
      digg: d, comment: cm, collect: col, share: sh,
      comment_ratio: Math.round(ratio * 10000) / 10000,
      age_h: Math.round(ageH * 10) / 10,
      score: Math.trunc(score),
      // 官方分享链接（带 share_sign）优先；没有才自己拼
      share_url: official || `${BASE}/video/${aid}`,
      share_desc: String(si.share_link_desc || '').replace('%s', official).trim(),
      web_url: `${BASE}/video/${aid}`,
    })
  }

  rows.sort((x, y) => y.score - x.score)
  const top = rows.slice(0, LIMIT)

  console.log('采集：' + JSON.stringify(meta))
  console.log(`硬筛跳过：${JSON.stringify(dropped)}（阈值 文案≥${limits.minDescLen} 字 / 评论≥${limits.minComments}）`)
  console.log(`去重后候选 ${rows.length} 条，取前 ${top.length}`)
  top.forEach((r, i) => {
    const idx = String(i + 1).padStart(2, ' ')
    console.log(`${idx}. [${fmts(r.digg)}] ${r.desc.slice(0, 46)}`)
    console.log(`    ${r.author} · ${r.duration_s ? r.duration_s + 's' : '时长未知'} · `
      + `赞${fmts(r.digg)} 评${fmts(r.comment)} 藏${fmts(r.collect)} 转${fmts(r.share)} · `
      + `${r.age_h < 900 ? Math.round(r.age_h) + '小时前' : '时间未知'}`)
    console.log(`    ${r.share_url}`)
  })

  // 落盘（和 Python 版保持同样的产物，别的脚本/笔记在引用）
  try {
    const stamp = new Date()
    const p2 = (n) => String(n).padStart(2, '0')
    const outMd = join(HOME, 'out', `forward-${stamp.getFullYear()}${p2(stamp.getMonth() + 1)}${p2(stamp.getDate())}-${p2(stamp.getHours())}${p2(stamp.getMinutes())}.md`)
    mkdirSync(dirname(outMd), { recursive: true })
    writeFileSync(OUT_JSON, JSON.stringify({ meta, rows: top, dropped, thresholds: limits }, null, 1), 'utf8')
    const md = [`# 转发清单 ${stamp.toLocaleString('zh-CN')}`, '']
    for (const r of top) {
      md.push(`### ${r.aweme_id}`, `- ${r.desc}`, `- ${r.author} · ${r.duration_s}s · 赞${fmts(r.digg)} 评${fmts(r.comment)} 藏${fmts(r.collect)}`, `- ${r.share_url}`, '')
    }
    writeFileSync(outMd, md.join('\n'), 'utf8')
    console.log(`\n清单 -> ${outMd}`)
  } catch (e) {
    err('写清单失败：' + ((e && e.message) || e))
  }

  // 一条都没取到 ⇒ 非 0 退出，让 index.js 的 runPicker 走「失败」分支
  if (!top.length) process.exitCode = 1
}

main().catch((e) => {
  err('feed-pick 失败：' + ((e && e.message) || e))
  console.log('采集失败：' + String((e && e.message) || e).slice(0, 200))
  process.exitCode = 1
})
