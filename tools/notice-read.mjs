#!/usr/bin/env node
/**
 * tools/notice-read.mjs —— 读抖音互动通知（@ 我的 / 评论 / 点赞 / 关注）
 * ============================================================================
 * 从 notice-read.py 搬过来（2026-10-24），原因同 feed-pick：去掉 curl_cffi 依赖。
 * 现在只在页面上下文里发同源只读请求，指纹/签名/cookie 全是浏览器自己的。
 *
 * 踩坑照旧（别重走）：
 *   · 列表在响应的 **notice_list_v2** 里，不是 notice_list
 *   · 必须**同时**给 `group` 和 `notice_group`，缺一个就 status_code=5
 *   · `min_time=0` 才会把历史拉出来
 *   · 网页端**没有**通知中心页（/notice /notification 全 404），只能走这个接口
 *   · 🔴 无头 Chrome 的 UA 带 `HeadlessChrome`，抖音直接给空 body ⇒ 必须先覆盖 UA
 *
 * 只读：is_mark_read=0（不把消息标成已读）
 *
 * 用法: node tools/notice-read.mjs [--raw]
 * 输出：一段 JSON（{ ok, counts, items, n, at_n, warnings? }），与 Python 版完全一致
 */
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'

import { openPage, sleep } from '../lib/chrome.mjs'

const HOME = String(process.env.DOUYIN_HOME || '').trim() || join(homedir(), '.dsh', 'douyin-duty')
const RAW = process.argv.includes('--raw')

const BASE = 'https://www.douyin.com'
const COMMON = 'device_platform=webapp&aid=6383&channel=channel_pc_web&pc_client_type=1'
  + '&version_code=190500&version_name=19.5.0&cookie_enabled=true'
  + '&screen_width=1920&screen_height=1080&browser_language=zh-CN'
  + '&browser_platform=Win32&browser_name=Chrome&browser_version=141.0.0.0'
  + '&engine_name=Blink&engine_version=141.0.0.0&os_name=Windows&os_version=10'
  + '&platform=PC'

const TYPE_NAME = {
  33: '关注了你',
  34: '点赞了你的作品',
  35: '评论了你的作品',
  45: '@了你（评论区）',
  46: '@了你（作品）',
  31: '回复了你的评论',
}
const GROUPS = [700, 960, 401, 601]

/** 把一条通知压成人类可读的形状（逻辑照抄 notice-read.py 的 norm） */
function norm(it) {
  const t = it.type
  const rec = {
    type: t === undefined ? null : t,
    type_name: TYPE_NAME[t] || ('type_' + t),
    nid: it.nid === undefined ? null : it.nid,
    create_time: it.create_time === undefined ? null : it.create_time,
  }
  for (const key of ['at', 'comment', 'digg', 'follow', 'fans', 'im', 'system']) {
    const blk = it[key]
    if (!blk || typeof blk !== 'object') continue
    const ui = blk.user_info || blk.from_user || {}
    rec.nickname = ui.nickname || ''
    rec.uid = ui.uid || ''
    rec.content = String(blk.content || '').trim()
    const sch = String(blk.schema_url || '')
    rec.schema_url = sch
    // aweme://aweme/detail/<aweme_id>?cid=<comment_id>&reply_id=<reply_id>
    if (sch.includes('aweme/detail/')) {
      const parts = sch.split('aweme/detail/')[1] || ''
      rec.aweme_id = parts.split('?')[0].split('&')[0]
      if (sch.includes('cid=')) rec.comment_id = sch.split('cid=')[1].split('&')[0]
      if (sch.includes('reply_id=')) rec.reply_id = sch.split('reply_id=')[1].split('&')[0]
    }
    if (blk.aweme_id) rec.aweme_id = rec.aweme_id || String(blk.aweme_id)
    if (rec.aweme_id) {
      rec.video_url = `${BASE}/video/${rec.aweme_id}`
      if (rec.comment_id) rec.comment_url = `${BASE}/video/${rec.aweme_id}?comment_id=${rec.comment_id}`
    }
    break
  }
  if (RAW) rec.raw = it
  return rec
}

