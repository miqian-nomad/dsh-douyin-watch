#!/usr/bin/env node
/**
 * tools/signed-search.mjs —— 签名直连搜视频（不用开浏览器，也不会弹搜索页滑块）
 * ============================================================================
 * 为什么要有：2026-10-28 之前刷标签只能开搜索页，而搜索页经常弹「请完成验证」滑块，
 *   一弹就得等人手动过。签名直连这条路走接口，不经过页面，自然没那个滑块。
 *
 * 用法:
 *   node tools/signed-search.mjs --keyword "#蓝色大肥鱼" [--count 10] [--offset 0]
 * 输出一行 JSON: { ok, keyword, n, items: [ {aweme_id, desc, author, digg, comment, create_time, share_url} ] }
 */
import { spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'

const argv = process.argv.slice(2)
const argOf = (k, d) => { const i = argv.indexOf(k); return i >= 0 ? (argv[i + 1] ?? d) : d }

const KEYWORD = String(argOf('--keyword', '')).trim()
const COUNT = Math.min(50, Math.max(1, Number(argOf('--count', '10')) || 10))
const OFFSET = Math.max(0, Number(argOf('--offset', '0')) || 0)

const out = (o) => { console.log(JSON.stringify(o, null, 1)); process.exitCode = o.ok ? 0 : 1 }
if (!KEYWORD) { out({ ok: false, error: '缺 --keyword' }); process.exit(1) }

const PY = String(process.env.DOUYIN_SIGN_PY || 'D:\\dsh-plugins\\_deps\\python311\\cpython-3.11-windows-x86_64-none\\python.exe')
const SCRIPT = String(process.env.DOUYIN_SIGN_SCRIPT || 'D:\\dsh-plugins\\_deps\\scripts\\douyin-signer\\signed_get.py')
if (!existsSync(SCRIPT) || !existsSync(PY)) { out({ ok: false, error: '签名脚本不存在（看 _deps\\scripts\\douyin-signer）' }); process.exit(1) }

// 关键词要 URL 编码（# / 中文都要）
const kw = encodeURIComponent(KEYWORD)
const query = `device_platform=webapp&aid=6383&channel=channel_pc_web&search_channel=aweme_general`
  + `&keyword=${kw}&search_source=normal_search&query_correct_type=1&is_filter_search=0`
  + `&offset=${OFFSET}&count=${COUNT}&sort_type=0&publish_time=0`

const r = spawnSync(PY, [SCRIPT, '--kind', 'search', '--path', '/aweme/v1/web/general/search/single/', '--query', query], { encoding: 'utf8', timeout: 45000 })
let p = null
try { p = JSON.parse(String(r.stdout || '').trim()) } catch { p = null }
if (!p) { out({ ok: false, error: '签名脚本没返回可解析结果', stderr: String(r.stderr || '').slice(0, 200) }); process.exit(1) }

out({
  ok: !!p.ok,
  keyword: KEYWORD,
  n: p.n || 0,
  has_more: !!p.has_more,
  items: p.items || [],
})