/** 页面内串行 GET，返回 [{http, text|error}]（带 20s 超时，见 feed-pick 里的说明） */
async function fetchAllInPage(c, paths) {
  const raw = await c.ev(`(async function(){
    var paths = ${JSON.stringify(paths)};
    var out = [];
    function sleep(ms) { return new Promise(function (z) { setTimeout(z, ms) }); }
    for (var i = 0; i < paths.length; i++) {
      if (String(location.href).indexOf('douyin.com') === -1) {
        out.push({ http: 0, error: 'left-douyin-origin' });
        continue;
      }
      var ctl = new AbortController();
      var to = setTimeout(function () { try { ctl.abort() } catch (e) {} }, 20000);
      try {
        var r = await fetch(paths[i], { credentials: 'include', signal: ctl.signal });
        var t = await r.text();
        out.push({ http: r.status, text: t });
      } catch (e) {
        out.push({ http: 0, error: String((e && e.name) || (e && e.message) || e) });
      } finally { clearTimeout(to) }
      await sleep(1200);
    }
    return JSON.stringify(out);
  })()`)
  return JSON.parse(raw) || []
}

async function main() {
  const out = { ok: true, counts: {}, items: [] }
  const c = await openPage({ url: BASE + '/' })
  try {
    const href = String(await c.ev('location.href'))
    if (!href.includes('douyin.com')) {
      await c.send('Page.navigate', { url: BASE + '/' })
      await sleep(5000)
    }
    // 🔴 关键：无头 UA 会被抖音判掉（200 + 空 body），先换成不带 Headless 标记的
    const realUA = String(await c.ev('navigator.userAgent')).replace('HeadlessChrome', 'Chrome')
    await c.send('Network.enable')
    await c.send('Network.setUserAgentOverride', {
      userAgent: realUA,
      acceptLanguage: 'zh-CN,zh;q=0.9',
      platform: 'Win32',
    })
    await sleep(300)

    const paths = [`${BASE}/aweme/v1/web/notice/count/?${COMMON}&is_new_notice=1&need_social_count=1`]
    for (const g of GROUPS) {
      paths.push(`${BASE}/aweme/v1/web/notice/?${COMMON}&is_new_notice=1&is_mark_read=0&count=20&min_time=0&group=${g}&notice_group=${g}`)
    }
    const responses = await fetchAllInPage(c, paths)

    const parse = (r) => {
      if (!r || !r.text) return null
      try { return JSON.parse(r.text) } catch { return null }
    }

    // 1) 计数
    const cj = parse(responses[0])
    if (cj) {
      for (const x of (cj.notice_count || [])) out.counts[String(x.group)] = x.count
    } else {
      out.warnings = out.warnings || []
      out.warnings.push('count 失败: ' + ((responses[0] && (responses[0].error || ('http ' + responses[0].http))) || 'unknown'))
    }

    // 2) 各组列表
    const seen = new Set()
    GROUPS.forEach((g, i) => {
      const j = parse(responses[i + 1])
      if (!j) {
        out.warnings = out.warnings || []
        out.warnings.push(`group=${g} ${(responses[i + 1] && (responses[i + 1].error || ('http ' + responses[i + 1].http))) || 'no-json'}`)
        return
      }
      if (j.status_code !== 0 && j.status_code !== undefined && j.status_code !== null) {
        out.warnings = out.warnings || []
        out.warnings.push(`group=${g} status_code=${j.status_code}`)
      }
      for (const it of (j.notice_list_v2 || [])) {
        const nid = it.nid
        if (nid !== undefined && seen.has(nid)) continue
        if (nid !== undefined) seen.add(nid)
        const r = norm(it)
        r.group = g
        out.items.push(r)
      }
    })
  } finally {
    try { await c.send('Network.setUserAgentOverride', { userAgent: '' }) } catch { /* 忽略 */ }
    c.close()
    await sleep(200)
  }

  out.items.sort((a, b) => (b.create_time || 0) - (a.create_time || 0))
  out.n = out.items.length
  out.at_n = out.items.filter((x) => x.type === 45 || x.type === 46).length

  console.log(JSON.stringify(out, null, 1))
  try { writeFileSync(join(HOME, 'notice.json'), JSON.stringify(out, null, 1), 'utf8') } catch { /* 写不进去不影响输出 */ }
}

main().catch((e) => {
  console.log(JSON.stringify({ ok: false, error: String((e && e.message) || e).slice(0, 300) }, null, 1))
  process.exitCode = 1
})
